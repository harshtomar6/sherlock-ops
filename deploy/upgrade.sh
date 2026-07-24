#!/usr/bin/env bash
#
# Trigger a detached self-upgrade of this sherlock installation.
#
# Designed to be invoked by the bot itself (via sudo) through the 'upgrade'
# skill, so it is deliberately rigid: no arguments, role and directory are
# derived from where the script lives, and the actual work runs in a
# transient systemd unit so it survives the service restarting underneath it.
#
# Enable by opting into self-upgrade during install (writes a sudoers rule
# allowing the service user to run exactly this script with no arguments).

set -euo pipefail

[[ $# -eq 0 ]] || { echo "upgrade.sh takes no arguments" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "must run as root (via sudo)" >&2; exit 1; }
command -v systemd-run >/dev/null 2>&1 || { echo "systemd-run not found" >&2; exit 1; }

# deploy/upgrade.sh -> install dir is one level up.
INSTALL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ -f "$INSTALL_DIR/install.sh" ]] || { echo "$INSTALL_DIR/install.sh missing" >&2; exit 1; }

# Agent installs carry SHERLOCK_CONTROL_URL in .env; the control plane doesn't.
ROLE=control-plane
if grep -qs '^SHERLOCK_CONTROL_URL=' "$INSTALL_DIR/.env"; then
  ROLE=agent
fi

UNIT="sherlock-upgrade-$$"
systemd-run --unit "$UNIT" --collect \
  --property=WorkingDirectory="$INSTALL_DIR" \
  /usr/bin/env SHERLOCK_SELF_UPGRADE=1 bash "$INSTALL_DIR/install.sh" \
  --non-interactive --role "$ROLE" --dir "$INSTALL_DIR" >/dev/null

echo "upgrade started in background unit '$UNIT' (role: $ROLE, dir: $INSTALL_DIR)"
echo "the service will rebuild and restart itself in the next minute or two"
echo "follow progress with: journalctl -u $UNIT -f"
