#!/usr/bin/env bash
# Runs plugins/sessions/setup/setup.sh in throwaway home folders and checks what it changed: once per shell (bash, zsh,
# and the account's own login shell), then again, when it must change nothing; and once over an earlier setup (its ccc
# opened the agent view from ~/.claude/mods/sessions-bin), which it must move over with a backup. The CI runs it on
# macOS and Linux; it's safe to run anywhere (it never touches your real home folder).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
setup="$root/plugins/sessions/setup/setup.sh"
fail() { echo "FAIL ($1): $2" >&2; exit 1; }
line="alias ccc='bash ~/.claude/mods/sessions-data/bin/ccc'"

check() {
  local label="$1" home="$2" rc="$3"
  local bin="$home/.claude/mods/sessions-data/bin"
  [ -x "$bin/ccc" ] || fail "$label" "ccc command missing"
  grep -q "^SETUP_ROOT=.*plugins/sessions'\?$" "$bin/ccc" || fail "$label" "ccc doesn't remember the plugin's folder"
  [ -x "$bin/statusline.sh" ] || fail "$label" "status line copy missing"
  HOME_DIR="$home" python3 - <<'PY' || fail "$label" "settings or keybindings not as expected"
import json, os
home = os.environ['HOME_DIR']
settings = json.load(open(f'{home}/.claude/settings.json'))
assert settings['statusLine']['command'] == f'{home}/.claude/mods/sessions-data/bin/statusline.sh', settings
keys = json.load(open(f'{home}/.claude/keybindings.json'))
blocks = {b['context']: b['bindings'] for b in keys['bindings']}
assert blocks['Chat']['shift+right'] == 'abovePrompt:focus', blocks
assert blocks['Pane']['left'] == 'abovePrompt:leave', blocks
PY
  grep -Fxq "$line" "$rc" || fail "$label" "no ccc in $rc"
}

run_setup() { env -u CLAUDE_CODE_PLUGIN_DIRS -u SESSIONS_DATA_DIR HOME="$1" bash "$setup" "${@:2}"; }
unchanged() {
  if echo "$2" | grep -Eq 'backup:|added|replaced|statusLine →'; then
    echo "$2" >&2
    fail "$1" "a second run changed something"
  fi
}

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
  unchanged "$label" "$second"
  rm -rf "$home"
done

# Over an earlier setup: its block's ccc and its status line move to the new command, with backups; a second run
# changes nothing
label="earlier setup"
home="$(mktemp -d)"
mkdir -p "$home/.claude/mods/sessions-bin"
printf '{"statusLine": {"type": "command", "command": "%s/.claude/mods/sessions-bin/statusline.sh", "padding": 0}}\n' "$home" > "$home/.claude/settings.json"
printf "export FOO=1\n\n# >>> sessions plugin >>>\n# Open this folder's Claude sessions in the agents view, without starting a new one\nalias ccc='bash ~/.claude/mods/sessions-bin/visor.sh agents'\n# <<< sessions plugin <<<\n" > "$home/.bashrc"
printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' > "$home/.bash_profile"
first=$(run_setup "$home" --shell=bash)
echo "$first" | sed "s/^/[$label] /"
check "$label" "$home" "$home/.bashrc"
grep -q "sessions-bin" "$home/.bashrc" && fail "$label" "the old ccc is still there"
grep -q "^export FOO=1$" "$home/.bashrc" || fail "$label" "the rest of .bashrc changed"
[ "$(grep -c '^# >>> sessions plugin >>>' "$home/.bashrc")" = 1 ] || fail "$label" "the block was duplicated"
ls "$home"/.bashrc.bak-antes-ccc-start-* >/dev/null 2>&1 || fail "$label" "no backup of .bashrc"
ls "$home"/.claude/settings.json.bak-antes-statusline-* >/dev/null 2>&1 || fail "$label" "no backup of settings.json"
unchanged "$label" "$(run_setup "$home" --shell=bash)"
rm -rf "$home"
echo "setup: ok"
