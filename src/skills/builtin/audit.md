---
description: Answer questions about your own history — what was asked, what ran, who approved what — from the audit log.
allow:
  - node dist/audit/query.js
---

Everything you do is recorded in an append-only SQLite audit log. When a user asks "what did you run", "who approved that restart", "what happened yesterday", or wants usage stats, query it instead of relying on memory.

Run queries on the control-plane host, passing the SQL as the command's stdin:

```
command: node dist/audit/query.js
stdin:   SELECT at, name, host, command_preview, ok FROM tool_calls ORDER BY at DESC LIMIT 20
```

Output is JSON `{rowCount, rows}`. One statement per call, SELECT/WITH only, capped at 200 rows — always add a LIMIT and select specific columns (avoid `SELECT *`: the `args`/`result` columns hold large JSON blobs).

## Schema

- **requests** — one row per user message. `at`, `completed_at`, `user` (e.g. `slack:U0…`), `conversation_id`, `text` (what they asked), `response_text`, `error`, `duration_ms`, `llm_model`, `input_tokens`, `output_tokens`, `iterations`.
- **tool_calls** — every command executed (or denied). `at`, `request_id` → requests.id, `seq`, `name` (tool), `scope` (read/mutate/dangerous), `host`, `command_preview`, `exit_code`, `stdout_preview` / `stderr_preview` (truncated at 4 KB), `ok` (0/1), `error`, `duration_ms`, `approval_id`.
- **approvals** — every approval request. `requested_at`, `decided_at`, `request_id`, `tool_name`, `scope`, `args` (JSON), `approved` (1 approved / 0 denied / NULL never decided), `decided_by`, `reason`.
- **conversation_turns** — raw conversation history (internal; rarely useful for questions).

All timestamps are ISO-8601 UTC strings — comparisons like `at > datetime('now', '-1 day')` work.

## Recipes

- Recent activity: `SELECT at, command_preview, host, ok FROM tool_calls WHERE name='shell_exec' ORDER BY at DESC LIMIT 20`
- Who approved/denied what: `SELECT requested_at, tool_name, approved, decided_by, reason FROM approvals ORDER BY requested_at DESC LIMIT 20`
- What ran under an approval: join `tool_calls.approval_id = approvals.id`
- A request end-to-end: find it in `requests`, then `SELECT seq, command_preview, ok, error FROM tool_calls WHERE request_id=? ORDER BY seq`
- Usage/cost: `SELECT date(at) d, count(*), sum(input_tokens), sum(output_tokens) FROM requests GROUP BY d ORDER BY d DESC LIMIT 14`
- Failures: `WHERE ok=0` on tool_calls, or `error IS NOT NULL` on requests

Answer from the rows you got — cite timestamps, users, and commands. If the data doesn't cover the question (e.g. pruned history), say so rather than guessing.
