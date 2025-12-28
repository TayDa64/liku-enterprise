import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LikuEngine } from "../src/liku/engine.js";

describe("LikuEngine", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "liku-engine-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("init()", () => {
    it("creates expected directory structure", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      expect(fs.existsSync(path.join(tmpDir, "Liku"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "Liku", "root"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "Liku", "specialist"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "Liku", "specialist", "specific"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "Liku", "memory"))).toBe(true);
    });

    it("creates policy.md with expected content", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      const policyPath = path.join(tmpDir, "Liku", "root", "policy.md");
      expect(fs.existsSync(policyPath)).toBe(true);
      const content = fs.readFileSync(policyPath, "utf8");
      expect(content).toContain("# Liku Policy");
    });

    it("creates skills.xml at Liku root", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      const skillsPath = path.join(tmpDir, "Liku", "skills.xml");
      expect(fs.existsSync(skillsPath)).toBe(true);
      const content = fs.readFileSync(skillsPath, "utf8");
      expect(content).toContain("<skills>");
      expect(content).toContain("log_error");
    });

    it("creates ts and python specialist directories", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      expect(fs.existsSync(path.join(tmpDir, "Liku", "specialist", "ts"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "Liku", "specialist", "python"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "Liku", "specialist", "ts", "skills.xml"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "Liku", "specialist", "python", "skills.xml"))).toBe(true);
    });

    it("is idempotent (does not overwrite existing files)", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      const policyPath = path.join(tmpDir, "Liku", "root", "policy.md");
      fs.writeFileSync(policyPath, "# Custom Policy\n", "utf8");

      await engine.init();
      const content = fs.readFileSync(policyPath, "utf8");
      expect(content).toBe("# Custom Policy\n");
    });
  });

  describe("invokeAgent()", () => {
    it("rejects absolute paths", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      const result = await engine.invokeAgentSafe({
        agentResidence: "/absolute/path",
        task: {}
      });

      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("PATH_TRAVERSAL");
      }
    });

    it("rejects path traversal with ..", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      const result = await engine.invokeAgentSafe({
        agentResidence: "Liku/../../../etc/passwd",
        task: {}
      });

      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("PATH_TRAVERSAL");
      }
    });

    it("rejects residence outside Liku/", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      const result = await engine.invokeAgentSafe({
        agentResidence: "src/some/path",
        task: {}
      });

      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.code).toBe("INVALID_RESIDENCE");
      }
    });

    it("returns valid bundle for valid residence", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      const result = await engine.invokeAgentSafe({
        agentResidence: "Liku/specialist/ts",
        task: { action: "test" }
      });

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.bundle.agentResidence).toBe("Liku/specialist/ts");
        expect(result.bundle.skills).toBeDefined();
        expect(Array.isArray(result.bundle.skills)).toBe(true);
        expect(result.bundle.paperTrail).toBeDefined();
        expect(result.bundle.prompts).toBeDefined();
      }
    });

    it("inherits skills from parent directories", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      const result = await engine.invokeAgentSafe({
        agentResidence: "Liku/specialist/ts",
        task: {}
      });

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const skillIds = result.bundle.skills.map((s) => s.id);
        // Should have root skills + ts skills
        expect(skillIds).toContain("log_error"); // from root
        expect(skillIds).toContain("refactor_ts"); // from ts specialist
      }
    });
  });

  describe("ensureTaskDir()", () => {
    it("creates todo.md and LikuErrors.md", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      const taskDir = path.join(tmpDir, "Liku", "specialist", "specific", "test-task");
      const { todoPath, errorsPath } = engine.ensureTaskDir(taskDir);

      expect(fs.existsSync(todoPath)).toBe(true);
      expect(fs.existsSync(errorsPath)).toBe(true);
      expect(fs.readFileSync(todoPath, "utf8")).toContain("# Todo");
      expect(fs.readFileSync(errorsPath, "utf8")).toContain("# Liku Errors");
    });
  });

  describe("loadSkills()", () => {
    it("loads skills from a residence directory", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      const tsDir = path.join(tmpDir, "Liku", "specialist", "ts");
      const skills = engine.loadSkills(tsDir);

      expect(skills.skills.length).toBeGreaterThan(0);
      const skillIds = skills.skills.map((s) => s.id);
      expect(skillIds).toContain("refactor_ts");
    });

    it("throws for residence outside Liku/", async () => {
      const engine = new LikuEngine({ repoRoot: tmpDir });
      await engine.init();

      expect(() => engine.loadSkills(tmpDir)).toThrow();
    });
  });
});
