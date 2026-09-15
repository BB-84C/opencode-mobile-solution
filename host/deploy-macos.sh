#!/bin/bash
# One-shot host deployment for opencode-cockpit on macOS.
#
# Brings up: one or more opencode backends, the relay in front of them, and TLS
# termination on the tailnet. There is no reverse proxy and no certificate to
# manage: `tailscale serve` terminates HTTPS with a certificate it provisions
# itself, which also means nothing here listens on a public interface.
#
#   tailnet client --> ts.net:<serve-port> --> tailscaled --> relay --> backend(s)
#
# Two modes:
#   production  installs launchd jobs, survives reboot
#   shadow      runs in the foreground under nohup, installs nothing, and is torn
#               down by uninstall-macos.sh. Use it to try a new build beside a
#               deployment that is already serving devices.
#
# Every step is checked, and --dry-run prints the whole plan without touching
# anything.

set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
COCKPIT_LOG_PREFIX="deploy"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

MODE="production"
CONFIG_DIR=""
RELAY_PORT=""
SERVE_PORT=""
BACKEND_ENV=""
BACKEND_DATA_HOME=""
DRY_RUN=0
TARGETS=()
MANAGED=()

usage() {
  cat <<'EOF'
Usage: deploy-macos.sh [options]

  --mode <production|shadow>   Deployment mode (default: production)
  --config-dir <path>          Where configuration and credentials live
  --relay-port <port>          Relay listen port (default: 4097 / shadow 4197)
  --serve-port <port>          HTTPS port published on the tailnet (default: 8443 / shadow 8444)
  --target <name:host:port>    Register an existing backend as a target. Repeatable.
  --managed-backend <name:port[:profile]>
                               Start and supervise a backend. Repeatable.
                               `profile` selects an OMO profile, e.g. gpt.
  --backend-env <path>         Reuse existing Basic credentials instead of generating new ones
  --backend-data-home <path>   Give managed backends their own XDG_DATA_HOME, so they use a
                               separate session database instead of the user's default one
  --dry-run                    Print the plan and exit without changing anything
  -h, --help                   This text

Examples:
  # Try a new build beside a live deployment, reusing its backend and credentials
  ./deploy-macos.sh --mode shadow \
      --target default:127.0.0.1:4096 \
      --backend-env ~/.config/opencode-relay/backend.env

  # Full host install with two profiles
  ./deploy-macos.sh --managed-backend default:4096 --managed-backend gpt:4098:gpt
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)             MODE="${2:-}"; shift 2 ;;
    --config-dir)       CONFIG_DIR="${2:-}"; shift 2 ;;
    --relay-port)       RELAY_PORT="${2:-}"; shift 2 ;;
    --serve-port)       SERVE_PORT="${2:-}"; shift 2 ;;
    --target)           TARGETS+=("${2:-}"); shift 2 ;;
    --managed-backend)  MANAGED+=("${2:-}"); shift 2 ;;
    --backend-env)      BACKEND_ENV="${2:-}"; shift 2 ;;
    --backend-data-home) BACKEND_DATA_HOME="${2:-}"; shift 2 ;;
    --dry-run)          DRY_RUN=1; shift ;;
    -h|--help)          usage; exit 0 ;;
    *)                  die "unknown option: $1 (try --help)" ;;
  esac
done

case "$MODE" in
  production) : ;;
  shadow)     : ;;
  *) die "--mode must be production or shadow, got '$MODE'" ;;
esac

if [ "$MODE" = "shadow" ]; then
  CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/opencode-cockpit-shadow}"
  RELAY_PORT="${RELAY_PORT:-4197}"
  SERVE_PORT="${SERVE_PORT:-8444}"
  [ "${#MANAGED[@]}" -eq 0 ] || die "shadow mode does not supervise backends; register them with --target instead"
else
  CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/opencode-cockpit}"
  RELAY_PORT="${RELAY_PORT:-4097}"
  SERVE_PORT="${SERVE_PORT:-8443}"
