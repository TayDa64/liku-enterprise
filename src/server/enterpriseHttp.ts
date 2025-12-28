import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import type { LikuEngine } from "../liku/engine.js";
import { toLikuError } from "../liku/errors.js";
import { Orchestrator } from "../liku/orchestrator/index.js";
import { taskRegistry } from "../liku/orchestrator/taskRegistry.js";
import { ConcurrencyLimiter, CapacityExceededError } from "../liku/utils/concurrencyLimiter.js";

// Enterprise imports
import {
  createOIDCMiddleware,
  requirePermission,
  TenantResolver,
  InMemoryTenantStore,
  TenantRateLimiter,
  createRateLimitMiddleware,
  createDefaultTenant,
  AuthError,
  type OIDCConfig
} from "../enterprise/auth/index.js";
import {
  SqliteAuditStore,
  createAuditMiddleware,
  createAuditLogger,
  type AuditConfig
} from "../enterprise/audit/index.js";
import {
  createPolicyEngine,
  createPolicyMiddleware,
  type OPAConfig
} from "../enterprise/policy/index.js";

// ============================================================================
// Schema Definitions
// ============================================================================

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

const AuditQuerySchema = z.object({
  tenantId: z.string().optional(),
  actorId: z.string().optional(),
  actions: z.array(z.string()).optional(),
  outcomes: z.array(z.string()).optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  limit: z.number().optional(),
  afterSequence: z.number().optional()
});

// ============================================================================
// Configuration Types
// ============================================================================

export type EnterpriseHttpConfig = {
  engine: LikuEngine;
  port: number;
  /** Maximum concurrent task executions */
  maxConcurrentTasks?: number;
  /** Timeout for waiting in queue (ms) */
  queueTimeoutMs?: number;
  /** Enterprise features */
  enterprise?: {
    /** Enable enterprise features */
    enabled: boolean;
    /** OIDC configuration */
    oidc?: OIDCConfig;
    /** Audit configuration */
    audit?: AuditConfig;
    /** Policy configuration */
    policy?: OPAConfig;
    /** Initial tenants for development */
    initialTenants?: Array<{ id: string; name: string }>;
  };
};

// ============================================================================
// Enterprise HTTP Server
// ============================================================================

