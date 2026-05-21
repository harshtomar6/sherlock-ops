# Self-hosting sherlock-ops

This guide walks you through deploying sherlock-ops for real use — from a
single-machine setup you can run in 5 minutes to a multi-host production
deployment with TLS, systemd, and a hardened audit trail.

If you just want to kick the tires locally, the [README](../README.md) quick
start is enough. Come here when you're ready to put it in front of a team.

## Contents

1. [Architecture refresher](#architecture-refresher)
2. [Choosing a deployment mode](#choosing-a-deployment-mode)
3. [Prerequisites](#prerequisites)
4. [Slack app setup](#slack-app-setup)
5. [LLM provider setup](#llm-provider-setup)
6. [Single-host deployment](#single-host-deployment)
7. [Multi-host: control plane](#multi-host-control-plane)
8. [Multi-host: deploying agents](#multi-host-deploying-agents)
9. [TLS for the agent endpoint](#tls-for-the-agent-endpoint)
10. [Docker deployment](#docker-deployment)
11. [Secret & token management](#secret--token-management)
12. [Audit log: retention, backups, queries](#audit-log-retention-backups-queries)
13. [Day-2 operations](#day-2-operations)
14. [Hardening checklist](#hardening-checklist)
15. [Troubleshooting](#troubleshooting)

---

## Architecture refresher

```
            ┌──────────────────────────────────────────────┐
            │             Slack workspace                  │
            └──────────────────┬───────────────────────────┘
                               │ Socket Mode (xapp- token, outbound only)
                               ▼
            ┌──────────────────────────────────────────────┐
            │           sherlock-ops control plane         │
            │  Slack adapter · orchestrator · audit · hub  │
            │  (one process, one host, one Slack workspace)│
            └──────────┬───────────────────────────────────┘
                       │ WSS / JSON-RPC (agents dial out)
                       │
       ┌───────────────┼──────────────────┬────────────────┐
       ▼               ▼                  ▼                ▼
  sherlock-agent  sherlock-agent    sherlock-agent   sherlock-agent
  (host: api-1)   (host: api-2)     (host: db-1)     (host: worker-1)
       │               │                  │                │
  pm2 + shell      pm2 + shell        pm2 + shell      pm2 + shell
```

Key properties:

- **Control plane** holds state (audit DB, host registry, Slack connection). One per Slack workspace.
- **Agents** are stateless workers — they hold a PSK, run commands, return results. Restart-safe.
- **Agents dial *out*** to the control plane. No inbound ports on target hosts.
- **No public Slack endpoint required** — Socket Mode is outbound only.

## Choosing a deployment mode

| Mode | When to pick | Hosts managed | Setup time |
|---|---|---|---|
| **Single-host** | sherlock-ops runs on the same box as PM2 | 1 (itself) | ~5 min |
| **Multi-host** | Fleet of PM2 servers, one team chatting with the bot | N | ~30 min |
| **Multi-host + Docker** | You already containerize your tooling | N | ~30 min |

Single-host is fine for a homelab, a hobby project, or one prod server. Once
you have more than one server, move to multi-host — it's the same code,
just with `hosts.json` present and an agent on each target.

## Prerequisites

**Control plane host** (where sherlock-ops itself runs):

- Linux or macOS (anything that runs Node 20+)
- Node.js ≥ 20 (Node 22 LTS recommended)
- ~100 MB disk for code + node_modules
- ~10 MB/month for the audit SQLite (depends on activity)
- Outbound HTTPS to Slack and your LLM provider
- An inbound TCP port reachable by agents (default `8787`), or a TLS reverse proxy

**Each target host** (where PM2 runs):

- Linux or macOS
- Node.js ≥ 20
- PM2 installed (`npm i -g pm2`)
- Outbound TCP to the control plane

**Accounts:**

- A Slack workspace where you can create an app (admin or app-installation rights)
- An API key for your LLM provider (OpenRouter, Anthropic, OpenAI, or a self-hosted Ollama instance)

## Slack app setup

1. Go to <https://api.slack.com/apps> → **Create New App** → **From manifest**.
2. Paste:

   ```yaml
   display_information:
     name: Sherlock
     description: AI ops bot for PM2, logs, and shell
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

3. Install the app to your workspace.
4. From the app config, collect three secrets:
   - **Bot User OAuth Token** (starts `xoxb-…`) → `SLACK_BOT_TOKEN`
   - **App-Level Token** (starts `xapp-…`) with the `connections:write` scope → `SLACK_APP_TOKEN`
   - **Signing Secret** → `SLACK_SIGNING_SECRET`
5. Invite the bot to whatever channels you want it accessible in (`/invite @Sherlock`).

## LLM provider setup

Pick one. Recommended: **OpenRouter** — works with Claude, GPT, Llama, and many others through one API.

| Provider | `LLM_PROVIDER` | Key var | Default model |
|---|---|---|---|
| OpenRouter | `openai` | `OPENROUTER_API_KEY` | `anthropic/claude-opus-4` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-opus-4-7` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| Self-hosted Ollama | `openai` | `OPENAI_API_KEY=ollama` (any string) + `OPENAI_BASE_URL=http://localhost:11434/v1` | set `LLM_MODEL` |
| Together / Groq / etc. | `openai` | `OPENAI_API_KEY` + `OPENAI_BASE_URL` | set `LLM_MODEL` |

Tool-use quality varies a lot across models. Claude (Opus or Sonnet) and
GPT-4-class models are the most reliable. Smaller models tend to struggle
with multi-step investigations.

## Single-host deployment

For one server. The control plane runs on the same machine as PM2.

```bash
git clone https://github.com/your-fork/sherlock-ops.git /opt/sherlock-ops
cd /opt/sherlock-ops
npm ci
npm run build

cp .env.example .env
# fill in Slack tokens and LLM provider key
# Optionally: LOCAL_SHELL_ALLOWLIST=df -h,free -m,uptime,journalctl
```

Run it under a process manager so it restarts on crash. The simplest option
is the one you already have:

```bash
# managed by pm2 itself (meta)
pm2 start dist/index.js --name sherlock-ops --update-env
pm2 save
pm2 startup    # follow the printed instructions to enable on boot
```

Or use systemd — see [deploy/systemd/sherlock-ops.service](../deploy/systemd/sherlock-ops.service).

## Multi-host: control plane

1. Pick a host for the control plane. It needs:
   - Outbound HTTPS (Slack, LLM provider)
   - Either an inbound TCP port reachable by all agents, or a TLS reverse proxy in front of it (recommended)

2. Install:

   ```bash
   git clone https://github.com/your-fork/sherlock-ops.git /opt/sherlock-ops
   cd /opt/sherlock-ops
   npm ci
   npm run build
   cp .env.example .env       # Slack tokens, LLM key, ALLOWED_SLACK_USERS
   ```

3. Generate per-host PSK tokens and create `hosts.json`:

   ```bash
   # Generate a token for each host
   openssl rand -hex 32     # token for api-prod-1
   openssl rand -hex 32     # token for api-prod-2
   ```

   ```jsonc
   // /opt/sherlock-ops/hosts.json
   {
     "port": 8787,
     "path": "/agent",
     "hosts": [
       {
         "id": "api-prod-1",
         "token": "<paste first openssl output>",
         "shellAllowlist": [
           "df -h", "free -m", "uptime", "top -bn1",
           "journalctl -u nginx", "ps aux"
         ]
       },
       {
         "id": "api-prod-2",
         "token": "<paste second openssl output>",
         "shellAllowlist": ["df -h", "free -m", "uptime"]
       }
     ]
   }
   ```

   Lock the file down: `chmod 600 hosts.json && chown sherlock:sherlock hosts.json`.

4. Install the systemd unit using the install script (handles user
   creation, file perms, node path detection, and state directory):

   ```bash
   sudo bash deploy/install-control-plane.sh
   ```

   The script is idempotent — re-run it after any config change.

   If you'd rather do it by hand:

   ```bash
   # 1. Create the service user
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin sherlock

   # 2. Lock down secrets
   sudo chown -R sherlock:sherlock /opt/sherlock-ops/{dist,node_modules,.env}
   sudo chmod 600 /opt/sherlock-ops/.env /opt/sherlock-ops/hosts.json

   # 3. Verify Node is at /usr/bin/node (otherwise edit ExecStart in the unit)
   which node

   # 4. Install + start
   sudo cp deploy/systemd/sherlock-ops.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now sherlock-ops
   ```

   The unit uses `StateDirectory=sherlock-ops`, so systemd auto-creates
   `/var/lib/sherlock-ops` with correct ownership. No manual mkdir needed.

5. Verify the hub is listening:

   ```bash
   ss -tlnp | grep 8787
   journalctl -u sherlock-ops -f
   # look for: {"event":"sherlock_ops_ready","mode":"multi_host",...}
   ```

## Multi-host: deploying agents

On each target host:

```bash
git clone https://github.com/your-fork/sherlock-ops.git /opt/sherlock-agent
cd /opt/sherlock-agent
npm ci
npm run build

cp .env.agent.example .env
# edit:
#   SHERLOCK_CONTROL_URL=wss://sherlock.example.com/agent
#   SHERLOCK_HOST_ID=api-prod-1
#   SHERLOCK_AGENT_TOKEN=<the token for this host from the control plane's hosts.json>
chmod 600 .env
```

Install the systemd unit:

```bash
# Set SERVICE_USER to whoever owns the PM2 daemon you want to manage
# (e.g. SERVICE_USER=deploy bash deploy/install-agent.sh). The script auto-detects
# from ~/.pm2 ownership if you don't set it.
sudo bash deploy/install-agent.sh

sudo journalctl -u sherlock-agent -f
# look for: {"component":"sherlock_agent","event":"welcomed",...}
```

On the control plane side you should now see:

```json
{"component":"agent_hub","event":"agent_connected","hostId":"api-prod-1",...}
```

Repeat for each target host with its own `SHERLOCK_HOST_ID` and matching token.

## TLS for the agent endpoint

The control plane's WSS endpoint should be behind TLS in production. Terminate
TLS at a reverse proxy — don't put it in the app.

Example with Caddy (`deploy/caddy/Caddyfile.example`):

```caddy
sherlock.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

That's it. Caddy auto-provisions a Let's Encrypt cert. Agents then dial
`wss://sherlock.example.com/agent`.

Equivalent nginx (relevant block only):

```nginx
location /agent {
    proxy_pass http://127.0.0.1:8787/agent;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;
}
```

Firewall: only the proxy's HTTPS port (443) needs to be open to the world.
Port `8787` can be `127.0.0.1`-only.

## Docker deployment

A multi-stage `Dockerfile` and an example `docker-compose.example.yml` are
included for containerizing the **control plane**. Agents typically stay on
bare metal because they need to talk to the host's PM2.

```bash
cp docker-compose.example.yml docker-compose.yml
# edit env_file paths and the published port if your proxy needs it

docker compose build
docker compose up -d
docker compose logs -f sherlock-ops
```

The compose file mounts `./hosts.json` and `./.env` into the container and
persists the audit DB on a named volume.

## Secret & token management

- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, LLM key → put in `.env` (mode `0600`) or your secret manager. Never commit.
- Per-host PSK tokens (`hosts.json`) → 32 bytes from `openssl rand -hex 32`. Mode `0600`. Rotate quarterly or after personnel changes.
- Slack `SLACK_APP_TOKEN` is the most painful to rotate (you create a new one in the app config and update env). Worth it on a regular cadence.

**Rotating a host token:**

1. Generate a new token: `openssl rand -hex 32`.
2. Update the host's entry in `hosts.json`.
3. Restart the control plane: `systemctl restart sherlock-ops`.
4. Update `SHERLOCK_AGENT_TOKEN` in the agent's `.env`.
5. Restart the agent: `systemctl restart sherlock-agent`.

The agent will be rejected with the old token (good — confirms rotation
worked). It will reconnect cleanly once both sides have the new token.

## Audit log: retention, backups, queries

The audit DB defaults to `./sherlock-audit.sqlite` next to the control plane.
Override with `SHERLOCK_AUDIT_DB=/var/lib/sherlock-ops/audit.sqlite`.

**Useful queries:**

```sql
-- Recent activity
SELECT at, name, scope, host, ok, duration_ms
FROM tool_calls ORDER BY at DESC LIMIT 50;

-- Who has approved what
SELECT a.decided_at, a.tool_name, a.scope, a.decided_by, a.approved
FROM approvals a
WHERE a.decided_at IS NOT NULL
ORDER BY a.decided_at DESC;

-- Top users by request count
SELECT user, COUNT(*) AS n
FROM requests GROUP BY user ORDER BY n DESC;

-- Failed commands in the last 24h
SELECT at, name, host, error
FROM tool_calls
WHERE ok = 0 AND at > datetime('now', '-1 day')
ORDER BY at DESC;
```

**Backups:** SQLite is one file. Snapshot it with the SQLite backup API,
not `cp` (the file is open and being written). Example daily backup:

```bash
sqlite3 /var/lib/sherlock-ops/audit.sqlite ".backup /backups/audit-$(date +%F).sqlite"
gzip /backups/audit-$(date +%F).sqlite
find /backups -name "audit-*.sqlite.gz" -mtime +30 -delete
```

**Retention:** sherlock-ops does not auto-prune. For long-running deployments,
periodically drop old rows:

```sql
DELETE FROM tool_calls WHERE at < datetime('now', '-180 days');
DELETE FROM approvals WHERE requested_at < datetime('now', '-180 days');
DELETE FROM requests WHERE at < datetime('now', '-180 days');
VACUUM;
```

Wrap that in a cron job.

## Day-2 operations

### Adding a host

1. `openssl rand -hex 32` → new PSK.
2. Add the host entry to `hosts.json`.
3. `systemctl restart sherlock-ops` (control plane reads `hosts.json` at startup).
4. Provision the agent on the new host (same steps as initial deployment).

> Hot-reload of `hosts.json` is not yet supported. A restart is required.
> If this is painful, file an issue — it's a planned improvement.

### Removing a host

1. Stop and uninstall the agent on the target host.
2. Remove its entry from `hosts.json`.
3. `systemctl restart sherlock-ops`.

### Updating sherlock-ops

```bash
cd /opt/sherlock-ops
git pull
npm ci
npm run build
systemctl restart sherlock-ops

# on each target host:
cd /opt/sherlock-agent
git pull
npm ci
npm run build
systemctl restart sherlock-agent
```

Agents auto-reconnect; in-flight tool calls during the restart will fail —
the LLM sees the error and either retries or reports it.

### Observability

- Control plane structured logs: `journalctl -u sherlock-ops -f`
- Agent structured logs: `journalctl -u sherlock-agent -f` (per host)
- Audit DB: queryable any time with `sqlite3`
- Slack: every action is visible in-thread; approvals show who decided

## Hardening checklist

Run through this before going to production.

**Network**
- [ ] Control plane is not directly internet-exposed; TLS proxy in front of the WSS endpoint
- [ ] Port 8787 (default hub port) is bound to `127.0.0.1` if a proxy is used
- [ ] Agents reach the control plane over WSS, not plain WS

**Identity & auth**
- [ ] `ALLOWED_SLACK_USERS` is set to a specific list — not empty
- [ ] Per-host PSK tokens are 32+ random bytes; rotated on a schedule
- [ ] `.env` and `hosts.json` are mode `0600`, owned by the service user
- [ ] Slack signing secret matches the app (mismatched secret rejects all events)

**Authorization**
- [ ] `shellAllowlist` on each host is genuinely minimal — only what's needed
- [ ] No `rm`, `dd`, `mkfs`, `chmod`, `chown`, `mv`, `cp`, `tee`, `sh`, `bash`, `python`, `node` (and similar) on any allowlist
- [ ] Mutating tools (`pm2_*`) gated by approval — verify in audit
- [ ] At least two reviewers know how to read the audit log

**Operational**
- [ ] systemd (or equivalent) restarts the control plane and agents on failure
- [ ] Audit DB backed up daily
- [ ] Audit retention policy in place
- [ ] Disk monitoring for the control plane host (the audit DB grows)
- [ ] Tested: revoke a Slack user, confirm they can no longer invoke
- [ ] Tested: rotate a host token, confirm old token is rejected

## Troubleshooting

### `invalid x-api-key` or similar 401 from LLM provider

Your LLM key is wrong, expired, or pointed at the wrong base URL. Confirm:

```bash
# OpenRouter
curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  https://openrouter.ai/api/v1/models | head -c 200

# Anthropic
curl -s -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  https://api.anthropic.com/v1/models | head -c 200
```

### Slack bot doesn't respond

1. Is the control plane running? `systemctl status sherlock-ops`
2. Did you invite the bot to the channel? `/invite @Sherlock`
3. Is the bot using Socket Mode? Check the app config — `socket_mode_enabled: true`
4. Is your user in `ALLOWED_SLACK_USERS`?
5. Logs: `journalctl -u sherlock-ops -f` — look for `audit` events on incoming requests

### Agent stuck in reconnect loop

```
{"event":"reconnect_scheduled","inMs":2000}
```

Common causes:

- **`rejected` with reason `auth failed`** — token in agent `.env` doesn't match `hosts.json` on the control plane. Fix and the agent re-auths on next attempt.
- **`rejected` with reason `protocol version mismatch`** — agent and control plane are different versions. Update both.
- **Connection refused** — control plane is down, port is firewalled, or the proxy isn't forwarding `/agent`.
- **Hello timeout (4001)** — the agent connected but didn't send hello in 5s. Network is slow or something is buffering — check the proxy config.

### Approvals never resolve

Approve/Deny buttons send block actions over Socket Mode — no public URL
needed. If clicks have no effect:

1. App manifest has `interactivity.is_enabled: true`? (yes by default in the manifest above)
2. App reinstalled after manifest changes? (Slack requires this when scopes change)
3. Control plane logs show the action event? (`audit` entry should appear)

### systemd: `Failed at step NAMESPACE` or `status=226/NAMESPACE`

The unit's `User=`, `WorkingDirectory=`, or a sandboxed path doesn't exist
yet. Common causes:

```
Failed to set up mount namespacing: /var/lib/sherlock-ops: No such file or directory
```

→ You're on an older copy of the unit that used `ReadWritePaths=`. The current
unit uses `StateDirectory=sherlock-ops` which auto-creates the path. Pull the
latest, then:

```bash
sudo cp deploy/systemd/sherlock-ops.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart sherlock-ops
```

```
Failed to determine user credentials: User sherlock not found
```

→ The service user doesn't exist. Run the install script
(`sudo bash deploy/install-control-plane.sh`) or create the user manually
(`sudo useradd --system --no-create-home --shell /usr/sbin/nologin sherlock`).

```
Failed at step EXEC spawning /usr/bin/node: No such file or directory
```

→ Node isn't at `/usr/bin/node`. Find it with `which node` and edit
`ExecStart=` in `/etc/systemd/system/sherlock-ops.service` (or re-run the
install script, which detects the right path).

### `pm2_list failed` but `pm2 ls` works on the host

Sherlock runs `pm2 jlist`, not `pm2 ls`. Check:

```bash
pm2 jlist | head -c 200
```

If you see permission errors, the agent (or the user running the control plane
in single-host mode) is running as a different user than the one that owns
the PM2 daemon. Either:

- Run the agent as the same user that runs PM2 (recommended; see the
  systemd unit's `User=` field)
- Or set `PM2_HOME` in the agent's `.env` to point at the right PM2 dir

### Tool calls return "host is required" or "unknown host"

You're in multi-host mode (because `hosts.json` exists) and the LLM didn't
pick a host. Either tell it in the message (`@Sherlock check api-prod-1 for…`)
or make sure the host enum is reaching the LLM:

```bash
# In the control plane logs at startup:
{"event":"sherlock_ops_ready","mode":"multi_host","hosts":["api-prod-1","api-prod-2"]}
```

If `hosts` is empty, `hosts.json` failed to parse — look at startup logs for
the error.
