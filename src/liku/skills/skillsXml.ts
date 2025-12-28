import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { LikuSkill, Privilege, Capability } from "./types.js";

type ParsedSkill = {
  id?: string;
  privilege?: Privilege;
  description?: string;
  requires?: string;
  escalateIfMissing?: string | boolean;
};

type ParsedSkillsDoc = {
  skills?: {
    skill?: ParsedSkill[] | ParsedSkill;
  };
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  allowBooleanAttributes: true,
  trimValues: true
});

function normalizePrivilege(raw: unknown): Privilege {
  if (raw === "root" || raw === "specialist" || raw === "user") return raw;
  return "user";
}

const VALID_CAPABILITIES: Capability[] = [
  "read_repo", "write_repo", "execute_code", "network_access", "memory_write", "escalate", "invoke_subagent"
];

function normalizeCapability(raw: unknown): Capability | undefined {
  if (typeof raw === "string" && VALID_CAPABILITIES.includes(raw as Capability)) {
    return raw as Capability;
  }
  return undefined;
}

function normalizeBoolean(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === "1") return true;
  return false;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function loadSkillsXml(skillsXmlPath: string, residencePath: string): LikuSkill[] {
  if (!fs.existsSync(skillsXmlPath)) return [];
  const xml = fs.readFileSync(skillsXmlPath, "utf8");
  const doc = parser.parse(xml) as ParsedSkillsDoc;

  const skills = toArray(doc.skills?.skill).flatMap((raw): LikuSkill[] => {
    const id = raw.id?.trim();
    if (!id) return [];
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const requiredPrivilege = normalizePrivilege(raw.privilege);
    const requires = normalizeCapability(raw.requires);
    const escalateIfMissing = normalizeBoolean(raw.escalateIfMissing);
    
    const skill: LikuSkill = {
      id,
      residencePath,
      requiredPrivilege
    };
    if (description) {
      skill.description = description;
    }
    if (requires) {
      skill.requires = requires;
    }
    if (escalateIfMissing) {
      skill.escalateIfMissing = escalateIfMissing;
    }
    return [skill];
  });

  return skills;
}

export function findSkillsXmlFiles(fromDir: string, stopAtDir: string): string[] {
  const files: string[] = [];
  let current = path.resolve(fromDir);
  const stop = path.resolve(stopAtDir);

  // Include fromDir, then walk up to stopAtDir (inclusive).
  // Example: Liku/specialist/ts/specific/sprint-001 -> ... -> Liku
  while (true) {
    const candidate = path.join(current, "skills.xml");
    if (fs.existsSync(candidate)) files.push(candidate);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return files;
}

