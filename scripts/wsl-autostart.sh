#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
STATE_DIR="${HOME}/.local/state/resume-tailor"
LOG_FILE="${STATE_DIR}/server.log"
LOCK_FILE="${STATE_DIR}/autostart.lock"
PORT="${PORT:-8787}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/ping"
MODE="${1:---keepalive}"

source "${SCRIPT_DIR}/runtime.sh"
resume_tailor_configure_runtime
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

mkdir -p "${STATE_DIR}"

check_health() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf --max-time 2 "${HEALTH_URL}" >/dev/null 2>&1
    return $?
  fi
  "${NODE_BIN}" -e "
    fetch('${HEALTH_URL}', { signal: AbortSignal.timeout(1500) })
      .then((r) => process.exit(r.ok ? 0 : 1))
      .catch(() => process.exit(1));
  " >/dev/null 2>&1
}

wait_for_health() {
  local tries="${1:-25}"
  for _ in $(seq 1 "${tries}"); do
    if check_health; then
      return 0
    fi
    sleep 0.3
  done
  return 1
}

start_server_if_needed() {
  if check_health; then
    return 0
  fi

  # Wait briefly for systemd --user bus on cold WSL boot
  for _ in $(seq 1 10); do
    if [ -S "${XDG_RUNTIME_DIR}/bus" ]; then
      break
    fi
    sleep 0.25
  done

  if [ -S "${XDG_RUNTIME_DIR}/bus" ] && systemctl --user list-unit-files resume-tailor.service >/dev/null 2>&1; then
    systemctl --user start resume-tailor.service >/dev/null 2>&1 || true
    if wait_for_health 20; then
      return 0
    fi
  fi

  # Fallback when systemd user bus isn't active on a non-PAM cold boot
  cd "${PROJECT_DIR}"
  nohup "${SCRIPT_DIR}/start-server.sh" >>"${LOG_FILE}" 2>&1 </dev/null &
  wait_for_health 25 || true
}

# Prevent duplicate keepalive instances
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  # Another instance already holds the lock; just make sure server is up
  start_server_if_needed
  exit 0
fi

start_server_if_needed

if [ "${MODE}" = "--keepalive" ]; then
  # Keep a lightweight foreground handle alive so WSL2 does not auto-shutdown after 8s idle
  # and periodically verify the server stays up if not managed by systemd
  while true; do
    sleep 30
    if ! check_health; then
      start_server_if_needed
    fi
  done
fi