fi

[ "${#TARGETS[@]}" -gt 0 ] || [ "${#MANAGED[@]}" -gt 0 ] \
  || die "nothing to serve: pass at least one --target or --managed-backend"

# --- probe the toolchain ---------------------------------------------------

TS_BIN="$(probe_tailscale)"   || die "Tailscale CLI not found (looked on PATH and inside /Applications/Tailscale.app)"
NODE_BIN="$(probe_node)"      || die "node not found"
require_node_major "$NODE_BIN" 22
if [ "${#MANAGED[@]}" -gt 0 ]; then
  OPENCODE_BIN="$(probe_opencode)" || die "opencode not found, but --managed-backend was requested"
else
  OPENCODE_BIN="$(probe_opencode 2>/dev/null || true)"
fi

"$TS_BIN" status >/dev/null 2>&1 || die "Tailscale is installed but not connected; run '$TS_BIN up' first"

DNS_NAME="$(tailnet_dns_name "$TS_BIN" "$NODE_BIN")"
[ -n "$DNS_NAME" ] || die "could not read this machine's tailnet DNS name; is MagicDNS enabled?"
TS_IPV4="$(tailnet_ipv4 "$TS_BIN")"

PUBLIC_ORIGIN="https://${DNS_NAME}:${SERVE_PORT}"
SERVICE_DIR="$CONFIG_DIR/service"
STATE_DIR="$CONFIG_DIR"
LOG_DIR="$CONFIG_DIR/logs"
TOKENS_PATH="$CONFIG_DIR/tokens.json"
RELAY_ENV_PATH="$CONFIG_DIR/relay.env"
BACKEND_ENV_PATH="${BACKEND_ENV:-$CONFIG_DIR/backend.env}"

# --- plan ------------------------------------------------------------------

log "mode            : $MODE"
log "tailnet host    : $DNS_NAME (${TS_IPV4:-no IPv4})"
log "public origin   : $PUBLIC_ORIGIN"
log "config dir      : $CONFIG_DIR"
log "relay port      : $RELAY_PORT"
log "node            : $NODE_BIN"
log "tailscale       : $TS_BIN"
[ -n "${OPENCODE_BIN:-}" ] && log "opencode        : $OPENCODE_BIN"
for entry in ${TARGETS+"${TARGETS[@]}"}; do log "target          : $entry (external, not supervised)"; done
for entry in ${MANAGED+"${MANAGED[@]}"}; do log "managed backend : $entry"; done
if [ "$MODE" = "production" ]; then
  log "launchd         : com.skylerhu.cockpit-relay (+ one per managed backend)"
else
  log "launchd         : none (shadow mode runs under nohup)"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run: nothing was changed"
  exit 0
fi

# --- credentials -----------------------------------------------------------

if [ -n "$BACKEND_ENV" ]; then
  [ -r "$BACKEND_ENV" ] || die "--backend-env $BACKEND_ENV is not readable"
  log "reusing Basic credentials from $BACKEND_ENV (not copied)"
else
  if [ -r "$BACKEND_ENV_PATH" ]; then
    log "keeping the Basic credentials already in $BACKEND_ENV_PATH"
  else
    write_private_file "$BACKEND_ENV_PATH" "$(printf 'OPENCODE_SERVER_USERNAME=opencode\nOPENCODE_SERVER_PASSWORD=%s\n' "$(random_hex 24)")"
    log "generated new Basic credentials in $BACKEND_ENV_PATH"
  fi
fi

# Credentials only ever enter the environment, never a command line, so they do
# not appear in `ps` output or shell history.
set -a
# shellcheck disable=SC1090
. "$BACKEND_ENV_PATH" || die "cannot read $BACKEND_ENV_PATH"
set +a
BASIC_USER="${OPENCODE_SERVER_USERNAME:-}"
BASIC_PASS="${OPENCODE_SERVER_PASSWORD:-}"
[ -n "$BASIC_USER" ] && [ -n "$BASIC_PASS" ] || die "$BACKEND_ENV_PATH does not define OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD"

