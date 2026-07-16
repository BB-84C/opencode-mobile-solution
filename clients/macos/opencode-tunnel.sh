#!/usr/bin/env bash
# opencode-tunnel.sh — SSH reverse tunnel daemon for Mac / Linux.
#
# Usage:
#   ./opencode-tunnel.sh start     Launch tunnel daemon (idempotent)
#   ./opencode-tunnel.sh stop      Kill tunnel daemon
#   ./opencode-tunnel.sh status    Show tunnel health
#   ./opencode-tunnel.sh logs      Tail recent log entries
#
# Config via environment (same as Windows .ps1 version):
#   OPENCODE_SERVER_PORT   Local port (default: 4096)
#   OPENCODE_TUNNEL_HOST   SSH alias/host (default: opencode-vps)

set -euo pipefail

LOCAL_PORT="${OPENCODE_SERVER_PORT:-4096}"
REMOTE_PORT="$LOCAL_PORT"
SSH_ALIAS="${OPENCODE_TUNNEL_HOST:-opencode-vps}"
RUN_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/opencode"
PID_FILE="$RUN_DIR/tunnel.pid"
LOG_FILE="$RUN_DIR/tunnel.log"

mkdir -p "$RUN_DIR"

# ── Helpers ──────────────────────────────────────────────────
AUTOSSH=$(command -v autossh 2>/dev/null || echo "")

is_running() {
    if [ ! -f "$PID_FILE" ]; then return 1; fi
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -z "$pid" ]; then return 1; fi
    kill -0 "$pid" 2>/dev/null
}

remote_port_open() {
    ssh -o ConnectTimeout=5 -o BatchMode=yes "$SSH_ALIAS" \
        "ss -tlnp 2>/dev/null | grep -q ':${REMOTE_PORT}\b'" 2>/dev/null
}

log_msg() {
    echo "$(date '+%Y-%m-%d %H:%M:%S')  $1" >> "$LOG_FILE"
}

# ── Start ────────────────────────────────────────────────────
do_start() {
    if is_running; then
        echo "[tunnel] Already running (PID $(cat "$PID_FILE"))"
        return 0
    fi

    log_msg "=== STARTING TUNNEL ==="
    log_msg "SSH=$SSH_ALIAS localhost:$LOCAL_PORT -> VPS:$REMOTE_PORT"

    if [ -n "$AUTOSSH" ]; then
        # autossh with monitor port
        local monitor_port=$((LOCAL_PORT + 1))
        "$AUTOSSH" \
            -M "$monitor_port" \
            -o "ServerAliveInterval=30" \
            -o "ServerAliveCountMax=3" \
            -o "ExitOnForwardFailure=yes" \
            -o "ConnectTimeout=10" \
            -o "BatchMode=yes" \
            -N -R "${REMOTE_PORT}:localhost:${LOCAL_PORT}" "$SSH_ALIAS" \
            >> "$LOG_FILE" 2>&1 &
    else
        # Fallback: plain SSH with retry loop
        (
            while true; do
                log_msg "Connecting $SSH_ALIAS -R ${REMOTE_PORT}:localhost:${LOCAL_PORT}..."
                ssh -o "ServerAliveInterval=30" \
                    -o "ServerAliveCountMax=3" \
                    -o "ExitOnForwardFailure=yes" \
                    -o "ConnectTimeout=10" \
                    -o "BatchMode=yes" \
                    -N -R "${REMOTE_PORT}:localhost:${LOCAL_PORT}" "$SSH_ALIAS" \
                    >> "$LOG_FILE" 2>&1
                log_msg "SSH exited (code=$?). Retrying in 5s..."
                sleep 5
            done
        ) &
    fi

    echo $! > "$PID_FILE"
    log_msg "Daemon started (PID=$(cat "$PID_FILE"), autossh=$([ -n "$AUTOSSH" ] && echo true || echo false))"

    echo "[tunnel] Started (PID $(cat "$PID_FILE"))"
    echo "  localhost:$LOCAL_PORT <--> $SSH_ALIAS:$REMOTE_PORT"

    sleep 2
    if remote_port_open; then
        echo "  VPS port :$REMOTE_PORT confirmed listening"
    else
        echo "  VPS port :$REMOTE_PORT not yet confirmed (may need a moment)"
    fi
}

# ── Stop ─────────────────────────────────────────────────────
do_stop() {
    if ! is_running; then
        echo "[tunnel] Not running."
        return 0
    fi

    local pid
    pid=$(cat "$PID_FILE")
    log_msg "Stopping daemon (PID=$pid)..."

    # Kill the wrapper process
    kill "$pid" 2>/dev/null || true
    sleep 1

    # Clean up any orphaned ssh/autossh
    pkill -f "ssh.*-R.*${REMOTE_PORT}:localhost:${LOCAL_PORT}" 2>/dev/null || true
    [ -n "$AUTOSSH" ] && pkill -f "autossh.*${REMOTE_PORT}:localhost:${LOCAL_PORT}" 2>/dev/null || true

    rm -f "$PID_FILE"
    log_msg "Daemon stopped."
    echo "[tunnel] Stopped."
}

# ── Status ───────────────────────────────────────────────────
do_status() {
    echo "=== OpenCode Tunnel Status ==="
    echo "  Local port : $LOCAL_PORT"
    echo "  Remote port: $REMOTE_PORT"
    echo "  SSH alias  : $SSH_ALIAS"

    if [ -n "$AUTOSSH" ]; then
        echo "  autossh    : $AUTOSSH"
    else
        echo "  autossh    : not found (fallback: ssh retry loop)"
    fi

    if is_running; then
        echo "  Daemon PID : $(cat "$PID_FILE")"
    else
        echo "  Daemon PID : not running"
    fi

    # Check local OpenCode
    if curl -sf "http://127.0.0.1:${LOCAL_PORT}/global/health" > /dev/null 2>&1; then
        echo "  Local OC   : healthy"
    else
        echo "  Local OC   : UNREACHABLE"
    fi

    # Check remote port
    if remote_port_open 2>/dev/null; then
        echo "  VPS port   : listening on :$REMOTE_PORT"
    else
        echo "  VPS port   : NOT listening (tunnel may be down)"
    fi

    echo ""
    if [ -f "$LOG_FILE" ]; then
        echo "  Recent log:"
        tail -5 "$LOG_FILE" | while read -r line; do
            echo "    $line"
        done
    fi
}

# ── Logs ─────────────────────────────────────────────────────
do_logs() {
    if [ -f "$LOG_FILE" ]; then
        tail -40 "$LOG_FILE"
    else
        echo "No log file at $LOG_FILE"
    fi
}

# ── Dispatch ─────────────────────────────────────────────────
case "${1:-status}" in
    start)  do_start ;;
    stop)   do_stop ;;
    status) do_status ;;
    logs)   do_logs ;;
    *)
        echo "Usage: $0 {start|stop|status|logs}"
        exit 1
        ;;
esac
