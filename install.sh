#!/usr/bin/env bash
#
# sherlock-ops one-line installer.
#
#   Control plane:
#     curl -fsSL https://raw.githubusercontent.com/harshtomar6/sherlock-ops/main/install.sh | sudo bash
#
#   Agent (on each target host):
#     curl -fsSL https://raw.githubusercontent.com/harshtomar6/sherlock-ops/main/install.sh | sudo bash -s -- --role agent
#
# Handles everything: Node 20+ (installed via NodeSource if missing), repo
# clone/update, build, guided .env setup, skills config, service user, and
# the systemd unit. Idempotent — re-run the same command to upgrade.
#
# Flags:
#   --role control-plane|agent   what to install (default: control-plane)
#   --dir <path>                 install dir (default: /opt/sherlock-ops or /opt/sherlock-agent)
#   --repo <url>                 git repo to install from
#   --ref <branch|tag>           git ref to install (default: main)
#   --non-interactive            never prompt; secrets come from env vars
#   --help                       this text
#
# Non-interactive secrets (also used as prompt defaults):
#   control plane: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET,
#                  and one of OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY
#   agent:         SHERLOCK_CONTROL_URL, SHERLOCK_HOST_ID, SHERLOCK_AGENT_TOKEN

set -euo pipefail

ROLE=control-plane
REPO=${SHERLOCK_REPO:-https://github.com/harshtomar6/sherlock-ops.git}
REF=${SHERLOCK_REF:-main}
INSTALL_DIR=${INSTALL_DIR:-}
INTERACTIVE=1
ENV_READY=1

# ─── output helpers ───────────────────────────────────────────────────────
if [[ -t 2 ]]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi
step() { echo "${BOLD}==>${RESET} $*" >&2; }
ok()   { echo "${GREEN} ✓${RESET} $*" >&2; }
warn() { echo "${YELLOW} !${RESET} $*" >&2; }
die()  { echo "${RED}error:${RESET} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
sherlock-ops installer

  control plane:  curl -fsSL https://raw.githubusercontent.com/harshtomar6/sherlock-ops/main/install.sh | sudo bash
  agent:          curl -fsSL https://raw.githubusercontent.com/harshtomar6/sherlock-ops/main/install.sh | sudo bash -s -- --role agent

Flags:
  --role control-plane|agent   what to install (default: control-plane)
  --dir <path>                 install dir (default: /opt/sherlock-ops or /opt/sherlock-agent)
  --repo <url>                 git repo to install from
  --ref <branch|tag>           git ref to install (default: main)
  --non-interactive            never prompt; secrets come from env vars
  --help                       this text

Non-interactive secrets (also used as prompt defaults):
  control plane: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET,
                 and one of OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY
  agent:         SHERLOCK_CONTROL_URL, SHERLOCK_HOST_ID, SHERLOCK_AGENT_TOKEN
  either:        SHERLOCK_SELF_UPGRADE=1 to let the bot upgrade itself on request
EOF
  exit 0
}

# ─── args ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)            ROLE=$2; shift 2 ;;
    --dir)             INSTALL_DIR=$2; shift 2 ;;
    --repo)            REPO=$2; shift 2 ;;
    --ref)             REF=$2; shift 2 ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    --help|-h)         usage ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
done

case "$ROLE" in
  control-plane) INSTALL_DIR=${INSTALL_DIR:-/opt/sherlock-ops};   SERVICE=sherlock-ops ;;
  agent)         INSTALL_DIR=${INSTALL_DIR:-/opt/sherlock-agent}; SERVICE=sherlock-agent ;;
  *) die "--role must be control-plane or agent" ;;
esac

# ─── environment checks ──────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "must run as root. Pipe to 'sudo bash' instead of 'bash'."
[[ "$(uname -s)" == "Linux" ]] || die "this installer targets Linux + systemd. On macOS, follow the Quick start in the README instead."
[[ -d /run/systemd/system ]] || die "systemd not detected. Install manually — see docs/SELF_HOSTING.md."