mkdir -p "$LOG_DIR" || die "cannot create $LOG_DIR"
chmod 700 "$CONFIG_DIR" || die "cannot chmod $CONFIG_DIR"

# --- tokens.json -----------------------------------------------------------

CLIENT_TOKEN=""
if [ -r "$TOKENS_PATH" ]; then
  CLIENT_TOKEN="$("$NODE_BIN" -e '
    const fs = require("node:fs");
    try {
      const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(doc?.clients?.owner?.token ?? "");
    } catch { process.stdout.write(""); }
  ' "$TOKENS_PATH")"
fi
[ -n "$CLIENT_TOKEN" ] || CLIENT_TOKEN="$(random_hex 32)"

TOKENS_JSON="$(
  BASIC_USER="$BASIC_USER" BASIC_PASS="$BASIC_PASS" CLIENT_TOKEN="$CLIENT_TOKEN" \
  TARGET_SPEC="${TARGETS+$(IFS=' '; printf '%s' "${TARGETS[*]}")}" \
  MANAGED_SPEC="${MANAGED+$(IFS=' '; printf '%s' "${MANAGED[*]}")}" \
  "$NODE_BIN" -e '
    const targets = {};
    const register = (name, host, port, label) => {
      targets[name] = {
        displayName: label,
        host,
        port: Number(port),
        basicUser: process.env.BASIC_USER,
        basicPass: process.env.BASIC_PASS,
      };
    };
    for (const spec of (process.env.TARGET_SPEC || "").split(" ").filter(Boolean)) {
      const [name, host, port] = spec.split(":");
      if (!name || !host || !port) throw new Error(`bad --target: ${spec}`);
      register(name, host, port, name);
    }
    for (const spec of (process.env.MANAGED_SPEC || "").split(" ").filter(Boolean)) {
      const [name, port, profile] = spec.split(":");
      if (!name || !port) throw new Error(`bad --managed-backend: ${spec}`);
      register(name, "127.0.0.1", port, profile ? `${name} (${profile})` : name);
    }
    const ids = Object.keys(targets);
    process.stdout.write(JSON.stringify({
      version: 2,
      targets,
      clients: {
        owner: {
          displayName: "Host owner",
          token: process.env.CLIENT_TOKEN,
          targetID: ids[0],
          targetIDs: ids,
        },
      },
    }, null, 2) + "\n");
  '
)" || die "could not build tokens.json"

write_private_file "$TOKENS_PATH" "$TOKENS_JSON"
log "wrote $TOKENS_PATH"

write_private_file "$RELAY_ENV_PATH" "$(cat <<EOF
RELAY_PORT=$RELAY_PORT
TOKENS_PATH=$TOKENS_PATH
PASSKEY_STATE_PATH=$STATE_DIR/passkeys.json
RELAY_PUBLIC_ORIGIN=$PUBLIC_ORIGIN
PAIRING_SOURCE_CLIENT_ID=owner
TOKEN_RELOAD_SEC=60
EOF
)"
log "wrote $RELAY_ENV_PATH"

# --- relay service copy ----------------------------------------------------
# The running service is a copy, independent of the source checkout, so moving
# or rebuilding the repository cannot take the deployment down.

mkdir -p "$SERVICE_DIR" || die "cannot create $SERVICE_DIR"
cp "$REPO_ROOT/relay/relay.mjs" "$SERVICE_DIR/" || die "cannot copy relay.mjs"
cp "$REPO_ROOT/relay/package.json" "$SERVICE_DIR/" || die "cannot copy package.json"
rm -rf "$SERVICE_DIR/lib" && cp -R "$REPO_ROOT/relay/lib" "$SERVICE_DIR/lib" || die "cannot copy relay/lib"
if [ -d "$REPO_ROOT/relay/node_modules" ]; then
  rm -rf "$SERVICE_DIR/node_modules"
  cp -R "$REPO_ROOT/relay/node_modules" "$SERVICE_DIR/node_modules" 2>/dev/null
