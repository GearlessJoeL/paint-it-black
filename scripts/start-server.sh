#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${SCRIPT_DIR}/runtime.sh"
resume_tailor_configure_runtime

cd "${PROJECT_DIR}"
exec "${NODE_BIN}" server/index.mjs "$@"
