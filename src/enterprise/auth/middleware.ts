import type { Context, Next, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { OIDCConfig, User, Tenant, RequestContext, Permission, Role } from "./types.js";
import { AuthError, ROLE_PERMISSIONS } from "./types.js";
import { JWTVerifier, type JWTPayload } from "./jwt.js";
import { TenantResolver } from "./tenantResolver.js";

/**
 * OIDC Authentication Middleware for Hono
 * 
 * Validates JWT tokens, resolves tenant context, and enforces RBAC.
 */

// Extend Hono context with auth info
declare module "hono" {
  interface ContextVariableMap {
    user: User;
    tenant: Tenant;
    requestContext: RequestContext;
  }
}

export type OIDCMiddlewareOptions = {
  config: OIDCConfig;
  tenantResolver: TenantResolver;
  /** Skip auth for these paths (e.g., health checks) */
  skipPaths?: string[];
  /** Extract tenant from header instead of token */
  tenantHeader?: string;
};

/**
 * Creates OIDC authentication middleware
 */
export function createOIDCMiddleware(options: OIDCMiddlewareOptions): MiddlewareHandler {
  const jwtVerifier = new JWTVerifier(options.config);
  const skipPaths = new Set(options.skipPaths ?? ["/health", "/ready"]);
  const tenantHeader = options.tenantHeader ?? "X-Tenant-ID";

  return async (c: Context, next: Next) => {
    // Skip auth for allowed paths
    if (skipPaths.has(c.req.path)) {
      return next();
    }

    const requestId = c.req.header("X-Request-ID") ?? crypto.randomUUID();

    try {
      // Extract and validate token
      const token = extractBearerToken(c);
      const payload = await jwtVerifier.verify(token);

      // Resolve tenant
      const tenantId = resolveTenantId(c, payload, options.config.tenantClaim, tenantHeader);
      const tenant = await options.tenantResolver.resolve(tenantId);

      // Build user from token claims
      const user = buildUserFromPayload(payload, tenant.id, options.config.rolesClaim);

      // Build request context
      const requestContext: RequestContext = {
        user,
        tenant,
        requestId,
        timestamp: new Date().toISOString(),
        sourceIp: c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? c.req.header("X-Real-IP"),
        userAgent: c.req.header("User-Agent")
      };

      // Set context variables
      c.set("user", user);
      c.set("tenant", tenant);
      c.set("requestContext", requestContext);

      // Add request ID to response headers
      c.header("X-Request-ID", requestId);

      return next();
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json(err.toJSON(), err.statusCode as 401 | 403);
      }
      throw err;
    }
  };
}

/**
 * RBAC middleware - checks if user has required permission
 */
export function requirePermission(...permissions: Permission[]): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    if (!user) {
      throw new AuthError("MISSING_TOKEN", "Authentication required");
    }

    const userPermissions = getUserPermissions(user.roles as Role[]);
    const hasPermission = permissions.some(p => userPermissions.has(p));

    if (!hasPermission) {
      throw new AuthError(
        "INSUFFICIENT_PERMISSIONS",
        `Required permissions: ${permissions.join(" or ")}`,
        403,
        { required: permissions, userRoles: user.roles }
      );
    }

    return next();
  };
}

/**
 * Role check middleware - checks if user has required role
 */
export function requireRole(...roles: Role[]): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    if (!user) {
      throw new AuthError("MISSING_TOKEN", "Authentication required");
    }

    const hasRole = roles.some(r => user.roles.includes(r));

    if (!hasRole) {
      throw new AuthError(
        "FORBIDDEN",
        `Required roles: ${roles.join(" or ")}`,
        403,
        { required: roles, userRoles: user.roles }
      );
    }

    return next();
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function extractBearerToken(c: Context): string {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    throw new AuthError("MISSING_TOKEN", "Authorization header required");
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    throw new AuthError("INVALID_TOKEN", "Invalid authorization header format");
  }

  return parts[1];
}

function resolveTenantId(
  c: Context,
  payload: JWTPayload,
  tenantClaim: string,
  tenantHeader: string
): string {
  // Try header first (allows tenant switching for admins)
  const headerTenantId = c.req.header(tenantHeader);
  if (headerTenantId) {
    return headerTenantId;
  }

  // Fall back to token claim
  const claimTenantId = payload[tenantClaim];
  if (typeof claimTenantId === "string" && claimTenantId) {
    return claimTenantId;
  }

  throw new AuthError("MISSING_TENANT", "Tenant ID not found in token or headers");
}

function buildUserFromPayload(payload: JWTPayload, tenantId: string, rolesClaim: string): User {
  const roles = extractRoles(payload, rolesClaim);

  return {
    id: payload.sub ?? "",
    email: (payload.email as string) ?? "",
    name: (payload.name as string) ?? (payload.preferred_username as string),
    tenantId,
    roles,
    claims: payload
  };
}

function extractRoles(payload: JWTPayload, rolesClaim: string): string[] {
  const rolesValue = payload[rolesClaim];

  if (Array.isArray(rolesValue)) {
    return rolesValue.filter((r): r is string => typeof r === "string");
  }

  if (typeof rolesValue === "string") {
    return rolesValue.split(",").map(r => r.trim()).filter(Boolean);
  }

  // Default to viewer if no roles specified
  return ["viewer"];
}

function getUserPermissions(roles: Role[]): Set<Permission> {
  const permissions = new Set<Permission>();

  for (const role of roles) {
    const rolePerms = ROLE_PERMISSIONS[role];
    if (rolePerms) {
      for (const perm of rolePerms) {
        permissions.add(perm);
      }
    }
  }

  return permissions;
}
