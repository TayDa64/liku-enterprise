import type { 
  PolicyEngine, 
  OPAConfig, 
  AuthzInput, 
  PolicyResult, 
  PolicyInfo,
  AuthzDecision
} from "./types.js";
import { PolicyError } from "./types.js";

/**
 * OPA Policy Engine Implementation
 * 
 * Provides policy evaluation for authorization decisions.
 */

// ============================================================================
// Decision Cache
// ============================================================================

type CacheEntry = {
  result: PolicyResult;
  fetchedAt: number;
};

function hashInput(input: AuthzInput): string {
  // Simple hash for cache key
  const str = JSON.stringify({
    action: input.action,
    resource: input.resource,
    subject: { id: input.subject.id, roles: input.subject.roles }
  });
  
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

// ============================================================================
// Embedded Policy Engine (Default Rules)
// ============================================================================

export class EmbeddedPolicyEngine implements PolicyEngine {
  private config: OPAConfig;
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;
  private loadedAt: string = new Date().toISOString();

  constructor(config: OPAConfig) {
    this.config = config;
    this.cacheTtlMs = config.cacheTtlSeconds * 1000;
  }

  async authorize(input: AuthzInput): Promise<PolicyResult> {
    const start = Date.now();

    // Check cache
    if (this.cacheTtlMs > 0) {
      const cacheKey = hashInput(input);
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
        return {
          ...cached.result,
          metadata: { ...cached.result.metadata, cached: true }
        };
      }
    }

    // Evaluate policy
    const decision = this.evaluatePolicy(input);
    
    const result: PolicyResult = {
      decision,
      metadata: {
        package: this.config.defaultPackage,
        evaluationMs: Date.now() - start,
        cached: false
      }
    };

    // Cache result
    if (this.cacheTtlMs > 0) {
      const cacheKey = hashInput(input);
      this.cache.set(cacheKey, { result, fetchedAt: Date.now() });
    }

    return result;
  }

  private evaluatePolicy(input: AuthzInput): AuthzDecision {
    const { action, resource, subject } = input;

    // Rule 1: Admin role has full access
    if (subject.roles.includes("admin")) {
      return {
        allow: true,
        reason: "Admin role has full access",
        rule: "admin_full_access"
      };
    }

    // Rule 2: Tenant isolation - subject must belong to resource tenant
    if (resource.tenantId && resource.tenantId !== subject.tenantId) {
      return {
        allow: false,
        reason: "Cross-tenant access denied",
        rule: "tenant_isolation"
      };
    }

    // Rule 3: Resource-type specific restrictions (checked BEFORE general permissions)
    if (resource.type === "agent") {
      const agentPath = resource.path ?? resource.id;
      
      // Root agents require admin access - this is a hard restriction
      if (agentPath.includes("Liku/root")) {
        return {
          allow: false,
          reason: "Root agent access requires admin role",
          rule: "agent_path_restriction"
        };
      }
    }

    // Rule 4: Action-based permissions
    const actionPermissions: Record<string, string[]> = {
      // Task actions
      "tasks:create": ["admin", "developer"],
      "tasks:read": ["admin", "developer", "viewer", "auditor"],
      "tasks:cancel": ["admin", "developer"],
      "tasks:list": ["admin", "developer", "viewer", "auditor"],
      
      // Agent actions
      "agents:invoke": ["admin", "developer"],
      "agents:read": ["admin", "developer", "viewer"],
      "agents:manage": ["admin"],
      
      // Tenant actions
      "tenants:read": ["admin"],
      "tenants:manage": ["admin"],
      "tenants:create": ["admin"],
      
      // Audit actions
      "audit:read": ["admin", "auditor"],
      "audit:export": ["admin", "auditor"]
    };

    const allowedRoles = actionPermissions[action];
    if (allowedRoles) {
      const hasRole = subject.roles.some(r => allowedRoles.includes(r));
      if (hasRole) {
        return {
          allow: true,
          reason: `Role authorized for action ${action}`,
          rule: "role_permission"
        };
      }
      return {
        allow: false,
        reason: `No authorized role for action ${action}`,
        rule: "role_permission",
        suggestion: `Required roles: ${allowedRoles.join(", ")}`
      };
    }

    // Default: deny unknown actions
    return {
      allow: false,
      reason: `Unknown action: ${action}`,
      rule: "default_deny"
    };
  }

  async evaluate<T = unknown>(query: string, input: unknown): Promise<T> {
    // For embedded mode, we only support the standard authorize query
    if (query === "data.liku.authz.allow") {
      const result = await this.authorize(input as AuthzInput);
      return result.decision.allow as T;
    }

    throw new PolicyError(
      "POLICY_NOT_FOUND",
      `Embedded engine only supports authorization queries. Query: ${query}`
    );
  }

  async loadPolicies(): Promise<void> {
    // Embedded policies are compiled in - nothing to load
    this.loadedAt = new Date().toISOString();
    this.clearCache();
  }

  async health(): Promise<{ healthy: boolean; mode: string; message?: string }> {
    return { healthy: true, mode: "embedded" };
  }

  async getPolicyInfo(): Promise<PolicyInfo> {
    return {
      packages: [this.config.defaultPackage],
      rules: [
        "admin_full_access",
        "tenant_isolation",
        "role_permission",
        "agent_path_restriction",
        "default_deny"
      ],
      loadedAt: this.loadedAt
    };
  }

  clearCache(): void {
    this.cache.clear();
  }
}

