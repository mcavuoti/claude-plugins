#!/usr/bin/env bash
# One-time setup for the sessions plugin: the pieces a plugin can't configure by itself, because Claude Code only
# reads them from your own settings.
#   - status line: "statusLine" in ~/.claude/settings.json → the plugin's status line script
#   - keyboard: shift+→ focuses the panel from the prompt, ← goes back to the prompt (~/.claude/keybindings.json)
#   - shell: `ccc` opens the current folder's sessions in the agents view through the launcher, without starting a
#     new session. It goes in your shell's startup file: bash ~/.bashrc (plus making the login file load it, since
#     macOS Terminal starts login shells), zsh ~/.zshrc, fish ~/.config/fish/config.fish
#
# The status line and the launcher run from fixed copies in ~/.claude/mods/sessions-bin/, which the mod refreshes
# every time a session starts: an installed plugin lives in a folder that changes with each update.
#
# Every file it changes is backed up first (<file>.bak-sessions-<date-time>). Running it again changes nothing.
#
# Usage: setup.sh [--statusline] [--keys] [--alias] [--force-statusline] [--macos-launcher] [--shell=NAME] [--dry-run]
#   With none of --statusline/--keys/--alias, it does all three.
#   --force-statusline   replace a status line you already have (by default it's kept, and the setup says so)
#   --shell=NAME         bash, zsh or fish, if your terminal runs another shell than your account's login shell
#   --macos-launcher     macOS: run background sessions from a fixed copy of Claude, so macOS keeps folder permissions
#                        (Desktop, Documents) across Claude updates; see extras/macos/claude-bg-launcher
#   --dry-run            print what would change, change nothing
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$HOME/.claude/mods/sessions-bin"
settings="$HOME/.claude/settings.json"
keybindings="$HOME/.claude/keybindings.json"
stamp="$(date +%Y%m%d-%H%M%S)"

do_statusline=0 do_keys=0 do_alias=0 force_statusline=0 macos_launcher=0 dry=0 shell_override=""
for arg in "$@"; do
  case "$arg" in
    --shell=*) shell_override="${arg#--shell=}" ;;
    --statusline) do_statusline=1 ;;
    --keys) do_keys=1 ;;
    --alias) do_alias=1 ;;
    --all) do_statusline=1 do_keys=1 do_alias=1 ;;
    --force-statusline) force_statusline=1 ;;
    --macos-launcher) macos_launcher=1 ;;
    --dry-run) dry=1 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done
if [ $((do_statusline + do_keys + do_alias)) -eq 0 ]; then do_statusline=1 do_keys=1 do_alias=1; fi

command -v python3 >/dev/null || { echo "setup needs python3 (to edit JSON settings safely)" >&2; exit 1; }

say() { printf '%s\n' "$*"; }
backup() { if [ -f "$1" ] && [ "$dry" -eq 0 ]; then cp -p "$1" "$1.bak-sessions-$stamp"; say "  backup: $1.bak-sessions-$stamp"; fi; }

# The fixed copies (the mod keeps them up to date afterwards)
install_copies() {
  if [ "$dry" -eq 1 ]; then say "would copy the launcher and the status line to $bin/"; return; fi
  mkdir -p "$bin"
  cp "$root/hooks/visor.sh" "$bin/visor.sh"
  cp "$root/statusline/statusline.sh" "$bin/statusline.sh"
  chmod +x "$bin/visor.sh" "$bin/statusline.sh"
}

# Edits a JSON file with a small Python program; prints CHANGED or UNCHANGED, then a note (what was left as is).
# $1 file, $2 program (gets `data`, sets `changed` and `note`), extra args become sys.argv[1:]
edit_json() {
  local file="$1" program="$2"; shift 2
  FILE="$file" DRY="$dry" python3 - "$@" <<PY
import json, os, sys
path = os.environ['FILE']
data = {}
if os.path.exists(path):
    with open(path, encoding='utf-8') as f:
        text = f.read().strip()
    data = json.loads(text) if text else {}
changed = False
note = ''
$program
if changed and os.environ['DRY'] != '1':
    tmp = path + '.tmp-sessions'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)
print(('CHANGED ' if changed else 'UNCHANGED ') + note)
PY
}

