import { describe, it, expect, beforeEach } from "vitest";
import {
  EmbeddedPolicyEngine,
  createPolicyEngine,
  PolicyError
} from "../src/enterprise/policy/index.js";
import type { OPAConfig, AuthzInput } from "../src/enterprise/policy/types.js";

describe("EmbeddedPolicyEngine", () => {
  let engine: EmbeddedPolicyEngine;
  const config: OPAConfig = {
    mode: "embedded",
    defaultPackage: "liku.authz",
    cacheTtlSeconds: 60,
    timeoutMs: 1000,
    enableLogging: false
  };

  beforeEach(() => {
    engine = new EmbeddedPolicyEngine(config);
  });

  describe("admin access", () => {
    it("allows admin full access", async () => {
      const input: AuthzInput = {
        action: "tenants:manage",
        resource: { type: "tenant", id: "t1" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["admin"] }
      };

      const result = await engine.authorize(input);
      expect(result.decision.allow).toBe(true);
      expect(result.decision.rule).toBe("admin_full_access");
    });
  });

  describe("tenant isolation", () => {
    it("denies cross-tenant access", async () => {
      const input: AuthzInput = {
        action: "tasks:read",
        resource: { type: "task", id: "task1", tenantId: "tenant-a" },
        subject: { id: "user1", type: "user", tenantId: "tenant-b", roles: ["developer"] }
      };

      const result = await engine.authorize(input);
      expect(result.decision.allow).toBe(false);
      expect(result.decision.rule).toBe("tenant_isolation");
    });

    it("allows same-tenant access", async () => {
      const input: AuthzInput = {
        action: "tasks:read",
        resource: { type: "task", id: "task1", tenantId: "tenant-a" },
        subject: { id: "user1", type: "user", tenantId: "tenant-a", roles: ["developer"] }
      };

      const result = await engine.authorize(input);
      expect(result.decision.allow).toBe(true);
    });
  });

  describe("role-based permissions", () => {
    it("allows developer to create tasks", async () => {
      const input: AuthzInput = {
        action: "tasks:create",
        resource: { type: "task", id: "new" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["developer"] }
      };

      const result = await engine.authorize(input);
      expect(result.decision.allow).toBe(true);
    });

    it("denies viewer from creating tasks", async () => {
      const input: AuthzInput = {
        action: "tasks:create",
        resource: { type: "task", id: "new" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["viewer"] }
      };

      const result = await engine.authorize(input);
      expect(result.decision.allow).toBe(false);
      expect(result.decision.suggestion).toContain("developer");
    });

    it("allows viewer to read tasks", async () => {
      const input: AuthzInput = {
        action: "tasks:read",
        resource: { type: "task", id: "task1" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["viewer"] }
      };

      const result = await engine.authorize(input);
      expect(result.decision.allow).toBe(true);
    });

    it("allows auditor to read audit logs", async () => {
      const input: AuthzInput = {
        action: "audit:read",
        resource: { type: "audit", id: "logs" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["auditor"] }
      };

      const result = await engine.authorize(input);
      expect(result.decision.allow).toBe(true);
    });

    it("denies auditor from creating tasks", async () => {
      const input: AuthzInput = {
        action: "tasks:create",
        resource: { type: "task", id: "new" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["auditor"] }
      };

      const result = await engine.authorize(input);
      expect(result.decision.allow).toBe(false);
    });
  });

  describe("agent path restrictions", () => {
    it("denies non-admin access to root agents", async () => {
      const input: AuthzInput = {
        action: "agents:invoke",
        resource: { type: "agent", id: "root-agent", path: "Liku/root/supervisor" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["developer"] }
      };

      const result = await engine.authorize(input);
      expect(result.decision.allow).toBe(false);
      expect(result.decision.rule).toBe("agent_path_restriction");
    });

    it("allows admin access to root agents", async () => {
      const input: AuthzInput = {
        action: "agents:invoke",
        resource: { type: "agent", id: "root-agent", path: "Liku/root/supervisor" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["admin"] }
      };

      const result = await engine.authorize(input);
      expect(result.decision.allow).toBe(true);
    });

    it("allows developer access to specialist agents", async () => {
      const input: AuthzInput = {
        action: "agents:invoke",
        resource: { type: "agent", id: "ts-agent", path: "Liku/specialist/ts" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["developer"] }
      };

      const result = await engine.authorize(input);
      expect(result.decision.allow).toBe(true);
    });
  });

  describe("default deny", () => {
    it("denies unknown actions", async () => {
      const input: AuthzInput = {
        action: "unknown:action",
        resource: { type: "unknown", id: "x" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["developer"] }
      };

      const result = await engine.authorize(input);
      expect(result.decision.allow).toBe(false);
      expect(result.decision.rule).toBe("default_deny");
    });
  });

  describe("caching", () => {
    it("caches decisions", async () => {
      const input: AuthzInput = {
        action: "tasks:read",
        resource: { type: "task", id: "task1" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["developer"] }
      };

      const result1 = await engine.authorize(input);
      expect(result1.metadata.cached).toBe(false);

      const result2 = await engine.authorize(input);
      expect(result2.metadata.cached).toBe(true);
    });

    it("clears cache", async () => {
      const input: AuthzInput = {
        action: "tasks:read",
        resource: { type: "task", id: "task1" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["developer"] }
      };

      await engine.authorize(input);
      engine.clearCache();

      const result = await engine.authorize(input);
      expect(result.metadata.cached).toBe(false);
    });
  });

  describe("metadata", () => {
    it("returns evaluation time", async () => {
      const input: AuthzInput = {
        action: "tasks:read",
        resource: { type: "task", id: "task1" },
        subject: { id: "user1", type: "user", tenantId: "t1", roles: ["developer"] }
      };

      const result = await engine.authorize(input);
      expect(result.metadata.evaluationMs).toBeGreaterThanOrEqual(0);
      expect(result.metadata.package).toBe("liku.authz");
    });
  });

  describe("health and info", () => {
    it("reports healthy", async () => {
      const health = await engine.health();
      expect(health.healthy).toBe(true);
      expect(health.mode).toBe("embedded");
    });

    it("returns policy info", async () => {
      const info = await engine.getPolicyInfo();
      expect(info.packages).toContain("liku.authz");
      expect(info.rules).toContain("admin_full_access");
      expect(info.rules).toContain("tenant_isolation");
    });
  });
});

describe("createPolicyEngine", () => {
  it("creates embedded engine by default", () => {
    const engine = createPolicyEngine({
      mode: "embedded",
      defaultPackage: "liku.authz",
      cacheTtlSeconds: 60,
      timeoutMs: 1000,
      enableLogging: false
    });
    expect(engine).toBeInstanceOf(EmbeddedPolicyEngine);
  });

  it("throws for remote mode without endpoint", () => {
    expect(() => createPolicyEngine({
      mode: "remote",
      defaultPackage: "liku.authz",
      cacheTtlSeconds: 60,
      timeoutMs: 1000,
      enableLogging: false
    })).toThrow(PolicyError);
  });
});
