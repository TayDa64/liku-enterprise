import { describe, it, expect, beforeEach } from "vitest";
import { SqliteAuditStore, createAuditEntryBuilder } from "../src/enterprise/audit/store.js";
import type { AuditConfig, AuditEntry } from "../src/enterprise/audit/types.js";

describe("SqliteAuditStore", () => {
  let store: SqliteAuditStore;
  const config: AuditConfig = {
    storage: "sqlite",
    hashAlgorithm: "sha256",
    retentionDays: 0,
    enableBatching: false,
    batchIntervalMs: 1000,
    maxBatchSize: 100
  };

  beforeEach(async () => {
    store = new SqliteAuditStore(config);
    await store.init();
  });

  describe("append", () => {
    it("creates entry with proper hash chain", async () => {
      const entry = await store.append({
        timestamp: new Date().toISOString(),
        actor: { userId: "user-1", email: "user@example.com" },
        tenantId: "tenant-1",
        action: "task.create",
        outcome: "success",
        resource: { type: "task", id: "task-123" }
      });

      expect(entry.id).toBeDefined();
      expect(entry.sequence).toBe(0);
      expect(entry.contentHash).toBeDefined();
      expect(entry.previousHash).toBeDefined();
    });

    it("chains entries correctly", async () => {
      const entry1 = await store.append({
        timestamp: new Date().toISOString(),
        actor: { userId: "user-1" },
        tenantId: "tenant-1",
        action: "task.create",
        outcome: "success",
        resource: { type: "task", id: "task-1" }
      });

      const entry2 = await store.append({
        timestamp: new Date().toISOString(),
        actor: { userId: "user-1" },
        tenantId: "tenant-1",
        action: "task.complete",
        outcome: "success",
        resource: { type: "task", id: "task-1" }
      });

      expect(entry2.sequence).toBe(1);
      expect(entry2.previousHash).toBe(entry1.contentHash);
    });
  });

  describe("query", () => {
    beforeEach(async () => {
      // Add test entries
      await store.append({
        timestamp: "2025-01-01T10:00:00Z",
        actor: { userId: "user-1" },
        tenantId: "tenant-1",
        action: "task.create",
        outcome: "success",
        resource: { type: "task", id: "task-1" }
      });

      await store.append({
        timestamp: "2025-01-01T11:00:00Z",
        actor: { userId: "user-2" },
        tenantId: "tenant-1",
        action: "task.complete",
        outcome: "success",
        resource: { type: "task", id: "task-1" }
      });

      await store.append({
        timestamp: "2025-01-01T12:00:00Z",
        actor: { userId: "user-1" },
        tenantId: "tenant-2",
        action: "agent.invoke",
        outcome: "failure",
        resource: { type: "agent", id: "agent-path" }
      });
    });

    it("filters by tenantId", async () => {
      const results = await store.query({ tenantId: "tenant-1", limit: 100 });
      expect(results).toHaveLength(2);
      expect(results.every(e => e.tenantId === "tenant-1")).toBe(true);
    });

    it("filters by actorId", async () => {
      const results = await store.query({ actorId: "user-1", limit: 100 });
      expect(results).toHaveLength(2);
      expect(results.every(e => e.actor.userId === "user-1")).toBe(true);
    });

    it("filters by actions", async () => {
      const results = await store.query({ 
        actions: ["task.create", "task.complete"],
        limit: 100 
      });
      expect(results).toHaveLength(2);
    });

    it("filters by outcome", async () => {
      const results = await store.query({ outcomes: ["failure"], limit: 100 });
      expect(results).toHaveLength(1);
      expect(results[0].outcome).toBe("failure");
    });

    it("filters by time range", async () => {
      const results = await store.query({
        startTime: "2025-01-01T10:30:00Z",
        endTime: "2025-01-01T11:30:00Z",
        limit: 100
      });
      expect(results).toHaveLength(1);
      expect(results[0].timestamp).toBe("2025-01-01T11:00:00Z");
    });

    it("supports pagination via afterSequence", async () => {
      const results = await store.query({ afterSequence: 0, limit: 100 });
      expect(results).toHaveLength(2);
      expect(results.every(e => e.sequence > 0)).toBe(true);
    });

    it("respects limit", async () => {
      const results = await store.query({ limit: 1 });
      expect(results).toHaveLength(1);
    });

    it("sorts by order", async () => {
      const asc = await store.query({ order: "asc", limit: 100 });
      expect(asc[0].sequence).toBe(0);

      const desc = await store.query({ order: "desc", limit: 100 });
      expect(desc[0].sequence).toBe(2);
    });
  });

  describe("verifyChain", () => {
    it("verifies valid chain", async () => {
      await store.append({
        timestamp: new Date().toISOString(),
        actor: { userId: "user-1" },
        tenantId: "tenant-1",
        action: "task.create",
        outcome: "success",
        resource: { type: "task", id: "task-1" }
      });

      await store.append({
        timestamp: new Date().toISOString(),
        actor: { userId: "user-1" },
        tenantId: "tenant-1",
        action: "task.complete",
        outcome: "success",
        resource: { type: "task", id: "task-1" }
      });

      const result = await store.verifyChain(0, 1);
      expect(result.valid).toBe(true);
      expect(result.entriesChecked).toBe(2);
    });
  });

  describe("export", () => {
    beforeEach(async () => {
      await store.append({
        timestamp: "2025-01-01T10:00:00Z",
        actor: { userId: "user-1", email: "user@example.com" },
        tenantId: "tenant-1",
        action: "task.create",
        outcome: "success",
        resource: { type: "task", id: "task-1" }
      });
    });

    it("exports as JSON", async () => {
      const json = await store.export({ limit: 100 }, "json");
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].action).toBe("task.create");
    });

    it("exports as CSV", async () => {
      const csv = await store.export({ limit: 100 }, "csv");
      expect(csv).toContain("id,sequence,timestamp");
      expect(csv).toContain("task.create");
    });
  });

  describe("getById and getBySequence", () => {
    it("retrieves by ID", async () => {
      const entry = await store.append({
        timestamp: new Date().toISOString(),
        actor: { userId: "user-1" },
        tenantId: "tenant-1",
        action: "task.create",
        outcome: "success",
        resource: { type: "task", id: "task-1" }
      });

      const retrieved = await store.getById(entry.id);
      expect(retrieved?.id).toBe(entry.id);
    });

    it("retrieves by sequence", async () => {
      await store.append({
        timestamp: new Date().toISOString(),
        actor: { userId: "user-1" },
        tenantId: "tenant-1",
        action: "task.create",
        outcome: "success",
        resource: { type: "task", id: "task-1" }
      });

      const retrieved = await store.getBySequence(0);
      expect(retrieved?.sequence).toBe(0);
    });

    it("returns null for non-existent entries", async () => {
      expect(await store.getById("nonexistent")).toBeNull();
      expect(await store.getBySequence(999)).toBeNull();
    });
  });

  describe("getLatest", () => {
    it("returns null for empty store", async () => {
      expect(await store.getLatest()).toBeNull();
    });

    it("returns latest entry", async () => {
      await store.append({
        timestamp: new Date().toISOString(),
        actor: { userId: "user-1" },
        tenantId: "tenant-1",
        action: "task.create",
        outcome: "success",
        resource: { type: "task", id: "task-1" }
      });

      await store.append({
        timestamp: new Date().toISOString(),
        actor: { userId: "user-1" },
        tenantId: "tenant-1",
        action: "task.complete",
        outcome: "success",
        resource: { type: "task", id: "task-1" }
      });

      const latest = await store.getLatest();
      expect(latest?.sequence).toBe(1);
      expect(latest?.action).toBe("task.complete");
    });
  });
});

