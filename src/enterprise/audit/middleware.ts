import type { Context, Next, MiddlewareHandler } from "hono";
import type { AuditStore, AuditAction, AuditOutcome, AuditEntry } from "./types.js";

/**
 * Audit Logging Middleware
 * 
 * Automatically logs HTTP requests to the audit store.
 */

export type AuditMiddlewareOptions = {
  store: AuditStore;
  /** Map route patterns to audit actions */
  actionMap?: Map<string, AuditAction>;
  /** Skip logging for these paths */
  skipPaths?: string[];
  /** Extract resource from request */
  resourceExtractor?: (c: Context) => { type: string; id: string; path?: string } | null;
};

// Default route to action mapping
const DEFAULT_ACTION_MAP = new Map<string, AuditAction>([
  ["POST /a2a/tasks/send", "task.create"],
  ["POST /a2a/tasks/get", "task.create"], // Reading is still logged
  ["POST /a2a/tasks/cancel", "task.cancel"],
  ["POST /a2a/invoke", "agent.invoke"]
]);

/**
 * Create audit logging middleware
 */
export function createAuditMiddleware(options: AuditMiddlewareOptions): MiddlewareHandler {
  const actionMap = options.actionMap ?? DEFAULT_ACTION_MAP;
  const skipPaths = new Set(options.skipPaths ?? ["/health", "/ready"]);

  return async (c: Context, next: Next) => {
    // Skip specified paths
    if (skipPaths.has(c.req.path)) {
      return next();
    }

    const startTime = Date.now();
    const routeKey = `${c.req.method} ${c.req.path}`;
    const action = actionMap.get(routeKey);

    // If no action mapped, skip audit logging
    if (!action) {
      return next();
    }

    // Execute request
    let outcome: AuditOutcome = "success";
    let errorInfo: AuditEntry["error"] | undefined;

    try {
      await next();

      // Determine outcome from response status
      const status = c.res.status;
      if (status >= 400 && status < 500) {
        outcome = "denied";
      } else if (status >= 500) {
        outcome = "error";
      }
    } catch (err) {
      outcome = "error";
      errorInfo = {
        code: (err as Error).name ?? "UNKNOWN_ERROR",
        message: (err as Error).message ?? "Unknown error"
      };
      throw err;
    } finally {
      // Log audit entry
      const requestContext = c.get("requestContext");
      const user = c.get("user");
      const tenant = c.get("tenant");

      if (user && tenant) {
        const resource = options.resourceExtractor?.(c) ?? extractResourceFromPath(c);

        try {
          await options.store.append({
            timestamp: new Date().toISOString(),
            actor: {
              userId: user.id,
              email: user.email,
              ipAddress: requestContext?.sourceIp,
              userAgent: requestContext?.userAgent
            },
            tenantId: tenant.id,
            action,
            outcome,
            resource,
            requestId: requestContext?.requestId,
            details: {
              method: c.req.method,
              path: c.req.path,
              durationMs: Date.now() - startTime,
              statusCode: c.res.status
            },
            error: errorInfo
          });
        } catch (auditErr) {
          // Log audit failure but don't fail the request
          console.error("[AUDIT] Failed to log entry:", auditErr);
        }
      }
    }
  };
}

/**
 * Extract resource info from request path
 */
function extractResourceFromPath(c: Context): { type: string; id: string; path?: string } {
  const path = c.req.path;

  // Extract task ID from tasks endpoints
  if (path.includes("/tasks/")) {
    try {
      const body = c.req.raw.clone();
      // Would need to parse body for taskId
    } catch {
      // Ignore parse errors
    }
  }

  // Default to path-based resource
  return {
    type: "endpoint",
    id: path,
    path
  };
}

/**
 * Manual audit logging helper
 */
export function createAuditLogger(store: AuditStore) {
  return {
    async log(
      c: Context,
      action: AuditAction,
      resource: { type: string; id: string; path?: string },
      outcome: AuditOutcome,
      details?: Record<string, unknown>,
      error?: { code: string; message: string }
    ): Promise<void> {
      const requestContext = c.get("requestContext");
      const user = c.get("user");
      const tenant = c.get("tenant");

      if (!user || !tenant) {
        console.warn("[AUDIT] Cannot log without user/tenant context");
        return;
      }

      await store.append({
        timestamp: new Date().toISOString(),
        actor: {
          userId: user.id,
          email: user.email,
          ipAddress: requestContext?.sourceIp,
          userAgent: requestContext?.userAgent
        },
        tenantId: tenant.id,
        action,
        outcome,
        resource,
        requestId: requestContext?.requestId,
        details,
        error
      });
    },

    /**
     * Log a task operation
     */
    async logTask(
      c: Context,
      action: Extract<AuditAction, `task.${string}`>,
      taskId: string,
      outcome: AuditOutcome,
      details?: Record<string, unknown>
    ): Promise<void> {
      await this.log(c, action, { type: "task", id: taskId }, outcome, details);
    },

    /**
     * Log an agent operation
     */
    async logAgent(
      c: Context,
      action: Extract<AuditAction, `agent.${string}`>,
      agentPath: string,
      outcome: AuditOutcome,
      details?: Record<string, unknown>
    ): Promise<void> {
      await this.log(c, action, { type: "agent", id: agentPath, path: agentPath }, outcome, details);
    },

    /**
     * Log a security event
     */
    async logSecurity(
      c: Context,
      action: Extract<AuditAction, `security.${string}`>,
      resourceType: string,
      resourceId: string,
      details?: Record<string, unknown>
    ): Promise<void> {
      await this.log(c, action, { type: resourceType, id: resourceId }, "denied", details);
    }
  };
}
