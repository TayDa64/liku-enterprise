import { describe, it, expect } from "vitest";
import {
  validateSkillExecution,
  findEscalationRequired,
  getResidencePrivilege,
  getCapabilities,
  validateSkillsIndex
} from "../src/liku/skills/validator.js";
import type { LikuSkill, SkillsIndex } from "../src/liku/skills/types.js";
import { hasCapability, PRIVILEGE_CAPABILITIES } from "../src/liku/skills/types.js";

describe("Skill Types", () => {
  describe("hasCapability", () => {
    it("should grant root all capabilities", () => {
      expect(hasCapability("root", "read_repo")).toBe(true);
      expect(hasCapability("root", "write_repo")).toBe(true);
      expect(hasCapability("root", "execute_code")).toBe(true);
      expect(hasCapability("root", "network_access")).toBe(true);
      expect(hasCapability("root", "escalate")).toBe(true);
    });

    it("should grant specialist limited capabilities", () => {
      expect(hasCapability("specialist", "read_repo")).toBe(true);
      expect(hasCapability("specialist", "write_repo")).toBe(true);
      expect(hasCapability("specialist", "execute_code")).toBe(true);
      expect(hasCapability("specialist", "network_access")).toBe(false);
      expect(hasCapability("specialist", "escalate")).toBe(false);
    });

    it("should grant user read-only", () => {
      expect(hasCapability("user", "read_repo")).toBe(true);
      expect(hasCapability("user", "write_repo")).toBe(false);
      expect(hasCapability("user", "execute_code")).toBe(false);
    });
  });

  describe("PRIVILEGE_CAPABILITIES", () => {
    it("should have correct capability counts", () => {
      expect(PRIVILEGE_CAPABILITIES.root.length).toBe(7);
      expect(PRIVILEGE_CAPABILITIES.specialist.length).toBe(5);
      expect(PRIVILEGE_CAPABILITIES.user.length).toBe(1);
    });
  });
});

