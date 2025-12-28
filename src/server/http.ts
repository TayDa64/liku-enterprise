import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import type { LikuEngine } from "../liku/engine.js";
import { toLikuError } from "../liku/errors.js";
import { Orchestrator } from "../liku/orchestrator/index.js";
import { taskRegistry } from "../liku/orchestrator/taskRegistry.js";
import { ConcurrencyLimiter, CapacityExceededError } from "../liku/utils/concurrencyLimiter.js";

const InvokeSchema = z.object({
  agentResidence: z.string(),
  task: z.unknown()
});

const TaskSendSchema = z.object({
  query: z.string(),
  startResidence: z.string().optional(),
  config: z.object({
    maxConcurrency: z.number().optional(),
    stepTimeoutMs: z.number().optional(),
    totalTimeoutMs: z.number().optional(),
    executeWithLlm: z.boolean().optional(),
    abortOnError: z.boolean().optional()
  }).optional()
});

const TaskIdSchema = z.object({
  taskId: z.string()
});

export type HttpServerConfig = {
  engine: LikuEngine;
  port: number;
  /** Maximum concurrent task executions */
  maxConcurrentTasks?: number;
  /** Timeout for waiting in queue (ms) */
  queueTimeoutMs?: number;
};

export async function startHttpServer(options: HttpServerConfig): Promise<void> {
  const app = new Hono();
  const orchestrator = new Orchestrator(options.engine);
  
  // Ingress limiter - only wraps task entry points (not reads/cancels)
  const limiter = new ConcurrencyLimiter({
    maxConcurrent: options.maxConcurrentTasks ?? 5,
    queueTimeoutMs: options.queueTimeoutMs ?? 30_000
  });

  // Global error handler
  app.onError((err, c) => {
    // Handle capacity exceeded errors with A2A-compliant response
    if (err instanceof CapacityExceededError) {
      return c.json({
        kind: "error",
        errorType: "capacity_exceeded",
        message: err.message,
        retryAfterMs: err.retryAfterMs
      }, 503);
    }
    const likuErr = toLikuError(err);
    return c.json(likuErr.toJSON(), 500);
  });

  app.get("/health", (c) => {
    const memoryStatus = options.engine.memory.isDegraded
      ? { status: "degraded", reason: options.engine.memory.degradedReason }
      : { status: "ok" };
    const taskStats = taskRegistry.stats();
    const limiterStats = {
      running: limiter.running,
      queued: limiter.queued,
      atCapacity: limiter.atCapacity
    };
    return c.json({ ok: true, memory: memoryStatus, tasks: taskStats, limiter: limiterStats });
  });

  // Legacy invoke endpoint (bundle-only, single agent)
  // Wrapped in limiter since it executes agent logic
  app.post("/a2a/invoke", async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ code: "BAD_REQUEST", message: "Invalid JSON body" }, 400);
    }

    let input: z.infer<typeof InvokeSchema>;
    try {
      input = InvokeSchema.parse(json);
    } catch (parseErr) {
      const likuErr = toLikuError(parseErr);
      return c.json(likuErr.toJSON(), 400);
    }

    // Wrap in limiter - don't create task if limiter rejects
    const result = await limiter.run(async () => {
      return options.engine.invokeAgentSafe({
        agentResidence: input.agentResidence,
        task: input.task ?? null
      });
    });

    if (result.kind === "error") {
      const status = result.code === "BAD_REQUEST" || result.code === "INVALID_RESIDENCE" || result.code === "PATH_TRAVERSAL" ? 400 : 500;
      return c.json(result, status);
    }

    return c.json(result);
  });

  // A2A tasks/send - Start a new orchestration task
  // Wrapped in limiter - the main entry point for orchestration
  app.post("/a2a/tasks/send", async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ code: "BAD_REQUEST", message: "Invalid JSON body" }, 400);
    }

    let input: z.infer<typeof TaskSendSchema>;
    try {
      input = TaskSendSchema.parse(json);
    } catch (parseErr) {
      const likuErr = toLikuError(parseErr);
      return c.json(likuErr.toJSON(), 400);
    }

    // Build orchestration input
    const orchestrationInput: Parameters<typeof orchestrator.run>[0] = {
      query: input.query
    };
    if (input.startResidence) {
      orchestrationInput.startResidence = input.startResidence;
    }
    if (input.config) {
      const config: Parameters<typeof orchestrator.run>[0]["config"] = {};
      if (input.config.maxConcurrency !== undefined) config.maxConcurrency = input.config.maxConcurrency;
      if (input.config.stepTimeoutMs !== undefined) config.stepTimeoutMs = input.config.stepTimeoutMs;
      if (input.config.totalTimeoutMs !== undefined) config.totalTimeoutMs = input.config.totalTimeoutMs;
      if (input.config.executeWithLlm !== undefined) config.executeWithLlm = input.config.executeWithLlm;
      if (input.config.abortOnError !== undefined) config.abortOnError = input.config.abortOnError;
      if (Object.keys(config).length > 0) {
        orchestrationInput.config = config;
      }
    }

    // Wrap in limiter - don't create task in registry if limiter rejects
    const result = await limiter.run(async () => {
      return orchestrator.run(orchestrationInput);
    });

    // Find the task that was created for this run
    const tasks = taskRegistry.list();
    const lastTask = tasks[tasks.length - 1];

    return c.json({
      taskId: lastTask?.id ?? "unknown",
      status: lastTask?.status ?? "completed",
      result
    });
  });

  // A2A tasks/get - Get task status and result (no limiter needed - read-only)
  app.post("/a2a/tasks/get", async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ code: "BAD_REQUEST", message: "Invalid JSON body" }, 400);
    }

    let input: z.infer<typeof TaskIdSchema>;
    try {
      input = TaskIdSchema.parse(json);
    } catch (parseErr) {
      const likuErr = toLikuError(parseErr);
      return c.json(likuErr.toJSON(), 400);
    }

    const task = taskRegistry.get(input.taskId);
    if (!task) {
      return c.json({ code: "NOT_FOUND", message: `Task ${input.taskId} not found` }, 404);
    }

    return c.json(task);
  });

  // A2A tasks/cancel - Cancel a running task (no limiter needed - control operation)
  app.post("/a2a/tasks/cancel", async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ code: "BAD_REQUEST", message: "Invalid JSON body" }, 400);
    }

    let input: z.infer<typeof TaskIdSchema>;
    try {
      input = TaskIdSchema.parse(json);
    } catch (parseErr) {
      const likuErr = toLikuError(parseErr);
      return c.json(likuErr.toJSON(), 400);
    }

    const cancelled = taskRegistry.cancel(input.taskId);
    if (!cancelled) {
      return c.json({ code: "NOT_FOUND", message: `Task ${input.taskId} not found or already finished` }, 404);
    }

    return c.json({ cancelled: true, taskId: input.taskId });
  });

  // A2A tasks/list - List all tasks (no limiter needed - read-only)
  app.get("/a2a/tasks/list", (c) => {
    const tasks = taskRegistry.list();
    const stats = taskRegistry.stats();
    return c.json({ tasks, stats });
  });

  serve({ fetch: app.fetch, port: options.port });
  // Log to stderr to avoid stdout pollution if this is used with other tools
  process.stderr.write(`[LIKU] HTTP server listening on http://localhost:${options.port}\n`);
}

