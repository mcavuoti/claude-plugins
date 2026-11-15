#!/usr/bin/env bash
# Tests the process sampler of /sessions debug perf (plugins/sessions/hooks/debug/sampler.py): a real window of 3 s over
# a stand-in session this script starts (a shell that keeps one `sleep` and starts short ones), then its parsers and its
# sums with made-up text for both systems (test_sampler.py). The CI runs it on macOS and Linux; it's safe to run
# anywhere: it reads the process list, touches no session, and writes only in a throwaway folder.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sampler="$root/plugins/sessions/hooks/debug/sampler.py"
checks="$root/dev/sessions/test_sampler.py"
work="$(mktemp -d)"
session=''
short=''
# shellcheck disable=SC2317,SC2329 # only the trap calls it
cleanup() {
  if [ -n "$session" ]; then kill "$session" 2>/dev/null || true; fi
  if [ -n "$short" ]; then kill "$short" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "FAIL ($1): $2" >&2; exit 1; }
pass() { echo "ok: $1"; }

# Which readings to ask for: the sampler itself never looks at the system it runs on
case "$(uname -s)" in
  Darwin) how=libproc; wrong=procfs ;;
  Linux) how=procfs; wrong=libproc ;;
  *) echo "sampler: no readings for $(uname -s), nothing to test"; exit 0 ;;
esac

# ---- command lines it doesn't take (exit code 2), and readings this system doesn't have (exit code 1) ----

# refused <what> <arguments...>: the sampler ends with code 2 and writes nothing
refused() {
  local what="$1" code=0
  shift
  python3 "$sampler" "$@" 2>"$work/err" || code=$?
  [ "$code" = 2 ] || fail "$what" "expected exit code 2, got $code"
  grep -q '^usage: sampler.py perf' "$work/err" || fail "$what" "no usage line: $(cat "$work/err")"
  [ ! -e "$work/out.json" ] || fail "$what" "it wrote an output"
}
refused "no command"
refused "a relative --out" perf --how "$how" --seconds 1 --sessions "$$:aaaaaaaa-1" --programs git --terminals Terminal --out out.json
refused "a program that is a path" perf --how "$how" --seconds 1 --sessions "$$:aaaaaaaa-1" --programs /bin/sh --terminals Terminal --out "$work/out.json"
refused "a session id that is a path" perf --how "$how" --seconds 1 --sessions "$$:../x" --programs git --terminals Terminal --out "$work/out.json"
refused "no sessions" perf --how "$how" --seconds 1 --programs git --terminals Terminal --out "$work/out.json"
refused "an unknown --how" perf --how guess --seconds 1 --sessions "$$:aaaaaaaa-1" --programs git --terminals Terminal --out "$work/out.json"
pass "sampler: a command line it doesn't take ends with code 2 and writes nothing"

code=0
python3 "$sampler" perf --how "$wrong" --seconds 1 --sessions "$$:aaaaaaaa-1" --programs git --terminals Terminal --out "$work/out.json" 2>"$work/err" || code=$?
[ "$code" = 1 ] || fail "--how $wrong" "expected exit code 1, got $code"
[ "$(wc -l < "$work/err" | tr -d ' ')" = 1 ] || fail "--how $wrong" "expected one line on stderr, got: $(cat "$work/err")"
[ ! -e "$work/out.json" ] || fail "--how $wrong" "it wrote an output"
pass "sampler: --how $wrong can't work here: code 1 and one line, with no look at which system this is"

# ---- a real window ----

# The stand-in session: a `sleep` that stays (a helper at the close) and short ones that come and go (starts)
cat > "$work/session.sh" <<'EOF'
sleep 60 &
helper=$!
trap 'kill "$helper" 2>/dev/null' EXIT
trap 'exit 0' TERM
: > "$1"
while :; do sleep 0.4; done
EOF
bash "$work/session.sh" "$work/ready" &
session=$!
tries=0
until [ -e "$work/ready" ]; do
  tries=$((tries + 1))
  [ "$tries" -le 100 ] || fail "the stand-in session" "it didn't start"
  sleep 0.1
done

# Its conversation file, 2 MB of nothing: only its size is read
mkdir -p "$work/projects/-Users-x-myapp"
dd if=/dev/zero of="$work/projects/-Users-x-myapp/aaaaaaaa-1.jsonl" bs=1048576 count=2 2>/dev/null

# A second "session" that ends inside the window, and a pid that is no process (above what either system gives out)
sleep 1.5 &
short=$!
missing=4999999
sessions="$session:aaaaaaaa-1,$short:bbbbbbbb-1,$missing:cccccccc-1"

# Two windows at once over the same processes: one with `sleep` on the list of programs, one without
python3 "$sampler" perf --how "$how" --seconds 3 --interval 0.2 --sessions "$sessions" --programs sleep,git \
  --terminals Terminal,iTerm2 --projects-dir "$work/projects" --out "$work/listed.json" &
one=$!
python3 "$sampler" perf --how="$how" --seconds=3 --interval=0.2 --sessions="$sessions" --programs=git \
  --terminals=Terminal,iTerm2 --projects-dir="$work/projects" --out="$work/unlisted.json" &
two=$!
wait "$one" || fail "the window" "the sampler ended with code $?"
wait "$two" || fail "the window, sleep off the list" "the sampler ended with code $?"
ended="$short"
short=''
[ -z "$(find "$work" -name '*.tmp')" ] || fail "the window" "it left a temporary file"

python3 "$checks" check "$work/listed.json" "$how" "$session" "$ended" "$missing" sleep,git yes
python3 "$checks" check "$work/unlisted.json" "$how" "$session" "$ended" "$missing" git no
# The checks do bite: the first output holds `sleep`, which isn't on this list
if python3 "$checks" check "$work/listed.json" "$how" "$session" "$ended" "$missing" git yes > /dev/null 2>&1; then
  fail "the checks" "they let through a program off the list"
fi
pass "sampler: a window over a stand-in session: its shape, the session's numbers, its starts and helpers by program (other when off the list), one that ended, nothing but numbers and listed words"

# SIGTERM closes the window early, and the output is written all the same
python3 "$sampler" perf --how "$how" --seconds 60 --interval 0.2 --sessions "$session:aaaaaaaa-1" --programs sleep \
  --terminals Terminal --out "$work/early.json" &
one=$!
sleep 1.5
kill "$one"
wait "$one" || fail "SIGTERM" "the sampler ended with code $?"
python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
assert 0 < d["seconds"] < 30, d["seconds"]
assert sys.argv[2] in d["processes"], "the session is missing"' "$work/early.json" "$session" || fail "SIGTERM" "the output of a window closed early"
pass "sampler: SIGTERM closes the window early and the output is written"

# ---- the parsers and the sums, with made-up text for both systems ----
python3 "$checks"

echo "sampler: ok"
