/**
 * Liku Orchestrator - Multi-agent pipeline execution engine.
 * 
 * Implements the APA-inspired orchestration patterns:
 * - Sequential pipeline: Supervisor → Parser → Planner → Specialist(s) → Synthesizer
 * - Parallel fan-out: Multiple specialists in parallel (up to maxConcurrency)
 * - Hierarchical: Specialists can request sub-agents
 */

import crypto from "node:crypto";
import type { LikuEngine, AgentBundle } from "../engine.js";
import { ConcurrencyLimiter } from "../utils/concurrencyLimiter.js";
import { LikuError, toLikuError, type LikuErrorCode } from "../errors.js";
import { validateSkillsIndex, getResidencePrivilege } from "../skills/validator.js";
import type { LlmClient, LlmInput, LlmOutput, LlmError } from "../llm/types.js";
import { StubLlmClient } from "../llm/types.js";
import type {
  OrchestrationInput,
  OrchestrationConfig,
  OrchestrationResult,
  PlannerOutput,
  PlanStep,
  StepResult,
  EscalationInfo,
  OrchestrationEvent,
  OrchestrationEventOptions,
  StepStartedEvent,
  StepCompletedEvent,
  EscalationEvent,
  RunStartedEvent,
  RunCompletedEvent
} from "./types.js";
import { taskRegistry } from "./taskRegistry.js";

function isoNow(): string {
  return new Date().toISOString();
}

function id(): string {
  return crypto.randomUUID();
}

/**
 * Event emitter helper - fire-and-forget with microtask isolation.
 * 
 * Uses queueMicrotask to guarantee:
 * - No accidental sync throws affecting orchestration
 * - No reentrancy bugs from handlers modifying state
 * - No performance coupling between orchestration and observers
 */
function emitEvent(
  options: OrchestrationEventOptions | undefined,
  event: OrchestrationEvent
): void {
  if (!options?.onEvent) return;
  
  // Check if this event type is enabled (all enabled by default)
  const typeToOption: Record<OrchestrationEvent["type"], keyof OrchestrationEventOptions | null> = {
    step_started: "emitStepStarted",
    step_completed: "emitStepCompleted",
    escalation: "emitEscalation",
    elicitation: "emitElicitation",
    run_started: null,  // Always emitted
    run_completed: null // Always emitted
  };
  
  const optionKey = typeToOption[event.type];
  if (optionKey && options[optionKey] === false) return;
  
  // Wrap in microtask for isolation - prevents sync throws and reentrancy
  const handler = options.onEvent;
  queueMicrotask(() => {
    try {
      const result = handler(event);
      // Handle async handlers without blocking
      if (result && typeof result === "object" && "then" in result) {
        (result as Promise<void>).catch(() => {
          // Silently ignore async handler errors
        });
      }
    } catch {
      // Fire-and-forget: silently ignore handler errors
    }
  });
}

// Re-export for backward compatibility
export type { LlmClient };
export { StubLlmClient };

// Legacy type alias for existing code
export type LlmResponse = {
  content: string;
  tokensUsed?: number;
  model?: string;
};

/**
 * Adapter to use new LlmClient interface with legacy LlmResponse type.
 */
function adaptLlmOutput(output: LlmOutput): LlmResponse {
  const response: LlmResponse = {
    content: output.text
  };
  
  // Conditionally add optional properties to satisfy exactOptionalPropertyTypes
  if (output.usage?.totalTokens !== undefined) {
    response.tokensUsed = output.usage.totalTokens;
  }
  if (output.model !== undefined) {
    response.model = output.model;
  }
  
  return response;
}

/**
 * The Liku Orchestrator coordinates multi-agent pipelines.
 */
export class Orchestrator {
  private readonly engine: LikuEngine;
  private readonly limiter: ConcurrencyLimiter;
  private llmClient: LlmClient;

