import Database from "better-sqlite3";
import type { ProviderMessage } from "../llm/types.js";

export interface ConversationStoreOpts {
  dbPath: string;
  /** Max number of distinct request_ids (Slack exchanges) to load. Default 10. */
  maxExchanges?: number;
  /** Drop history older than this when loading. Default 24h. */
  ttlHours?: number;
}

/**
 * Per-thread conversation history. Keyed by Request.conversationId
 * (e.g. "slack:<channel>:<threadTs>"). Backed by SQLite — uses the same DB
 * file as the audit store, but a separate connection (better-sqlite3 + WAL
 * mode handles multi-connection writes safely).
 *
 * Stores the raw ProviderMessage stream so we keep tool_calls and
 * tool_results — not just the user-visible text. On reload the LLM sees the
 * full context of prior investigations.
 */
export class ConversationStore {
  private db: Database.Database;
  private maxExchanges: number;
  private ttlHours: number;

  constructor(opts: ConversationStoreOpts) {
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.maxExchanges = opts.maxExchanges ?? 10;
    this.ttlHours = opts.ttlHours ?? 24;
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Returns ProviderMessages for the most recent N exchanges within the TTL,
   * in chronological order. An "exchange" is one Slack-user turn and all the
   * tool round-trips it spawned (shared request_id).
   */
  load(conversationId: string): ProviderMessage[] {
    const rows = this.db
      .prepare(
        `WITH recent_req AS (
           SELECT request_id, MAX(at) AS last_at
           FROM conversation_turns
           WHERE conversation_id = @cid
             AND at > datetime('now', @ttl)
           GROUP BY request_id
           ORDER BY last_at DESC
           LIMIT @lim
         )
         SELECT t.role, t.content
         FROM conversation_turns t
         INNER JOIN recent_req r ON t.request_id = r.request_id
         WHERE t.conversation_id = @cid
         ORDER BY t.id ASC`,
      )
      .all({
        cid: conversationId,
        ttl: `-${this.ttlHours} hours`,
        lim: this.maxExchanges,
      }) as { role: string; content: string }[];

    return rows.map((r) => ({
      role: r.role as "user" | "assistant",
      content: JSON.parse(r.content),
    })) as ProviderMessage[];
  }

  save(conversationId: string, requestId: string, messages: ProviderMessage[]): void {
    if (messages.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO conversation_turns (conversation_id, request_id, at, role, content)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction((msgs: ProviderMessage[]) => {
      for (const m of msgs) {
        insert.run(conversationId, requestId, now, m.role, JSON.stringify(m.content));
      }
    });
    tx(messages);
  }

  /**
   * Drop turns older than 4× the load TTL — gives a safety margin so a
   * conversation can be picked back up just outside the window. Returns
   * the number of rows deleted. Safe to call periodically.
   */
  prune(): number {
    const r = this.db
      .prepare(`DELETE FROM conversation_turns WHERE at < datetime('now', ?)`)
      .run(`-${this.ttlHours * 4} hours`);
    return r.changes;
  }

  /** Clear all history for one conversation. Returns rows deleted. */
  forget(conversationId: string): number {
    const r = this.db
      .prepare(`DELETE FROM conversation_turns WHERE conversation_id = ?`)
      .run(conversationId);
    return r.changes;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        at TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_convo_lookup ON conversation_turns(conversation_id, at);
      CREATE INDEX IF NOT EXISTS idx_convo_request ON conversation_turns(request_id);
    `);
  }
}
