#!/bin/bash
# Launcher for the sessions mod: shows one session after another in this window, without anything typed into the
# terminal. To switch sessions, the mod writes which one comes next to this window's file; the viewer it shows ends (the
# window's watcher ends it, or the mod closes it) and the launcher opens the next one over the last frame, which stays
# on screen until the next viewer draws. If the viewer closes with nothing else written down (you exited, the session
# ended), the launcher ends and the usual terminal is left.
#
# Usage: visor.sh start [--new | --agents | <name>]   what ccc runs: launcher.py decides what opens first
#        visor.sh start tell [--in <folder>] [--wait[=<s>]] <name|id> [text | -]   ccc tell: hand a session text (no
#                                                                                 terminal needed)
#        visor.sh start section [--session <name|id>] [<title> | -]   ccc section: put a session in one of your sections
#        visor.sh start tidy [--here] [--pinned] [--days <n>] [--list]   ccc tidy: end the sessions you no longer need
#        visor.sh attach <id> | agents                  windows the panel opens
#
# The window's file is <data>/windows/<tty with / as _> (<data>: ~/.claude/mods/sessions-data, or SESSIONS_DATA_DIR):
# format=, command= (attach or agents), id=, title=, folder= and end= lines (windowTargetText in state.ts). A file in
# another format (a session running another version of the mod wrote it) isn't followed: the launcher says so and ends.
# The window's watcher (launcher.py watch) runs beside the loop: it ends the viewer as soon as the file asks for it
# (end=1, written by a panel switching this window), and while it runs the launcher publishes what the window shows in
# <file>.showing (Showing in state.ts), so the panel finds this window with no ps and no question to the terminal.
# python3 is required: without a usable one, the launcher says so and opens nothing.
# SESSIONS_CLAUDE is the claude command (tests), SESSIONS_TTY this window's terminal (tests without one).
#
# Everything lives inside a function and the last line calls it and exits: bash reads the function whole before
# running it, so a new version of this file (when the plugin is updated) doesn't break a launcher that's already running.

FORMAT=3

