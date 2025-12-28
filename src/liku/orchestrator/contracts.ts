/**
 * Agent Output Contracts - Validates and handles malformed agent output.
 * 
 * Each agent role has a contract defining:
 * - How to parse/validate its output
 * - What to do on violation (retry, escalate, or error)
 * 
 * Implements the reflect-repair loop:
 * 1. First violation → retry with feedback
 * 2. Second violation → escalate to verifier agent
 * 3. Verifier failure → escalate to human/policy layer
 */

import type { OrchestrationResult, EscalationInfo, PlannerOutput, PlanStep } from "./types.js";
import type { LikuErrorCode } from "../errors.js";

/**
 * Agent roles that have contracts.
 */
export type AgentRole = 
  | "supervisor"
  | "parser"
  | "planner"
  | "specialist"
  | "synthesizer"
  | "verifier";

/**
 * Result of contract validation.
 */
export type ContractValidationResult<T> =
  | { valid: true; parsed: T }
  | { valid: false; violation: ContractViolation };

/**
 * Details about a contract violation.
 */
export type ContractViolation = {
  role: AgentRole;
  expected: string;
  received: string;
  recoverable: boolean;
  suggestedFeedback?: string;
};

/**
 * How to handle a contract violation.
 */
export type ViolationAction =
  | { action: "retry"; feedback: string }
  | { action: "escalate_verifier"; violation: ContractViolation }
  | { action: "escalate_human"; violation: ContractViolation }
  | { action: "error"; code: LikuErrorCode; message: string };

/**
 * Contract definition for an agent role.
 */
export interface AgentContract<T> {
  role: AgentRole;
  
  /**
   * Parse and validate agent output.
   */
  parse(output: unknown): ContractValidationResult<T>;
  
  /**
   * Determine action on violation, considering retry count.
   */
  onViolation(violation: ContractViolation, retryCount: number): ViolationAction;
}

/**
 * Violation handling policy.
 */
export type ViolationPolicy = {
  /** Maximum retries before escalating to verifier */
  maxRetries: number;
  /** Whether to escalate to human after verifier failure */
  escalateToHumanOnVerifierFailure: boolean;
};

/**
 * Default violation policy.
 */
export const DEFAULT_VIOLATION_POLICY: ViolationPolicy = {
  maxRetries: 1,
  escalateToHumanOnVerifierFailure: true
};

// =============================================================================
// Supervisor Contract
// =============================================================================

export type SupervisorOutput = {
  analysis: string;
  routing: string;
  confidence: number;
};

export const supervisorContract: AgentContract<SupervisorOutput> = {
  role: "supervisor",
  
  parse(output: unknown): ContractValidationResult<SupervisorOutput> {
    if (!output || typeof output !== "object") {
      return {
        valid: false,
        violation: {
          role: "supervisor",
          expected: "object with analysis, routing, confidence",
          received: typeof output,
          recoverable: true,
          suggestedFeedback: "Output must be a JSON object with 'analysis' (string), 'routing' (string), and 'confidence' (0-1 number)"
        }
      };
    }

    const obj = output as Record<string, unknown>;
    
    // For bundle-only mode, we accept any object
    if ("bundleOnly" in obj && obj.bundleOnly === true) {
      return {
        valid: true,
        parsed: {
          analysis: "Bundle-only mode",
          routing: "default",
          confidence: 1.0
        }
      };
    }

    // Validate structure
    if (typeof obj.analysis !== "string" || typeof obj.routing !== "string") {
      return {
        valid: false,
        violation: {
          role: "supervisor",
          expected: "analysis and routing strings",
          received: JSON.stringify(obj).slice(0, 100),
          recoverable: true,
          suggestedFeedback: "Ensure 'analysis' and 'routing' are strings"
        }
      };
    }

    return {
      valid: true,
      parsed: {
        analysis: obj.analysis,
        routing: obj.routing,
        confidence: typeof obj.confidence === "number" ? obj.confidence : 0.8
      }
    };
  },

  onViolation(violation: ContractViolation, retryCount: number): ViolationAction {
    if (retryCount < DEFAULT_VIOLATION_POLICY.maxRetries) {
      return {
        action: "retry",
        feedback: violation.suggestedFeedback ?? "Please provide valid structured output"
      };
    }
    return {
      action: "escalate_verifier",
      violation
    };
  }
};