  constructor(engine: LikuEngine, llmClient?: LlmClient) {
    this.engine = engine;
    this.limiter = new ConcurrencyLimiter(5);
    this.llmClient = llmClient ?? new StubLlmClient();
  }

  /**
   * Set the LLM client for BYOK execution.
   */
  setLlmClient(client: LlmClient): void {
    this.llmClient = client;
  }

  /**
   * Get default orchestration config.
   */
  getDefaultConfig(): OrchestrationConfig {
    return {
      maxConcurrency: 5,
      stepTimeoutMs: 60_000,
      totalTimeoutMs: 300_000,
      executeWithLlm: this.llmClient.isConfigured(),
      abortOnError: true
    };
  }

  /**
   * Run an orchestration with full pipeline.
   * This is the main entry point for multi-agent execution.
   */
  async run(input: OrchestrationInput): Promise<OrchestrationResult> {
    const config = { ...this.getDefaultConfig(), ...input.config };
    const steps: StepResult[] = [];
    const startTime = Date.now();
    const eventOptions = input.events;

    // Create task in registry with abort support
    const { id: taskId, abortController } = taskRegistry.create(input);
    taskRegistry.updateStatus(taskId, "running");
    
    // Merge abort signals: use input signal if provided, otherwise use task's signal
    const effectiveConfig = {
      ...config
    };
    if (input.config?.abortSignal !== undefined) {
      effectiveConfig.abortSignal = input.config.abortSignal;
    } else {
      effectiveConfig.abortSignal = abortController.signal;
    }

    // Emit run_started event
    emitEvent(eventOptions, {
      type: "run_started",
      timestamp: isoNow(),
      taskId,
      query: input.query,
      startResidence: input.startResidence ?? "Liku/root"
    });

    try {
      // Step 1: Supervisor analysis
      const supervisorResult = await this.runStepWithEvents({
        id: "supervisor",
        description: "Supervisor analyzes request and routes to appropriate agents",
        agentResidence: input.startResidence ?? "Liku/root",
        input: { query: input.query },
        dependsOn: [],
        parallel: false
      }, effectiveConfig, startTime, taskId, eventOptions);
      steps.push(supervisorResult);

      if (supervisorResult.status === "error" && effectiveConfig.abortOnError) {
        return this.finishRun(taskId, eventOptions, startTime, steps,
          this.errorResult("Supervisor failed", steps, supervisorResult.error!));
      }
      if (supervisorResult.status === "escalated") {
        return this.finishRun(taskId, eventOptions, startTime, steps,
          this.escalationResult("Supervisor escalated", steps, supervisorResult.escalation!));
      }

      // Step 2: Parser normalizes the request
      const parserResult = await this.runStepWithEvents({
        id: "parser",
        description: "Parser normalizes request into structured task",
        agentResidence: "Liku/specialist/parser",
        input: { query: input.query, supervisorAnalysis: supervisorResult.output },
        dependsOn: ["supervisor"],
        parallel: false
      }, effectiveConfig, startTime, taskId, eventOptions);
      steps.push(parserResult);

      if (parserResult.status === "error" && effectiveConfig.abortOnError) {
        return this.finishRun(taskId, eventOptions, startTime, steps,
          this.errorResult("Parser failed", steps, parserResult.error!));
      }

      // Step 3: Planner decomposes into steps (or use provided plan)
      let plan: PlannerOutput;
      if (input.plan) {
        plan = input.plan;
      } else {
        const plannerResult = await this.runStepWithEvents({
          id: "planner",
          description: "Planner decomposes goal into executable steps",
          agentResidence: "Liku/specialist/planner",
          input: { parsedTask: parserResult.output },
          dependsOn: ["parser"],
          parallel: false
        }, effectiveConfig, startTime, taskId, eventOptions);
        steps.push(plannerResult);

        if (plannerResult.status === "error" && effectiveConfig.abortOnError) {
          return this.finishRun(taskId, eventOptions, startTime, steps,
            this.errorResult("Planner failed", steps, plannerResult.error!));
        }

        // Parse planner output into structured plan
        plan = this.parsePlannerOutput(plannerResult.output);
      }

      // Step 4: Execute planned steps (sequential or parallel based on plan)
      const executionResults = await this.executeStepsWithEvents(
        plan.steps, effectiveConfig, startTime, taskId, eventOptions
      );
      steps.push(...executionResults);

      // Check for failures
      const failedSteps = executionResults.filter((r) => r.status === "error");
      const escalatedSteps = executionResults.filter((r) => r.status === "escalated");

      if (escalatedSteps.length > 0) {
        return this.finishRun(taskId, eventOptions, startTime, steps,
          this.escalationResult(
            `${escalatedSteps.length} step(s) require escalation`,
            steps,
            escalatedSteps[0]!.escalation!
          ));
      }

      if (failedSteps.length > 0 && effectiveConfig.abortOnError) {
        return this.finishRun(taskId, eventOptions, startTime, steps,
          this.errorResult(
            `${failedSteps.length} step(s) failed`,
            steps,
            failedSteps[0]!.error!
          ));
      }

      // Step 5: Synthesizer merges results
      const successfulOutputs = executionResults
        .filter((r) => r.status === "success")
        .map((r) => ({ stepId: r.stepId, output: r.output }));

      const synthesizerResult = await this.runStepWithEvents({
        id: "synthesizer",
        description: "Synthesizer merges step outputs into final result",
        agentResidence: "Liku/specialist/synthesizer",
        input: { stepOutputs: successfulOutputs, plan },
        dependsOn: plan.steps.map((s) => s.id),
        parallel: false
      }, effectiveConfig, startTime, taskId, eventOptions);
      steps.push(synthesizerResult);

      // Build final result
      const result: OrchestrationResult = {
        kind: failedSteps.length > 0 ? "partial" : "ok",
        summary: plan.goalSummary,
        steps,
        ...(failedSteps.length > 0
          ? { partialOutput: synthesizerResult.output, pendingSteps: failedSteps.map((s) => s.stepId) }
          : { finalOutput: synthesizerResult.output })
      } as OrchestrationResult;

      return this.finishRun(taskId, eventOptions, startTime, steps, result);

    } catch (err) {
      const likuErr = toLikuError(err);
      const result: OrchestrationResult = {
        kind: "error",
        code: likuErr.code,
        message: likuErr.message,
        details: likuErr.details,
        steps
      };
      return this.finishRun(taskId, eventOptions, startTime, steps, result);
    }
  }

