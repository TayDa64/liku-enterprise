import { describe, it, expect } from "vitest";
import {
  getContract,
  validateAgentOutput,
  getViolationAction,
  supervisorContract,
  parserContract,
  plannerContract,
  synthesizerContract,
  type AgentRole,
  type ContractViolation
} from "../src/liku/orchestrator/contracts.js";

describe("Agent Contracts", () => {
  describe("Individual Contracts", () => {
    it("should have contracts for all main agent roles", () => {
      expect(getContract("supervisor")).toBeDefined();
      expect(getContract("parser")).toBeDefined();
      expect(getContract("planner")).toBeDefined();
      expect(getContract("synthesizer")).toBeDefined();
    });

    it("supervisor contract should validate analysis/routing structure", () => {
      const contract = supervisorContract;
      
      // Valid output
      const valid = contract.parse({
        analysis: "Task is clear",
        routing: "specialist/ts",
        confidence: 0.9
      });
      expect(valid.valid).toBe(true);
      if (valid.valid) {
        expect(valid.parsed.analysis).toBe("Task is clear");
      }

      // Invalid - missing analysis
      const invalid1 = contract.parse({ routing: "test" });
      expect(invalid1.valid).toBe(false);

      // Invalid - non-object
      const invalid2 = contract.parse("just a string");
      expect(invalid2.valid).toBe(false);
    });

    it("parser contract should validate normalizedTask structure", () => {
      const contract = parserContract;
      
      // Valid output
      const valid = contract.parse({
        normalizedTask: "Create a TypeScript file",
        entities: ["file.ts"],
        intent: "create"
      });
      expect(valid.valid).toBe(true);

      // Invalid - missing normalizedTask
      const invalid = contract.parse({ entities: [], intent: "test" });
      expect(invalid.valid).toBe(false);
    });

    it("planner contract should validate plan structure", () => {
      const contract = plannerContract;
      
      // Valid output
      const valid = contract.parse({
        goalSummary: "Create test file",
        steps: [{
          id: "step1",
          description: "Write test",
          agentResidence: "Liku/specialist/ts",
          input: {},
          dependsOn: [],
          parallel: false
        }],
        constraints: [],
        risks: []
      });
      expect(valid.valid).toBe(true);

      // Invalid - missing steps
      const invalid = contract.parse({ goalSummary: "Test" });
      expect(invalid.valid).toBe(false);
    });

    it("synthesizer contract should validate response structure", () => {
      const contract = synthesizerContract;
      
      // Valid output (string is allowed)
      const valid = contract.parse("Task completed successfully");
      expect(valid.valid).toBe(true);

      // Valid object output
      const validObj = contract.parse({
        content: "Task completed",
        summary: "Done",
        format: "markdown"
      });
      expect(validObj.valid).toBe(true);

      // Invalid - null
      const invalid = contract.parse(null);
      expect(invalid.valid).toBe(false);
    });
  });

  describe("getContract", () => {
    it("should return known contracts", () => {
      const supervisor = getContract("supervisor");
      expect(supervisor).toBeDefined();
      expect(supervisor?.role).toBe("supervisor");

      const parser = getContract("parser");
      expect(parser).toBeDefined();
      expect(parser?.role).toBe("parser");
    });

    it("should return undefined for unknown roles", () => {
      const unknown = getContract("specialist" as AgentRole);
      expect(unknown).toBeUndefined();
    });
  });

  describe("validateAgentOutput", () => {
    it("should return valid result for correct output", () => {
      const result = validateAgentOutput("supervisor", {
        analysis: "Task analysis",
        routing: "specialist/ts",
        confidence: 0.8
      });
      expect(result.valid).toBe(true);
    });

    it("should return violation for incorrect output", () => {
      const result = validateAgentOutput("supervisor", {
        invalid: "structure"
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.violation.role).toBe("supervisor");
        expect(result.violation.expected).toBeDefined();
      }
    });

    it("should return valid for unknown roles (no contract)", () => {
      const result = validateAgentOutput("verifier", { anything: "goes" });
      expect(result.valid).toBe(true);
    });
  });

  describe("getViolationAction", () => {
    const mockViolation: ContractViolation = {
      role: "supervisor",
      expected: "analysis and routing strings",
      received: '{"invalid": true}',
      recoverable: true,
      suggestedFeedback: "Please provide analysis and routing"
    };

    it("should return retry for first violation", () => {
      const action = getViolationAction("supervisor", mockViolation, 0);
      expect(action.action).toBe("retry");
      if (action.action === "retry") {
        expect(action.feedback).toBeDefined();
      }
    });

    it("should escalate to verifier after one retry", () => {
      const action = getViolationAction("supervisor", mockViolation, 1);
      expect(action.action).toBe("escalate_verifier");
    });

    it("should still escalate after multiple failures", () => {
      // After maxRetries, it escalates to verifier
      const action = getViolationAction("supervisor", mockViolation, 3);
      expect(action.action).toBe("escalate_verifier");
    });

    it("should return error for unknown roles", () => {
      const unknownViolation: ContractViolation = {
        role: "specialist",
        expected: "something",
        received: "{}",
        recoverable: true
      };
      const action = getViolationAction("specialist", unknownViolation, 0);
      expect(action.action).toBe("error");
    });
  });

  describe("contract.onViolation", () => {
    it("supervisor contract should provide retry action for first violation", () => {
      const contract = supervisorContract;
      const violation: ContractViolation = {
        role: "supervisor",
        expected: "object with analysis, routing",
        received: "{}",
        recoverable: true,
        suggestedFeedback: "Provide analysis and routing"
      };
      
      const action = contract.onViolation(violation, 0);
      expect(action.action).toBe("retry");
    });

    it("parser contract should provide retry action for first violation", () => {
      const contract = parserContract;
      const violation: ContractViolation = {
        role: "parser",
        expected: "normalizedTask string",
        received: "{}",
        recoverable: true
      };
      
      const action = contract.onViolation(violation, 0);
      expect(action.action).toBe("retry");
    });

    it("planner contract should escalate after retry", () => {
      const contract = plannerContract;
      const violation: ContractViolation = {
        role: "planner",
        expected: "goalSummary and steps",
        received: "{}",
        recoverable: true
      };
      
      const action = contract.onViolation(violation, 1);
      expect(action.action).toBe("escalate_verifier");
    });

    it("synthesizer contract should error after retry", () => {
      const contract = synthesizerContract;
      const violation: ContractViolation = {
        role: "synthesizer",
        expected: "content",
        received: "null",
        recoverable: true
      };
      
      const action = contract.onViolation(violation, 1);
      expect(action.action).toBe("error");
    });
  });

  describe("bundle-only mode", () => {
    it("supervisor accepts bundleOnly flag", () => {
      const result = supervisorContract.parse({ bundleOnly: true });
      expect(result.valid).toBe(true);
    });

    it("parser accepts bundleOnly flag", () => {
      const result = parserContract.parse({ bundleOnly: true });
      expect(result.valid).toBe(true);
    });

    it("planner accepts bundleOnly flag", () => {
      const result = plannerContract.parse({ bundleOnly: true });
      expect(result.valid).toBe(true);
    });

    it("synthesizer accepts bundleOnly flag", () => {
      const result = synthesizerContract.parse({ bundleOnly: true });
      expect(result.valid).toBe(true);
    });
  });
});
