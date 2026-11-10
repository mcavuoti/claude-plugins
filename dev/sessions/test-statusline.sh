#!/usr/bin/env bash
# Tests the status line (plugins/sessions/statusline/statusline.sh): it prints what the version that asked git for the
# branch printed (kept below as the reference), on repositories made here (a branch, a subfolder, a worktree, a
# detached HEAD, a submodule's relative gitdir, a HEAD on a packed remote ref, inside .git, a bare repository, an unborn
# branch, a folder through a symbolic link, no repository, a folder that's gone), with each bash found (macOS's 3.2 and
# a newer one), and that a run starts no program but jq. The CI runs it on macOS and Linux; it's safe to run anywhere
# (it only reads and writes a throwaway folder).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/plugins/sessions/statusline/statusline.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL ($1): $2" >&2; exit 1; }
pass() { echo "ok: $1"; }
# The folder as the scripts see it (macOS's temporary folder is behind a symbolic link)
work="$(cd -P "$work" && pwd)"

# The status line as it was when it asked git for the branch: the reference for what's printed
cat > "$work/reference.sh" <<'OLD_STATUSLINE'
#!/usr/bin/env bash
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

branch=""
if [ -d "$cur" ]; then
  branch=$(git --no-optional-locks -C "$cur" branch --show-current 2>/dev/null)
  if [ -z "$branch" ] && git --no-optional-locks -C "$cur" rev-parse --git-dir >/dev/null 2>&1; then
    sha=$(git --no-optional-locks -C "$cur" rev-parse --short HEAD 2>/dev/null)
    [ -n "$sha" ] && branch="@${sha}"
  fi
fi

launch="${launch/#$HOME/\~}"
cur="${cur/#$HOME/\~}"

line="${CYAN}${model}${RESET}"
[ "$effort" != "-" ] && line+="${SEP}${YELLOW}${effort}${RESET}"
line+="${SEP}${GREEN}${launch}${RESET}"
[ "$cur" != "$launch" ] && line+="${DIM} (cwd: ${cur})${RESET}"
[ -n "$branch" ] && line+="${SEP}${MAGENTA}${branch}${RESET}"

if [ "$ctx" != "-" ]; then
  if   [ "$ctx" -ge 80 ] 2>/dev/null; then ctx_color=$RED
  elif [ "$ctx" -ge 60 ] 2>/dev/null; then ctx_color=$YELLOW
  else ctx_color=$DIM
  fi
  line+="${SEP}${ctx_color}${ctx}%${RESET}"
fi

if [ "$cost" != "-" ]; then
  printf -v cost_fmt '$%.2f' "$cost" 2>/dev/null || cost_fmt="\$$cost"
  seg="$cost_fmt"
  [ "$added" != "0" ] || [ "$removed" != "0" ] && seg+=" +${added}/-${removed}"
  line+="${SEP}${DIM}${seg}${RESET}"
fi

printf '%s' "$line"
OLD_STATUSLINE

# Git with nothing of this machine's configuration
export HOME="$work/home" GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@example.com GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@example.com
mkdir -p "$HOME"
g() { git -c init.defaultBranch=main -c advice.detachedHead=false "$@" >/dev/null 2>&1; }

r="$work/repo"
g init "$r"
g -C "$r" commit --allow-empty -m one
g -C "$r" commit --allow-empty -m two
mkdir -p "$r/sub/deeper"
g -C "$r" worktree add -b feature/x "$work/wt"
g -C "$r" worktree add --detach "$work/wt-detached" HEAD~1
d="$work/detached"
g clone "$r" "$d"
g -C "$d" checkout --detach HEAD~1
# A submodule's checkout: a .git file with a relative gitdir
s="$work/super"
g init "$s"
g init "$s/child"
mkdir -p "$s/.git/modules"
mv "$s/child/.git" "$s/.git/modules/child"
printf 'gitdir: ../.git/modules/child\n' > "$s/child/.git"
g -C "$s/child" commit --allow-empty -m one
# HEAD on a remote ref that lives only in packed-refs
p="$work/packed"
g clone "$r" "$p"
g -C "$p" symbolic-ref HEAD refs/remotes/origin/main
g -C "$p" pack-refs --all
u="$work/unborn"
g init "$u"
g -C "$u" symbolic-ref HEAD refs/heads/not-yet
b="$work/bare.git"
g clone --bare "$r" "$b"
ln -s "$r/sub" "$work/link"
mkdir -p "$work/plain/a"
# An empty .git folder isn't a repository: git looks further up
mkdir -p "$r/sub/fake/.git"

