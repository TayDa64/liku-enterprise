#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import chalk from "chalk";
import { LikuEngine } from "./liku/engine.js";
import { startHttpServer } from "./server/http.js";
import { startEnterpriseHttpServer } from "./server/enterpriseHttp.js";
import { Orchestrator } from "./liku/orchestrator/orchestrator.js";
import { createLlmClientFromEnv } from "./liku/llm/index.js";
import type { OrchestrationResult } from "./liku/orchestrator/types.js";
import type { OIDCConfig } from "./enterprise/auth/index.js";
import type { AuditConfig } from "./enterprise/audit/index.js";
import type { OPAConfig } from "./enterprise/policy/index.js";

/**
 * Exit codes for CLI commands.
 * Follows standard Unix conventions with extension for agent-specific states.
 */
const EXIT_CODES = {
  OK: 0,           // Success, all steps completed
  PARTIAL: 10,     // Partial completion, some steps failed
  ESCALATION: 20,  // Escalation required, cannot proceed without user
  ERROR: 30,       // Fatal error during execution
  CANCELLED: 40,   // Cancelled by user (SIGINT/SIGTERM)
} as const;

const program = new Command();

program.name("liku").description("Liku path-grounded multi-agent engine").version("0.1.0");

program
  .command("init")
  .description("Initialize the Liku directory tree in the current repo")
  .option("--repo <path>", "Repo root (defaults to cwd)")
  .action(async (opts) => {
    const repoRoot = path.resolve(opts.repo ?? process.cwd());
    const engine = new LikuEngine({ repoRoot });
    await engine.init();
    process.stdout.write(chalk.green(`Initialized Liku at ${path.join(repoRoot, "Liku")}\n`));
  });

program
  .command("serve")
  .description("Run the Liku HTTP server (A2A-style endpoints)")
  .option("--repo <path>", "Repo root (defaults to cwd)")
  .option("--port <port>", "Port", "8765")
  .option("--enterprise", "Enable enterprise features (auth, audit, policy)", false)
  .option("--oidc-issuer <url>", "OIDC issuer URL for token validation")
  .option("--oidc-audience <aud>", "Expected JWT audience")
  .option("--tenant-mode <mode>", "Tenant mode: single or multi", "single")
  .option("--audit-path <path>", "Audit log SQLite path (defaults to :memory:)")
  .option("--policy-mode <mode>", "Policy mode: embedded or remote", "embedded")
  .option("--policy-url <url>", "Remote OPA server URL")
  .action(async (opts) => {
    const repoRoot = path.resolve(opts.repo ?? process.cwd());
    const port = Number(opts.port);
    const engine = new LikuEngine({ repoRoot });
    await engine.init();

    if (opts.enterprise) {
      // Build enterprise configuration
      const oidcConfig: OIDCConfig | undefined = opts.oidcIssuer ? {
        issuerUrl: opts.oidcIssuer,
        audience: opts.oidcAudience ?? "liku-enterprise",
        jwksUri: `${opts.oidcIssuer}/.well-known/jwks.json`,
        algorithms: ["RS256"],
        clockToleranceSeconds: 30,
        cacheJwksSeconds: 300
      } : undefined;

      const auditConfig: AuditConfig = {
        storage: "sqlite",
        dbPath: opts.auditPath,
        hashAlgorithm: "sha256",
        retentionDays: 0,
        enableBatching: false,
        batchIntervalMs: 1000,
        maxBatchSize: 100
      };

      const policyConfig: OPAConfig = opts.policyMode === "remote" ? {
        mode: "remote",
        serverUrl: opts.policyUrl ?? "http://localhost:8181",
        defaultPackage: "liku.authz",
        cacheTtlSeconds: 60,
        timeoutMs: 1000,
        enableLogging: true
      } : {
        mode: "embedded",
        defaultPackage: "liku.authz",
        cacheTtlSeconds: 60,
        timeoutMs: 1000,
        enableLogging: true
      };

      await startEnterpriseHttpServer({
        engine,
        port,
        maxConcurrentTasks: 5,
        queueTimeoutMs: 30_000,
        enterprise: {
          enabled: true,
          oidc: oidcConfig,
          audit: auditConfig,
          policy: policyConfig
        }
      });
    } else {
      await startHttpServer({ engine, port });
    }
  });

program
  .command("task:new")
  .description("Create an isolated task directory under Liku/specialist/specific/")
  .option("--repo <path>", "Repo root (defaults to cwd)")
  .option("--name <name>", "Task folder name (defaults to task-<uuid>)")
  .action(async (opts) => {
    const repoRoot = path.resolve(opts.repo ?? process.cwd());
    const engine = new LikuEngine({ repoRoot });
    await engine.init();

    const taskName = typeof opts.name === "string" ? opts.name : undefined;
    const specificDir = path.join(repoRoot, "Liku", "specialist", "specific");
    const taskDir = path.join(specificDir, taskName ?? `task-${crypto.randomUUID()}`);
    engine.ensureTaskDir(taskDir);
    process.stdout.write(chalk.green(`Created task dir: ${path.relative(repoRoot, taskDir)}\n`));
  });

