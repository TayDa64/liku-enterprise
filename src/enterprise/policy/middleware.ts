import type { Context, Next, MiddlewareHandler } from "hono";
import type { PolicyEngine, AuthzInput } from "./types.js";
import { PolicyError } from "./types.js";
import { AuthError } from "../auth/types.js";

/**
 * OPA Policy Middleware
 * 
 * Enforces authorization policies on HTTP requests.
 */

export type PolicyMiddlewareOptions = {
  engine: PolicyEngine;
  /** Extract action from request */
  actionExtractor?: (c: Context) => string;
  /** Extract resource from request */
  resourceExtractor?: (c: Context) => AuthzInput["resource"];
  /** Skip policy check for these paths */
  skipPaths?: string[];
  /** Log policy decisions */
  enableLogging?: boolean;
};

// Default action extraction from HTTP method + path
const DEFAULT_ACTION_MAP: Record<string, Record<string, string>> = {
  "/a2a/tasks/send": { POST: "tasks:create" },
  "/a2a/tasks/get": { POST: "tasks:read" },
  "/a2a/tasks/cancel": { POST: "tasks:cancel" },
  "/a2a/tasks/list": { GET: "tasks:list" },
  "/a2a/invoke": { POST: "agents:invoke" }
};

function defaultActionExtractor(c: Context): string {
  const pathActions = DEFAULT_ACTION_MAP[c.req.path];
  if (pathActions) {
    return pathActions[c.req.method] ?? `${c.req.method.toLowerCase()}:${c.req.path}`;
  }
  return `${c.req.method.toLowerCase()}:${c.req.path}`;
}

function defaultResourceExtractor(c: Context): AuthzInput["resource"] {
  return {
    type: "endpoint",
    id: c.req.path,
    path: c.req.path
  };
}

/**
 * Create policy enforcement middleware
 */
export function createPolicyMiddleware(options: PolicyMiddlewareOptions): MiddlewareHandler {
  const skipPaths = new Set(options.skipPaths ?? ["/health", "/ready"]);
  const actionExtractor = options.actionExtractor ?? defaultActionExtractor;
  const resourceExtractor = options.resourceExtractor ?? defaultResourceExtractor;
  const enableLogging = options.enableLogging ?? true;

  return async (c: Context, next: Next) => {
    // Skip policy check for allowed paths
    if (skipPaths.has(c.req.path)) {
      return next();
    }

    const user = c.get("user");
    const tenant = c.get("tenant");
    const requestContext = c.get("requestContext");

    // Can't enforce policy without auth context
    if (!user || !tenant) {
      return next();
    }

    const action = actionExtractor(c);
    const resource = resourceExtractor(c);

    // Add tenant to resource if not present
    if (!resource.tenantId) {
      resource.tenantId = tenant.id;
    }

    const input: AuthzInput = {
      action,
      resource,
      subject: {
        id: user.id,
        type: "user",
        tenantId: user.tenantId,
        roles: user.roles,
        attributes: user.claims
      },
      context: requestContext ? {
        requestId: requestContext.requestId,
        timestamp: requestContext.timestamp,
        ipAddress: requestContext.sourceIp,
        userAgent: requestContext.userAgent
      } : undefined
    };

    try {
      const result = await options.engine.authorize(input);

      if (enableLogging) {
        const level = result.decision.allow ? "info" : "warn";
        console[level]("[POLICY]", {
          action,
          resource: resource.id,
          subject: user.id,
          decision: result.decision.allow ? "ALLOW" : "DENY",
          rule: result.decision.rule,
          cached: result.metadata.cached,
          evaluationMs: result.metadata.evaluationMs
        });
      }

      if (!result.decision.allow) {
        throw new AuthError(
          "FORBIDDEN",
          result.decision.reason ?? "Access denied by policy",
          403,
          {
            action,
            resource: resource.id,
            rule: result.decision.rule,
            suggestion: result.decision.suggestion
          }
        );
      }

      // Store decision in context for audit logging
      c.set("policyDecision" as never, result as never);

      return next();
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err instanceof PolicyError) {
        // Policy evaluation failed - default deny
        throw new AuthError(
          "FORBIDDEN",
          `Policy evaluation failed: ${err.message}`,
          403
        );
      }
      throw err;
    }
  };
}

/**
 * Inline policy check for programmatic use
 */
export function createPolicyChecker(engine: PolicyEngine) {
  return {
    async check(
      action: string,
      resource: AuthzInput["resource"],
      subject: AuthzInput["subject"]
    ): Promise<boolean> {
      const result = await engine.authorize({ action, resource, subject });
      return result.decision.allow;
    },

    async require(
      action: string,
      resource: AuthzInput["resource"],
      subject: AuthzInput["subject"]
    ): Promise<void> {
      const result = await engine.authorize({ action, resource, subject });
      
      if (!result.decision.allow) {
        throw new AuthError(
          "FORBIDDEN",
          result.decision.reason ?? "Access denied by policy",
          403,
          {
            action,
            resource: resource.id,
            rule: result.decision.rule
          }
        );
      }
    }
  };
}
