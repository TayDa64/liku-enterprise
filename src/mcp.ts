#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LikuEngine } from "./liku/engine.js";
import { toLikuError, type LikuError } from "./liku/errors.js";
import { ConcurrencyLimiter, CapacityExceededError } from "./liku/utils/concurrencyLimiter.js";

// Global degraded mode flag
let degradedMode = false;
let degradedReason: string | undefined;

// Ingress limiter - protects invoke operations
const limiter = new ConcurrencyLimiter({
  maxConcurrent: parseInt(process.env.LIKU_MAX_CONCURRENT ?? "5", 10),
  queueTimeoutMs: parseInt(process.env.LIKU_QUEUE_TIMEOUT_MS ?? "30000", 10)
});

/**
 * Log to stderr only (never stdout) to avoid JSON-RPC framing pollution.
 */
function log(msg: string): void {
  process.stderr.write(`[liku-mcp] ${msg}\n`);
}

/**
 * Format a LikuError into MCP tool error response.
 */
function toErrorResponse(err: LikuError): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(err.toJSON(), null, 2) }]
  };
}

// Global process error handlers to prevent crashes
process.on("uncaughtException", (err) => {
  log(`Uncaught exception (server continues): ${err.message}`);
  if (err.stack) log(err.stack);
  degradedMode = true;
  degradedReason = `Uncaught exception: ${err.message}`;
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log(`Unhandled rejection (server continues): ${msg}`);
  if (reason instanceof Error && reason.stack) log(reason.stack);
  degradedMode = true;
  degradedReason = `Unhandled rejection: ${msg}`;
});

const InvokeSchema = z.object({
  agentResidence: z.string(),
  task: z.unknown()
});

const SearchSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().max(100).optional()
});

async function main(): Promise<void> {
  const repoRoot = process.env.LIKU_REPO_ROOT ? path.resolve(process.env.LIKU_REPO_ROOT) : process.cwd();
  log(`Starting MCP server with repo root: ${repoRoot}`);

  let engine: LikuEngine;
  try {
    engine = new LikuEngine({ repoRoot });
    await engine.init();
    log("Engine initialized successfully");

    // Check if memory is in degraded mode
    if (engine.memory.isDegraded) {
      log(`Memory in degraded mode: ${engine.memory.degradedReason}`);
    }
  } catch (err) {
    // Engine init failed - enter degraded mode but keep server alive
    const likuErr = toLikuError(err);
    log(`Engine init failed: ${likuErr.message}`);
    degradedMode = true;
    degradedReason = likuErr.message;

    // Create a minimal engine that will be mostly non-functional
    engine = new LikuEngine({ repoRoot });
  }

  const server = new Server(
    { name: "liku-engine", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "liku.init",
          description: "Initialize Liku filesystem tree under repo root",
          inputSchema: { type: "object", properties: {}, additionalProperties: false }
        },
        {
          name: "liku.invoke",
          description: "Create/resolve a path-grounded agent bundle (skills + paper trail + prompts) for a residence path",
          inputSchema: {
            type: "object",
            properties: {
              agentResidence: { type: "string" },
              task: {}
            },
            required: ["agentResidence", "task"],
            additionalProperties: false
          }
        },
        {
          name: "liku.search_memory",
          description: "Search SQLite event memory for prior patterns/solutions",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "number" }
            },
            required: ["query"],
            additionalProperties: false
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    // Check global degraded mode for all operations
    if (degradedMode && name !== "liku.init") {
      return toErrorResponse(
        toLikuError(new Error(`Server in degraded mode: ${degradedReason}. Try liku.init to recover.`))
      );
    }

    try {
      if (name === "liku.init") {
        await engine.init();
        // Reset degraded mode on successful re-init
        if (!engine.memory.isDegraded) {
          degradedMode = false;
          degradedReason = undefined;
        }
        return { content: [{ type: "text", text: "Initialized Liku tree." }] };
      }

      if (name === "liku.invoke") {
        // Parse with Zod - catch validation errors
        let input: z.infer<typeof InvokeSchema>;
        try {
          input = InvokeSchema.parse(args ?? {});
        } catch (parseErr) {
          return toErrorResponse(toLikuError(parseErr));
        }

        // Wrap in limiter - don't allow unbounded parallel invocations
        try {
          const result = await limiter.run(async () => {
            return engine.invokeAgentSafe({
              agentResidence: input.agentResidence,
              task: input.task ?? null
            });
          });

          if (result.kind === "error") {
            return {
              isError: true,
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
          }
          if (result.kind === "escalation") {
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          }
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (limiterErr) {
          if (limiterErr instanceof CapacityExceededError) {
            return {
              isError: true,
              content: [{
                type: "text",
                text: JSON.stringify({
                  kind: "error",
                  errorType: "capacity_exceeded",
                  message: limiterErr.message,
                  retryAfterMs: limiterErr.retryAfterMs
                }, null, 2)
              }]
            };
          }
          throw limiterErr;
        }
      }

      if (name === "liku.search_memory") {
        // Parse with Zod - catch validation errors
        let input: z.infer<typeof SearchSchema>;
        try {
          input = SearchSchema.parse(args ?? {});
        } catch (parseErr) {
          return toErrorResponse(toLikuError(parseErr));
        }

        try {
          const results = await engine.memory.search(input.query, input.limit ?? 20);
          return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
        } catch (searchErr) {
          return toErrorResponse(toLikuError(searchErr));
        }
      }

      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    } catch (err) {
      // Catch-all: any unhandled error in handlers becomes a clean error response
      log(`Handler error for ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return toErrorResponse(toLikuError(err));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Transport connected, server running");

  // Keep the process alive while transport is active
  // The server.connect() returns after setup but transport stays open
  // We wait forever or until the transport closes
  await new Promise<void>((resolve) => {
    // StdioServerTransport will close when stdin closes
    process.stdin.on("close", () => {
      log("stdin closed, shutting down");
      resolve();
    });
    process.stdin.on("end", () => {
      log("stdin ended, shutting down");
      resolve();
    });
  });
}

// Run main and handle any startup errors gracefully
main().catch((err) => {
  process.stderr.write(`[liku-mcp] Fatal startup error: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  // Exit with error code - MCP client will see the disconnect
  process.exit(1);
});

