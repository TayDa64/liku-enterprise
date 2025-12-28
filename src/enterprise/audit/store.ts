import crypto from "node:crypto";
import type { 
  AuditEntry, 
  AuditQuery, 
  AuditStore, 
  AuditConfig, 
  ChainVerificationResult,
  AuditAction,
  AuditOutcome
} from "./types.js";
import { AuditError } from "./types.js";

/**
 * SQLite-based Immutable Audit Store
 * 
 * Implements append-only, tamper-evident audit logging with hash chains.
 */

// In-memory implementation for scaffolding
// Production should use better-sqlite3 or sql.js

type StoredEntry = AuditEntry;

export class SqliteAuditStore implements AuditStore {
  private entries: StoredEntry[] = [];
  private config: AuditConfig;
  private hashAlgorithm: string;

  constructor(config: AuditConfig) {
    this.config = config;
    this.hashAlgorithm = config.hashAlgorithm;
  }

  /**
   * Initialize the audit store
   */
  async init(): Promise<void> {
    // In production: create SQLite tables with appropriate constraints
    // CREATE TABLE audit_log (
    //   id TEXT PRIMARY KEY,
    //   sequence INTEGER UNIQUE NOT NULL,
    //   timestamp TEXT NOT NULL,
    //   previous_hash TEXT NOT NULL,
    //   content_hash TEXT NOT NULL,
    //   actor_json TEXT NOT NULL,
    //   tenant_id TEXT NOT NULL,
    //   action TEXT NOT NULL,
    //   outcome TEXT NOT NULL,
    //   resource_json TEXT NOT NULL,
    //   request_id TEXT,
    //   details_json TEXT,
    //   error_json TEXT
    // );
    // CREATE INDEX idx_audit_tenant ON audit_log(tenant_id);
    // CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
    // CREATE INDEX idx_audit_action ON audit_log(action);
    // CREATE INDEX idx_audit_sequence ON audit_log(sequence);
  }

  async append(
    entry: Omit<AuditEntry, "id" | "sequence" | "previousHash" | "contentHash">
  ): Promise<AuditEntry> {
    const id = crypto.randomUUID();
    const sequence = this.entries.length;
    
    // Get previous hash (genesis block uses empty string)
    const previousHash = sequence === 0 
      ? this.hash("GENESIS") 
      : this.entries[sequence - 1].contentHash;

    // Create content for hashing (deterministic JSON)
    const contentForHash = JSON.stringify({
      sequence,
      timestamp: entry.timestamp,
      actor: entry.actor,
      tenantId: entry.tenantId,
      action: entry.action,
      outcome: entry.outcome,
      resource: entry.resource,
      requestId: entry.requestId,
      details: entry.details,
      error: entry.error,
      previousHash
    });

    const contentHash = this.hash(contentForHash);

    const fullEntry: AuditEntry = {
      id,
      sequence,
      previousHash,
      contentHash,
      ...entry
    };

    // Append (in production: INSERT with constraint check)
    this.entries.push(fullEntry);

    return fullEntry;
  }

  async query(query: AuditQuery): Promise<AuditEntry[]> {
    let results = [...this.entries];

    // Apply filters
    if (query.tenantId) {
      results = results.filter(e => e.tenantId === query.tenantId);
    }

    if (query.actorId) {
      results = results.filter(e => e.actor.userId === query.actorId);
    }

    if (query.actions?.length) {
      const actionSet = new Set(query.actions);
      results = results.filter(e => actionSet.has(e.action));
    }

    if (query.outcomes?.length) {
      const outcomeSet = new Set(query.outcomes);
      results = results.filter(e => outcomeSet.has(e.outcome));
    }

    if (query.resourceType) {
      results = results.filter(e => e.resource.type === query.resourceType);
    }

    if (query.resourceId) {
      results = results.filter(e => e.resource.id === query.resourceId);
    }

    if (query.startTime) {
      results = results.filter(e => e.timestamp >= query.startTime!);
    }

    if (query.endTime) {
      results = results.filter(e => e.timestamp < query.endTime!);
    }

    if (query.afterSequence !== undefined) {
      results = results.filter(e => e.sequence > query.afterSequence!);
    }

    // Sort
    results.sort((a, b) => {
      const cmp = a.sequence - b.sequence;
      return query.order === "asc" ? cmp : -cmp;
    });

    // Limit
    return results.slice(0, query.limit);
  }

