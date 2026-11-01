#!/bin/bash
# Launcher for the sessions mod: shows one session after another in this window, without the mod typing commands into
# the terminal. To switch sessions, the mod writes which one comes next to a file for this window and closes the current
# viewer; the launcher clears the screen and opens the next one. If the viewer closes with no other one written down
# (you exited, the session ended), the launcher ends and the usual terminal is left.
#
# Usage: visor.sh [attach <id> | agents]   (the first session; the mod writes down the following ones)
#
# The target file is a wire format read by launchers already running (and written by other versions of the mod): its
# keys (comando, id, titulo, carpeta = command, id, title, folder) and the sessions-visor folder stay as they are.
#
# Everything lives inside a function: bash reads it whole before starting, so a new version of this file (when the mod
# is updated) doesn't break a launcher that's already running.

main() {
  local dir="$HOME/.claude/mods/sessions-visor"
  local window
  window=$(tty) || return 1
  local file="$dir/${window//\//_}"
  mkdir -p "$dir" || return 1
  if [ "$1" = attach ] && [ -n "$2" ]; then
    printf 'comando=attach\nid=%s\n' "$2" > "$file"
  elif [ "$1" = agents ]; then
    printf 'comando=agents\n' > "$file"
  fi
  # This is how the mod knows this window has a launcher
  printf '%s\n' "$$" > "$file.pid"

  local cmd id title folder k v
  while [ -s "$file" ]; do
    cmd='' id='' title='' folder=''
    while IFS='=' read -r k v; do
      case "$k" in
        comando) cmd=$v ;;
        id) id=$v ;;
        titulo) title=$v ;;
        carpeta) folder=$v ;;
      esac
    done < "$file"
    rm -f "$file"
    # The terminal as it was before the previous viewer: mouse, paste, keyboard, alternate screen and cursor
    printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?2004l\033[<u\033[>4;0m\033[?1049l\033[?25h'
    stty sane 2>/dev/null
    clear
    [ -n "$title" ] && printf '\033[2m→ %s\033[0m\n' "$title"
    # Outside macOS, the window title is the session's name: the panel brings a window forward by its title (wmctrl,
    # xdotool). On macOS Terminal.app keeps the title the panel gave the window when it opened it
    if [ -n "$title" ] && [ "$(uname -s)" != Darwin ]; then printf '\033]0;%s\007' "$title"; fi
    [ -n "$folder" ] && cd "$folder" 2>/dev/null
    case "$cmd" in
      attach) [[ "$id" =~ ^[0-9a-f]{8}$ ]] && claude attach "$id" ;;
      agents) claude agents --cwd . ;;
    esac
  done
  # When it ends, the terminal is left as it was before the viewer (without erasing what it left on screen)
  printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?2004l\033[<u\033[>4;0m\033[?1049l\033[?25h'
  stty sane 2>/dev/null
  rm -f "$file.pid"
}

main "$@"
exit
