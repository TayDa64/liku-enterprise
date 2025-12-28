import { z } from "zod";

/**
 * Secrets Vault Integration Types
 * 
 * Defines types for secrets management with multiple backend support.
 */

// ============================================================================
// Vault Configuration
// ============================================================================

export const VaultProviderEnum = z.enum([
  "hashicorp",  // HashiCorp Vault
  "aws",        // AWS Secrets Manager
  "azure",      // Azure Key Vault
  "env",        // Environment variables (development)
  "memory"      // In-memory (testing)
]);

export type VaultProvider = z.infer<typeof VaultProviderEnum>;

export const VaultConfigSchema = z.object({
  /** Vault provider type */
  provider: VaultProviderEnum,
  
  /** Provider-specific configuration */
  hashicorp: z.object({
    /** Vault server address */
    address: z.string().url(),
    /** Authentication token */
    token: z.string().optional(),
    /** AppRole auth */
    appRole: z.object({
      roleId: z.string(),
      secretId: z.string()
    }).optional(),
    /** Kubernetes auth */
    kubernetes: z.object({
      role: z.string(),
      jwtPath: z.string().default("/var/run/secrets/kubernetes.io/serviceaccount/token")
    }).optional(),
    /** Secret engine mount path */
    mountPath: z.string().default("secret"),
    /** Namespace (enterprise only) */
    namespace: z.string().optional()
  }).optional(),
  
  aws: z.object({
    /** AWS region */
    region: z.string(),
    /** Optional endpoint override (for LocalStack) */
    endpoint: z.string().url().optional(),
    /** Credential profile name */
    profile: z.string().optional()
  }).optional(),
  
  azure: z.object({
    /** Key Vault name */
    vaultName: z.string(),
    /** Tenant ID */
    tenantId: z.string().optional(),
    /** Client ID for service principal */
    clientId: z.string().optional()
  }).optional(),
  
  /** Cache TTL in seconds (0 = no cache) */
  cacheTtlSeconds: z.number().int().nonnegative().default(300),
  
  /** Prefix for secret paths */
  pathPrefix: z.string().default("liku/")
});

export type VaultConfig = z.infer<typeof VaultConfigSchema>;

// ============================================================================
// Secret Types
// ============================================================================

export const SecretMetadataSchema = z.object({
  /** Secret version */
  version: z.number().int().optional(),
  /** Creation time */
  createdAt: z.string().datetime().optional(),
  /** Last update time */
  updatedAt: z.string().datetime().optional(),
  /** Expiration time */
  expiresAt: z.string().datetime().optional(),
  /** Custom metadata */
  tags: z.record(z.string()).optional()
});

export type SecretMetadata = z.infer<typeof SecretMetadataSchema>;

export const SecretValueSchema = z.object({
  /** Secret key */
  key: z.string(),
  /** Secret value (string or structured data) */
  value: z.union([z.string(), z.record(z.unknown())]),
  /** Metadata */
  metadata: SecretMetadataSchema.optional()
});

export type SecretValue = z.infer<typeof SecretValueSchema>;

// ============================================================================
// Vault Client Interface
// ============================================================================

export interface VaultClient {
  /**
   * Get a secret by key
   */
  get(key: string): Promise<SecretValue | null>;
  
  /**
   * Get multiple secrets by keys
   */
  getMany(keys: string[]): Promise<Map<string, SecretValue>>;
  
  /**
   * Set a secret (if provider supports writes)
   */
  set(key: string, value: string | Record<string, unknown>, metadata?: Partial<SecretMetadata>): Promise<void>;
  
  /**
   * Delete a secret (if provider supports deletes)
   */
  delete(key: string): Promise<boolean>;
  
  /**
   * List secret keys under a path
   */
  list(pathPrefix?: string): Promise<string[]>;
  
  /**
   * Check if vault is healthy/connected
   */
  health(): Promise<{ healthy: boolean; provider: VaultProvider; message?: string }>;
  
  /**
   * Invalidate cache for a key
   */
  invalidateCache(key?: string): void;
}

// ============================================================================
// Well-Known Secret Keys
// ============================================================================

/** Standard secret keys used by Liku Enterprise */
export const SecretKeys = {
  // LLM API keys
  OPENAI_API_KEY: "llm/openai/api_key",
  ANTHROPIC_API_KEY: "llm/anthropic/api_key",
  
  // OIDC secrets
  OIDC_CLIENT_SECRET: "auth/oidc/client_secret",
  
  // Database credentials
  DB_PASSWORD: "db/password",
  DB_CONNECTION_STRING: "db/connection_string",
  
  // Encryption keys
  ENCRYPTION_KEY: "crypto/encryption_key",
  SIGNING_KEY: "crypto/signing_key",
  
  // External service credentials
  GITHUB_TOKEN: "integrations/github/token",
  SLACK_WEBHOOK: "integrations/slack/webhook"
} as const;

export type SecretKey = typeof SecretKeys[keyof typeof SecretKeys];

// ============================================================================
// Errors
// ============================================================================

export class VaultError extends Error {
  constructor(
    public readonly code: VaultErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export type VaultErrorCode =
  | "NOT_FOUND"
  | "ACCESS_DENIED"
  | "CONNECTION_FAILED"
  | "INVALID_CONFIG"
  | "WRITE_NOT_SUPPORTED"
  | "CACHE_ERROR";
