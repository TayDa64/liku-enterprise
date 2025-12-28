#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseArgs(argv) {
  const args = new Map();
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const value = argv[i + 1];
    args.set(key.slice(2), value);
    i++;
  }
  return args;
}

const args = parseArgs(process.argv);
const repoRoot = path.resolve(args.get("repo") ?? process.cwd());
const serverCwd = path.resolve(args.get("serverCwd") ?? process.cwd());
const serverPath = path.resolve(args.get("server") ?? path.join(repoRoot, "dist", "mcp.js"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: serverCwd,
  env: { ...process.env, LIKU_REPO_ROOT: repoRoot }
});

const client = new Client({ name: "liku-repro", version: "0.0.0" }, { capabilities: {} });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  process.stdout.write(`Connected. Tools: ${tools.tools.map((t) => t.name).join(", ")}\n`);
  process.exit(0);
} catch (err) {
  process.stdout.write("=== MCP STREAM DISCONNECT REPRO ===\n");
  process.stdout.write(`Repo root: ${repoRoot}\n`);
  process.stdout.write(`Server path: ${serverPath}\n`);
  process.stdout.write(`Server cwd: ${serverCwd}\n`);
  process.stdout.write("\nError:\n");
  if (err instanceof Error) {
    process.stdout.write(`${err.name}: ${err.message}\n`);
    if (err.stack) process.stdout.write(`${err.stack}\n`);
  } else {
    process.stdout.write(`${String(err)}\n`);
  }
  process.exit(1);
}

