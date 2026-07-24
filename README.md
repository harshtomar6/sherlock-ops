# sherlock-ops

An AI ops bot that investigates and reports on your servers in plain English.
Ask it *"why does api-server keep restarting?"* in Slack — it runs the right
commands, reads the right logs, and tells you what it found.

> **Status:** Phase 3 — approval flow + mutating ops + shell. Multi-host, single Slack workspace, SQLite audit.
> See the [roadmap](#roadmap) for what's next.

## What it does

- **Investigates in plain English.** Ask in Slack, get a focused answer with evidence.
- **Conversational follow-ups.** Each Slack thread is a continuous conversation — prior turns and command results stay in context.
- **Skills, not tool sprawl.** One execution primitive (`shell_exec`); everything else is knowledge. A skill is a markdown playbook that teaches the agent a system (PM2 ships built-in; write your own in minutes). Nothing is enabled by default.
- **Runs shell commands safely.** Skill + per-host allowlists for routine diagnostics; everything else needs human approval.
- **Approval in-thread.** Interactive Approve/Deny buttons in Slack for any non-allowlisted command.
- **Audits everything.** Append-only SQLite log of every request, command, and approval.

## Architecture

```
       Slack ─→ control plane ─wss──→ sherlock-agent (host A) ─→ shell
                     │       └─wss──→ sherlock-agent (host B) ─→ shell
                     ├── skills (markdown playbooks → system prompt)
                     ├── LocalExecutor (control plane itself, optional)
                     ├── LLM (OpenRouter / Anthropic / OpenAI / Ollama)
                     └── SQLite audit
```

Interface-agnostic core, pluggable LLM providers, agent dial-out over WSS
(no inbound ports on target hosts).

### Control-plane as a target (multi-host)

By default the control plane only orchestrates remote agents. To let it also
run commands on itself, add a `controlPlane` block to `hosts.json`:

```json
{
  "controlPlane": {
    "id": "control-plane",
    "shellAllowlist": ["df -h", "uptime", "systemctl status sherlock-ops"]
  },
  "hosts": [ { "id": "api-prod-1", "token": "..." } ]
}
```

The reserved id (`control-plane` by default) shows up as a selectable host.
Commands targeted at it run via the local executor — no agent process
needed. Non-allowlisted commands still require Slack approval.

## Quick start (single host)

For trying it on one machine.

```bash
git clone https://github.com/your-fork/sherlock-ops.git
cd sherlock-ops
npm ci
cp .env.example .env
# edit .env: Slack tokens (xoxb / xapp / signing) + an LLM key (e.g. OPENROUTER_API_KEY)
cp sherlock-config.example.json sherlock-config.json   # enables the pm2, audit + skill-author skills
npm run dev
```

In Slack:

```
@Sherlock list pm2 processes
@Sherlock why is api-server restarting? show me the last 200 lines of stderr
@Sherlock restart api-server      # triggers an Approve/Deny prompt
```

## Install on a server (one command)

For a real Linux server with systemd, one command does everything — Node,
clone, build, guided `.env` setup, skills, service user, systemd unit:

```bash
# control plane
curl -fsSL https://raw.githubusercontent.com/harshtomar6/sherlock-ops/main/install.sh | sudo bash

# agent, on each target host (multi-host mode)
curl -fsSL https://raw.githubusercontent.com/harshtomar6/sherlock-ops/main/install.sh | sudo bash -s -- --role agent
```

It prompts for your Slack tokens and LLM key; re-running the same command
upgrades in place without touching your config. It also offers self-upgrade
(default off): opt in and you can later just ask the bot —
"@Sherlock upgrade yourself" — instead of re-running the installer.
Unattended installs, flags, and the manual path are covered in
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Skills

Sherlock has exactly one tool: `shell_exec`. Everything it knows about
specific systems comes from **skills** — markdown playbooks that teach the
agent which commands to run, how to read the output, and what needs
approval. No skills are enabled by default.

### Enabling skills

Drop a `sherlock-config.json` next to your `hosts.json`:

```json
{
  "skills": ["pm2"]
}
```

Each name resolves to `<skills dir>/<name>.md` first (so you can override a
built-in), then to a bundled skill. A name that resolves to neither fails at
boot. The startup log surfaces `skills` and `skillAllow` so the live
configuration is always visible.

Built-in skills (see `src/skills/builtin/`):

- `pm2` — investigate and manage PM2-supervised processes.
- `audit` — answers questions about the bot's own history ("what did you run yesterday?", "who approved that restart?", "how many tokens this week?") by querying the SQLite audit log through `node dist/audit/query.js` — a read-only-by-construction CLI (single SELECT/WITH statement, no ATTACH, row-capped), which is why it can be allowlisted where the raw `sqlite3` CLI never could (its dot-commands execute arbitrary programs).
- `upgrade` — lets you ask the bot to upgrade itself ("@Sherlock upgrade yourself"). It checks the installed version (`BUILD_INFO`) against the remote, then — behind the usual Approve/Deny prompt — runs `deploy/upgrade.sh` via sudo, which rebuilds and restarts the service in a detached systemd unit. Requires opting into self-upgrade during install (that's what creates the restricted sudoers rule).
- `skill-author` — lets the bot write new skills for itself. Describe a recurring workflow in Slack ("when the queue backs up, we always check…"), and Sherlock drafts a skill, shows you the full markdown for confirmation, then saves it through `node dist/skills/cli.js write` — an approval-gated call whose validation rejects `allow` entries that would bypass the approval flow (interpreters, file mutators, `sudo`, non-read-only `systemctl`, …). Skills reload on every request, so the new skill is active from the next message — no restart.

### Writing a skill

Put a markdown file in `./sherlock-skills/` (override the directory via
`SHERLOCK_SKILLS_DIR`) and list its name in the config:

```markdown
---
description: Diagnose the Redis server on a host.
allow:
  - redis-cli PING
  - redis-cli INFO
---

Use `redis-cli` for all diagnostics.

- `redis-cli PING` — expect `PONG`; anything else means Redis is down.
- `redis-cli INFO memory` — check `used_memory_human` vs `maxmemory_human`.

Mutations like `redis-cli CONFIG SET` or `systemctl restart redis-server`
require approval — state your rationale before running them.
```

- **Body → system prompt.** The markdown body is appended to the system
  prompt as a `## Skill: <name>` section. Write it for the agent: commands,
  output fields that matter, investigation workflows, footguns.
- **`allow` → no approval.** Command prefixes listed under `allow` are
  treated as safe reads on every host (same prefix matcher as the per-host
  `shellAllowlist`). List only read-only commands here — anything not
  allowlisted goes through Slack Approve/Deny, which is exactly what you
  want for mutations.

See `sherlock-skills.example/redis.md` for a fuller example.

### System prompt

Point `SHERLOCK_SYSTEM_PROMPT_FILE` at any markdown file:

```bash
SHERLOCK_SYSTEM_PROMPT_FILE=./prompts/my-ops.md npm run dev
```

A missing file fails at boot — Sherlock never silently falls back to the
default after an operator asked for a specific prompt. The bundled default
lives at `src/prompts/default.md` and is a good starting point to copy.
Skill sections are appended to whichever base prompt is active.

## Deploying it for real

For multi-host fleets, TLS, systemd, Docker, secret management, audit retention,
and the hardening checklist — see **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**.

## Execution model

| | |
|---|---|
| `shell_exec` | The only tool. Runs argv-style commands via `spawn` (`shell: false` — no shell expansion). Optional `stdin` pipes text to the command. |
| Allowlists | Skill `allow` entries (all hosts) + per-host `shellAllowlist` are prefix-matched against the command. A match runs without approval. |
| Approval | Any non-allowlisted command triggers Slack Approve/Deny before it runs. |
| Skills | Markdown playbooks appended to the system prompt; they steer *what* the agent runs, allowlists control *whether it needs a human*. |

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
├── skills/
│   ├── builtin/pm2.md       # built-in PM2 skill
│   └── loader.ts            # skill loading + system-prompt composition
├── tools/
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
- **Phase 5:** more built-in skills — systemd, docker, journalctl, k8s
- **Phase 6:** approval policies (auto-approve for trusted users on specific commands)

## License

MIT
