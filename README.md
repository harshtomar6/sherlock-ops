# sherlock-ops

An AI ops bot that investigates and reports on your servers in plain English.
Ask it *"why does api-server keep restarting?"* in Slack — it inspects PM2,
reads the right logs, and tells you what it found.

> **Status:** Phase 3 — approval flow + mutating ops + shell. Multi-host, single Slack workspace, SQLite audit.
> See the [roadmap](#roadmap) for what's next.

## What it does

- **Investigates in plain English.** Ask in Slack, get a focused answer with evidence.
- **Manages PM2 across a fleet.** List, describe, tail logs, restart, stop, start, reload, delete.
- **Runs shell commands safely.** Per-host allowlist for routine diagnostics; everything else needs human approval.
- **Approval in-thread.** Interactive Approve/Deny buttons in Slack for any mutating or non-allowlisted call.
- **Audits everything.** Append-only SQLite log of every request, tool call, and approval.

## Architecture

```
       Slack ─→ control plane ─wss──→ sherlock-agent (host A) ─→ pm2 + shell
                     │       └─wss──→ sherlock-agent (host B) ─→ pm2 + shell
                     ├── LLM (OpenRouter / Anthropic / OpenAI / Ollama)
                     └── SQLite audit
```

Interface-agnostic core, pluggable LLM providers, agent dial-out over WSS
(no inbound ports on target hosts).

## Quick start (single host)

For trying it on one machine.

```bash
git clone https://github.com/your-fork/sherlock-ops.git
cd sherlock-ops
npm ci
cp .env.example .env
# edit .env: Slack tokens (xoxb / xapp / signing) + an LLM key (e.g. OPENROUTER_API_KEY)
npm run dev
```

In Slack:

```
@Sherlock list pm2 processes
@Sherlock why is api-server restarting? show me the last 200 lines of stderr
@Sherlock restart api-server      # triggers an Approve/Deny prompt
```

## Deploying it for real

For multi-host fleets, TLS, systemd, Docker, secret management, audit retention,
and the hardening checklist — see **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**.

## Tools reference

| Tool | Scope | Notes |
|---|---|---|
| `pm2_list` | read | Status, restarts, uptime, CPU, memory per process |
| `pm2_describe` | read | Log paths, exit code, env, restart history |
| `pm2_logs` | read | Tail stdout/stderr/both, up to 2000 lines |
| `pm2_restart` | mutate | Approval required |
| `pm2_stop` | mutate | Approval required |
| `pm2_start` | mutate | Approval required |
| `pm2_reload` | mutate | Zero-downtime reload; approval required |
| `pm2_delete` | dangerous | Removes process entry; approval required |
| `shell_exec` | dynamic | Allowlisted command → no approval. Anything else → approval. |

## Project layout

```
src/
├── adapters/
│   ├── slack.ts             # Slack Bolt app + approval action handler
│   └── slackApproval.ts     # SlackApprovalBroker — interactive Approve/Deny
├── agent/index.ts           # sherlock-agent daemon (runs on each target host)
├── audit/store.ts           # SQLite append-only audit log
├── controlplane/
│   └── agentHub.ts          # WSS server + agent registry + RPC dispatch
├── core/
│   ├── approval.ts          # ApprovalBroker interface + DenyAllBroker
│   ├── gateway.ts           # auth, audit, error handling
│   ├── orchestrator.ts      # LLM tool-use loop + scope/approval enforcement
│   ├── registry.ts          # tool registry + JSON schema export
│   └── types.ts             # Request / Response shapes
├── executor/
│   ├── hostResolver.ts      # resolves Executor + allowlist for a host id
│   ├── local.ts             # spawn child_process locally
│   ├── remote.ts            # dispatch exec via AgentHub
│   └── types.ts             # Executor interface
├── llm/
│   ├── anthropic.ts         # Anthropic provider (with prompt caching)
│   ├── openai.ts            # OpenAI-compatible (OpenRouter / OpenAI / Together / Groq / Ollama)
│   └── types.ts             # LLMProvider interface
├── proto/
│   └── types.ts             # agent ↔ control-plane wire format
├── tools/
│   ├── pm2.ts               # PM2 read + mutating tools
│   ├── shell.ts             # shell_exec + tokenizer + allowlist matcher
│   └── types.ts             # Tool interface + defineTool + dynamic scope
├── config.ts                # env + hosts.json loading
└── index.ts                 # control plane entry

deploy/
├── systemd/                 # sherlock-ops + sherlock-agent unit files
├── caddy/Caddyfile.example  # TLS proxy
└── nginx/sherlock.conf.example
```

## Roadmap

- ✅ **Phase 1:** single-host, Slack-only, PM2 read tools
- ✅ **Phase 2:** multi-host with `sherlock-agent`; provider-agnostic LLM
- ✅ **Phase 3:** approval flow; `shell_exec` with per-host allowlist; SQLite audit
- **Phase 4:** additional adapters (CLI, REST, Web UI)
- **Phase 5:** more tool packs — systemd, docker, journalctl, k8s
- **Phase 6:** approval policies (auto-approve for trusted users on specific tools)

## License

MIT
