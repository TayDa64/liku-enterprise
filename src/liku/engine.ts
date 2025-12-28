import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { ensureDir, isSubpath, normalizeAgentResidence, resolveLikuPaths, validateRepoRoot } from "./paths.js";
import { loadInheritedSkills } from "./skills/loader.js";
import type { SkillsIndex } from "./skills/types.js";
import { appendError, appendTodo } from "./audit/paperTrail.js";
import { SqliteMemory } from "./memory/sqliteMemory.js";
import type { TaskEvent } from "./memory/types.js";
import { LikuError, type InvokeResult, okResult, errorResult, toLikuError } from "./errors.js";

export type EngineInitOptions = {
  repoRoot: string;
};

export type InvokeAgentInput = {
  agentResidence: string;
  task: unknown;
};

export type AgentBundle = {
  agentResidence: string;
  skills: SkillsIndex["skills"];
  paperTrail: {
    todoPath: string;
    errorsPath: string;
  };
  prompts: {
    system: string;
    instructions: string;
  };
};

function isoNow(): string {
  return new Date().toISOString();
}

function id(): string {
  return crypto.randomUUID();
}

export class LikuEngine {
  readonly repoRoot: string;
  readonly paths = resolveLikuPaths(".");
  readonly memory: SqliteMemory;

  constructor(options: EngineInitOptions) {
    this.repoRoot = path.resolve(options.repoRoot);
    this.paths = resolveLikuPaths(this.repoRoot);
    this.memory = new SqliteMemory(path.join(this.paths.memoryDir, "liku_memory.db"));
  }

