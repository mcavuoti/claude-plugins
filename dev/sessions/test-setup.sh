#!/usr/bin/env bash
# Runs plugins/sessions/setup/setup.sh in throwaway home folders and checks what it changed: once per shell (bash, zsh,
# and the account's own login shell), then again, when it must change nothing. The CI runs it on macOS and Linux; it's
# safe to run anywhere (it never touches your real home folder).
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
  # shellcheck disable=SC2001 # a prefix on every line of a multi-line output
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

# ccc already defined in a file the startup file loads (like Debian's ~/.bash_aliases): already set, nothing added or
# backed up, in a dry run and a real one; a loaded file with no ccc doesn't count, and then ccc is added once
for shell in bash zsh; do
  label="ccc in a loaded file ($shell)"
  home="$(mktemp -d)"
  mkdir -p "$home/.claude"
  if [ "$shell" = zsh ]; then rc="$home/.zshrc"; else rc="$home/.bashrc"; fi
  cat > "$rc" <<'RC'
export FOO=1
if [ -f ~/.other_aliases ]; then
    . ~/.other_aliases
fi
[ -f "$HOME/.my_aliases" ] && source "$HOME/.my_aliases"
RC
  printf 'alias ll="ls -l"\n' > "$home/.other_aliases"
  printf '%s\n' "$line" > "$home/.my_aliases"
  printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' > "$home/.bash_profile"
  before="$(cat "$rc")"
  dry=$(run_setup "$home" "--shell=$shell" --alias --dry-run)
  # shellcheck disable=SC2001 # a prefix on every line of a multi-line output
  echo "$dry" | sed "s/^/[$label] /"
  echo "$dry" | grep -Fq "already set (in $home/.my_aliases, which $rc loads)" || fail "$label" "the dry run doesn't find ccc in the loaded file"
  if echo "$dry" | grep -q 'would add ccc'; then fail "$label" "the dry run would add ccc"; fi
  real=$(run_setup "$home" "--shell=$shell" --alias)
  echo "$real" | grep -Fq "already set (in $home/.my_aliases" || fail "$label" "the setup doesn't find ccc in the loaded file"
  [ "$(cat "$rc")" = "$before" ] || fail "$label" "$rc changed"
  if ls "$rc".bak-antes-* >/dev/null 2>&1; then fail "$label" "$rc was backed up, as if it changed"; fi
  # Another ccc there is the person's: left as is
  printf "alias ccc='echo mine'\n" > "$home/.my_aliases"
  mine=$(run_setup "$home" "--shell=$shell" --alias)
  echo "$mine" | grep -Fq "$home/.my_aliases (which $rc loads) already defines ccc: left as is" || fail "$label" "another ccc in a loaded file isn't left as is"
  [ "$(cat "$rc")" = "$before" ] || fail "$label" "$rc changed over another ccc"
  # Two levels down, through files that also load each other: found, and the loop ends
  printf '[ -f ~/.level1 ] && . ~/.level1\n' > "$home/.my_aliases"
  printf '. ~/.my_aliases\nsource ~/.level2\n' > "$home/.level1"
  printf '. ~/.level1\n%s\n' "$line" > "$home/.level2"
  deep=$(run_setup "$home" "--shell=$shell" --alias)
  echo "$deep" | grep -Fq "already set (in $home/.level2, which $rc loads)" || fail "$label" "ccc two levels down isn't found: $deep"
  [ "$(cat "$rc")" = "$before" ] || fail "$label" "$rc changed with ccc two levels down"
  rm -f "$home/.level1" "$home/.level2"
  # None anywhere: added once
  printf 'alias gs="git status"\n' > "$home/.my_aliases"
  run_setup "$home" "--shell=$shell" --alias >/dev/null
  unchanged "$label" "$(run_setup "$home" "--shell=$shell" --alias)"
  [ "$(grep -c '^# >>> sessions plugin >>>' "$rc")" = 1 ] || fail "$label" "ccc wasn't added exactly once"
  grep -Fxq "$line" "$rc" || fail "$label" "no ccc in $rc"
  rm -rf "$home"
done

# python3 is required: with none on the PATH, the setup says so and changes nothing
label="no python3"
home="$(mktemp -d)"
mkdir -p "$home/bin" "$home/.claude"
for tool in dirname date uname; do ln -s "$(command -v "$tool")" "$home/bin/$tool"; done
code=0
out=$(env -u CLAUDE_CODE_PLUGIN_DIRS -u SESSIONS_DATA_DIR HOME="$home" PATH="$home/bin" "$(command -v bash)" "$setup" 2>&1) || code=$?
[ "$code" = 1 ] || fail "$label" "exit code $code: $out"
echo "$out" | grep -q "^sessions needs python3, and there's no usable one here" || fail "$label" "it didn't say python3 is needed: $out"
if [ -e "$home/.claude/settings.json" ] || [ -e "$home/.claude/mods" ]; then fail "$label" "it changed something"; fi
rm -rf "$home"
echo "setup: ok"
