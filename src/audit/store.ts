import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface RequestRecord {
  user: string;
  source: string;
  conversationId: string;
  text: string;
}

export interface ResponseRecord {
  text?: string;
  error?: string;
  durationMs: number;
  llmModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  iterations?: number;
  finalStopReason?: string;
}

export interface ToolCallRecord {
  requestId: string;
  seq: number;
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

const PREVIEW_BYTES = 4096;

/**
 * Append-only audit log. Emits structured JSON to stdout in parallel with
 * SQLite writes so `journalctl -u sherlock-ops -f` shows live activity.
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
    emit({ audit: "request", request_id: id, user: r.user, source: r.source, text: truncate(r.text, 500) });
    return id;
  }

  recordResponse(requestId: string, opts: ResponseRecord): void {
    this.db
      .prepare(
        `UPDATE requests
         SET response_text = ?, error = ?, duration_ms = ?, completed_at = ?,
             llm_model = ?, input_tokens = ?, output_tokens = ?,
             iterations = ?, final_stop_reason = ?
         WHERE id = ?`,
      )
      .run(
        opts.text ?? null,
        opts.error ?? null,
        opts.durationMs,
        new Date().toISOString(),
        opts.llmModel ?? null,
        opts.inputTokens ?? null,
        opts.outputTokens ?? null,
        opts.iterations ?? null,
        opts.finalStopReason ?? null,
        requestId,
      );
    emit({
      audit: "response",
      request_id: requestId,
      ok: !opts.error,
      duration_ms: opts.durationMs,
      llm_model: opts.llmModel,
      input_tokens: opts.inputTokens,
      output_tokens: opts.outputTokens,
      iterations: opts.iterations,
      final_stop_reason: opts.finalStopReason,
      error: opts.error,
    });
  }

  recordToolCall(t: ToolCallRecord): string {
    const id = randomUUID();
    const extracted = extractExecFields(t.result);
    this.db
      .prepare(
        `INSERT INTO tool_calls
         (id, request_id, seq, at, name, scope, host, args, ok, result,
          error, duration_ms, approval_id,
          command_preview, exit_code, stdout_preview, stderr_preview, output_truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        t.requestId,
        t.seq,
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
        extracted.command ?? null,
        extracted.exitCode ?? null,
        extracted.stdoutPreview ?? null,
        extracted.stderrPreview ?? null,
        extracted.truncated == null ? null : (extracted.truncated ? 1 : 0),
      );
    emit({
      audit: "tool_call",
      request_id: t.requestId,
      seq: t.seq,
      name: t.name,
      host: t.host,
      scope: t.scope,
      ok: t.ok,
      command: extracted.command,
      exit_code: extracted.exitCode,
      duration_ms: t.durationMs,
      truncated: extracted.truncated,
      error: t.error,
      approval_id: t.approvalId,
    });
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
    emit({
      audit: "approval_requested",
      approval_id: id,
      request_id: a.requestId,
      tool: a.toolName,
      scope: a.scope,
    });
    return id;
  }

  recordApprovalDecision(d: ApprovalDecisionRecord): void {
    this.db
      .prepare(
        `UPDATE approvals SET approved = ?, decided_by = ?, decided_at = ?, reason = ? WHERE id = ?`,
      )
      .run(d.approved ? 1 : 0, d.decidedBy ?? null, new Date().toISOString(), d.reason ?? null, d.approvalId);
    emit({
      audit: "approval_decided",
      approval_id: d.approvalId,
      approved: d.approved,
      decided_by: d.decidedBy,
      reason: d.reason,
    });
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

    // Idempotent additive migrations for v0.4 observability columns.
    this.ensureColumn("tool_calls", "seq", "INTEGER");
    this.ensureColumn("tool_calls", "command_preview", "TEXT");
    this.ensureColumn("tool_calls", "exit_code", "INTEGER");
    this.ensureColumn("tool_calls", "stdout_preview", "TEXT");
    this.ensureColumn("tool_calls", "stderr_preview", "TEXT");
    this.ensureColumn("tool_calls", "output_truncated", "INTEGER");

    this.ensureColumn("requests", "llm_model", "TEXT");
    this.ensureColumn("requests", "input_tokens", "INTEGER");
    this.ensureColumn("requests", "output_tokens", "INTEGER");
    this.ensureColumn("requests", "iterations", "INTEGER");
    this.ensureColumn("requests", "final_stop_reason", "TEXT");

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_command ON tool_calls(command_preview);`);
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

interface ExecFields {
  command?: string;
  exitCode?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  truncated?: boolean;
}

/** Duck-type extract exec-flavored fields from any tool result. */
function extractExecFields(result: unknown): ExecFields {
  if (!result || typeof result !== "object") return {};
  const r = result as Record<string, unknown>;
  const out: ExecFields = {};
  if (typeof r.command === "string") out.command = r.command;
  if (typeof r.exitCode === "number") out.exitCode = r.exitCode;
  if (typeof r.stdout === "string") out.stdoutPreview = truncate(r.stdout, PREVIEW_BYTES);
  if (typeof r.stderr === "string") out.stderrPreview = truncate(r.stderr, PREVIEW_BYTES);
  if (typeof r.truncated === "boolean") out.truncated = r.truncated;
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(truncated, ${s.length - max} more bytes)`;
}

function emit(obj: Record<string, unknown>): void {
  // Drop undefined keys so the log line stays compact.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) clean[k] = v;
  }
  console.log(JSON.stringify(clean));
}