  /**
   * Execute a single step with timeout and error handling.
   */
  private async runStep(
    step: PlanStep,
    config: OrchestrationConfig,
    orchestrationStart: number
  ): Promise<StepResult> {
    const stepStart = Date.now();

    // Check total timeout
    if (Date.now() - orchestrationStart > config.totalTimeoutMs) {
      return {
        stepId: step.id,
        agentResidence: step.agentResidence,
        status: "error",
        error: { code: "INTERNAL", message: "Orchestration timeout exceeded" },
        durationMs: Date.now() - stepStart,
        paperTrail: { todoPath: "", errorsPath: "" }
      };
    }

    try {
      // Get agent bundle (this validates residence, loads skills, creates paper trail)
      const bundleResult = await this.engine.invokeAgentSafe({
        agentResidence: step.agentResidence,
        task: step.input
      });

      if (bundleResult.kind === "error") {
        return {
          stepId: step.id,
          agentResidence: step.agentResidence,
          status: "error",
          error: { code: bundleResult.code, message: bundleResult.message, details: bundleResult.details },
          durationMs: Date.now() - stepStart,
          paperTrail: { todoPath: "", errorsPath: "" }
        };
      }

      if (bundleResult.kind === "escalation") {
        return {
          stepId: step.id,
          agentResidence: step.agentResidence,
          status: "escalated",
          escalation: {
            missingSkill: bundleResult.missingSkill,
            requestedAction: bundleResult.requestedAction,
            residence: bundleResult.residence,
            policyRef: bundleResult.policyRef,
            suggestedAlternatives: []
          },
          durationMs: Date.now() - stepStart,
          paperTrail: { todoPath: "", errorsPath: "" }
        };
      }

      const bundle = bundleResult.bundle;

      // Check for missing skills that might require escalation
      const escalation = this.checkForEscalation(bundle, step);
      if (escalation) {
        return {
          stepId: step.id,
          agentResidence: step.agentResidence,
          status: "escalated",
          escalation,
          durationMs: Date.now() - stepStart,
          paperTrail: bundle.paperTrail
        };
      }

      // Execute with LLM if configured, otherwise return bundle info
      let output: unknown;
      if (config.executeWithLlm && this.llmClient.isConfigured()) {
        const llmInput: LlmInput = {
          system: bundle.prompts.system,
          task: bundle.prompts.instructions,
          context: "", // Could be populated from memory/context in future
          maxTokens: 4096
        };
        // Conditionally add abortSignal to satisfy exactOptionalPropertyTypes
        if (config.abortSignal !== undefined) {
          llmInput.abortSignal = config.abortSignal;
        }
        const llmOutput = await this.llmClient.generate(llmInput);
        output = { llmResponse: llmOutput.text, bundle, usage: llmOutput.usage };
      } else {
        // Bundle-only mode: return the bundle for external execution
        output = { bundleOnly: true, bundle };
      }

      return {
        stepId: step.id,
        agentResidence: step.agentResidence,
        status: "success",
        output,
        durationMs: Date.now() - stepStart,
        paperTrail: bundle.paperTrail
      };

    } catch (err) {
      const likuErr = toLikuError(err);
      return {
        stepId: step.id,
        agentResidence: step.agentResidence,
        status: "error",
        error: { code: likuErr.code, message: likuErr.message, details: likuErr.details },
        durationMs: Date.now() - stepStart,
        paperTrail: { todoPath: "", errorsPath: "" }
      };
    }
  }

