/**
 * Skill capability validation.
 * Checks if an agent has the required capabilities to execute skills.
 */

import type { LikuSkill, Privilege, Capability, SkillsIndex } from "./types.js";
import { hasCapability, PRIVILEGE_CAPABILITIES } from "./types.js";

/**
 * Result of validating a skill for execution.
 */
export type SkillValidationResult =
  | { allowed: true }
  | { allowed: false; reason: "missing_capability"; capability: Capability; escalate: boolean }
  | { allowed: false; reason: "insufficient_privilege"; required: Privilege; current: Privilege };

/**
 * Validate if a skill can be executed at the given privilege level.
 */
export function validateSkillExecution(
  skill: LikuSkill,
  currentPrivilege: Privilege
): SkillValidationResult {
  // Check privilege level first
  const privilegeOrder: Privilege[] = ["user", "specialist", "root"];
  const currentLevel = privilegeOrder.indexOf(currentPrivilege);
  const requiredLevel = privilegeOrder.indexOf(skill.requiredPrivilege);

  if (currentLevel < requiredLevel) {
    return {
      allowed: false,
      reason: "insufficient_privilege",
      required: skill.requiredPrivilege,
      current: currentPrivilege
    };
  }

  // Check capability requirement
  if (skill.requires) {
    if (!hasCapability(currentPrivilege, skill.requires)) {
      return {
        allowed: false,
        reason: "missing_capability",
        capability: skill.requires,
        escalate: skill.escalateIfMissing ?? false
      };
    }
  }

  return { allowed: true };
}

/**
 * Check all skills in an index for capability violations.
 * Returns skills that would require escalation.
 */
export function findEscalationRequired(
  skillsIndex: SkillsIndex,
  currentPrivilege: Privilege
): LikuSkill[] {
  const escalationSkills: LikuSkill[] = [];

  for (const skill of skillsIndex.skills) {
    const result = validateSkillExecution(skill, currentPrivilege);
    if (!result.allowed && result.reason === "missing_capability" && result.escalate) {
      escalationSkills.push(skill);
    }
  }

  return escalationSkills;
}

/**
 * Get capabilities available at a residence based on its path.
 * Root residence has all capabilities, specialists have subset.
 */
export function getResidencePrivilege(residencePath: string): Privilege {
  // Normalize path separators
  const normalized = residencePath.replace(/\\/g, "/");
  
  if (normalized.includes("/root")) {
    return "root";
  }
  // Match "Liku" at end of path (the root Liku directory)
  if (normalized === "Liku" || normalized.endsWith("/Liku")) {
    return "root";
  }
  if (normalized.includes("/specialist")) {
    return "specialist";
  }
  return "user";
}

/**
 * Get all capabilities available at a privilege level.
 */
export function getCapabilities(privilege: Privilege): Capability[] {
  return [...PRIVILEGE_CAPABILITIES[privilege]];
}

/**
 * Build a validation report for a set of skills.
 */
export type SkillValidationReport = {
  totalSkills: number;
  allowed: number;
  blocked: number;
  escalationRequired: number;
  details: Array<{
    skillId: string;
    result: SkillValidationResult;
  }>;
};

export function validateSkillsIndex(
  skillsIndex: SkillsIndex,
  currentPrivilege: Privilege
): SkillValidationReport {
  const details: SkillValidationReport["details"] = [];
  let allowed = 0;
  let blocked = 0;
  let escalationRequired = 0;

  for (const skill of skillsIndex.skills) {
    const result = validateSkillExecution(skill, currentPrivilege);
    details.push({ skillId: skill.id, result });

    if (result.allowed) {
      allowed++;
    } else if (result.reason === "missing_capability" && result.escalate) {
      escalationRequired++;
    } else {
      blocked++;
    }
  }

  return {
    totalSkills: skillsIndex.skills.length,
    allowed,
    blocked,
    escalationRequired,
    details
  };
}
