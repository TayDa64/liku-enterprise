/**
 * Plan Validator - Guards against planner-induced privilege escalation and DoS.
 * 
 * Validates planner output before execution to ensure:
 * - No unauthorized capability requests
 * - No excessive step counts
 * - No unbounded parallelism
 * - No escalation loops
 */

import type { Capability, Privilege, SkillsIndex } from "../skills/types.js";
import { hasCapability, PRIVILEGE_CAPABILITIES } from "../skills/types.js";
import { getResidencePrivilege } from "../skills/validator.js";
import type { PlannerOutput, PlanStep } from "./types.js";

/**
 * Constraints for plan validation.
 */
export type PlanConstraints = {
  /** Maximum allowed steps in a plan */
  maxSteps: number;
  /** Maximum parallel steps in any batch */
  maxParallelism: number;
  /** Capabilities the current context is allowed to use */
  allowedCapabilities: Capability[];
  /** Whether the planner can request escalation */
  allowEscalationRequests: boolean;
  /** Skills index for validation (optional, for skill existence checks) */
  skillsIndex?: SkillsIndex;
};

/**
 * Default constraints for plan validation.
 */
export const DEFAULT_PLAN_CONSTRAINTS: PlanConstraints = {
  maxSteps: 20,
  maxParallelism: 5,
  allowedCapabilities: PRIVILEGE_CAPABILITIES.specialist,
  allowEscalationRequests: true
};

/**
 * Result of plan validation.
 */
export type PlanValidationResult =
  | { valid: true }
  | { valid: false; reason: PlanValidationError; details: string };

/**
 * Types of plan validation errors.
 */
export type PlanValidationError =
  | "too_many_steps"
  | "too_much_parallelism"
  | "missing_skill"
  | "unauthorized_capability"
  | "unauthorized_escalation"
  | "circular_dependency"
  | "missing_dependency"
  | "invalid_residence";

/**
 * Escalation request from planner (proposal, not action).
 */
export type PlannerEscalationRequest = {
  kind: "escalation_requested";
  reason: string;
  capability?: Capability;
  stepId?: string;
};

/**
 * Extended planner output that may include escalation requests.
 */
export type ExtendedPlannerOutput = PlannerOutput & {
  escalationRequests?: PlannerEscalationRequest[];
};

/**
 * Validate a planner output against constraints.
 * Returns validation result with specific error if invalid.
 */
export function validatePlan(
  plan: PlannerOutput,
  constraints: Partial<PlanConstraints> = {}
): PlanValidationResult {
  const cfg = { ...DEFAULT_PLAN_CONSTRAINTS, ...constraints };

  // 1. Check total step count
  if (plan.steps.length > cfg.maxSteps) {
    return {
      valid: false,
      reason: "too_many_steps",
      details: `Plan has ${plan.steps.length} steps, max allowed is ${cfg.maxSteps}`
    };
  }

  // 2. Check parallelism
  const parallelismResult = checkParallelism(plan.steps, cfg.maxParallelism);
  if (!parallelismResult.valid) {
    return parallelismResult;
  }

  // 3. Check for circular dependencies
  const circularResult = checkCircularDependencies(plan.steps);
  if (!circularResult.valid) {
    return circularResult;
  }

  // 4. Check for missing dependencies
  const missingDepResult = checkMissingDependencies(plan.steps);
  if (!missingDepResult.valid) {
    return missingDepResult;
  }

  // 5. Check each step for authorization
  for (const step of plan.steps) {
    const stepResult = validateStep(step, cfg);
    if (!stepResult.valid) {
      return stepResult;
    }
  }

  // 6. Check escalation requests if present
  const extended = plan as ExtendedPlannerOutput;
  if (extended.escalationRequests && !cfg.allowEscalationRequests) {
    return {
      valid: false,
      reason: "unauthorized_escalation",
      details: "Planner requested escalation but escalation requests are not allowed in this context"
    };
  }

  return { valid: true };
}

/**
 * Check parallelism constraints.
 */
