#!/usr/bin/env bash
# Shared by setup, background services, and the native messaging launcher.
# Do not source shell profiles or print to stdout: native messaging uses stdout
# for its binary protocol, and login-shell fnm paths are temporary symlinks.

resume_tailor_prepend_path() {
  local dir="$1"
  if [ -d "${dir}" ]; then
    case ":${PATH:-}:" in
      *":${dir}:"*) ;;
      *) PATH="${dir}:${PATH:-}" ;;
    esac
  fi
}

resume_tailor_try_node() {
  local candidate="$1" resolved
  [ -n "${candidate}" ] && [ -x "${candidate}" ] || return 1
  # Resolve fnm's multishell/default symlinks to the real installation, and
  # validate the minimum version even for explicitly supplied NODE_BIN.
  if resolved="$("${candidate}" -e '
    if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1);
    process.stdout.write(require("node:fs").realpathSync(process.execPath));
  ' 2>/dev/null)" && [ -n "${resolved}" ] && [ -x "${resolved}" ]; then
    NODE_BIN="${resolved}"
    return 0
  fi
  return 1
}

resume_tailor_find_node() {
  local path_node="$1" root candidate best='' major minor patch
  local best_major=0 best_minor=0 best_patch=0 version

  for candidate in "${NODE_BIN:-}" "${path_node}" "$(command -v node || true)"; do
    if resume_tailor_try_node "${candidate}"; then return 0; fi
  done

  local fnm_roots=(
    "${FNM_DIR:-}"
    "${XDG_DATA_HOME:-${HOME}/.local/share}/fnm"
    "${HOME}/Library/Application Support/fnm"
    "${HOME}/.local/share/fnm"
    "${HOME}/.fnm"
  )
  for root in "${fnm_roots[@]}"; do
    [ -n "${root}" ] || continue
    if resume_tailor_try_node "${root}/aliases/default/bin/node"; then
      # Retain custom roots for recovery if the pinned version is uninstalled.
      export FNM_DIR="${root}"
      return 0
    fi
  done

  # No usable default: select the newest supported installed fnm/nvm version.
  # Compare numeric components rather than sort -V (unavailable on macOS).
  local candidates=()
  for root in "${fnm_roots[@]}"; do
    [ -n "${root}" ] || continue
    for candidate in "${root}"/node-versions/v*/installation/bin/node; do
      if [ -x "${candidate}" ]; then candidates+=("${candidate}"); fi
    done
  done
  for root in "${NVM_DIR:-${HOME}/.nvm}" "${HOME}/.nvm"; do
    for candidate in "${root}"/versions/node/v*/bin/node; do
      if [ -x "${candidate}" ]; then candidates+=("${candidate}"); fi
    done
  done
  for candidate in ${candidates[@]+"${candidates[@]}"}; do
    if ! resume_tailor_try_node "${candidate}"; then continue; fi
    version="$("${NODE_BIN}" -p 'process.versions.node')"
    IFS=. read -r major minor patch <<< "${version}"
    patch="${patch%%-*}"
    if (( major > best_major || (major == best_major && minor > best_minor) || (major == best_major && minor == best_minor && patch > best_patch) )); then
      best="${NODE_BIN}"
      best_major="${major}" best_minor="${minor}" best_patch="${patch}"
    fi
  done
  if [ -n "${best}" ]; then NODE_BIN="${best}"; return 0; fi
  return 1
}

resume_tailor_configure_runtime() {
  local path_node tool_dir tex_root bin_dir
  path_node="$(command -v node || true)"
  for tool_dir in /usr/local/bin /opt/homebrew/bin /Library/TeX/texbin \
    "${VOLTA_HOME:-${HOME}/.volta}/bin" "${HOME}/.local/bin" "${HOME}/.gemini/bin"; do
    resume_tailor_prepend_path "${tool_dir}"
  done
  for tex_root in /usr/local/texlive "${HOME}/texlive" "${HOME}/.local/texlive"; do
    for bin_dir in "${tex_root}"/[0-9][0-9][0-9][0-9]/bin/*; do
      resume_tailor_prepend_path "${bin_dir}"
    done
  done
  export PATH

  if ! resume_tailor_find_node "${path_node}"; then
    echo '[resume-tailor] Error: Node.js >=20 was not found. Install Node.js >=20 (or run fnm install --lts), then rerun setup.' >&2
    return 1
  fi
  case "${NODE_BIN}" in
    */node-versions/v*/installation/bin/node)
      export FNM_DIR="${NODE_BIN%/node-versions/*}"
      ;;
  esac
  # CLI tools installed alongside Node often use #!/usr/bin/env node.
  PATH="$(dirname "${NODE_BIN}"):${PATH}"
  export NODE_BIN PATH
}