// =============================================================================
// Parser Contract
// =============================================================================

export type ParserOutput = {
  normalizedTask: string;
  entities: string[];
  intent: string;
};

export const parserContract: AgentContract<ParserOutput> = {
  role: "parser",
  
  parse(output: unknown): ContractValidationResult<ParserOutput> {
    if (!output || typeof output !== "object") {
      return {
        valid: false,
        violation: {
          role: "parser",
          expected: "object with normalizedTask, entities, intent",
          received: typeof output,
          recoverable: true,
          suggestedFeedback: "Output must be JSON with 'normalizedTask' (string), 'entities' (string[]), 'intent' (string)"
        }
      };
    }

    const obj = output as Record<string, unknown>;
    
    // Bundle-only mode
    if ("bundleOnly" in obj && obj.bundleOnly === true) {
      return {
        valid: true,
        parsed: {
          normalizedTask: "Bundle-only mode",
          entities: [],
          intent: "execute"
        }
      };
    }

    if (typeof obj.normalizedTask !== "string") {
      return {
        valid: false,
        violation: {
          role: "parser",
          expected: "normalizedTask string",
          received: JSON.stringify(obj).slice(0, 100),
          recoverable: true,
          suggestedFeedback: "Include 'normalizedTask' as a string"
        }
      };
    }

    return {
      valid: true,
      parsed: {
        normalizedTask: obj.normalizedTask,
        entities: Array.isArray(obj.entities) ? obj.entities.map(String) : [],
        intent: typeof obj.intent === "string" ? obj.intent : "execute"
      }
    };
  },

  onViolation(violation: ContractViolation, retryCount: number): ViolationAction {
    if (retryCount < DEFAULT_VIOLATION_POLICY.maxRetries) {
      return {
        action: "retry",
        feedback: violation.suggestedFeedback ?? "Provide structured parser output"
      };
    }
    return {
      action: "escalate_verifier",
      violation
    };
  }
};

// =============================================================================
// Planner Contract
// =============================================================================

export const plannerContract: AgentContract<PlannerOutput> = {
  role: "planner",
  
  parse(output: unknown): ContractValidationResult<PlannerOutput> {
    if (!output || typeof output !== "object") {
      return {
        valid: false,
        violation: {
          role: "planner",
          expected: "PlannerOutput object",
          received: typeof output,
          recoverable: true,
          suggestedFeedback: "Output must be JSON with 'goalSummary', 'steps', 'constraints', 'risks'"
        }
      };
    }

    const obj = output as Record<string, unknown>;
    
    // Bundle-only mode - create default plan
    if ("bundleOnly" in obj && obj.bundleOnly === true) {
      return {
        valid: true,
        parsed: {
          goalSummary: "Execute with default specialist",
          steps: [],
          constraints: [],
          risks: []
        }
      };
    }

    // Validate required fields
    if (typeof obj.goalSummary !== "string") {
      return {
        valid: false,
        violation: {
          role: "planner",
          expected: "goalSummary string",
          received: JSON.stringify(obj).slice(0, 100),
          recoverable: true,
          suggestedFeedback: "Include 'goalSummary' as a string describing the plan's objective"
        }
      };
    }

    if (!Array.isArray(obj.steps)) {
      return {
        valid: false,
        violation: {
          role: "planner",
          expected: "steps array",
          received: typeof obj.steps,
          recoverable: true,
          suggestedFeedback: "Include 'steps' as an array of PlanStep objects"
        }
      };
    }

    // Validate each step structure
    for (let i = 0; i < obj.steps.length; i++) {
      const step = obj.steps[i] as Record<string, unknown>;
      if (!step || typeof step.id !== "string" || typeof step.agentResidence !== "string") {
        return {
          valid: false,
          violation: {
            role: "planner",
            expected: "valid PlanStep at index " + i,
            received: JSON.stringify(step).slice(0, 50),
            recoverable: true,
            suggestedFeedback: `Step ${i} must have 'id' and 'agentResidence' strings`
          }
        };
      }
    }

    return {
      valid: true,
      parsed: {
        goalSummary: obj.goalSummary,
        steps: obj.steps as PlanStep[],
        constraints: Array.isArray(obj.constraints) ? obj.constraints.map(String) : [],
        risks: Array.isArray(obj.risks) ? obj.risks.map(String) : []
      }
    };
  },

  onViolation(violation: ContractViolation, retryCount: number): ViolationAction {
    if (retryCount < DEFAULT_VIOLATION_POLICY.maxRetries) {
      return {
        action: "retry",
        feedback: violation.suggestedFeedback ?? "Provide valid PlannerOutput structure"
      };
    }
    // Planner is critical - escalate to verifier
    return {
      action: "escalate_verifier",
      violation
    };
  }
};

