import type { Tenant } from "./types.js";
import { AuthError } from "./types.js";

/**
 * Tenant Resolution
 * 
 * Resolves and caches tenant information from tenant ID.
 * This is a scaffold - production implementation should use a database.
 */

export type TenantStore = {
  get(tenantId: string): Promise<Tenant | null>;
  list(): Promise<Tenant[]>;
  create(tenant: Omit<Tenant, "createdAt" | "updatedAt">): Promise<Tenant>;
  update(tenantId: string, updates: Partial<Tenant>): Promise<Tenant>;
  delete(tenantId: string): Promise<boolean>;
};

/**
 * Tenant Resolver with caching
 */
export class TenantResolver {
  private store: TenantStore;
  private cache: Map<string, { tenant: Tenant; fetchedAt: number }> = new Map();
  private cacheTtlMs: number;

  constructor(store: TenantStore, options?: { cacheTtlMs?: number }) {
    this.store = store;
    this.cacheTtlMs = options?.cacheTtlMs ?? 60_000; // 1 minute default
  }

  /**
   * Resolve tenant by ID
   * 
   * @throws AuthError if tenant not found or suspended
   */
  async resolve(tenantId: string): Promise<Tenant> {
    // Check cache
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return this.validateTenant(cached.tenant);
    }

    // Fetch from store
    const tenant = await this.store.get(tenantId);
    if (!tenant) {
      throw new AuthError(
        "INVALID_TENANT",
        `Tenant not found: ${tenantId}`,
        403
      );
    }

    // Cache and return
    this.cache.set(tenantId, { tenant, fetchedAt: Date.now() });
    return this.validateTenant(tenant);
  }

  /**
   * Validate tenant status
   */
  private validateTenant(tenant: Tenant): Tenant {
    if (tenant.status === "suspended") {
      throw new AuthError(
        "TENANT_SUSPENDED",
        `Tenant ${tenant.id} is suspended`,
        403,
        { tenantId: tenant.id, status: tenant.status }
      );
    }

    if (tenant.status === "pending") {
      throw new AuthError(
        "INVALID_TENANT",
        `Tenant ${tenant.id} is pending activation`,
        403,
        { tenantId: tenant.id, status: tenant.status }
      );
    }

    return tenant;
  }

  /**
   * Invalidate cache for a tenant
   */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /**
   * Clear entire cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * In-memory tenant store for development/testing
 */
export class InMemoryTenantStore implements TenantStore {
  private tenants: Map<string, Tenant> = new Map();

  constructor(initialTenants?: Tenant[]) {
    if (initialTenants) {
      for (const tenant of initialTenants) {
        this.tenants.set(tenant.id, tenant);
      }
    }
  }

  async get(tenantId: string): Promise<Tenant | null> {
    return this.tenants.get(tenantId) ?? null;
  }

  async list(): Promise<Tenant[]> {
    return Array.from(this.tenants.values());
  }

  async create(tenant: Omit<Tenant, "createdAt" | "updatedAt">): Promise<Tenant> {
    const now = new Date().toISOString();
    const fullTenant: Tenant = {
      ...tenant,
      createdAt: now,
      updatedAt: now
    };
    this.tenants.set(tenant.id, fullTenant);
    return fullTenant;
  }

  async update(tenantId: string, updates: Partial<Tenant>): Promise<Tenant> {
    const existing = this.tenants.get(tenantId);
    if (!existing) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }

    const updated: Tenant = {
      ...existing,
      ...updates,
      id: existing.id, // Prevent ID change
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString()
    };

    this.tenants.set(tenantId, updated);
    return updated;
  }

  async delete(tenantId: string): Promise<boolean> {
    return this.tenants.delete(tenantId);
  }
}

/**
 * Create a default tenant for development
 */
export function createDefaultTenant(): Tenant {
  const now = new Date().toISOString();
  return {
    id: "default",
    name: "Default Tenant",
    status: "active",
    rateLimits: {
      maxConcurrentTasks: 10,
      requestsPerMinute: 100
    },
    createdAt: now,
    updatedAt: now
  };
}
