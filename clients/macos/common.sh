#!/bin/zsh

# Shared macOS primitives for the OpenCode relay controller. This file is
# sourced by the thin command scripts and intentionally never prints secrets.

setopt pipe_fail
zmodload zsh/datetime
umask 077

RELAY_CONFIG_DIR="${OPENCODE_RELAY_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode-relay}"
RELAY_ENV_FILE="$RELAY_CONFIG_DIR/env"
RELAY_INSTALL_FILE="$RELAY_CONFIG_DIR/installation.json"
RELAY_STATE_ROOT="${OPENCODE_RELAY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/opencode-relay}"
RELAY_STATE_FILE="$RELAY_STATE_ROOT/server-state.json"
RELAY_CLIENT_ROOT="$RELAY_STATE_ROOT/clients"
RELAY_LOG_ROOT="$RELAY_STATE_ROOT/logs"
RELAY_LOCK_FILE="$RELAY_STATE_ROOT/lock"
RELAY_BIN_DIR="${OPENCODE_RELAY_BIN_DIR:-$HOME/.local/bin}"
RELAY_LIB_DIR="${OPENCODE_RELAY_LIB_DIR:-$HOME/.local/lib/opencode-relay}"
RELAY_HOST="127.0.0.1"
RELAY_PORT=4096
RELAY_REAL_OPENCODE=""
RELAY_NODE=""
RELAY_DAEMON_LAUNCHER="$RELAY_LIB_DIR/opencode-daemon-launcher.mjs"
RELAY_TUNNEL_SCRIPT="$RELAY_BIN_DIR/opencode-frp-tunnel"
RELAY_CONTROLLER="$RELAY_BIN_DIR/opencode-relay-server"

relay_private_file() {
  local path="$1" mode owner
  [[ -f "$path" ]] || return 1
  mode=$(/usr/bin/stat -f '%Lp' "$path" 2>/dev/null) || return 1
  owner=$(/usr/bin/stat -f '%u' "$path" 2>/dev/null) || return 1
  [[ "$mode" == 600 && "$owner" == "$EUID" ]]
}

