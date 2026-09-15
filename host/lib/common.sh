#!/bin/bash
# Shared helpers for the macOS host scripts.
#
# Two rules this file exists to enforce:
#   1. Never hardcode a tool's path. Every binary is probed, and a missing one
#      aborts with the reason instead of failing later in a confusing place.
#   2. Never report success without checking. Every step that changes something
#      is followed by an independent check that it actually changed.

set -u -o pipefail

COCKPIT_LOG_PREFIX="${COCKPIT_LOG_PREFIX:-cockpit}"

log()  { printf '[%s] %s\n' "$COCKPIT_LOG_PREFIX" "$*"; }
warn() { printf '[%s] WARNING: %s\n' "$COCKPIT_LOG_PREFIX" "$*" >&2; }
die()  { printf '[%s] ABORT: %s\n' "$COCKPIT_LOG_PREFIX" "$*" >&2; exit 1; }

# --- tool probing ----------------------------------------------------------

# The Tailscale CLI is not on PATH when Tailscale comes from the App Store or as
# the standalone app; it lives inside the bundle. Probe, never assume.
probe_tailscale() {
  local candidate
  for candidate in \
    "$(command -v tailscale 2>/dev/null || true)" \
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    "/usr/local/bin/tailscale" \
    "/opt/homebrew/bin/tailscale"
  do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

# /usr/bin/git is a shim that resolves through xcode-select. When the active
# developer directory is Xcode.app and its licence has not been accepted, every
# git call fails with exit 69 and costs ~90ms. Prefer a git that works.
probe_git() {
  local candidate
  for candidate in \
    "/opt/homebrew/bin/git" \
    "/Library/Developer/CommandLineTools/usr/bin/git" \
    "$(command -v git 2>/dev/null || true)"
  do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    "$candidate" --version >/dev/null 2>&1 && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

probe_node() {
  local candidate
  candidate="$(command -v node 2>/dev/null || true)"
  [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

# A user's shell may define an `opencode` function that wins over PATH, so a
# PATH wrapper is not a reliable way to reach the real binary. Resolve the file.
probe_opencode() {
  local candidate
  candidate="$(command -v opencode 2>/dev/null || true)"
  [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  for candidate in "$HOME"/.nvm/versions/node/*/bin/opencode "$HOME"/.opencode/bin/opencode \
                   /opt/homebrew/bin/opencode /usr/local/bin/opencode; do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

require_node_major() {
  local node_bin="$1" minimum="$2" actual
  actual="$("$node_bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" \
    || die "cannot read the version of $node_bin"
  [ "$actual" -ge "$minimum" ] || die "node >= $minimum required, found $actual at $node_bin"
}

# --- tailnet facts ---------------------------------------------------------

# The host name is read from the running daemon rather than written into the
# scripts, so renaming the machine in the Tailscale console does not strand the
# deployment. Returns the name without its trailing dot.
tailnet_dns_name() {
  local ts_bin="$1"
  "$ts_bin" status --json 2>/dev/null | "$2" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const name = JSON.parse(raw)?.Self?.DNSName ?? "";
        process.stdout.write(name.replace(/\.$/, ""));
      } catch { process.stdout.write(""); }
    });
  '
}

tailnet_ipv4() {
  local ts_bin="$1"
  "$ts_bin" ip -4 2>/dev/null | head -1 | tr -d '[:space:]'
}

# --- verification helpers --------------------------------------------------

port_listener() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}'
}

require_port_free() {
  local port="$1" owner
  owner="$(port_listener "$port")"
  [ -z "$owner" ] || die "port $port is already served by $owner; choose another port or stop it first"
}

wait_for_port() {
  local port="$1" timeout="${2:-15}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    [ -n "$(port_listener "$port")" ] && return 0
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

random_hex() {
  local bytes="${1:-32}"
  /usr/bin/openssl rand -hex "$bytes" 2>/dev/null || die "openssl is required to generate credentials"
}

# Writes a file with restrictive permissions, creating parents, and verifies the
# result rather than trusting the redirect.
write_private_file() {
  local path="$1" content="$2"
  mkdir -p "$(dirname "$path")" || die "cannot create $(dirname "$path")"
  printf '%s' "$content" > "$path" || die "cannot write $path"
  chmod 600 "$path" || die "cannot chmod $path"
  [ -s "$path" ] || die "$path is empty after writing"
}