setup_statusline() {
  say "Status line"
  local want="$bin/statusline.sh"
  command -v jq >/dev/null || say "  note: the status line script needs jq (brew install jq / apt install jq)"
  [ -f "$settings" ] && [ "$dry" -eq 0 ] && cp -p "$settings" "$settings.bak-sessions-$stamp"
  local result
  result=$(edit_json "$settings" '
want, force = sys.argv[1], sys.argv[2] == "1"
current = (data.get("statusLine") or {}).get("command")
if current == want:
    note = "(already set)"
elif current and not force:
    note = "(you already have one: " + str(current) + "; run with --force-statusline to replace it)"
else:
    data["statusLine"] = {"type": "command", "command": want, "padding": 0}
    changed = True
' "$want" "$force_statusline")
  if [ "${result%% *}" = CHANGED ]; then
    if [ "$dry" -eq 1 ]; then say "  would set statusLine → $want"
    else [ -f "$settings.bak-sessions-$stamp" ] && say "  backup: $settings.bak-sessions-$stamp"; say "  statusLine → $want"; fi
  else
    rm -f "$settings.bak-sessions-$stamp"
    say "  ${result#UNCHANGED }"
  fi
}

setup_keys() {
  say "Keyboard"
  local result
  [ -f "$keybindings" ] && [ "$dry" -eq 0 ] && cp -p "$keybindings" "$keybindings.bak-sessions-$stamp"
  result=$(edit_json "$keybindings" '
data = {"$schema": data.get("$schema", "https://www.schemastore.org/claude-code-keybindings.json"),
        "$docs": data.get("$docs", "https://code.claude.com/docs/en/keybindings"), **data}
blocks = data.setdefault("bindings", [])
notes = []
for context, key, action in (("Chat", "shift+right", "abovePrompt:focus"), ("Pane", "left", "abovePrompt:leave")):
    block = next((b for b in blocks if b.get("context") == context), None)
    if block is None:
        block = {"context": context, "bindings": {}}
        blocks.append(block)
    current = block.setdefault("bindings", {}).get(key)
    if current == action:
        continue
    if current:
        notes.append(f"{context} {key} is already bound to {current}: left as is")
        continue
    block["bindings"][key] = action
    changed = True
note = "; ".join(notes) if notes else ("" if changed else "(already set)")
')
  if [ "${result%% *}" = CHANGED ]; then
    if [ "$dry" -eq 1 ]; then say "  would add the missing keys: shift+right (to the panel), left (back to the prompt)"
    else [ -f "$keybindings.bak-sessions-$stamp" ] && say "  backup: $keybindings.bak-sessions-$stamp"; say "  added the missing keys: shift+right (to the panel), left (back to the prompt)"; fi
    note="${result#CHANGED }"; if [ -n "$note" ]; then say "  $note"; fi
  else
    rm -f "$keybindings.bak-sessions-$stamp"
    say "  ${result#UNCHANGED }"
  fi
}

# The user's shell: the login shell recorded for the account (what a new terminal window starts), else $SHELL.
# --shell overrides it (for a terminal set to run another shell than the account's)
detect_shell() {
  local s=""
  if [ -n "$shell_override" ]; then s="$shell_override"
  elif [ "$(uname -s)" = Darwin ]; then s="$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk '{print $2}')"
  elif command -v getent >/dev/null; then s="$(getent passwd "$(id -un)" | cut -d: -f7)"
  fi
  [ -n "$s" ] || s="${SHELL:-}"
  basename "$s"
}

# Appends a marked block to a startup file (with a backup), or does nothing if the block is already there
add_block() {
  local file="$1" body="$2"
  if [ -f "$file" ] && grep -q '^# >>> sessions plugin >>>' "$file"; then return 1; fi
  [ "$dry" -eq 1 ] && return 0
  mkdir -p "$(dirname "$file")"
  backup "$file"
  printf '\n# >>> sessions plugin >>>\n%s\n# <<< sessions plugin <<<\n' "$body" >> "$file"
}

setup_alias() {
  say "Shell shortcut (ccc)"
  local shell rc line comment="# Open this folder's Claude sessions in the agents view, without starting a new one"
  local launcher="~/.claude/mods/sessions-bin/visor.sh"
  shell="$(detect_shell)"
  case "$shell" in
    bash) rc="$HOME/.bashrc"; line="alias ccc='bash $launcher agents'" ;;
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc"; line="alias ccc='bash $launcher agents'" ;;
    fish) rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"; line="alias ccc 'bash $launcher agents'" ;;
    *) say "  your shell is $shell: add a shortcut that runs this command to its startup file yourself:"
       say "    bash $launcher agents"; return ;;
  esac
  say "  shell: $shell → $rc"
  # A ccc that runs the launcher from the plugin's old folder (manual installs) is replaced; any other ccc is the user's
  if [ -f "$rc" ] && grep -Eq "^[[:space:]]*alias ccc[= ].*sessions/hooks/visor\.sh" "$rc"; then
    if [ "$dry" -eq 1 ]; then say "  would replace the old ccc (pointing at the old launcher folder)"
    else
      backup "$rc"
      CCC_LINE="$line" python3 - "$rc" <<'PY'
