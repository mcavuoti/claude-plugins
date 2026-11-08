#!/usr/bin/env bash
# Tests what ccc opens (plugins/sessions/hooks/launcher.py and visor.sh) without Claude: a throwaway HOME, a `claude`
# that answers from fixture files and logs what it was asked to do, and a `ps` that lists fixture windows. The CI runs
# it on macOS and Linux; it's safe to run anywhere (it never touches your real files or sessions).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hooks="$root/plugins/sessions/hooks"
work="$(mktemp -d)"
# What a failed check leaves running (a launcher with its watcher and stand-in viewer) ends with the test too: it would
# run on for minutes, holding the test's output open
kill_tree() {
  local p
  for p in $(pgrep -P "$1"); do
    kill_tree "$p"
    kill "$p" 2>/dev/null || true
  done
}
trap 'kill_tree $$; rm -rf "$work"' EXIT
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
# A stand-in for claude: answers from $FIX, logs every call to $FIX/calls.log, and to $FIX/leaks.log a call that still
# sees what ccc hands the launcher (a claude would pass it on to the background service, and on to every session);
# $EVERY_CALL and $LEAKS outlive the fixtures' resets. $FIX/agents-next.json, when there, is the list from the second
# listing on (a session that changed meanwhile); stop and rm change the list as Claude would, or fail with the message
# in $FIX/<stop|rm>-error-<id>
echo "$*" >> "$FIX/calls.log"
echo "$*" >> "$EVERY_CALL"
if [ -n "${SESSIONS_PLUGIN_VERSION+x}" ] || [ -n "${SESSIONS_PLUGIN_SINCE+x}" ]; then echo "$*" >> "$LEAKS"; fi
case "$1 $2" in
  "agents --json")
    cat "$FIX/agents.json"
    if [ -f "$FIX/agents-next.json" ]; then mv -f "$FIX/agents-next.json" "$FIX/agents.json"; fi ;;
  "stop "*|"rm "*)
    if [ -f "$FIX/$1-error-$2" ]; then cat "$FIX/$1-error-$2" >&2; exit 1; fi
    FIXDIR="$FIX" WHAT="$1" ID="$2" python3 - <<'PY'
import json, os
path = os.path.join(os.environ['FIXDIR'], 'agents.json')
rows = [r for r in json.load(open(path)) if os.environ['WHAT'] == 'stop' or r.get('id') != os.environ['ID']]
for r in rows:
    if os.environ['WHAT'] == 'stop' and r.get('id') == os.environ['ID']:
        r.pop('pid', None)
        r.pop('status', None)
json.dump(rows, open(path, 'w'))
PY
    ;;
  "plugin list") cat "$FIX/plugins.json" 2>/dev/null || echo '[]' ;;
  # With $FIX/attach-wait, a viewer that runs until it's ended (as itself: its pid stays the viewer's)
  "attach "*)
    if [ -f "$FIX/attach-wait" ]; then echo "$$" > "$FIX/viewer-$2"; exec sleep 600; fi
    # With $FIX/attach-read, a viewer on a real terminal: what it reads as it takes the terminal (raw, 0.3 s) into
    # $FIX/read-<id>, then what comes in the next 2 s into $FIX/read2-<id>. $FIX/attach-early-<id>: first, like claude
    # attach, it reads the terminal as it starts, in the mode the launcher left (a line only once it's whole), for 1 s,
    # and says in $FIX/early-<id> whether a line came; then it takes the terminal, as claude attach does about 0.1 s in
    if [ -f "$FIX/attach-read" ]; then
      echo "$$" > "$FIX/viewer-$2"
      if [ -f "$FIX/attach-early-$2" ]; then
        if IFS= read -r -t 1 _; then echo line > "$FIX/early-$2"; else echo none > "$FIX/early-$2"; fi
      fi
      stty -icanon min 0 time 3 2>/dev/null
      dd bs=256 count=1 2>/dev/null > "$FIX/read-$2.part"
      mv -f "$FIX/read-$2.part" "$FIX/read-$2"
      stty -icanon min 0 time 20 2>/dev/null
      dd bs=256 count=1 2>/dev/null > "$FIX/read2-$2.part"
      mv -f "$FIX/read2-$2.part" "$FIX/read2-$2"
      exec sleep 600
    fi
    exit "$(cat "$FIX/attach-exit-$2" 2>/dev/null || echo 0)" ;;
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
# As a real ps reads -o (POSIX, which procps keeps to the letter): in `name=header` the header runs to the end of that
# -o argument, so `-o pid=,tty=,command=` is one pid column headed ",tty=,command=", and only pids are listed
prev=''
for a in "$@"; do
  if [ "$prev" = -o ] && [[ "$a" == *=?* ]]; then echo "${a#*=}"; awk '{print $1}' "$FIX/ps.txt" 2>/dev/null; exit 0; fi
  prev=$a
done
cat "$FIX/ps.txt" 2>/dev/null
# $FIX/ps-next.txt, when there, is what the next ps lists (a window that opened meanwhile)
if [ -f "$FIX/ps-next.txt" ]; then mv -f "$FIX/ps-next.txt" "$FIX/ps.txt"; fi
SH
chmod +x "$work/bin/claude" "$work/bin/ps"