describe("Skill Validator", () => {
  describe("validateSkillExecution", () => {
    it("should allow skill with sufficient privilege", () => {
      const skill: LikuSkill = {
        id: "test",
        residencePath: "Liku/specialist/ts",
        requiredPrivilege: "specialist"
      };
      const result = validateSkillExecution(skill, "specialist");
      expect(result.allowed).toBe(true);
    });

    it("should allow skill with higher privilege", () => {
      const skill: LikuSkill = {
        id: "test",
        residencePath: "Liku/specialist/ts",
        requiredPrivilege: "specialist"
      };
      const result = validateSkillExecution(skill, "root");
      expect(result.allowed).toBe(true);
    });

    it("should block skill with insufficient privilege", () => {
      const skill: LikuSkill = {
        id: "test",
        residencePath: "Liku/root",
        requiredPrivilege: "root"
      };
      const result = validateSkillExecution(skill, "specialist");
      expect(result.allowed).toBe(false);
      if (!result.allowed && result.reason === "insufficient_privilege") {
        expect(result.required).toBe("root");
        expect(result.current).toBe("specialist");
      }
    });

    it("should block skill with missing capability", () => {
      const skill: LikuSkill = {
        id: "network_call",
        residencePath: "Liku/specialist/ts",
        requiredPrivilege: "specialist",
        requires: "network_access"
      };
      const result = validateSkillExecution(skill, "specialist");
      expect(result.allowed).toBe(false);
      if (!result.allowed && result.reason === "missing_capability") {
        expect(result.capability).toBe("network_access");
      }
    });

    it("should allow skill when capability is present", () => {
      const skill: LikuSkill = {
        id: "network_call",
        residencePath: "Liku/root",
        requiredPrivilege: "root",
        requires: "network_access"
      };
      const result = validateSkillExecution(skill, "root");
      expect(result.allowed).toBe(true);
    });

    it("should mark escalation flag correctly", () => {
      const skill: LikuSkill = {
        id: "delete_files",
        residencePath: "Liku/specialist/ts",
        requiredPrivilege: "specialist",
        requires: "network_access",
        escalateIfMissing: true
      };
      const result = validateSkillExecution(skill, "specialist");
      expect(result.allowed).toBe(false);
      if (!result.allowed && result.reason === "missing_capability") {
        expect(result.escalate).toBe(true);
      }
    });
  });

  describe("findEscalationRequired", () => {
    it("should find skills requiring escalation", () => {
      const skillsIndex: SkillsIndex = {
        skills: [
          { id: "safe_read", residencePath: "Liku/specialist/ts", requiredPrivilege: "user" },
          { id: "dangerous_write", residencePath: "Liku/specialist/ts", requiredPrivilege: "specialist", requires: "network_access", escalateIfMissing: true }
        ],
        byId: new Map()
      };
      skillsIndex.skills.forEach(s => skillsIndex.byId.set(s.id, s));

      const escalations = findEscalationRequired(skillsIndex, "specialist");
      expect(escalations.length).toBe(1);
      expect(escalations[0]!.id).toBe("dangerous_write");
    });

    it("should return empty for fully allowed skills", () => {
      const skillsIndex: SkillsIndex = {
        skills: [
          { id: "read", residencePath: "Liku/root", requiredPrivilege: "user" },
          { id: "write", residencePath: "Liku/root", requiredPrivilege: "specialist" }
        ],
        byId: new Map()
      };
      skillsIndex.skills.forEach(s => skillsIndex.byId.set(s.id, s));

      const escalations = findEscalationRequired(skillsIndex, "root");
      expect(escalations.length).toBe(0);
    });
  });

  describe("getResidencePrivilege", () => {
    it("should return root for root residence", () => {
      expect(getResidencePrivilege("Liku/root")).toBe("root");
      expect(getResidencePrivilege("C:/repo/Liku/root")).toBe("root");
    });

    it("should return root for Liku root", () => {
      expect(getResidencePrivilege("Liku")).toBe("root");
      expect(getResidencePrivilege("C:/repo/Liku")).toBe("root");
    });

    it("should return specialist for specialist residence", () => {
      expect(getResidencePrivilege("Liku/specialist/ts")).toBe("specialist");
      expect(getResidencePrivilege("Liku/specialist/python")).toBe("specialist");
    });

    it("should return user for other paths", () => {
      expect(getResidencePrivilege("Liku/task/abc")).toBe("user");
      expect(getResidencePrivilege("other/path")).toBe("user");
    });

    it("should handle Windows paths", () => {
      expect(getResidencePrivilege("C:\\repo\\Liku\\root")).toBe("root");
      expect(getResidencePrivilege("C:\\repo\\Liku\\specialist\\ts")).toBe("specialist");
    });
  });

  describe("getCapabilities", () => {
    it("should return all root capabilities", () => {
      const caps = getCapabilities("root");
      expect(caps).toContain("read_repo");
      expect(caps).toContain("write_repo");
      expect(caps).toContain("network_access");
      expect(caps).toContain("escalate");
    });

    it("should return specialist capabilities", () => {
      const caps = getCapabilities("specialist");
      expect(caps).toContain("read_repo");
      expect(caps).toContain("write_repo");
      expect(caps).not.toContain("network_access");
    });

    it("should return user capabilities", () => {
      const caps = getCapabilities("user");
      expect(caps).toContain("read_repo");
      expect(caps.length).toBe(1);
    });
  });

  describe("validateSkillsIndex", () => {
    it("should produce complete validation report", () => {
      const skillsIndex: SkillsIndex = {
        skills: [
          { id: "allowed", residencePath: "test", requiredPrivilege: "user" },
          { id: "blocked", residencePath: "test", requiredPrivilege: "root" },
          { id: "escalate", residencePath: "test", requiredPrivilege: "specialist", requires: "network_access", escalateIfMissing: true }
        ],
        byId: new Map()
      };
      skillsIndex.skills.forEach(s => skillsIndex.byId.set(s.id, s));

      const report = validateSkillsIndex(skillsIndex, "specialist");
      
      expect(report.totalSkills).toBe(3);
      expect(report.allowed).toBe(1);
      expect(report.blocked).toBe(1);
      expect(report.escalationRequired).toBe(1);
      expect(report.details.length).toBe(3);
    });

    it("should report all allowed for root", () => {
      const skillsIndex: SkillsIndex = {
        skills: [
          { id: "a", residencePath: "test", requiredPrivilege: "user" },
          { id: "b", residencePath: "test", requiredPrivilege: "specialist" },
          { id: "c", residencePath: "test", requiredPrivilege: "root", requires: "network_access" }
        ],
        byId: new Map()
      };
      skillsIndex.skills.forEach(s => skillsIndex.byId.set(s.id, s));

      const report = validateSkillsIndex(skillsIndex, "root");
      
      expect(report.allowed).toBe(3);
      expect(report.blocked).toBe(0);
      expect(report.escalationRequired).toBe(0);
    });
  });
});