// =============================================================================
// Synthesizer Contract
// =============================================================================

export type SynthesizerOutput = {
  summary: string;
  format: "markdown" | "plaintext" | "json";
  content: string;
};

export const synthesizerContract: AgentContract<SynthesizerOutput> = {
  role: "synthesizer",
  
  parse(output: unknown): ContractValidationResult<SynthesizerOutput> {
    // Synthesizer is lenient - accepts string or object
    if (typeof output === "string") {
      return {
        valid: true,
        parsed: {
          summary: output.slice(0, 100),
          format: "plaintext",
          content: output
        }
      };
    }

    if (!output || typeof output !== "object") {
      return {
        valid: false,
        violation: {
          role: "synthesizer",
          expected: "string or object with content",
          received: typeof output,
          recoverable: true,
          suggestedFeedback: "Output should be a string or object with 'content' field"
        }
      };
    }

    const obj = output as Record<string, unknown>;
    
    // Bundle-only mode
    if ("bundleOnly" in obj && obj.bundleOnly === true) {
      return {
        valid: true,
        parsed: {
          summary: "Bundle-only result",
          format: "json",
          content: JSON.stringify(obj)
        }
      };
    }

    const content = typeof obj.content === "string" 
      ? obj.content 
      : typeof obj.llmResponse === "string"
        ? obj.llmResponse
        : JSON.stringify(obj);

    return {
      valid: true,
      parsed: {
        summary: typeof obj.summary === "string" ? obj.summary : content.slice(0, 100),
        format: obj.format === "markdown" || obj.format === "json" ? obj.format : "plaintext",
        content
      }
    };
  },

  onViolation(violation: ContractViolation, retryCount: number): ViolationAction {
    if (retryCount < DEFAULT_VIOLATION_POLICY.maxRetries) {
      return {
        action: "retry",
        feedback: violation.suggestedFeedback ?? "Provide synthesis output"
      };
    }
    // Synthesizer failures are less critical - error instead of escalate
    return {
      action: "error",
      code: "INTERNAL",
      message: `Synthesizer contract violation: ${violation.expected}`
    };
  }
};

// =============================================================================
// Contract Registry
// =============================================================================

/**
 * Get contract for an agent role.
 */
export function getContract(role: AgentRole): AgentContract<unknown> | undefined {
  switch (role) {
    case "supervisor":
      return supervisorContract as AgentContract<unknown>;
    case "parser":
      return parserContract as AgentContract<unknown>;
    case "planner":
      return plannerContract as AgentContract<unknown>;
    case "synthesizer":
      return synthesizerContract as AgentContract<unknown>;
    default:
      return undefined;
  }
}

/**
 * Validate output against role contract.
 */
export function validateAgentOutput(
  role: AgentRole,
  output: unknown
): ContractValidationResult<unknown> {
  const contract = getContract(role);
  if (!contract) {
    // No contract = permissive
    return { valid: true, parsed: output };
  }
  return contract.parse(output);
}

/**
 * Get violation action based on role and retry count.
 */
export function getViolationAction(
  role: AgentRole,
  violation: ContractViolation,
  retryCount: number
): ViolationAction {
  const contract = getContract(role);
  if (!contract) {
    return {
      action: "error",
      code: "INTERNAL",
      message: "No contract for role: " + role
    };
  }
  return contract.onViolation(violation, retryCount);
}
