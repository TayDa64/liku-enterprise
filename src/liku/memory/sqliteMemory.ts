import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { MemorySearchResult, TaskEvent } from "./types.js";
import { LikuError } from "../errors.js";

type SqlJsBundle = {
  SQL: SqlJsStatic;
  db: Database;
};

/**
 * Attempts to locate sql-wasm.wasm in multiple candidate locations.
 * Order:
 *   1. Adjacent to the running JS (dist/)
 *   2. node_modules/sql.js/dist/ relative to cwd
 *   3. Via require.resolve from this file's directory
 *   4. Via require.resolve from cwd
 */
function locateSqlWasm(filename: string): string {
  // 1. Check adjacent to the running JS file (for bundled dist/)
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const localCandidate = path.join(here, filename);
    if (fs.existsSync(localCandidate)) return localCandidate;
  } catch {
    // import.meta.url may not resolve in all contexts
  }

  // 2. Check node_modules relative to cwd
  const nodeModulesCandidate = path.resolve(process.cwd(), "node_modules", "sql.js", "dist", filename);
  if (fs.existsSync(nodeModulesCandidate)) return nodeModulesCandidate;

  // 3. Try require.resolve from this file's location
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve(`sql.js/dist/${filename}`);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // May fail if sql.js is not resolvable from here
  }

  // 4. Try require.resolve from cwd (npx/global installs)
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const resolved = require.resolve(`sql.js/dist/${filename}`);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // May fail
  }

  // 5. Fallback: return the node_modules path (sql.js will throw its own error if it doesn't exist)
  return nodeModulesCandidate;
}

async function openDb(dbPath: string): Promise<SqlJsBundle> {
  const SQL = await initSqlJs({
    locateFile: (filename: string) => locateSqlWasm(filename)
  }).catch((err: unknown) => {
    throw new LikuError("SQLITE_INIT_FAILED", "Failed to initialize sql.js (missing/invalid wasm?)", {
      err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
      searchedPaths: [
        "adjacent to dist/",
        `${process.cwd()}/node_modules/sql.js/dist/`,
        "require.resolve('sql.js/dist/sql-wasm.wasm')"
      ]
    });
  });
  if (fs.existsSync(dbPath)) {
    const bytes = fs.readFileSync(dbPath);
    const db = new SQL.Database(bytes);
    return { SQL, db };
  }
  const db = new SQL.Database();
  return { SQL, db };
}

function migrate(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL,
      agent_path TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_events_time ON events(time);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_path);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  `);
}

function safeStringify(payload: unknown): string {
  try {
    return JSON.stringify(payload ?? null);
  } catch {
    return JSON.stringify({ error: "non_serializable_payload" });
  }
}

export class SqliteMemory {
  private readonly dbPath: string;
  private bundle?: SqlJsBundle;
  private _degraded = false;
  private _degradedReason?: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Returns true if memory is in degraded mode (init failed but engine continues).
   */
  get isDegraded(): boolean {
    return this._degraded;
  }

  get degradedReason(): string | undefined {
    return this._degradedReason;
  }

  /**
   * Initialize memory. If init fails, enters degraded mode instead of throwing.
   * Returns true on success, false on degraded mode.
   */
  async init(): Promise<boolean> {
    try {
      const dir = path.dirname(this.dbPath);
      fs.mkdirSync(dir, { recursive: true });
      this.bundle = await openDb(this.dbPath);
      migrate(this.bundle.db);
      await this.flush();
      this._degraded = false;
      return true;
    } catch (err) {
      this._degraded = true;
      this._degradedReason = err instanceof Error ? err.message : String(err);
      // Log to stderr for debugging but don't crash
      process.stderr.write(`[liku] Memory init failed (degraded mode): ${this._degradedReason}\n`);
      return false;
    }
  }

  async flush(): Promise<void> {
    if (!this.bundle) return;
    const data = this.bundle.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  async logEvent(event: TaskEvent): Promise<void> {
    if (this._degraded) {
      // In degraded mode, silently skip memory logging (paper trail still works)
      return;
    }
    if (!this.bundle) throw new LikuError("MEMORY_NOT_INITIALIZED", "SqliteMemory not initialized");
    this.bundle.db.run(
      `INSERT OR REPLACE INTO events (id, time, agent_path, type, payload_json) VALUES (?, ?, ?, ?, ?)`,
      [event.id, event.time, event.agentPath, event.type, safeStringify(event.payload)]
    );
    await this.flush();
  }

  async search(query: string, limit = 20): Promise<MemorySearchResult[]> {
    if (this._degraded) {
      throw new LikuError("MEMORY_DEGRADED", `Memory search unavailable: ${this._degradedReason}`);
    }
    if (!this.bundle) throw new LikuError("MEMORY_NOT_INITIALIZED", "SqliteMemory not initialized");
    const q = `%${query}%`;
    const stmt = this.bundle.db.prepare(
      `SELECT id, time, agent_path, type, payload_json FROM events WHERE payload_json LIKE ? ORDER BY time DESC LIMIT ?`
    );
    stmt.bind([q, limit]);
    const rows: MemorySearchResult[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      const payloadJson = typeof row.payload_json === "string" ? row.payload_json : "";
      rows.push({
        id: String(row.id ?? ""),
        time: String(row.time ?? ""),
        agentPath: String(row.agent_path ?? ""),
        type: String(row.type ?? ""),
        snippet: payloadJson.slice(0, 240)
      });
    }
    stmt.free();
    return rows;
  }
}
