export type Privilege = "user" | "specialist" | "root";

/**
 * A capability that can be granted to an agent.
 * Capabilities are checked before skill execution.
 */
export type Capability =
  | "read_repo"
  | "write_repo"
  | "execute_code"
  | "network_access"
  | "memory_write"
  | "escalate"
  | "invoke_subagent";

export type LikuSkill = {
  id: string;
  description?: string;
  residencePath: string;
  requiredPrivilege: Privilege;
  /** Capability required to execute this skill */
  requires?: Capability;
  /** If true, missing capability triggers escalation instead of error */
  escalateIfMissing?: boolean;
};

export type SkillsIndex = {
  skills: LikuSkill[];
  byId: Map<string, LikuSkill>;
};

/**
 * Capabilities granted at a residence level.
 * Root has all capabilities, specialists have subset.
 */
export const PRIVILEGE_CAPABILITIES: Record<Privilege, Capability[]> = {
  root: ["read_repo", "write_repo", "execute_code", "network_access", "memory_write", "escalate", "invoke_subagent"],
  specialist: ["read_repo", "write_repo", "execute_code", "memory_write", "invoke_subagent"],
  user: ["read_repo"]
};

/**
 * Check if a privilege level has a capability.
 */
export function hasCapability(privilege: Privilege, capability: Capability): boolean {
  return PRIVILEGE_CAPABILITIES[privilege].includes(capability);
}

