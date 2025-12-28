/**
 * Enterprise Secrets Vault Module
 * 
 * Provides secure secrets management with multiple backend support.
 */

// Types
export {
  type VaultProvider,
  type VaultConfig,
  type SecretValue,
  type SecretMetadata,
  type VaultClient,
  type VaultErrorCode,
  VaultProviderEnum,
  VaultConfigSchema,
  SecretValueSchema,
  SecretMetadataSchema,
  SecretKeys,
  VaultError
} from "./types.js";

// Client implementations
export {
  InMemoryVaultClient,
  EnvVaultClient,
  HashiCorpVaultClient,
  createVaultClient
} from "./client.js";
