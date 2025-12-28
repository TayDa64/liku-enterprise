/**
 * Provenance metadata for memory entries.
 * Enables replay, audit, and pruning strategies.
 */
export type MemoryProvenance = {
  /** Repository where this memory was created */
  repoId?: string;
  /** Task that created this memory */
  taskId?: string;
  /** Step within the task */
  stepId?: string;
  /** Agent role that produced this memory */
  agentRole?: string;
  /** Confidence score (0-1), if available */
  confidence?: number;
  /** Source of the memory (agent, user, system) */
  source: "agent" | "user" | "system";
  /** Whether this memory has been validated */
  validated?: boolean;
  /** TTL in milliseconds (0 = no expiry) */
  ttlMs?: number;
};

/**
 * Memory scope for filtering queries.
 */
export type MemoryScope = "global" | "repo" | "task";

export type TaskEvent = {
  id: string;
  time: string;
  agentPath: string;
  type: string;
  payload?: unknown;
  /** Provenance metadata for audit and filtering */
  provenance?: MemoryProvenance;
};

export type MemorySearchResult = {
  id: string;
  time: string;
  agentPath: string;
  type: string;
  snippet: string;
  /** Provenance if available */
  provenance?: MemoryProvenance;
};

/**
 * Options for memory search.
 */
export type MemorySearchOptions = {
  /** Scope of search */
  scope?: MemoryScope;
  /** Filter by repo */
  repoId?: string;
  /** Filter by task */
  taskId?: string;
  /** Filter by agent role */
  agentRole?: string;
  /** Minimum confidence score */
  minConfidence?: number;
  /** Only return validated entries */
  validatedOnly?: boolean;
  /** Maximum results */
  limit?: number;
};

/**
 * Options for logging events with provenance.
 */
export type LogEventOptions = {
  /** Provenance metadata */
  provenance?: Partial<MemoryProvenance>;
  /** Maximum size in bytes (default 64KB) */
  maxSize?: number;
};

