#!/usr/bin/env bash
#
# Install the sherlock-ops control plane as a systemd service.
#
# Run on the VPS as root (or with sudo). Idempotent — safe to re-run.
#
# Assumes the repo is checked out at /opt/sherlock-ops and you've already run:
#   npm ci && npm run build
# and created /opt/sherlock-ops/.env with your secrets.

set -euo pipefail

INSTALL_DIR=${INSTALL_DIR:-/opt/sherlock-ops}
SERVICE_USER=${SERVICE_USER:-sherlock}
SERVICE_FILE=/etc/systemd/system/sherlock-ops.service

if [[ $EUID -ne 0 ]]; then
  echo "must run as root (try: sudo $0)" >&2
  exit 1
fi

[[ -d "$INSTALL_DIR" ]] || { echo "$INSTALL_DIR does not exist — clone the repo there first" >&2; exit 1; }
[[ -f "$INSTALL_DIR/dist/index.js" ]] || { echo "$INSTALL_DIR/dist/index.js missing — run 'npm ci && npm run build' first" >&2; exit 1; }
[[ -f "$INSTALL_DIR/.env" ]] || { echo "$INSTALL_DIR/.env missing — copy .env.example and fill in secrets first" >&2; exit 1; }

# ─── service user ────────────────────────────────────────────────────────
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "creating user '$SERVICE_USER' (system account, no login)"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
else
  echo "user '$SERVICE_USER' already exists"
fi

# ─── locate node ─────────────────────────────────────────────────────────
NODE_BIN=$(command -v node || true)
if [[ -z "$NODE_BIN" ]]; then
  echo "node binary not found in PATH. Install Node 20+ first." >&2
  echo "  Debian/Ubuntu (NodeSource):" >&2
  echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs" >&2
  exit 1
fi
NODE_VERSION=$("$NODE_BIN" --version)
echo "using node at: $NODE_BIN ($NODE_VERSION)"

# ─── file perms ──────────────────────────────────────────────────────────
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

if [[ -f "$INSTALL_DIR/hosts.json" ]]; then
  chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/hosts.json"
  chmod 600 "$INSTALL_DIR/hosts.json"
fi

# Skills config + operator skills dir must exist and be writable by the
# service user (the skill-author skill writes here; the unit's
# ReadWritePaths references both and fails at start if they're missing).
[[ -f "$INSTALL_DIR/sherlock-config.json" ]] || printf '{\n  "skills": []\n}\n' > "$INSTALL_DIR/sherlock-config.json"
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/sherlock-config.json"
mkdir -p "$INSTALL_DIR/sherlock-skills"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/sherlock-skills"

# ─── install unit ────────────────────────────────────────────────────────
cp "$INSTALL_DIR/deploy/systemd/sherlock-ops.service" "$SERVICE_FILE"

# Patch ExecStart if node is not at /usr/bin/node
if [[ "$NODE_BIN" != "/usr/bin/node" ]]; then
  echo "patching ExecStart to use $NODE_BIN"
  sed -i "s|^ExecStart=/usr/bin/node|ExecStart=$NODE_BIN|" "$SERVICE_FILE"
fi

# Patch User/WorkingDirectory if customized
if [[ "$SERVICE_USER" != "sherlock" ]]; then
  sed -i "s|^User=sherlock|User=$SERVICE_USER|; s|^Group=sherlock|Group=$SERVICE_USER|" "$SERVICE_FILE"
fi
if [[ "$INSTALL_DIR" != "/opt/sherlock-ops" ]]; then
  sed -i "s|/opt/sherlock-ops|$INSTALL_DIR|g" "$SERVICE_FILE"
fi

# ─── self-upgrade sudoers (opt-in) ───────────────────────────────────────
# Allows the service user to run exactly deploy/upgrade.sh with no arguments,
# so the bot's 'upgrade' skill can trigger a detached self-upgrade.
if [[ "${SHERLOCK_SELF_UPGRADE:-0}" == "1" ]]; then
  SUDOERS_FILE=/etc/sudoers.d/sherlock-ops-upgrade
  chmod 755 "$INSTALL_DIR/deploy/upgrade.sh"
  printf '%s ALL=(root) NOPASSWD: %s ""\n' "$SERVICE_USER" "$INSTALL_DIR/deploy/upgrade.sh" > "$SUDOERS_FILE.tmp"
  chmod 440 "$SUDOERS_FILE.tmp"
  if visudo -cf "$SUDOERS_FILE.tmp" >/dev/null; then
    mv "$SUDOERS_FILE.tmp" "$SUDOERS_FILE"
    echo "self-upgrade enabled ($SUDOERS_FILE)"
  else
    rm -f "$SUDOERS_FILE.tmp"
    echo "generated sudoers rule failed validation — self-upgrade NOT enabled" >&2
  fi
fi

# ─── enable + start ──────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable sherlock-ops
systemctl restart sherlock-ops

echo
echo "✓ sherlock-ops installed"
echo
echo "  status:  systemctl status sherlock-ops"
echo "  logs:    journalctl -u sherlock-ops -f"
echo
sleep 1
systemctl --no-pager status sherlock-ops | head -20
