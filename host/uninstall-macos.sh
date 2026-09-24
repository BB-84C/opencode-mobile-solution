#!/bin/bash
# Removes a cockpit deployment: launchd jobs, the tailnet publication, the
# running relay, and optionally the configuration directory.
#
# Credentials are never deleted unless --purge is given, because a deployment is
# usually torn down to be rebuilt, and losing the paired-device state means every
# phone and laptop has to be paired again.

set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COCKPIT_LOG_PREFIX="uninstall"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

MODE="production"
CONFIG_DIR=""
SERVE_PORT=""
PURGE=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: uninstall-macos.sh [options]

  --mode <production|shadow>   Which deployment to remove (default: production)
  --config-dir <path>          Configuration directory to clean up
  --serve-port <port>          Tailnet port to unpublish (default: 8443 / shadow 8444)
  --purge                      Also delete the configuration directory, including
                               credentials and paired-device state
  --dry-run                    List what would be removed and exit
  -h, --help                   This text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)        MODE="${2:-}"; shift 2 ;;
    --config-dir)  CONFIG_DIR="${2:-}"; shift 2 ;;
    --serve-port)  SERVE_PORT="${2:-}"; shift 2 ;;
    --purge)       PURGE=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown option: $1 (try --help)" ;;
  esac
done

if [ "$MODE" = "shadow" ]; then
  CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/opencode-cockpit-shadow}"
  SERVE_PORT="${SERVE_PORT:-8444}"
else
  CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/opencode-cockpit}"
  SERVE_PORT="${SERVE_PORT:-8443}"
fi

TS_BIN="$(probe_tailscale)" || warn "Tailscale CLI not found; the tailnet publication will be left in place"

log "mode       : $MODE"
log "config dir : $CONFIG_DIR"
log "serve port : $SERVE_PORT"
log "purge      : $([ "$PURGE" -eq 1 ] && echo yes || echo 'no (credentials and pairings kept)')"

JOBS=()
# Shadow runs under nohup and installs no launchd job, so matching by label
# prefix found the production relay instead and took the live stack off the air.
if [ "$MODE" != "shadow" ]; then
  while IFS= read -r label; do
    [ -n "$label" ] && JOBS+=("$label")
  done < <(launchctl list 2>/dev/null | awk '$3 ~ /^com\.skylerhu\.cockpit-/ {print $3}')
fi

for job in ${JOBS+"${JOBS[@]}"}; do log "will unload launchd job: $job"; done
[ -f "$CONFIG_DIR/relay.pid" ] && log "will stop shadow relay pid $(cat "$CONFIG_DIR/relay.pid")"
log "will unpublish https://<this-host>:$SERVE_PORT"
[ "$PURGE" -eq 1 ] && log "will DELETE $CONFIG_DIR"

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run: nothing was changed"
  exit 0
fi

failures=0

for job in ${JOBS+"${JOBS[@]}"}; do
  if launchctl bootout "gui/$UID/$job" >/dev/null 2>&1; then
    log "unloaded $job"
  else
    warn "could not unload $job"
    failures=$((failures + 1))
  fi
  rm -f "$HOME/Library/LaunchAgents/$job.plist"

  # bootout returns before the job's process has finished exiting, so the job
  # stays visible for a moment. Checking immediately reports a failure that is
  # only a race; give it a bounded window to disappear.
  waited=0
  while [ "$waited" -lt 10 ] && launchctl print "gui/$UID/$job" >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
  done
  if launchctl print "gui/$UID/$job" >/dev/null 2>&1; then
    warn "$job is still registered with launchd after ${waited}s"
    failures=$((failures + 1))
  fi
done

if [ -f "$CONFIG_DIR/relay.pid" ]; then
  pid="$(cat "$CONFIG_DIR/relay.pid")"
  if kill "$pid" 2>/dev/null; then
    sleep 1
    if ps -p "$pid" >/dev/null 2>&1; then
      warn "relay pid $pid ignored SIGTERM"
      failures=$((failures + 1))
    else
      log "stopped relay pid $pid"
    fi
  else
    log "relay pid $pid was not running"
  fi
  rm -f "$CONFIG_DIR/relay.pid"
fi

if [ -n "${TS_BIN:-}" ]; then
  "$TS_BIN" serve --https="$SERVE_PORT" off >/dev/null 2>&1 || true
  if "$TS_BIN" serve status 2>/dev/null | grep -q ":$SERVE_PORT"; then
    warn "port $SERVE_PORT is still published by tailscale serve"
    failures=$((failures + 1))
  else
    log "unpublished port $SERVE_PORT"
  fi
fi

if [ "$PURGE" -eq 1 ]; then
  if [ -d "$CONFIG_DIR" ]; then
    rm -rf "$CONFIG_DIR" || { warn "could not delete $CONFIG_DIR"; failures=$((failures + 1)); }
    [ -d "$CONFIG_DIR" ] && { warn "$CONFIG_DIR still exists"; failures=$((failures + 1)); } || log "deleted $CONFIG_DIR"
  fi
else
  log "kept $CONFIG_DIR (pass --purge to delete credentials and pairings too)"
fi

[ "$failures" -eq 0 ] || die "$failures step(s) did not complete; inspect the warnings above"
log "done."
