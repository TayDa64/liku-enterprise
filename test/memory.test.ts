import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteMemory } from "../src/liku/memory/sqliteMemory.js";

describe("SqliteMemory", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "liku-memory-test-"));
    dbPath = path.join(tmpDir, "test.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes successfully with valid path", async () => {
    const memory = new SqliteMemory(dbPath);
    const result = await memory.init();

    expect(result).toBe(true);
    expect(memory.isDegraded).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("logs and searches events", async () => {
    const memory = new SqliteMemory(dbPath);
    await memory.init();

    await memory.logEvent({
      id: "test-1",
      time: new Date().toISOString(),
      agentPath: "Liku/specialist/ts",
      type: "invoke",
      payload: { searchableContent: "hello world" }
    });

    const results = await memory.search("hello", 10);
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe("test-1");
    expect(results[0]!.snippet).toContain("hello");
  });

  it("search throws MEMORY_DEGRADED when degraded", async () => {
    const memory = new SqliteMemory(dbPath);
    // Don't call init - memory should be uninitialized

    // Manually set degraded mode
    (memory as unknown as { _degraded: boolean })._degraded = true;
    (memory as unknown as { _degradedReason: string })._degradedReason = "Test degraded mode";

    await expect(memory.search("test")).rejects.toThrow("Memory search unavailable");
  });

  it("logEvent silently skips in degraded mode", async () => {
    const memory = new SqliteMemory(dbPath);

    // Manually set degraded mode
    (memory as unknown as { _degraded: boolean })._degraded = true;
    (memory as unknown as { _degradedReason: string })._degradedReason = "Test degraded mode";

    // Should not throw
    await expect(
      memory.logEvent({
        id: "test-1",
        time: new Date().toISOString(),
        agentPath: "test",
        type: "test",
        payload: {}
      })
    ).resolves.toBeUndefined();
  });

  it("multiple events can be logged and searched", async () => {
    const memory = new SqliteMemory(dbPath);
    await memory.init();

    for (let i = 0; i < 5; i++) {
      await memory.logEvent({
        id: `event-${i}`,
        time: new Date().toISOString(),
        agentPath: `Liku/agent-${i}`,
        type: "invoke",
        payload: { index: i, pattern: "common-pattern" }
      });
    }

    const results = await memory.search("common-pattern", 10);
    expect(results.length).toBe(5);
  });

  it("search respects limit parameter", async () => {
    const memory = new SqliteMemory(dbPath);
    await memory.init();

    for (let i = 0; i < 10; i++) {
      await memory.logEvent({
        id: `event-${i}`,
        time: new Date().toISOString(),
        agentPath: "test",
        type: "test",
        payload: { keyword: "findme" }
      });
    }

    const results = await memory.search("findme", 3);
    expect(results.length).toBe(3);
  });

  it("flush persists data to disk", async () => {
    const memory = new SqliteMemory(dbPath);
    await memory.init();

    await memory.logEvent({
      id: "persist-test",
      time: new Date().toISOString(),
      agentPath: "test",
      type: "test",
      payload: { data: "persistent" }
    });

    // Create new memory instance pointing to same file
    const memory2 = new SqliteMemory(dbPath);
    await memory2.init();

    const results = await memory2.search("persistent", 10);
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe("persist-test");
  });
});
