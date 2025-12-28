import { z } from "zod";

/**
 * Immutable Audit Logging Types
 * 
 * Defines types for tamper-evident, append-only audit logging.
 */

// ============================================================================
// Audit Entry
// ============================================================================

export const AuditActionEnum = z.enum([
  // Authentication
  "auth.login",
  "auth.logout",
  "auth.token_refresh",
  "auth.token_revoke",
  
  // Task operations
  "task.create",
  "task.start",
  "task.complete",
  "task.cancel",
  "task.fail",
  
  // Agent operations
  "agent.invoke",
  "agent.escalate",
  "agent.error",
  
  // Plan operations
  "plan.validate",
  "plan.reject",
  "plan.execute",
  
  // Tenant operations
  "tenant.create",
  "tenant.update",
  "tenant.suspend",
  "tenant.delete",
  
  // User operations
  "user.create",
  "user.update",
  "user.delete",
  "user.role_change",
  
  // Policy operations
  "policy.evaluate",
  "policy.deny",
  "policy.update",
  
  // System operations
  "system.config_change",
  "system.startup",
  "system.shutdown",
  
  // Security events
  "security.rate_limited",
  "security.permission_denied",
  "security.invalid_token"
]);

export type AuditAction = z.infer<typeof AuditActionEnum>;

export const AuditOutcomeEnum = z.enum([
  "success",
  "failure",
  "denied",
  "error"
]);

export type AuditOutcome = z.infer<typeof AuditOutcomeEnum>;

export const AuditEntrySchema = z.object({
  /** Unique entry ID (UUID) */
  id: z.string().uuid(),
  
  /** Entry sequence number (monotonically increasing) */
  sequence: z.number().int().nonnegative(),
  
  /** ISO 8601 timestamp with timezone */
  timestamp: z.string().datetime(),
  
  /** Hash of previous entry (chain integrity) */
  previousHash: z.string(),
  
  /** Hash of this entry's content */
  contentHash: z.string(),
  
  // Actor information
  actor: z.object({
    /** User ID (or "system" for automated) */
    userId: z.string(),
    /** User email */
    email: z.string().optional(),
    /** Service account name if applicable */
    serviceAccount: z.string().optional(),
    /** IP address */
    ipAddress: z.string().optional(),
    /** User agent */
    userAgent: z.string().optional()
  }),
  
  /** Tenant context */
  tenantId: z.string(),
  
  /** Action performed */
  action: AuditActionEnum,
  
  /** Outcome of the action */
  outcome: AuditOutcomeEnum,
  
  /** Resource affected */
  resource: z.object({
    /** Resource type (task, agent, tenant, etc.) */
    type: z.string(),
    /** Resource identifier */
    id: z.string(),
    /** Additional resource context */
    path: z.string().optional()
  }),
  
  /** Request/correlation ID for tracing */
  requestId: z.string().optional(),
  
  /** Additional structured details */
  details: z.record(z.unknown()).optional(),
  
  /** Error information if outcome is error/failure */
  error: z.object({
    code: z.string(),
    message: z.string(),
    stack: z.string().optional()
  }).optional()
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ============================================================================
// Audit Query
// ============================================================================

export const AuditQuerySchema = z.object({
  /** Filter by tenant */
  tenantId: z.string().optional(),
  
  /** Filter by actor */
  actorId: z.string().optional(),
  
  /** Filter by action(s) */
  actions: z.array(AuditActionEnum).optional(),
  
  /** Filter by outcome(s) */
  outcomes: z.array(AuditOutcomeEnum).optional(),
  
  /** Filter by resource type */
  resourceType: z.string().optional(),
  
  /** Filter by resource ID */
  resourceId: z.string().optional(),
  
  /** Start time (inclusive) */
  startTime: z.string().datetime().optional(),
  
  /** End time (exclusive) */
  endTime: z.string().datetime().optional(),
  
  /** Start sequence (for pagination) */
  afterSequence: z.number().optional(),
  
  /** Max results to return */
  limit: z.number().int().positive().default(100),
  
  /** Sort order */
  order: z.enum(["asc", "desc"]).default("desc")
});

export type AuditQuery = z.infer<typeof AuditQuerySchema>;

// ============================================================================
// Audit Store Interface
// ============================================================================

export interface AuditStore {
  /**
   * Append an entry to the audit log.
   * Must be atomic and append-only.
   */
  append(entry: Omit<AuditEntry, "id" | "sequence" | "previousHash" | "contentHash">): Promise<AuditEntry>;
  
  /**
   * Query audit entries
   */
  query(query: AuditQuery): Promise<AuditEntry[]>;
  
  /**
   * Get entry by ID
   */
  getById(id: string): Promise<AuditEntry | null>;
  
  /**
   * Get entry by sequence number
   */
  getBySequence(sequence: number): Promise<AuditEntry | null>;
  
  /**
   * Get the latest entry (for chain verification)
   */
  getLatest(): Promise<AuditEntry | null>;
  
  /**
   * Verify chain integrity from sequence A to B
   */
  verifyChain(startSequence: number, endSequence: number): Promise<ChainVerificationResult>;
  
  /**
   * Export entries for compliance/archival
   */
  export(query: AuditQuery, format: "json" | "csv"): Promise<string>;
}

export type ChainVerificationResult = {
  valid: boolean;
  startSequence: number;
  endSequence: number;
  entriesChecked: number;
  /** First broken link if invalid */
  brokenAt?: number;
  /** Expected vs actual hash if broken */
  hashMismatch?: {
    expected: string;
    actual: string;
  };
};

// ============================================================================
// Configuration
// ============================================================================

export const AuditConfigSchema = z.object({
  /** Storage backend */
  storage: z.enum(["sqlite", "postgres", "s3"]).default("sqlite"),
  
  /** Connection string / path */
  connectionString: z.string().optional(),
  
  /** Retention period in days (0 = forever) */
  retentionDays: z.number().int().nonnegative().default(0),
  
  /** Hash algorithm for chain */
  hashAlgorithm: z.enum(["sha256", "sha384", "sha512"]).default("sha256"),
  
  /** Enable async batching for performance */
  enableBatching: z.boolean().default(false),
  
  /** Batch flush interval in ms */
  batchIntervalMs: z.number().int().positive().default(1000),
  
  /** Max batch size */
  maxBatchSize: z.number().int().positive().default(100)
});

export type AuditConfig = z.infer<typeof AuditConfigSchema>;

// ============================================================================
// Audit Errors
// ============================================================================

export class AuditError extends Error {
  constructor(
    public readonly code: AuditErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AuditError";
  }
}

export type AuditErrorCode =
  | "APPEND_FAILED"
  | "CHAIN_BROKEN"
  | "ENTRY_NOT_FOUND"
  | "QUERY_FAILED"
  | "EXPORT_FAILED"
  | "STORAGE_ERROR";