  async getById(id: string): Promise<AuditEntry | null> {
    return this.entries.find(e => e.id === id) ?? null;
  }

  async getBySequence(sequence: number): Promise<AuditEntry | null> {
    return this.entries[sequence] ?? null;
  }

  async getLatest(): Promise<AuditEntry | null> {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
  }

  async verifyChain(startSequence: number, endSequence: number): Promise<ChainVerificationResult> {
    if (startSequence < 0 || endSequence >= this.entries.length || startSequence > endSequence) {
      throw new AuditError("QUERY_FAILED", "Invalid sequence range");
    }

    let entriesChecked = 0;

    for (let i = startSequence; i <= endSequence; i++) {
      const entry = this.entries[i];
      entriesChecked++;

      // Verify content hash
      const contentForHash = JSON.stringify({
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        actor: entry.actor,
        tenantId: entry.tenantId,
        action: entry.action,
        outcome: entry.outcome,
        resource: entry.resource,
        requestId: entry.requestId,
        details: entry.details,
        error: entry.error,
        previousHash: entry.previousHash
      });

      const expectedHash = this.hash(contentForHash);
      if (entry.contentHash !== expectedHash) {
        return {
          valid: false,
          startSequence,
          endSequence,
          entriesChecked,
          brokenAt: i,
          hashMismatch: {
            expected: expectedHash,
            actual: entry.contentHash
          }
        };
      }

      // Verify chain link (except genesis)
      if (i > 0) {
        const previousEntry = this.entries[i - 1];
        if (entry.previousHash !== previousEntry.contentHash) {
          return {
            valid: false,
            startSequence,
            endSequence,
            entriesChecked,
            brokenAt: i,
            hashMismatch: {
              expected: previousEntry.contentHash,
              actual: entry.previousHash
            }
          };
        }
      }
    }

    return {
      valid: true,
      startSequence,
      endSequence,
      entriesChecked
    };
  }

  async export(query: AuditQuery, format: "json" | "csv"): Promise<string> {
    const entries = await this.query({ ...query, limit: 10000 });

    if (format === "json") {
      return JSON.stringify(entries, null, 2);
    }

    // CSV export
    const headers = [
      "id", "sequence", "timestamp", "actor_id", "actor_email", 
      "tenant_id", "action", "outcome", "resource_type", "resource_id",
      "request_id", "content_hash"
    ];

    const rows = entries.map(e => [
      e.id,
      e.sequence,
      e.timestamp,
      e.actor.userId,
      e.actor.email ?? "",
      e.tenantId,
      e.action,
      e.outcome,
      e.resource.type,
      e.resource.id,
      e.requestId ?? "",
      e.contentHash
    ]);

    return [
      headers.join(","),
      ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))
    ].join("\n");
  }

  private hash(content: string): string {
    return crypto.createHash(this.hashAlgorithm).update(content).digest("hex");
  }
}

/**
 * Create an audit entry builder for common operations
 */
export function createAuditEntryBuilder(tenantId: string, actor: AuditEntry["actor"]) {
  return {
    task(action: Extract<AuditAction, `task.${string}`>, taskId: string, outcome: AuditOutcome, details?: Record<string, unknown>) {
      return {
        timestamp: new Date().toISOString(),
        actor,
        tenantId,
        action,
        outcome,
        resource: { type: "task", id: taskId },
        details
      };
    },

    agent(action: Extract<AuditAction, `agent.${string}`>, agentPath: string, outcome: AuditOutcome, details?: Record<string, unknown>) {
      return {
        timestamp: new Date().toISOString(),
        actor,
        tenantId,
        action,
        outcome,
        resource: { type: "agent", id: agentPath, path: agentPath },
        details
      };
    },

    auth(action: Extract<AuditAction, `auth.${string}`>, outcome: AuditOutcome, details?: Record<string, unknown>) {
      return {
        timestamp: new Date().toISOString(),
        actor,
        tenantId,
        action,
        outcome,
        resource: { type: "session", id: actor.userId },
        details
      };
    },

    security(action: Extract<AuditAction, `security.${string}`>, resourceType: string, resourceId: string, outcome: AuditOutcome, details?: Record<string, unknown>) {
      return {
        timestamp: new Date().toISOString(),
        actor,
        tenantId,
        action,
        outcome,
        resource: { type: resourceType, id: resourceId },
        details
      };
    }
  };
}