  async init(): Promise<void> {
    // Validate repo root exists and is a directory (allow it to be created if it's empty)
    const resolvedRoot = path.resolve(this.repoRoot);
    if (fs.existsSync(resolvedRoot)) {
      validateRepoRoot(resolvedRoot);
    }

    ensureDir(this.paths.likuRoot);
    ensureDir(this.paths.rootSupervisorDir);
    ensureDir(this.paths.specialistsDir);
    ensureDir(this.paths.memoryDir);
    ensureDir(path.join(this.paths.specialistsDir, "specific"));

    const policyPath = path.join(this.paths.rootSupervisorDir, "policy.md");
    if (!fs.existsSync(policyPath)) {
      fs.writeFileSync(
        policyPath,
        `# Liku Policy (Root)\n\n- The filesystem under \`Liku/\` is the canonical source of truth.\n- Sub-agents may only narrow policies; they may not override root policy.\n- Escalations are returned as structured events; interactive prompting is optional per client.\n`,
        "utf8"
      );
    }

    const escalationsPath = path.join(this.paths.rootSupervisorDir, "LikuEscalations.md");
    if (!fs.existsSync(escalationsPath)) {
      fs.writeFileSync(
        escalationsPath,
        `# Liku Escalations (Root)\n\nRecord privilege boundary crossings and required approvals here.\n`,
        "utf8"
      );
    }

    const routingPath = path.join(this.paths.rootSupervisorDir, "routing.md");
    if (!fs.existsSync(routingPath)) {
      fs.writeFileSync(
        routingPath,
        `# Liku Routing (Supervisor)\n\nThis file is the Supervisor's grounded routing rubric.\n\n## Patterns\n\n- Sequential pipeline: \`parser -> planner -> specialist -> verify -> synthesizer\`\n- Parallel fan-out: run up to 5 verifiers concurrently; each writes to its own task dir.\n- Hierarchical: specialists may request sub-agents in child directories.\n\n## Default routing\n\n- Parse/normalize request: \`Liku/specialist/parser\`\n- Decompose and plan: \`Liku/specialist/planner\`\n- TypeScript work: \`Liku/specialist/ts\`\n- Python work: \`Liku/specialist/python\`\n- Security audit: \`Liku/specialist/verify/security\`\n- Style audit: \`Liku/specialist/verify/style\`\n- Synthesis/merge reports: \`Liku/specialist/synthesizer\`\n`,
        "utf8"
      );
    }

    const supervisorPromptPath = path.join(this.paths.rootSupervisorDir, "supervisor.prompt.md");
    if (!fs.existsSync(supervisorPromptPath)) {
      fs.writeFileSync(
        supervisorPromptPath,
        `# Liku Supervisor System Prompt\n\nYou are the Liku Supervisor agent residing at \`Liku/root\`.\n\n## Grounding rules\n- Treat the directory path of an agent as its identity and permission boundary.\n- Determine skills by loading \`skills.xml\` from the agent directory and inheriting from parents up to \`Liku/\`.\n- Mirror every meaningful state change to \`todo.md\` in the task directory.\n- Record failures and resolutions to \`LikuErrors.md\`.\n\n## Orchestration patterns\n- Sequential pipeline: parse -> plan -> execute -> verify.\n- Parallel fan-out: up to 5 concurrent specialists, each in an isolated task directory.\n- Hierarchical: a specialist may request sub-agents in subdirectories.\n\n## Escalation\nWhen an action requires a skill with \`requiredPrivilege=root\` that is not available at the current residence:\n- Emit an EscalationRequired event describing: missing skill, requested action, and recommended safe alternative.\n- Do not assume human consent; do not prompt unless the client explicitly supports it.\n`,
        "utf8"
      );
    }

    const rootSkillsPath = path.join(this.paths.likuRoot, "skills.xml");
    if (!fs.existsSync(rootSkillsPath)) {
      fs.writeFileSync(
        rootSkillsPath,
        `<skills>\n  <skill id=\"log_error\" privilege=\"user\" description=\"Append an error record to LikuErrors.md\" />\n  <skill id=\"read_todo\" privilege=\"user\" description=\"Read and interpret todo.md\" />\n  <skill id=\"escalate\" privilege=\"root\" description=\"Request root-only actions per policy\" />\n</skills>\n`,
        "utf8"
      );
    }

    const specialistSkillsPath = path.join(this.paths.specialistsDir, "skills.xml");
    if (!fs.existsSync(specialistSkillsPath)) {
      fs.writeFileSync(
        specialistSkillsPath,
        `<skills>\n  <skill id=\"write_todo\" privilege=\"specialist\" description=\"Append a progress line to todo.md\" />\n  <skill id=\"write_error\" privilege=\"specialist\" description=\"Append a failure record to LikuErrors.md\" />\n  <skill id=\"request_subagent\" privilege=\"specialist\" description=\"Ask Supervisor to invoke a sub-agent at a child path\" />\n</skills>\n`,
        "utf8"
      );
    }

    const specialistSeeds: Array<{ rel: string; skillsXml: string; context: string }> = [
      {
        rel: "parser",
        skillsXml:
          `<skills>\n  <skill id=\"parse_request\" privilege=\"specialist\" description=\"Normalize user request into a structured task JSON\" />\n  <skill id=\"extract_constraints\" privilege=\"specialist\" description=\"Extract constraints, risks, and required inputs\" />\n</skills>\n`,
        context:
          `# Parser Specialist Context\n\n- Output must be a deterministic JSON structure.\n- Do not invent repo facts; only cite files that exist.\n`
      },
      {
        rel: "planner",
        skillsXml:
          `<skills>\n  <skill id=\"decompose\" privilege=\"specialist\" description=\"Decompose a goal into a sequential pipeline and parallel checks\" />\n  <skill id=\"assign_residences\" privilege=\"specialist\" description=\"Choose Liku residence paths for each step\" />\n</skills>\n`,
        context:
          `# Planner Specialist Context\n\n- Produce small, verifiable steps.\n- Prefer sequential pipeline unless tasks are independent.\n`
      },
      {
        rel: "ts",
        skillsXml:
          `<skills>\n  <skill id=\"refactor_ts\" privilege=\"specialist\" description=\"Perform a TypeScript refactor grounded to repo files\" />\n  <skill id=\"check_types\" privilege=\"specialist\" description=\"Run TypeScript typechecking and interpret results\" />\n</skills>\n`,
        context: `# TypeScript Specialist Context\n\n- Use \`skills.xml\` + repository files as the source of truth.\n- Prefer minimal diffs and safe refactors.\n`
      },
      {
        rel: "python",
        skillsXml:
          `<skills>\n  <skill id=\"refactor_py\" privilege=\"specialist\" description=\"Perform a Python refactor grounded to repo files\" />\n  <skill id=\"pytest\" privilege=\"specialist\" description=\"Run pytest and interpret results\" />\n</skills>\n`,
        context: `# Python Specialist Context\n\n- Use \`skills.xml\` + repository files as the source of truth.\n- Prefer minimal diffs and safe refactors.\n`
      },
      {
        rel: path.join("verify", "security"),
        skillsXml:
          `<skills>\n  <skill id=\"audit_security\" privilege=\"specialist\" description=\"Identify security issues and propose fixes grounded to code\" />\n</skills>\n`,
        context:
          `# Security Verifier Context\n\n- Prefer concrete, file-grounded findings.\n- Classify by severity and exploitability.\n`
      },
      {
        rel: path.join("verify", "style"),
        skillsXml:
          `<skills>\n  <skill id=\"audit_style\" privilege=\"specialist\" description=\"Check formatting/style consistency and propose minimal diffs\" />\n</skills>\n`,
        context:
          `# Style Verifier Context\n\n- Prefer minimal, mechanical edits.\n- Avoid refactors unless required.\n`
      },
      {
        rel: "synthesizer",
        skillsXml:
          `<skills>\n  <skill id=\"synthesize\" privilege=\"specialist\" description=\"Merge multiple agent outputs into a single grounded result\" />\n</skills>\n`,
        context:
          `# Synthesizer Context\n\n- Merge reports without losing constraints.\n- If reports conflict, ask for clarification.\n`
      }
    ];

    for (const seed of specialistSeeds) {
      const dir = path.join(this.paths.specialistsDir, seed.rel);
      ensureDir(dir);
      const skillsPath = path.join(dir, "skills.xml");
      if (!fs.existsSync(skillsPath)) fs.writeFileSync(skillsPath, seed.skillsXml, "utf8");
      const contextPath = path.join(dir, "context.md");
      if (!fs.existsSync(contextPath)) fs.writeFileSync(contextPath, seed.context, "utf8");
    }

    await this.memory.init();
  }