# status <cwd> [project dir]: the status JSON Claude passes
status() {
  printf '{"model":{"display_name":"Opus"},"effort":{"level":"high"},"workspace":{"project_dir":"%s","current_dir":"%s"},"context_window":{"used_percentage":63.4},"cost":{"total_cost_usd":1.5,"total_lines_added":3,"total_lines_removed":1}}' "${2:-$1}" "$1"
}

cases=(
  "$r" "$r/sub/deeper" "$r/sub/fake" "$r/.git" "$r/.git/refs"
  "$work/wt" "$work/wt-detached" "$d" "$s" "$s/child" "$p" "$u" "$b" "$work/link"
  "$work/plain/a" "$work/gone" "relative/folder" "/"
)
# Refs in a reftable (git 2.45 and newer), which the files don't show: there the status line asks git, as before
if g init --ref-format=reftable "$work/reftable"; then
  g -C "$work/reftable" commit --allow-empty -m one
  cases+=("$work/reftable")
  g clone --ref-format=reftable "$r" "$work/reftable-detached"
  g -C "$work/reftable-detached" checkout --detach HEAD~1
  cases+=("$work/reftable-detached")
fi
shells=()
for sh in /bin/bash "$(command -v bash)"; do
  if [ -x "$sh" ]; then
    case " ${shells[*]-} " in
      *" $sh "*) ;;
      *) shells+=("$sh") ;;
    esac
  fi
done

for sh in "${shells[@]}"; do
  for c in "${cases[@]}"; do
    want="$(status "$c" "$r" | "$sh" "$work/reference.sh")"
    got="$(status "$c" "$r" | "$sh" "$script")"
    if [ "$got" != "$want" ]; then fail "$sh, $c" "printed $(printf '%q' "$got"), the reference $(printf '%q' "$want")"; fi
  done
  # Input that isn't JSON, and none at all
  for input in 'not json' ''; do
    want="$(printf '%s' "$input" | "$sh" "$work/reference.sh")"
    got="$(printf '%s' "$input" | "$sh" "$script")"
    if [ "$got" != "$want" ]; then fail "$sh, input $(printf '%q' "$input")" "printed $(printf '%q' "$got"), the reference $(printf '%q' "$want")"; fi
  done
  # shellcheck disable=SC2016 # the inner bash expands it
  pass "bash $("$sh" -c 'echo "$BASH_VERSION"'): the same line as the reference in ${#cases[@]} folders and 2 broken inputs"
done

# Branches the reference shows, so the comparison above isn't between two empty fields
for pair in "$r|main" "$r/sub/deeper|main" "$work/wt|feature/x" "$s/child|main" "$u|not-yet" "$b|main" "$work/link|main"; do
  got="$(status "${pair%%|*}" | bash "$script")"
  case $got in
    *"${pair#*|}"*) ;;
    *) fail "${pair%%|*}" "no ${pair#*|} in $(printf '%q' "$got")" ;;
  esac
done
for c in "$d" "$work/wt-detached" "$p"; do
  case $(status "$c" | bash "$script") in
    *@[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) fail "$c" "no @<short hash>" ;;
  esac
done
pass "branches, worktrees, a submodule, unborn and bare: the branch; detached HEADs: @<short hash>"

# What a run starts: each of these programs found on the PATH goes through a stand-in that notes its name
shim="$work/shim"
mkdir -p "$shim"
for prog in jq git cat date tr sed awk head mkdir mv ps; do
  real="$(command -v "$prog" || true)"
  if [ -n "$real" ]; then
    printf '#!/bin/sh\necho %s >> "%s/started"\nexec "%s" "$@"\n' "$prog" "$work" "$real" > "$shim/$prog"
    chmod +x "$shim/$prog"
  fi
done
started() {
  local names=""
  if [ -f "$work/started" ]; then
    while read -r n; do names+="$n "; done < "$work/started"
  fi
  printf '%s' "${names% }"
}
for c in "$r/sub/deeper" "$work/wt" "$d" "$p" "$work/plain/a"; do
  rm -f "$work/started"
  status "$c" | PATH="$shim:$PATH" bash "$script" >/dev/null
  if [ "$(started)" != jq ]; then fail "$c" "a run started: $(started)"; fi
done
rm -f "$work/started"
status "$r/sub/deeper" | PATH="$shim:$PATH" bash "$work/reference.sh" >/dev/null
on_branch="$(started)"
rm -f "$work/started"
status "$d" | PATH="$shim:$PATH" bash "$work/reference.sh" >/dev/null
pass "a run starts jq and nothing else (the reference started $on_branch on a branch, $(started) on a detached HEAD)"
