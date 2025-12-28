/**
 * Enterprise Policy Module
 * 
 * Provides OPA-based policy evaluation for fine-grained authorization.
 */

// Types
export {
  type OPAConfig,
  type AuthzInput,
  type AuthzDecision,
  type PolicyResult,
  type PolicyEngine,
  type PolicyInfo,
  type PolicyErrorCode,
  OPAConfigSchema,
  AuthzInputSchema,
  AuthzDecisionSchema,
  PolicyResultSchema,
  PolicyError
} from "./types.js";

// Engine implementations
export {
  EmbeddedPolicyEngine,
  RemoteOPAEngine,
  createPolicyEngine
} from "./engine.js";

// Middleware
export {
  createPolicyMiddleware,
  createPolicyChecker,
  type PolicyMiddlewareOptions
} from "./middleware.js";
