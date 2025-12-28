import { z } from "zod";

/**
 * OPA (Open Policy Agent) Integration Types
 * 
 * Defines types for policy-as-code authorization.
 */

// ============================================================================
// Policy Configuration
// ============================================================================

export const OPAConfigSchema = z.object({
  /** OPA evaluation mode */
  mode: z.enum(["embedded", "remote"]).default("embedded"),
  
  /** Remote OPA server endpoint (for remote mode) */
  endpoint: z.string().url().optional(),
  
  /** Path to policy bundle directory (for embedded mode) */
  policyPath: z.string().optional(),
  
  /** Default policy package name */
  defaultPackage: z.string().default("liku.authz"),
  
  /** Cache policy decisions for this many seconds */
  cacheTtlSeconds: z.number().int().nonnegative().default(60),
  
  /** Timeout for policy evaluation in ms */
  timeoutMs: z.number().int().positive().default(1000),
  
  /** Enable decision logging */
  enableLogging: z.boolean().default(true)
});

export type OPAConfig = z.infer<typeof OPAConfigSchema>;

// ============================================================================
// Policy Input/Output Types
// ============================================================================

/** Standard input for authorization decisions */
export const AuthzInputSchema = z.object({
  /** The action being performed */
  action: z.string(),
  
  /** The resource being accessed */
  resource: z.object({
    type: z.string(),
    id: z.string(),
    tenantId: z.string().optional(),
    path: z.string().optional(),
    attributes: z.record(z.unknown()).optional()
  }),
  
  /** The subject (user/service) making the request */
  subject: z.object({
    id: z.string(),
    type: z.enum(["user", "service", "agent"]),
    tenantId: z.string(),
    roles: z.array(z.string()),
    attributes: z.record(z.unknown()).optional()
  }),
  
  /** Request context */
  context: z.object({
    requestId: z.string().optional(),
    timestamp: z.string().datetime().optional(),
    ipAddress: z.string().optional(),
    userAgent: z.string().optional()
  }).optional()
});

export type AuthzInput = z.infer<typeof AuthzInputSchema>;

/** Authorization decision result */
export const AuthzDecisionSchema = z.object({
  /** Whether the action is allowed */
  allow: z.boolean(),
  
  /** Reason for the decision (for logging/debugging) */
  reason: z.string().optional(),
  
  /** Which policy rule made the decision */
  rule: z.string().optional(),
  
  /** Additional constraints on the allowed action */
  constraints: z.record(z.unknown()).optional(),
  
  /** Suggested alternative if denied */
  suggestion: z.string().optional()
});

export type AuthzDecision = z.infer<typeof AuthzDecisionSchema>;

/** Full policy evaluation result */
export const PolicyResultSchema = z.object({
  /** The decision */
  decision: AuthzDecisionSchema,
  
  /** Evaluation metadata */
  metadata: z.object({
    /** Policy package evaluated */
    package: z.string(),
    /** Evaluation time in ms */
    evaluationMs: z.number(),
    /** Whether result was from cache */
    cached: z.boolean(),
    /** Policy version if available */
    policyVersion: z.string().optional()
  })
});

export type PolicyResult = z.infer<typeof PolicyResultSchema>;

// ============================================================================
// Policy Engine Interface
// ============================================================================

export interface PolicyEngine {
  /**
   * Evaluate an authorization policy
   */
  authorize(input: AuthzInput): Promise<PolicyResult>;
  
  /**
   * Evaluate a custom policy query
   */
  evaluate<T = unknown>(query: string, input: unknown): Promise<T>;
  
  /**
   * Load/reload policies from source
   */
  loadPolicies(): Promise<void>;
  
  /**
   * Check if policy engine is healthy
   */
  health(): Promise<{ healthy: boolean; mode: string; message?: string }>;
  
  /**
   * Get policy metadata
   */
  getPolicyInfo(): Promise<PolicyInfo>;
  
  /**
   * Clear decision cache
   */
  clearCache(): void;
}

export type PolicyInfo = {
  packages: string[];
  rules: string[];
  loadedAt: string;
  version?: string;
};

// ============================================================================
// Errors
// ============================================================================

export class PolicyError extends Error {
  constructor(
    public readonly code: PolicyErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

export type PolicyErrorCode =
  | "POLICY_NOT_FOUND"
  | "EVALUATION_FAILED"
  | "TIMEOUT"
  | "INVALID_INPUT"
  | "CONNECTION_FAILED"
  | "POLICY_LOAD_FAILED";