program
  .command("run")
  .description("Execute a query through the orchestrator pipeline")
  .argument("<query>", "The query/task to execute")
  .option("--repo <path>", "Repo root (defaults to cwd)")
  .option("--residence <path>", "Starting agent residence (defaults to Liku/root)")
  .option("--execute", "Execute with LLM (requires BYOK keys)", false)
  .option("--timeout <ms>", "Total timeout in ms", "300000")
  .option("--step-timeout <ms>", "Per-step timeout in ms", "60000")
  .option("--max-concurrency <n>", "Max parallel specialists", "5")
  .option("--json", "Output full JSON result", false)
  .action(async (query: string, opts) => {
    const repoRoot = path.resolve(opts.repo ?? process.cwd());
    const engine = new LikuEngine({ repoRoot });
    
    // Setup abort controller for graceful shutdown
    const abortController = new AbortController();
    let cancelled = false;
    
    const handleSignal = (signal: string) => {
      if (cancelled) {
        // Force exit on second signal
        process.stderr.write(chalk.red(`\nForced exit on second ${signal}\n`));
        process.exit(EXIT_CODES.CANCELLED);
      }
      cancelled = true;
      process.stderr.write(chalk.yellow(`\nReceived ${signal}, cancelling...\n`));
      abortController.abort();
    };
    
    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));

    try {
      await engine.init();
      
      // Create orchestrator with optional LLM client
      const llmClient = createLlmClientFromEnv();
      const orchestrator = new Orchestrator(engine, llmClient ?? undefined);
      
      // Build config
      const config = {
        maxConcurrency: Number(opts.maxConcurrency),
        stepTimeoutMs: Number(opts.stepTimeout),
        totalTimeoutMs: Number(opts.timeout),
        executeWithLlm: opts.execute && llmClient?.isConfigured(),
        abortOnError: true,
        abortSignal: abortController.signal
      };
      
      // Display start message
      process.stderr.write(chalk.blue(`Starting orchestration: "${query}"\n`));
      process.stderr.write(chalk.dim(`  Repo: ${repoRoot}\n`));
      process.stderr.write(chalk.dim(`  Residence: ${opts.residence ?? "Liku/root"}\n`));
      process.stderr.write(chalk.dim(`  Execute with LLM: ${config.executeWithLlm}\n`));
      process.stderr.write("\n");

      // Run orchestration
      const result = await orchestrator.run({
        query,
        startResidence: opts.residence,
        config
      });

      // Output result
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        outputResultHuman(result);
      }

      // Exit with appropriate code
      process.exit(resultToExitCode(result, cancelled));

    } catch (err) {
      process.stderr.write(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(EXIT_CODES.ERROR);
    }
  });

/**
 * Map orchestration result to exit code.
 */
function resultToExitCode(result: OrchestrationResult, cancelled: boolean): number {
  if (cancelled) {
    return EXIT_CODES.CANCELLED;
  }
  switch (result.kind) {
    case "ok":
      return EXIT_CODES.OK;
    case "partial":
      return EXIT_CODES.PARTIAL;
    case "escalation":
      return EXIT_CODES.ESCALATION;
    case "error":
      return EXIT_CODES.ERROR;
    default:
      return EXIT_CODES.ERROR;
  }
}

/**
 * Output orchestration result in human-readable format.
 */
function outputResultHuman(result: OrchestrationResult): void {
  const stepCount = result.steps.length;
  const successCount = result.steps.filter(s => s.status === "success").length;
  const errorCount = result.steps.filter(s => s.status === "error").length;
  const escalatedCount = result.steps.filter(s => s.status === "escalated").length;

  switch (result.kind) {
    case "ok":
      process.stderr.write(chalk.green("✓ Orchestration completed successfully\n"));
      process.stderr.write(chalk.dim(`  Steps: ${successCount}/${stepCount} succeeded\n`));
      process.stderr.write(chalk.dim(`  Summary: ${result.summary}\n`));
      break;

    case "partial":
      process.stderr.write(chalk.yellow("⚠ Orchestration partially completed\n"));
      process.stderr.write(chalk.dim(`  Steps: ${successCount}/${stepCount} succeeded, ${errorCount} errors\n`));
      process.stderr.write(chalk.dim(`  Pending: ${result.pendingSteps.join(", ")}\n`));
      process.stderr.write(chalk.dim(`  Summary: ${result.summary}\n`));
      break;

    case "escalation":
      process.stderr.write(chalk.magenta("⬆ Escalation required\n"));
      process.stderr.write(chalk.dim(`  Steps: ${successCount}/${stepCount} succeeded, ${escalatedCount} escalated\n`));
      process.stderr.write(chalk.dim(`  Missing: ${result.escalation.missingSkill}\n`));
      process.stderr.write(chalk.dim(`  Action: ${result.escalation.requestedAction}\n`));
      process.stderr.write(chalk.dim(`  Policy: ${result.escalation.policyRef}\n`));
      if (result.escalation.suggestedAlternatives.length > 0) {
        process.stderr.write(chalk.dim(`  Alternatives: ${result.escalation.suggestedAlternatives.join(", ")}\n`));
      }
      break;

    case "error":
      process.stderr.write(chalk.red(`✗ Orchestration failed: [${result.code}] ${result.message}\n`));
      process.stderr.write(chalk.dim(`  Steps: ${successCount}/${stepCount} succeeded before failure\n`));
      break;
  }
}

await program.parseAsync(process.argv);
