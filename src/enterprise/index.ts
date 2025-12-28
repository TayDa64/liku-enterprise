/**
 * Liku Enterprise Module
 * 
 * Enterprise features for the Liku multi-agent orchestration framework.
 */

// Authentication
export * from "./auth/index.js";

// Audit Logging
export * from "./audit/index.js";

// Secrets Vault
export * from "./vault/index.js";

// Policy Engine
export * from "./policy/index.js";

// Enterprise HTTP Server
export { startEnterpriseHttpServer, type EnterpriseHttpConfig } from "../server/enterpriseHttp.js";

// Re-export common types for convenience
export type {
  User,
  Role,
  Permission,
  Tenant,
  RequestContext,
  OIDCConfig
} from "./auth/types.js";

export type {
  AuditEntry,
  AuditAction,
  AuditOutcome,
  AuditQuery,
  AuditConfig
} from "./audit/types.js";

export type {
  VaultProvider,
  VaultConfig,
  SecretValue,
  VaultClient
} from "./vault/types.js";

export type {
  OPAConfig,
  AuthzInput,
  AuthzDecision,
  PolicyResult,
  PolicyEngine
} from "./policy/types.js";