# stdin is the curl pipe, so prompts must go through the terminal directly.
if [[ $INTERACTIVE -eq 1 ]]; then
  if { : </dev/tty; } 2>/dev/null; then
    exec 3</dev/tty 4>/dev/tty
  else
    warn "no terminal available — falling back to non-interactive mode"
    INTERACTIVE=0
  fi
fi

# ask <var> <prompt> [default]  — env var of the same name wins as default.
ask() {
  local var=$1 prompt=$2 def=${3-} cur val
  cur=$(printenv "$var" || true)
  def=${cur:-$def}
  if [[ $INTERACTIVE -eq 0 ]]; then
    [[ -n "$def" ]] || return 1
    printf -v "$var" '%s' "$def"
    return 0
  fi
  if [[ -n "$def" ]]; then
    read -r -u 3 -p "  $prompt [$def]: " val >&4 || true
  else
    read -r -u 3 -p "  $prompt: " val >&4 || true
  fi
  printf -v "$var" '%s' "${val:-$def}"
  [[ -n "${!var}" ]]
}

# confirm <prompt> [Y|N] — returns the user's yes/no; default applies on enter
# and in non-interactive mode.
confirm() {
  local prompt=$1 def=${2:-Y} val
  if [[ $INTERACTIVE -eq 0 ]]; then [[ $def == Y ]]; return; fi
  read -r -u 3 -p "  $prompt [$([[ $def == Y ]] && echo Y/n || echo y/N)]: " val >&4 || true
  val=${val:-$def}
  [[ $val =~ ^[Yy] ]]
}

# ─── prerequisites ────────────────────────────────────────────────────────
PKG=""
command -v apt-get >/dev/null 2>&1 && PKG=apt
command -v dnf     >/dev/null 2>&1 && PKG=${PKG:-dnf}
command -v yum     >/dev/null 2>&1 && PKG=${PKG:-yum}

pkg_install() {
  case "$PKG" in
    apt) apt-get update -qq && apt-get install -y -qq "$@" ;;
    dnf) dnf install -y -q "$@" ;;
    yum) yum install -y -q "$@" ;;
    *) return 1 ;;
  esac
}

step "Checking prerequisites"

if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  pkg_install git curl ca-certificates || die "git and curl are required — install them and re-run"
fi

node_major() { node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }

if ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt 20 ]]; then
  if [[ -n "$PKG" ]] && confirm "Node 20+ not found. Install Node 22 via NodeSource?" Y; then
    step "Installing Node 22"
    if [[ $PKG == apt ]]; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
      apt-get install -y -qq nodejs
    else
      curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null
      pkg_install nodejs
    fi
  else
    die "Node.js >= 20 is required. Install it and re-run."
  fi
fi
ok "node $(node --version) at $(command -v node)"

# ─── fetch source ─────────────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  step "Updating $INSTALL_DIR ($REF)"
  git -C "$INSTALL_DIR" fetch --quiet origin "$REF"
  # reset only touches tracked files — .env, hosts.json, sherlock-config.json,
  # sherlock-skills/ and the audit DB are untracked and survive upgrades.
  git -C "$INSTALL_DIR" reset --quiet --hard FETCH_HEAD
