/**
 * Enterprise Authentication Module
 * 
 * Provides SSO/OIDC authentication, RBAC, multi-tenancy, and rate limiting.
 */

// Types
export {
  type User,
  type Role,
  type Permission,
  type Tenant,
  type RequestContext,
  type OIDCConfig,
  type AuthErrorCode,
  type AuthErrorResponse,
  UserSchema,
  RoleEnum,
  PermissionEnum,
  TenantSchema,
  RequestContextSchema,
  OIDCConfigSchema,
  AuthError,
  ROLE_PERMISSIONS
} from "./types.js";

// JWT Verification
export { JWTVerifier, type JWTPayload, type JWKSet, type JWK } from "./jwt.js";

// Middleware
export {
  createOIDCMiddleware,
  requirePermission,
  requireRole,
  type OIDCMiddlewareOptions
} from "./middleware.js";

// Tenant Resolution
export {
  TenantResolver,
  InMemoryTenantStore,
  createDefaultTenant,
  type TenantStore
} from "./tenantResolver.js";

// Rate Limiting
export {
  TenantRateLimiter,
  createRateLimitMiddleware,
  createConcurrentTaskMiddleware,
  type RateLimitConfig,
  type RateLimitResult
} from "./rateLimiter.js";
