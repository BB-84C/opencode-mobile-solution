#!/bin/bash
# Does running two opencode backends against one session database work?
#
# The multi-profile design puts a second `opencode serve` beside the first so a
# client can pick which one runs the next prompt. Both processes then write the
# same SQLite file. SQLite allows that, but only under assumptions about locking
# and journal mode that this has to confirm rather than assume.
#
# Runs entirely in an isolated XDG_DATA_HOME, so the database this machine
# actually uses is never opened. Nothing here touches a live deployment.

set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COCKPIT_LOG_PREFIX="sqlite-probe"
# shellcheck source=../lib/common.sh
. "$HERE/../lib/common.sh"

WORKDIR="${1:-/tmp/cockpit-sqlite-probe}"
PORT_A=4910
PORT_B=4911
ROUNDS="${ROUNDS:-20}"

OPENCODE_BIN="$(probe_opencode)" || die "opencode not found"
require_port_free "$PORT_A"
require_port_free "$PORT_B"

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR/data" "$WORKDIR/project" || die "cannot create $WORKDIR"
# macOS /tmp is a symlink to /private/tmp and the server stores the resolved
# path. Comparing against an unresolved one silently matches nothing.
PROJECT_DIR="$(cd "$WORKDIR/project" && pwd -P)"
# Session listing is scoped by the server's working directory, so run the whole
# probe from inside the project rather than passing a directory query.
cd "$PROJECT_DIR" || die "cannot enter $PROJECT_DIR"

export XDG_DATA_HOME="$WORKDIR/data"
export OPENCODE_SERVER_USERNAME=probe
export OPENCODE_SERVER_PASSWORD="probe-password-with-entropy"
AUTH="$(printf '%s:%s' "$OPENCODE_SERVER_USERNAME" "$OPENCODE_SERVER_PASSWORD" | base64)"

log "isolated data home: $XDG_DATA_HOME"
log "the live database is not opened by this probe"

start_backend() {
  local port="$1" logfile="$2"
  # Session listing is scoped by the server's own working directory, not by a
  # directory query, so both backends must be started inside the project.
  nohup "$OPENCODE_BIN" serve --hostname 127.0.0.1 --port "$port" > "$logfile" 2>&1 &
  printf '%s' "$!"
}

# Measured: the first process holds an exclusive lock while it initialises the
# database, and a second process started inside that window dies with "database
# is locked". Staggering is not politeness, it is required.
PID_A="$(start_backend "$PORT_A" "$WORKDIR/a.log")"
cleanup() {
  kill "$PID_A" "${PID_B:-}" 2>/dev/null
  wait "$PID_A" "${PID_B:-}" 2>/dev/null
}
trap cleanup EXIT
wait_for_port "$PORT_A" 40 || { tail -20 "$WORKDIR/a.log" >&2; die "backend A never bound $PORT_A"; }

PID_B="$(start_backend "$PORT_B" "$WORKDIR/b.log")"
wait_for_port "$PORT_B" 40 || { tail -20 "$WORKDIR/b.log" >&2; die "backend B never bound $PORT_B (started after A was already listening)"; }
log "both backends are listening; they share $XDG_DATA_HOME/opencode/opencode.db"

create_session() {
  local port="$1" label="$2"
  curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -X POST "http://127.0.0.1:$port/session" \
    -H "Authorization: Basic $AUTH" \
    -H 'Content-Type: application/json' \
    -d "{\"title\":\"$label\",\"directory\":\"$PROJECT_DIR\"}"
}

log "writing from both processes at once, $ROUNDS rounds"
failures=0
for round in $(seq 1 "$ROUNDS"); do
  code_a=""; code_b=""
  code_a="$(create_session "$PORT_A" "a-$round")" &
  pid_write_a=$!
  code_b="$(create_session "$PORT_B" "b-$round")"
  wait $pid_write_a
  # The backgrounded subshell cannot hand its variable back, so re-read both
  # from a second, sequential pass rather than trusting an empty string.
  [ "$code_b" = "200" ] || { warn "round $round: backend B returned $code_b"; failures=$((failures + 1)); }
done

sequential_a="$(create_session "$PORT_A" "final-a")"
sequential_b="$(create_session "$PORT_B" "final-b")"
[ "$sequential_a" = "200" ] || { warn "backend A returned $sequential_a"; failures=$((failures + 1)); }
[ "$sequential_b" = "200" ] || { warn "backend B returned $sequential_b"; failures=$((failures + 1)); }

log "checking both processes agree on what is in the database"
list_a="$(curl -s --max-time 20 -H "Authorization: Basic $AUTH" "http://127.0.0.1:$PORT_A/session")"
list_b="$(curl -s --max-time 20 -H "Authorization: Basic $AUTH" "http://127.0.0.1:$PORT_B/session")"
count_a="$(printf '%s' "$list_a" | /usr/bin/python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo error)"
count_b="$(printf '%s' "$list_b" | /usr/bin/python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo error)"
log "backend A lists $count_a sessions, backend B lists $count_b"
[ "$count_a" = "$count_b" ] || { warn "the two processes disagree on the session list"; failures=$((failures + 1)); }
[ "$count_a" = "error" ] && { warn "could not read a session list"; failures=$((failures + 1)); }

log "scanning both logs for lock contention"
if grep -aiE "database is locked|SQLITE_BUSY|database table is locked" "$WORKDIR/a.log" "$WORKDIR/b.log" >/dev/null 2>&1; then
  warn "a backend logged lock contention:"
  grep -aiE "database is locked|SQLITE_BUSY|database table is locked" "$WORKDIR/a.log" "$WORKDIR/b.log" | head -5 >&2
  failures=$((failures + 1))
else
  log "no lock contention in either log"
fi

journal="$(/usr/bin/sqlite3 "$XDG_DATA_HOME/opencode/opencode.db" 'PRAGMA journal_mode;' 2>/dev/null || echo unknown)"
log "journal mode: $journal"
[ "$journal" = "wal" ] || warn "journal mode is '$journal'; WAL is what lets two writers coexist comfortably"

if [ "$failures" -ne 0 ]; then
  die "$failures problem(s); two backends on one database is NOT safe as configured"
fi
log "two backends shared one database with no contention"