fi
[ -d "$SERVICE_DIR/node_modules/@simplewebauthn" ] \
  || die "relay dependencies missing; run 'npm ci --omit=dev' in $REPO_ROOT/relay first"
log "installed relay service into $SERVICE_DIR"

# --- start the relay -------------------------------------------------------

if [ "$MODE" = "shadow" ]; then
  require_port_free "$RELAY_PORT"
  RUNNER="$CONFIG_DIR/run-relay.sh"
  write_private_file "$RUNNER" "$(cat <<EOF
#!/bin/bash
# Started by deploy-macos.sh in shadow mode. Not managed by launchd.
set -a
. "$RELAY_ENV_PATH"
. "$BACKEND_ENV_PATH"
set +a
cd "$SERVICE_DIR"
exec "$NODE_BIN" relay.mjs
EOF
)"
  chmod 700 "$RUNNER"
  nohup "$RUNNER" > "$LOG_DIR/relay.log" 2>&1 &
  RELAY_PID=$!
  log "relay started in the foreground (pid $RELAY_PID), log at $LOG_DIR/relay.log"
  wait_for_port "$RELAY_PORT" 20 || { tail -20 "$LOG_DIR/relay.log" >&2; die "relay did not bind port $RELAY_PORT"; }
  printf '%s' "$RELAY_PID" > "$CONFIG_DIR/relay.pid"
else
  # launchd starts a job with almost no environment: no PATH, no proxy
  # variables, and it does not read the user's shell profile. Everything the
  # services need is written here and sourced by each runner.
  SERVICE_ENV="$CONFIG_DIR/service-env.sh"
  if [ ! -r "$SERVICE_ENV" ]; then
    write_private_file "$SERVICE_ENV" "$(cat <<EOF
# Sourced by every cockpit service. launchd provides no PATH and does not read
# your shell profile, so anything the services need belongs here.
export PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="\${LANG:-en_US.UTF-8}"

# If model API traffic has to leave through a local proxy, set it here. Keep the
# tailnet out of the proxy, or devices will reach the relay while the backend
# cannot reach its models.
# export https_proxy="http://127.0.0.1:1082"
# export http_proxy="\$https_proxy"
# export no_proxy="localhost,127.0.0.1,::1,.ts.net,100.64.0.0/10"
# export NO_PROXY="\$no_proxy"
EOF
)"
    log "wrote $SERVICE_ENV (edit it if the backends need a proxy)"
  fi

  install_job() {
    local label="$1" runner="$2" logfile="$3"
    local plist="$HOME/Library/LaunchAgents/$label.plist"
    local spec
    spec="$("$NODE_BIN" -e '
      const [label, runner, logfile] = process.argv.slice(1);
      process.stdout.write(JSON.stringify({
        label,
        programArguments: ["/bin/bash", runner],
        standardOutPath: logfile,
        standardErrorPath: logfile,
      }));
    ' "$label" "$runner" "$logfile")"
    "$NODE_BIN" "$HERE/lib/plist.mjs" "$spec" > "$plist" || die "cannot render $plist"
    /usr/bin/plutil -lint "$plist" >/dev/null || die "$plist is not a valid property list"

    launchctl bootout "gui/$UID/$label" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$UID" "$plist" || die "launchctl refused to load $label"
    launchctl print "gui/$UID/$label" >/dev/null 2>&1 || die "$label did not appear in launchd after loading"
    log "installed launchd job $label"
  }

  for entry in ${MANAGED+"${MANAGED[@]}"}; do
    b_name="${entry%%:*}"; rest="${entry#*:}"
    b_port="${rest%%:*}"; b_profile=""
    [ "$rest" != "$b_port" ] && b_profile="${rest#*:}"
    require_port_free "$b_port"

    b_runner="$CONFIG_DIR/run-backend-$b_name.sh"
    profile_lines=""
    if [ -n "$b_profile" ]; then
      profile_config="$HOME/.config/opencode/profiles/$b_profile/opencode.json"
      [ -r "$profile_config" ] || die "profile '$b_profile' has no config at $profile_config"
      profile_lines="export OMO_PROFILE=\"$b_profile\"
