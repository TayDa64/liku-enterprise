import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("MCP Server Integration", () => {
  let tmpDir: string;
  let mcpPath: string;

  beforeAll(() => {
    // Ensure dist exists
    mcpPath = path.resolve(process.cwd(), "dist", "mcp.js");
    if (!fs.existsSync(mcpPath)) {
      throw new Error(`MCP server not built. Run 'npm run build' first. Expected: ${mcpPath}`);
    }
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "liku-mcp-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createClient(): Promise<{ client: Client; transport: StdioClientTransport }> {
    // Filter out undefined env values for type safety
    const env: Record<string, string> = { LIKU_REPO_ROOT: tmpDir };
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpPath],
      cwd: tmpDir,
      env
    });

    const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
    return { client, transport };
  }

  it("lists available tools", async () => {
    const { client, transport } = await createClient();

    try {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((t) => t.name);

      expect(toolNames).toContain("liku.init");
      expect(toolNames).toContain("liku.invoke");
      expect(toolNames).toContain("liku.search_memory");
    } finally {
      await transport.close();
    }
  });

  it("liku.init creates directory structure", async () => {
    const { client, transport } = await createClient();

    try {
      const result = await client.callTool({ name: "liku.init", arguments: {} });
      expect(result.content).toBeDefined();
      expect(fs.existsSync(path.join(tmpDir, "Liku"))).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it("liku.invoke returns agent bundle", async () => {
    const { client, transport } = await createClient();

    try {
      // First init
      await client.callTool({ name: "liku.init", arguments: {} });

      // Then invoke
      const result = await client.callTool({
        name: "liku.invoke",
        arguments: {
          agentResidence: "Liku/specialist/ts",
          task: { action: "test" }
        }
      });

      expect(result.content).toBeDefined();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content.length).toBeGreaterThan(0);

      const parsed = JSON.parse(content[0]!.text);
      expect(parsed.kind).toBe("ok");
      expect(parsed.bundle.agentResidence).toBe("Liku/specialist/ts");
    } finally {
      await transport.close();
    }
  });

  it("liku.invoke rejects path traversal", async () => {
    const { client, transport } = await createClient();

    try {
      await client.callTool({ name: "liku.init", arguments: {} });

      const result = await client.callTool({
        name: "liku.invoke",
        arguments: {
          agentResidence: "Liku/../../../etc/passwd",
          task: {}
        }
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]).toBeDefined();
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed.code).toBe("PATH_TRAVERSAL");
    } finally {
      await transport.close();
    }
  });

  it("liku.invoke rejects absolute paths", async () => {
    const { client, transport } = await createClient();

    try {
      await client.callTool({ name: "liku.init", arguments: {} });

      const result = await client.callTool({
        name: "liku.invoke",
        arguments: {
          agentResidence: "/absolute/path",
          task: {}
        }
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]).toBeDefined();
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed.code).toBe("PATH_TRAVERSAL");
    } finally {
      await transport.close();
    }
  });

  it("liku.search_memory works after init", async () => {
    const { client, transport } = await createClient();

    try {
      await client.callTool({ name: "liku.init", arguments: {} });

      // First invoke to create an event
      await client.callTool({
        name: "liku.invoke",
        arguments: {
          agentResidence: "Liku/specialist/ts",
          task: { action: "searchable-test-action" }
        }
      });

      // Then search
      const result = await client.callTool({
        name: "liku.search_memory",
        arguments: { query: "searchable-test-action", limit: 10 }
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    } finally {
      await transport.close();
    }
  });

  it("handles invalid Zod input gracefully", async () => {
    const { client, transport } = await createClient();

    try {
      const result = await client.callTool({
        name: "liku.invoke",
        arguments: {
          // Missing required 'agentResidence' field - this is clearly invalid
        }
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed.code).toBe("BAD_REQUEST");
    } finally {
      await transport.close();
    }
  });

  it("handles unknown tool gracefully", async () => {
    const { client, transport } = await createClient();

    try {
      const result = await client.callTool({
        name: "liku.nonexistent",
        arguments: {}
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("Unknown tool");
    } finally {
      await transport.close();
    }
  });

  it("survives repeated calls (10 iterations)", async () => {
    const { client, transport } = await createClient();

    try {
      await client.callTool({ name: "liku.init", arguments: {} });

      for (let i = 0; i < 10; i++) {
        const result = await client.callTool({
          name: "liku.invoke",
          arguments: {
            agentResidence: "Liku/specialist/ts",
            task: { iteration: i }
          }
        });
        expect(result.isError).toBeFalsy();
      }
    } finally {
      await transport.close();
    }
  });

  it("server stays alive after bad input", async () => {
    const { client, transport } = await createClient();

    try {
      // Send bad input
      await client.callTool({
        name: "liku.invoke",
        arguments: {
          agentResidence: "../../../etc/passwd",
          task: {}
        }
      });

      // Server should still respond
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);

      // And handle valid requests
      await client.callTool({ name: "liku.init", arguments: {} });
      const result = await client.callTool({
        name: "liku.invoke",
        arguments: {
          agentResidence: "Liku/specialist/ts",
          task: {}
        }
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await transport.close();
    }
  });
});
