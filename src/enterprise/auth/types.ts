import { z } from "zod";

/**
 * Enterprise Authentication Types
 * 
 * Defines the core types for SSO/OIDC authentication, RBAC, and tenant context.
 */

// ============================================================================
// User & Identity
// ============================================================================

export const UserSchema = z.object({
  /** Unique user identifier from IdP (sub claim) */
  id: z.string(),
  /** User's email address */
  email: z.string().email(),
  /** Display name */
  name: z.string().optional(),
  /** Tenant the user belongs to */
  tenantId: z.string(),
  /** Assigned roles */
  roles: z.array(z.string()),
  /** Raw claims from OIDC token */
  claims: z.record(z.unknown()).optional()
});

export type User = z.infer<typeof UserSchema>;

// ============================================================================
// Roles & Permissions
// ============================================================================

/** Built-in enterprise roles */
export const RoleEnum = z.enum([
  "admin",      // Full access, manage tenants, view audit logs
  "developer",  // Create/run tasks, manage own agents
  "viewer",     // Read-only access to task results
  "auditor"     // Read audit logs, no task execution
]);

export type Role = z.infer<typeof RoleEnum>;

/** Fine-grained permissions */
export const PermissionEnum = z.enum([
  // Task operations
  "tasks:create",
  "tasks:read",
  "tasks:cancel",
  "tasks:list",
  
  // Agent operations
  "agents:invoke",
  "agents:read",
  "agents:manage",
  
  // Tenant operations
  "tenants:read",
  "tenants:manage",
  "tenants:create",
  
  // Audit operations
  "audit:read",
  "audit:export",
  
  // Admin operations
  "admin:users",
  "admin:roles",
  "admin:config"
]);

export type Permission = z.infer<typeof PermissionEnum>;

/** Role to permissions mapping */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    "tasks:create", "tasks:read", "tasks:cancel", "tasks:list",
    "agents:invoke", "agents:read", "agents:manage",
    "tenants:read", "tenants:manage", "tenants:create",
    "audit:read", "audit:export",
    "admin:users", "admin:roles", "admin:config"
  ],
  developer: [
    "tasks:create", "tasks:read", "tasks:cancel", "tasks:list",
    "agents:invoke", "agents:read"
  ],
  viewer: [
    "tasks:read", "tasks:list",
    "agents:read"
  ],
  auditor: [
    "tasks:read", "tasks:list",
    "audit:read", "audit:export"
  ]
};

// ============================================================================
// Tenant Context
// ============================================================================

export const TenantSchema = z.object({
  /** Unique tenant identifier */
  id: z.string(),
  /** Human-readable tenant name */
  name: z.string(),
  /** Tenant status */
  status: z.enum(["active", "suspended", "pending"]),
  /** Rate limiting config */
  rateLimits: z.object({
    /** Max concurrent tasks */
    maxConcurrentTasks: z.number().default(10),
    /** Requests per minute */
    requestsPerMinute: z.number().default(100),
    /** Daily task quota */
    dailyTaskQuota: z.number().optional()
  }).optional(),
  /** Tenant metadata */
  metadata: z.record(z.unknown()).optional(),
  /** Creation timestamp */
  createdAt: z.string().datetime(),
  /** Last update timestamp */
  updatedAt: z.string().datetime()
});

export type Tenant = z.infer<typeof TenantSchema>;

// ============================================================================
// Request Context
// ============================================================================

export const RequestContextSchema = z.object({
  /** Authenticated user */
  user: UserSchema,
  /** Resolved tenant */
  tenant: TenantSchema,
  /** Request ID for tracing */
  requestId: z.string(),
  /** Request timestamp */
  timestamp: z.string().datetime(),
  /** Source IP address */
  sourceIp: z.string().optional(),
  /** User agent string */
  userAgent: z.string().optional()
});

export type RequestContext = z.infer<typeof RequestContextSchema>;

// ============================================================================
// OIDC Configuration
// ============================================================================

export const OIDCConfigSchema = z.object({
  /** OIDC issuer URL */
  issuer: z.string().url(),
  /** Client ID */
  clientId: z.string(),
  /** Client secret (for confidential clients) */
  clientSecret: z.string().optional(),
  /** Expected audience */
  audience: z.string().optional(),
  /** JWKS URI (auto-discovered if not provided) */
  jwksUri: z.string().url().optional(),
  /** Token endpoint (auto-discovered if not provided) */
  tokenEndpoint: z.string().url().optional(),
  /** Claim to use for tenant ID */
  tenantClaim: z.string().default("tenant_id"),
  /** Claim to use for roles */
  rolesClaim: z.string().default("roles"),
  /** Clock tolerance in seconds for token validation */
  clockTolerance: z.number().default(60),
  /** Cache JWKS for this many seconds */
  jwksCacheTtl: z.number().default(3600)
});

export type OIDCConfig = z.infer<typeof OIDCConfigSchema>;

// ============================================================================
// Auth Errors
// ============================================================================

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly statusCode: number = 401,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AuthError";
  }

  toJSON(): AuthErrorResponse {
    return {
      kind: "auth_error",
      code: this.code,
      message: this.message,
      details: this.details
    };
  }
}

export type AuthErrorCode =
  | "MISSING_TOKEN"
  | "INVALID_TOKEN"
  | "TOKEN_EXPIRED"
  | "INVALID_ISSUER"
  | "INVALID_AUDIENCE"
  | "MISSING_TENANT"
  | "INVALID_TENANT"
  | "TENANT_SUSPENDED"
  | "FORBIDDEN"
  | "INSUFFICIENT_PERMISSIONS"
  | "RATE_LIMITED";

export type AuthErrorResponse = {
  kind: "auth_error";
  code: AuthErrorCode;
  message: string;
  details?: Record<string, unknown>;
};
