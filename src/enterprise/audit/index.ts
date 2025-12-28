/**
 * Enterprise Audit Module
 * 
 * Provides immutable, tamper-evident audit logging for compliance.
 */

// Types
export {
  type AuditEntry,
  type AuditAction,
  type AuditOutcome,
  type AuditQuery,
  type AuditStore,
  type AuditConfig,
  type ChainVerificationResult,
  type AuditErrorCode,
  AuditEntrySchema,
  AuditActionEnum,
  AuditOutcomeEnum,
  AuditQuerySchema,
  AuditConfigSchema,
  AuditError
} from "./types.js";

// Store implementation
export { 
  SqliteAuditStore, 
  createAuditEntryBuilder 
} from "./store.js";

// Middleware
export { 
  createAuditMiddleware,
  createAuditLogger,
  type AuditMiddlewareOptions 
} from "./middleware.js";
