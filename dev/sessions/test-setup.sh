#!/usr/bin/env bash
# Runs plugins/sessions/setup/setup.sh in throwaway home folders and checks what it changed: once per shell (bash, zsh,
# and the account's own login shell), then again, when it must change nothing. The CI runs it on macOS and Linux; it's
# safe to run anywhere (it never touches your real home folder).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
setup="$root/plugins/sessions/setup/setup.sh"
fail() { echo "FAIL ($1): $2" >&2; exit 1; }

check() {
  local label="$1" home="$2" rc="$3"
  [ -x "$home/.claude/mods/sessions-bin/visor.sh" ] || fail "$label" "launcher copy missing"
  [ -x "$home/.claude/mods/sessions-bin/statusline.sh" ] || fail "$label" "status line copy missing"
  HOME_DIR="$home" python3 - <<'PY' || fail "$label" "settings or keybindings not as expected"
import json, os
home = os.environ['HOME_DIR']
settings = json.load(open(f'{home}/.claude/settings.json'))
assert settings['statusLine']['command'] == f'{home}/.claude/mods/sessions-bin/statusline.sh', settings
keys = json.load(open(f'{home}/.claude/keybindings.json'))
blocks = {b['context']: b['bindings'] for b in keys['bindings']}
assert blocks['Chat']['shift+right'] == 'abovePrompt:focus', blocks
assert blocks['Pane']['left'] == 'abovePrompt:leave', blocks
PY
  grep -Eq "^alias ccc[= ]'bash ~/.claude/mods/sessions-bin/visor.sh agents'" "$rc" || fail "$label" "no ccc in $rc"
}

run_setup() { env -u CLAUDE_CODE_PLUGIN_DIRS HOME="$1" bash "$setup" "${@:2}"; }

for shell in bash zsh ""; do
  label="${shell:-login shell}"
  home="$(mktemp -d)"
  mkdir -p "$home/.claude"
  if [ -n "$shell" ]; then first=$(run_setup "$home" "--shell=$shell"); else first=$(run_setup "$home"); fi
  echo "$first" | sed "s/^/[$label] /"
  detected=$(echo "$first" | sed -n 's/^  shell: \([a-z]*\) → \(.*\)$/\1 \2/p')
  rc="${detected#* }"
  case "${detected%% *}" in
    bash|zsh|fish) check "$label" "$home" "$rc" ;;
    *) echo "[$label] account shell isn't bash, zsh or fish: only the run itself is checked" ;;
  esac
  if [ "${detected%% *}" = bash ]; then
    grep -Eqs '(\.|source)[[:space:]]+[^#]*\.bashrc' "$home/.bash_profile" "$home/.bash_login" "$home/.profile" \
      || fail "$label" "bash login file doesn't load ~/.bashrc"
  fi
  if [ -n "$shell" ]; then second=$(run_setup "$home" "--shell=$shell"); else second=$(run_setup "$home"); fi
  if echo "$second" | grep -Eq 'backup:|added|replaced|statusLine →'; then
    echo "$second" >&2
    fail "$label" "a second run changed something"
  fi
  rm -rf "$home"
done
echo "setup: ok"