  loadSkills(agentResidence: string): SkillsIndex {
    if (!isSubpath(this.paths.likuRoot, agentResidence)) {
      throw new LikuError("INVALID_RESIDENCE", `agentResidence must be under Liku/: ${agentResidence}`);
    }
    return loadInheritedSkills(agentResidence, this.paths.likuRoot);
  }

  ensureTaskDir(taskDir: string): { todoPath: string; errorsPath: string } {
    ensureDir(taskDir);
    const todoPath = path.join(taskDir, "todo.md");
    const errorsPath = path.join(taskDir, "LikuErrors.md");
    if (!fs.existsSync(todoPath)) fs.writeFileSync(todoPath, "# Todo\n\n", "utf8");
    if (!fs.existsSync(errorsPath)) fs.writeFileSync(errorsPath, "# Liku Errors\n\n", "utf8");
    const instructionsPath = path.join(taskDir, "instructions.apa");
    if (!fs.existsSync(instructionsPath)) {
      fs.writeFileSync(
        instructionsPath,
        `# APA Instructions\n\n- Goal:\n- Constraints:\n- Inputs:\n- Expected outputs:\n`,
        "utf8"
      );
    }
    return { todoPath, errorsPath };
  }

  async invokeAgent(input: InvokeAgentInput): Promise<AgentBundle> {
    // Use the new path normalization that validates and rejects traversal
    const agentResidenceAbs = normalizeAgentResidence(
      input.agentResidence,
      this.repoRoot,
      this.paths.likuRoot
    );

    const skills = this.loadSkills(agentResidenceAbs);

    // Heuristic: if residence is inside Liku/specialist/specific/* treat it as a task dir.
    const specificDir = path.join(this.paths.specialistsDir, "specific");
    const isTask = isSubpath(specificDir, agentResidenceAbs);
    const taskDir = isTask ? agentResidenceAbs : path.join(specificDir, "task-" + id());
    const paperTrail = this.ensureTaskDir(taskDir);

    appendTodo(paperTrail.todoPath, `Invoke agent at ${path.relative(this.repoRoot, agentResidenceAbs)}`);

    const event: TaskEvent = {
      id: id(),
      time: isoNow(),
      agentPath: path.relative(this.repoRoot, agentResidenceAbs).replaceAll("\\", "/"),
      type: "invoke",
      payload: { task: input.task, taskDir: path.relative(this.repoRoot, taskDir).replaceAll("\\", "/") }
    };
    await this.memory.logEvent(event);

    const supervisorPromptPath = path.join(this.paths.rootSupervisorDir, "supervisor.prompt.md");
    const supervisorPrompt = fs.readFileSync(supervisorPromptPath, "utf8");
    const contextPath = path.join(agentResidenceAbs, "context.md");
    const localContext = fs.existsSync(contextPath) ? fs.readFileSync(contextPath, "utf8") : "";

    return {
      agentResidence: path.relative(this.repoRoot, agentResidenceAbs).replaceAll("\\", "/"),
      skills: skills.skills,
      paperTrail: {
        todoPath: path.relative(this.repoRoot, paperTrail.todoPath).replaceAll("\\", "/"),
        errorsPath: path.relative(this.repoRoot, paperTrail.errorsPath).replaceAll("\\", "/")
      },
      prompts: {
        system: [supervisorPrompt, localContext].filter(Boolean).join("\n\n"),
        instructions: `Residence: ${path.relative(this.repoRoot, agentResidenceAbs).replaceAll("\\", "/")}\nTask dir: ${path.relative(this.repoRoot, taskDir).replaceAll("\\", "/")}\nTask JSON:\n${JSON.stringify(input.task, null, 2)}\n`
      }
    };
  }

  async recordFailure(agentResidence: string, title: string, details?: string): Promise<void> {
    const agentResidenceAbs = path.resolve(this.repoRoot, agentResidence);
    const paperTrail = this.ensureTaskDir(agentResidenceAbs);
    appendError(paperTrail.errorsPath, title, details);
    await this.memory.logEvent({
      id: id(),
      time: isoNow(),
      agentPath: path.relative(this.repoRoot, agentResidenceAbs).replaceAll("\\", "/"),
      type: "failure",
      payload: { title, details }
    });
  }

  /**
   * Safe wrapper around invokeAgent that returns a result envelope.
   * Never throws - errors are returned as { kind: "error", ... }.
   */
  async invokeAgentSafe(input: InvokeAgentInput): Promise<InvokeResult<AgentBundle>> {
    try {
      const bundle = await this.invokeAgent(input);
      return okResult(bundle);
    } catch (err) {
      const likuErr = toLikuError(err);
      return errorResult(likuErr);
    }
  }
}
