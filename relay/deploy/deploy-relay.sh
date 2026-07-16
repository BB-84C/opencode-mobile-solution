#!/usr/bin/env bash
# Deploy the OpenCode relay to a VPS over SSH.
#
# This is a starting point — review it against your own host layout before use.
# It NEVER bakes credentials into the repo: the device token and OpenCode server
# password are passed via environment variables and only for a first-time seed.
# An existing /etc/opencode-relay/tokens.json and passkeys.json are preserved.
#
# Usage:
#   RELAY_SSH_ALIAS=your-vps ./deploy-relay.sh
#
# First-time token seed (optional; afterwards manage devices from the Dashboard):
#   DEPLOY_RELAY_TOKENS=1 \
#   OPENCODE_SERVER_PASSWORD=... RELAY_DEVICE_TOKEN=... \
#   RELAY_SSH_ALIAS=your-vps ./deploy-relay.sh

set -euo pipefail

SSH_ALIAS="${RELAY_SSH_ALIAS:-your-vps}"
RELAY_DIR="$(cd "$(dirname "$0")/.." && pwd)"     # the relay/ source root
VPS_RELAY_DIR="${VPS_RELAY_DIR:-/opt/opencode-relay}"
VPS_CONFIG_DIR="${VPS_CONFIG_DIR:-/etc/opencode-relay}"
PUBLIC_ORIGIN="${RELAY_PUBLIC_ORIGIN:-https://opencode.example.com}"

TMP_BUNDLE="$(mktemp -t opencode-relay.XXXXXX.tar.gz)"
TMP_ENV="$(mktemp -t opencode-relay.XXXXXX.env)"
TMP_TOKENS=""
cleanup() { rm -f "$TMP_BUNDLE" "$TMP_ENV"; [ -n "$TMP_TOKENS" ] && rm -f "$TMP_TOKENS" || true; }
trap cleanup EXIT

echo "=== Deploying OpenCode Relay to '$SSH_ALIAS' ($PUBLIC_ORIGIN) ==="

# --- Optional first-time token seed -----------------------------------------
if [ "${DEPLOY_RELAY_TOKENS:-0}" = "1" ]; then
    : "${OPENCODE_SERVER_PASSWORD:?set OPENCODE_SERVER_PASSWORD for a token seed}"
    : "${RELAY_DEVICE_TOKEN:?set RELAY_DEVICE_TOKEN for a token seed}"
    TMP_TOKENS="$(mktemp -t opencode-relay.XXXXXX.tokens.json)"
    cat > "$TMP_TOKENS" <<EOF
{
  "tokens": {
    "my-iphone": {
      "token": "${RELAY_DEVICE_TOKEN}",
      "name": "My iPhone",
      "basic_user": "opencode",
      "basic_pass": "${OPENCODE_SERVER_PASSWORD}"
    }
  }
}
EOF
fi

# --- Bundle source (deps are installed on the VPS to match its platform) -----
COPYFILE_DISABLE=1 tar -C "$RELAY_DIR" \
    --exclude='./node_modules' \
    --exclude='./test' \
    --exclude='./tokens.json' \
    --exclude='./deploy' \
    --exclude='./reverse-proxy' \
    -czf "$TMP_BUNDLE" \
    relay.mjs lib package.json package-lock.json

# --- Build the environment file (without a bootstrap token; generated remotely)
{
    printf 'RELAY_PUBLIC_ORIGIN=%s\n' "$PUBLIC_ORIGIN"
    printf 'PASSKEY_STATE_PATH=%s/passkeys.json\n' "$VPS_CONFIG_DIR"
    [ -n "${PAIRING_SOURCE_CLIENT_ID:-}" ] && printf 'PAIRING_SOURCE_CLIENT_ID=%s\n' "$PAIRING_SOURCE_CLIENT_ID"
} > "$TMP_ENV"
chmod 600 "$TMP_ENV"

ssh "$SSH_ALIAS" "sudo mkdir -p '$VPS_RELAY_DIR' && sudo install -d -m 700 '$VPS_CONFIG_DIR'"

scp "$TMP_BUNDLE" "$SSH_ALIAS:/tmp/opencode-relay.tar.gz"
ssh "$SSH_ALIAS" "sudo tar -xzf /tmp/opencode-relay.tar.gz -C '$VPS_RELAY_DIR' \
    && rm -f /tmp/opencode-relay.tar.gz \
    && sudo npm ci --omit=dev --prefix '$VPS_RELAY_DIR' \
    && sudo chmod -R a+rX '$VPS_RELAY_DIR' \
    && sudo chmod 755 '$VPS_RELAY_DIR/relay.mjs'"

# --- Install env (first deploy only; a live relay.env is preserved) ----------
scp "$TMP_ENV" "$SSH_ALIAS:/tmp/opencode-relay.env"
ssh "$SSH_ALIAS" "set -e
if sudo test -f '$VPS_CONFIG_DIR/relay.env'; then
    echo 'Preserving existing $VPS_CONFIG_DIR/relay.env'
    sudo rm -f /tmp/opencode-relay.env
else
    sudo install -m 600 /tmp/opencode-relay.env '$VPS_CONFIG_DIR/relay.env'
    sudo rm -f /tmp/opencode-relay.env
    sudo sh -c 'printf \"PASSKEY_BOOTSTRAP_TOKEN=%s\n\" \"\$(openssl rand -hex 32)\" >> \"$VPS_CONFIG_DIR/relay.env\"'
    echo 'Generated a one-time PASSKEY_BOOTSTRAP_TOKEN on the VPS (never printed).'
fi"

# --- Install tokens (only when seeding); otherwise preserve live tokens.json --
if [ "${DEPLOY_RELAY_TOKENS:-0}" = "1" ]; then
    scp "$TMP_TOKENS" "$SSH_ALIAS:/tmp/tokens.json"
    ssh "$SSH_ALIAS" "sudo install -m 600 /tmp/tokens.json '$VPS_CONFIG_DIR/tokens.json' && rm -f /tmp/tokens.json"
else
    echo "Preserving existing $VPS_CONFIG_DIR/tokens.json (if any)"
fi

# --- Install + (re)start the systemd unit ------------------------------------
scp "$RELAY_DIR/opencode-relay.service" "$SSH_ALIAS:/tmp/opencode-relay.service"
ssh "$SSH_ALIAS" "sudo install -m 644 /tmp/opencode-relay.service /etc/systemd/system/opencode-relay.service \
    && rm -f /tmp/opencode-relay.service \
    && sudo systemctl daemon-reload \
    && sudo systemctl enable opencode-relay \
    && sudo systemctl restart opencode-relay"

echo "Waiting for relay health..."
sleep 2
ssh "$SSH_ALIAS" "curl -fsS http://127.0.0.1:4097/health"
echo
echo "=== Done. Configure your reverse proxy (see ../reverse-proxy/), then open $PUBLIC_ORIGIN ==="
