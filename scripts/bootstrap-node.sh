#!/usr/bin/env bash
# Per-user official Node.js bootstrap. Source this file and call
# resume_tailor_bootstrap_node; all progress/errors go to stderr.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime.sh"

resume_tailor_node_download() {
  local url="$1" destination="$2" protocols='=https'
  case "${url}" in
    https://*) ;;
    http://127.0.0.1:*/*|http://localhost:*/*) protocols='=http,https' ;;
    *) echo '[paint-it-black] Node download URL must use HTTPS.' >&2; return 1 ;;
  esac
  curl --silent --show-error --fail --location --retry 2 \
    --connect-timeout 15 --max-time 300 --proto "${protocols}" --proto-redir "${protocols}" \
    --output "${destination}" "${url}"
}

resume_tailor_node_sha256() {
  local file="$1" result
  if command -v sha256sum >/dev/null 2>&1; then
    result="$(sha256sum "${file}")" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    result="$(shasum -a 256 "${file}")" || return 1
  elif command -v sha256 >/dev/null 2>&1; then
    result="$(sha256 -q "${file}")" || return 1
  else
    echo '[paint-it-black] A SHA256 checker (shasum or sha256sum) is required to verify Node.js.' >&2
    return 1
  fi
  printf '%s\n' "${result%% *}"
}

