import type { VaultClient, VaultConfig, SecretValue, SecretMetadata, VaultProvider } from "./types.js";
import { VaultError } from "./types.js";

/**
 * Vault Client Implementations
 * 
 * Provides secret retrieval from multiple backends with caching.
 */

// ============================================================================
// Base Client with Caching
// ============================================================================

type CacheEntry = {
  value: SecretValue;
  fetchedAt: number;
};

abstract class BaseVaultClient implements VaultClient {
  protected cache: Map<string, CacheEntry> = new Map();
  protected config: VaultConfig;
  protected cacheTtlMs: number;

  constructor(config: VaultConfig) {
    this.config = config;
    this.cacheTtlMs = config.cacheTtlSeconds * 1000;
  }

  async get(key: string): Promise<SecretValue | null> {
    const fullKey = this.config.pathPrefix + key;

    // Check cache
    if (this.cacheTtlMs > 0) {
      const cached = this.cache.get(fullKey);
      if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
        return cached.value;
      }
    }

    // Fetch from backend
    const value = await this.fetchSecret(fullKey);
    
    if (value && this.cacheTtlMs > 0) {
      this.cache.set(fullKey, { value, fetchedAt: Date.now() });
    }

    return value;
  }

  async getMany(keys: string[]): Promise<Map<string, SecretValue>> {
    const results = new Map<string, SecretValue>();
    
    // Fetch in parallel
    const promises = keys.map(async key => {
      const value = await this.get(key);
      if (value) {
        results.set(key, value);
      }
    });

    await Promise.all(promises);
    return results;
  }

  invalidateCache(key?: string): void {
    if (key) {
      this.cache.delete(this.config.pathPrefix + key);
    } else {
      this.cache.clear();
    }
  }

  // Abstract methods for backends to implement
  protected abstract fetchSecret(fullKey: string): Promise<SecretValue | null>;
  abstract set(key: string, value: string | Record<string, unknown>, metadata?: Partial<SecretMetadata>): Promise<void>;
  abstract delete(key: string): Promise<boolean>;
  abstract list(pathPrefix?: string): Promise<string[]>;
  abstract health(): Promise<{ healthy: boolean; provider: VaultProvider; message?: string }>;
}

// ============================================================================
// In-Memory Client (Testing)
// ============================================================================

export class InMemoryVaultClient extends BaseVaultClient {
  private secrets: Map<string, SecretValue> = new Map();

  constructor(config: VaultConfig, initialSecrets?: Map<string, string | Record<string, unknown>>) {
    super(config);
    
    if (initialSecrets) {
      for (const [key, value] of initialSecrets) {
        this.secrets.set(this.config.pathPrefix + key, {
          key,
          value,
          metadata: { createdAt: new Date().toISOString() }
        });
      }
    }
  }

  protected async fetchSecret(fullKey: string): Promise<SecretValue | null> {
    return this.secrets.get(fullKey) ?? null;
  }

  async set(key: string, value: string | Record<string, unknown>, metadata?: Partial<SecretMetadata>): Promise<void> {
    const fullKey = this.config.pathPrefix + key;
    const now = new Date().toISOString();
    
    this.secrets.set(fullKey, {
      key,
      value,
      metadata: {
        createdAt: this.secrets.get(fullKey)?.metadata?.createdAt ?? now,
        updatedAt: now,
        ...metadata
      }
    });

    // Invalidate cache
    this.invalidateCache(key);
  }

  async delete(key: string): Promise<boolean> {
    const fullKey = this.config.pathPrefix + key;
    const deleted = this.secrets.delete(fullKey);
    this.invalidateCache(key);
    return deleted;
  }

  async list(pathPrefix?: string): Promise<string[]> {
    const prefix = this.config.pathPrefix + (pathPrefix ?? "");
    const keys: string[] = [];
    
    for (const fullKey of this.secrets.keys()) {
      if (fullKey.startsWith(prefix)) {
        keys.push(fullKey.slice(this.config.pathPrefix.length));
      }
    }
    
    return keys;
  }

  async health(): Promise<{ healthy: boolean; provider: VaultProvider; message?: string }> {
    return { healthy: true, provider: "memory" };
  }
}

