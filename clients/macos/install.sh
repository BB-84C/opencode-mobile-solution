#!/bin/zsh

set -euo pipefail

readonly SOURCE_DIRECTORY="${0:A:h}"
readonly FRP_VERSION="0.71.0"
# Pinned from the official release checksum manifest:
# https://github.com/fatedier/frp/releases/download/v0.71.0/frp_sha256_checksums.txt
readonly BIN_DIRECTORY="${OPENCODE_RELAY_BIN_DIR:-$HOME/.local/bin}"
readonly LIB_DIRECTORY="${OPENCODE_RELAY_LIB_DIR:-$HOME/.local/lib/opencode-relay}"
readonly CONFIG_DIRECTORY="${OPENCODE_RELAY_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode-relay}"
readonly STATE_DIRECTORY="${OPENCODE_RELAY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/opencode-relay}"
readonly INSTALLATION_FILE="$CONFIG_DIRECTORY/installation.json"
readonly ENV_FILE="$CONFIG_DIRECTORY/env"
readonly WRAPPER="$BIN_DIRECTORY/opencode"
readonly FRPC_DIRECTORY="$LIB_DIRECTORY/bin"
readonly FRPC_VERSIONED="$FRPC_DIRECTORY/frpc-$FRP_VERSION"
readonly FRPC_LINK="$FRPC_DIRECTORY/frpc"

