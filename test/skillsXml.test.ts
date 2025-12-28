import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSkillsXml } from "../src/liku/skills/skillsXml.js";

describe("skills.xml parsing", () => {
  it("parses skills and privileges", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liku-"));
    const file = path.join(dir, "skills.xml");
    fs.writeFileSync(
      file,
      `<skills>\n  <skill id="a" privilege="user" description="d1" />\n  <skill id="b" privilege="root" description="d2" />\n</skills>\n`,
      "utf8"
    );
    const skills = loadSkillsXml(file, dir);
    expect(skills.map((s) => s.id)).toEqual(["a", "b"]);
    expect(skills[1]?.requiredPrivilege).toBe("root");
  });
});

