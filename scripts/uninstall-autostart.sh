#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.local.resume_tailor.launcher"
LAUNCHD_LABEL="com.local.resume_tailor.server"
OS_NAME="$(uname -s)"
STATE_DIR="${HOME}/.local/state/resume-tailor"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

stop_owned_wsl_keepalive() {
  local pid_file="${STATE_DIR}/autostart.pid" owner_pid='' owner_script='' owner_root=''
  if [ -f "${pid_file}" ]; then
    {
      IFS= read -r owner_pid || true
      IFS= read -r owner_script || true
    } < "${pid_file}"
    case "${owner_pid}" in ''|*[!0-9]*) owner_pid='' ;; esac
    case "${owner_script}" in
      /*/scripts/wsl-autostart.sh)
        owner_root="${owner_script%/scripts/wsl-autostart.sh}"
        ;;
      *) owner_script='' ;;
    esac
    # A downloaded-source uninstaller may stop the stable installed companion,
    # whose owner marker identifies its recorded script as this application.
    if [ -n "${owner_pid}" ] && [ "${owner_pid}" -gt 1 ] && [ -n "${owner_script}" ] && \
      { [ "${owner_script}" = "${SCRIPT_DIR}/wsl-autostart.sh" ] ||
        grep -Eq '"owner"[[:space:]]*:[[:space:]]*"paint-it-black"' "${owner_root}/.paint-it-black-companion.json" 2>/dev/null; } && \
      [ -r "/proc/${owner_pid}/cmdline" ] && \
      tr '\000' '\n' < "/proc/${owner_pid}/cmdline" | grep -Fx -- "${owner_script}" >/dev/null; then
      echo 'Stopping the registered WSL keepalive process...'
      kill -TERM "${owner_pid}" 2>/dev/null || true
    fi
    rm -f "${pid_file}"
  fi
  rm -f "${STATE_DIR}/wsl-launcher.sh"
}

case "${OS_NAME}" in
  Darwin)
    uid_num="$(id -u)"
    plist_path="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
    echo "Stopping and removing macOS LaunchAgent..."
    launchctl bootout "gui/${uid_num}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
    launchctl unload -w "${plist_path}" >/dev/null 2>&1 || true
    rm -f "${plist_path}"

    echo "Removing Chrome Native Messaging host..."
    rm -f "${STATE_DIR}/native-host.sh"
    for nm_dir in \
      "${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
      "${HOME}/Library/Application Support/Chromium/NativeMessagingHosts" \
      "${HOME}/Library/Application Support/Microsoft Edge/NativeMessagingHosts" \
      "${HOME}/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    do
      rm -f "${nm_dir}/${HOST_NAME}.json"
    done
    ;;
  Linux)
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

    stop_owned_wsl_keepalive
    echo "Stopping and disabling systemd user service..."
    systemctl --user disable --now resume-tailor.service >/dev/null 2>&1 || true
    rm -f "${HOME}/.config/systemd/user/resume-tailor.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true

    if [ -n "${WSL_DISTRO_NAME:-}" ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop ]; then
      win_appdata="$(cmd.exe /c "echo %APPDATA%" 2>/dev/null | tr -d '\r\n')"
      win_localappdata="$(cmd.exe /c "echo %LOCALAPPDATA%" 2>/dev/null | tr -d '\r\n')"
      wsl_appdata="$(wslpath -u "${win_appdata}")"
      wsl_localappdata="$(wslpath -u "${win_localappdata}")"

      echo "Removing Windows Startup launcher..."
      rm -f "${wsl_appdata}/Microsoft/Windows/Start Menu/Programs/Startup/ResumeTailorWSL.vbs"

      echo "Removing Chrome/Edge Native Messaging host..."
      rm -rf "${wsl_localappdata}/ResumeTailor"
      reg.exe delete "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}" /f >/dev/null 2>&1 || true
      reg.exe delete "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}" /f >/dev/null 2>&1 || true
    else
      echo "Removing Chrome Native Messaging host..."
      rm -f "${STATE_DIR}/native-host.sh"
      for nm_dir in \
        "${HOME}/.config/google-chrome/NativeMessagingHosts" \
        "${HOME}/.config/chromium/NativeMessagingHosts" \
        "${HOME}/.config/microsoft-edge/NativeMessagingHosts" \
        "${HOME}/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      do
        rm -f "${nm_dir}/${HOST_NAME}.json"
      done
    fi
    ;;
  *)
    echo "Nothing automated to uninstall on ${OS_NAME}."
    ;;
esac

echo "Resume Tailor auto-start removed."
