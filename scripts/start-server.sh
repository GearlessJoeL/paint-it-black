#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

prepend_path_if_dir() {
  local dir="$1"
  if [ -d "${dir}" ]; then
    case ":${PATH}:" in
      *":${dir}:"*) ;;
      *) PATH="${dir}:${PATH}" ;;
    esac
  fi
}

# Include common tool locations across macOS (Homebrew/MacTeX) and Linux/WSL (TeX Live/agy)
prepend_path_if_dir "/usr/local/bin"
prepend_path_if_dir "/opt/homebrew/bin"
prepend_path_if_dir "/Library/TeX/texbin"
prepend_path_if_dir "${HOME}/.volta/bin"
prepend_path_if_dir "${HOME}/.local/bin"
prepend_path_if_dir "${HOME}/.gemini/bin"

for tex_root in "/usr/local/texlive" "${HOME}/texlive"; do
  if [ -d "${tex_root}" ]; then
    for bin_dir in "${tex_root}"/[0-9][0-9][0-9][0-9]/bin/*; do
      prepend_path_if_dir "${bin_dir}"
    done
  fi
done

# Support nvm-managed Node when launched non-interactively (e.g. macOS launchd / systemd)
if ! command -v node >/dev/null 2>&1 && [ -d "${HOME}/.nvm/versions/node" ]; then
  latest_nvm_bin=""
  for nvm_bin in "${HOME}"/.nvm/versions/node/*/bin; do
    if [ -x "${nvm_bin}/node" ]; then
      latest_nvm_bin="${nvm_bin}"
    fi
  done
  if [ -n "${latest_nvm_bin}" ]; then
    prepend_path_if_dir "${latest_nvm_bin}"
  fi
fi

export PATH

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "${NODE_BIN}" ] || [ ! -x "${NODE_BIN}" ]; then
  echo "[resume-tailor] Error: Node.js (>=20) not found on PATH (${PATH})." >&2
  exit 1
fi

cd "${PROJECT_DIR}"
exec "${NODE_BIN}" server/index.mjs "$@"
