#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
prepare_only=0
for option in "$@"; do
  case "${option}" in
    --prepare-only) prepare_only=1 ;;
    --help|-h)
      echo 'Usage: ./scripts/setup.sh [--prepare-only]'
      echo 'Prepare-only provisions and verifies prerequisites without changing login services.'
      exit 0 ;;
    *) echo "Unknown setup option: ${option}" >&2; exit 2 ;;
  esac
done

export PAINT_IT_BLACK_DATA_DIR="${PAINT_IT_BLACK_DATA_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/paint-it-black}"
mkdir -p "${PAINT_IT_BLACK_DATA_DIR}"
export PAINT_IT_BLACK_DATA_DIR="$(cd "${PAINT_IT_BLACK_DATA_DIR}" && pwd -P)"
source "${SCRIPT_DIR}/bootstrap-node.sh"
resume_tailor_bootstrap_node
npm_bin="$(dirname "${NODE_BIN}")/npm"
if [ ! -x "${npm_bin}" ]; then
  # Embedded/single-binary Node installations may omit npm. Use the verified
  # managed distribution instead of asking the user to install another tool.
  resume_tailor_bootstrap_node --managed
  npm_bin="$(dirname "${NODE_BIN}")/npm"
fi
if [ ! -x "${npm_bin}" ]; then
  echo '[paint-it-black] The managed Node.js runtime does not contain npm; rerun setup.' >&2
  exit 1
fi

cd "${PROJECT_DIR}"
if [ ! -f package-lock.json ]; then
  echo '[paint-it-black] package-lock.json is missing. Download the complete application source and rerun setup.' >&2
  exit 1
fi
dependency_hash="$("${NODE_BIN}" -e '
  const fs = require("node:fs"), crypto = require("node:crypto");
  const hash = crypto.createHash("sha256");
  for (const file of ["package.json", "package-lock.json"]) hash.update(fs.readFileSync(file));
  hash.update(process.versions.modules);
  process.stdout.write(hash.digest("hex"));
')"
dependency_marker="${PROJECT_DIR}/node_modules/.paint-it-black-lockhash"
saved_hash="$(cat "${dependency_marker}" 2>/dev/null || true)"
if [ "${saved_hash}" != "${dependency_hash}" ] || \
  ! "${NODE_BIN}" --input-type=module -e 'await import("pdf-parse");' >/dev/null 2>&1; then
  echo '[paint-it-black] Installing application dependencies...' >&2
  mkdir -p "${PAINT_IT_BLACK_DATA_DIR}/cache/npm"
  npm_config_cache="${PAINT_IT_BLACK_DATA_DIR}/cache/npm" npm_config_update_notifier=false \
    "${npm_bin}" ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ! "${NODE_BIN}" --input-type=module -e 'await import("pdf-parse");' >/dev/null 2>&1; then
    echo '[paint-it-black] PDF support could not be loaded after dependency installation.' >&2
    exit 1
  fi
  printf '%s\n' "${dependency_hash}" > "${dependency_marker}"
fi

"${NODE_BIN}" "${SCRIPT_DIR}/setup-companion.mjs"
companion_dir="$("${NODE_BIN}" "${SCRIPT_DIR}/install-companion.mjs")"
echo "[paint-it-black] Load the unpacked Chrome extension from: ${companion_dir}/extension" >&2
if [ "${prepare_only}" -eq 1 ]; then
  echo '[paint-it-black] Prerequisites verified. Login services were not installed (--prepare-only).' >&2
  exit 0
fi
exec env PAINT_IT_BLACK_BOOTSTRAPPED=1 /bin/bash "${companion_dir}/scripts/install-autostart.sh"