# python3, unless on a Mac it's the stand-in that asks to install the developer tools
usable_python() {
  local py
  py=$(command -v python3) || return 1
  if [ "$py" = /usr/bin/python3 ] && [ "$(uname -s)" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then return 1; fi
  printf '%s' "$py"
}

# What a viewer turns on, off again: mouse, paste and keyboard modes
modes_off() {
  printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?2004l\033[<u\033[>4;0m'
}

# The terminal as it was before the first viewer: those modes, the alternate screen, the cursor and echo
reset_terminal() {
  modes_off
  printf '\033[?1049l\033[?25h'
  stty sane 2>/dev/null
}

# The window's watcher and the file saying what the window shows, while they're there (see main). They go when the
# launcher ends, however it ends: the viewer closed, the window closed (HUP), ^C; and so does the window's file once
# it's read (left empty)
WATCHER=''
SHOWING=''
WINDOW_FILE=''
# shellcheck disable=SC2317,SC2329 # the EXIT trap runs it (shellcheck 0.9 calls it SC2317, 0.10 and later SC2329)
cleanup() {
  if [ -n "$WATCHER" ]; then kill "$WATCHER" 2>/dev/null; fi
  if [ -n "$SHOWING" ]; then rm -f "$SHOWING"; fi
  if [ -n "$WINDOW_FILE" ] && [ -e "$WINDOW_FILE" ] && [ ! -s "$WINDOW_FILE" ]; then rm -f "$WINDOW_FILE"; fi
}

# Runs a viewer in this window, in the foreground, and returns its exit code: claude <args>, as itself (the subshell
# execs it), without what ccc hands the launcher (SESSIONS_PLUGIN_VERSION/SINCE: a viewer that brings up the background
# service would pass them on to it, and from it to every session it starts: launcher.py's CHILD_ENV), with its own
# stderr (fd 3), while bash's report of a viewer the watcher ended ("Hangup: 1 …", over the last frame) goes nowhere.
# While the watcher runs, the window's .showing is written first, with the viewer's own pid: by /bin/sh, whose $$ is
# the process that then becomes the viewer (bash 3.2 has no BASHPID). $$ in the subshell is the launcher's.
# Usage: viewer <claude> <tty> <attach|agents> <id or ''> <args...>
viewer() {
  local claude="$1" window="$2" what="$3" id="$4"
  shift 4
  { (
    exec 2>&3 3>&-
    unset SESSIONS_PLUGIN_VERSION SESSIONS_PLUGIN_SINCE
    if [ -n "$SHOWING" ]; then
      # shellcheck disable=SC2016 # a script for sh, which expands it
      exec /bin/sh -c '{ printf "format=%s\ntty=%s\ncommand=%s\nid=%s\nviewer=%s\nlauncher=%s\nwatcher=%s\n" "$1" "$2" "$3" "$4" "$$" "$5" "$6" > "$7"; } 2>/dev/null; shift 7; exec "$@"' \
        sh "$FORMAT" "$window" "$what" "$id" "$$" "$WATCHER" "$SHOWING" "$claude" "$@"
    fi
    exec "$claude" "$@"
  ); } 3>&2 2>/dev/null
}

main() {
  local here data claude window file mode py
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  data="${SESSIONS_DATA_DIR:-$HOME/.claude/mods/sessions-data}"
  claude="${SESSIONS_CLAUDE:-claude}"
  py=$(usable_python) || { echo "ccc needs python3, and there's no usable one here (on a Mac: xcode-select --install)"; return 1; }
  # ccc tell runs from scripts, cron or launchd, with no terminal: the launcher hands the text to the session's mod.
  # ccc section and ccc tidy need no window file either: one writes the person's sections.json, the other asks in this
  # terminal and runs claude stop and claude rm
  if [ "${1:-}" = start ] && { [ "${2:-}" = tell ] || [ "${2:-}" = section ] || [ "${2:-}" = tidy ]; }; then
    local what="$2"
    shift 2
    "$py" "$here/launcher.py" "$what" "$@"
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
      rm -f "$file"
      "$py" "$here/launcher.py" start --tty "$window" --file "$file" "$@" || return 0 ;;
    *) echo "usage: visor.sh start [--new | --agents | <name> | tell <name|id> <text> | section <title> | tidy] | attach <id> | agents"; return 2 ;;
  esac

  # The window's watcher, for as long as the launcher runs (it ends by itself once its parent is gone, too)
  WINDOW_FILE=$file
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ -s "$file" ]; then
    "$py" "$here/launcher.py" watch --file "$file" --launcher "$$" < /dev/null > /dev/null 2>&1 &
    WATCHER=$!
    SHOWING="$file.showing"
  fi

  local cmd id title folder format k v first=1 began code system
  # Read once, not on every switch: each command run between two viewers is time before the next one starts
  system=$(uname -s)
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
    # Read: emptied with no command run (rm would be one more process before the next viewer); it goes at the end
    : > "$file"
    if [ "$format" != "$FORMAT" ]; then
      reset_terminal
      echo "This window's launcher and the panel run different versions of the sessions mod: restart the sessions (u in the panel, or claude respawn <id>) and open ccc again."
      break
    fi
    if [ "$first" = 1 ]; then
      # The first viewer starts from the shell's screen: what opens is said there meanwhile
      reset_terminal
      clear
      [ -n "$title" ] && printf '\033[2m→ %s\033[0m\n' "$title"
    else
      # A switch: the last frame stays on the alternate screen until the next viewer draws over it, with no blank
      # screen in between, and a key typed meanwhile isn't echoed over it. In this mode (canonical, no echo) the
      # window's watcher drops what's typed until the next viewer takes the terminal (drop_typed in launcher.py), and
      # Enter (CR) doesn't end a line (-icrnl): claude attach reads its input as soon as it starts, and a whole line
      # would reach it before the watcher drops it
      modes_off
      stty sane -echo -icrnl 2>/dev/null
    fi
    # Outside macOS, the window title is the session's name: the panel brings a window forward by its title (wmctrl,
    # xdotool). On macOS Terminal.app keeps the title the panel gave the window when it opened it
    if [ -n "$title" ] && [ "$system" != Darwin ]; then printf '\033]0;%s\007' "$title"; fi
    # The agent view opens in its folder; if that folder is gone, in the current one
    if [ -n "$folder" ]; then cd "$folder" 2>/dev/null || true; fi
    # A watcher that stopped can't end a viewer: the window stops saying what it shows, and switches the old way
    if [ -n "$WATCHER" ] && ! kill -0 "$WATCHER" 2>/dev/null; then
      WATCHER=''
      rm -f "$SHOWING"
      SHOWING=''
    fi
    began=$SECONDS
    code=0
    case "$cmd" in
      attach) if [[ "$id" =~ ^[0-9a-f]{8}$ ]]; then viewer "$claude" "$window" attach "$id" attach "$id"; code=$?; fi ;;
      agents) viewer "$claude" "$window" agents '' agents --cwd .; code=$? ;;
    esac
    # A viewer that ends at once on the first open of ccc failed to attach (the session went away meanwhile): pick
    # again, once, without it. Unless something was written down for this window: then the panel is switching it
    if [ "$mode" = start ] && [ "$first" = 1 ] && [ "$cmd" = attach ] && [ "$code" -ne 0 ] && [ $((SECONDS - began)) -lt 3 ] && [ ! -s "$file" ]; then
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
