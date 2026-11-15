#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${DIGI_DX_COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"
ENV_FILE="${DIGI_DX_ENV_FILE:-$SCRIPT_DIR/.env}"
CONTAINER_NAME="${DIGI_DX_CONTAINER_NAME:-digi-dx-edge}"
READINESS_URL="${DIGI_DX_READINESS_URL:-http://127.0.0.1:8792/api/update-readiness}"
MIN_IDLE_SECONDS="${DIGI_DX_MIN_IDLE_SECONDS:-1800}"
MIN_UPTIME_SECONDS="${DIGI_DX_MIN_UPTIME_SECONDS:-60}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

TARGET_IMAGE="${DIGI_DX_EDGE_IMAGE:-ghcr.io/mpmbq2/digi-dx-edge:latest}"

is_container_running() {
  local running
  running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo "false")"
  [[ "$running" == "true" ]]
}

check_ready() {
  if ! is_container_running; then
    return 0
  fi

  local payload
  if ! payload="$(curl -fsS --max-time 5 "${READINESS_URL}?minIdleSeconds=${MIN_IDLE_SECONDS}&minUptimeSeconds=${MIN_UPTIME_SECONDS}")"; then
    echo "update-edge: readiness endpoint unreachable at ${READINESS_URL}; deferring update"
    return 1
  fi

  local verdict
  verdict="$(
    printf '%s' "$payload" | python3 -c '
import json, sys
data = json.load(sys.stdin)
ready = "true" if data.get("ready") is True else "false"
reason = data.get("reason", "unknown")
idle = data.get("idleSeconds")
print(f"{ready}|{reason}|{idle}")
'
  )"

  local ready reason idle
  IFS='|' read -r ready reason idle <<<"$verdict"
  if [[ "$ready" != "true" ]]; then
    echo "update-edge: deferring update (reason=${reason}, idleSeconds=${idle}, required=${MIN_IDLE_SECONDS}s)"
    return 1
  fi

  return 0
}

# 1. Avoid pulling or disrupting anything mid-session.
if ! check_ready; then
  exit 0
fi

CURRENT_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"

echo "update-edge: checking ${TARGET_IMAGE}"
docker compose -f "$COMPOSE_FILE" pull -q digi-dx-edge

NEW_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$TARGET_IMAGE" 2>/dev/null || true)"
if [[ -n "$CURRENT_IMAGE_ID" && "$CURRENT_IMAGE_ID" == "$NEW_IMAGE_ID" ]] && is_container_running; then
  echo "update-edge: already running latest image (${NEW_IMAGE_ID})"
  exit 0
fi

# 2. Re-check readiness in case a session/TX started while the image was downloading.
if ! check_ready; then
  echo "update-edge: downloaded ${NEW_IMAGE_ID}, waiting for >= ${MIN_IDLE_SECONDS}s idle before restart"
  exit 0
fi

echo "update-edge: updating ${CONTAINER_NAME} (${CURRENT_IMAGE_ID:-none} -> ${NEW_IMAGE_ID})"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans digi-dx-edge
docker image prune -f >/dev/null 2>&1 || true
