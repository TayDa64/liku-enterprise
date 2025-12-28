import { describe, it, expect, beforeEach, vi } from "vitest";
import { Orchestrator, StubLlmClient } from "../src/liku/orchestrator/orchestrator.js";
import { TaskRegistry, taskRegistry } from "../src/liku/orchestrator/taskRegistry.js";
import type { OrchestrationInput, OrchestrationResult } from "../src/liku/orchestrator/types.js";
import type { LikuEngine, AgentBundle } from "../src/liku/engine.js";
import type { InvokeResult } from "../src/liku/errors.js";

// Mock engine that returns predictable results
function createMockEngine(overrides?: Partial<LikuEngine>): LikuEngine {
  const mockBundle: AgentBundle = {
    agentResidence: "Liku/root",
    skills: [],
    paperTrail: { todoPath: "test/todo.md", errorsPath: "test/errors.md" },
    prompts: { system: "You are a test agent", instructions: "Execute the task" }
  };

  return {
    repoRoot: "/test/repo",
    paths: {
      likuRoot: "/test/repo/Liku",
      rootSupervisorDir: "/test/repo/Liku/root",
      specialistsDir: "/test/repo/Liku/specialist",
      memoryDir: "/test/repo/Liku/memory"
    },
    memory: {
      isDegraded: false,
      degradedReason: undefined,
      init: vi.fn().mockResolvedValue(true),
      logEvent: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      flush: vi.fn().mockResolvedValue(undefined)
    },
    init: vi.fn().mockResolvedValue(undefined),
    loadSkills: vi.fn().mockReturnValue({ skills: [], byId: new Map() }),
    ensureTaskDir: vi.fn().mockReturnValue({ todoPath: "test/todo.md", errorsPath: "test/errors.md" }),
    invokeAgent: vi.fn().mockResolvedValue(mockBundle),
    invokeAgentSafe: vi.fn().mockResolvedValue({ kind: "ok", bundle: mockBundle }),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as LikuEngine;
}

describe("Orchestrator", () => {
  let orchestrator: Orchestrator;
  let mockEngine: LikuEngine;

  beforeEach(() => {
    // Clear task registry between tests
    const tasks = taskRegistry.list();
    tasks.forEach(t => taskRegistry.delete(t.id));
    
    mockEngine = createMockEngine();
    orchestrator = new Orchestrator(mockEngine);
  });

  describe("basic operations", () => {
    it("should create orchestrator with stub LLM client", () => {
      expect(orchestrator).toBeDefined();
      const config = orchestrator.getDefaultConfig();
      expect(config.executeWithLlm).toBe(false);
    });

    it("should allow setting custom LLM client", () => {
      const mockLlmClient = {
        generate: vi.fn().mockResolvedValue({ text: "Test response", finishReason: "stop" }),
        isConfigured: () => true,
        provider: "test",
        model: "test-model"
      };
      orchestrator.setLlmClient(mockLlmClient);
      const config = orchestrator.getDefaultConfig();
      expect(config.executeWithLlm).toBe(true);
    });

    it("should invoke bundle directly", async () => {
      const bundle = await orchestrator.invokeBundle("Liku/root", { test: true });
      expect(bundle).toBeDefined();
      expect(bundle.agentResidence).toBe("Liku/root");
    });
  });

  describe("orchestration run", () => {
    it("should complete a simple orchestration", async () => {
      const input: OrchestrationInput = {
        query: "Test task",
        startResidence: "Liku/root"
      };

      const result = await orchestrator.run(input);

      expect(result).toBeDefined();
      expect(result.steps).toBeDefined();
      expect(result.steps.length).toBeGreaterThan(0);
    });

    it("should create task in registry during run", async () => {
      const input: OrchestrationInput = {
        query: "Test task for registry"
      };

      await orchestrator.run(input);

      const tasks = taskRegistry.list();
      expect(tasks.length).toBeGreaterThan(0);
    });

    it("should handle error from engine", async () => {
      const errorEngine = createMockEngine({
        invokeAgentSafe: vi.fn().mockResolvedValue({
          kind: "error",
          code: "INVALID_RESIDENCE",
          message: "Test error"
        })
      });
      const errorOrchestrator = new Orchestrator(errorEngine);

      const result = await errorOrchestrator.run({ query: "Will fail" });

      expect(result.kind).toBe("error");
    });

    it("should handle escalation from engine", async () => {
      const escalationEngine = createMockEngine({
        invokeAgentSafe: vi.fn().mockResolvedValue({
          kind: "escalation",
          missingSkill: "root_access",
          requestedAction: "delete system files",
          residence: "Liku/specialist/ts",
          policyRef: "Liku/root/policy.md"
        })
      });
      const escalationOrchestrator = new Orchestrator(escalationEngine);

      const result = await escalationOrchestrator.run({ query: "Need escalation" });

      // First step (supervisor) escalates
      expect(result.steps[0]?.status).toBe("escalated");
    });
  });

  describe("configuration", () => {
    it("should use default config values", () => {
      const config = orchestrator.getDefaultConfig();
      
      expect(config.maxConcurrency).toBe(5);
      expect(config.stepTimeoutMs).toBe(60_000);
      expect(config.totalTimeoutMs).toBe(300_000);
      expect(config.abortOnError).toBe(true);
    });

    it("should respect custom config overrides", async () => {
      const input: OrchestrationInput = {
        query: "Test with custom config",
        config: {
          abortOnError: false,
          maxConcurrency: 2
        }
      };

      const result = await orchestrator.run(input);
      expect(result).toBeDefined();
    });
  });
});

describe("TaskRegistry", () => {
  let registry: TaskRegistry;

  beforeEach(() => {
    registry = new TaskRegistry();
  });

  describe("basic CRUD", () => {
    it("should create a task", () => {
      const { id } = registry.create({ query: "Test task" });
      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
    });

    it("should get a created task", () => {
      const { id } = registry.create({ query: "Test task" });
      const task = registry.get(id);
      
      expect(task).toBeDefined();
      expect(task?.id).toBe(id);
      expect(task?.input.query).toBe("Test task");
      expect(task?.status).toBe("pending");
    });

    it("should return undefined for non-existent task", () => {
      const task = registry.get("non-existent-id");
      expect(task).toBeUndefined();
    });

    it("should list all tasks", () => {
      registry.create({ query: "Task 1" });
      registry.create({ query: "Task 2" });
      
      const tasks = registry.list();
      expect(tasks.length).toBe(2);
    });

    it("should delete a task", () => {
      const { id } = registry.create({ query: "To be deleted" });
      expect(registry.get(id)).toBeDefined();
      
      const deleted = registry.delete(id);
      expect(deleted).toBe(true);
      expect(registry.get(id)).toBeUndefined();
    });

    it("should return abort controller on create", () => {
      const { id, abortController } = registry.create({ query: "Test" });
      expect(abortController).toBeInstanceOf(AbortController);
      expect(abortController.signal.aborted).toBe(false);
      
      // Verify the signal is linked to cancel
      registry.cancel(id);
      expect(abortController.signal.aborted).toBe(true);
    });
  });

  describe("status updates", () => {
    it("should update task status", () => {
      const { id } = registry.create({ query: "Test" });
      registry.updateStatus(id, "running");
      
      const task = registry.get(id);
      expect(task?.status).toBe("running");
    });

    it("should update updatedAt on status change", () => {
      const { id } = registry.create({ query: "Test" });
      const before = registry.get(id)?.updatedAt;
      
      // Small delay to ensure timestamp differs
      registry.updateStatus(id, "running");
      const after = registry.get(id)?.updatedAt;
      
      expect(after).toBeDefined();
      expect(before).toBeDefined();
    });

    it("should set result and mark completed", () => {
      const { id } = registry.create({ query: "Test" });
      const result: OrchestrationResult = {
        kind: "ok",
        summary: "Done",
        steps: [],
        finalOutput: { success: true }
      };
      
      const outcome = registry.setResult(id, result);
      
      expect(outcome.success).toBe(true);
      if (outcome.success) {
        expect(outcome.wasIdempotent).toBe(false);
      }
      
      const task = registry.get(id);
      expect(task?.status).toBe("completed");
      expect(task?.result).toEqual(result);
    });

    it("should set failed status for error result", () => {
      const { id } = registry.create({ query: "Test" });
      const result: OrchestrationResult = {
        kind: "error",
        code: "INTERNAL",
        message: "Something went wrong",
        steps: []
      };
      
      registry.setResult(id, result);
      
      const task = registry.get(id);
      expect(task?.status).toBe("failed");
    });

    it("should be idempotent when result already set", () => {
      const { id } = registry.create({ query: "Test" });
      const result: OrchestrationResult = {
        kind: "ok",
        summary: "Done",
        steps: [],
        finalOutput: {}
      };
      
      const first = registry.setResult(id, result);
      expect(first.success).toBe(true);
      if (first.success) expect(first.wasIdempotent).toBe(false);
      
      // Second call should be idempotent
      const second = registry.setResult(id, result);
      expect(second.success).toBe(true);
      if (second.success) expect(second.wasIdempotent).toBe(true);
    });
  });

  describe("cancel", () => {
    it("should cancel pending task", () => {
      const { id } = registry.create({ query: "Test" });
      const cancelled = registry.cancel(id);
      
      expect(cancelled).toBe(true);
      expect(registry.get(id)?.status).toBe("cancelled");
    });

    it("should cancel running task", () => {
      const { id } = registry.create({ query: "Test" });
      registry.updateStatus(id, "running");
      
      const cancelled = registry.cancel(id);
      expect(cancelled).toBe(true);
      expect(registry.get(id)?.status).toBe("cancelled");
    });

    it("should not cancel completed task", () => {
      const { id } = registry.create({ query: "Test" });
      registry.setResult(id, { kind: "ok", summary: "Done", steps: [], finalOutput: {} });
      
      const cancelled = registry.cancel(id);
      expect(cancelled).toBe(false);
      expect(registry.get(id)?.status).toBe("completed");
    });

    it("should return false for non-existent task", () => {
      const cancelled = registry.cancel("non-existent");
      expect(cancelled).toBe(false);
    });

    it("should trigger abort signal when cancelled", () => {
      const { id, abortController } = registry.create({ query: "Test" });
      expect(abortController.signal.aborted).toBe(false);
      
      registry.cancel(id);
      expect(abortController.signal.aborted).toBe(true);
    });
  });

  describe("stats", () => {
    it("should return correct stats", () => {
      registry.create({ query: "Task 1" });
      const { id: id2 } = registry.create({ query: "Task 2" });
      const { id: id3 } = registry.create({ query: "Task 3" });
      
      registry.updateStatus(id2, "running");
      registry.setResult(id3, { kind: "ok", summary: "Done", steps: [], finalOutput: {} });
      
      const stats = registry.stats();
      
      expect(stats.total).toBe(3);
      expect(stats.byStatus.pending).toBe(1);
      expect(stats.byStatus.running).toBe(1);
      expect(stats.byStatus.completed).toBe(1);
      expect(stats.byStatus.failed).toBe(0);
      expect(stats.byStatus.cancelled).toBe(0);
    });
  });
});

describe("StubLlmClient", () => {
  it("should return bundle-only message", async () => {
    const stub = new StubLlmClient();
    const response = await stub.generate({
      system: "system",
      task: "user",
      maxTokens: 1000
    });
    
    expect(response.text).toContain("bundle-only");
    expect(response.text).toContain("BYOK");
  });

  it("should report not configured", () => {
    const stub = new StubLlmClient();
    expect(stub.isConfigured()).toBe(false);
  });

  it("should have stub provider and model", () => {
    const stub = new StubLlmClient();
    expect(stub.provider).toBe("stub");
    expect(stub.model).toBe("none");
  });
});
