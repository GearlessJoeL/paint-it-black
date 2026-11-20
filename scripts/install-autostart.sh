#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOST_NAME="com.local.resume_tailor.launcher"
LAUNCHD_LABEL="com.local.resume_tailor.server"
PORT="${PORT:-8787}"
OS_NAME="$(uname -s)"
STATE_DIR="${HOME}/.local/state/resume-tailor"

# Discover Node/Homebrew binaries even when run from non-login shells
for d in "/opt/homebrew/bin" "/usr/local/bin" "${HOME}/.volta/bin" "${HOME}/.local/bin"; do
  if [ -d "${d}" ]; then
    case ":${PATH}:" in
      *":${d}:"*) ;;
      *) PATH="${d}:${PATH}" ;;
    esac
  fi
done
if ! command -v node >/dev/null 2>&1 && [ -d "${HOME}/.nvm/versions/node" ]; then
  for nvm_bin in "${HOME}"/.nvm/versions/node/*/bin; do
    if [ -x "${nvm_bin}/node" ]; then
      PATH="${nvm_bin}:${PATH}"
    fi
  done
fi
export PATH

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "${NODE_BIN}" ] || [ ! -x "${NODE_BIN}" ]; then
  echo "Error: Node.js (>=20) is required but was not found on PATH." >&2
  exit 1
fi

chmod +x "${PROJECT_DIR}/scripts/start-server.sh" "${PROJECT_DIR}/scripts/native-host.mjs"
if [ -f "${PROJECT_DIR}/scripts/wsl-autostart.sh" ]; then
  chmod +x "${PROJECT_DIR}/scripts/wsl-autostart.sh"
fi

# Compute deterministic Extension ID from manifest.json "key"
EXT_ID="$(${NODE_BIN} -e "
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  if (!manifest.key) process.exit(1);
  const der = Buffer.from(manifest.key, 'base64');
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  console.log([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(''));
" "${PROJECT_DIR}/extension/manifest.json")"

write_posix_native_wrapper() {
  mkdir -p "${STATE_DIR}"
  cat > "${STATE_DIR}/native-host.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:\${HOME}/.local/bin:\${PATH}"
NODE_EXEC="${NODE_BIN}"
if [ ! -x "\${NODE_EXEC}" ]; then
  NODE_EXEC="\$(command -v node || true)"
fi
exec "\${NODE_EXEC}" "${PROJECT_DIR}/scripts/native-host.mjs"
EOF
  chmod +x "${STATE_DIR}/native-host.sh"
}

write_native_manifest_json() {
  local target_dir="$1"
  local host_exec_path="$2"
  mkdir -p "${target_dir}"
  cat > "${target_dir}/${HOST_NAME}.json" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Auto-starts the Resume Tailor companion server on demand",
  "path": "${host_exec_path}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXT_ID}/"
  ]
}
EOF
}

verify_live_health() {
  local attempts=0
  while [ "${attempts}" -lt 15 ]; do
    if "${NODE_BIN}" -e "
      fetch('http://127.0.0.1:${PORT}/api/ping', { signal: AbortSignal.timeout(1000) })
        .then((r) => process.exit(r.ok ? 0 : 1))
        .catch(() => process.exit(1));
    " >/dev/null 2>&1; then
      break
    fi
    attempts=$((attempts + 1))
    sleep 0.3
  done

  "${NODE_BIN}" -e "
    fetch('http://127.0.0.1:${PORT}/api/health')
      .then((r) => r.json())
      .then((h) => {
        console.log('  Status:       ', h.status);
        console.log('  Platform:     ', h.isWsl ? 'Windows (WSL)' : h.platform);
        console.log('  Extension ID: ', '${EXT_ID}');
        console.log('  LaTeX:        ', h.latex?.installed ? h.latex.compiler : 'MISSING (install MacTeX/BasicTeX on macOS or TeX Live on Linux/WSL)');
        console.log('  Antigravity:  ', h.agents?.[0]?.authenticated ? 'Signed in & ready' : 'Sign-in needed (run ~/.gemini/bin/agy once)');
      })
      .catch((e) => {
        console.error('Health check failed:', e.message);
        process.exit(1);
      });
  "
}

install_macos() {
  local uid_num plist_dir plist_path log_dir runtime_path
  uid_num="$(id -u)"
  plist_dir="${HOME}/Library/LaunchAgents"
  plist_path="${plist_dir}/${LAUNCHD_LABEL}.plist"
  log_dir="${HOME}/Library/Logs/resume-tailor"
  runtime_path="/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin:${HOME}/.gemini/bin:${HOME}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  echo "[1/3] Installing macOS LaunchAgent (${LAUNCHD_LABEL})..."
  mkdir -p "${plist_dir}" "${log_dir}" "${STATE_DIR}"

  launchctl bootout "gui/${uid_num}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
  pkill -f '[n]ode server/index\.mjs' >/dev/null 2>&1 || true
  sleep 0.3

  cat > "${plist_path}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${PROJECT_DIR}/scripts/start-server.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>PATH</key>
    <string>${runtime_path}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log_dir}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${log_dir}/server.log</string>
</dict>
</plist>
EOF

  if ! launchctl bootstrap "gui/${uid_num}" "${plist_path}" >/dev/null 2>&1; then
    launchctl load -w "${plist_path}"
  fi

  echo "[2/3] Installing Chrome Native Messaging on-demand auto-waker..."
  write_posix_native_wrapper

  local chrome_nm="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  write_native_manifest_json "${chrome_nm}" "${STATE_DIR}/native-host.sh"

  for browser_root in \
    "${HOME}/Library/Application Support/Chromium" \
    "${HOME}/Library/Application Support/Microsoft Edge" \
    "${HOME}/Library/Application Support/BraveSoftware/Brave-Browser"
  do
    if [ -d "${browser_root}" ]; then
      write_native_manifest_json "${browser_root}/NativeMessagingHosts" "${STATE_DIR}/native-host.sh"
    fi
  done

  echo "[3/3] Verifying live server health..."
  verify_live_health

  echo ""
  echo "macOS auto-start setup complete!"
  echo "  - LaunchAgent plist:     ${plist_path}"
  echo "  - Native host manifest:  ${chrome_nm}/${HOST_NAME}.json"
  echo "  - Load unpacked path:    ${PROJECT_DIR}/extension"
}

install_linux_systemd() {
  local systemd_user_dir="${HOME}/.config/systemd/user"
  mkdir -p "${systemd_user_dir}" "${STATE_DIR}"

  cat > "${systemd_user_dir}/resume-tailor.service" <<EOF
[Unit]
Description=Resume Tailor Companion Server (Antigravity + TeX Live)
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
Environment=PORT=${PORT}
Environment=PATH=$(dirname "${NODE_BIN}"):${HOME}/.gemini/bin:${HOME}/.local/bin:${HOME}/texlive/2024/bin/x86_64-linux:/usr/local/bin:/usr/bin:/bin
ExecStart=${PROJECT_DIR}/scripts/start-server.sh
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

  systemctl --user daemon-reload
  systemctl --user stop resume-tailor.service >/dev/null 2>&1 || true
  pkill -f '[n]ode server/index\.mjs' >/dev/null 2>&1 || true
  sleep 0.3
  systemctl --user enable resume-tailor.service
  systemctl --user restart resume-tailor.service
}

install_wsl() {
  local distro_name linux_user win_appdata win_localappdata wsl_appdata wsl_localappdata
  distro_name="${WSL_DISTRO_NAME:-Ubuntu-24.04}"
  linux_user="$(id -un)"

  echo "[1/4] Installing WSL systemd user service (resume-tailor.service)..."
  install_linux_systemd

  echo "[2/4] Installing silent Windows Startup launcher..."
  win_appdata="$(cmd.exe /c "echo %APPDATA%" 2>/dev/null | tr -d '\r\n')"
  win_localappdata="$(cmd.exe /c "echo %LOCALAPPDATA%" 2>/dev/null | tr -d '\r\n')"
  wsl_appdata="$(wslpath -u "${win_appdata}")"
  wsl_localappdata="$(wslpath -u "${win_localappdata}")"

  local startup_dir="${wsl_appdata}/Microsoft/Windows/Start Menu/Programs/Startup"
  local vbs_wsl_path="${startup_dir}/ResumeTailorWSL.vbs"
  local vbs_win_path="${win_appdata}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\ResumeTailorWSL.vbs"

  mkdir -p "${startup_dir}"
  cat > "${vbs_wsl_path}" <<EOF
Set shell = CreateObject("WScript.Shell")
shell.Run "wsl.exe -d ${distro_name} -u ${linux_user} -- ${PROJECT_DIR}/scripts/wsl-autostart.sh --keepalive", 0, False
EOF

  echo "[3/4] Installing Chrome Native Messaging on-demand auto-waker..."
  local native_wsl_dir="${wsl_localappdata}/ResumeTailor"
  local native_win_dir="${win_localappdata}\\ResumeTailor"
  mkdir -p "${native_wsl_dir}"

  printf '@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%%~dp0native-host.ps1"\r\n' > "${native_wsl_dir}/native-host.cmd"

  cat > "${native_wsl_dir}/native-host.ps1" <<EOF
\$ErrorActionPreference = 'SilentlyContinue'
\$ProgressPreference = 'SilentlyContinue'

function Read-NativeMessage {
  \$stdin = [Console]::OpenStandardInput()
  \$lenBytes = New-Object byte[] 4
  \$read = \$stdin.Read(\$lenBytes, 0, 4)
  if (\$read -lt 4) { return \$null }
  \$len = [BitConverter]::ToInt32(\$lenBytes, 0)
  if (\$len -le 0 -or \$len -gt 1048576) { return \$null }
  \$buf = New-Object byte[] \$len
  \$offset = 0
  while (\$offset -lt \$len) {
    \$n = \$stdin.Read(\$buf, \$offset, \$len - \$offset)
    if (\$n -le 0) { break }
    \$offset += \$n
  }
  return [System.Text.Encoding]::UTF8.GetString(\$buf, 0, \$offset)
}

function Write-NativeMessage([hashtable]\$Obj) {
  \$json = (\$Obj | ConvertTo-Json -Compress)
  \$bytes = [System.Text.Encoding]::UTF8.GetBytes(\$json)
  \$lenBytes = [BitConverter]::GetBytes([int]\$bytes.Length)
  \$stdout = [Console]::OpenStandardOutput()
  \$stdout.Write(\$lenBytes, 0, 4)
  \$stdout.Write(\$bytes, 0, \$bytes.Length)
  \$stdout.Flush()
}

function Test-Health([string]\$Url) {
  try {
    \$req = [System.Net.HttpWebRequest]::Create(\$Url)
    \$req.Method = 'GET'
    \$req.Timeout = 1000
    \$resp = \$req.GetResponse()
    \$code = [int]\$resp.StatusCode
    \$resp.Close()
    return (\$code -eq 200)
  } catch {
    return \$false
  }
}

\$rawMsg = Read-NativeMessage
\$healthUrl = 'http://127.0.0.1:${PORT}/api/ping'

if (Test-Health \$healthUrl) {
  Write-NativeMessage @{ ok = \$true; alreadyRunning = \$true; ready = \$true }
  exit 0
}

\$vbsPath = '${vbs_win_path}'
if (Test-Path \$vbsPath) {
  \$null = Start-Process -FilePath 'wscript.exe' -ArgumentList ('//B //Nologo "' + \$vbsPath + '"') -WindowStyle Hidden
} else {
  \$null = Start-Process -FilePath 'wsl.exe' -ArgumentList '-d ${distro_name} -u ${linux_user} -- ${PROJECT_DIR}/scripts/wsl-autostart.sh --keepalive' -WindowStyle Hidden
}

\$ready = \$false
for (\$i = 0; \$i -lt 35; \$i++) {
  Start-Sleep -Milliseconds 400
  if (Test-Health \$healthUrl) {
    \$ready = \$true
    break
  }
}

if (\$ready) {
  Write-NativeMessage @{ ok = \$true; alreadyRunning = \$false; ready = \$true }
} else {
  Write-NativeMessage @{ ok = \$false; ready = \$false; error = 'Timed out waiting for WSL companion server on 127.0.0.1:${PORT}' }
}
EOF

  local host_manifest_win="${native_win_dir}\\${HOST_NAME}.json"
  local host_cmd_json_escaped="${native_win_dir//\\/\\\\}\\\\native-host.cmd"

  cat > "${native_wsl_dir}/${HOST_NAME}.json" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Auto-starts the Resume Tailor WSL companion server on demand",
  "path": "${host_cmd_json_escaped}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXT_ID}/"
  ]
}
EOF

  reg.exe add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}" /ve /t REG_SZ /d "${host_manifest_win}" /f >/dev/null
  if reg.exe query "HKCU\\Software\\Microsoft\\Edge" >/dev/null 2>&1; then
    reg.exe add "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}" /ve /t REG_SZ /d "${host_manifest_win}" /f >/dev/null || true
  fi

  echo "[4/4] Verifying live server health..."
  verify_live_health

  echo ""
  echo "Windows + WSL auto-start setup complete!"
  echo "  - WSL systemd service:   resume-tailor.service (enabled & running)"
  echo "  - Windows Startup VBS:   ${vbs_win_path}"
  echo "  - Chrome Native Host:    HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}"
}

install_native_linux() {
  echo "[1/3] Installing systemd user service (resume-tailor.service)..."
  install_linux_systemd

  echo "[2/3] Installing Chrome Native Messaging on-demand auto-waker..."
  write_posix_native_wrapper
  local chrome_nm="${HOME}/.config/google-chrome/NativeMessagingHosts"
  write_native_manifest_json "${chrome_nm}" "${STATE_DIR}/native-host.sh"
  for browser_root in \
    "${HOME}/.config/chromium" \
    "${HOME}/.config/microsoft-edge" \
    "${HOME}/.config/BraveSoftware/Brave-Browser"
  do
    if [ -d "${browser_root}" ]; then
      write_native_manifest_json "${browser_root}/NativeMessagingHosts" "${STATE_DIR}/native-host.sh"
    fi
  done

  echo "[3/3] Verifying live server health..."
  verify_live_health

  echo ""
  echo "Linux auto-start setup complete!"
  echo "  - systemd user service:  resume-tailor.service (enabled & running)"
  echo "  - Native host manifest:  ${chrome_nm}/${HOST_NAME}.json"
  echo "  - Load unpacked path:    ${PROJECT_DIR}/extension"
}

case "${OS_NAME}" in
  Darwin)
    install_macos
    ;;
  Linux)
    if [ -n "${WSL_DISTRO_NAME:-}" ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop ]; then
      install_wsl
    else
      install_native_linux
    fi
    ;;
  *)
    echo "Unsupported OS: ${OS_NAME}. Run ./scripts/start-server.sh directly instead." >&2
    exit 1
    ;;
esac
