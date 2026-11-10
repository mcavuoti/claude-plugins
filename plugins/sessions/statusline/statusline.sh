#!/usr/bin/env bash
# Claude Code status line.
#   model · effort · launch-dir · branch · context% · cost
# Reads the status JSON on stdin (see `statusLine` in settings.json).
# Claude runs it at every redraw, background sessions included, so a run starts one program only (jq): the branch is
# read from the repository's files with bash builtins, never with git, and stdin with read, never cat. On a machine
# where an endpoint scanner inspects every process start, each program a redraw starts costs more than the script.
set -uo pipefail

IFS= read -r -d '' input || true

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

# The first line of a file, with bash's read (a last line without a newline counts); 1 if it can't be read
first_line() {
  line1=""
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then return 1; fi
  IFS= read -r line1 <"$1" || [ -n "$line1" ]
}

# A git directory, as git tells one: a HEAD file, and objects (or, a worktree's, a commondir file pointing at them)
is_git_dir() {
  [ -f "$1/HEAD" ] || return 1
  [ -d "$1/objects" ] || [ -f "$1/commondir" ]
}

# The repository holding the physical folder $1, found the way git does: walking up, a .git directory, a .git file's
# "gitdir: <path>" (a worktree or a submodule; a relative path is from the folder the file is in), or the folder
# itself being one (a bare repository, or inside .git). Sets gitdir; 1 if there's none
find_git_dir() {
  local d=$1
  gitdir=""
  while :; do
    if [ -f "$d/.git" ]; then
      first_line "$d/.git" || return 1
      case $line1 in
        "gitdir: "*) gitdir=${line1#gitdir: } ;;
        *) return 1 ;;
      esac
      case $gitdir in
        /*) ;;
        *) gitdir="${d%/}/$gitdir" ;;
      esac
      is_git_dir "$gitdir"
      return
    fi
    if is_git_dir "$d/.git"; then gitdir="${d%/}/.git"; return 0; fi
    if is_git_dir "$d"; then gitdir=$d; return 0; fi
    if [ -z "$d" ] || [ "$d" = / ]; then return 1; fi
    d=${d%/*}
    if [ -z "$d" ]; then d=/; fi
  done
}

# A full object name (40 or 64 hex digits)
is_hash() {
  case $1 in
    *[!0-9a-f]*) return 1 ;;
  esac
  [ ${#1} -eq 40 ] || [ ${#1} -eq 64 ]
}

# What a ref other than a branch points at, from the repository's files: its loose file in the shared git directory
# (a worktree's commondir), else its line in packed-refs. Sets refhash
resolve_ref() {
  local ref=$1 common=$gitdir hash name
  refhash=""
  if first_line "$gitdir/commondir"; then
    case $line1 in
      /*) common=$line1 ;;
      *) common="$gitdir/$line1" ;;
    esac
  fi
  if first_line "$gitdir/$ref" || first_line "$common/$ref"; then
    if is_hash "$line1"; then refhash=$line1; fi
    return
  fi
  [ -r "$common/packed-refs" ] || return
  while read -r hash name; do
    if [ "$name" = "$ref" ] && is_hash "$hash"; then refhash=$hash; return; fi
  done <"$common/packed-refs"
}

# The branch, as `git branch --show-current` prints it, or on a detached HEAD "@" and its first 7 hex digits (what
# `git rev-parse --short HEAD` prints in a repository of fewer than 16384 objects; git's own length grows with the
# repository's size and core.abbrev). A repository that keeps its refs in a reftable (HEAD names refs/heads/.invalid)
# can't be read this way: there git is asked, as before
branch_of() {
  local head sha
  branch=""
  find_git_dir "$1" || return
  first_line "$gitdir/HEAD" || return
  head=$line1
  case $head in
    "ref: refs/heads/.invalid")
      branch=$(git --no-optional-locks -C "$1" branch --show-current 2>/dev/null)
      if [ -z "$branch" ]; then
        sha=$(git --no-optional-locks -C "$1" rev-parse --short HEAD 2>/dev/null)
        if [ -n "$sha" ]; then branch="@${sha}"; fi
      fi
      ;;
    "ref: refs/heads/"*) branch=${head#ref: refs/heads/} ;;
    "ref: "*)
      resolve_ref "${head#ref: }"
      if [ -n "$refhash" ]; then branch="@${refhash:0:7}"; fi
      ;;
    *)
      if is_hash "$head"; then branch="@${head:0:7}"; fi
      ;;
  esac
}

# Branch is read from the live cwd (its physical path, as git sees it), before $HOME is abbreviated away
branch=""
if [ -d "$cur" ] && cd -P -- "$cur" 2>/dev/null; then
  branch_of "$PWD"
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
