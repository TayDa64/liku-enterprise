import path from "node:path";
import { findSkillsXmlFiles, loadSkillsXml } from "./skillsXml.js";
import type { LikuSkill, SkillsIndex } from "./types.js";

export function loadInheritedSkills(residenceDir: string, likuRootDir: string): SkillsIndex {
  const files = findSkillsXmlFiles(residenceDir, likuRootDir);
  const skills: LikuSkill[] = [];
  const byId = new Map<string, LikuSkill>();

  // Parent skills are loaded first; children override by id.
  for (const file of files.reverse()) {
    const fileDir = path.dirname(file);
    for (const skill of loadSkillsXml(file, fileDir)) {
      byId.set(skill.id, skill);
    }
  }

  for (const skill of byId.values()) skills.push(skill);
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return { skills, byId };
}