  /**
   * Execute multiple steps, respecting dependencies and parallelism.
   */
  private async executeSteps(
    steps: PlanStep[],
    config: OrchestrationConfig,
    orchestrationStart: number
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];
    const completed = new Set<string>();

    // Group steps by their dependency level
    const readySteps = (): PlanStep[] => {
      return steps.filter((s) => {
        if (completed.has(s.id)) return false;
        return s.dependsOn.every((dep) => completed.has(dep));
      });
    };

    while (completed.size < steps.length) {
      const batch = readySteps();
      if (batch.length === 0) {
        // No steps ready - might have circular dependencies or all done
        break;
      }

      // Execute batch with concurrency limit
      const parallelSteps = batch.filter((s) => s.parallel);
      const sequentialSteps = batch.filter((s) => !s.parallel);

      // Run sequential steps first
      for (const step of sequentialSteps) {
        const result = await this.limiter.run(() =>
          this.runStep(step, config, orchestrationStart)
        );
        results.push(result);
        completed.add(step.id);

        // Abort on error if configured
        if (result.status === "error" && config.abortOnError) {
          return results;
        }
      }

      // Run parallel steps concurrently
      if (parallelSteps.length > 0) {
        const parallelResults = await Promise.all(
          parallelSteps.map((step) =>
            this.limiter.run(() => this.runStep(step, config, orchestrationStart))
          )
        );
        results.push(...parallelResults);
        parallelSteps.forEach((s) => completed.add(s.id));

        // Check for errors
        if (config.abortOnError && parallelResults.some((r) => r.status === "error")) {
          return results;
        }
      }
    }

