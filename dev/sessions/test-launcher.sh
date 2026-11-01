#!/usr/bin/env bash
# Tests what ccc opens (plugins/sessions/hooks/launcher.py and visor.sh) without Claude: a throwaway HOME, a `claude`
# that answers from fixture files and logs what it was asked to do, and a `ps` that lists fixture windows. The CI runs
# it on macOS and Linux; it's safe to run anywhere (it never touches your real files or sessions).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hooks="$root/plugins/sessions/hooks"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL ($1): $2" >&2; exit 1; }
pass() { echo "ok: $1"; }

# The project folder (it has a CLAUDE.md, so its subfolder belongs to it) and the fixtures
proj="$work/home/projects/myapp"
mkdir -p "$proj/src" "$work/bin" "$work/fix"
touch "$proj/CLAUDE.md"
proj="$(cd "$proj" && pwd -P)"
data="$work/home/.claude/mods/sessions-data"
fix="$work/fix"

cat > "$work/bin/claude" <<'SH'
#!/usr/bin/env bash
# A stand-in for claude: answers from $FIX, logs every call to $FIX/calls.log
echo "$*" >> "$FIX/calls.log"
case "$1 $2" in
  "agents --json") cat "$FIX/agents.json" ;;
  "plugin list") cat "$FIX/plugins.json" 2>/dev/null || echo '[]' ;;
  "attach "*) exit "$(cat "$FIX/attach-exit-$2" 2>/dev/null || echo 0)" ;;
  "respawn "*) exit 0 ;;
  "agents --cwd") exit 0 ;;
  "--bg -n"|"--bg --debug-file")
    if [ -f "$FIX/bg-error" ]; then cat "$FIX/bg-error" >&2; exit 1; fi
    name="$3"; [ "$2" = -n ] || name="$5"
    FIXDIR="$FIX" NAME="$name" CWD="$(pwd -P)" python3 - <<'PY'
import json, os, time
path = os.path.join(os.environ['FIXDIR'], 'agents.json')
rows = json.load(open(path))
rows.append({'id': 'ffff0001', 'sessionId': 'ffff0001-0000-0000-0000-000000000000', 'name': os.environ['NAME'], 'cwd': os.environ['CWD'],
             'kind': 'background', 'pid': 4242, 'status': 'idle', 'startedAt': int(time.time() * 1000)})
json.dump(rows, open(path, 'w'))
PY
    echo "backgrounded · ffff0001 · $name" ;;
esac
SH
cat > "$work/bin/ps" <<'SH'
#!/usr/bin/env bash
cat "$FIX/ps.txt" 2>/dev/null
SH
chmod +x "$work/bin/claude" "$work/bin/ps"

export HOME="$work/home" FIX="$fix" SESSIONS_CLAUDE="$work/bin/claude" SESSIONS_DATA_DIR="$data" PATH="$work/bin:$PATH"
export SESSIONS_TTY=/dev/ttys900 SESSIONS_START_WAIT=1
unset SESSIONS_PLUGIN_VERSION SESSIONS_PLUGIN_SINCE

now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

