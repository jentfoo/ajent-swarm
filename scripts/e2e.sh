#!/usr/bin/env bash
# E2E smoke: build ajent and swarm, start the fake provider and the service,
# drive one turn through the real UI with Playwright. Requires pnpm with
# @playwright/test installed (pnpm exec playwright install chromium once).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD

AJENT_DIR=${AJENT_DIR:-$ROOT/../ajent}
PORT=${SWARM_PORT:-8382}
PROVIDER_PORT=${FAKE_PROVIDER_PORT:-8391}
export SWARM_URL="http://127.0.0.1:$PORT"
export SWARM_PASSWORD=${SWARM_PASSWORD:-smoke-secret}
export FAKE_PROVIDER_PORT=$PROVIDER_PORT

command -v go >/dev/null || { echo "go is required" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }
[ -d "$AJENT_DIR" ] || { echo "ajent checkout missing at $AJENT_DIR (set AJENT_DIR)" >&2; exit 1; }

cleanup() {
  trap - EXIT INT TERM
  [ -n "${SWARM_PID:-}" ] && kill "$SWARM_PID" 2>/dev/null || true
  [ -n "${PROVIDER_PID:-}" ] && kill "$PROVIDER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> building ajent"
go -C "$AJENT_DIR" build -o "$ROOT/bin/e2e-ajent" .

echo "==> building swarm (embedded frontend)"
mkdir -p bin
make build >/dev/null
cp bin/ajent-swarm bin/e2e-swarm

export SWARM_USER=$(id -un)
export SWARM_WORKSPACE=$(mktemp -d /tmp/swarm-e2e-ws.XXXXXX)

HOME_DIR=$(mktemp -d /tmp/swarm-e2e-home.XXXXXX)
mkdir -p "$HOME_DIR"
cat > "$HOME_DIR/models.json" <<EOF
{
  "version": 1,
  "providers": {
    "fake": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:$PROVIDER_PORT/v1",
      "apiKey": "dummy",
      "models": [{"id": "fake-model", "contextWindow": 8192}]
    }
  }
}
EOF

echo "==> starting fake provider"
node scripts/fake-provider.mjs &
PROVIDER_PID=$!

echo "==> starting swarm on $SWARM_URL"
# --password no longer takes a value; headless starts read AJENT_SWARM_PASSWORD.
# stdin stays redirected so an interactive run never triggers the prompt path.
AJENT_HOME="$HOME_DIR" AJENT_SWARM_PASSWORD="$SWARM_PASSWORD" \
  bin/e2e-swarm --port "$PORT" --host 127.0.0.1 \
  --password --ajent-bin "$ROOT/bin/e2e-ajent" </dev/null &
SWARM_PID=$!

for _ in $(seq 1 100); do
  # the service is up once the auth gate answers, 401 included: /api/me
  # refuses anonymous callers by design
  code=$(curl -s -o /dev/null -w '%{http_code}' "$SWARM_URL/api/me" 2>/dev/null || true)
  [ "$code" = "401" ] || [ "$code" = "200" ] && break
  sleep 0.2
done
code=$(curl -s -o /dev/null -w '%{http_code}' "$SWARM_URL/api/me" 2>/dev/null || true)
{ [ "$code" = "401" ] || [ "$code" = "200" ]; } || { echo "swarm never answered" >&2; exit 1; }

echo "==> running playwright"
cd web
pnpm exec playwright test "$@"