elif [[ -e "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
  die "$INSTALL_DIR exists but is not a git checkout — move it aside or pass --dir"
else
  step "Cloning $REPO ($REF) to $INSTALL_DIR"
  git clone --quiet --branch "$REF" "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
ok "source at $(git rev-parse --short HEAD)"

# ─── build ────────────────────────────────────────────────────────────────
step "Installing dependencies and building"
if ! npm ci --no-audit --no-fund --loglevel=error; then
  # better-sqlite3 occasionally needs to compile from source
  warn "npm ci failed — installing native build tools and retrying"
  pkg_install python3 make g++ || die "npm ci failed and build tools could not be installed"
  npm ci --no-audit --no-fund --loglevel=error
fi
npm run build >/dev/null
npm prune --omit=dev --no-audit --no-fund --loglevel=error >/dev/null

# Version stamp, readable by the service user (the repo itself is root-owned,
# so the bot's 'upgrade' skill reads this instead of running git).
{
  echo "commit=$(git rev-parse --short HEAD)"
  echo "ref=$REF"
  echo "repo=$(git remote get-url origin)"
  echo "installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > BUILD_INFO
chmod 644 BUILD_INFO
ok "built dist/ ($(git rev-parse --short HEAD))"

# ─── configuration ────────────────────────────────────────────────────────
write_env() { # write_env <path> <lines...>
  local path=$1; shift
  printf '%s\n' "$@" > "$path"
  chmod 600 "$path"
}

configure_control_plane() {
  if [[ -f .env ]]; then
    ok "keeping existing .env"
  else
    step "Configuring control plane (.env)"
    if [[ $INTERACTIVE -eq 1 ]]; then
      echo "  Slack app secrets — create the app first if you haven't: see docs/SELF_HOSTING.md §'Slack app setup'" >&2
    fi

    local BOT="" APP="" SIGNING="" PROVIDER="" KEY_LINE="" MODEL="" BASE_URL=""
    if ask BOT "Slack bot token (xoxb-…)" "${SLACK_BOT_TOKEN-}" &&
       ask APP "Slack app token (xapp-…)" "${SLACK_APP_TOKEN-}" &&
       ask SIGNING "Slack signing secret" "${SLACK_SIGNING_SECRET-}"; then
      # LLM provider: pick the first key present in env, else ask.
      if   [[ -n "${OPENROUTER_API_KEY-}" ]]; then PROVIDER=openrouter
      elif [[ -n "${ANTHROPIC_API_KEY-}"  ]]; then PROVIDER=anthropic
      elif [[ -n "${OPENAI_API_KEY-}"     ]]; then PROVIDER=openai
      else
        ask PROVIDER "LLM provider (openrouter/anthropic/openai)" "openrouter" || true
      fi
      local API_KEY=""
      case "$PROVIDER" in
        openrouter)
          ask API_KEY "OpenRouter API key (sk-or-…)" "${OPENROUTER_API_KEY-}" || ENV_READY=0
          ask MODEL "Model" "anthropic/claude-opus-4" || true
          KEY_LINE="LLM_PROVIDER=openai"$'\n'"OPENROUTER_API_KEY=$API_KEY" ;;
        anthropic)
          ask API_KEY "Anthropic API key (sk-ant-…)" "${ANTHROPIC_API_KEY-}" || ENV_READY=0
          ask MODEL "Model" "claude-opus-4-7" || true
          KEY_LINE="LLM_PROVIDER=anthropic"$'\n'"ANTHROPIC_API_KEY=$API_KEY" ;;
        openai)
          ask API_KEY "OpenAI API key (sk-…)" "${OPENAI_API_KEY-}" || ENV_READY=0
          ask MODEL "Model" "gpt-4o" || true
          ask BASE_URL "Base URL (blank for api.openai.com)" "${OPENAI_BASE_URL-}" || true
          KEY_LINE="LLM_PROVIDER=openai"$'\n'"OPENAI_API_KEY=$API_KEY"
          [[ -n "$BASE_URL" ]] && KEY_LINE+=$'\n'"OPENAI_BASE_URL=$BASE_URL" ;;
        *) ENV_READY=0 ;;
      esac
      local USERS=""
      ask USERS "Allowed Slack user IDs, comma-separated (blank = everyone)" "${ALLOWED_SLACK_USERS-}" || true

      if [[ $ENV_READY -eq 1 ]]; then
        write_env .env \
          "SLACK_BOT_TOKEN=$BOT" \
          "SLACK_APP_TOKEN=$APP" \
          "SLACK_SIGNING_SECRET=$SIGNING" \
          "$KEY_LINE" \
          "LLM_MODEL=$MODEL" \
          "ALLOWED_SLACK_USERS=$USERS"
        ok "wrote .env"
      fi
    else
      ENV_READY=0
    fi

    if [[ $ENV_READY -eq 0 ]]; then
      cp .env.example .env && chmod 600 .env
      warn "missing secrets — wrote .env from template; edit it before starting the service"
    fi
  fi

  local skills=()
  if confirm "Enable the built-in pm2 skill? (choose no for a bare bot)" Y; then
    skills+=(pm2)
  fi
  [[ $SELF_UPGRADE -eq 1 ]] && skills+=(upgrade)

  if [[ -f sherlock-config.json ]]; then
    ok "keeping existing sherlock-config.json"
    if [[ $SELF_UPGRADE -eq 1 ]] && ! grep -q '"upgrade"' sherlock-config.json; then
      warn "add \"upgrade\" to the skills array in sherlock-config.json to finish enabling self-upgrade"
    fi
  elif [[ ${#skills[@]} -gt 0 ]]; then
    printf '{\n  "skills": [%s]\n}\n' "$(printf '"%s", ' "${skills[@]}" | sed 's/, $//')" > sherlock-config.json
    ok "enabled skills: ${skills[*]}"
  else
    warn "no skills enabled — add them later in sherlock-config.json"
  fi
}

configure_agent() {
  if [[ -f .env ]]; then
    ok "keeping existing .env"
    return
  fi
  step "Configuring agent (.env)"
  if [[ $INTERACTIVE -eq 1 ]]; then
    echo "  The host id + token must match an entry in the control plane's hosts.json" >&2
  fi
  local URL="" HOST_ID="" TOKEN=""
  if ask URL "Control plane URL (wss://…/agent)" "${SHERLOCK_CONTROL_URL-}" &&
     ask HOST_ID "Host id" "${SHERLOCK_HOST_ID-}" &&
     ask TOKEN "Agent token" "${SHERLOCK_AGENT_TOKEN-}"; then
    write_env .env \
      "SHERLOCK_CONTROL_URL=$URL" \
      "SHERLOCK_HOST_ID=$HOST_ID" \
      "SHERLOCK_AGENT_TOKEN=$TOKEN"
    ok "wrote .env"
  else
    ENV_READY=0
    cp .env.agent.example .env && chmod 600 .env
    warn "missing values — wrote .env from template; edit it before starting the service"
  fi
}

# Self-upgrade: lets the bot upgrade this install when asked in Slack, via a
# restricted sudoers rule on deploy/upgrade.sh. Off unless explicitly chosen
# (pre-seed with SHERLOCK_SELF_UPGRADE=1 for non-interactive installs).
SELF_UPGRADE=0
if [[ "${SHERLOCK_SELF_UPGRADE:-0}" == "1" ]]; then
  SELF_UPGRADE=1
elif confirm "Let Sherlock upgrade itself on request? (adds a restricted sudoers rule$( [[ $ROLE == control-plane ]] && echo " + the 'upgrade' skill"))" N; then
  SELF_UPGRADE=1
fi

if [[ $ROLE == control-plane ]]; then configure_control_plane; else configure_agent; fi

# ─── service ──────────────────────────────────────────────────────────────
if [[ $ENV_READY -eq 1 ]]; then
  step "Installing systemd service ($SERVICE)"
  INSTALL_DIR="$INSTALL_DIR" SHERLOCK_SELF_UPGRADE="$SELF_UPGRADE" \
    bash "deploy/install-$ROLE.sh"
else
  warn "skipping service start — .env is incomplete"
  echo >&2
  echo "  Finish up with:" >&2
  echo "    1. edit $INSTALL_DIR/.env" >&2
  echo "    2. sudo SHERLOCK_SELF_UPGRADE=$SELF_UPGRADE bash $INSTALL_DIR/deploy/install-$ROLE.sh" >&2
fi

echo >&2
ok "done — $SERVICE @ $INSTALL_DIR ($(git rev-parse --short HEAD))"
echo "  upgrade later by re-running this installer with the same flags" >&2
