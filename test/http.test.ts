import { describe, expect, it, beforeEach, afterEach, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { LikuEngine, type InvokeAgentInput } from "../src/liku/engine.js";
import { toLikuError } from "../src/liku/errors.js";

// Note: These tests use fetch to test the HTTP server.
// They require Node 18+ for native fetch support.

// Schema defined at module level so TypeScript can infer types
const InvokeSchema = z.object({
  agentResidence: z.string(),
  task: z.unknown()
});

// Response type helpers for test assertions
type HealthResponse = { ok: boolean; memory: { status: string; reason?: string } };
type OkResponse = { kind: "ok"; bundle: { agentResidence: string } };
type ErrorResponse = { kind: "error"; code: string; message: string };
type BadRequestResponse = { code: string; message: string };

describe("HTTP Server", () => {
  let tmpDir: string;
  let engine: LikuEngine;
  let server: Awaited<ReturnType<typeof import("@hono/node-server")["serve"]>> | undefined;
  let port: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "liku-http-test-"));
    engine = new LikuEngine({ repoRoot: tmpDir });
    await engine.init();

    // Use a random port
    port = 10000 + Math.floor(Math.random() * 50000);

    // Start server
    const { Hono } = await import("hono");
    const { serve } = await import("@hono/node-server");

    const app = new Hono();

    app.onError((err, c) => {
      const likuErr = toLikuError(err);
      return c.json(likuErr.toJSON(), 500);
    });

    app.get("/health", (c) => {
      const memoryStatus = engine.memory.isDegraded
        ? { status: "degraded", reason: engine.memory.degradedReason }
        : { status: "ok" };
      return c.json({ ok: true, memory: memoryStatus });
    });

    app.post("/a2a/invoke", async (c) => {
      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        return c.json({ code: "BAD_REQUEST", message: "Invalid JSON body" }, 400);
      }

      let parsed: z.infer<typeof InvokeSchema>;
      try {
        parsed = InvokeSchema.parse(json);
      } catch (parseErr) {
        const likuErr = toLikuError(parseErr);
        return c.json(likuErr.toJSON(), 400);
      }

      // Cast to InvokeAgentInput since schema validation passed
      const input: InvokeAgentInput = {
        agentResidence: parsed.agentResidence,
        task: parsed.task
      };
      const result = await engine.invokeAgentSafe(input);

      if (result.kind === "error") {
        const status =
          result.code === "BAD_REQUEST" || result.code === "INVALID_RESIDENCE" || result.code === "PATH_TRAVERSAL"
            ? 400
            : 500;
        return c.json(result, status);
      }

      return c.json(result);
    });

    server = serve({ fetch: app.fetch, port });
  });

  afterEach(() => {
    if (server) {
      server.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("/health returns ok", async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.ok).toBe(true);

    const json = (await res.json()) as HealthResponse;
    expect(json.ok).toBe(true);
    expect(json.memory.status).toBe("ok");
  });

  it("/a2a/invoke returns bundle for valid request", async () => {
    const res = await fetch(`http://localhost:${port}/a2a/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentResidence: "Liku/specialist/ts",
        task: { action: "test" }
      })
    });

    expect(res.ok).toBe(true);
    const json = (await res.json()) as OkResponse;
    expect(json.kind).toBe("ok");
    expect(json.bundle.agentResidence).toBe("Liku/specialist/ts");
  });

  it("/a2a/invoke returns 400 for invalid JSON", async () => {
    const res = await fetch(`http://localhost:${port}/a2a/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json"
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as BadRequestResponse;
    expect(json.code).toBe("BAD_REQUEST");
  });

  it("/a2a/invoke returns 400 for missing required fields", async () => {
    const res = await fetch(`http://localhost:${port}/a2a/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})  // Missing both agentResidence and task
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as BadRequestResponse;
    expect(json.code).toBe("BAD_REQUEST");
  });

  it("/a2a/invoke returns 400 for path traversal", async () => {
    const res = await fetch(`http://localhost:${port}/a2a/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentResidence: "Liku/../../../etc/passwd",
        task: {}
      })
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as ErrorResponse;
    expect(json.kind).toBe("error");
    expect(json.code).toBe("PATH_TRAVERSAL");
  });

  it("/a2a/invoke returns 400 for absolute paths", async () => {
    const res = await fetch(`http://localhost:${port}/a2a/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentResidence: "/absolute/path",
        task: {}
      })
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as ErrorResponse;
    expect(json.kind).toBe("error");
    expect(json.code).toBe("PATH_TRAVERSAL");
  });

  it("/a2a/invoke returns 400 for residence outside Liku/", async () => {
    const res = await fetch(`http://localhost:${port}/a2a/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentResidence: "src/somewhere",
        task: {}
      })
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as ErrorResponse;
    expect(json.kind).toBe("error");
    expect(json.code).toBe("INVALID_RESIDENCE");
  });
});
