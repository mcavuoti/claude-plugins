#!/usr/bin/env bash
# Tests which project hooks/usage.py counts each response in: the one its session started in (the rule of sessionHome
# in plugins/sessions/hooks/state.ts), wherever the session worked, from conversation logs written here. The CI runs it
# on macOS and Linux; it's safe to run anywhere (it only reads and writes a throwaway folder).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
usage="$root/plugins/sessions/hooks/usage.py"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL ($1): $2" >&2; exit 1; }
pass() { echo "ok: $1"; }

proj=/Users/x/myapp
outside=/Users/x/wt-outside
other=/Users/x/other
logs="$work/projects"
alive="$work/alive"
mkdir -p "$logs/-Users-x-myapp" "$logs/-Users-x-wt-outside/aaaaaaaa-1/subagents" "$logs/-Users-x-other" "$alive"

# row <cwd> <input tokens> <message id>: a response with its usage, now; first <cwd>: a session's first row
row() { printf '{"type":"assistant","cwd":"%s","timestamp":"%s","requestId":"r-%s","message":{"id":"%s","usage":{"input_tokens":%s,"output_tokens":0}}}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" "$3" "$2"; }
first() { printf '{"type":"permission-mode"}\n{"type":"user","cwd":"%s","message":{"content":"hi"}}\n' "$1"; }

# "aaaaaaaa-1" started in the project and moved to a worktree outside it (EnterWorktree with a path): Claude moved its
# file to that folder's logs, its first row stays, the rows after the move carry the new folder; a subagent of it there
{ first "$proj"; row "$proj" 100 m1; row "$outside" 1000 m2; } > "$logs/-Users-x-wt-outside/aaaaaaaa-1.jsonl"
{ first "$outside"; row "$outside" 20000 m3; } > "$logs/-Users-x-wt-outside/aaaaaaaa-1/subagents/agent-x.jsonl"
# "bbbbbbbb-1" is the same session after a /clear there: its new conversation starts outside, its mod's heartbeat says
# where it belongs
{ first "$outside"; row "$outside" 300000 m4; } > "$logs/-Users-x-wt-outside/bbbbbbbb-1.jsonl"
printf 'format=3\npid=1000\nat=1\nversion=0.15.0\nvia=session.start\nroot=%s\n' "$proj" > "$alive/bbbbbbbb-1"
# "cccccccc-1" started in the worktree outside; "dddddddd-1" in another project, and its heartbeat is another format's
{ first "$outside"; row "$outside" 4000000 m5; } > "$logs/-Users-x-wt-outside/cccccccc-1.jsonl"
{ first "$other"; row "$other" 50000000 m6; } > "$logs/-Users-x-other/dddddddd-1.jsonl"
printf 'format=2\npid=1001\nat=1\nroot=%s\n' "$proj" > "$alive/dddddddd-1"

# totals <output>: the input tokens per folder, over the days
totals() { python3 -c 'import json, sys; d = json.loads(sys.argv[1])["days"]; print(" ".join("%s=%d" % (k, sum(v[0] for v in d[k].values())) for k in sorted(d)))' "$1"; }
want="$proj=321100 $other=50000000 $outside=4000000"
got="$(totals "$(python3 "$usage" "$logs" "$work/cache" "$alive")")"
[ "$got" = "$want" ] || fail "by project" "expected $want, got $got"
# Nothing new: the same; a new response of the session that moved: in its project, from the first folder it kept
got="$(totals "$(python3 "$usage" "$logs" "$work/cache" "$alive")")"
[ "$got" = "$want" ] || fail "a second run" "expected $want, got $got"
row "$outside" 1 m7 >> "$logs/-Users-x-wt-outside/aaaaaaaa-1.jsonl"
got="$(totals "$(python3 "$usage" "$logs" "$work/cache" "$alive")")"
[ "$got" = "$proj=321101 $other=50000000 $outside=4000000" ] || fail "a new response" "got $got"
pass "usage: each response in the project its session started in (heartbeat, first row, a subagent's session), wherever it worked"

# Without the heartbeats folder (its third argument is optional): the first rows alone
got="$(totals "$(python3 "$usage" "$logs" "$work/cache2")")"
[ "$got" = "$proj=21101 $other=50000000 $outside=4300000" ] || fail "no heartbeats" "got $got"
pass "usage: with no heartbeats folder, each session's first row"

echo "usage: ok"
