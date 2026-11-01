#!/usr/bin/env bash
# Claude Code status line.
#   model · effort · launch-dir · branch · context% · cost
# Reads the status JSON on stdin (see `statusLine` in settings.json).
set -uo pipefail

input=$(cat)

fields=$(jq -r '
  [ (.model.display_name // .model.id // "?")
  , (.effort.level // "-")
  , (.workspace.project_dir // .cwd // "?")
  , (.workspace.current_dir // .cwd // "?")
  , (if .context_window.used_percentage == null then "-"
     else (.context_window.used_percentage | round | tostring) end)
  , (if .cost.total_cost_usd == null then "-"
     else (.cost.total_cost_usd | tostring) end)
  , (.cost.total_lines_added   // 0 | tostring)
  , (.cost.total_lines_removed // 0 | tostring)
  ] | @tsv' <<<"$input" 2>/dev/null) || fields=""
[ -n "$fields" ] || fields=$'?\t-\t?\t?\t-\t-\t0\t0'

IFS=$'\t' read -r model effort launch cur ctx cost added removed <<<"$fields"

DIM=$'\033[2m'; RESET=$'\033[0m'
CYAN=$'\033[36m'; YELLOW=$'\033[33m'; GREEN=$'\033[32m'
MAGENTA=$'\033[35m'; RED=$'\033[31m'
SEP="${DIM} · ${RESET}"

# Branch is read from the live cwd, before $HOME is abbreviated away.
branch=""
if [ -d "$cur" ]; then
  branch=$(git --no-optional-locks -C "$cur" branch --show-current 2>/dev/null)
  # Detached HEAD reports an empty branch; fall back to the short sha.
  if [ -z "$branch" ] && git --no-optional-locks -C "$cur" rev-parse --git-dir >/dev/null 2>&1; then
    sha=$(git --no-optional-locks -C "$cur" rev-parse --short HEAD 2>/dev/null)
    [ -n "$sha" ] && branch="@${sha}"
  fi
fi

# Abbreviate $HOME as ~ (the \~ keeps bash from tilde-expanding the replacement)
launch="${launch/#$HOME/\~}"
cur="${cur/#$HOME/\~}"

line="${CYAN}${model}${RESET}"
[ "$effort" != "-" ] && line+="${SEP}${YELLOW}${effort}${RESET}"
line+="${SEP}${GREEN}${launch}${RESET}"
# Only note the working dir when it has drifted from the launch dir
[ "$cur" != "$launch" ] && line+="${DIM} (cwd: ${cur})${RESET}"
[ -n "$branch" ] && line+="${SEP}${MAGENTA}${branch}${RESET}"

# Context window: warn as it fills
if [ "$ctx" != "-" ]; then
  if   [ "$ctx" -ge 80 ] 2>/dev/null; then ctx_color=$RED
  elif [ "$ctx" -ge 60 ] 2>/dev/null; then ctx_color=$YELLOW
  else ctx_color=$DIM
  fi
  line+="${SEP}${ctx_color}${ctx}%${RESET}"
fi

# Cost, with lines changed only once there are any
if [ "$cost" != "-" ]; then
  printf -v cost_fmt '$%.2f' "$cost" 2>/dev/null || cost_fmt="\$$cost"
  seg="$cost_fmt"
  [ "$added" != "0" ] || [ "$removed" != "0" ] && seg+=" +${added}/-${removed}"
  line+="${SEP}${DIM}${seg}${RESET}"
fi

printf '%s' "$line"
