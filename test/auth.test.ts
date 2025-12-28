import { describe, it, expect, beforeEach } from "vitest";
import { 
  TenantRateLimiter, 
  TenantResolver, 
  InMemoryTenantStore,
  createDefaultTenant,
  AuthError,
  ROLE_PERMISSIONS
} from "../src/enterprise/auth/index.js";
import type { Tenant, Role } from "../src/enterprise/auth/types.js";

describe("TenantRateLimiter", () => {
  let limiter: TenantRateLimiter;
  let tenant: Tenant;

  beforeEach(() => {
    limiter = new TenantRateLimiter({
      defaultRpm: 10,
      defaultMaxConcurrent: 2,
      windowMs: 1000
    });
    tenant = {
      ...createDefaultTenant(),
      rateLimits: {
        requestsPerMinute: 5,
        maxConcurrentTasks: 2
      }
    };
  });

  it("allows requests under the limit", () => {
    const result = limiter.checkLimit(tenant);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4); // 5 - 1
  });

  it("blocks requests over the rate limit", () => {
    // Use up all requests
    for (let i = 0; i < 5; i++) {
      limiter.checkLimit(tenant);
    }

    const result = limiter.checkLimit(tenant);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("rate_limit");
    }
  });

  it("tracks concurrent tasks", () => {
    limiter.incrementConcurrent(tenant.id);
    limiter.incrementConcurrent(tenant.id);

    const state = limiter.getState(tenant.id);
    expect(state?.runningTasks).toBe(2);

    // Should block due to concurrent limit
    const result = limiter.checkLimit(tenant);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("concurrent_limit");
    }

    limiter.decrementConcurrent(tenant.id);
    const result2 = limiter.checkLimit(tenant);
    expect(result2.allowed).toBe(true);
  });

  it("uses default limits when tenant has none", () => {
    const tenantNoLimits = { ...createDefaultTenant(), rateLimits: undefined };
    
    // Should use default of 10 RPM
    for (let i = 0; i < 10; i++) {
      const result = limiter.checkLimit(tenantNoLimits);
      expect(result.allowed).toBe(true);
    }

    const result = limiter.checkLimit(tenantNoLimits);
    expect(result.allowed).toBe(false);
  });

  it("resets state correctly", () => {
    limiter.checkLimit(tenant);
    limiter.incrementConcurrent(tenant.id);
    
    limiter.reset(tenant.id);
    
    const state = limiter.getState(tenant.id);
    expect(state).toBeUndefined();
  });
});

describe("TenantResolver", () => {
  let store: InMemoryTenantStore;
  let resolver: TenantResolver;

  beforeEach(() => {
    store = new InMemoryTenantStore([createDefaultTenant()]);
    resolver = new TenantResolver(store, { cacheTtlMs: 100 });
  });

  it("resolves existing tenant", async () => {
    const tenant = await resolver.resolve("default");
    expect(tenant.id).toBe("default");
    expect(tenant.status).toBe("active");
  });

  it("throws for non-existent tenant", async () => {
    await expect(resolver.resolve("nonexistent")).rejects.toThrow(AuthError);
    await expect(resolver.resolve("nonexistent")).rejects.toMatchObject({
      code: "INVALID_TENANT"
    });
  });

  it("throws for suspended tenant", async () => {
    await store.update("default", { status: "suspended" });
    resolver.invalidate("default");

    await expect(resolver.resolve("default")).rejects.toThrow(AuthError);
    await expect(resolver.resolve("default")).rejects.toMatchObject({
      code: "TENANT_SUSPENDED"
    });
  });

  it("caches tenant lookups", async () => {
    const tenant1 = await resolver.resolve("default");
    
    // Update the store directly
    await store.update("default", { name: "Updated Name" });
    
    // Should return cached version
    const tenant2 = await resolver.resolve("default");
    expect(tenant2.name).toBe(tenant1.name);

    // Invalidate cache
    resolver.invalidate("default");
    
    // Should fetch fresh
    const tenant3 = await resolver.resolve("default");
    expect(tenant3.name).toBe("Updated Name");
  });
});

describe("InMemoryTenantStore", () => {
  let store: InMemoryTenantStore;

  beforeEach(() => {
    store = new InMemoryTenantStore();
  });

  it("creates and retrieves tenants", async () => {
    const tenant = await store.create({
      id: "test-tenant",
      name: "Test Tenant",
      status: "active"
    });

    expect(tenant.id).toBe("test-tenant");
    expect(tenant.createdAt).toBeDefined();

    const retrieved = await store.get("test-tenant");
    expect(retrieved?.name).toBe("Test Tenant");
  });

  it("lists all tenants", async () => {
    await store.create({ id: "t1", name: "Tenant 1", status: "active" });
    await store.create({ id: "t2", name: "Tenant 2", status: "active" });

    const tenants = await store.list();
    expect(tenants).toHaveLength(2);
  });

  it("updates tenants", async () => {
    await store.create({ id: "test", name: "Original", status: "active" });
    
    const updated = await store.update("test", { name: "Updated" });
    expect(updated.name).toBe("Updated");
    expect(updated.id).toBe("test"); // ID unchanged
  });

  it("deletes tenants", async () => {
    await store.create({ id: "test", name: "Test", status: "active" });
    
    const deleted = await store.delete("test");
    expect(deleted).toBe(true);

    const retrieved = await store.get("test");
    expect(retrieved).toBeNull();
  });
});

describe("ROLE_PERMISSIONS", () => {
  it("admin has all permissions", () => {
    const adminPerms = ROLE_PERMISSIONS.admin;
    expect(adminPerms).toContain("tasks:create");
    expect(adminPerms).toContain("admin:config");
    expect(adminPerms).toContain("tenants:manage");
    expect(adminPerms).toContain("audit:read");
  });

  it("developer has task permissions but not admin", () => {
    const devPerms = ROLE_PERMISSIONS.developer;
    expect(devPerms).toContain("tasks:create");
    expect(devPerms).toContain("agents:invoke");
    expect(devPerms).not.toContain("admin:config");
    expect(devPerms).not.toContain("tenants:manage");
  });

  it("viewer has read-only permissions", () => {
    const viewerPerms = ROLE_PERMISSIONS.viewer;
    expect(viewerPerms).toContain("tasks:read");
    expect(viewerPerms).toContain("tasks:list");
    expect(viewerPerms).not.toContain("tasks:create");
    expect(viewerPerms).not.toContain("agents:invoke");
  });

  it("auditor can read audit logs but not execute", () => {
    const auditorPerms = ROLE_PERMISSIONS.auditor;
    expect(auditorPerms).toContain("audit:read");
    expect(auditorPerms).toContain("audit:export");
    expect(auditorPerms).not.toContain("tasks:create");
    expect(auditorPerms).not.toContain("agents:invoke");
  });
});
