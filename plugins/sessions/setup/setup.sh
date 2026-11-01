#!/usr/bin/env bash
# One-time setup for the sessions plugin: the pieces a plugin can't configure by itself, because Claude Code only
# reads them from your own settings.
#   - status line: "statusLine" in ~/.claude/settings.json → the plugin's status line script
#   - keyboard: shift+→ focuses the panel from the prompt, ← goes back to the prompt (~/.claude/keybindings.json)
#   - shell: `ccc` opens the current folder's top session in the terminal window, with its panel (or a Name prompt
#     when there's none). It goes in your shell's startup file: bash ~/.bashrc (plus making the login file load it,
#     since macOS Terminal starts login shells), zsh ~/.zshrc, fish ~/.config/fish/config.fish
#
# The status line and the ccc command are installed in ~/.claude/mods/sessions-data/bin/ (SESSIONS_DATA_DIR): an
# installed plugin lives in a folder that changes with each update, and nothing else writes there. ccc finds the
# enabled plugin each time it runs, so it follows updates; the status line is a copy (run the setup again after an
# update that changes it). An earlier setup's ccc and status line (in ~/.claude/mods/sessions-bin) are moved over.
#
# Every file it changes is backed up first (<file>.bak-antes-<what>-<date-time>). Running it again changes nothing.
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
data="${SESSIONS_DATA_DIR:-$HOME/.claude/mods/sessions-data}"
bin="$data/bin"
old_bin="$HOME/.claude/mods/sessions-bin"
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
# $1 file, $2 what for (the backup is <file>.bak-antes-<what>-<date-time>)
backup() { if [ -f "$1" ] && [ "$dry" -eq 0 ]; then cp -p "$1" "$1.bak-antes-$2-$stamp"; say "  backup: $1.bak-antes-$2-$stamp"; fi; }

