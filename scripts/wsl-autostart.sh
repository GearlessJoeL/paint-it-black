#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
STATE_DIR="${HOME}/.local/state/resume-tailor"
LOG_FILE="${STATE_DIR}/server.log"
LOCK_FILE="${STATE_DIR}/autostart.lock"
PID_FILE="${STATE_DIR}/autostart.pid"
PORT="${PORT:-8787}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/ping"
MODE="${1:---keepalive}"
WAKE_REQUESTED=0

source "${SCRIPT_DIR}/runtime.sh"
resume_tailor_configure_runtime
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

umask 077
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
  nohup "${SCRIPT_DIR}/start-server.sh" >>"${LOG_FILE}" 2>&1 </dev/null 9>&- &
  wait_for_health 25 || true
}

# Prevent duplicate keepalive instances
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  # Wake the registered owner instead of spawning an untracked fallback server
  # from this duplicate process. Only the owner should manage server lifetime.
  owner_pid='' owner_script=''
  if [ -f "${PID_FILE}" ]; then
    { IFS= read -r owner_pid || true; IFS= read -r owner_script || true; } < "${PID_FILE}"
  fi
  case "${owner_pid}" in ''|*[!0-9]*) owner_pid='' ;; esac
  if [ -n "${owner_pid}" ] && [ "${owner_pid}" -gt 1 ] && \
    [ "${owner_script}" = "${SCRIPT_DIR}/wsl-autostart.sh" ] && [ -r "/proc/${owner_pid}/cmdline" ] && \
    tr '\000' '\n' < "/proc/${owner_pid}/cmdline" | grep -Fx -- "${owner_script}" >/dev/null; then
    kill -USR1 "${owner_pid}" 2>/dev/null || true
  fi
  wait_for_health 25 || true
  exit 0
fi

# Store both identity and PID after taking the lock. The uninstaller validates
# the recorded script against /proc before signalling this process, so a stale
# PID file cannot stop an unrelated process that reused the PID.
cleanup() {
  local recorded_pid='' child_pid
  if [ -f "${PID_FILE}" ]; then IFS= read -r recorded_pid < "${PID_FILE}" || true; fi
  if [ "${recorded_pid}" = "$$" ]; then rm -f "${PID_FILE}"; fi
  if [ "${MODE}" = '--keepalive' ]; then
    # Only jobs spawned by this shell are stopped, never processes matched by
    # name. This includes its no-systemd fallback server and sleeping timer.
    for child_pid in $(jobs -pr); do kill -TERM "${child_pid}" 2>/dev/null || true; done
  fi
}
trap cleanup EXIT
trap 'exit 0' HUP INT TERM
trap 'WAKE_REQUESTED=1' USR1
printf '%s\n%s\n' "$$" "${SCRIPT_DIR}/wsl-autostart.sh" > "${PID_FILE}.$$"
mv -f "${PID_FILE}.$$" "${PID_FILE}"

start_server_if_needed

if [ "${MODE}" = "--keepalive" ]; then
  # Keep a lightweight foreground handle alive so WSL2 does not auto-shutdown after 8s idle
  # and periodically verify the server stays up if not managed by systemd
  while true; do
    # A wait builtin is interrupted immediately by TERM; a foreground external
    # sleep would delay the cleanup trap for up to 30 seconds.
    if [ "${WAKE_REQUESTED}" -eq 0 ]; then
      sleep 30 9>&- &
      timer_pid="$!"
      wait "${timer_pid}" || true
      if [ "${WAKE_REQUESTED}" -eq 1 ] && jobs -pr | grep -Fx "${timer_pid}" >/dev/null; then
        kill -TERM "${timer_pid}" 2>/dev/null || true
      fi
    fi
    WAKE_REQUESTED=0
    if ! check_health; then
      start_server_if_needed
    fi
  done
fi
