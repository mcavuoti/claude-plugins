#!/bin/bash
# Launcher for the sessions mod: shows one session after another in this window, without anything typed into the
# terminal. To switch sessions, the mod writes which one comes next to this window's file and closes the current viewer;
# the launcher clears the screen and opens the next one. If the viewer closes with nothing else written down (you
# exited, the session ended), the launcher ends and the usual terminal is left.
#
# Usage: visor.sh start [--new | --agents | <name>]   what ccc runs: launcher.py decides what opens first
#        visor.sh start tell [--in <folder>] <name|id> [text | -]   ccc tell: hand a session text (no terminal needed)
#        visor.sh attach <id> | agents                  windows the panel opens
#
# The window's file is <data>/windows/<tty with / as _> (<data>: ~/.claude/mods/sessions-data, or SESSIONS_DATA_DIR):
# format=, command= (attach or agents), id=, title=, folder= lines (windowTargetText in state.ts). A file in another
# format (a session running another version of the mod wrote it) isn't followed: the launcher says so and ends.
# SESSIONS_CLAUDE is the claude command (tests), SESSIONS_TTY this window's terminal (tests without one).
#
# Everything lives inside a function and the last line calls it and exits: bash reads the function whole before
# running it, so a new version of this file (when the plugin is updated) doesn't break a launcher that's already running.

FORMAT=2

# python3, unless on a Mac it's the stand-in that asks to install the developer tools
usable_python() {
  local py
  py=$(command -v python3) || return 1
  if [ "$py" = /usr/bin/python3 ] && [ "$(uname -s)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then return 1; fi
  printf '%s' "$py"
}

# The terminal as it was before the previous viewer: mouse, paste, keyboard, alternate screen and cursor
reset_terminal() {
  printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?2004l\033[<u\033[>4;0m\033[?1049l\033[?25h'
  stty sane 2>/dev/null
}

main() {
  local here data claude window file mode py
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  data="${SESSIONS_DATA_DIR:-$HOME/.claude/mods/sessions-data}"
  claude="${SESSIONS_CLAUDE:-claude}"
  # ccc tell runs from scripts, cron or launchd, with no terminal: the launcher hands the text to the session's mod
  if [ "${1:-}" = start ] && [ "${2:-}" = tell ]; then
    shift 2
    py=$(usable_python) || { echo "ccc tell needs python3 (on a Mac: xcode-select --install)"; return 1; }
    "$py" "$here/launcher.py" tell "$@"
    return
  fi
  window="${SESSIONS_TTY:-}"
  if [ -z "$window" ]; then window=$(tty) || { echo "ccc needs a terminal"; return 1; }; fi
  file="$data/windows/${window//\//_}"
  mkdir -p "$data/windows" || return 1
  mode="$1"
  case "$mode" in
    attach)
      [[ "${2:-}" =~ ^[0-9a-f]{8}$ ]] || { echo "usage: visor.sh attach <id>"; return 2; }
      printf 'format=%s\ncommand=attach\nid=%s\n' "$FORMAT" "$2" > "$file" ;;
    agents)
      printf 'format=%s\ncommand=agents\nfolder=%s\n' "$FORMAT" "$PWD" > "$file" ;;
    start)
      shift
      if ! py=$(usable_python); then
        echo "ccc needs python3 (on a Mac: xcode-select --install). Opening the agent view instead."
        printf 'format=%s\ncommand=agents\nfolder=%s\n' "$FORMAT" "$PWD" > "$file"
      else
        rm -f "$file"
        "$py" "$here/launcher.py" start --tty "$window" --file "$file" "$@" || return 0
      fi ;;
    *) echo "usage: visor.sh start [--new | --agents | <name> | tell <name|id> <text>] | attach <id> | agents"; return 2 ;;
  esac

  local cmd id title folder format k v first=1 began code
  while [ -s "$file" ]; do
    cmd='' id='' title='' folder='' format=''
    while IFS='=' read -r k v; do
      case "$k" in
        format) format=$v ;;
        command) cmd=$v ;;
        id) id=$v ;;
        title) title=$v ;;
        folder) folder=$v ;;
      esac
    done < "$file"
    rm -f "$file"
    reset_terminal
    if [ "$format" != "$FORMAT" ]; then
      echo "This window's launcher and the panel run different versions of the sessions mod: restart the sessions (u in the panel, or claude respawn <id>) and open ccc again."
      break
    fi
    clear
    [ -n "$title" ] && printf '\033[2m→ %s\033[0m\n' "$title"
    # Outside macOS, the window title is the session's name: the panel brings a window forward by its title (wmctrl,
    # xdotool). On macOS Terminal.app keeps the title the panel gave the window when it opened it
    if [ -n "$title" ] && [ "$(uname -s)" != Darwin ]; then printf '\033]0;%s\007' "$title"; fi
    # The agent view opens in its folder; if that folder is gone, in the current one
    if [ -n "$folder" ]; then cd "$folder" 2>/dev/null || true; fi
    began=$(date +%s)
    code=0
    case "$cmd" in
      attach) if [[ "$id" =~ ^[0-9a-f]{8}$ ]]; then "$claude" attach "$id"; code=$?; fi ;;
      agents) "$claude" agents --cwd .; code=$? ;;
    esac
    # A viewer that ends at once on the first open of ccc failed to attach (the session went away meanwhile): pick
    # again, once, without it. Unless something was written down for this window: then the panel is switching it
    if [ "$mode" = start ] && [ "$first" = 1 ] && [ "$cmd" = attach ] && [ "$code" -ne 0 ] && [ $(($(date +%s) - began)) -lt 3 ] && [ ! -s "$file" ] && [ -n "${py:-}" ]; then
      reset_terminal
      echo "Couldn't open that session; picking another."
      "$py" "$here/launcher.py" start --tty "$window" --file "$file" --new --exclude "$id"
    fi
    first=0
  done
  # When it ends, the terminal is left as it was before the viewer (without erasing what it left on screen)
  reset_terminal
}

main "$@"; exit