// ============================================================================
// Environment Variable Client (Development)
// ============================================================================

export class EnvVaultClient extends BaseVaultClient {
  constructor(config: VaultConfig) {
    super(config);
  }

  protected async fetchSecret(fullKey: string): Promise<SecretValue | null> {
    // Convert path to env var name: liku/llm/openai/api_key -> LIKU_LLM_OPENAI_API_KEY
    const envName = fullKey
      .toUpperCase()
      .replace(/\//g, "_")
      .replace(/-/g, "_");
    
    const value = process.env[envName];
    
    if (value === undefined) {
      return null;
    }

    return {
      key: fullKey.slice(this.config.pathPrefix.length),
      value,
      metadata: {}
    };
  }

  async set(): Promise<void> {
    throw new VaultError("WRITE_NOT_SUPPORTED", "Environment variable vault is read-only");
  }

  async delete(): Promise<boolean> {
    throw new VaultError("WRITE_NOT_SUPPORTED", "Environment variable vault is read-only");
  }

  async list(): Promise<string[]> {
    // Return env vars that match our prefix pattern
    const prefix = this.config.pathPrefix
      .toUpperCase()
      .replace(/\//g, "_")
      .replace(/-/g, "_");
    
    return Object.keys(process.env)
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length).toLowerCase().replace(/_/g, "/"));
  }

  async health(): Promise<{ healthy: boolean; provider: VaultProvider; message?: string }> {
    return { healthy: true, provider: "env" };
  }
}

// ============================================================================
// HashiCorp Vault Client (Production)
// ============================================================================

export class HashiCorpVaultClient extends BaseVaultClient {
  private token: string | null = null;

  constructor(config: VaultConfig) {
    super(config);
    
    if (!config.hashicorp) {
      throw new VaultError("INVALID_CONFIG", "HashiCorp Vault config required");
    }
    
    this.token = config.hashicorp.token ?? null;
  }

  private get vaultConfig() {
    return this.config.hashicorp!;
  }

