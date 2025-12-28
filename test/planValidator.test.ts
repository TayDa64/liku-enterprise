import { describe, it, expect } from "vitest";
import {
  validatePlan,
  constraintsFromPrivilege,
  DEFAULT_PLAN_CONSTRAINTS,
  extractEscalationRequests,
  type PlanConstraints,
  type ExtendedPlannerOutput
} from "../src/liku/orchestrator/planValidator.js";
import type { PlannerOutput, PlanStep } from "../src/liku/orchestrator/types.js";

// Helper to create test steps
function step(id: string, residence: string, opts: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    description: `Step ${id}`,
    agentResidence: residence,
    input: {},
    dependsOn: opts.dependsOn ?? [],
    parallel: opts.parallel ?? false
  };
}

describe("Plan Validator", () => {
  describe("validatePlan", () => {
    it("should accept valid plan within constraints", () => {
      const plan: PlannerOutput = {
        goalSummary: "Test goal",
        steps: [
          step("step1", "Liku/specialist/ts"),
          step("step2", "Liku/specialist/python", { dependsOn: ["step1"] })
        ],
        constraints: [],
        risks: []
      };

      const result = validatePlan(plan);
      expect(result.valid).toBe(true);
    });

    it("should reject plan with too many steps", () => {
      const steps = Array.from({ length: 25 }, (_, i) =>
        step(`step${i}`, "Liku/specialist/ts", { dependsOn: i > 0 ? [`step${i - 1}`] : [] })
      );
      
      const plan: PlannerOutput = {
        goalSummary: "Large plan",
        steps,
        constraints: [],
        risks: []
      };

      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("too_many_steps");
        expect(result.details).toContain("25");
      }
    });

    it("should accept plan with custom maxSteps", () => {
      const steps = Array.from({ length: 25 }, (_, i) =>
        step(`step${i}`, "Liku/specialist/ts", { dependsOn: i > 0 ? [`step${i - 1}`] : [] })
      );
      
      const plan: PlannerOutput = {
        goalSummary: "Large plan",
        steps,
        constraints: [],
        risks: []
      };

      const result = validatePlan(plan, { maxSteps: 30 });
      expect(result.valid).toBe(true);
    });

    it("should reject plan with too much parallelism", () => {
      const plan: PlannerOutput = {
        goalSummary: "Parallel plan",
        steps: [
          step("p1", "Liku/specialist/ts", { parallel: true }),
          step("p2", "Liku/specialist/ts", { parallel: true }),
          step("p3", "Liku/specialist/ts", { parallel: true }),
          step("p4", "Liku/specialist/ts", { parallel: true }),
          step("p5", "Liku/specialist/ts", { parallel: true }),
          step("p6", "Liku/specialist/ts", { parallel: true }) // 6th parallel
        ],
        constraints: [],
        risks: []
      };

      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("too_much_parallelism");
      }
    });

    it("should detect circular dependencies", () => {
      const plan: PlannerOutput = {
        goalSummary: "Circular plan",
        steps: [
          step("a", "Liku/specialist/ts", { dependsOn: ["c"] }),
          step("b", "Liku/specialist/ts", { dependsOn: ["a"] }),
          step("c", "Liku/specialist/ts", { dependsOn: ["b"] })
        ],
        constraints: [],
        risks: []
      };

      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("circular_dependency");
        expect(result.details).toContain("→");
      }
    });

    it("should detect missing dependencies", () => {
      const plan: PlannerOutput = {
        goalSummary: "Missing dep plan",
        steps: [
          step("a", "Liku/specialist/ts", { dependsOn: ["nonexistent"] })
        ],
        constraints: [],
        risks: []
      };

      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("missing_dependency");
        expect(result.details).toContain("nonexistent");
      }
    });

    it("should reject invalid residence path", () => {
      const plan: PlannerOutput = {
        goalSummary: "Bad residence",
        steps: [
          step("a", "invalid/path")
        ],
        constraints: [],
        risks: []
      };

      const result = validatePlan(plan);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("invalid_residence");
      }
    });

    it("should reject unauthorized escalation requests when not allowed", () => {
      const plan: ExtendedPlannerOutput = {
        goalSummary: "With escalation",
        steps: [step("a", "Liku/specialist/ts")],
        constraints: [],
        risks: [],
        escalationRequests: [
          { kind: "escalation_requested", reason: "Need npm install" }
        ]
      };

      const result = validatePlan(plan, { allowEscalationRequests: false });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("unauthorized_escalation");
      }
    });

    it("should allow escalation requests when enabled", () => {
      const plan: ExtendedPlannerOutput = {
        goalSummary: "With escalation",
        steps: [step("a", "Liku/specialist/ts")],
        constraints: [],
        risks: [],
        escalationRequests: [
          { kind: "escalation_requested", reason: "Need npm install" }
        ]
      };

      const result = validatePlan(plan, { allowEscalationRequests: true });
      expect(result.valid).toBe(true);
    });
  });

  describe("constraintsFromPrivilege", () => {
    it("should return strict constraints for user privilege", () => {
      const constraints = constraintsFromPrivilege("user");
      expect(constraints.maxSteps).toBe(5);
      expect(constraints.maxParallelism).toBe(5);
      expect(constraints.allowEscalationRequests).toBe(false);
      expect(constraints.allowedCapabilities).toContain("read_repo");
      expect(constraints.allowedCapabilities).not.toContain("write_repo");
    });

    it("should return moderate constraints for specialist privilege", () => {
      const constraints = constraintsFromPrivilege("specialist");
      expect(constraints.maxSteps).toBe(20);
      expect(constraints.allowEscalationRequests).toBe(true);
      expect(constraints.allowedCapabilities).toContain("write_repo");
      expect(constraints.allowedCapabilities).not.toContain("network_access");
    });

    it("should return permissive constraints for root privilege", () => {
      const constraints = constraintsFromPrivilege("root");
      expect(constraints.maxSteps).toBe(50);
      expect(constraints.maxParallelism).toBe(10);
      expect(constraints.allowEscalationRequests).toBe(true);
      expect(constraints.allowedCapabilities).toContain("network_access");
      expect(constraints.allowedCapabilities).toContain("escalate");
    });
  });

  describe("extractEscalationRequests", () => {
    it("should extract escalation requests from plan", () => {
      const plan: ExtendedPlannerOutput = {
        goalSummary: "Test",
        steps: [],
        constraints: [],
        risks: [],
        escalationRequests: [
          { kind: "escalation_requested", reason: "Need network", capability: "network_access" },
          { kind: "escalation_requested", reason: "Need shell", stepId: "step1" }
        ]
      };

      const requests = extractEscalationRequests(plan);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.capability).toBe("network_access");
      expect(requests[1]?.stepId).toBe("step1");
    });

    it("should return empty array when no requests", () => {
      const plan: PlannerOutput = {
        goalSummary: "Test",
        steps: [],
        constraints: [],
        risks: []
      };

      const requests = extractEscalationRequests(plan);
      expect(requests).toHaveLength(0);
    });
  });

  describe("DEFAULT_PLAN_CONSTRAINTS", () => {
    it("should have reasonable defaults", () => {
      expect(DEFAULT_PLAN_CONSTRAINTS.maxSteps).toBe(20);
      expect(DEFAULT_PLAN_CONSTRAINTS.maxParallelism).toBe(5);
      expect(DEFAULT_PLAN_CONSTRAINTS.allowEscalationRequests).toBe(true);
      expect(DEFAULT_PLAN_CONSTRAINTS.allowedCapabilities.length).toBeGreaterThan(0);
    });
  });
});