// ============================================================================
// Remote OPA Engine
// ============================================================================

export class RemoteOPAEngine implements PolicyEngine {
  private config: OPAConfig;
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;

  constructor(config: OPAConfig) {
    if (!config.endpoint) {
      throw new PolicyError("INVALID_INPUT", "Remote OPA endpoint required");
    }
    this.config = config;
    this.cacheTtlMs = config.cacheTtlSeconds * 1000;
  }

  async authorize(input: AuthzInput): Promise<PolicyResult> {
    const start = Date.now();

    // Check cache
    if (this.cacheTtlMs > 0) {
      const cacheKey = hashInput(input);
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
        return {
          ...cached.result,
          metadata: { ...cached.result.metadata, cached: true }
        };
      }
    }

    // Call remote OPA
    const query = `data.${this.config.defaultPackage}`;
    const response = await this.callOPA(query, { input });

    const decision: AuthzDecision = {
      allow: response.result?.allow ?? false,
      reason: response.result?.reason,
      rule: response.result?.rule,
      constraints: response.result?.constraints
    };

    const result: PolicyResult = {
      decision,
      metadata: {
        package: this.config.defaultPackage,
        evaluationMs: Date.now() - start,
        cached: false
      }
    };

    // Cache result
    if (this.cacheTtlMs > 0) {
      const cacheKey = hashInput(input);
      this.cache.set(cacheKey, { result, fetchedAt: Date.now() });
    }

    return result;
  }

  async evaluate<T = unknown>(query: string, input: unknown): Promise<T> {
    const response = await this.callOPA(query, { input });
    return response.result as T;
  }

  private async callOPA(query: string, body: unknown): Promise<{ result: Record<string, unknown> }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.endpoint}/v1/data/${query.replace(/^data\./, "").replace(/\./g, "/")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new PolicyError(
          "EVALUATION_FAILED",
          `OPA returned status ${response.status}`
        );
      }

      return await response.json() as { result: Record<string, unknown> };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new PolicyError("TIMEOUT", `Policy evaluation timed out after ${this.config.timeoutMs}ms`);
      }
      if (err instanceof PolicyError) throw err;
      throw new PolicyError("CONNECTION_FAILED", `Failed to connect to OPA: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async loadPolicies(): Promise<void> {
    // Remote OPA manages its own policies
    // Could trigger a bundle refresh here if needed
    this.clearCache();
  }

  async health(): Promise<{ healthy: boolean; mode: string; message?: string }> {
    try {
      const response = await fetch(`${this.config.endpoint}/health`);
      return {
        healthy: response.ok,
        mode: "remote",
        message: response.ok ? undefined : `OPA returned status ${response.status}`
      };
    } catch (err) {
      return {
        healthy: false,
        mode: "remote",
        message: (err as Error).message
      };
    }
  }

  async getPolicyInfo(): Promise<PolicyInfo> {
    try {
      const response = await fetch(`${this.config.endpoint}/v1/policies`);
      const data = await response.json() as { result: Array<{ id: string; raw: string }> };
      
      return {
        packages: data.result?.map(p => p.id) ?? [],
        rules: [], // Would need to parse policy to extract rules
        loadedAt: new Date().toISOString()
      };
    } catch {
      return {
        packages: [],
        rules: [],
        loadedAt: new Date().toISOString()
      };
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createPolicyEngine(config: OPAConfig): PolicyEngine {
  if (config.mode === "remote") {
    return new RemoteOPAEngine(config);
  }
  return new EmbeddedPolicyEngine(config);
}