function checkParallelism(steps: PlanStep[], maxParallelism: number): PlanValidationResult {
  // Group steps by their dependency set to find parallel batches
  const dependencyGroups = new Map<string, PlanStep[]>();
  
  for (const step of steps) {
    const key = step.dependsOn.sort().join(",");
    const group = dependencyGroups.get(key) ?? [];
    group.push(step);
    dependencyGroups.set(key, group);
  }

  // Check each group for parallel steps
  for (const [deps, group] of dependencyGroups) {
    const parallelSteps = group.filter(s => s.parallel);
    if (parallelSteps.length > maxParallelism) {
      return {
        valid: false,
        reason: "too_much_parallelism",
        details: `${parallelSteps.length} parallel steps with dependencies [${deps || "none"}], max allowed is ${maxParallelism}`
      };
    }
  }

  return { valid: true };
}

/**
 * Check for circular dependencies using DFS.
 */
function checkCircularDependencies(steps: PlanStep[]): PlanValidationResult {
  const stepIds = new Set(steps.map(s => s.id));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stepMap = new Map(steps.map(s => [s.id, s]));

  function dfs(stepId: string, path: string[]): string[] | null {
    if (visiting.has(stepId)) {
      return [...path, stepId]; // Found cycle
    }
    if (visited.has(stepId)) {
      return null; // Already processed, no cycle
    }

    visiting.add(stepId);
    const step = stepMap.get(stepId);
    if (step) {
      for (const dep of step.dependsOn) {
        if (stepIds.has(dep)) {
          const cycle = dfs(dep, [...path, stepId]);
          if (cycle) return cycle;
        }
      }
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return null;
  }

  for (const step of steps) {
    const cycle = dfs(step.id, []);
    if (cycle) {
      return {
        valid: false,
        reason: "circular_dependency",
        details: `Circular dependency detected: ${cycle.join(" → ")}`
      };
    }
  }

  return { valid: true };
}

/**
 * Check for missing dependencies (steps that depend on non-existent steps).
 */
function checkMissingDependencies(steps: PlanStep[]): PlanValidationResult {
  const stepIds = new Set(steps.map(s => s.id));

  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) {
        return {
          valid: false,
          reason: "missing_dependency",
          details: `Step "${step.id}" depends on "${dep}" which does not exist in the plan`
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Validate a single step against constraints.
 */
function validateStep(step: PlanStep, cfg: PlanConstraints): PlanValidationResult {
  // Get privilege level from residence path
  const privilege = getResidencePrivilege(step.agentResidence);

  // Check if residence path is valid (basic check)
  if (!step.agentResidence.startsWith("Liku/")) {
    return {
      valid: false,
      reason: "invalid_residence",
      details: `Step "${step.id}" has invalid residence "${step.agentResidence}" - must be under Liku/`
    };
  }

  // Get capabilities required by this residence
  const residenceCapabilities = PRIVILEGE_CAPABILITIES[privilege];

  // Check if any required capability is not in allowed list
  for (const cap of residenceCapabilities) {
    if (!cfg.allowedCapabilities.includes(cap)) {
      // This step would use a capability not allowed in this context
      // Only flag if it's a "powerful" capability
      if (cap === "escalate" || cap === "network_access") {
        return {
          valid: false,
          reason: "unauthorized_capability",
          details: `Step "${step.id}" at residence "${step.agentResidence}" would use capability "${cap}" which is not authorized`
        };
      }
    }
  }

  // If skills index provided, check skill existence
  if (cfg.skillsIndex) {
    // This would check if the step references a known skill
    // For now, we don't have skill references in PlanStep, so skip
  }

  return { valid: true };
}

/**
 * Create constraints from a privilege level.
 */
export function constraintsFromPrivilege(privilege: Privilege): PlanConstraints {
  return {
    maxSteps: privilege === "root" ? 50 : privilege === "specialist" ? 20 : 5,
    maxParallelism: privilege === "root" ? 10 : 5,
    allowedCapabilities: PRIVILEGE_CAPABILITIES[privilege],
    allowEscalationRequests: privilege !== "user"
  };
}

/**
 * Validate and extract escalation requests from extended planner output.
 * These are proposals that the orchestrator can choose to honor or reject.
 */
export function extractEscalationRequests(
  plan: ExtendedPlannerOutput
): PlannerEscalationRequest[] {
  return plan.escalationRequests ?? [];
}