describe("createAuditEntryBuilder", () => {
  const actor = { userId: "user-1", email: "user@example.com" };
  const builder = createAuditEntryBuilder("tenant-1", actor);

  it("builds task entries", () => {
    const entry = builder.task("task.create", "task-123", "success", { key: "value" });
    
    expect(entry.action).toBe("task.create");
    expect(entry.resource.type).toBe("task");
    expect(entry.resource.id).toBe("task-123");
    expect(entry.outcome).toBe("success");
    expect(entry.tenantId).toBe("tenant-1");
    expect(entry.actor.userId).toBe("user-1");
    expect(entry.details).toEqual({ key: "value" });
  });

  it("builds agent entries", () => {
    const entry = builder.agent("agent.invoke", "Liku/specialist/ts", "success");
    
    expect(entry.action).toBe("agent.invoke");
    expect(entry.resource.type).toBe("agent");
    expect(entry.resource.path).toBe("Liku/specialist/ts");
  });

  it("builds auth entries", () => {
    const entry = builder.auth("auth.login", "success");
    
    expect(entry.action).toBe("auth.login");
    expect(entry.resource.type).toBe("session");
  });

  it("builds security entries", () => {
    const entry = builder.security("security.permission_denied", "endpoint", "/admin", "denied");
    
    expect(entry.action).toBe("security.permission_denied");
    expect(entry.outcome).toBe("denied");
  });
});
