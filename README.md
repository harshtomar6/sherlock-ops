# sherlock-ops

An AI ops bot that investigates and reports on your servers in plain English.
Ask it *"why does api-server keep restarting?"* in Slack — it inspects PM2,
reads the right logs, and tells you what it found.

> **Status:** MVP. Single-host, Slack-only, PM2-focused. Multi-host agents,
> approvals, and additional interfaces (CLI/Web) are on the roadmap.

## What works today

- **Slack interface** (Socket Mode — no public URL required)
- **PM2 tools:** `pm2_list`, `pm2_describe`, `pm2_logs`
- **Anthropic-powered tool-use loop** — typed tool calls, no free-form shell
- **Append-only audit log** to stdout (structured JSON)
- **User allowlist** via env

## Architecture

```
Slack → Gateway → Orchestrator (LLM tool-use loop) → Tools → Local Executor
                                                        │
                                                        └── pm2_list / describe / logs
```

The core is interface-agnostic — Slack is one adapter; CLI, Web, and REST
adapters slot in without touching the orchestrator. LLM providers are
pluggable behind a small interface (Anthropic ships first).

## Setup

### 1. Create a Slack app

Go to <https://api.slack.com/apps> → **Create New App** → **From manifest**,
then paste:

```yaml
display_information:
  name: Sherlock
  description: AI ops bot for PM2 + logs
features:
  bot_user:
    display_name: Sherlock
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - im:history
      - im:read
      - im:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
```

Install the app to your workspace. From the app config page collect:

- **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`
- **App-Level Token** with `connections:write` scope (`xapp-…`) → `SLACK_APP_TOKEN`
- **Signing Secret** → `SLACK_SIGNING_SECRET`

### 2. Configure env

```bash
cp .env.example .env
# edit .env with your Slack tokens and an LLM API key
```

**LLM provider — pick one:**

| Provider | `LLM_PROVIDER` | Key var | Default model |
|---|---|---|---|
| OpenRouter (recommended) | `openai` | `OPENROUTER_API_KEY` | `anthropic/claude-opus-4` |
| Anthropic direct | `anthropic` | `ANTHROPIC_API_KEY` | `claude-opus-4-7` |
| OpenAI direct | `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| Any OpenAI-compatible (Together, Groq, Ollama, …) | `openai` | `OPENAI_API_KEY` + `OPENAI_BASE_URL` | set `LLM_MODEL` |

The `openai` provider is a generic OpenAI-compatible client — point `OPENAI_BASE_URL`
at any endpoint that speaks the OpenAI chat-completions API. If `OPENROUTER_API_KEY`
is set, the base URL and identification headers are configured for you.

Set `ALLOWED_SLACK_USERS` to a comma-separated list of Slack user IDs
(e.g. `U01ABC,U02DEF`). Leave empty only in trusted environments.

### 3. Install + run

```bash
npm install
npm run dev
```

You should see `sherlock_ops_ready` in the logs.

### 4. Use it

In Slack, DM Sherlock or `@mention` it in any channel it's been invited to:

```
@Sherlock list all pm2 processes
@Sherlock why is api-server restarting? show me the last 200 lines of stderr
@Sherlock which process is using the most memory right now?
```

## Project layout

```
src/
├── adapters/slack.ts        # Slack Bolt app
├── core/
│   ├── gateway.ts           # auth, audit, error handling
│   ├── orchestrator.ts      # LLM tool-use loop
│   ├── registry.ts          # tool registry + JSON schema export
│   └── types.ts             # Request / Response shapes
├── executor/
│   ├── local.ts             # spawn child_process locally
│   └── types.ts             # Executor interface
├── llm/
│   ├── anthropic.ts         # Anthropic provider (with prompt caching)
│   ├── openai.ts            # OpenAI-compatible provider (OpenRouter, OpenAI, Together, Groq, Ollama)
│   └── types.ts             # LLMProvider interface
├── tools/
│   ├── pm2.ts               # pm2_list, pm2_describe, pm2_logs
│   └── types.ts             # Tool interface + defineTool helper
├── config.ts                # env loading
└── index.ts                 # entry: wires everything
```

## Roadmap

- **Phase 1** (current MVP): single-host, Slack-only, PM2 read tools
- **Phase 2:** `sherlock-agent` daemon — central control plane + WSS to multiple hosts
- **Phase 3:** approval flow for mutating ops (`pm2_restart`, `shell_exec`); SQLite audit log
- **Phase 4:** additional adapters (CLI, REST, Web UI)
- **Phase 5:** additional LLM providers (OpenAI, Ollama)
- **Phase 6:** more tool packs — systemd, docker, journalctl, k8s

## License

MIT
