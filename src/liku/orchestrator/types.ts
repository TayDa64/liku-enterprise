/**
 * Orchestrator types for multi-agent pipeline execution.
 * Defines data contracts between agents and result envelopes.
 */

import type { AgentBundle } from "../engine.js";
import type { LikuErrorCode } from "../errors.js";

/**
 * A step in an orchestration plan.
 */
export type PlanStep = {
  /** Unique step ID */
  id: string;
  /** Human-readable description */
  description: string;
  /** Agent residence path (e.g. "Liku/specialist/ts") */
  agentResidence: string;
  /** Input data for this step */
  input: unknown;
  /** Dependencies - step IDs that must complete first */
  dependsOn: string[];
  /** Whether this step can run in parallel with siblings */
  parallel: boolean;
};

/**
 * Output from the Planner agent.
 */
export type PlannerOutput = {
  /** Goal summary from Planner */
  goalSummary: string;
  /** Ordered steps to execute */
  steps: PlanStep[];
  /** Constraints identified */
  constraints: string[];
  /** Risks identified */
  risks: string[];
};

/**
 * Result of a single step execution.
 */
export type StepResult = {
  stepId: string;
  agentResidence: string;
  status: "success" | "error" | "skipped" | "escalated";
  output?: unknown;
  error?: { code: LikuErrorCode; message: string; details?: unknown };
  escalation?: EscalationInfo;
  durationMs: number;
  paperTrail: {
    todoPath: string;
    errorsPath: string;
  };
};

/**
 * Escalation information when a step cannot proceed.
 */
export type EscalationInfo = {
  missingSkill: string;
  requestedAction: string;
  residence: string;
  policyRef: string;
  suggestedAlternatives: string[];
  /** The capability that is missing (if capability-based escalation) */
  capability?: string;
  /** Description of the skill requiring escalation */
  skillDescription?: string;
};

/**
 * Final orchestration result envelope.
 */
export type OrchestrationResult =
  | { kind: "ok"; summary: string; steps: StepResult[]; finalOutput: unknown }
  | { kind: "partial"; summary: string; steps: StepResult[]; partialOutput: unknown; pendingSteps: string[] }
  | { kind: "escalation"; summary: string; steps: StepResult[]; escalation: EscalationInfo }
  | { kind: "error"; code: LikuErrorCode; message: string; details?: unknown; steps: StepResult[] };

/**
 * Configuration for an orchestration run.
 */
export type OrchestrationConfig = {
  /** Maximum concurrent specialist executions */
  maxConcurrency: number;
  /** Timeout per step in ms */
  stepTimeoutMs: number;
  /** Total orchestration timeout in ms */
  totalTimeoutMs: number;
  /** Whether to execute with LLM (requires BYOK keys) */
  executeWithLlm: boolean;
  /** Abort on first error or continue */
  abortOnError: boolean;
  /** AbortSignal for cancellation */
  abortSignal?: AbortSignal;
};

/**
 * Input to start an orchestration.
 */
export type OrchestrationInput = {
  /** User's original query/task */
  query: string;
  /** Optional starting residence (defaults to Liku/root) */
  startResidence?: string;
  /** Optional pre-defined plan (skip Planner) */
  plan?: PlannerOutput;
  /** Execution config overrides */
  config?: Partial<OrchestrationConfig>;
  /** Event handling options */
  events?: OrchestrationEventOptions;
};

/**
 * Task state for A2A task registry.
 */
export type TaskState = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  input: OrchestrationInput;
  result?: OrchestrationResult;
  currentStep?: string;
};

/**
 * Default orchestration config.
 */
export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfig = {
  maxConcurrency: 5,
  stepTimeoutMs: 60_000,
  totalTimeoutMs: 300_000,
  executeWithLlm: false,
  abortOnError: true
};

// ============================================================================
// Orchestration Events
// ============================================================================

/**
 * Event types emitted during orchestration.
 */
export type OrchestrationEventType =
  | "step_started"
  | "step_completed"
  | "escalation"
  | "elicitation"
  | "run_started"
  | "run_completed";

/**
 * Base event structure.
 */
export type OrchestrationEventBase = {
  type: OrchestrationEventType;
  timestamp: string;
  taskId: string;
};

/**
 * Event emitted when a step starts execution.
 */
export type StepStartedEvent = OrchestrationEventBase & {
  type: "step_started";
  stepId: string;
  agentResidence: string;
  description: string;
};

/**
 * Event emitted when a step completes (success, error, or escalated).
 */
export type StepCompletedEvent = OrchestrationEventBase & {
  type: "step_completed";
  stepId: string;
  agentResidence: string;
  status: StepResult["status"];
  durationMs: number;
  error?: { code: LikuErrorCode; message: string };
  escalation?: EscalationInfo;
};

/**
 * Event emitted when escalation is required.
 */
export type EscalationEvent = OrchestrationEventBase & {
  type: "escalation";
  stepId: string;
  escalation: EscalationInfo;
};

/**
 * Event emitted when user input is needed (elicitation).
 */
export type ElicitationEvent = OrchestrationEventBase & {
  type: "elicitation";
  stepId: string;
  question: string;
  context: string;
  /** Optional choices for structured input */
  choices?: string[];
};

/**
 * Event emitted when orchestration starts.
 */
export type RunStartedEvent = OrchestrationEventBase & {
  type: "run_started";
  query: string;
  startResidence: string;
};

/**
 * Event emitted when orchestration completes.
 */
export type RunCompletedEvent = OrchestrationEventBase & {
  type: "run_completed";
  resultKind: OrchestrationResult["kind"];
  totalSteps: number;
  successfulSteps: number;
  durationMs: number;
};

/**
 * Union of all orchestration events.
 */
export type OrchestrationEvent =
  | StepStartedEvent
  | StepCompletedEvent
  | EscalationEvent
  | ElicitationEvent
  | RunStartedEvent
  | RunCompletedEvent;

/**
 * Event handler callback for orchestration events.
 */
export type OrchestrationEventHandler = (event: OrchestrationEvent) => void | Promise<void>;

/**
 * Options for event handling during orchestration.
 */
export type OrchestrationEventOptions = {
  /** Event handler callback */
  onEvent?: OrchestrationEventHandler;
  /** Whether to emit step_started events */
  emitStepStarted?: boolean;
  /** Whether to emit step_completed events */
  emitStepCompleted?: boolean;
  /** Whether to emit escalation events */
  emitEscalation?: boolean;
  /** Whether to emit elicitation events */
  emitElicitation?: boolean;
};
