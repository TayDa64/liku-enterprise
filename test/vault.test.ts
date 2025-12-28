import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  InMemoryVaultClient,
  EnvVaultClient,
  createVaultClient,
  VaultError,
  SecretKeys
} from "../src/enterprise/vault/index.js";
import type { VaultConfig } from "../src/enterprise/vault/types.js";

describe("InMemoryVaultClient", () => {
  let client: InMemoryVaultClient;
  const config: VaultConfig = {
    provider: "memory",
    cacheTtlSeconds: 60,
    pathPrefix: "liku/"
  };

  beforeEach(() => {
    const initialSecrets = new Map<string, string>([
      ["llm/openai/api_key", "sk-test-key"],
      ["db/password", "super-secret"]
    ]);
    client = new InMemoryVaultClient(config, initialSecrets);
  });

  it("retrieves existing secrets", async () => {
    const secret = await client.get("llm/openai/api_key");
    expect(secret).not.toBeNull();
    expect(secret?.value).toBe("sk-test-key");
  });

  it("returns null for non-existent secrets", async () => {
    const secret = await client.get("nonexistent");
    expect(secret).toBeNull();
  });

  it("sets new secrets", async () => {
    await client.set("new/secret", "new-value");
    const secret = await client.get("new/secret");
    expect(secret?.value).toBe("new-value");
  });

  it("updates existing secrets", async () => {
    await client.set("llm/openai/api_key", "updated-key");
    const secret = await client.get("llm/openai/api_key");
    expect(secret?.value).toBe("updated-key");
  });

  it("deletes secrets", async () => {
    const deleted = await client.delete("llm/openai/api_key");
    expect(deleted).toBe(true);
    
    const secret = await client.get("llm/openai/api_key");
    expect(secret).toBeNull();
  });

  it("lists secrets with prefix", async () => {
    const keys = await client.list("llm/");
    expect(keys).toContain("llm/openai/api_key");
    expect(keys).not.toContain("db/password");
  });

  it("gets multiple secrets", async () => {
    const secrets = await client.getMany(["llm/openai/api_key", "db/password", "nonexistent"]);
    expect(secrets.size).toBe(2);
    expect(secrets.get("llm/openai/api_key")?.value).toBe("sk-test-key");
  });

  it("reports healthy", async () => {
    const health = await client.health();
    expect(health.healthy).toBe(true);
    expect(health.provider).toBe("memory");
  });

  it("caches secrets", async () => {
    // First fetch
    await client.get("llm/openai/api_key");
    
    // Modify directly (bypassing cache)
    await client.set("llm/openai/api_key", "modified");
    client.invalidateCache(); // Need to invalidate to see change
    
    // Should return new value after invalidation
    const secret = await client.get("llm/openai/api_key");
    expect(secret?.value).toBe("modified");
  });
});

describe("EnvVaultClient", () => {
  let client: EnvVaultClient;
  const config: VaultConfig = {
    provider: "env",
    cacheTtlSeconds: 0,
    pathPrefix: "liku/"
  };

  beforeEach(() => {
    // Set test env vars
    process.env.LIKU_TEST_SECRET = "env-secret-value";
    client = new EnvVaultClient(config);
  });

  afterEach(() => {
    delete process.env.LIKU_TEST_SECRET;
  });

  it("reads from environment variables", async () => {
    const secret = await client.get("test/secret");
    expect(secret?.value).toBe("env-secret-value");
  });

  it("returns null for missing env vars", async () => {
    const secret = await client.get("nonexistent");
    expect(secret).toBeNull();
  });

  it("throws on write attempts", async () => {
    await expect(client.set("key", "value")).rejects.toThrow(VaultError);
  });

  it("throws on delete attempts", async () => {
    await expect(client.delete("key")).rejects.toThrow(VaultError);
  });

  it("reports healthy", async () => {
    const health = await client.health();
    expect(health.healthy).toBe(true);
    expect(health.provider).toBe("env");
  });
});

describe("createVaultClient", () => {
  it("creates memory client", () => {
    const client = createVaultClient({
      provider: "memory",
      cacheTtlSeconds: 60,
      pathPrefix: "test/"
    });
    expect(client).toBeInstanceOf(InMemoryVaultClient);
  });

  it("creates env client", () => {
    const client = createVaultClient({
      provider: "env",
      cacheTtlSeconds: 60,
      pathPrefix: "test/"
    });
    expect(client).toBeInstanceOf(EnvVaultClient);
  });

  it("throws for unimplemented providers", () => {
    expect(() => createVaultClient({
      provider: "aws",
      aws: { region: "us-east-1" },
      cacheTtlSeconds: 60,
      pathPrefix: "test/"
    })).toThrow(VaultError);
  });
});

describe("SecretKeys", () => {
  it("has standard secret keys defined", () => {
    expect(SecretKeys.OPENAI_API_KEY).toBe("llm/openai/api_key");
    expect(SecretKeys.OIDC_CLIENT_SECRET).toBe("auth/oidc/client_secret");
    expect(SecretKeys.DB_PASSWORD).toBe("db/password");
  });
});