export async function startEnterpriseHttpServer(options: EnterpriseHttpConfig): Promise<void> {
  const app = new Hono();
  const orchestrator = new Orchestrator(options.engine);
  
  // Base concurrency limiter
  const baseLimiter = new ConcurrencyLimiter({
    maxConcurrent: options.maxConcurrentTasks ?? 5,
    queueTimeoutMs: options.queueTimeoutMs ?? 30_000
  });

  // Enterprise components (initialized if enabled)
  let auditStore: SqliteAuditStore | null = null;
  let auditLogger: ReturnType<typeof createAuditLogger> | null = null;
  let tenantRateLimiter: TenantRateLimiter | null = null;

  // ============================================================================
  // Enterprise Middleware Setup
  // ============================================================================

  if (options.enterprise?.enabled) {
    // Initialize audit store
    const auditConfig: AuditConfig = options.enterprise.audit ?? {
      storage: "sqlite",
      hashAlgorithm: "sha256",
      retentionDays: 0,
      enableBatching: false,
      batchIntervalMs: 1000,
      maxBatchSize: 100
    };
    auditStore = new SqliteAuditStore(auditConfig);
    await auditStore.init();
    auditLogger = createAuditLogger(auditStore);

    // Initialize tenant store
    const tenantStore = new InMemoryTenantStore([
      createDefaultTenant(),
      ...(options.enterprise.initialTenants ?? []).map(t => ({
        ...createDefaultTenant(),
        id: t.id,
        name: t.name
      }))
    ]);
    const tenantResolver = new TenantResolver(tenantStore);

    // Initialize tenant rate limiter
    tenantRateLimiter = new TenantRateLimiter({
      defaultRpm: 100,
      defaultMaxConcurrent: 10,
      windowMs: 60_000
    });

    // Initialize policy engine
    const policyConfig: OPAConfig = options.enterprise.policy ?? {
      mode: "embedded",
      defaultPackage: "liku.authz",
      cacheTtlSeconds: 60,
      timeoutMs: 1000,
      enableLogging: true
    };
    const policyEngine = createPolicyEngine(policyConfig);

    // Setup OIDC middleware if configured
    if (options.enterprise.oidc) {
      app.use("*", createOIDCMiddleware({
        config: options.enterprise.oidc,
        tenantResolver,
        skipPaths: ["/health", "/ready"],
        tenantHeader: "X-Tenant-ID"
      }));
    }

    // Rate limiting middleware
    app.use("*", createRateLimitMiddleware(tenantRateLimiter));

    // Policy enforcement middleware
    app.use("*", createPolicyMiddleware({
      engine: policyEngine,
      skipPaths: ["/health", "/ready"],
      enableLogging: true
    }));

    // Audit logging middleware
    app.use("*", createAuditMiddleware({
      store: auditStore,
      skipPaths: ["/health", "/ready"]
    }));

    process.stderr.write("[LIKU] Enterprise features enabled: OIDC, RBAC, Audit, Policy\n");
  }

  // ============================================================================
  // Error Handler
  // ============================================================================

  app.onError(async (err, c) => {
    // Handle auth errors
    if (err instanceof AuthError) {
      return c.json(err.toJSON(), err.statusCode as 401 | 403 | 429);
    }

    // Handle capacity exceeded errors
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

  // ============================================================================
  // Health & Ready Endpoints
  // ============================================================================

  app.get("/health", (c) => {
    const memoryStatus = options.engine.memory.isDegraded
      ? { status: "degraded", reason: options.engine.memory.degradedReason }
      : { status: "ok" };
    const taskStats = taskRegistry.stats();
    const limiterStats = {
      running: baseLimiter.running,
      queued: baseLimiter.queued,
      atCapacity: baseLimiter.atCapacity
    };
    
    const enterprise = options.enterprise?.enabled ? {
      enabled: true,
      oidc: !!options.enterprise.oidc,
      audit: !!auditStore,
      policy: true
    } : { enabled: false };

    return c.json({ 
      ok: true, 
      memory: memoryStatus, 
      tasks: taskStats, 
      limiter: limiterStats,
      enterprise
    });
  });

  app.get("/ready", (c) => {
    return c.json({ ready: true });
  });

  // ============================================================================
  // A2A Endpoints
  // ============================================================================

  // Legacy invoke endpoint
  app.post("/a2a/invoke", requirePermission("agents:invoke"), async (c) => {
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

    const result = await baseLimiter.run(async () => {
      return options.engine.invokeAgentSafe({
        agentResidence: input.agentResidence,
        task: input.task ?? null
      });
    });

    // Audit log on success
    if (result.kind === "ok" && auditLogger) {
      await auditLogger.logAgent(c, "agent.invoke", input.agentResidence, "success", {
        taskDir: result.data.paperTrail.todoPath
      });
    }

    if (result.kind === "error") {
      const status = result.code === "BAD_REQUEST" || result.code === "INVALID_RESIDENCE" || result.code === "PATH_TRAVERSAL" ? 400 : 500;
      return c.json(result, status);
    }

    return c.json(result);
  });

  // A2A tasks/send
  app.post("/a2a/tasks/send", requirePermission("tasks:create"), async (c) => {
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

    const result = await baseLimiter.run(async () => {
      return orchestrator.run(orchestrationInput);
    });

    const tasks = taskRegistry.list();
    const lastTask = tasks[tasks.length - 1];

    // Audit log
    if (auditLogger && lastTask) {
      const outcome = result.kind === "ok" ? "success" : result.kind === "error" ? "failure" : "success";
      await auditLogger.logTask(c, "task.create", lastTask.id, outcome, {
        query: input.query,
        resultKind: result.kind
      });
    }

    return c.json({
      taskId: lastTask?.id ?? "unknown",
      status: lastTask?.status ?? "completed",
      result
    });
  });

  // A2A tasks/get
  app.post("/a2a/tasks/get", requirePermission("tasks:read"), async (c) => {
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

  // A2A tasks/cancel
  app.post("/a2a/tasks/cancel", requirePermission("tasks:cancel"), async (c) => {
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

    // Audit log
    if (auditLogger) {
      await auditLogger.logTask(c, "task.cancel", input.taskId, "success");
    }

    return c.json({ cancelled: true, taskId: input.taskId });
  });

  // A2A tasks/list
  app.get("/a2a/tasks/list", requirePermission("tasks:list"), (c) => {
    const tasks = taskRegistry.list();
    const stats = taskRegistry.stats();
    return c.json({ tasks, stats });
  });

  // ============================================================================
  // Audit Endpoints (Enterprise Only)
  // ============================================================================

  if (options.enterprise?.enabled && auditStore) {
    // Query audit logs
    app.post("/enterprise/audit/query", requirePermission("audit:read"), async (c) => {
      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        return c.json({ code: "BAD_REQUEST", message: "Invalid JSON body" }, 400);
      }

      let query: z.infer<typeof AuditQuerySchema>;
      try {
        query = AuditQuerySchema.parse(json);
      } catch (parseErr) {
        const likuErr = toLikuError(parseErr);
        return c.json(likuErr.toJSON(), 400);
      }

      const entries = await auditStore!.query({
        ...query,
        actions: query.actions as import("../enterprise/audit/types.js").AuditAction[] | undefined,
        outcomes: query.outcomes as import("../enterprise/audit/types.js").AuditOutcome[] | undefined,
        limit: query.limit ?? 100
      });

      return c.json({ entries, count: entries.length });
    });

    // Export audit logs
    app.post("/enterprise/audit/export", requirePermission("audit:export"), async (c) => {
      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        return c.json({ code: "BAD_REQUEST", message: "Invalid JSON body" }, 400);
      }

      const input = z.object({
        format: z.enum(["json", "csv"]).default("json"),
        ...AuditQuerySchema.shape
      }).parse(json);

      const { format, ...query } = input;
      const exported = await auditStore!.export({
        ...query,
        actions: query.actions as import("../enterprise/audit/types.js").AuditAction[] | undefined,
        outcomes: query.outcomes as import("../enterprise/audit/types.js").AuditOutcome[] | undefined,
        limit: query.limit ?? 10000
      }, format);

      if (format === "csv") {
        c.header("Content-Type", "text/csv");
        c.header("Content-Disposition", "attachment; filename=audit-log.csv");
      }

      return c.text(exported);
    });

    // Verify audit chain integrity
    app.post("/enterprise/audit/verify", requirePermission("audit:read"), async (c) => {
      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        return c.json({ code: "BAD_REQUEST", message: "Invalid JSON body" }, 400);
      }

      const input = z.object({
        startSequence: z.number().int().nonnegative(),
        endSequence: z.number().int().nonnegative()
      }).parse(json);

      const result = await auditStore!.verifyChain(input.startSequence, input.endSequence);
      return c.json(result);
    });
  }

  // ============================================================================
  // Start Server
  // ============================================================================

  serve({ fetch: app.fetch, port: options.port });
  process.stderr.write(`[LIKU] Enterprise HTTP server listening on http://localhost:${options.port}\n`);
}
