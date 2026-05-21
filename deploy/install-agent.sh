#!/usr/bin/env bash
#
# Install sherlock-agent as a systemd service on a target host.
#
# Run as root (or with sudo). Assumes the repo is checked out at /opt/sherlock-agent
# and you've already run `npm ci && npm run build` and created .env with:
#   SHERLOCK_CONTROL_URL=wss://your-control-plane/agent
#   SHERLOCK_HOST_ID=...
#   SHERLOCK_AGENT_TOKEN=...

set -euo pipefail

INSTALL_DIR=${INSTALL_DIR:-/opt/sherlock-agent}
# Default to the user that owns PM2 on this host. Set to e.g. "deploy" before running
# if you run PM2 under a non-root user.
SERVICE_USER=${SERVICE_USER:-$(stat -c %U "$HOME/.pm2" 2>/dev/null || echo root)}
SERVICE_FILE=/etc/systemd/system/sherlock-agent.service

if [[ $EUID -ne 0 ]]; then
  echo "must run as root (try: sudo $0)" >&2
  exit 1
fi

[[ -d "$INSTALL_DIR" ]] || { echo "$INSTALL_DIR does not exist — clone the repo there first" >&2; exit 1; }
[[ -f "$INSTALL_DIR/dist/agent/index.js" ]] || { echo "$INSTALL_DIR/dist/agent/index.js missing — run 'npm ci && npm run build' first" >&2; exit 1; }
[[ -f "$INSTALL_DIR/.env" ]] || { echo "$INSTALL_DIR/.env missing — set SHERLOCK_CONTROL_URL, SHERLOCK_HOST_ID, SHERLOCK_AGENT_TOKEN" >&2; exit 1; }

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "user '$SERVICE_USER' does not exist — create it or set SERVICE_USER=<your-pm2-user>" >&2
  exit 1
fi
echo "running agent as user: $SERVICE_USER"

NODE_BIN=$(command -v node || true)
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found — install Node 20+ first" >&2
  exit 1
fi
echo "using node at: $NODE_BIN"

chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

cp "$INSTALL_DIR/deploy/systemd/sherlock-agent.service" "$SERVICE_FILE"

if [[ "$NODE_BIN" != "/usr/bin/node" ]]; then
  sed -i "s|^ExecStart=/usr/bin/node|ExecStart=$NODE_BIN|" "$SERVICE_FILE"
fi
sed -i "s|^User=deploy|User=$SERVICE_USER|; s|^Group=deploy|Group=$SERVICE_USER|" "$SERVICE_FILE"

if [[ "$INSTALL_DIR" != "/opt/sherlock-agent" ]]; then
  sed -i "s|/opt/sherlock-agent|$INSTALL_DIR|g" "$SERVICE_FILE"
fi

systemctl daemon-reload
systemctl enable sherlock-agent
systemctl restart sherlock-agent

echo
echo "✓ sherlock-agent installed"
echo "  status:  systemctl status sherlock-agent"
echo "  logs:    journalctl -u sherlock-agent -f"
echo
sleep 1
systemctl --no-pager status sherlock-agent | head -20
