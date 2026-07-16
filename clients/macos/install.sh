#!/bin/zsh

set -euo pipefail

source_directory="${0:A:h}"
bin_directory="$HOME/.local/bin"
lib_directory="$HOME/.local/lib/opencode-relay"
controller="$bin_directory/opencode-relay-server"
core="$bin_directory/opencode-relay-server-core"

mkdir -p "$bin_directory" "$lib_directory"
chmod 700 "$HOME/.local" "$lib_directory" 2>/dev/null || true

if [[ ! -x "$core" ]]; then
  [[ -x "$controller" ]] || { print -u2 -- 'Existing relay controller was not found.'; exit 10; }
  if grep -q 'Product-level relay orchestration' "$controller"; then
    print -u2 -- 'Relay core is missing and the installed controller is already an orchestrator.'
    exit 10
  fi
  /usr/bin/install -m 755 "$controller" "$core"
fi

/opt/homebrew/bin/node --check "$source_directory/opencode-machine-auth.mjs"
/opt/homebrew/bin/node --check "$source_directory/opencode-machine-agent.mjs"
/bin/zsh -n "$source_directory/opencode-relay-server"
/bin/zsh -n "$source_directory/opencode-machine-agent"
/bin/zsh -n "$source_directory/opencode-launch"

/usr/bin/install -m 700 "$source_directory/opencode-machine-auth.mjs" "$lib_directory/opencode-machine-auth.mjs"
/usr/bin/install -m 700 "$source_directory/opencode-machine-agent.mjs" "$lib_directory/opencode-machine-agent.mjs"
/usr/bin/install -m 755 "$source_directory/opencode-machine-agent" "$bin_directory/opencode-machine-agent"
/usr/bin/install -m 755 "$source_directory/opencode-relay-server" "$controller"
/usr/bin/install -m 755 "$source_directory/opencode-launch" "$bin_directory/opencode-launch"

print -r -- 'Installed OpenCode relay OAuth orchestrator for macOS.'