    return results;
  }

  /**
   * Execute multiple steps with event emission.
   */
  private async executeStepsWithEvents(
    steps: PlanStep[],
    config: OrchestrationConfig,
    orchestrationStart: number,
    taskId: string,
    eventOptions: OrchestrationEventOptions | undefined
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];
    const completed = new Set<string>();

    const readySteps = (): PlanStep[] => {
      return steps.filter((s) => {
        if (completed.has(s.id)) return false;
        return s.dependsOn.every((dep) => completed.has(dep));
      });
    };

    while (completed.size < steps.length) {
      const batch = readySteps();
      if (batch.length === 0) break;

      const parallelSteps = batch.filter((s) => s.parallel);
      const sequentialSteps = batch.filter((s) => !s.parallel);

      for (const step of sequentialSteps) {
        const result = await this.limiter.run(() =>
          this.runStepWithEvents(step, config, orchestrationStart, taskId, eventOptions)
        );
        results.push(result);
        completed.add(step.id);

        if (result.status === "error" && config.abortOnError) {
          return results;
        }
      }

      if (parallelSteps.length > 0) {
        const parallelResults = await Promise.all(
          parallelSteps.map((step) =>
            this.limiter.run(() => this.runStepWithEvents(step, config, orchestrationStart, taskId, eventOptions))
          )
        );
        results.push(...parallelResults);
        parallelSteps.forEach((s) => completed.add(s.id));

        if (config.abortOnError && parallelResults.some((r) => r.status === "error")) {
          return results;
        }
      }
    }

    return results;
  }

  /**
   * Check if a step requires escalation using declarative skill metadata.
   * Validates capabilities before execution based on skill requirements.
   */
  private checkForEscalation(bundle: AgentBundle, step: PlanStep): EscalationInfo | undefined {
    // Get the privilege level based on residence path
    const privilege = getResidencePrivilege(step.agentResidence);
    
    // Build a skills index for validation
    const skillsIndex = {
      skills: bundle.skills,
      byId: new Map(bundle.skills.map(s => [s.id, s]))
    };
    
    // Validate all skills against current privilege
    const report = validateSkillsIndex(skillsIndex, privilege);
    
    // If any skill requires escalation, return escalation info
    if (report.escalationRequired > 0) {
      const escalationSkill = report.details.find(
        d => !d.result.allowed && d.result.reason === "missing_capability" && d.result.escalate
      );
      
      if (escalationSkill && !escalationSkill.result.allowed && escalationSkill.result.reason === "missing_capability") {
        const skill = skillsIndex.byId.get(escalationSkill.skillId);
        const info: EscalationInfo = {
          missingSkill: escalationSkill.skillId,
          requestedAction: step.description,
          residence: step.agentResidence,
          policyRef: "Liku/root/policy.md",
          suggestedAlternatives: [
            `Request '${escalationSkill.result.capability}' capability from root supervisor`,
            "Use alternative skill with lower privilege requirement",
            "Decompose task to avoid privileged operation"
          ],
          capability: escalationSkill.result.capability
        };
        if (skill?.description) {
          info.skillDescription = skill.description;
        }
        return info;
      }
    }
    
    // Check for blocked skills (insufficient privilege, not escalatable)
    if (report.blocked > 0) {
      const blockedSkill = report.details.find(
        d => !d.result.allowed && d.result.reason === "insufficient_privilege"
      );
      
      if (blockedSkill && !blockedSkill.result.allowed && blockedSkill.result.reason === "insufficient_privilege") {
        return {
          missingSkill: blockedSkill.skillId,
          requestedAction: step.description,
          residence: step.agentResidence,
          policyRef: "Liku/root/policy.md",
          suggestedAlternatives: [
            `Current privilege '${blockedSkill.result.current}' insufficient, requires '${blockedSkill.result.required}'`,
            "Execute from a higher-privilege residence",
            "Request root approval for this operation"
          ]
        };
      }
    }
    
    return undefined;
  }

  /**
   * Parse planner output into structured plan.
   * In LLM mode, this would parse the LLM response.
   * In bundle-only mode, we create a default single-step plan.
   */
  private parsePlannerOutput(output: unknown): PlannerOutput {
    // If output is already structured, use it
    if (output && typeof output === "object" && "goalSummary" in output) {
      return output as PlannerOutput;
    }

    // Default: create a simple single-specialist plan
    return {
      goalSummary: "Execute task with TypeScript specialist",
      steps: [
        {
          id: "ts-execution",
          description: "Execute TypeScript task",
          agentResidence: "Liku/specialist/ts",
          input: output,
          dependsOn: [],
          parallel: false
        }
      ],
      constraints: [],
      risks: []
    };
  }

  /**
   * Build an error result.
   */
  private errorResult(
    summary: string,
    steps: StepResult[],
    error: { code: LikuErrorCode; message: string; details?: unknown }
  ): OrchestrationResult {
    return {
      kind: "error",
      code: error.code,
      message: `${summary}: ${error.message}`,
      details: error.details,
      steps
    };
  }

  /**
   * Build an escalation result.
   */
  private escalationResult(
    summary: string,
    steps: StepResult[],
    escalation: EscalationInfo
  ): OrchestrationResult {
    return {
      kind: "escalation",
      summary,
      steps,
      escalation
    };
  }

  /**
   * Run a step with event emission.
   */
  private async runStepWithEvents(
    step: PlanStep,
    config: OrchestrationConfig,
    orchestrationStart: number,
    taskId: string,
    eventOptions: OrchestrationEventOptions | undefined
  ): Promise<StepResult> {
    // Emit step_started event
    emitEvent(eventOptions, {
      type: "step_started",
      timestamp: isoNow(),
      taskId,
      stepId: step.id,
      agentResidence: step.agentResidence,
      description: step.description
    });

    const result = await this.runStep(step, config, orchestrationStart);

    // Emit step_completed event
    const completedEvent: StepCompletedEvent = {
      type: "step_completed",
      timestamp: isoNow(),
      taskId,
      stepId: step.id,
      agentResidence: step.agentResidence,
      status: result.status,
      durationMs: result.durationMs
    };
    if (result.error) {
      completedEvent.error = { code: result.error.code, message: result.error.message };
    }
    if (result.escalation) {
      completedEvent.escalation = result.escalation;
    }
    emitEvent(eventOptions, completedEvent);

    // Emit escalation event if step was escalated
    if (result.status === "escalated" && result.escalation) {
      emitEvent(eventOptions, {
        type: "escalation",
        timestamp: isoNow(),
        taskId,
        stepId: step.id,
        escalation: result.escalation
      });
    }

    return result;
  }

  /**
   * Finish an orchestration run with guaranteed event emission.
   * 
   * GUARANTEE: Exactly one run_completed event is emitted for every orchestration,
   * regardless of how the run terminates (success, error, escalation, cancellation).
   * This is critical for CLI, CI, external supervisors, and UI clients.
   */
  private finishRun(
    taskId: string,
    eventOptions: OrchestrationEventOptions | undefined,
    startTime: number,
    steps: StepResult[],
    result: OrchestrationResult
  ): OrchestrationResult {
    // Set result in registry (idempotent)
    taskRegistry.setResult(taskId, result);
    
    // Emit run_completed event - guaranteed to fire exactly once
    emitEvent(eventOptions, {
      type: "run_completed",
      timestamp: isoNow(),
      taskId,
      resultKind: result.kind,
      totalSteps: steps.length,
      successfulSteps: steps.filter(s => s.status === "success").length,
      durationMs: Date.now() - startTime
    });
    
    return result;
  }

  /**
   * Run a simple bundle-only invocation (backward compatible with existing API).
   */
  async invokeBundle(agentResidence: string, task: unknown): Promise<AgentBundle> {
    const result = await this.engine.invokeAgentSafe({ agentResidence, task });
    if (result.kind === "error") {
      throw new LikuError(result.code, result.message, result.details);
    }
    if (result.kind === "escalation") {
      throw new LikuError("ESCALATION_REQUIRED", `Escalation required: ${result.missingSkill}`, result);
    }
    return result.bundle;
  }
}
