import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadInheritedSkills } from "../src/liku/skills/loader.js";

describe("loadInheritedSkills", () => {
  let tmpDir: string;
  let likuRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "liku-skills-test-"));
    likuRoot = path.join(tmpDir, "Liku");

    // Create directory structure
    fs.mkdirSync(path.join(likuRoot, "specialist", "ts"), { recursive: true });
    fs.mkdirSync(path.join(likuRoot, "specialist", "ts", "specific", "task-001"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads skills from a single directory", () => {
    fs.writeFileSync(
      path.join(likuRoot, "skills.xml"),
      `<skills>
        <skill id="root_skill" privilege="root" description="Root skill" />
      </skills>`,
      "utf8"
    );

    const result = loadInheritedSkills(likuRoot, likuRoot);
    expect(result.skills.length).toBe(1);
    expect(result.skills[0]!.id).toBe("root_skill");
    expect(result.byId.get("root_skill")).toBeDefined();
  });

  it("inherits skills from parent directories", () => {
    fs.writeFileSync(
      path.join(likuRoot, "skills.xml"),
      `<skills>
        <skill id="root_skill" privilege="root" description="Root skill" />
      </skills>`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(likuRoot, "specialist", "skills.xml"),
      `<skills>
        <skill id="specialist_skill" privilege="specialist" description="Specialist skill" />
      </skills>`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(likuRoot, "specialist", "ts", "skills.xml"),
      `<skills>
        <skill id="ts_skill" privilege="specialist" description="TS skill" />
      </skills>`,
      "utf8"
    );

    const residence = path.join(likuRoot, "specialist", "ts");
    const result = loadInheritedSkills(residence, likuRoot);

    const ids = result.skills.map((s) => s.id).sort();
    expect(ids).toEqual(["root_skill", "specialist_skill", "ts_skill"]);
  });

  it("child skills override parent skills by id", () => {
    fs.writeFileSync(
      path.join(likuRoot, "skills.xml"),
      `<skills>
        <skill id="shared_skill" privilege="root" description="Root version" />
      </skills>`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(likuRoot, "specialist", "ts", "skills.xml"),
      `<skills>
        <skill id="shared_skill" privilege="specialist" description="TS override" />
      </skills>`,
      "utf8"
    );

    const residence = path.join(likuRoot, "specialist", "ts");
    const result = loadInheritedSkills(residence, likuRoot);

    expect(result.skills.length).toBe(1);
    expect(result.skills[0]!.description).toBe("TS override");
    expect(result.skills[0]!.requiredPrivilege).toBe("specialist");
  });

  it("deeply nested residence inherits all parent skills", () => {
    fs.writeFileSync(
      path.join(likuRoot, "skills.xml"),
      `<skills>
        <skill id="l0" privilege="root" description="Level 0" />
      </skills>`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(likuRoot, "specialist", "skills.xml"),
      `<skills>
        <skill id="l1" privilege="specialist" description="Level 1" />
      </skills>`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(likuRoot, "specialist", "ts", "skills.xml"),
      `<skills>
        <skill id="l2" privilege="specialist" description="Level 2" />
      </skills>`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(likuRoot, "specialist", "ts", "specific", "skills.xml"),
      `<skills>
        <skill id="l3" privilege="user" description="Level 3" />
      </skills>`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(likuRoot, "specialist", "ts", "specific", "task-001", "skills.xml"),
      `<skills>
        <skill id="l4" privilege="user" description="Level 4" />
      </skills>`,
      "utf8"
    );

    const residence = path.join(likuRoot, "specialist", "ts", "specific", "task-001");
    const result = loadInheritedSkills(residence, likuRoot);

    const ids = result.skills.map((s) => s.id).sort();
    expect(ids).toEqual(["l0", "l1", "l2", "l3", "l4"]);
  });

  it("returns empty skills when no skills.xml files exist", () => {
    const residence = path.join(likuRoot, "specialist", "ts");
    const result = loadInheritedSkills(residence, likuRoot);

    expect(result.skills).toEqual([]);
    expect(result.byId.size).toBe(0);
  });

  it("skills are sorted by id", () => {
    fs.writeFileSync(
      path.join(likuRoot, "skills.xml"),
      `<skills>
        <skill id="zebra" privilege="user" description="Z" />
        <skill id="alpha" privilege="user" description="A" />
        <skill id="mike" privilege="user" description="M" />
      </skills>`,
      "utf8"
    );

    const result = loadInheritedSkills(likuRoot, likuRoot);
    const ids = result.skills.map((s) => s.id);
    expect(ids).toEqual(["alpha", "mike", "zebra"]);
  });

  it("byId map provides quick lookup", () => {
    fs.writeFileSync(
      path.join(likuRoot, "skills.xml"),
      `<skills>
        <skill id="skill_a" privilege="root" description="Skill A" />
        <skill id="skill_b" privilege="user" description="Skill B" />
      </skills>`,
      "utf8"
    );

    const result = loadInheritedSkills(likuRoot, likuRoot);
    expect(result.byId.get("skill_a")?.description).toBe("Skill A");
    expect(result.byId.get("skill_b")?.requiredPrivilege).toBe("user");
    expect(result.byId.get("nonexistent")).toBeUndefined();
  });
});