# sessions <spec...>: each "id:name:status:age_s[:cwd]" (status "-" = stopped). Writes agents.json
sessions() {
  NOW="$(now_ms)" PROJ="$proj" python3 - "$@" > "$fix/agents.json" <<'PY'
import json, os, sys
now, proj, rows = int(os.environ['NOW']), os.environ['PROJ'], []
for i, spec in enumerate(sys.argv[1:]):
    sid, name, status, age, *cwd = spec.split(':')
    row = {'id': sid, 'sessionId': sid + '-0000-0000-0000-000000000000', 'name': name, 'cwd': cwd[0] if cwd else proj,
           'kind': 'background', 'startedAt': now - int(age) * 1000}
    if status != '-':
        row.update(status=status, pid=1000 + i)
    rows.append(row)
print(json.dumps(rows))
PY
}
beat() { mkdir -p "$data/alive"; printf 'format=%s\npid=%s\nat=%s\nversion=0.10.0\nvia=session.start\n' "${3:-1}" "$2" "$(now_ms)" > "$data/alive/$1-0000-0000-0000-000000000000"; }
order() {
  mkdir -p "$data/order"
  local file="$data/order/${proj//\//_}"
  printf 'format=1\nat=%s\nroot=%s\n' "${ORDER_AT:-$(now_ms)}" "$proj" > "$file"
  for id in "$@"; do printf 'row=%s-0000-0000-0000-000000000000\tgreen\t%s\tx\n' "$id" "$id" >> "$file"; done
}
reset() { rm -rf "$data" "$fix"/*; mkdir -p "$fix"; : > "$fix/calls.log"; : > "$fix/ps.txt"; }
pick() { (cd "${PICK_IN:-$proj}" && python3 "$hooks/launcher.py" pick --tty "$SESSIONS_TTY" "$@"); }
expect() { [ "$1" = "$2" ] || fail "$3" "expected $2, got $1"; }
field() { python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d.get(sys.argv[2]))' "$1" "$2"; }

# 1. The panel's order wins when it's fresh; a stale one falls back to waiting, working, idle, then by name
reset
sessions aaaaaaaa:alpha:idle:600 bbbbbbbb:beta:busy:600 cccccccc:gamma:waiting:600
expect "$(field "$(pick)" session)" cccccccc "fallback order puts waiting first"
order aaaaaaaa bbbbbbbb cccccccc
expect "$(field "$(pick)" session)" aaaaaaaa "a fresh order file is used"
ORDER_AT=1000 order aaaaaaaa bbbbbbbb cccccccc
expect "$(field "$(pick)" session)" cccccccc "a stale order file is ignored"
PICK_IN="$proj/src" expect "$(field "$(PICK_IN="$proj/src" pick)" session)" cccccccc "a subfolder belongs to the project"
pass "order: fresh file, stale file, fallback, subfolder"

# 2. Sessions of other folders don't count; stopped ones and an empty folder lead to the Name prompt
reset
sessions aaaaaaaa:alpha:-:600 bbbbbbbb:other:idle:600:/elsewhere
d="$(pick)"
expect "$(field "$d" action)" prompt "only stopped sessions"
expect "$(field "$d" stopped)" "['aaaaaaaa']" "the stopped one is listed"
sessions
expect "$(field "$(pick)" action)" prompt "empty folder"
pass "prompt: only stopped, empty"

# 3. One window per project: a window showing a project session is brought forward; --new skips that and the
#    sessions shown elsewhere; ccc <name> brings its window, or switches the project's window to it
reset
sessions aaaaaaaa:alpha:idle:600 bbbbbbbb:beta:idle:600
printf '  501 ttys901  bash /x/hooks/visor.sh start\n  502 ttys901  claude attach aaaaaaaa\n' > "$fix/ps.txt"
beat aaaaaaaa 1000
d="$(pick)"
expect "$(field "$d" action)" bring "another window shows the project"
expect "$(field "$d" window)" /dev/ttys901 "that window"
expect "$(field "$d" helpers)" "['aaaaaaaa']" "its session's mod is asked"
d="$(pick --new)"
expect "$(field "$d" action)" attach "--new opens here"
expect "$(field "$d" session)" bbbbbbbb "--new skips the session shown elsewhere"
expect "$(field "$(pick alpha)" action)" bring "ccc <name> of a shown session brings its window"
d="$(pick beta)"
expect "$(field "$d" action)" show "ccc <name> switches the project's window"
expect "$(field "$d" session)" bbbbbbbb "to the named session"
expect "$(field "$(pick newone)" action)" create "a new name is created (then shown in that window)"
sessions aaaaaaaa:alpha:idle:600
expect "$(field "$(pick --new)" action)" prompt "--new with every session shown elsewhere: the prompt"
pass "one window per project: bring, --new, by name"

# 4. A session whose mod should run and doesn't is offered a restart; one that started before the heartbeat version
#    was installed, or that has a fresh heartbeat, isn't
reset
sessions aaaaaaaa:alpha:idle:600
expect "$(field "$(pick)" restart)" False "no installed plugin known: nothing expected"
export SESSIONS_PLUGIN_VERSION=0.10.0 SESSIONS_PLUGIN_SINCE=0
expect "$(field "$(pick)" restart)" True "no heartbeat after the install: restart offered"
beat aaaaaaaa 1000
expect "$(field "$(pick)" restart)" False "a fresh heartbeat"
beat aaaaaaaa 1999
expect "$(field "$(pick)" restart)" True "a heartbeat from another process"
beat aaaaaaaa 1000 2
expect "$(field "$(pick)" restart)" False "another format isn't a missing mod"
SESSIONS_PLUGIN_SINCE="$(now_ms)" expect "$(field "$(SESSIONS_PLUGIN_SINCE="$(now_ms)" pick)" restart)" False "started before the install"
SESSIONS_PLUGIN_VERSION=0.9.2 expect "$(field "$(SESSIONS_PLUGIN_VERSION=0.9.2 pick)" restart)" False "installed version has no heartbeats"
pass "heartbeat expectations"

# 5. The whole launcher, with the Name prompt: a new session whose mod never comes up gets exactly one restart, then
#    opens anyway (Enter); it lands with a focus request in its inbox
reset
sessions
printf 'TEST one\n\n' | (cd "$proj" && /bin/bash "$hooks/visor.sh" start) > "$work/out.txt" 2>&1 || true
grep -q "^--bg -n TEST one" "$fix/calls.log" || fail "create" "no claude --bg -n: $(cat "$fix/calls.log")"
expect "$(grep -c '^respawn ffff0001' "$fix/calls.log")" 1 "exactly one automatic restart"
grep -q "^attach ffff0001" "$fix/calls.log" || fail "create" "the new session wasn't opened"
grep -q "Starting “TEST one”" "$work/out.txt" || fail "create" "no progress line: $(cat "$work/out.txt")"
[ -f "$data/inbox/ffff0001-0000-0000-0000-000000000000" ] || fail "create" "no focus request for the new session"
grep -q '^action=focus' "$data/inbox/ffff0001-0000-0000-0000-000000000000" || fail "create" "the request isn't a focus one"
pass "empty folder: name, create, one restart, open, focus request"

# 6. Enter on an empty name goes back to the shell; a number reopens a stopped session; an untrusted folder says how
reset
sessions aaaaaaaa:alpha:-:600
printf '\n' | (cd "$proj" && /bin/bash "$hooks/visor.sh" start) > "$work/out.txt" 2>&1 || true
grep -q "^attach" "$fix/calls.log" && fail "empty name" "something was opened"
grep -q "alpha" "$work/out.txt" || fail "empty name" "the stopped session isn't listed"
printf '1\n' | (cd "$proj" && /bin/bash "$hooks/visor.sh" start) > /dev/null 2>&1 || true
grep -q "^attach aaaaaaaa" "$fix/calls.log" || fail "number" "the stopped session wasn't reopened"
echo 'Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.' > "$fix/bg-error"
printf 'TEST two\n' | (cd "$proj" && /bin/bash "$hooks/visor.sh" start) > "$work/out.txt" 2>&1 || true
grep -q "doesn't trust this folder" "$work/out.txt" || fail "trust" "no trust message: $(cat "$work/out.txt")"
pass "prompt: empty name, number, untrusted folder"

# 7. The restart question for an existing session without its mod: n opens it as is, y restarts it first
reset
sessions aaaaaaaa:alpha:idle:600
printf 'n\n' | (cd "$proj" && /bin/bash "$hooks/visor.sh" start) > "$work/out.txt" 2>&1 || true
grep -q "Restart it first? \[Y/n\]" "$work/out.txt" || fail "restart question" "not asked with Yes as default: $(cat "$work/out.txt")"
grep -q "^respawn" "$fix/calls.log" && fail "restart question" "restarted after n"
grep -q "^attach aaaaaaaa" "$fix/calls.log" || fail "restart question" "not opened after n"
: > "$fix/calls.log"
printf 'y\n' | (cd "$proj" && /bin/bash "$hooks/visor.sh" start) > /dev/null 2>&1 || true
grep -q "^respawn aaaaaaaa" "$fix/calls.log" || fail "restart question" "not restarted after y"
sessions aaaaaaaa:alpha:busy:600
printf '\n' | (cd "$proj" && /bin/bash "$hooks/visor.sh" start) > "$work/out.txt" 2>&1 || true
grep -q "\[y/N\]" "$work/out.txt" || fail "restart question" "a busy session should default to No"
unset SESSIONS_PLUGIN_VERSION SESSIONS_PLUGIN_SINCE
pass "restart question"

# 8. A viewer that fails at once makes the launcher pick again without it; one that ends after the panel wrote a
#    switch follows the switch
reset
sessions aaaaaaaa:alpha:waiting:600 bbbbbbbb:beta:idle:600
echo 1 > "$fix/attach-exit-aaaaaaaa"
(cd "$proj" && /bin/bash "$hooks/visor.sh" start) > /dev/null 2>&1 || true
expect "$(grep -c '^attach' "$fix/calls.log")" 2 "two attaches"
grep -q "^attach bbbbbbbb" "$fix/calls.log" || fail "re-pick" "didn't pick the other session"
pass "fast failure: picks again once"

# 9. Bring: a running session's mod answers the request (here a stand-in that answers ok); the switch writes the other
#    window's file and closes its viewer
reset
export SESSIONS_PLUGIN_VERSION=0.10.0 SESSIONS_PLUGIN_SINCE=0
sessions aaaaaaaa:alpha:idle:600 bbbbbbbb:beta:idle:600
sleep 30 & viewer=$!
disown "$viewer"
printf '  501 ttys901  bash /x/hooks/visor.sh start\n  %s ttys901  claude attach aaaaaaaa\n' "$viewer" > "$fix/ps.txt"
beat aaaaaaaa 1000
inbox="$data/inbox/aaaaaaaa-0000-0000-0000-000000000000"
( for _ in $(seq 1 50); do
    if [ -f "$inbox" ]; then reply=$(sed -n 's/^reply=//p' "$inbox"); rm -f "$inbox"; printf 'format=1\nresult=ok\n' > "$reply"; break; fi
    sleep 0.1
  done ) &
(cd "$proj" && /bin/bash "$hooks/visor.sh" start beta) > "$work/out.txt" 2>&1 || true
wait "$!" 2>/dev/null || true
grep -q "already open in another window" "$work/out.txt" || fail "bring" "no note: $(cat "$work/out.txt")"
grep -q "^attach" "$fix/calls.log" && fail "bring" "something opened here too"
grep -q "^id=bbbbbbbb" "$data/windows/_dev_ttys901" || fail "show" "the other window wasn't told to show beta"
kill -0 "$viewer" 2>/dev/null && fail "show" "the other window's viewer wasn't closed"
grep -q '^action=focus' "$data/inbox/bbbbbbbb-0000-0000-0000-000000000000" || fail "show" "no focus request for beta"
# Nobody answers: open here instead
reset
sessions aaaaaaaa:alpha:idle:600 bbbbbbbb:beta:idle:600
printf '  501 ttys901  bash /x/hooks/visor.sh start\n  502 ttys901  claude attach aaaaaaaa\n' > "$fix/ps.txt"
beat bbbbbbbb 1001
(cd "$proj" && /bin/bash "$hooks/visor.sh" start) > "$work/out.txt" 2>&1 < /dev/null || true
grep -q "Couldn't bring the other window forward" "$work/out.txt" || fail "bring fallback" "no note: $(cat "$work/out.txt")"
grep -q "^attach bbbbbbbb" "$fix/calls.log" || fail "bring fallback" "didn't open the next session here"
unset SESSIONS_PLUGIN_VERSION SESSIONS_PLUGIN_SINCE
pass "bring and switch another window; fallback when nobody answers"

# 10. The ccc command runs the enabled plugin's launcher, with its version
reset
sessions aaaaaaaa:alpha:idle:600
printf '[{"id":"sessions@m","version":"0.10.0","enabled":true,"installPath":"%s","lastUpdated":"2026-01-01T00:00:00.000Z"}]' "$root/plugins/sessions" > "$fix/plugins.json"
sed "s|^SETUP_ROOT=''|SETUP_ROOT=/nowhere|" "$root/plugins/sessions/setup/ccc" > "$work/ccc"
printf 'n\n' | (cd "$proj" && /bin/bash "$work/ccc") > "$work/out.txt" 2>&1 || true
grep -q "^attach aaaaaaaa" "$fix/calls.log" || fail "ccc" "didn't open the top session: $(cat "$work/out.txt")"
grep -q "Restart it first" "$work/out.txt" || fail "ccc" "the installed version wasn't passed on (no heartbeat expected)"
echo '[]' > "$fix/plugins.json"
(cd "$proj" && /bin/bash "$work/ccc") > "$work/out.txt" 2>&1 || true
grep -q "can't find the sessions plugin" "$work/out.txt" || fail "ccc" "no message without a plugin"
pass "ccc: finds the enabled plugin"

echo "launcher: ok"