  private async getToken(): Promise<string> {
    if (this.token) {
      return this.token;
    }

    // AppRole authentication
    if (this.vaultConfig.appRole) {
      const response = await fetch(`${this.vaultConfig.address}/v1/auth/approle/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role_id: this.vaultConfig.appRole.roleId,
          secret_id: this.vaultConfig.appRole.secretId
        })
      });

      if (!response.ok) {
        throw new VaultError("ACCESS_DENIED", "AppRole authentication failed");
      }

      const data = await response.json() as { auth: { client_token: string } };
      this.token = data.auth.client_token;
      return this.token;
    }

    // Kubernetes authentication
    if (this.vaultConfig.kubernetes) {
      const fs = await import("node:fs");
      const jwt = fs.readFileSync(this.vaultConfig.kubernetes.jwtPath, "utf8");

      const response = await fetch(`${this.vaultConfig.address}/v1/auth/kubernetes/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: this.vaultConfig.kubernetes.role,
          jwt
        })
      });

      if (!response.ok) {
        throw new VaultError("ACCESS_DENIED", "Kubernetes authentication failed");
      }

      const data = await response.json() as { auth: { client_token: string } };
      this.token = data.auth.client_token;
      return this.token;
    }

    throw new VaultError("INVALID_CONFIG", "No authentication method configured for HashiCorp Vault");
  }

  protected async fetchSecret(fullKey: string): Promise<SecretValue | null> {
    const token = await this.getToken();
    const url = `${this.vaultConfig.address}/v1/${this.vaultConfig.mountPath}/data/${fullKey}`;

    const headers: Record<string, string> = {
      "X-Vault-Token": token
    };

    if (this.vaultConfig.namespace) {
      headers["X-Vault-Namespace"] = this.vaultConfig.namespace;
    }

    try {
      const response = await fetch(url, { headers });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new VaultError("ACCESS_DENIED", `Failed to fetch secret: ${response.status}`);
      }

      const data = await response.json() as {
        data: {
          data: Record<string, unknown>;
          metadata: { version: number; created_time: string; deletion_time: string }
        }
      };

      // Vault KV v2 stores data in data.data
      const secretData = data.data.data;
      const value = secretData.value ?? secretData;

      return {
        key: fullKey.slice(this.config.pathPrefix.length),
        value: value as string | Record<string, unknown>,
        metadata: {
          version: data.data.metadata.version,
          createdAt: data.data.metadata.created_time
        }
      };
    } catch (err) {
      if (err instanceof VaultError) throw err;
      throw new VaultError("CONNECTION_FAILED", `Vault connection failed: ${(err as Error).message}`);
    }
  }

  async set(key: string, value: string | Record<string, unknown>): Promise<void> {
    const token = await this.getToken();
    const fullKey = this.config.pathPrefix + key;
    const url = `${this.vaultConfig.address}/v1/${this.vaultConfig.mountPath}/data/${fullKey}`;

    const headers: Record<string, string> = {
      "X-Vault-Token": token,
      "Content-Type": "application/json"
    };

    if (this.vaultConfig.namespace) {
      headers["X-Vault-Namespace"] = this.vaultConfig.namespace;
    }

    const body = JSON.stringify({
      data: typeof value === "string" ? { value } : value
    });

    const response = await fetch(url, { method: "POST", headers, body });

    if (!response.ok) {
      throw new VaultError("ACCESS_DENIED", `Failed to write secret: ${response.status}`);
    }

    this.invalidateCache(key);
  }

  async delete(key: string): Promise<boolean> {
    const token = await this.getToken();
    const fullKey = this.config.pathPrefix + key;
    const url = `${this.vaultConfig.address}/v1/${this.vaultConfig.mountPath}/data/${fullKey}`;

    const headers: Record<string, string> = {
      "X-Vault-Token": token
    };

    if (this.vaultConfig.namespace) {
      headers["X-Vault-Namespace"] = this.vaultConfig.namespace;
    }

    const response = await fetch(url, { method: "DELETE", headers });
    this.invalidateCache(key);
    
    return response.ok;
  }

  async list(pathPrefix?: string): Promise<string[]> {
    const token = await this.getToken();
    const fullPrefix = this.config.pathPrefix + (pathPrefix ?? "");
    const url = `${this.vaultConfig.address}/v1/${this.vaultConfig.mountPath}/metadata/${fullPrefix}?list=true`;

    const headers: Record<string, string> = {
      "X-Vault-Token": token
    };

    if (this.vaultConfig.namespace) {
      headers["X-Vault-Namespace"] = this.vaultConfig.namespace;
    }

    const response = await fetch(url, { headers });

    if (response.status === 404) {
      return [];
    }

    if (!response.ok) {
      throw new VaultError("ACCESS_DENIED", `Failed to list secrets: ${response.status}`);
    }

    const data = await response.json() as { data: { keys: string[] } };
    return data.data.keys.map(k => (pathPrefix ?? "") + k);
  }

  async health(): Promise<{ healthy: boolean; provider: VaultProvider; message?: string }> {
    try {
      const response = await fetch(`${this.vaultConfig.address}/v1/sys/health`);
      const data = await response.json() as { sealed: boolean; initialized: boolean };
      
      return {
        healthy: response.ok && !data.sealed && data.initialized,
        provider: "hashicorp",
        message: data.sealed ? "Vault is sealed" : undefined
      };
    } catch (err) {
      return {
        healthy: false,
        provider: "hashicorp",
        message: (err as Error).message
      };
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createVaultClient(config: VaultConfig): VaultClient {
  switch (config.provider) {
    case "memory":
      return new InMemoryVaultClient(config);
    case "env":
      return new EnvVaultClient(config);
    case "hashicorp":
      return new HashiCorpVaultClient(config);
    case "aws":
      // TODO: Implement AWS Secrets Manager client
      throw new VaultError("INVALID_CONFIG", "AWS Secrets Manager not yet implemented");
    case "azure":
      // TODO: Implement Azure Key Vault client
      throw new VaultError("INVALID_CONFIG", "Azure Key Vault not yet implemented");
    default:
      throw new VaultError("INVALID_CONFIG", `Unknown vault provider: ${config.provider}`);
  }
}