export OPENCODE_CONFIG=\"$profile_config\""
    fi
    write_private_file "$b_runner" "$(cat <<EOF
#!/bin/bash
set -a
. "$SERVICE_ENV"
. "$BACKEND_ENV_PATH"
set +a
$profile_lines
${BACKEND_DATA_HOME:+export XDG_DATA_HOME="$BACKEND_DATA_HOME"}
cd "\$HOME"
exec "$OPENCODE_BIN" serve --hostname 127.0.0.1 --port $b_port
EOF
)"
    chmod 700 "$b_runner"
    install_job "com.skylerhu.cockpit-backend-$b_name" "$b_runner" "$LOG_DIR/backend-$b_name.log"
    wait_for_port "$b_port" 30 || { tail -20 "$LOG_DIR/backend-$b_name.log" >&2; die "backend '$b_name' did not bind port $b_port"; }
    log "backend '$b_name' is listening on 127.0.0.1:$b_port"
  done

  require_port_free "$RELAY_PORT"
  RELAY_RUNNER="$CONFIG_DIR/run-relay.sh"
  write_private_file "$RELAY_RUNNER" "$(cat <<EOF
#!/bin/bash
set -a
. "$SERVICE_ENV"
. "$RELAY_ENV_PATH"
. "$BACKEND_ENV_PATH"
set +a
cd "$SERVICE_DIR"
exec "$NODE_BIN" relay.mjs
EOF
)"
  chmod 700 "$RELAY_RUNNER"
  install_job "com.skylerhu.cockpit-relay" "$RELAY_RUNNER" "$LOG_DIR/relay.log"
  wait_for_port "$RELAY_PORT" 20 || { tail -20 "$LOG_DIR/relay.log" >&2; die "relay did not bind port $RELAY_PORT"; }
fi

# --- TLS on the tailnet ----------------------------------------------------

"$TS_BIN" serve --bg --https="$SERVE_PORT" "http://127.0.0.1:$RELAY_PORT" >/dev/null 2>&1 \
  || die "could not publish the relay with 'tailscale serve' on port $SERVE_PORT"
"$TS_BIN" serve status 2>/dev/null | grep -q ":$SERVE_PORT" \
  || die "'tailscale serve' reported success but port $SERVE_PORT is absent from its status"
log "published $PUBLIC_ORIGIN -> 127.0.0.1:$RELAY_PORT"

# --- verify ----------------------------------------------------------------
# Checked through the tailnet name rather than against 127.0.0.1, so TLS
# termination and the proxy hop are both exercised.

health="$(curl -fsS --max-time 10 "$PUBLIC_ORIGIN/health" 2>/dev/null)" \
  || die "health check failed through $PUBLIC_ORIGIN (the relay may be up but unreachable over the tailnet)"
printf '%s' "$health" | grep -q '"status":"ok"' || die "unexpected health payload: $health"

unauth_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC_ORIGIN/session")"
[ "$unauth_code" = "401" ] || die "an unauthenticated request returned $unauth_code, expected 401"

auth_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  -H "Authorization: Bearer $CLIENT_TOKEN" "$PUBLIC_ORIGIN/session")"
[ "$auth_code" = "200" ] || die "an authenticated request returned $auth_code, expected 200"

log "verified: health ok, unauthenticated 401, authenticated 200"
log ""
log "  URL for clients : $PUBLIC_ORIGIN"
log "  device token    : stored in $TOKENS_PATH (client id 'owner')"
log "  pairing console : $PUBLIC_ORIGIN/pair"
log ""
log "done."