# The ccc command (it remembers this copy of the plugin, for when no installed one is found) and the status line
install_copies() {
  if [ "$dry" -eq 1 ]; then say "would install the ccc command and the status line in $bin/"; return; fi
  mkdir -p "$bin"
  ROOT="$root" python3 - "$root/setup/ccc" "$bin/ccc.tmp" <<'PY'
import os, shlex, sys
text = open(sys.argv[1], encoding='utf-8').read()
open(sys.argv[2], 'w', encoding='utf-8').write(text.replace("SETUP_ROOT=''\n", 'SETUP_ROOT=%s\n' % shlex.quote(os.environ['ROOT']), 1))
PY
  mv -f "$bin/ccc.tmp" "$bin/ccc"
  cp "$root/statusline/statusline.sh" "$bin/statusline.sh.tmp" && mv -f "$bin/statusline.sh.tmp" "$bin/statusline.sh"
  chmod +x "$bin/ccc" "$bin/statusline.sh"
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
  [ -f "$settings" ] && [ "$dry" -eq 0 ] && cp -p "$settings" "$settings.bak-antes-statusline-$stamp"
  local result
  result=$(edit_json "$settings" '
want, force, old = sys.argv[1], sys.argv[2] == "1", sys.argv[3]
current = (data.get("statusLine") or {}).get("command")
if current == want:
    note = "(already set)"
elif current and current != old and not force:
    note = "(you already have one: " + str(current) + "; run with --force-statusline to replace it)"
else:
    data["statusLine"] = {"type": "command", "command": want, "padding": 0}
    changed = True
' "$want" "$force_statusline" "$old_bin/statusline.sh")
  if [ "${result%% *}" = CHANGED ]; then
    if [ "$dry" -eq 1 ]; then say "  would set statusLine → $want"
    else [ -f "$settings.bak-antes-statusline-$stamp" ] && say "  backup: $settings.bak-antes-statusline-$stamp"; say "  statusLine → $want"; fi
  else
    rm -f "$settings.bak-antes-statusline-$stamp"
    say "  ${result#UNCHANGED }"
  fi
}

setup_keys() {
  say "Keyboard"
  local result
  [ -f "$keybindings" ] && [ "$dry" -eq 0 ] && cp -p "$keybindings" "$keybindings.bak-antes-keys-$stamp"
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
    else [ -f "$keybindings.bak-antes-keys-$stamp" ] && say "  backup: $keybindings.bak-antes-keys-$stamp"; say "  added the missing keys: shift+right (to the panel), left (back to the prompt)"; fi
    note="${result#CHANGED }"; if [ -n "$note" ]; then say "  $note"; fi
  else
    rm -f "$keybindings.bak-antes-keys-$stamp"
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
  backup "$file" ccc
  printf '\n# >>> sessions plugin >>>\n%s\n# <<< sessions plugin <<<\n' "$body" >> "$file"
}

setup_alias() {
  say "Shell shortcut (ccc)"
  local shell rc line comment="# ccc: open this folder's top Claude session here, with its panel (ccc <name>, ccc --new, ccc --agents)"
  local command="$bin/ccc"
  [ "$command" = "$HOME/.claude/mods/sessions-data/bin/ccc" ] && command="~/.claude/mods/sessions-data/bin/ccc"
  shell="$(detect_shell)"
  case "$shell" in
    bash) rc="$HOME/.bashrc"; line="alias ccc='bash $command'" ;;
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc"; line="alias ccc='bash $command'" ;;
    fish) rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"; line="alias ccc 'bash $command'" ;;
    *) say "  your shell is $shell: add a shortcut that runs this command to its startup file yourself:"
       say "    bash $command"; return ;;
  esac
  say "  shell: $shell → $rc"
  if [ -f "$rc" ] && grep -Fxq "$line" "$rc"; then say "  already set"; return; fi
  # A ccc this plugin wrote before (inside its block, or pointing at an old launcher) is replaced; any other is yours
  if [ -f "$rc" ] && { sed -n '/^# >>> sessions plugin >>>/,/^# <<< sessions plugin <<</p' "$rc" | grep -Eq '^[[:space:]]*alias ccc[= ]' \
      || grep -Eq "^[[:space:]]*alias ccc[= ].*(sessions/hooks|sessions-bin)/visor\.sh" "$rc"; }; then
    if [ "$dry" -eq 1 ]; then say "  would replace the plugin's earlier ccc with: $line"
    else
      backup "$rc" ccc-start
      CCC_LINE="$line" CCC_COMMENT="$comment" python3 - "$rc" <<'PY'
import os, re, sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
line, comment = os.environ['CCC_LINE'], os.environ['CCC_COMMENT']
def block(m):
    body = re.sub(r'(?m)^[ \t]*alias ccc[= ].*$', lambda _: line, m.group(0))
    return re.sub(r'(?m)^# (Open this folder|ccc: open).*$', lambda _: comment, body)
text = re.sub(r'(?ms)^# >>> sessions plugin >>>$.*?^# <<< sessions plugin <<<$', block, text)
text = re.sub(r'(?m)^[ \t]*alias ccc[= ].*(sessions/hooks|sessions-bin)/visor\.sh.*$', lambda _: line, text)
open(path, 'w', encoding='utf-8').write(text)
PY
      say "  replaced the plugin's earlier ccc (it opened the agent view): $line"
    fi
    return
  fi
  if [ -f "$rc" ] && grep -Eq '^[[:space:]]*(alias ccc[= ]|function ccc|ccc[[:space:]]*\(\))' "$rc"; then
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
  [ -f "$settings" ] && cp -p "$settings" "$settings.bak-antes-macos-launcher-$stamp"
  local result
  result=$(edit_json "$settings" '
dest = sys.argv[1]
env = data.setdefault("env", {})
if env.get("CLAUDE_CODE_PROCESS_WRAPPER") != dest:
    env["CLAUDE_CODE_PROCESS_WRAPPER"] = dest
    changed = True
' "$dest")
  if [ "${result%% *}" = CHANGED ]; then
    say "  backup: $settings.bak-antes-macos-launcher-$stamp"
    say "  CLAUDE_CODE_PROCESS_WRAPPER → $dest (takes effect when the background service restarts)"
  else
    rm -f "$settings.bak-antes-macos-launcher-$stamp"; say "  already set"
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