relay_load_config() {
  if ! relay_private_file "$RELAY_ENV_FILE"; then
    print -u2 -- 'OpenCode relay credential store is missing, has the wrong owner, or is not mode 600.'
    return 10
  fi
  if ! relay_private_file "$RELAY_INSTALL_FILE"; then
    print -u2 -- 'OpenCode relay installation metadata is missing, has the wrong owner, or is not mode 600.'
    return 10
  fi

  source "$RELAY_ENV_FILE"
  RELAY_PORT="${OPENCODE_SERVER_PORT:-4096}"
  RELAY_TUNNEL_SCRIPT="${OPENCODE_TUNNEL_SCRIPT:-$RELAY_TUNNEL_SCRIPT}"
  RELAY_REAL_OPENCODE="${OPENCODE_REAL_CMD:-$(jq -r '.realOpenCode // empty' "$RELAY_INSTALL_FILE" 2>/dev/null)}"
  RELAY_NODE="${OPENCODE_NODE:-$(jq -r '.node // empty' "$RELAY_INSTALL_FILE" 2>/dev/null)}"

  local machine_file="$RELAY_CONFIG_DIR/machine.json"
  if relay_private_file "$machine_file"; then
    : "${OPENCODE_RELAY_ORIGIN:=$(jq -r '.relayOrigin // empty' "$machine_file" 2>/dev/null)}"
    : "${OPENCODE_RELAY_SSH_ALIAS:=$(jq -r '.sshAlias // empty' "$machine_file" 2>/dev/null)}"
  fi
  export OPENCODE_RELAY_ORIGIN OPENCODE_RELAY_SSH_ALIAS

  if [[ "$RELAY_PORT" != <1-65535> ]]; then
    print -u2 -- 'OPENCODE_SERVER_PORT must be an integer from 1 through 65535.'
    return 10
  fi
  if [[ -z "${OPENCODE_SERVER_USERNAME:-}" || -z "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
    print -u2 -- 'OpenCode relay credentials are incomplete.'
    return 10
  fi
  if [[ ! -x "$RELAY_REAL_OPENCODE" || "$RELAY_REAL_OPENCODE" -ef "$RELAY_BIN_DIR/opencode" ]]; then
    print -u2 -- 'Configured OpenCode executable is missing or resolves back to the relay wrapper.'
    return 10
  fi
  if [[ ! -x "$RELAY_NODE" ]]; then
    print -u2 -- 'Configured Node executable was not found.'
    return 10
  fi
  for command in jq curl lsof; do
    command -v "$command" >/dev/null 2>&1 || { print -u2 -- "Required command is missing: $command"; return 10; }
  done
  mkdir -p "$RELAY_STATE_ROOT" "$RELAY_CLIENT_ROOT" "$RELAY_LOG_ROOT"
  chmod 700 "$RELAY_STATE_ROOT" "$RELAY_CLIENT_ROOT" "$RELAY_LOG_ROOT"
}

relay_lock_acquire() {
  local timeout="${1:-20}"
  : >> "$RELAY_LOCK_FILE"
  chmod 600 "$RELAY_LOCK_FILE"
  zmodload zsh/system || return 10
  if ! zsystem flock -t "$timeout" -f RELAY_LOCK_FD "$RELAY_LOCK_FILE"; then
    print -u2 -- 'Relay mutex acquisition timed out.'
    return 10
  fi
}

relay_lock_release() {
  if [[ -n "${RELAY_LOCK_FD:-}" ]]; then
    zsystem flock -u "$RELAY_LOCK_FD" 2>/dev/null || true
    unset RELAY_LOCK_FD
  fi
}

relay_process_json() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null || return 1
  local created executable parent pgid process_command
  created=$(/bin/ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//')
  executable=$(/bin/ps -p "$pid" -o comm= 2>/dev/null | sed 's/^ *//;s/ *$//')
  parent=$(/bin/ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
  pgid=$(/bin/ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ')
  process_command=$(/bin/ps -p "$pid" -o command= 2>/dev/null)
  [[ -n "$created" && -n "$executable" && "$parent" == <1-> && "$pgid" == <1-> ]] || return 1
  jq -cn --argjson pid "$pid" --arg created "$created" --arg executable "$executable" \
    --argjson parentPid "$parent" --argjson pgid "$pgid" --arg command "$process_command" \
    '{pid:$pid,created:$created,executable:$executable,parentPid:$parentPid,pgid:$pgid,command:$command}'
}

relay_process_matches() {
  local expected="$1" current pid
  pid=$(jq -r '.pid // 0' <<< "$expected")
  current=$(relay_process_json "$pid") || return 1
  [[ "$(jq -r '.created' <<< "$current")" == "$(jq -r '.created' <<< "$expected")" ]] || return 1
  [[ "$(jq -r '.executable' <<< "$current")" == "$(jq -r '.executable' <<< "$expected")" ]] || return 1
  [[ "$(jq -r '.parentPid' <<< "$current")" == "$(jq -r '.parentPid' <<< "$expected")" ]] || return 1
  [[ "$(jq -r '.pgid' <<< "$current")" == "$(jq -r '.pgid' <<< "$expected")" ]] || return 1
}

relay_listener_pids() {
  lsof -nP -iTCP:"$RELAY_PORT" -sTCP:LISTEN -Fp 2>/dev/null | sed -n 's/^p//p' | sort -nu
}

relay_urlencode() {
  jq -nr --arg value "$1" '$value | @uri'
}

relay_http() {
  local method="$1" request_path="$2" body="${3:-}" timeout="${4:-3}"
  local tmp http_code
  tmp=$(mktemp "$RELAY_STATE_ROOT/.http.XXXXXX") || return 1
  chmod 600 "$tmp"
  local -a args
  args=(--silent --show-error --max-time "$timeout" --output "$tmp" --write-out '%{http_code}' --request "$method")
  if [[ -n "$body" ]]; then
    args+=(--header 'Content-Type: application/json' --data-binary "$body")
  fi
  http_code=$(
    {
      print -r -- 'user-agent = "opencode-relay-macos/1"'
      print -r -- "user = \"$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD\""
    } | curl --config - "${args[@]}" "http://$RELAY_HOST:$RELAY_PORT$request_path" 2>/dev/null
  )
  local curl_status=$?
  RELAY_HTTP_STATUS="${http_code:-000}"
  RELAY_HTTP_BODY=$(<"$tmp")
  rm -f "$tmp"
  return "$curl_status"
}

relay_probe() {
  RELAY_PROBE_READY=false
  RELAY_PROBE_VERSION=""
  relay_http GET '/global/health' '' 3 || return 1
  local health_status="$RELAY_HTTP_STATUS" health_body="$RELAY_HTTP_BODY"
  relay_http GET '/config' '' 3 || return 1
  local config_status="$RELAY_HTTP_STATUS"
  if [[ "$health_status" == 200 && "$config_status" == 200 ]] \
      && jq -e '.healthy == true' >/dev/null 2>&1 <<< "$health_body"; then
    RELAY_PROBE_READY=true
    RELAY_PROBE_VERSION=$(jq -r '.version // empty' <<< "$health_body")
    [[ -n "$RELAY_PROBE_VERSION" ]]
    return
  fi
  return 1
}

relay_anonymous_health_status() {
  local http_code
  http_code=$(curl --silent --output /dev/null --max-time 3 --write-out '%{http_code}' \
    "http://$RELAY_HOST:$RELAY_PORT/global/health" 2>/dev/null) || true
  print -n -- "${http_code:-000}"
}

relay_read_state() {
  [[ -f "$RELAY_STATE_FILE" ]] || return 1
  jq -e '(.schema == 1) and (.state | type == "string") and (.generation | type == "number") and (.generation >= 0) and ((.backend == null) or ((.backend.pid|type)=="number" and (.backend.created|type)=="string" and (.backend.executable|type)=="string" and (.backend.port|type)=="number" and (.backend.version|type)=="string"))' "$RELAY_STATE_FILE" >/dev/null 2>&1 || return 1
  jq -c . "$RELAY_STATE_FILE"
}

relay_write_state() {
  local state="$1" generation="$2" backend="${3:-null}" last_error="${4:-}"
  local tmp
  tmp=$(mktemp "$RELAY_STATE_ROOT/.server-state.XXXXXX") || return 1
  chmod 600 "$tmp"
  jq -cn --arg state "$state" --argjson generation "$generation" --argjson backend "$backend" --arg lastError "$last_error" \
    '{schema:1,state:$state,generation:$generation,backend:$backend} + (if $lastError == "" then {} else {lastError:$lastError} end)' > "$tmp" \
    || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$RELAY_STATE_FILE"
}

relay_backend_identity() {
  local backend="$1"
  RELAY_IDENTITY_STATUS="Stale"
  local pid pids current
  pid=$(jq -r '.pid // 0' <<< "$backend")
  pids=(${(f)"$(relay_listener_pids)"})
  if (( ${#pids[@]} == 0 )); then RELAY_IDENTITY_STATUS="Absent"; return 1; fi
  if (( ${#pids[@]} != 1 )); then RELAY_IDENTITY_STATUS="Conflict"; return 1; fi
  if [[ "${pids[1]}" != "$pid" ]]; then RELAY_IDENTITY_STATUS="Foreign"; return 1; fi
  if ! relay_process_matches "$backend"; then RELAY_IDENTITY_STATUS="Stale"; return 1; fi
  if ! relay_probe; then RELAY_IDENTITY_STATUS="Unhealthy"; return 1; fi
  if [[ "$RELAY_PROBE_VERSION" != "$(jq -r '.version' <<< "$backend")" ]]; then
    RELAY_IDENTITY_STATUS="Unhealthy"
    return 1
  fi
  RELAY_IDENTITY_STATUS="Managed"
}

relay_status_json() {
  local state generation backend pid version backend_status ready warning=""
  state="Stopped"; generation=0; backend='null'; pid='null'; version='null'; backend_status="Absent"; ready=false
  local stored
  if stored=$(relay_read_state); then
    generation=$(jq -r '.generation' <<< "$stored")
    backend=$(jq -c '.backend' <<< "$stored")
    warning=$(jq -r '.lastError // empty' <<< "$stored")
    if [[ "$backend" == null ]]; then
      [[ "$(jq -r '.state' <<< "$stored")" == STOPPED ]] && state="Stopped" || state="$(jq -r '.state' <<< "$stored")"
    elif [[ "$(jq -r '.state' <<< "$stored")" == DEGRADED ]]; then
      state="DEGRADED"; backend_status="Unhealthy"
      pid=$(jq -r '.pid' <<< "$backend"); version=$(jq -r '.version' <<< "$backend")
    elif relay_backend_identity "$backend"; then
      state="Ready"; backend_status="Managed"; ready=true
      pid=$(jq -r '.pid' <<< "$backend"); version=$(jq -r '.version' <<< "$backend")
    else
      state="$RELAY_IDENTITY_STATUS"; [[ "$state" == Absent ]] && state="Stale"
      backend_status="$RELAY_IDENTITY_STATUS"; pid=$(jq -r '.pid' <<< "$backend"); version=$(jq -r '.version' <<< "$backend")
    fi
  else
    local pids
    pids=(${(f)"$(relay_listener_pids)"})
    if (( ${#pids[@]} == 1 )); then state="Foreign"; backend_status="Foreign"; pid="${pids[1]}"; fi
    if (( ${#pids[@]} > 1 )); then state="Conflict"; backend_status="Conflict"; fi
  fi
  local tunnel_status="Missing"
  [[ -x "$RELAY_TUNNEL_SCRIPT" ]] && tunnel_status="Configured"
  jq -cn --arg State "$state" --argjson Generation "$generation" --arg Status "$backend_status" \
    --argjson PID "$pid" --arg Version "$version" --argjson Port "$RELAY_PORT" --argjson Ready "$ready" \
    --arg TunnelStatus "$tunnel_status" --arg TunnelScript "$RELAY_TUNNEL_SCRIPT" --arg warning "$warning" \
    '{State:$State,Generation:$Generation,Backend:{Status:$Status,PID:$PID,Version:(if $Version=="null" or $Version=="" then null else $Version end),Port:$Port,Ready:$Ready},Tunnel:{Status:$TunnelStatus,Script:$TunnelScript},Warnings:(if $warning == "" then [] else [$warning] end)}'
}

relay_kill_verified_group() {
  local process="$1" grace="${2:-3}" pid pgid
  pid=$(jq -r '.pid' <<< "$process"); pgid=$(jq -r '.pgid' <<< "$process")
  relay_process_matches "$process" || return 6
  if [[ "$pgid" == "$pid" ]]; then
    /bin/kill -TERM -- "-$pgid" 2>/dev/null || true
  else
    /bin/kill -TERM "$pid" 2>/dev/null || true
  fi
  local end=$(( EPOCHSECONDS + grace ))
  while kill -0 "$pid" 2>/dev/null && (( EPOCHSECONDS < end )); do sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then
    relay_process_matches "$process" || return 6
    if [[ "$pgid" == "$pid" ]]; then
      /bin/kill -KILL -- "-$pgid" 2>/dev/null || true
    else
      /bin/kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  return 0
}

relay_wait_port_free() {
  local seconds="${1:-10}"
  local end=$(( EPOCHSECONDS + seconds ))
  while (( EPOCHSECONDS < end )); do
    [[ -z "$(relay_listener_pids)" ]] && return 0
    sleep 0.1
  done
  return 1
}

relay_spawn_backend() {
  local generation="$1" launch_id envelope handshake pid initial deadline pids current
  launch_id="$(date +%Y%m%dT%H%M%S)-$$-$RANDOM"
  local stdout="$RELAY_LOG_ROOT/backend-$launch_id.stdout.log" stderr="$RELAY_LOG_ROOT/backend-$launch_id.stderr.log"
  envelope=$(jq -cn --arg executable "$RELAY_REAL_OPENCODE" --arg stdoutPath "$stdout" --arg stderrPath "$stderr" --arg port "$RELAY_PORT" \
    '{executable:$executable,args:["serve","--hostname","127.0.0.1","--port",$port],stdoutPath:$stdoutPath,stderrPath:$stderrPath}')
  handshake=$(print -r -- "$envelope" \
    | OPENCODE_SERVER_USERNAME="$OPENCODE_SERVER_USERNAME" OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
      "$RELAY_NODE" "$RELAY_DAEMON_LAUNCHER") || return 7
  pid=$(jq -r '.pid // 0' <<< "$handshake" 2>/dev/null)
  [[ "$pid" == <1-> ]] || return 7
  sleep 0.1
  initial=$(relay_process_json "$pid") || return 7
  deadline=$(( EPOCHSECONDS + 20 ))
  while (( EPOCHSECONDS < deadline )); do
    pids=(${(f)"$(relay_listener_pids)"})
    if (( ${#pids[@]} > 1 )); then relay_kill_verified_group "$initial" 2; return 6; fi
    if (( ${#pids[@]} == 1 )); then
      if [[ "${pids[1]}" != "$pid" ]]; then relay_kill_verified_group "$initial" 2; return 6; fi
      current=$(relay_process_json "$pid") || break
      if [[ "$(jq -r '.created' <<< "$current")" != "$(jq -r '.created' <<< "$initial")" ]]; then break; fi
      local command_line
      command_line=$(jq -r '.command' <<< "$current")
      if [[ "$command_line" != *" serve "* || "$command_line" != *"--hostname 127.0.0.1"* \
          || "$command_line" != *"--port $RELAY_PORT"* ]]; then
        relay_kill_verified_group "$current" 2
        return 6
      fi
      if relay_probe; then
        local backend
        backend=$(jq -cn --argjson process "$current" --argjson port "$RELAY_PORT" --arg version "$RELAY_PROBE_VERSION" \
          '$process | {pid,created,executable,parentPid,pgid} + {port:$port,version:$version}')
        relay_write_state READY "$generation" "$backend"
        return 0
      fi
    fi
    sleep 0.2
  done
  relay_kill_verified_group "$initial" 2 || true
  return 7
}

relay_lease_valid() {
  local lease="$1" state_generation="$2" process
  [[ "$(jq -r '.schema // 0' <<< "$lease")" == 1 ]] || return 1
  [[ "$(jq -r '.backendGeneration // 0' <<< "$lease")" == "$state_generation" ]] || return 1
  process=$(jq -c '{pid,created,executable,parentPid,pgid}' <<< "$lease")
  relay_process_matches "$process"
}

relay_client_shutdown() {
  local state_generation="$1"
  local -a leases paths directories
  local lease_path lease directory encoded
  for lease_path in "$RELAY_CLIENT_ROOT"/*.json(N); do
    lease=$(jq -c . "$lease_path" 2>/dev/null) || { rm -f "$lease_path"; continue; }
    if relay_lease_valid "$lease" "$state_generation"; then
      paths+=("$lease_path"); leases+=("$lease"); directories+=("$(jq -r '.directory' <<< "$lease")")
    else
      rm -f "$lease_path"
    fi
  done
  local -a unique_directories
  unique_directories=(${(u)directories})
  for directory in "${unique_directories[@]}"; do
    encoded=$(relay_urlencode "$directory")
    relay_http POST "/tui/publish?directory=$encoded" \
      '{"type":"tui.command.execute","properties":{"command":"app.exit"}}' 3 || true
    relay_http GET "/session/status?directory=$encoded" '' 3 || continue
    if [[ "$RELAY_HTTP_STATUS" == 200 ]]; then
      local sid session_status
      while IFS=$'\t' read -r sid session_status; do
        [[ "$session_status" == busy || "$session_status" == retry ]] || continue
        relay_http POST "/session/$(relay_urlencode "$sid")/abort?directory=$encoded" '' 3 || true
      done < <(jq -r 'to_entries[] | [.key, (if (.value|type)=="string" then .value else (.value.type // "") end)] | @tsv' \
        <<< "$RELAY_HTTP_BODY" 2>/dev/null)
    fi
  done
  (( ${#leases[@]} > 0 )) && sleep 5
  local index current expected pid
  for (( index=1; index<=${#leases[@]}; index++ )); do
    lease_path="${paths[$index]}"; expected="${leases[$index]}"
    [[ -f "$lease_path" ]] || continue
    current=$(jq -c . "$lease_path" 2>/dev/null) || return 6
    [[ "$current" == "$expected" ]] || return 6
    if relay_lease_valid "$current" "$state_generation"; then
      pid=$(jq -r '.pid' <<< "$current")
      /bin/kill -TERM "$pid" 2>/dev/null || true
      local end=$(( EPOCHSECONDS + 2 ))
      while kill -0 "$pid" 2>/dev/null && (( EPOCHSECONDS < end )); do sleep 0.1; done
      if kill -0 "$pid" 2>/dev/null; then
        relay_lease_valid "$current" "$state_generation" || return 6
        /bin/kill -KILL "$pid" 2>/dev/null || true
      fi
    elif kill -0 "$(jq -r '.pid' <<< "$current")" 2>/dev/null; then
      return 6
    fi
    rm -f "$lease_path"
  done
}