export HOME="$work/home" FIX="$fix" SESSIONS_CLAUDE="$work/bin/claude" SESSIONS_DATA_DIR="$data" PATH="$work/bin:$PATH"
export SESSIONS_TTY=/dev/ttys900 SESSIONS_START_WAIT=1 EVERY_CALL="$work/every-call.log" LEAKS="$work/leaks.log"
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
beat() { mkdir -p "$data/alive"; printf 'format=%s\npid=%s\nat=%s\nversion=0.10.0\nvia=session.start\n' "${3:-3}" "$2" "$(now_ms)" > "$data/alive/$1-0000-0000-0000-000000000000"; }
order() {
  mkdir -p "$data/order"
  local file="$data/order/${proj//\//_}"
  printf 'format=3\nat=%s\nroot=%s\n' "${ORDER_AT:-$(now_ms)}" "$proj" > "$file"
  for id in "$@"; do printf 'row=%s-0000-0000-0000-000000000000\tgreen\t%s\tx\n' "$id" "$id" >> "$file"; done
}
reset() { rm -rf "$data" "${fix:?}"/*; mkdir -p "$fix"; : > "$fix/calls.log"; : > "$fix/ps.txt"; }
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
# A worktree under the project's .claude/worktrees/, with its own copy of CLAUDE.md, is still the project
mkdir -p "$proj/.claude/worktrees/w1/src"
touch "$proj/.claude/worktrees/w1/CLAUDE.md"
expect "$(field "$(PICK_IN="$proj/.claude/worktrees/w1/src" pick)" session)" cccccccc "a worktree belongs to the project"
pass "order: fresh file, stale file, fallback, subfolder, worktree"

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
beat aaaaaaaa 1000 1
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
# shellcheck disable=SC1111 # the curly quotes are what the launcher prints
grep -q "Starting “TEST one”" "$work/out.txt" || fail "create" "no progress line: $(cat "$work/out.txt")"
[ -f "$data/inbox/ffff0001-0000-0000-0000-000000000000" ] || fail "create" "no focus request for the new session"
grep -q '^action=focus' "$data/inbox/ffff0001-0000-0000-0000-000000000000" || fail "create" "the request isn't a focus one"
pass "empty folder: name, create, one restart, open, focus request"

# 5b. With the debug-logs option on (the mod mirrors it to <data>/config), a session ccc creates writes its debug log
reset
sessions
mkdir -p "$data"; printf 'format=3\ndebug=1\n' > "$data/config"
printf 'TEST one\n' | (cd "$proj" && /bin/bash "$hooks/visor.sh" start) > /dev/null 2>&1 || true
grep -q "^--bg -n TEST one --debug-file $data/debug/TEST_one.log" "$fix/calls.log" || fail "debug" "no --debug-file: $(cat "$fix/calls.log")"
pass "debug logs option: --debug-file for new sessions"

# 6. Enter on an empty name goes back to the shell; a number reopens a stopped session; an untrusted folder says how
reset
sessions aaaaaaaa:alpha:-:600
printf '\n' | (cd "$proj" && /bin/bash "$hooks/visor.sh" start) > "$work/out.txt" 2>&1 || true
grep -q "^attach" "$fix/calls.log" && fail "empty name" "something was opened"
grep -q "alpha" "$work/out.txt" || fail "empty name" "the stopped session isn't listed"
printf '1\n' | (cd "$proj" && /bin/bash "$hooks/visor.sh" start) > /dev/null 2>&1 || true
grep -q "^attach aaaaaaaa" "$fix/calls.log" || fail "number" "the stopped session wasn't reopened"
# shellcheck disable=SC2016 # Claude's own message, backticks included
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
    if [ -f "$inbox" ]; then reply=$(sed -n 's/^reply=//p' "$inbox"); rm -f "$inbox"; printf 'format=3\nresult=ok\n' > "$reply"; break; fi
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
grep -q "^plugin list --json" "$fix/calls.log" || fail "ccc" "didn't ask claude for the enabled plugin"
# What claude answered is kept for this folder: the next ccc here asks nothing and runs the same copy, the same version
lookup="$data/lookup/${proj//\//_}"
grep -q "^path=$root/plugins/sessions$" "$lookup" || fail "ccc" "the answer wasn't kept: $(cat "$lookup" 2>&1)"
mkdir -p "$HOME/.claude/plugins" "$proj/.claude"
touch -t 202001010000 "$HOME/.claude/plugins/installed_plugins.json" "$proj/.claude/settings.local.json"
: > "$fix/calls.log"
printf 'n\n' | (cd "$proj" && /bin/bash "$work/ccc") > "$work/out.txt" 2>&1 || true
grep -q "^plugin list" "$fix/calls.log" && fail "ccc" "asked claude again with nothing changed"
grep -q "^attach aaaaaaaa" "$fix/calls.log" || fail "ccc" "didn't open the top session from the kept answer: $(cat "$work/out.txt")"
grep -q "Restart it first" "$work/out.txt" || fail "ccc" "the kept version wasn't passed on"
# An install or update since (Claude's record of installed plugins is newer): asked again
echo '[]' > "$fix/plugins.json"
touch -t 203001010000 "$HOME/.claude/plugins/installed_plugins.json"
(cd "$proj" && /bin/bash "$work/ccc") > "$work/out.txt" 2>&1 || true
grep -q "can't find the sessions plugin" "$work/out.txt" || fail "ccc" "no message without a plugin (an update wasn't noticed)"
# The project's settings changed (a plugin enabled or disabled there): asked again
printf '[{"id":"sessions@m","version":"0.10.0","enabled":true,"installPath":"%s","lastUpdated":"2026-01-01T00:00:00.000Z"}]' "$root/plugins/sessions" > "$fix/plugins.json"
touch -t 202001010000 "$HOME/.claude/plugins/installed_plugins.json"
(cd "$proj" && printf 'n\n' | /bin/bash "$work/ccc") > /dev/null 2>&1 || true
echo '[]' > "$fix/plugins.json"
touch -t 203001010000 "$proj/.claude/settings.local.json"
(cd "$proj" && /bin/bash "$work/ccc") > "$work/out.txt" 2>&1 || true
grep -q "can't find the sessions plugin" "$work/out.txt" || fail "ccc" "a change of the project's settings wasn't noticed"
# A kept folder that no longer has the plugin (an old version removed): asked again
printf 'format=3\nclaude=%s\npath=/nowhere\nversion=0.10.0\nsince=0\n' "$SESSIONS_CLAUDE" > "$lookup"
touch -t 202001010000 "$proj/.claude/settings.local.json"
: > "$fix/calls.log"
(cd "$proj" && /bin/bash "$work/ccc") > "$work/out.txt" 2>&1 || true
grep -q "^plugin list" "$fix/calls.log" || fail "ccc" "used a kept folder that's gone"
rm -rf "$proj/.claude" "$HOME/.claude/plugins"
pass "ccc: finds the enabled plugin, keeps the answer per folder, asks again after an install or a settings change"

# 11. ccc tell: needs no terminal and no project folder; refused without the session's opt-in, over 4 KB, for a regular
#     session, for an ambiguous name and for a session whose panel isn't running; otherwise a request and its status
tell() { (cd / && env -u SESSIONS_TTY /bin/bash "$hooks/visor.sh" start tell "$@" < /dev/null); }
allow() { mkdir -p "$data/tell/$1"; printf 'format=3\nat=1\n' > "$data/tell/$1/allow"; }
reset
sessions aaaaaaaa:alpha:idle:600
beat aaaaaaaa 1000
out="$(tell alpha "hi" || true)"
# shellcheck disable=SC1111 # the curly quotes are what the launcher prints
grep -q "refused: “alpha” doesn't take text from ccc tell" <<<"$out" || fail "tell" "no opt-in refusal: $out"
allow aaaaaaaa
tell alpha "New mail, id 42" > "$work/out.txt" || fail "tell" "refused: $(cat "$work/out.txt")"
# shellcheck disable=SC1111 # the curly quotes are what the launcher prints
grep -q "^queued: it goes as a turn of its own when “alpha” is idle" "$work/out.txt" || fail "tell" "not queued: $(cat "$work/out.txt")"
req=$(ls "$data/tell/aaaaaaaa/"*.req)
grep -q '^format=3$' "$req" || fail "tell" "the request has no format"
expect "$(cat "${req%.req}.txt")" "New mail, id 42" "the text is in its own file"
grep -q "^status file: ${req%.req}.status$" "$work/out.txt" || fail "tell" "no status file named: $(cat "$work/out.txt")"
rm -f "$data/tell/aaaaaaaa/"*.req
printf 'from stdin\nsecond line\n' | (cd / && env -u SESSIONS_TTY /bin/bash "$hooks/visor.sh" start tell aaaaaaaa -) > /dev/null || fail "tell" "by id, from stdin"
expect "$(cat "$(find "$data/tell/aaaaaaaa" -name '*.req' | head -n 1 | sed 's/\.req$/.txt/')")" "$(printf 'from stdin\nsecond line')" "the text from stdin, with its lines"
rm -f "$data/tell/aaaaaaaa/"*.req
grep -q "longer than 4 KB" <<<"$(tell alpha "$(head -c 4097 /dev/zero | tr '\0' x)" || true)" || fail "tell" "no 4 KB cap"
[ -z "$(ls "$data/tell/aaaaaaaa/"*.req 2>/dev/null)" ] || fail "tell" "a request was written over 4 KB"
rm -f "$data/alive/aaaaaaaa-0000-0000-0000-000000000000"
grep -q "panel isn't running" <<<"$(tell alpha "hi" || true)" || fail "tell" "a session without its panel"
sessions aaaaaaaa:dup:idle:600 bbbbbbbb:dup:idle:600:/elsewhere
# shellcheck disable=SC1111 # the curly quotes are what the launcher prints
grep -q "several background sessions are named “dup”: aaaaaaaa ($proj), bbbbbbbb (/elsewhere)" <<<"$(tell dup "hi" || true)" || fail "tell" "an ambiguous name"
beat aaaaaaaa 1000
(cd "$proj" && env -u SESSIONS_TTY /bin/bash "$hooks/visor.sh" start tell dup "hi" < /dev/null) > "$work/out.txt" || fail "tell" "the project's own dup: $(cat "$work/out.txt")"
rm -f "$data/tell/aaaaaaaa/"*.req
python3 -c 'import json,sys; print(json.dumps([{"sessionId": "cccccccc-0000-0000-0000-000000000000", "name": "reg", "cwd": sys.argv[1], "kind": "interactive", "pid": 7, "status": "idle"}]))' "$proj" > "$fix/agents.json"
# shellcheck disable=SC1111 # the curly quotes are what the launcher prints
grep -q "“reg” is a regular session" <<<"$(tell reg "hi" || true)" || fail "tell" "a regular session"
pass "tell: opt-in, request and status, stdin, 4 KB, no panel, ambiguous, regular"

# 12. ccc tell to a stopped session: a running session's mod is asked to wake it (here a stand-in that answers), and
#     with nobody to ask it's refused and its request removed
reset
sessions aaaaaaaa:alpha:-:600 bbbbbbbb:beta:idle:600
allow aaaaaaaa
beat bbbbbbbb 1001
inbox="$data/inbox/bbbbbbbb-0000-0000-0000-000000000000"
( for _ in $(seq 1 50); do
    if [ -f "$inbox" ]; then
      if ! grep -q '^ref=aaaaaaaa$' "$inbox" || ! grep -q '^action=wake$' "$inbox"; then break; fi
      reply=$(sed -n 's/^reply=//p' "$inbox"); rm -f "$inbox"; printf 'format=3\nresult=ok\nstate=queued\nreason=woke “alpha”\n' > "$reply"; break
    fi
    sleep 0.1
  done ) &
tell alpha "ping" > "$work/out.txt" || fail "tell wake" "refused: $(cat "$work/out.txt")"
wait "$!" 2>/dev/null || true
# shellcheck disable=SC1111 # the curly quotes are what the launcher prints
grep -q "^queued: woke “alpha”" "$work/out.txt" || fail "tell wake" "not woken: $(cat "$work/out.txt")"
[ -n "$(ls "$data/tell/aaaaaaaa/"*.req 2>/dev/null)" ] || fail "tell wake" "the request isn't waiting for the session"
rm -f "$data/alive/"*
out="$(tell alpha "ping" || true)"
grep -q "^refused: it is stopped, and no session with a running panel answered to wake it" <<<"$out" || fail "tell wake" "no refusal: $out"
expect "$(find "$data/tell/aaaaaaaa" -name '*.req' | wc -l | tr -d ' ')" 1 "the refused request is removed (the first one waits)"
pass "tell: wakes a stopped session through a running one, refused when none answers"

# 12b. ccc tell --wait: until the session's mod says delivered (0), held (3) or refused (1), or the time is up (4,
#      still queued); and at most 6 requests a minute (60 an hour) reach one session, the rest refused with when to retry
answer_after() {
  ( for _ in $(seq 1 50); do
      f=$(find "$data/tell/aaaaaaaa" -name '*.req' | head -n 1)
      if [ -n "$f" ]; then sleep "$1"; printf 'format=3\nstate=%s\nreason=%s\nat=1\n' "$2" "${3:-}" > "${f%.req}.status"; rm -f "$f"; break; fi
      sleep 0.1
    done ) &
}
reset
sessions aaaaaaaa:alpha:idle:600
beat aaaaaaaa 1000
allow aaaaaaaa
answer_after 2.5 delivered
began=$(date +%s)
code=0; tell --wait=20 alpha "ping" > "$work/out.txt" || code=$?
wait "$!" 2>/dev/null || true
expect "$code" 0 "tell --wait: delivered"
grep -q '^delivered$' "$work/out.txt" || fail "tell --wait" "not delivered: $(cat "$work/out.txt")"
[ $(($(date +%s) - began)) -ge 2 ] || fail "tell --wait" "it didn't wait past the usual 2 s"
answer_after 0.3 held 'the session was stopped: it goes once the person types in it'
code=0; tell --wait alpha "ping" > "$work/out.txt" || code=$?
wait "$!" 2>/dev/null || true
expect "$code" 3 "tell --wait: held"
grep -q '^held: the session was stopped' "$work/out.txt" || fail "tell --wait" "not held: $(cat "$work/out.txt")"
beat aaaaaaaa 1000
code=0; tell --wait=1 alpha "ping" > "$work/out.txt" || code=$?
expect "$code" 4 "tell --wait: still queued at the timeout"
grep -q '(still queued after 1 s)$' "$work/out.txt" || fail "tell --wait" "no timeout said: $(cat "$work/out.txt")"
rm -f "$data/tell/aaaaaaaa/"*
allow aaaaaaaa
now=$(now_ms)
for i in 1 2 3 4 5 6; do printf 'format=3\nstate=delivered\nreason=\nat=1\n' > "$data/tell/aaaaaaaa/$((now - i * 1000))-$i.status"; done
out="$(tell alpha "ping" || true)"
# shellcheck disable=SC1111 # the curly quotes are what the launcher prints
grep -q "^refused: “alpha” was handed 6 requests in the last minute, the most ccc tell gives one session (6 a minute, 60 an hour): try again in [0-9]* s$" <<<"$out" || fail "tell rate" "no refusal: $out"
[ -z "$(find "$data/tell/aaaaaaaa" -name '*.req')" ] || fail "tell rate" "a request was written past the limit"
rm -f "$data/tell/aaaaaaaa/"*.status
for i in $(seq 1 60); do printf 'format=3\nstate=delivered\nreason=\nat=1\n' > "$data/tell/aaaaaaaa/$((now - 120000 - i * 1000))-$i.status"; done
grep -q "was handed 60 requests in the last hour" <<<"$(tell alpha "ping" || true)" || fail "tell rate" "no hourly limit"
pass "tell --wait: delivered, held, timed out; at most 6 a minute and 60 an hour"

# 13. ccc section: the person's section for the session this project's window shows (or --session), written to
#     sections.json as /sessions section does (made if needed, gone when empty, unknown fields kept, a parent dropped);
#     refused with no window or several, and a newer sections.json is left untouched
sect() { (cd "$proj" && env -u SESSIONS_TTY /bin/bash "$hooks/visor.sh" start section "$@" < /dev/null); }
members() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps([d["members"], [s["id"] for s in d["sections"]], d.get("x")], sort_keys=True))' "$data/sections.json"; }
reset
sessions aaaaaaaa:alpha:idle:600 bbbbbbbb:beta:idle:600
printf '  501 ttys901  bash /x/hooks/visor.sh start\n  502 ttys901  claude attach aaaaaaaa\n' > "$fix/ps.txt"
mkdir -p "$data"
printf '{"sectionsFormat": 1, "x": 1, "sections": [], "members": {"aaaaaaaa": {"section": "probe:desk", "by": "probe", "parent": "bbbbbbbb", "note": 2}}}\n' > "$data/sections.json"
# shellcheck disable=SC1111 # the curly quotes are what the launcher prints
expect "$(sect Big renders!)" "“alpha” is in “Big renders!” now" "section: the window's session"
expect "$(members)" '[{"aaaaaaaa": {"by": "person", "note": 2, "section": "me:big-renders"}}, ["me:big-renders"], 1]' "section: written as the person's, unknown fields kept, the parent dropped"
# shellcheck disable=SC1111 # the curly quotes are what the launcher prints
expect "$(sect)" "“alpha” is in “Big renders!”" "section: which one"
# shellcheck disable=SC1111 # the curly quotes are what the launcher prints
expect "$(sect --session beta big RENDERS)" "“beta” is in “Big renders!” now" "section: --session, the same section by title"
# shellcheck disable=SC1111 # the curly quotes are what the launcher prints
expect "$(sect -)" "“alpha” is in no section now" "section: out of it"
expect "$(members)" '[{"bbbbbbbb": {"by": "person", "section": "me:big-renders"}}, ["me:big-renders"], 1]' "section: the section stays while beta's in it"
sect --session bbbbbbbb - > /dev/null
expect "$(members)" '[{}, [], 1]' "section: an empty section of the person's goes"
: > "$fix/ps.txt"
grep -q "no window shows a session of" <<<"$(sect Renders || true)" || fail "section" "no refusal without a window"
printf '  502 ttys901  claude attach aaaaaaaa\n  503 ttys902  claude attach bbbbbbbb\n' > "$fix/ps.txt"
# shellcheck disable=SC1111 # the curly quotes are what the launcher prints
grep -q "windows show several sessions of $proj (“alpha”, “beta”)" <<<"$(sect Renders || true)" || fail "section" "no refusal with two windows"
printf '{"sectionsFormat": 2, "sections": [], "members": {}}\n' > "$data/sections.json"
grep -q "from a newer sessions" <<<"$(sect --session alpha Renders || true)" || fail "section" "a newer sections.json was used"
grep -q '"sectionsFormat": 2' "$data/sections.json" || fail "section" "a newer sections.json was rewritten"
pass "section: the window's session or --session, as the person's, refused without one window, a newer file untouched"

# 14. ccc tidy: every folder's sessions from the list, grouped and numbered (stopped, then idle running ones), and the
#     ones it leaves alone with why (working, waiting, tasks in the background, a window, pinned, regular); a stopped
#     one's time from its transcript (found by its id), else its start, and whether it ended with the background
#     service; --here, --days, --list; a pick of numbers and ranges or s, a second yes for running ones, each checked again just before
#     it's stopped; never an unpin, never a regular session; the CLI's failures said, and exit 1
other="$work/home/projects/other"
mkdir -p "$other"
other="$(cd "$other" && pwd -P)"
# touch_ago <file> <seconds>: the file, last written that long ago
touch_ago() { python3 -c 'import os, sys, time; open(sys.argv[1], "a").close(); t = time.time() - int(sys.argv[2]); os.utime(sys.argv[1], (t, t))' "$1" "$2"; }
transcript() { echo "$HOME/.claude/projects/$1/$2-0000-0000-0000-000000000000.jsonl"; }
tidy_world() {
  rm -rf "$HOME/.claude/sessions" "$HOME/.claude/jobs" "$HOME/.claude/projects"
  NOW="$(now_ms)" PROJ="$proj" OTHER="$other" python3 - > "$fix/agents.json" <<'PY'
import json, os
now, proj, other = int(os.environ['NOW']), os.environ['PROJ'], os.environ['OTHER']
day, hour = 86400000, 3600000
def bg(i, name, cwd, age, status=None, pid=None):
    row = {'id': i, 'sessionId': i + '-0000-0000-0000-000000000000', 'name': name, 'cwd': cwd, 'kind': 'background', 'startedAt': now - age}
    if status:
        row.update(status=status, pid=pid)
    return row
print(json.dumps([
    bg('aaaaaaa1', 'old notes', proj, 20 * day), bg('aaaaaaa2', 'fresh stop', other, 2 * day),
    bg('bbbbbbb1', 'idle one', proj, 5 * hour, 'idle', 2001), bg('bbbbbbb2', 'idle other', other, 4 * hour, 'idle', 2002),
    bg('ccccccc1', 'worker', proj, hour, 'busy', 2003), bg('ccccccc2', 'asker', other, hour, 'waiting', 2004),
    bg('ddddddd1', 'viewed', proj, hour, 'idle', 2005), bg('eeeeeee1', 'pinned remote', proj, day, 'idle', 2006),
    bg('eeeeeee2', 'pinned by hand', other, day, 'idle', 2007), bg('fffffff1', 'with tasks', proj, hour, 'idle', 2008),
    {'sessionId': '99999999-0000-0000-0000-000000000000', 'name': 'myapp-1f', 'cwd': proj, 'kind': 'interactive', 'pid': 2009,
     'status': 'idle', 'startedAt': now - hour},
]))
PY
  # Claude's own files: the registry says since when "idle one" is idle; two pins, one with Remote Control on; a session
  # with tasks in the background (an artifact watch isn't one); a window showing "viewed"
  mkdir -p "$HOME/.claude/sessions" "$HOME/.claude/jobs/eeeeeee1" "$HOME/.claude/jobs/fffffff1"
  printf '{"pid": 2001, "sessionId": "bbbbbbb1-0000-0000-0000-000000000000", "status": "idle", "statusUpdatedAt": %s}\n' "$(($(now_ms) - 3 * 3600000 - 60000))" > "$HOME/.claude/sessions/2001.json"
  printf '[\n  "eeeeeee1",\n  "eeeeeee2"\n]' > "$HOME/.claude/jobs/pins.json"
  printf '{"bridgeSessionId": "session_x", "inFlight": {"tasks": 0}}\n' > "$HOME/.claude/jobs/eeeeeee1/state.json"
  printf '{"inFlight": {"tasks": 3, "drainableMonitors": 1, "kinds": ["agent", "shell", "artifact_watch"]}}\n' > "$HOME/.claude/jobs/fffffff1/state.json"
  printf '  501 ttys901  bash /x/hooks/visor.sh start\n  502 ttys901  claude attach ddddddd1\n' > "$fix/ps.txt"
  # The transcripts: "old notes" was last used 10 days ago (found by its id, in folders whose names aren't its project's:
  # the newest copy counts); "fresh stop" has none
  mkdir -p "$HOME/.claude/projects/-elsewhere" "$HOME/.claude/projects/-an-older-copy"
  touch_ago "$(transcript -elsewhere aaaaaaa1)" $((10 * 86400))
  touch_ago "$(transcript -an-older-copy aaaaaaa1)" $((15 * 86400))
}
# tidy_run <answers> <args...>: ccc tidy from the project (or $TIDY_IN), the answers on stdin; the output without its
# colours, and a line break after each question as a terminal shows once the answer is typed, in $work/out.txt; prints
# the exit code
tidy_run() {
  local answers="$1" code=0
  shift
  printf '%b' "$answers" | (cd "${TIDY_IN:-$proj}" && env -u SESSIONS_TTY /bin/bash "$hooks/visor.sh" start tidy "$@") > "$work/raw.txt" 2>&1 || code=$?
  python3 -c 'import re, sys; t = re.sub(r"\x1b\[[0-9;]*m", "", open(sys.argv[1]).read()); open(sys.argv[2], "w").write(re.sub(r"(Remove which\? |\[y/N\] )", "\\1\n", t))' "$work/raw.txt" "$work/out.txt"
  echo "$code"
}
has() { grep -Eq -- "$1" "$work/out.txt" || fail "tidy" "$2: no line like /$1/ in: $(cat "$work/out.txt")"; }
lacks() { if grep -Eq -- "$1" "$work/out.txt"; then fail "tidy" "$2: /$1/ in: $(cat "$work/out.txt")"; fi; }
acts() { grep -E '^(stop|rm) ' "$fix/calls.log" | tr '\n' ';' || true; }
reset
tidy_world
expect "$(tidy_run '' --list)" 0 "tidy --list"
has '^Sessions · every folder$' "the heading"
has '^Stopped \(no process: a list entry and its conversation on disk\) · remove$' "the stopped group"
has '^  1  old notes +~/projects/myapp +last used 10 d ago$' "the one used longest ago first, by its transcript's time"
has "^  2  fresh stop +~/projects/other +started 2 d ago \(its transcript wasn't found\)$" "no transcript: when it started, and why"
has '^Running in the background, idle, not pinned · stop and remove$' "the running group"
has '^  3  idle other +~/projects/other +idle, started 4 h ago$' "idle with no registry time: since it started"
has '^  4  idle one +~/projects/myapp +idle 3 h$' "idle since the registry's statusUpdatedAt"
has '^Left alone$' "the group left alone"
has '^     worker +~/projects/myapp +busy: never stopped while it works$' "busy"
has '^     asker +~/projects/other +waiting for you \(a question or a permission\)$' "waiting"
has '^     viewed +~/projects/myapp +shown in a window now \(ttys901\)$' "shown in a window"
has '^     pinned remote +~/projects/myapp +pinned, Remote Control on: turn off Remote Control, or --pinned to offer it$' "pinned with Remote Control"
has '^     pinned by hand +~/projects/other +pinned: unpin it \(Ctrl\+T in claude agents\), or --pinned to offer it$' "pinned by hand"
has '^     with tasks +~/projects/myapp +idle, but 2 tasks run in the background \(agent, shell\)$' "tasks in the background"
has '^     myapp-1f +~/projects/myapp +a regular session: /exit it in its window$' "a regular session"
lacks 'Remove which' "--list asks nothing"
expect "$(acts)" "" "--list does nothing"
# --here: this project only (by the root ccc uses: a subfolder belongs to it); --days: only stopped ones older than that
TIDY_IN="$proj/src" expect "$(TIDY_IN="$proj/src" tidy_run '' --here --list)" 0 "tidy --here --list"
has '^Sessions · myapp$' "--here: the project's name"
has '^  1  old notes ' "--here: the project's stopped one"
has '^  2  idle one ' "--here: the project's idle one"
lacks 'fresh stop|idle other|asker|pinned by hand' "--here: another folder's sessions"
expect "$(tidy_run '' --days 7 --list)" 0 "tidy --days 7"
has '^  1  old notes ' "--days: the one used 10 days ago"
has '^  1 more stopped, used in the last 7 days \(--days 7\)$' "--days: says what it left out"
has '^  2  idle other ' "--days doesn't filter running ones"
lacks 'fresh stop' "--days: one started 2 days ago, with no transcript, isn't listed"
# Used since: started 20 days ago, but its transcript was written yesterday, so it comes last and --days 7 leaves it out
touch_ago "$(transcript -elsewhere aaaaaaa1)" 86400
tidy_run '' --list > /dev/null
has '^  1  fresh stop ' "the one used longest ago first"
has '^  2  old notes +~/projects/myapp +last used 24 h ago$' "last used yesterday"
tidy_run '' --days 7 --list > /dev/null
lacks 'old notes|fresh stop' "--days: by when it was last used, not when it started"
has '^  2 more stopped, used in the last 7 days \(--days 7\)$' "--days: both left out"
# The stopped ones that ended with the background service are marked, with when: the service's log (at its place in
# HOME, or SESSIONS_DAEMON_LOG) found its workers dead after they last ran (their last start there, or their mod's
# heartbeat). Not one the person stopped (a claude stop the log shows), nor one with no sign of when it last ran, nor
# one that ran since
tidy_world
iso_ago() { python3 -c 'import datetime as d, sys; t = d.datetime.now(d.timezone.utc).replace(hour=int(sys.argv[2]), minute=30, second=0, microsecond=0) - d.timedelta(days=int(sys.argv[1])); print(t.strftime("%Y-%m-%dT%H:%M:%S.000Z"))' "$1" "$2"; }
ms_of() { python3 -c 'import datetime as d, sys; print(int(d.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp() * 1000))' "$1"; }
started_at="$(iso_ago 3 8)"
died_at="$(iso_ago 3 9)"
when="$(TZ=UTC python3 -c 'import datetime as d, sys; t = d.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")); print("%02d:%02d on %s %d" % (t.hour, t.minute, t.strftime("%b"), t.day))' "$died_at")"
{
  printf '[%s] [bg] bg claimed-spare aaaaaaa1 (spare)\n[%s] [bg] bg claimed-spare aaaaaaa2 (spare)\n' "$started_at" "$started_at"
  printf '[%s] [bg] bg settled aaaaaaa2 (killed)\n' "$started_at"
  printf '[%s] [supervisor] ─── daemon start ─── version=2.1.300 pid=100 origin=transient\n' "$died_at"
  printf '[%s] [bg] bg adopt: adopted=0 respawned=0 dead=1\n' "$died_at"
} > "$HOME/.claude/daemon.log"
export TZ=UTC
tidy_run '' --list > /dev/null
has "^  1  old notes +~/projects/myapp +last used 10 d ago · ended with the background service at $when$" "ended with the service: marked, with when"
has "^  2  fresh stop +~/projects/other +started 2 d ago \(its transcript wasn't found\)$" "stopped by the person: not marked"
# The mod's heartbeat says when one last ran when the log has no start of it: before the death, marked; after, it ran
# since; neither, no sign: not marked
grep -v 'claimed-spare aaaaaaa1' "$HOME/.claude/daemon.log" > "$work/service.log"
rm "$HOME/.claude/daemon.log"
beat_at() { mkdir -p "$data/alive"; printf 'format=3\npid=0\nat=%s\nversion=0.10.0\nvia=session.start\n' "$2" > "$data/alive/$1-0000-0000-0000-000000000000"; }
beat_at aaaaaaa1 "$(ms_of "$started_at")"
SESSIONS_DAEMON_LOG="$work/service.log" tidy_run '' --list > /dev/null
has "^  1  old notes .*last used 10 d ago · ended with the background service at $when$" "SESSIONS_DAEMON_LOG, and the heartbeat's time"
beat_at aaaaaaa1 "$(now_ms)"
SESSIONS_DAEMON_LOG="$work/service.log" tidy_run '' --list > /dev/null
lacks 'ended with the background service' "ran since the death"
rm -f "$data/alive/aaaaaaa1-0000-0000-0000-000000000000"
SESSIONS_DAEMON_LOG="$work/service.log" tidy_run '' --list > /dev/null
lacks 'ended with the background service' "no sign of when it last ran"
unset TZ
tidy_world
# A pick of a number and a range, with the second yes for the running ones
export SESSIONS_PLUGIN_VERSION=0.10.0 SESSIONS_PLUGIN_SINCE=0
expect "$(tidy_run '1 3-4\ny\n')" 0 "a pick"
unset SESSIONS_PLUGIN_VERSION SESSIONS_PLUGIN_SINCE
has '^numbers or ranges \(e\.g\. 1 3-5\), s = every stopped one, Enter = nothing$' "the hint"
has 'Remove which\? ' "the prompt"
has 'Stop and remove these 2 running sessions\? \[y/N\]' "the second question names how many"
has '^  1  old notes  removed$' "a stopped one: removed"
has '^  3  idle other  stopped and removed$' "a running one: stopped and removed"
has '^  4  idle one  stopped and removed$' "the range's end"
expect "$(acts)" "rm aaaaaaa1;stop bbbbbbb2;rm bbbbbbb2;stop bbbbbbb1;rm bbbbbbb1;" "what a pick does, in order"
# s: every stopped one, with no second question
reset
tidy_world
expect "$(tidy_run 's\n')" 0 "s"
expect "$(acts)" "rm aaaaaaa1;rm aaaaaaa2;" "s removes every stopped one, and only those"
lacks 'running sessions\?' "s asks nothing more"
# Enter does nothing; an answer it doesn't understand is asked again
: > "$fix/calls.log"
tidy_world
expect "$(tidy_run '\n')" 0 "Enter"
has '^Nothing changed\.$' "Enter: nothing changed"
expect "$(tidy_run '9\nx\n\n')" 0 "out of range, then not a number, then Enter"
has '9: the numbers go from 1 to 4$' "out of range"
has 'x: not a number or a range$' "not a number"
expect "$(acts)" "" "nothing done without a pick"
# Running ones need the yes: No (or Enter) skips them, the stopped ones picked with them still go
expect "$(tidy_run '1 4\nn\n')" 0 "running ones declined"
has 'Stop and remove this running session\? \[y/N\]' "one running session"
has '^  1  old notes  removed$' "the stopped one picked with it"
has '^  4  idle one  skipped: not confirmed$' "declined"
expect "$(acts)" "rm aaaaaaa1;" "only the stopped one"
: > "$fix/calls.log"
tidy_world
expect "$(tidy_run '3\n\n')" 0 "Enter at the second question"
expect "$(acts)" "" "Enter at the second question is No"
# Checked again just before it's stopped: one that turned busy, one a window opened on, is skipped
python3 -c 'import json,sys; rows=json.load(open(sys.argv[1])); [r.update(status="busy") for r in rows if r.get("id")=="bbbbbbb1"]; json.dump(rows, open(sys.argv[2], "w"))' "$fix/agents.json" "$fix/agents-next.json"
printf '  503 ttys902  claude attach bbbbbbb2\n' > "$fix/ps-next.txt"
expect "$(tidy_run '3-4\ny\n')" 0 "changed meanwhile"
has '^  3  idle other  skipped: shown in a window now \(ttys902\)$' "a window opened meanwhile"
has '^  4  idle one  skipped: busy: never stopped while it works$' "busy meanwhile"
expect "$(acts)" "" "nothing stopped that changed meanwhile"
# --pinned offers the pinned idle ones too, and stopping one needs no unpin (pins.json is never written); a regular
# session is never offered
reset
tidy_world
cp "$HOME/.claude/jobs/pins.json" "$work/pins.before"
expect "$(tidy_run '' --pinned --list)" 0 "--pinned --list"
has '^Running in the background, idle · stop and remove$' "--pinned: the heading"
has '^  3  pinned remote +~/projects/myapp +idle, started 24 h ago · pinned, Remote Control on$' "--pinned: the pinned ones offered"
has '^  4  pinned by hand +~/projects/other +idle, started 24 h ago · pinned$' "--pinned: the hand pin too"
has '^     myapp-1f .*a regular session' "--pinned: a regular session is still left alone"
expect "$(tidy_run '3-4\ny\n' --pinned)" 0 "--pinned pick"
expect "$(acts)" "stop eeeeeee1;rm eeeeeee1;stop eeeeeee2;rm eeeeeee2;" "--pinned: stopped and removed"
cmp -s "$HOME/.claude/jobs/pins.json" "$work/pins.before" || fail "tidy" "pins.json was written"
grep -q 99999999 "$fix/calls.log" && fail "tidy" "a regular session was acted on"
# pins.json that can't be read: any session may be pinned, so none is offered without --pinned; SESSIONS_JOBS_DIR
reset
tidy_world
printf 'not json' > "$HOME/.claude/jobs/pins.json"
tidy_run '' --list > /dev/null
has "^     old notes .*pins\.json can't be read, so it may be pinned: --pinned to offer it$" "unreadable pins: stopped ones kept"
has "^     idle one .*pins\.json can't be read" "unreadable pins: running ones kept"
mkdir -p "$work/jobs"
printf '["aaaaaaa1"]' > "$work/jobs/pins.json"
SESSIONS_JOBS_DIR="$work/jobs" tidy_run '' --list > /dev/null
has '^     old notes .*pinned: --pinned to offer it$' "SESSIONS_JOBS_DIR: its pins.json"
has '^  1  fresh stop ' "SESSIONS_JOBS_DIR: the rest offered"
# The CLI's failures, in its words, and exit 1: a remove refused, a stop that failed (then no rm)
reset
tidy_world
printf "Couldn't remove: its worktree has unpushed commits\n" > "$fix/rm-error-aaaaaaa1"
printf 'Not running\n' > "$fix/stop-error-bbbbbbb1"
expect "$(tidy_run '1-2 4\ny\n')" 1 "failures: exit 1"
has "^  1  old notes  failed: Couldn't remove: its worktree has unpushed commits$" "rm's message"
has '^  2  fresh stop  removed$' "the others go on"
has '^  4  idle one  failed: Not running$' "stop's message"
expect "$(acts)" "rm aaaaaaa1;rm aaaaaaa2;stop bbbbbbb1;" "no rm after a failed stop"
# Nothing offered; a list it can't read; a bad option
reset
sessions cccccccc:busy:busy:600
expect "$(tidy_run '')" 0 "nothing offered"
has '^Nothing to offer: each session above is left alone for the reason beside it\.$' "nothing offered"
echo 'not json' > "$fix/agents.json"
expect "$(tidy_run '')" 1 "an unreadable list"
has "^Couldn't read the session list" "an unreadable list"
expect "$(tidy_run '' --days)" 2 "--days without a number"
expect "$(tidy_run '' --bogus)" 2 "an unknown option"
pass "tidy: groups and reasons, last used, --here, --days, ended with the background service, --list, picks, s, Enter, the second yes, checked again, --pinned, failures"

# 15. A session belongs to the project it started in, wherever Claude lists it now (session_homes, the rule of
#     sessionHome in state.ts): its heartbeat's root (its own mod's record, however old), else its transcript's first
#     cwd, else the folder it's listed in. "mover" moved to a worktree of the project's repository outside it, with its
#     own CLAUDE.md; "quiet" moved there too and stopped (no heartbeat, its transcript started in the project);
#     "visitor" started in another project and moved into this one. ccc's pick, ccc <name> and ccc tidy --here go by it
reset
rm -rf "$HOME/.claude/projects" "$HOME/.claude/jobs" "$HOME/.claude/sessions"
outside="$work/home/wt-outside"
mkdir -p "$outside"
touch "$outside/CLAUDE.md"
outside="$(cd "$outside" && pwd -P)"
# beat_root <id> <pid> <root>: a heartbeat that names the project its session belongs to
beat_root() { beat "$1" "$2"; printf 'root=%s\n' "$3" >> "$data/alive/$1-0000-0000-0000-000000000000"; }
sessions "aaaaaaaa:mover:waiting:600:$outside" "bbbbbbbb:quiet:-:600:$outside" "cccccccc:visitor:idle:600:$proj/src"
beat_root aaaaaaaa 1000 "$proj"
beat_root cccccccc 1002 "$other"
mkdir -p "$HOME/.claude/projects/-wt-outside"
printf '{"type":"permission-mode"}\n{"type":"user","cwd":"%s","message":{"content":"hi"}}\n{"type":"user","cwd":"%s"}\n' "$proj" "$outside" > "$(transcript -wt-outside bbbbbbbb)"
expect "$(field "$(pick)" session)" aaaaaaaa "ccc's pick: the project's session that moved out, by its heartbeat"
expect "$(field "$(PICK_IN="$proj/src" pick)" session)" aaaaaaaa "ccc's pick from a subfolder"
d="$(pick mover)"
expect "$(field "$d" action)" attach "ccc <name>: a session that moved out is still found"
expect "$(field "$d" session)" aaaaaaaa "ccc <name>: that session"
expect "$(field "$(pick visitor)" action)" create "ccc <name>: one that moved in from another project isn't this one's"
d="$(PICK_IN="$outside" pick)"
expect "$(field "$d" action)" prompt "the outside worktree's own folder: none of them is its"
expect "$(field "$d" stopped)" "[]" "the outside worktree's own folder: not the stopped one either"
# Both stopped: the Name prompt lists them, one by its old heartbeat, one by its transcript's first row with a cwd (its
# last row is outside)
sessions "aaaaaaaa:mover:-:600:$outside" "bbbbbbbb:quiet:-:600:$outside" "cccccccc:visitor:idle:600:$proj/src"
d="$(pick)"
expect "$(field "$d" action)" prompt "only stopped ones of the project: the Name prompt"
expect "$(field "$d" stopped)" "['aaaaaaaa', 'bbbbbbbb']" "they're listed, by heartbeat and by transcript"
sessions "aaaaaaaa:mover:waiting:600:$outside" "bbbbbbbb:quiet:-:600:$outside" "cccccccc:visitor:idle:600:$proj/src"
expect "$(tidy_run '' --here --list)" 0 "tidy --here --list with moved sessions"
has '^Sessions · myapp$' "--here: the project"
has '^  1  quiet +~/wt-outside +last used ' "--here: the stopped one that moved out, from its transcript"
has '^     mover +~/wt-outside +waiting for you' "--here: the running one that moved out, from its heartbeat"
lacks 'visitor' "--here: one that moved in from another project"
TIDY_IN="$outside" tidy_run '' --here --list > /dev/null
lacks 'quiet|mover|visitor' "--here in the outside worktree: none of them"
pass "membership: the project a session started in, for ccc's pick, ccc <name> and ccc tidy --here (heartbeat, transcript)"

# 16. A switch a panel asks for in the window's file (end=1, its last line) is done by the window's watcher
#     (launcher.py watch): it ends the viewer at once, also when the file is made first and its bytes come later (as
#     $.fs.write writes it: a watch of the folder alone misses those bytes), and the loop opens the next viewer over the
#     last frame (no clear, the alternate screen kept) with no "Hangup" report. While a viewer runs, the window says
#     what it shows (.showing, with its three processes); a file with no end (a restart's reopen, a panel that closes
#     the viewer itself) waits for the viewer to end; .showing and the watcher go with the launcher. Without python3
#     the window says it's needed and opens nothing
reset
export SESSIONS_PLUGIN_VERSION=0.16.0 SESSIONS_PLUGIN_SINCE=0
touch "$fix/attach-wait"
win="$data/windows/_dev_ttys900"
until_true() { local n=$1; shift; for _ in $(seq 1 "$n"); do if "$@"; then return 0; fi; sleep 0.02; done; return 1; }
showing_is() { grep -q "^id=$1\$" "$win.showing" 2>/dev/null; }
key_of() { sed -n "s/^$1=//p" "$2"; }
alive() { kill -0 "$1" 2>/dev/null; }
# switch_ms <file> <viewer pid> <text> <split>: writes the window's file as a panel does (split 1: made first, its bytes
# 50 ms later) and prints how long the viewer lived after the bytes, in ms (9999: still there after 3 s)
switch_ms() {
  python3 - "$@" <<'PY'
import os, sys, time
path, pid, text, split = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4] == '1'
if split:
    open(path, 'w').close()
    time.sleep(0.05)
with open(path, 'w') as f:
    f.write(text)
t = time.time()
while time.time() - t < 3:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        print(int((time.time() - t) * 1000))
        sys.exit()
    time.sleep(0.002)
print(9999)
PY
}
SWITCH_B=$'format=3\ncommand=attach\nid=bbbbbbbb\ntitle=beta\nend=1\n'
(cd "$proj" && TERM=xterm-256color /bin/bash "$hooks/visor.sh" attach aaaaaaaa < /dev/null > "$work/out.txt" 2>&1) &
launcher=$!
until_true 150 showing_is aaaaaaaa || fail "showing" "no .showing for the first viewer"
until_true 150 test -s "$fix/viewer-aaaaaaaa" || fail "showing" "the first viewer didn't start"
v1=$(key_of viewer "$win.showing")
watcher=$(key_of watcher "$win.showing")
expect "$v1" "$(cat "$fix/viewer-aaaaaaaa")" ".showing names the viewer's own pid"
expect "$(key_of tty "$win.showing") $(key_of command "$win.showing")" "/dev/ttys900 attach" ".showing's terminal and command"
expect "$(/bin/ps -o ppid= -p "$watcher" | tr -d ' ')" "$(key_of launcher "$win.showing")" "the watcher is the launcher's"
/bin/ps -o command= -p "$watcher" | grep -q 'launcher.py watch' || fail "showing" "the watcher pid isn't the watcher"
sleep 0.3
ms=$(switch_ms "$win" "$v1" "$SWITCH_B" 1)
[ "$ms" -lt 500 ] || fail "watcher" "the viewer lived $ms ms after the switch was asked"
until_true 150 showing_is bbbbbbbb || fail "watcher" "the next viewer didn't open"
v2=$(key_of viewer "$win.showing")
printf 'format=3\ncommand=attach\nid=cccccccc\ntitle=gamma\n' > "$win"
sleep 1.3
alive "$v2" || fail "no end" "a file with no end=1 ended the viewer"
kill -HUP "$v2"
until_true 150 showing_is cccccccc || fail "no end" "not opened once the viewer ended"
# A watcher that stopped: the next viewer's window says nothing (no switch would come of it), and switches the old way
kill -9 "$watcher"
sleep 0.2
printf 'format=3\ncommand=attach\nid=dddddddd\ntitle=delta\n' > "$win"
kill -HUP "$(key_of viewer "$win.showing")"
until_true 150 grep -q '^attach dddddddd' "$fix/calls.log" || fail "watcher gone" "the next viewer didn't open"
until_true 150 test -s "$fix/viewer-dddddddd" || fail "watcher gone" "the next viewer didn't start"
[ ! -e "$win.showing" ] || fail "watcher gone" "a .showing with no watcher: $(cat "$win.showing")"
kill -HUP "$(cat "$fix/viewer-dddddddd")"
wait "$launcher" || true
[ ! -e "$win.showing" ] || fail "cleanup" ".showing outlived the launcher"
[ ! -e "$win" ] || fail "cleanup" "the window's file, read and left empty, outlived the launcher"
watcher_gone() { ! alive "$watcher"; }
until_true 50 watcher_gone || fail "cleanup" "the watcher outlived the launcher"
expect "$(grep -c '^attach' "$fix/calls.log")" 4 "four viewers"
grep -q Hangup "$work/out.txt" && fail "report" "bash reported the ended viewer: $(cat -v "$work/out.txt")"
expect "$(grep -o $'\e\\[?1049l' "$work/out.txt" | wc -l | tr -d ' ')" 2 "the alternate screen is left only before the first viewer and at the end"
expect "$(grep -o $'\e\\[2J' "$work/out.txt" | wc -l | tr -d ' ')" 1 "the screen is cleared only before the first viewer"
# The watcher alone, with each watch this system has (--how): it ends the viewer within half its pass (1 s), whichever
# way the file is written; a .showing that names another watcher, a file with no end=1 or of another format end none,
# and a viewer gets one SIGHUP however often the folder changes before it ends
watches=$(python3 -c 'import select, sys; print("kqueue" if hasattr(select, "kqueue") else "inotify" if sys.platform.startswith("linux") else "")')
# showing_for <viewer> <watcher>: the .showing a launcher with that watcher writes for that viewer
showing_for() { printf 'format=3\ntty=/dev/ttys900\ncommand=attach\nid=aaaaaaaa\nviewer=%s\nlauncher=%s\nwatcher=%s\n' "$1" $$ "$2" > "$win.showing"; }
for how in $watches poll; do
  rm -f "$win" "$win.showing"
  python3 "$hooks/launcher.py" watch --file "$win" --launcher $$ --how "$how" &
  w=$!
  sleep 0.3
  alive "$w" || fail "watch ($how)" "it didn't start"
  for split in 1 0; do
    sleep 600 &
    v=$!
    disown "$v"
    showing_for "$v" "$w"
    ms=$(switch_ms "$win" "$v" "$SWITCH_B" "$split")
    [ "$ms" -lt 500 ] || fail "watch ($how)" "the viewer lived $ms ms after the switch was asked (bytes later: $split)"
    rm -f "$win"
  done
  kill "$w"
done
python3 "$hooks/launcher.py" watch --file "$win" --launcher $$ &
w=$!
sleep 0.3
sleep 600 &
v=$!
disown "$v"
showing_for "$v" 1
printf '%s' "$SWITCH_B" > "$win"
printf 'format=2\ncommand=attach\nid=bbbbbbbb\nend=1\n' > "$win.other"
sleep 1.3
alive "$v" || fail "watch" "it ended a viewer a .showing of another watcher names"
printf 'format=2\ncommand=attach\nid=bbbbbbbb\ntitle=beta\nend=1\n' > "$win"
showing_for "$v" "$w"
sleep 1.3
alive "$v" || fail "watch" "it followed a file of another format"
kill "$v"
bash -c 'trap "echo x >> \"$1\"" HUP; while :; do sleep 0.05; done' sh "$work/hups" &
v=$!
disown "$v"
sleep 0.3
showing_for "$v" "$w"
printf '%s' "$SWITCH_B" > "$win"
for i in 1 2 3; do sleep 0.2; touch "$win.other$i"; done
sleep 0.3
expect "$(wc -l < "$work/hups" | tr -d ' ')" 1 "one SIGHUP per viewer"
kill "$v" "$w"
rm -f "$win" "$win".*
# A launcher killed outright (no trap runs): its watcher ends by itself within its pass
bash -c 'python3 "$1" watch --file "$2" --launcher $$ < /dev/null > /dev/null 2>&1 & sleep 600' sh "$hooks/launcher.py" "$win" > /dev/null 2>&1 &
outer=$!
sleep 0.5
w=$(pgrep -P "$outer" -f 'launcher.py watch' || true)
[ -n "$w" ] || fail "orphan" "no watcher under the stand-in launcher"
others=$(pgrep -P "$outer" -f '^sleep 600' || true)
kill -9 "$outer"
if [ -n "$others" ]; then kill "$others" 2>/dev/null || true; fi
gone_pid() { ! kill -0 "$1" 2>/dev/null; }
if ! until_true 100 gone_pid "$w"; then
  kill "$w" 2>/dev/null || true
  fail "orphan" "the watcher outlived a launcher killed outright"
fi
# python3 is required: without it, a window says so and opens nothing
nopy="$work/nopy"
mkdir -p "$nopy"
for t in bash dirname uname mkdir rm stty clear sleep cat; do p=$(command -v "$t") && ln -sf "$p" "$nopy/$t"; done
: > "$fix/calls.log"
code=0
(cd "$proj" && PATH="$nopy" /bin/bash "$hooks/visor.sh" attach aaaaaaaa < /dev/null > "$work/out.txt" 2>&1) || code=$?
expect "$code" 1 "without python3, the window's launcher fails"
grep -q 'needs python3' "$work/out.txt" || fail "no python3" "it didn't say python3 is needed: $(cat -v "$work/out.txt")"
[ ! -s "$fix/calls.log" ] || fail "no python3" "it ran claude anyway: $(cat "$fix/calls.log")"
rm -f "$fix/attach-wait"
unset SESSIONS_PLUGIN_VERSION SESSIONS_PLUGIN_SINCE
pass "the window's watcher: .showing, a switch at once (end=1), a reopen that waits, the last frame kept, no report, cleanup; each watch; python3 required"

# 16b. The mod's own watch (launcher.py watch-paths), with the kernel watch the platform picks (kqueue on macOS, inotify
#      on Linux): ready once armed, then a line for a write, a new file, a removal, a file in a folder made after it
#      started (a watched folder that was missing) and a watched file written beside and renamed over (how bells and
#      pins.json are written); it ends as soon as its parent does, even one killed outright
case "$(uname -s)" in
  Darwin) how=kqueue ;;
  Linux) how=inotify ;;
  *) how='' ;;
esac
if [ -n "$how" ]; then
  paths="$work/paths"
  mkdir -p "$paths/reg" "$paths/jobs"
  echo one > "$paths/reg/1.json"
  bash -c 'python3 "$1" watch-paths --how "$2" "$3/reg" "$3/tell" "$3/jobs/pins.json" > "$3.out" 2> "$3.err" & echo $! > "$3.pid"; wait' sh "$hooks/launcher.py" "$how" "$paths" &
  outer=$!
  has_line() { grep -qxF "$1" "$paths.out"; }
  until_true 150 test -s "$paths.out" || fail "watch-paths" "no ready: $(cat "$paths.err")"
  helper=$(cat "$paths.pid")
  tab=$'\t'
  head -n 1 "$paths.out" | grep -q "^ready$tab$how$tab$helper${tab}[0-9]*\$" || fail "watch-paths" "not ready as expected: $(head -n 1 "$paths.out")"
  echo two >> "$paths/reg/1.json"
  until_true 100 has_line "change$tab$paths/reg/1.json" || fail "watch-paths ($how)" "no line for a write: $(cat "$paths.out")"
  echo new > "$paths/reg/2.json"
  until_true 100 has_line "add$tab$paths/reg/2.json" || fail "watch-paths ($how)" "no line for a new file: $(cat "$paths.out")"
  rm "$paths/reg/1.json"
  until_true 100 has_line "unlink$tab$paths/reg/1.json" || fail "watch-paths ($how)" "no line for a removal: $(cat "$paths.out")"
  mkdir -p "$paths/tell/bbbbbbbb"
  sleep 0.2
  echo request > "$paths/tell/bbbbbbbb/1"
  until_true 100 has_line "add$tab$paths/tell/bbbbbbbb/1" || fail "watch-paths ($how)" "no line for a file in a folder made since: $(cat "$paths.out")"
  echo pins > "$paths/jobs/pins.json.tmp"
  mv "$paths/jobs/pins.json.tmp" "$paths/jobs/pins.json"
  until_true 100 has_line "add$tab$paths/jobs/pins.json" || fail "watch-paths ($how)" "no line for a watched file that came: $(cat "$paths.out")"
  echo pins2 > "$paths/jobs/pins.json.tmp"
  mv "$paths/jobs/pins.json.tmp" "$paths/jobs/pins.json"
  until_true 100 has_line "change$tab$paths/jobs/pins.json" || fail "watch-paths ($how)" "no line for a file renamed over: $(cat "$paths.out")"
  echo pins3 >> "$paths/jobs/pins.json"
  sleep 0.3
  expect "$(grep -c "^change$tab$paths/jobs/pins.json\$" "$paths.out")" 2 "a write to the file renamed over is heard too"
  grep -q 'pins.json.tmp' "$paths.out" && fail "watch-paths ($how)" "a file beside a watched one was reported: $(cat "$paths.out")"
  alive "$helper" || fail "watch-paths ($how)" "it ended on its own: $(cat "$paths.err")"
  kill -9 "$outer"
  wait "$outer" 2> /dev/null || true
  until_true 100 gone_pid "$helper" || fail "watch-paths ($how)" "it outlived its parent, killed outright"
  pass "the mod's own watch ($how): ready, a write, a new file, a removal, a folder made since, a file renamed over; it ends with its parent"
fi

# 17. What's typed during a switch is dropped, on a real terminal (a pty): what was pending when the switch was asked
#     and what's typed while the next viewer starts never reach it (an Enter neither: the next viewer reads from its
#     start, and a whole line would reach it first), what's typed once it has the terminal does, and what was typed
#     before the first viewer (from the shell) reaches the first viewer
reset
export SESSIONS_PLUGIN_VERSION=0.16.0 SESSIONS_PLUGIN_SINCE=0
touch "$fix/attach-read" "$fix/attach-early-bbbbbbbb"
python3 - "$hooks/visor.sh" "$data/windows" "$fix" > "$work/typed.txt" 2> "$work/typed.err" <<'PY' || fail "typed" "the pty run failed: $(cat "$work/typed.err")"
import os, pty, sys, threading, time
visor, windows, fix = sys.argv[1:4]

def until(cond, seconds=10):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False

def text(name):
    path = os.path.join(fix, name)
    return open(path).read() if os.path.exists(path) else None

pid, master = pty.fork()
if pid == 0:
    os.environ.pop('SESSIONS_TTY', None)
    os.environ['TERM'] = 'xterm-256color'
    os.execvp('bash', ['bash', visor, 'attach', 'aaaaaaaa'])
# What the window shows is read and thrown away, so the terminal never blocks
def drain():
    # Until the terminal closes: on Linux a read once the child is gone raises (EIO), which ends this, quietly
    try:
        while os.read(master, 65536):
            pass
    except OSError:
        pass
threading.Thread(target=drain, daemon=True).start()
os.write(master, b'first')
until(lambda: text('read-aaaaaaaa') is not None)
print('first viewer read: %r' % text('read-aaaaaaaa'))
until(lambda: any(n.endswith('.showing') for n in os.listdir(windows)))
showing = [n for n in os.listdir(windows) if n.endswith('.showing')][0]
until(lambda: text('read2-aaaaaaaa') is not None, 5)
time.sleep(0.3)
# Pending when the switch is asked, then typed while the next viewer starts, with an Enter (it reads from its start
# and takes the terminal 1 s later)
os.write(master, b'pending')
time.sleep(0.2)
with open(os.path.join(windows, showing[:-len('.showing')]), 'w') as f:
    f.write('format=3\ncommand=attach\nid=bbbbbbbb\ntitle=beta\nend=1\n')
time.sleep(0.2)
os.write(master, b'during\r')
until(lambda: text('read-bbbbbbbb') is not None)
print('next viewer, as it started: %s' % (text('early-bbbbbbbb') or '').strip())
print('next viewer read: %r' % text('read-bbbbbbbb'))
os.write(master, b'later')
until(lambda: text('read2-bbbbbbbb') is not None, 5)
print('then: %r' % text('read2-bbbbbbbb'))
os.kill(int(text('viewer-bbbbbbbb')), 1)
os.waitpid(pid, 0)
PY
grep -q "^first viewer read: 'first'$" "$work/typed.txt" || fail "typed" "the first viewer didn't get what was typed before it: $(cat "$work/typed.txt")"
grep -q "^next viewer, as it started: none$" "$work/typed.txt" || fail "typed" "an Enter typed during the switch reached the next viewer as it started: $(cat "$work/typed.txt")"
grep -q "^next viewer read: ''$" "$work/typed.txt" || fail "typed" "keys typed during the switch reached the next viewer: $(cat "$work/typed.txt")"
grep -q "^then: 'later'$" "$work/typed.txt" || fail "typed" "a key typed once the next viewer had the terminal didn't reach it: $(cat "$work/typed.txt")"
rm -f "$fix/attach-read" "$fix/attach-early-bbbbbbbb"
unset SESSIONS_PLUGIN_VERSION SESSIONS_PLUGIN_SINCE
pass "a switch drops what's typed until the next viewer has the terminal (a pty); the first viewer gets what was typed before it"

# What ccc hands the launcher (the installed version and since when) never reaches a claude it runs: a viewer or a
# start that brings up the background service would pass it on to every session the service starts
[ ! -s "$LEAKS" ] || fail "environment" "claude saw SESSIONS_PLUGIN_VERSION/SINCE: $(sort -u "$LEAKS" | head -5 | tr '\n' ';')"
for kind in '--bg' 'attach ' 'respawn ' 'stop ' 'rm '; do
  grep -q -- "^$kind" "$EVERY_CALL" || fail "environment" "the check never saw a claude $kind"
done
pass "environment: no claude the launcher runs (start, viewer, respawn, list) sees SESSIONS_PLUGIN_VERSION/SINCE"

echo "launcher: ok"