resume_tailor_node_archive_is_safe() {
  local archive="$1" root="$2" listing="$3"
  tar -tzf "${archive}" > "${listing}" || return 1
  awk -v root="${root}" '
    $0 != root && index($0, root "/") != 1 { exit 1 }
    $0 ~ /(^|\/)\.\.(\/|$)/ || $0 ~ /^\// { exit 1 }
    END { if (NR == 0) exit 1 }
  ' "${listing}" || return 1
  # Official archives contain relative npm/npx symlinks. Allow links that stay
  # within the one expected root, but reject absolute/escaping links and hard
  # links before extracting anything. Do not enable tar's unsafe -P option.
  tar -tvzf "${archive}" > "${listing}" || return 1
  awk -v root="${root}" '
    /^[lh]/ {
      if (substr($0, 1, 1) == "h") exit 1
      start = index($0, root "/"); if (!start) exit 1
      entry = substr($0, start); arrow = index(entry, " -> "); if (!arrow) exit 1
      name = substr(entry, 1, arrow - 1); target = substr(entry, arrow + 4)
      if (target ~ /^\//) exit 1
      sub(/\/[^\/]*$/, "", name)
      count = split(name "/" target, parts, "/"); depth = 0
      for (i = 1; i <= count; i++) {
        if (parts[i] == "" || parts[i] == ".") continue
        if (parts[i] == "..") { depth--; if (depth < 1) exit 1 }
        else depth++
      }
    }
  ' "${listing}"
}

resume_tailor_install_managed_node() (
  # These variables are isolated by the subshell. Bash 3.2 unwinds function
  # locals before an EXIT trap, so locals would make failure cleanup lose its
  # staging/lock paths under set -u.
  runtime_root="$1" name="$2" version="$3" dist_url="$4"
  target="${runtime_root}/${name}" lock="${runtime_root}/${name}.lock"
  stage='' backup='' keep_stage=0 attempt=0
  mkdir -p "${runtime_root}" || exit 1
  while ! mkdir "${lock}" 2>/dev/null; do
    if resume_tailor_try_node "${target}/bin/node"; then printf '%s\n' "${target}"; exit 0; fi
    owner="$(cat "${lock}/pid" 2>/dev/null || true)"
    if [[ "${owner}" =~ ^[0-9]+$ ]] && ! kill -0 "${owner}" 2>/dev/null; then
      rm -rf "${lock}" || exit 1
      continue
    fi
    attempt=$((attempt + 1))
    if [ "${attempt}" -ge 150 ]; then
      echo '[paint-it-black] Another Node.js setup is still running; retry when it completes.' >&2
      exit 1
    fi
    sleep 0.2 || exit 1
  done
  cleanup() {
    if [ -n "${backup}" ] && [ -e "${backup}" ] && [ ! -e "${target}" ]; then
      if ! mv "${backup}" "${target}"; then
        echo "[paint-it-black] Could not restore the previous runtime; retained at ${backup}." >&2
        keep_stage=1
      fi
    fi
    if [ -n "${stage}" ] && [ "${keep_stage}" -eq 0 ]; then rm -rf "${stage}"; fi
    rm -rf "${lock}"
  }
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  printf '%s\n' "$$" > "${lock}/pid" || exit 1
  if resume_tailor_try_node "${target}/bin/node"; then printf '%s\n' "${target}"; exit 0; fi
  stage="$(mktemp -d "${runtime_root}/.node-download.XXXXXX")" || exit 1
  archive="${name}.tar.gz"
  echo "[paint-it-black] Downloading official Node.js v${version} (${name#node-v${version}-})..." >&2
  resume_tailor_node_download "${dist_url}/v${version}/SHASUMS256.txt" "${stage}/SHASUMS256.txt" || exit 1
  expected="$(awk -v filename="${archive}" '$2 == filename { print $1; found++ } END { if (found != 1) exit 1 }' "${stage}/SHASUMS256.txt")" || {
    echo '[paint-it-black] Node.js checksum manifest does not contain the expected archive.' >&2; exit 1;
  }
  if ! [[ "${expected}" =~ ^[[:xdigit:]]{64}$ ]]; then
    echo '[paint-it-black] Node.js checksum manifest contains an invalid SHA256 value.' >&2; exit 1
  fi
  resume_tailor_node_download "${dist_url}/v${version}/${archive}" "${stage}/${archive}" || exit 1
  actual="$(resume_tailor_node_sha256 "${stage}/${archive}")" || exit 1
  if [ "${actual}" != "${expected}" ]; then
    echo '[paint-it-black] Node.js archive checksum verification failed; nothing was installed.' >&2; exit 1
  fi
  resume_tailor_node_archive_is_safe "${stage}/${archive}" "${name}" "${stage}/archive-list.txt" || {
    echo '[paint-it-black] Node.js archive contains an unsafe path or link; nothing was installed.' >&2; exit 1;
  }
  mkdir "${stage}/unpack" || exit 1
  tar -xzf "${stage}/${archive}" -C "${stage}/unpack" --no-same-owner || exit 1
  if ! resume_tailor_try_node "${stage}/unpack/${name}/bin/node" || \
    [ "$("${stage}/unpack/${name}/bin/node" --version 2>/dev/null)" != "v${version}" ]; then
    echo '[paint-it-black] Downloaded Node.js cannot run on this system; nothing was installed.' >&2; exit 1
  fi
  # Do not move an existing installation until its replacement has passed all
  # download, checksum, archive, architecture, and execution checks.
  if [ -e "${target}" ] || [ -L "${target}" ]; then
    backup="${stage}/previous"
    mv "${target}" "${backup}" || exit 1
  fi
  mv "${stage}/unpack/${name}" "${target}" || exit 1
  printf '%s\n' "${target}"
)

resume_tailor_bootstrap_node() {
  local version="${PAINT_IT_BLACK_NODE_VERSION:-24.22.3}"
  local platform="${PAINT_IT_BLACK_NODE_PLATFORM:-$(uname -s)}"
  local arch="${PAINT_IT_BLACK_NODE_ARCH:-$(uname -m)}"
  local data_root="${PAINT_IT_BLACK_DATA_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/paint-it-black}"
  local dist_url="${PAINT_IT_BLACK_NODE_DIST_URL:-https://nodejs.org/dist}"
  local runtime_root="${data_root}/runtime/node" name target loader major minor
  if [ "${1:-}" != '--managed' ] && resume_tailor_configure_runtime >/dev/null 2>&1; then return 0; fi
  if ! [[ "${version}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo '[paint-it-black] Invalid Node.js version requested (requires a pinned stable version >=22.3).' >&2; return 1
  fi
  major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}"
  if [ "${major}" -lt 22 ] || { [ "${major}" -eq 22 ] && [ "${minor}" -lt 3 ]; }; then
    echo '[paint-it-black] Invalid Node.js version requested (requires a pinned stable version >=22.3).' >&2; return 1
  fi
  case "${platform}" in Darwin|darwin) platform=darwin ;; Linux|linux) platform=linux ;;
    *) echo "[paint-it-black] Automatic Node.js setup does not support ${platform}." >&2; return 1 ;; esac
  case "${arch}" in x86_64|amd64|x64) arch=x64 ;; aarch64|arm64) arch=arm64 ;;
    *) echo "[paint-it-black] Automatic Node.js setup does not support architecture ${arch}." >&2; return 1 ;; esac
  if [ "${platform}" = linux ]; then
    for loader in /lib/ld-musl-*.so.1; do
      if [ -e "${loader}" ]; then
        if [ "${arch}" != x64 ]; then
          echo '[paint-it-black] Automatic Node.js setup requires glibc on this Linux architecture.' >&2; return 1
        fi
        arch=x64-musl
        break
      fi
    done
  fi
  name="node-v${version}-${platform}-${arch}"
  target="${runtime_root}/${name}"
  if ! resume_tailor_try_node "${target}/bin/node"; then
    for loader in curl tar awk mktemp; do
      if ! command -v "${loader}" >/dev/null 2>&1; then
        echo "[paint-it-black] ${loader} is required to bootstrap Node.js." >&2; return 1
      fi
    done
    target="$(resume_tailor_install_managed_node "${runtime_root}" "${name}" "${version}" "${dist_url%/}")" || return 1
  fi
  NODE_BIN="${target}/bin/node"
  export NODE_BIN
  resume_tailor_configure_runtime >/dev/null || return 1
  echo "[paint-it-black] Using managed Node.js at ${NODE_BIN}." >&2
}
