/**
 * Read-only audit query CLI — the safe path for the bot to answer questions
 * about its own history (audit skill).
 *
 *   node dist/audit/query.js            (SQL on stdin)
 *   node dist/audit/query.js "SELECT …" (or as a single argument)
 *
 * Safe to allowlist, unlike the sqlite3 CLI (whose dot-commands like .shell
 * execute arbitrary programs): the connection is opened read-only so no SQL
 * can write, only a single statement is accepted, ATTACH is rejected so
 * queries can't reach into other database files, and output is row-capped.
 * Reads SHERLOCK_AUDIT_DB like the control plane (default ./sherlock-audit.sqlite).
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_ROWS = 200;

function main(): void {
  const sql = (process.argv[2] ?? readFileSync(0, "utf8")).trim();
  if (!sql) throw new Error("no SQL given (pass as argument or on stdin)");
  if (/\battach\b/i.test(sql)) {
    throw new Error("ATTACH is not allowed — query the audit database only");
  }

  const path = resolve(process.cwd(), process.env.SHERLOCK_AUDIT_DB ?? "sherlock-audit.sqlite");
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    throw new Error(`audit database not found or unreadable at ${path}`);
  }

  try {
    const stmt = db.prepare(sql); // throws on multiple statements
    if (!stmt.reader) {
      throw new Error("only read queries are allowed (SELECT / WITH)");
    }
    const all = stmt.all() as Record<string, unknown>[];
    const rows = all.slice(0, MAX_ROWS);
    console.log(JSON.stringify({
      rowCount: rows.length,
      truncated: all.length > rows.length ? `showing first ${MAX_ROWS} of ${all.length}+ rows — add a LIMIT` : undefined,
      rows,
    }, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