action="${1:-install}"
case "$action" in
  install|update|uninstall|doctor) shift $(( $# > 0 ? 1 : 0 )) ;;
  *) action=install ;;
esac

relay_origin=""
ssh_alias=""
real_opencode=""
node_path=""
frpc_source=""
download_frpc=true
purge=false

usage() {
  cat <<'EOF'
Usage:
  ./install.sh install --relay-origin URL --ssh-alias HOST [options]
  ./install.sh update [options]
  ./install.sh doctor
  ./install.sh uninstall [--purge]

Options:
  --opencode PATH       Real OpenCode executable; required if discovery is ambiguous.
  --node PATH           Node 22+ executable.
  --frpc PATH           Use this frpc binary instead of downloading it.
  --no-frpc-download    Install scripts without downloading frpc.
  --relay-origin URL    Public HTTPS relay origin.
  --ssh-alias HOST      Host alias from ~/.ssh/config used to reach the VPS.
  --purge               Revoke the machine and delete credentials/state on uninstall.
EOF
}

fail() {
  print -u2 -- "[FAIL] $*"
  exit 10
}

while (( $# > 0 )); do
  case "$1" in
    --relay-origin) (( $# >= 2 )) || fail '--relay-origin requires a value'; relay_origin="$2"; shift 2 ;;
    --ssh-alias) (( $# >= 2 )) || fail '--ssh-alias requires a value'; ssh_alias="$2"; shift 2 ;;
    --opencode) (( $# >= 2 )) || fail '--opencode requires a value'; real_opencode="$2"; shift 2 ;;
    --node) (( $# >= 2 )) || fail '--node requires a value'; node_path="$2"; shift 2 ;;
    --frpc) (( $# >= 2 )) || fail '--frpc requires a value'; frpc_source="$2"; download_frpc=false; shift 2 ;;
    --no-frpc-download) download_frpc=false; shift ;;
    --purge) purge=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unsupported installer argument: $1" ;;
  esac
done

private_file() {
  local path="$1" owner
  [[ -f "$path" ]] || return 1
  owner=$(/usr/bin/stat -f '%u' "$path" 2>/dev/null) || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$path" 2>/dev/null)" == 600 && "$owner" == "$EUID" ]]
}

metadata_value() {
  local key="$1"
  private_file "$INSTALLATION_FILE" || return 1
  jq -r ".$key // empty" "$INSTALLATION_FILE" 2>/dev/null
}

discover_node() {
  local candidate="${node_path:-}"
  [[ -n "$candidate" ]] || candidate=$(command -v node 2>/dev/null || true)
  [[ -x "$candidate" ]] || fail 'Node was not found; pass --node with a Node 22+ executable.'
  node_path="${candidate:A}"
  local major
  major=$("$node_path" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null) || fail 'Node could not be executed.'
  (( major >= 22 )) || fail 'Node 22 or newer is required.'
}

managed_wrapper() {
  local path="$1"
  [[ -f "$path" ]] && /usr/bin/grep -q '^# opencode-relay-managed-wrapper v1$' "$path" 2>/dev/null
}

legacy_relay_wrapper() {
  local path="$1"
  [[ -f "$path" ]] || return 1
  /usr/bin/grep -q -- '--relay_server' "$path" 2>/dev/null \
    && /usr/bin/grep -q 'opencode-relay-server' "$path" 2>/dev/null \
    && /usr/bin/grep -q 'opencode-launch' "$path" 2>/dev/null
}

valid_real_opencode() {
  local candidate="$1"
  [[ -x "$candidate" ]] || return 1
  managed_wrapper "$candidate" && return 1
  [[ -e "$WRAPPER" && "$candidate" -ef "$WRAPPER" ]] && return 1
  return 0
}

discover_opencode() {
  if [[ -n "$real_opencode" ]]; then
    [[ -x "$real_opencode" ]] || fail "OpenCode is not executable: $real_opencode"
    real_opencode="${real_opencode:A}"
    return
  fi

  if private_file "$INSTALLATION_FILE"; then
    real_opencode=$(metadata_value realOpenCode || true)
    if valid_real_opencode "$real_opencode"; then real_opencode="${real_opencode:A}"; return; fi
    real_opencode=""
  fi

  if [[ -x "$WRAPPER" ]] && ! managed_wrapper "$WRAPPER"; then
    real_opencode="${WRAPPER:A}"
    return
  fi

  local directory candidate
  for directory in ${(s/:/)PATH}; do
    [[ -n "$directory" ]] || directory='.'
    candidate="$directory/opencode"
    if valid_real_opencode "$candidate"; then real_opencode="${candidate:A}"; return; fi
  done

  local npm_command npm_root
  npm_command=$(command -v npm 2>/dev/null || true)
  if [[ -x "$npm_command" ]]; then
    npm_root=$("$npm_command" root -g 2>/dev/null || true)
    for candidate in "$npm_root/opencode-ai/bin/opencode" "$npm_root/opencode-ai/bin/opencode.exe"; do
      if valid_real_opencode "$candidate"; then real_opencode="${candidate:A}"; return; fi
    done
  fi
  fail 'The original OpenCode executable could not be found. Pass --opencode PATH.'
}

install_atomic() {
  local source="$1" destination="$2" mode="$3" temporary
  mkdir -p "${destination:h}"
  temporary=$(mktemp "${destination:h}/.${destination:t}.XXXXXX")
  /usr/bin/install -m "$mode" "$source" "$temporary"
  mv -f "$temporary" "$destination"
}

write_installation_metadata() {
  local backup="$1" temporary
  temporary=$(mktemp "$CONFIG_DIRECTORY/.installation.XXXXXX")
  chmod 600 "$temporary"
  jq -cn --arg realOpenCode "$real_opencode" --arg node "$node_path" --arg wrapper "$WRAPPER" \
    --arg backup "$backup" --arg version 1 \
    '{schema:1,clientVersion:$version,realOpenCode:$realOpenCode,node:$node,wrapper:$wrapper,previousEntryBackup:(if $backup=="" then null else $backup end)}' \
    > "$temporary"
  mv -f "$temporary" "$INSTALLATION_FILE"
  chmod 600 "$INSTALLATION_FILE"
}

write_initial_environment() {
  if [[ -e "$ENV_FILE" ]]; then
    private_file "$ENV_FILE" || fail 'Existing relay env file must be owned by the current user and have mode 600.'
    return
  fi
  [[ "$relay_origin" == https://* || "$relay_origin" == http://127.0.0.1:* ]] \
    || fail 'A new install requires --relay-origin with an HTTPS URL.'
  [[ -n "$ssh_alias" ]] || fail 'A new install requires --ssh-alias.'
  local password temporary
  password=$(/usr/bin/openssl rand -hex 32)
  temporary=$(mktemp "$CONFIG_DIRECTORY/.env.XXXXXX")
  chmod 600 "$temporary"
  {
    printf 'OPENCODE_SERVER_PORT=%q\n' 4096
    printf 'OPENCODE_SERVER_USERNAME=%q\n' opencode
    printf 'OPENCODE_SERVER_PASSWORD=%q\n' "$password"
    printf 'OPENCODE_RELAY_ORIGIN=%q\n' "$relay_origin"
    printf 'OPENCODE_RELAY_SSH_ALIAS=%q\n' "$ssh_alias"
    printf 'OPENCODE_FRPC_BIN=%q\n' "$FRPC_LINK"
  } > "$temporary"
  mv -f "$temporary" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

install_frpc_from() {
  local source="$1"
  [[ -x "$source" ]] || fail "frpc is not executable: $source"
  mkdir -p "$FRPC_DIRECTORY"
  install_atomic "$source" "$FRPC_VERSIONED" 755
  ln -sfn "${FRPC_VERSIONED:t}" "$FRPC_LINK"
}

download_verified_frpc() {
  local architecture archive checksum
  architecture=$(/usr/bin/uname -m)
  case "$architecture" in
    arm64)
      archive="frp_${FRP_VERSION}_darwin_arm64.tar.gz"
      checksum="45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6"
      ;;
    x86_64)
      archive="frp_${FRP_VERSION}_darwin_amd64.tar.gz"
      checksum="1b1b4e2f1836e21e8733f1dddaacd4ed9ae67d7dbee39046b9d7b7eda6253637"
      ;;
    *) fail "Unsupported macOS architecture for bundled frpc: $architecture" ;;
  esac
  local temporary actual extracted
  temporary=$(mktemp -d "${TMPDIR:-/tmp}/opencode-frpc.XXXXXX")
  if ! curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    "https://github.com/fatedier/frp/releases/download/v$FRP_VERSION/$archive" \
    --output "$temporary/$archive"; then
    rm -rf "$temporary"
    fail 'Unable to download the pinned frpc release archive.'
  fi
  actual=$(/usr/bin/shasum -a 256 "$temporary/$archive" | awk '{print $1}')
  if [[ "$actual" != "$checksum" ]]; then
    rm -rf "$temporary"
    fail "frpc archive checksum mismatch for $archive"
  fi
  /usr/bin/tar -xzf "$temporary/$archive" -C "$temporary"
  extracted="$temporary/${archive%.tar.gz}/frpc"
  install_frpc_from "$extracted"
  rm -rf "$temporary"
}

install_client() {
  (( EUID != 0 )) || fail 'Install the macOS client as the target user, not root.'
  for command in jq curl lsof nc ssh; do
    command -v "$command" >/dev/null 2>&1 || fail "Required command is missing: $command"
  done
  discover_node
  discover_opencode

  mkdir -p "$BIN_DIRECTORY" "$LIB_DIRECTORY" "$CONFIG_DIRECTORY" "$STATE_DIRECTORY"
  chmod 700 "$BIN_DIRECTORY" "$LIB_DIRECTORY" "$CONFIG_DIRECTORY" "$STATE_DIRECTORY" 2>/dev/null || true
  write_initial_environment

  local backup="" real_was_wrapper=false legacy_archive=""
  typeset -g _install_rollback_entry=""
  typeset -g _install_rollback_generated=""
  typeset -g _install_complete=false
  rollback_install() {
    local exit_code=$?
    if ! $_install_complete && [[ -n "$_install_rollback_entry" ]]; then
      managed_wrapper "$WRAPPER" && rm -f "$WRAPPER"
      [[ ! -e "$WRAPPER" && -e "$_install_rollback_entry" ]] && mv "$_install_rollback_entry" "$WRAPPER"
      [[ -n "$_install_rollback_generated" && -L "$_install_rollback_generated" ]] && rm -f "$_install_rollback_generated"
    fi
    return "$exit_code"
  }
  trap rollback_install EXIT
  if private_file "$INSTALLATION_FILE"; then backup=$(metadata_value previousEntryBackup || true); fi
  if [[ -e "$WRAPPER" ]] && ! managed_wrapper "$WRAPPER"; then
    [[ "$real_opencode" -ef "$WRAPPER" ]] && real_was_wrapper=true
    mkdir -p "$CONFIG_DIRECTORY/backups"
    chmod 700 "$CONFIG_DIRECTORY/backups"
    backup="$CONFIG_DIRECTORY/backups/opencode.before-relay.$(date -u +%Y%m%dT%H%M%SZ)"
    if legacy_relay_wrapper "$WRAPPER" && ! $real_was_wrapper; then
      legacy_archive="$CONFIG_DIRECTORY/backups/opencode.legacy-relay.$(date -u +%Y%m%dT%H%M%SZ)"
      mv "$WRAPPER" "$legacy_archive"
      ln -s "$real_opencode" "$backup"
      _install_rollback_entry="$legacy_archive"
      _install_rollback_generated="$backup"
    else
      mv "$WRAPPER" "$backup"
      _install_rollback_entry="$backup"
      $real_was_wrapper && real_opencode="${backup:A}"
    fi
  fi
  valid_real_opencode "$real_opencode" || fail 'The selected OpenCode executable would recurse into the relay wrapper.'

  "$node_path" --check "$SOURCE_DIRECTORY/opencode-machine-auth.mjs"
  "$node_path" --check "$SOURCE_DIRECTORY/opencode-machine-agent.mjs"
  "$node_path" --check "$SOURCE_DIRECTORY/opencode-daemon-launcher.mjs"
  "$node_path" --check "$SOURCE_DIRECTORY/opencode-client-launcher.mjs"
  for script in opencode opencode-launch opencode-machine-agent opencode-relay-server \
      opencode-relay-server-core opencode-frp-tunnel; do
    /bin/zsh -n "$SOURCE_DIRECTORY/$script"
  done

  local rendered_wrapper
  rendered_wrapper=$(mktemp "$CONFIG_DIRECTORY/.opencode-wrapper.XXXXXX")
  "$node_path" -e 'const fs=require("node:fs"); const source=fs.readFileSync(process.argv[1],"utf8"); process.stdout.write(source.replace("\"__OPENCODE_REAL_CMD__\"",JSON.stringify(process.argv[2])));' \
    "$SOURCE_DIRECTORY/opencode" "$real_opencode" > "$rendered_wrapper"

  install_atomic "$rendered_wrapper" "$WRAPPER" 700
  rm -f "$rendered_wrapper"
  for script in opencode-launch opencode-machine-agent opencode-relay-server \
      opencode-relay-server-core opencode-frp-tunnel; do
    install_atomic "$SOURCE_DIRECTORY/$script" "$BIN_DIRECTORY/$script" 755
  done
  install_atomic "$SOURCE_DIRECTORY/common.sh" "$LIB_DIRECTORY/common.sh" 600
  for module in opencode-machine-auth.mjs opencode-machine-agent.mjs \
      opencode-daemon-launcher.mjs opencode-client-launcher.mjs; do
    install_atomic "$SOURCE_DIRECTORY/$module" "$LIB_DIRECTORY/$module" 600
  done

  if [[ -n "$frpc_source" ]]; then
    install_frpc_from "$frpc_source"
  elif [[ ! -x "$FRPC_VERSIONED" ]]; then
    if [[ "$download_frpc" == true ]]; then
      download_verified_frpc
    elif [[ "$action" == update ]]; then
      fail "Pinned frpc $FRP_VERSION is missing; update cannot retain a stale link."
    fi
  fi
  if [[ -x "$FRPC_VERSIONED" ]]; then
    ln -sfn "${FRPC_VERSIONED:t}" "$FRPC_LINK"
  elif [[ "$action" == update ]]; then
    fail "Pinned frpc $FRP_VERSION is missing after update."
  fi

  write_installation_metadata "$backup"
  _install_complete=true

  print -r -- "Installed the OpenCode relay client at $WRAPPER"
  print -r -- 'Run: opencode --relay_server start'
}

doctor() {
  local errors=0 real node backup linked_frpc_version linked_target
  private_file "$INSTALLATION_FILE" || { print -u2 -- '[FAIL] installation.json is missing or not private'; return 10; }
  real=$(metadata_value realOpenCode || true)
  node=$(metadata_value node || true)
  backup=$(metadata_value previousEntryBackup || true)
  managed_wrapper "$WRAPPER" || { print -u2 -- '[FAIL] managed wrapper is missing'; (( ++errors )); }
  [[ -x "$real" ]] || { print -u2 -- '[FAIL] original OpenCode executable is missing'; (( ++errors )); }
  [[ -e "$WRAPPER" && -e "$real" && "$WRAPPER" -ef "$real" ]] \
    && { print -u2 -- '[FAIL] wrapper recursion detected'; (( ++errors )); }
  [[ -x "$node" ]] || { print -u2 -- '[FAIL] configured Node executable is missing'; (( ++errors )); }
  private_file "$ENV_FILE" || { print -u2 -- '[FAIL] env credential file is missing or not private'; (( ++errors )); }
  if [[ ! -L "$FRPC_LINK" || ! -x "$FRPC_LINK" ]]; then
    print -u2 -- '[FAIL] pinned frpc link is missing or not executable'
    (( ++errors ))
  else
    linked_target="${FRPC_LINK:A}"
    if [[ "$linked_target" != "${FRPC_VERSIONED:A}" ]]; then
      print -u2 -- "[FAIL] FRPC link is stale: $linked_target"
      (( ++errors ))
    else
      linked_frpc_version=$("$FRPC_LINK" --version 2>/dev/null | /usr/bin/head -n 1 | /usr/bin/tr -d '\r' || true)
      if [[ "$linked_frpc_version" != "$FRP_VERSION" && "$linked_frpc_version" != "v$FRP_VERSION" ]]; then
        print -u2 -- "[FAIL] linked frpc reports stale version: ${linked_frpc_version:-unreadable}"
        (( ++errors ))
      else
        print -r -- "FRPC linked artifact: $linked_target (version $linked_frpc_version)"
      fi
    fi
  fi
  [[ -z "$backup" || -e "$backup" ]] || { print -u2 -- '[FAIL] original wrapper backup is missing'; (( ++errors )); }
  for command in jq curl lsof nc ssh; do
    command -v "$command" >/dev/null 2>&1 || { print -u2 -- "[FAIL] required command is missing: $command"; (( ++errors )); }
  done
  if (( errors == 0 )); then
    print -r -- 'OpenCode relay client installation: OK'
    [[ "$(command -v opencode 2>/dev/null || true)" == "$WRAPPER" ]] \
      || print -u2 -- "[WARN] $BIN_DIRECTORY is not first on PATH"
    return 0
  fi
  return 10
}

uninstall_client() {
  local backup="" node auth_module
  private_file "$INSTALLATION_FILE" || fail 'installation.json is missing or not private.'
  backup=$(metadata_value previousEntryBackup || true)
  node=$(metadata_value node || true)
  auth_module="$LIB_DIRECTORY/opencode-machine-auth.mjs"

  [[ -x "$BIN_DIRECTORY/opencode-relay-server" ]] \
    && "$BIN_DIRECTORY/opencode-relay-server" stop --json >/dev/null 2>&1 || true

  if $purge && [[ -f "$CONFIG_DIRECTORY/machine.json" ]]; then
    source "$LIB_DIRECTORY/common.sh" || fail 'Unable to load the installed relay client for revocation.'
    relay_load_config || fail 'Unable to load relay credentials for revocation.'
    OPENCODE_SERVER_USERNAME="$OPENCODE_SERVER_USERNAME" OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
      "$node" "$auth_module" revoke >/dev/null \
      || fail 'Machine revocation failed; credentials were retained. Retry while the relay is reachable.'
  fi

  if [[ -n "$backup" && ! -e "$backup" ]]; then
    fail 'The original opencode backup is missing; the managed wrapper was not removed.'
  fi
  if [[ -e "$WRAPPER" ]]; then
    managed_wrapper "$WRAPPER" || fail 'Refusing to remove an opencode entry not owned by this installer.'
    rm -f "$WRAPPER"
  fi
  if [[ -n "$backup" ]]; then
    mv "$backup" "$WRAPPER"
  fi

  for script in opencode-launch opencode-machine-agent opencode-relay-server \
      opencode-relay-server-core opencode-frp-tunnel; do
    rm -f "$BIN_DIRECTORY/$script"
  done
  rm -rf "$LIB_DIRECTORY"
  rm -f "$INSTALLATION_FILE"

  if $purge; then
    rm -rf "$CONFIG_DIRECTORY" "$STATE_DIRECTORY"
    print -r -- 'Uninstalled the OpenCode relay client and purged its revoked machine credential.'
  else
    print -r -- "Uninstalled the OpenCode relay client; credentials remain in $CONFIG_DIRECTORY"
  fi
}

case "$action" in
  install) install_client ;;
  update)
    private_file "$INSTALLATION_FILE" || fail 'Run install before update.'
    install_client
    ;;
  doctor) doctor ;;
  uninstall) uninstall_client ;;
esac