import os, re, sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
new = re.sub(r'(?m)^[ \t]*alias ccc[= ].*sessions/hooks/visor\.sh.*$', lambda m: os.environ['CCC_LINE'], text)
open(path, 'w', encoding='utf-8').write(new)
PY
      say "  replaced the old ccc (it pointed at the old launcher folder)"
    fi
    return
  fi
  if [ -f "$rc" ] && grep -Fxq "$line" "$rc"; then say "  already set"; return; fi
  if [ -f "$rc" ] && grep -Eq '^[[:space:]]*(alias ccc[= ]|function ccc|ccc[[:space:]]*\(\))' "$rc" && ! grep -q '^# >>> sessions plugin >>>' "$rc"; then
    say "  $rc already defines ccc: left as is. To use the plugin's, replace it with:"; say "    $line"; return
  fi
  if add_block "$rc" "$comment"$'\n'"$line"; then
    if [ "$dry" -eq 1 ]; then say "  would add ccc to $rc"; else say "  added ccc (open a new terminal to use it)"; fi
  else
    say "  already set"
  fi
  # bash reads ~/.bashrc only in non-login shells. macOS Terminal (and ssh) start login shells, which read the first
  # of ~/.bash_profile, ~/.bash_login, ~/.profile instead: make sure that one loads ~/.bashrc
  if [ "$shell" = bash ]; then
    local login="" f
    for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do [ -f "$f" ] && { login="$f"; break; }; done
    [ -n "$login" ] || login="$HOME/.bash_profile"
    if ! grep -Eqs '(\.|source)[[:space:]]+[^#]*\.bashrc' "$login"; then
      if add_block "$login" "# Login shells (macOS Terminal, ssh) read this file, not ~/.bashrc: load it so ccc is there"$'\n''[ -f ~/.bashrc ] && . ~/.bashrc'; then
        if [ "$dry" -eq 1 ]; then say "  would make $login load ~/.bashrc (login shells read it instead)"
        else say "  $login now loads ~/.bashrc (login shells, like macOS Terminal's, read it instead)"; fi
      fi
    fi
  fi
}

setup_macos_launcher() {
  say "macOS launcher for background sessions"
  if [ "$(uname -s)" != Darwin ]; then say "  only for macOS: skipped"; return; fi
  local dest="$HOME/.local/bin/claude-bg-launcher"
  if [ "$dry" -eq 1 ]; then say "  would copy it to $dest and set CLAUDE_CODE_PROCESS_WRAPPER"; return; fi
  mkdir -p "$(dirname "$dest")"
  cp "$root/extras/macos/claude-bg-launcher" "$dest"
  chmod +x "$dest"
  [ -f "$settings" ] && cp -p "$settings" "$settings.bak-sessions-$stamp"
  local result
  result=$(edit_json "$settings" '
dest = sys.argv[1]
env = data.setdefault("env", {})
if env.get("CLAUDE_CODE_PROCESS_WRAPPER") != dest:
    env["CLAUDE_CODE_PROCESS_WRAPPER"] = dest
    changed = True
' "$dest")
  if [ "${result%% *}" = CHANGED ]; then
    say "  backup: $settings.bak-sessions-$stamp"
    say "  CLAUDE_CODE_PROCESS_WRAPPER → $dest (takes effect when the background service restarts)"
  else
    rm -f "$settings.bak-sessions-$stamp"; say "  already set"
  fi
}

if [ "$dry" -eq 1 ]; then say "(dry run: nothing is changed)"; fi
install_copies
if [ "$do_statusline" -eq 1 ]; then setup_statusline; fi
if [ "$do_keys" -eq 1 ]; then setup_keys; fi
if [ "$do_alias" -eq 1 ]; then setup_alias; fi
if [ "$macos_launcher" -eq 1 ]; then setup_macos_launcher; fi
if [ -n "${CLAUDE_CODE_PLUGIN_DIRS:-}" ] || grep -qs 'CLAUDE_CODE_PLUGIN_DIRS' "$settings"; then
  say "Note: CLAUDE_CODE_PLUGIN_DIRS is set. A plugin folder loaded that way (sessions@inline) wins over the installed"
  say "plugin of the same name. Remove it from env in ~/.claude/settings.json and add"
  say "  \"enabledPlugins\": {\"sessions@inline\": false}"
  say "there too: the background service keeps passing the old variable to the sessions it starts until it restarts."
fi
say "Done."
