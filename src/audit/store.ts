import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface RequestRecord {
  user: string;
  source: string;
  conversationId: string;
  text: string;
}

export interface ToolCallRecord {
  requestId: string;
  name: string;
  scope: string;
  host?: string;
  args: unknown;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  approvalId?: string;
}

export interface ApprovalRecord {
  requestId: string;
  toolName: string;
  scope: string;
  args: unknown;
}

export interface ApprovalDecisionRecord {
  approvalId: string;
  approved: boolean;
  decidedBy?: string;
  reason?: string;
}

/**
 * Append-only audit log. All writes are synchronous (SQLite + better-sqlite3),
 * which is fine — we're talking single-digit millisecond inserts and the
 * caller doesn't need the result to proceed.
 */
export class AuditStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  recordRequest(r: RequestRecord): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO requests (id, at, user, source, conversation_id, text) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, new Date().toISOString(), r.user, r.source, r.conversationId, r.text);
    return id;
  }

  recordResponse(requestId: string, opts: { text?: string; error?: string; durationMs: number }): void {
    this.db
      .prepare(
        `UPDATE requests SET response_text = ?, error = ?, duration_ms = ?, completed_at = ? WHERE id = ?`,
      )
      .run(opts.text ?? null, opts.error ?? null, opts.durationMs, new Date().toISOString(), requestId);
  }

  recordToolCall(t: ToolCallRecord): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tool_calls
         (id, request_id, at, name, scope, host, args, ok, result, error, duration_ms, approval_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        t.requestId,
        new Date().toISOString(),
        t.name,
        t.scope,
        t.host ?? null,
        JSON.stringify(t.args ?? null),
        t.ok ? 1 : 0,
        t.result !== undefined ? JSON.stringify(t.result) : null,
        t.error ?? null,
        t.durationMs,
        t.approvalId ?? null,
      );
    return id;
  }

  recordApprovalRequest(a: ApprovalRecord): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO approvals (id, request_id, requested_at, tool_name, scope, args)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, a.requestId, new Date().toISOString(), a.toolName, a.scope, JSON.stringify(a.args ?? null));
    return id;
  }

  recordApprovalDecision(d: ApprovalDecisionRecord): void {
    this.db
      .prepare(
        `UPDATE approvals SET approved = ?, decided_by = ?, decided_at = ?, reason = ? WHERE id = ?`,
      )
      .run(d.approved ? 1 : 0, d.decidedBy ?? null, new Date().toISOString(), d.reason ?? null, d.approvalId);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        completed_at TEXT,
        user TEXT NOT NULL,
        source TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        text TEXT NOT NULL,
        response_text TEXT,
        error TEXT,
        duration_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        at TEXT NOT NULL,
        name TEXT NOT NULL,
        scope TEXT NOT NULL,
        host TEXT,
        args TEXT,
        ok INTEGER NOT NULL,
        result TEXT,
        error TEXT,
        duration_ms INTEGER NOT NULL,
        approval_id TEXT,
        FOREIGN KEY (request_id) REFERENCES requests(id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        tool_name TEXT NOT NULL,
        scope TEXT NOT NULL,
        args TEXT,
        approved INTEGER,
        decided_by TEXT,
        reason TEXT,
        FOREIGN KEY (request_id) REFERENCES requests(id)
      );

      CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user);
      CREATE INDEX IF NOT EXISTS idx_requests_at ON requests(at);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_request ON tool_calls(request_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(name);
      CREATE INDEX IF NOT EXISTS idx_approvals_request ON approvals(request_id);
    `);
  }
}
