#!/usr/bin/env python3
"""What `ccc` opens: the decisions of the sessions launcher (hooks/visor.sh runs this, then the window's loop).

    launcher.py start --tty TTY --file FILE [--new | --agents] [--exclude ID] [NAME...]
    launcher.py pick [--tty TTY] [--new] [NAME...]      the decision only, as JSON (tests and debugging)
    launcher.py tell [--in DIR] [--wait[=S]] NAME|ID [TEXT... | -]   ccc tell: hand a background session text (tell())
    launcher.py section [--session NAME|ID] [TITLE | -]  ccc section: the person's section for a session (section())
    launcher.py tidy [--here] [--pinned] [--days N] [--list]   ccc tidy: end the sessions no longer needed (tidy())
    launcher.py watch --file FILE --launcher PID          the window's watcher, beside visor.sh's loop (watch())
    launcher.py watch-paths --how kqueue|inotify PATH...  the mod's own file watch, where Claude watches nothing for it
                                                          (watch_paths())

start decides and, when something should open in this window, writes it to FILE (the window's file, which visor.sh
reads): the project's top session, the session NAME (created if there's none), the agent view (--agents). In order:

1. One window per project: if another terminal window already shows a session of this project, that window is brought
   forward (a running session's mod does it: the platform code lives there) and nothing opens here. `ccc NAME` switches
   that window to NAME. --new skips this.
2. The top session of the panel's list (the order file the panels write; without a fresh one, waiting, working, idle,
   then by name), skipping sessions already shown in another window and stopped ones.
3. No session to open: the Name prompt, listing the stopped sessions to reopen by number or name. A new name creates a
   background session in the project folder and opens it once its mod is up (one automatic restart if it isn't).

Before opening a session whose mod should be running and isn't (no heartbeat: an old pre-started process, for one), it
asks whether to restart it first. On arrival the panel takes the keyboard: a request in the session's inbox.

The files it reads and writes are the mod's (hooks/state.ts has the formats): <data>/alive/<sessionId> (heartbeats),
<data>/order/<root> (the panel's order), <data>/inbox/<sessionId> (requests), <data>/windows/<tty> (what a window opens
next; its watcher reads it and <tty>.showing, what the window shows), <data>/config (settings the mod mirrors), <data>/tell/<id>/ (ccc tell's requests), <data>/sections.json (the
person's sections, which ccc section changes, ringing <data>/bell/sections for the panels that watch it), with
<data> = ~/.claude/mods/sessions-data or SESSIONS_DATA_DIR.
Claude's own files, read only: the first row of a session's transcript (~/.claude/projects/*/<sessionId>.jsonl, under
HOME), for the project of a session whose heartbeat doesn't name one (session_homes); and by ccc tidy, <jobs>/pins.json
and <jobs>/<id>/state.json (the background service's: ~/.claude/jobs or SESSIONS_JOBS_DIR), <registry>/<pid>.json (the
running sessions: ~/.claude/sessions or SESSIONS_REGISTRY_DIR), when each stopped session's transcript was last
written, and the background service's log for the stopped ones that ended with it (~/.claude/daemon.log or
SESSIONS_DAEMON_LOG).
Other environment: SESSIONS_CLAUDE (the claude command), SESSIONS_PLUGIN_VERSION and SESSIONS_PLUGIN_SINCE (the
installed plugin, from the ccc command), SESSIONS_START_WAIT (seconds to wait for a new session's mod).
"""
import collections
import datetime
import json
import os
import re
import subprocess
import sys
import time
import unicodedata

FORMAT = 3
SECTIONS_FORMAT = 1
TELL_MAX_BYTES = 4096
HEARTBEAT_VERSION = (0, 10, 0)
HEARTBEAT_FRESH_MS = 45000
# The panels rewrite the order file when it changes and at least once a pass (a minute, each from its own offset)
ORDER_FRESH_MS = 150000
INBOX_FRESH_MS = 30000

HOME = os.environ.get('HOME', '')
DATA = os.environ.get('SESSIONS_DATA_DIR') or os.path.join(HOME, '.claude', 'mods', 'sessions-data')
CLAUDE = os.environ.get('SESSIONS_CLAUDE') or 'claude'
JOBS = os.environ.get('SESSIONS_JOBS_DIR') or os.path.join(HOME, '.claude', 'jobs')
REGISTRY = os.environ.get('SESSIONS_REGISTRY_DIR') or os.path.join(HOME, '.claude', 'sessions')
PROJECTS = os.path.join(HOME, '.claude', 'projects')
DAEMON_LOG = os.environ.get('SESSIONS_DAEMON_LOG') or os.path.join(HOME, '.claude', 'daemon.log')
START_WAIT = float(os.environ.get('SESSIONS_START_WAIT') or '10')

DIM, RESET, BOLD = '\033[2m', '\033[0m', '\033[1m'


def now_ms():
    return int(time.time() * 1000)


def say(text=''):
    print(text, flush=True)


# The shared files: key=value lines, the first `=` splits (see keyLines in state.ts)
def parse_key_lines(text):
    out = {}
    for line in text.split('\n'):
        k, sep, v = line.partition('=')
        if sep and k and k not in out:
            out[k] = v
    return out


def read_text(path):
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except OSError:
        return ''


def write_key_lines(path, entries):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = ''.join('%s=%s\n' % (k, re.sub(r'[\r\n]+', ' ', str(v))) for k, v in entries if v is not None)
    temporary = '%s.tmp-%d' % (path, os.getpid())
    with open(temporary, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(temporary, path)


def file_key(path):
    return path.replace('/', '_')


def parse_version(text):
    m = re.match(r'^(\d+)\.(\d+)\.(\d+)', str(text or ''))
    return tuple(int(x) for x in m.groups()) if m else None


# The project root, as the mod computes it (rootFrom in state.ts): the nearest folder upwards with AGENTS.md or
# CLAUDE.md, below the top two levels; else this folder. A folder inside <x>/.claude/worktrees/ walks from <x>
# (worktreeBase in state.ts)
def worktree_base(cwd):
    i = cwd.find('/.claude/worktrees/')
    return cwd[:i] if i > 0 else cwd


def project_root(cwd):
    base = worktree_base(cwd)
    d = base
    while True:
        if len([p for p in d.split('/') if p]) > 2 and any(os.path.isfile(os.path.join(d, n)) for n in ('AGENTS.md', 'CLAUDE.md')):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return base
        d = parent


def in_project(cwd, root, home):
    if cwd == root:
        return True
    if not root or root == '/' or (home and root == home):
        return False
    return cwd.startswith(root + '/')


# The folder that says which project a session belongs to (sessionHome in state.ts): the one it started in, wherever
# it went afterwards (a worktree inside or outside the project, /cd), which `claude agents` lists it in. In order: the
# project root its own mod recorded (its heartbeat's root, in this format, however old: a stopped session's too), the
# first cwd row of its transcript, the folder it's listed in. {sessionId: folder}, for the sessions given
def session_homes(sessions):
    homes, missing = {}, []
    for s in sessions:
        beat = read_heartbeat(s['sessionId'])
        root = beat['root'] if beat and beat['format'] == FORMAT else ''
        if root.startswith('/'):
            homes[s['sessionId']] = root
        else:
            missing.append(s['sessionId'])
    starts = {sid: first_cwd(path) for sid, (path, _) in transcripts(missing).items()}
    for s in sessions:
        homes.setdefault(s['sessionId'], starts.get(s['sessionId']) or s['cwd'])
    return homes


# The sessions of the list that belong to the project at root (session_homes)
def project_sessions(sessions, root):
    homes = session_homes(sessions)
    return [s for s in sessions if in_project(homes[s['sessionId']], root, HOME)]


# What ccc hands the launcher (the installed plugin's version and since when) is for the launcher alone. A claude it ran
# with them would pass them on: to the background service, when that call is what starts it, and from there to every
# session the service starts, whose mod would keep its data apart (a store namespace, as a test session's). Every other
# variable goes on (tests pass SESSIONS_DATA_DIR and the like on purpose)
LAUNCHER_ONLY = ('SESSIONS_PLUGIN_VERSION', 'SESSIONS_PLUGIN_SINCE')
CHILD_ENV = {k: v for k, v in os.environ.items() if k not in LAUNCHER_ONLY}


def run(argv, cwd=None, timeout=30):
    try:
        r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=CHILD_ENV)
        return r.returncode, r.stdout, r.stderr
    except (OSError, subprocess.SubprocessError) as err:
        return 127, '', str(err)


def list_sessions():
    code, out, _ = run([CLAUDE, 'agents', '--json', '--all'])
    if code != 0:
        return None
    try:
        rows = json.loads(out)
    except ValueError:
        return None
    if not isinstance(rows, list):
        return None
    return [s for s in rows if isinstance(s, dict) and isinstance(s.get('sessionId'), str) and isinstance(s.get('cwd'), str)]


def is_live(s):
    return bool(s.get('pid')) and s.get('status') is not None


def title_of(s):
    name = s.get('name')
    if name and name != s.get('id'):
        return name
    return s.get('id') or s['sessionId'][:8]


def read_heartbeat(session_id):
    k = parse_key_lines(read_text(os.path.join(DATA, 'alive', session_id)))
    try:
        at = int(k.get('at', ''))
    except ValueError:
        return None
    if not k.get('format') or at <= 0:
        return None
    try:
        pid = int(k.get('pid') or 0)
    except ValueError:
        pid = 0
    return {'format': int(k['format']) if k['format'].isdigit() else 0, 'pid': pid, 'at': at, 'version': k.get('version', ''), 'root': k.get('root', '')}


# heartbeatStatus in state.ts
def heartbeat_status(h, pid, now):
    if not h or now - h['at'] > HEARTBEAT_FRESH_MS:
        return 'missing'
    if h['format'] != FORMAT:
        return 'other-format'
    if pid and h['pid'] and pid != h['pid']:
        return 'missing'
    return 'ok'


# expectsHeartbeat in state.ts: a running session started (more than 30 s ago) after a mod version with heartbeats was
# installed
def expects_heartbeat(s, plugin, now):
    if not s.get('pid') or not s.get('status') or not plugin:
        return False
    v = parse_version(plugin.get('version'))
    if not v or v < HEARTBEAT_VERSION:
        return False
    started = int(s.get('startedAt') or 0)
    return started > plugin.get('since', 0) + 2000 and now - started > 30000


def plugin_info():
    version = os.environ.get('SESSIONS_PLUGIN_VERSION', '')
    if not version:
        return None
    try:
        since = int(os.environ.get('SESSIONS_PLUGIN_SINCE') or 0)
    except ValueError:
        since = 0
    return {'version': version, 'since': since}


# The order the panels wrote for this project, if it's fresh and in this format: the sessionIds, top first
def read_order(root, now):
    text = read_text(os.path.join(DATA, 'order', file_key(root)))
    k = parse_key_lines(text)
    try:
        at = int(k.get('at') or 0)
    except ValueError:
        at = 0
    if k.get('format') != str(FORMAT) or k.get('root') != root or now - at > ORDER_FRESH_MS:
        return None
    return [line[4:].split('\t')[0] for line in text.split('\n') if line.startswith('row=')]


# Without a fresh order file: waiting for you, working, idle, stopped; then by title
FALLBACK_RANK = {'waiting': 0, 'busy': 1, 'idle': 2}


def order_rows(rows, order):
    def fallback(s):
        return (FALLBACK_RANK.get(s.get('status'), 3) if is_live(s) else 3, title_of(s).casefold())
    rest = sorted(rows, key=fallback)
    if not order:
        return rest
    position = {sid: i for i, sid in enumerate(order)}
    return sorted(rest, key=lambda s: position.get(s['sessionId'], len(position)))


# A claude run through the glibc loader (hosts whose glibc is too old) is listed by ps as the loader's line: read it as
# `claude <args>`, as clientCommand in platform/linux.ts does; any other command stays as it is
def client_command(command):
    m = re.match(r'^\S*/ld-linux[^\s/]*\s+(?:--library-path\s+\S+\s+)?\S*/claude/versions/\d+\.\d+\.\d+(?:\s+(.*))?$', command)
    return ('claude ' + m.group(1) if m.group(1) else 'claude') if m else command


# Which windows show which session, from ps (parseWindows in state.ts): viewers (claude attach <id>), launchers, agent
# views (views), and every process's terminal (by_pid: a regular session's own window)
def parse_windows(ps):
    by_id, by_pid, clients, launchers, views = {}, {}, {}, {}, {}
    for line in ps.split('\n'):
        parts = line.split()
        if len(parts) < 3 or parts[1] in ('??', '?', '-'):
            continue
        pid, tty, command = parts[0], '/dev/' + parts[1], client_command(' '.join(parts[2:]))
        by_pid[pid] = tty
        m = re.match(r'^(\S*/)?claude attach ([0-9a-f]{8})$', command)
        if m:
            by_id.setdefault(m.group(2), []).append(tty)
            clients[tty] = pid
        if re.match(r'^(\S*/)?claude agents( |$)', command):
            clients[tty] = pid
            views[tty] = pid
        if re.match(r'^(\S*/)?bash \S*/visor\.sh( |$)', command):
            launchers[tty] = pid
    return {'by_id': by_id, 'by_pid': by_pid, 'clients': clients, 'launchers': launchers, 'views': views}


def read_windows():
    # One -o per column, as windows() in register.tsx: procps reads `-o pid=,tty=,command=` as the pid column alone
    code, out, _ = run(['ps', '-A', '-o', 'pid=', '-o', 'tty=', '-o', 'command='])
    return parse_windows(out if code == 0 else '')


def context(tty, exclude=()):
    cwd = os.path.realpath(os.getcwd())
    root = project_root(cwd)
    now = now_ms()
    sessions = list_sessions()
    rows = [s for s in project_sessions(sessions or [], root) if s.get('id') not in exclude]
    rows = order_rows(rows, read_order(root, now))
    beats = {s['sessionId']: read_heartbeat(s['sessionId']) for s in rows}
    return {
        'cwd': cwd, 'root': root, 'now': now, 'tty': tty, 'listed': sessions is not None, 'rows': rows,
        'beats': beats, 'plugin': plugin_info(), 'windows': read_windows(),
    }


def status_of(ctx, s):
    return heartbeat_status(ctx['beats'].get(s['sessionId']), s.get('pid'), ctx['now'])


def shown_elsewhere(ctx, s):
    return [t for t in ctx['windows']['by_id'].get(s.get('id') or '', []) if t != ctx['tty']]


def needs_restart(ctx, s):
    return expects_heartbeat(s, ctx['plugin'], ctx['now']) and status_of(ctx, s) == 'missing'


def find_by_name(ctx, name):
    rows = ctx['rows']
    for test in (lambda s: s.get('name') == name, lambda s: str(s.get('name') or '').casefold() == name.casefold(), lambda s: s.get('id') == name):
        found = [s for s in rows if test(s)]
        if found:
            return found[0]
    return None


# Who can bring a window forward: the mod of a running session of the project that answers (fresh heartbeat in this
# format), the one shown in that window first
def helpers(ctx, first=None):
    out = [s for s in ([first] if first else []) + ctx['rows'] if s and is_live(s) and status_of(ctx, s) == 'ok']
    seen, unique = set(), []
    for s in out:
        if s['sessionId'] not in seen:
            seen.add(s['sessionId'])
            unique.append(s)
    return unique


def project_window(ctx):
    for s in ctx['rows']:
        for t in shown_elsewhere(ctx, s):
            return t, s
    return None, None


# The decision, from the context alone (pure: `pick` prints it). Actions: agents; attach (session, restart: whether to
# ask about restarting it first); bring (window, the session it shows); show (window, the session to switch it to);
# create (name, then open it here, or in `window` when the project has one); prompt (the stopped sessions)
def decide(ctx, new=False, agents=False, name=None):
    if agents:
        return {'action': 'agents'}
    rows = ctx['rows']
    window, showing = (None, None) if new else project_window(ctx)
    if name:
        target = find_by_name(ctx, name)
        if target:
            elsewhere = shown_elsewhere(ctx, target)
            if elsewhere:
                return {'action': 'bring', 'window': elsewhere[0], 'session': target, 'named': True, 'helpers': helpers(ctx, target)}
            if window and window in ctx['windows']['launchers']:
                return {'action': 'show', 'window': window, 'session': target, 'showing': showing, 'helpers': helpers(ctx, showing)}
            return {'action': 'attach', 'session': target, 'restart': needs_restart(ctx, target)}
        if window and window in ctx['windows']['launchers']:
            return {'action': 'create', 'name': name, 'window': window, 'showing': showing, 'helpers': helpers(ctx, showing)}
        return {'action': 'create', 'name': name}
    if window:
        return {'action': 'bring', 'window': window, 'session': showing, 'helpers': helpers(ctx, showing)}
    for s in rows:
        if s.get('id') and is_live(s) and not shown_elsewhere(ctx, s):
            return {'action': 'attach', 'session': s, 'restart': needs_restart(ctx, s)}
    stopped = [s for s in rows if s.get('id') and not is_live(s)][:9]
    shown = len([s for s in rows if s.get('id') and is_live(s)])
    return {'action': 'prompt', 'stopped': stopped, 'shown': shown}


def summary(d):
    out = {'action': d['action']}
    for k in ('window', 'name', 'restart', 'shown'):
        if k in d:
            out[k] = d[k]
    for k in ('session', 'showing'):
        if d.get(k):
            out[k] = d[k].get('id')
    if 'helpers' in d:
        out['helpers'] = [s.get('id') for s in d['helpers']]
    if 'stopped' in d:
        out['stopped'] = [s.get('id') for s in d['stopped']]
    return out


# --- acting on the decision ---------------------------------------------------------------------------------------

def request(session, action, **fields):
    entries = [('format', FORMAT), ('action', action), ('at', now_ms())] + list(fields.items())
    write_key_lines(os.path.join(DATA, 'inbox', session['sessionId']), entries)


# Asks the first of the helpers (sessions whose mod answers) that answers to do something, through its inbox, and
# waits up to 3 s for each one's answer: its reply's keys, or None when none answered
def ask_helpers(helpers, action, **fields):
    for helper in helpers:
        reply = os.path.join(DATA, 'replies', '%d-%d' % (os.getpid(), now_ms()))
        os.makedirs(os.path.dirname(reply), exist_ok=True)
        request(helper, action, reply=reply, **fields)
        deadline = time.time() + 3
        answer = {}
        while time.time() < deadline:
            answer = parse_key_lines(read_text(reply))
            if answer.get('result'):
                break
            time.sleep(0.1)
        try:
            os.remove(reply)
        except OSError:
            pass
        if answer.get('result'):
            return answer
    return None


# Asks a session's mod to bring a window forward; waits for its answer. (ok, reason)
def bring(d):
    title = title_of(d['session']) if d.get('session') else ''
    answer = ask_helpers(d.get('helpers') or [], 'bring', tty=d['window'], title=title)
    if answer is None:
        return False, 'no session of this project answered (their panels may not be running)'
    if answer.get('result') == 'ok':
        return True, ''
    return False, answer.get('reason') or 'it said no'


def write_target(path, session):
    write_key_lines(path, [('format', FORMAT), ('command', 'attach'), ('id', session['id']), ('title', title_of(session))])


# Switches another window that runs the launcher to a session, the way the panel's Enter does: its file, then close
# its viewer. The session's panel takes the keyboard when it arrives
def switch_window(ctx, window, session):
    pid = ctx['windows']['clients'].get(window)
    if not pid:
        return False
    request(session, 'focus')
    write_target(os.path.join(DATA, 'windows', file_key(window)), session)
    return run(['kill', '-HUP', pid])[0] == 0


def ask_yes(question, default):
    try:
        answer = input('%s %s ' % (question, '[Y/n]' if default else '[y/N]')).strip().lower()
    except (EOFError, KeyboardInterrupt):
        say()
        return None
    if not answer:
        return default
    return answer in ('y', 'yes')


def fresh_row(session_id):
    for s in list_sessions() or []:
        if s['sessionId'] == session_id:
            return s
    return None


# Waits until the session's mod writes a heartbeat from its current process
def wait_for_heartbeat(session, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        s = fresh_row(session['sessionId']) or session
        if heartbeat_status(read_heartbeat(session['sessionId']), s.get('pid'), now_ms()) == 'ok':
            return True
        time.sleep(0.3)
    return False


def respawn(session):
    code, _, err = run([CLAUDE, 'respawn', session['id']], timeout=60)
    if code != 0:
        say("Couldn't restart it: %s" % (err.strip().split('\n')[0] if err.strip() else 'claude respawn failed'))
    return code == 0


def offer_restart(session):
    idle = session.get('status') == 'idle'
    name = title_of(session)
    say('“%s” is running without its panel: its mod didn\'t start (an old pre-started process, for one).' % name)
    if not idle:
        say("It's %s: restarting it cuts what it's doing." % ('waiting for you' if session.get('status') == 'waiting' else 'working'))
    yes = ask_yes('Restart it first?', idle)
    if yes is None:
        return False
    if yes and respawn(session):
        say('Restarting “%s”…' % name)
        if not wait_for_heartbeat(session, max(START_WAIT, 15)):
            say("Its panel still didn't start: opening it anyway.")
    return True


def debug_on():
    return parse_key_lines(read_text(os.path.join(DATA, 'config'))).get('debug') == '1'


def debug_file(name):
    clean = re.sub(r'^[._]+', '', re.sub(r'[^A-Za-z0-9._-]+', '_', name))[:80] or 'session'
    return os.path.join(DATA, 'debug', clean + '.log')


def expects_new_heartbeat(ctx):
    v = parse_version((ctx['plugin'] or {}).get('version'))
    return bool(v) and v >= HEARTBEAT_VERSION


# Creates a background session in the project folder and waits for its mod. None if it couldn't
def create(ctx, name):
    argv = [CLAUDE, '--bg', '-n', name]
    if debug_on():
        os.makedirs(os.path.join(DATA, 'debug'), exist_ok=True)
        argv += ['--debug-file', debug_file(name)]
    started = now_ms()
    code, out, err = run(argv, cwd=ctx['root'], timeout=60)
    if code != 0:
        text = (err + out).strip()
        if 'not trusted' in text:
            say("Claude doesn't trust this folder yet, so it can't start a session here in the background.")
            say('Run `claude` here once and accept its question (or `ccc --agents`, which asks too), then `ccc %s` again.' % json.dumps(name))
        elif 'trusted one session at a time' in text:
            say("Claude doesn't start background sessions in your home folder: cd to a project folder first.")
        else:
            say("Couldn't create “%s”: %s" % (name, text.split('\n')[0] if text else 'claude --bg failed'))
        return None
    session = None
    for _ in range(20):
        found = [s for s in list_sessions() or [] if s.get('name') == name and s['cwd'] == ctx['root'] and int(s.get('startedAt') or 0) >= started - 5000]
        if found:
            session = sorted(found, key=lambda s: -int(s.get('startedAt') or 0))[0]
            break
        time.sleep(0.3)
    if not session or not session.get('id'):
        say('Created “%s” but can\'t find it in the list: run ccc again.' % name)
        return None
    if expects_new_heartbeat(ctx):
        say('%sStarting “%s”…%s' % (DIM, name, RESET))
        if not wait_for_heartbeat(session, START_WAIT):
            # A session that was just created has no conversation to lose: restart it once, without asking
            say('%sIts panel didn\'t start: restarting it once…%s' % (DIM, RESET))
            if not (respawn(session) and wait_for_heartbeat(session, START_WAIT)):
                say('The panel didn\'t start in “%s”. Enter opens it anyway, Ctrl+C goes back to the shell.' % name)
                try:
                    input()
                except (EOFError, KeyboardInterrupt):
                    say()
                    return None
    return fresh_row(session['sessionId']) or session


# The empty folder: the launcher's own Name field (like the panel's New), with the stopped sessions to reopen
def prompt(ctx, d):
    folder = os.path.basename(ctx['root']) or ctx['root']
    say('%sSessions · %s%s' % (DIM, folder, RESET))
    if not ctx['listed']:
        say("Couldn't read the session list (claude agents --json).")
    if d['shown']:
        say('%s%d open in other windows (ccc --new skips them).%s' % (DIM, d['shown'], RESET))
    for i, s in enumerate(d['stopped'], 1):
        say('  %s%d%s  %s%s  stopped%s' % (BOLD, i, RESET, title_of(s), DIM, RESET))
    hint = 'a number or a name to reopen, a new name to start one' if d['stopped'] else 'a name for a new session'
    say('%s%s · Enter on an empty line goes back to the shell%s' % (DIM, hint, RESET))
    try:
        text = input('Name: ').strip()
    except (EOFError, KeyboardInterrupt):
        say()
        return None
    if not text:
        return None
    if text.isdigit() and 1 <= int(text) <= len(d['stopped']):
        return {'action': 'attach', 'session': d['stopped'][int(text) - 1], 'restart': False}
    return decide(ctx, new=True, name=text)


def start(args, tty, path):
    ctx = context(tty, exclude=args.exclude)
    d = decide(ctx, new=args.new, agents=args.agents, name=' '.join(args.name).strip() or None)
    for _ in range(4):
        if d['action'] == 'agents':
            write_key_lines(path, [('format', FORMAT), ('command', 'agents'), ('title', 'Agents'), ('folder', ctx['cwd'])])
            return 0
        if d['action'] in ('bring', 'show'):
            ok, reason = bring(d)
            if ok:
                folder = os.path.basename(ctx['root']) or ctx['root']
                if d['action'] == 'show' and not switch_window(ctx, d['window'], d['session']):
                    say("Brought %s's window forward, but couldn't switch it to “%s”." % (folder, title_of(d['session'])))
                    return 1
                say('%s is already open in another window%s. ccc --new opens it here too.' % (folder, '' if d['action'] == 'bring' else ' (now on “%s”)' % title_of(d['session'])))
                return 0
            say("%sCouldn't bring the other window forward (%s): opening here.%s" % (DIM, reason, RESET))
            if d['action'] == 'show' or d.get('named'):
                # The session asked for by name (shown there, or to switch that window to): open it here
                d = {'action': 'attach', 'session': d['session'], 'restart': needs_restart(ctx, d['session'])}
            else:
                d = decide(ctx, new=True)
            continue
        if d['action'] == 'create':
            session = create(ctx, d['name'])
            if not session:
                return 1
            if d.get('window'):
                d = {'action': 'show', 'window': d['window'], 'session': session, 'showing': d.get('showing'), 'helpers': d.get('helpers')}
                continue
            d = {'action': 'attach', 'session': session, 'restart': False}
        if d['action'] == 'prompt':
            d = prompt(ctx, d)
            if d is None:
                return 1
            continue
        if d['action'] == 'attach':
            s = d['session']
            if d.get('restart') and not offer_restart(s):
                return 1
            request(s, 'focus')
            write_target(path, s)
            return 0
    return 1


# --- ccc tell ------------------------------------------------------------------------------------------------------
#
# ccc tell [--in DIR] NAME|ID [TEXT... | -] hands a background session text from any script (cron, launchd, a git
# hook): that session's mod submits it as a turn of its own once the session is idle. It needs no terminal and no
# project folder: the session is found by its id, by its name in the project of DIR (or of the current folder), or by a
# name only one background session has. The session must have opted in (/sessions tell on in it), and the text is 4 KB
# at most: send a pointer ("new mail, id ...") rather than outside text. A session the background service retired for
# being idle is woken first, by a running session's mod and under the rules of $.sessions.wake. The request and its
# status file live in <data>/tell/<id>/ (TELL in state.ts); it prints the state and the status file's path, and exits
# 1 when it was refused. --wait[=S] waits (300 s by default) until the session's mod says delivered (exit 0), held (3)
# or refused (1), or the time is up (4, still queued). At most 6 requests a minute and 60 an hour reach one session.

def caller_name():
    # Who ran ccc tell: the parent of the launcher's shell, by its command's name
    code, out, _ = run(['ps', '-o', 'ppid=', '-p', str(os.getppid())])
    parent = out.strip().split('\n')[0].strip() if code == 0 else ''
    if not parent.isdigit():
        return 'ccc'
    code, out, _ = run(['ps', '-o', 'comm=', '-p', parent])
    name = re.sub(r'[^A-Za-z0-9._-]', '', os.path.basename(out.strip().split('\n')[0].strip()).lstrip('-'))[:40]
    return name or 'ccc'


def find_tell_target(sessions, target, folder):
    background = [s for s in sessions if s.get('kind') == 'background' and s.get('id')]
    if re.match(r'^[0-9a-f]{8}$', target):
        for s in background:
            if s['id'] == target:
                return s, None
    root = project_root(os.path.realpath(folder))

    def named(rows):
        exact = [s for s in rows if s.get('name') == target]
        return exact or [s for s in rows if str(s.get('name') or '').casefold() == target.casefold()]
    found = named(project_sessions(background, root)) or named(background)
    if len(found) == 1:
        return found[0], None
    if found:
        return None, 'several background sessions are named “%s”: %s. Name it by its id, or with --in <its folder>' % (
            target, ', '.join('%s (%s)' % (s['id'], s['cwd']) for s in found))
    if any(s.get('name') == target for s in sessions):
        return None, '“%s” is a regular session: ccc tell reaches background sessions only' % target
    return None, 'no background session is named “%s”' % target


def tell_status(folder, rid, state, reason=''):
    write_key_lines(os.path.join(folder, rid + '.status'), [('format', FORMAT), ('state', state), ('reason', reason), ('at', now_ms())])


# At most this many requests a minute and an hour reach one session, counted by their status files (<at>-<pid>.status,
# kept a day), so that a script gone wrong can't flood it: the rest are refused, saying when to try again
TELL_PER_MINUTE = 6
TELL_PER_HOUR = 60
# How long --wait waits by default, in seconds
TELL_WAIT = 300


def tell_too_many(here, name, now):
    try:
        times = [int(m.group(1)) for m in (re.match(r'^(\d+)-\d+\.status$', n) for n in os.listdir(here)) if m]
    except OSError:
        return None
    for limit, span, words in ((TELL_PER_MINUTE, 60000, 'minute'), (TELL_PER_HOUR, 3600000, 'hour')):
        recent = sorted(t for t in times if 0 <= now - t < span)
        if len(recent) >= limit:
            wait = max(1, -(-(recent[-limit] + span - now) // 1000))
            return '“%s” was handed %d requests in the last %s, the most ccc tell gives one session (%d a minute, %d an hour): try again in %d s' % (
                name, len(recent), words, TELL_PER_MINUTE, TELL_PER_HOUR, wait)
    return None


def tell(argv):
    folder, words, wait = os.getcwd(), list(argv), None
    while words and words[0].startswith('--'):
        flag = words.pop(0)
        if flag == '--in' and words:
            folder = words.pop(0)
        elif flag == '--wait':
            wait = TELL_WAIT
        elif flag.startswith('--wait=') and re.match(r'^\d+(\.\d+)?$', flag[7:]):
            wait = float(flag[7:])
        else:
            words = []
    if not words:
        say('usage: ccc tell [--in <folder>] [--wait[=<seconds>]] <name|id> "text"   (or - to read the text from stdin)')
        return 2
    target, text = words[0], ' '.join(words[1:])
    if text == '-' or (not text and not sys.stdin.isatty()):
        text = sys.stdin.read()
    if not text.strip():
        say('refused: no text (ccc tell <name|id> "text")')
        return 2
    if len(text.encode('utf-8')) > TELL_MAX_BYTES:
        say('refused: longer than 4 KB. Send a pointer instead (a file path, an id) and let the session read it')
        return 1
    sessions = list_sessions()
    if sessions is None:
        say("refused: couldn't read the session list (claude agents --json)")
        return 1
    s, why = find_tell_target(sessions, target, folder)
    if not s:
        say('refused: %s' % why)
        return 1
    name, ref = title_of(s), s['id']
    here = os.path.join(DATA, 'tell', ref)
    if not os.path.isfile(os.path.join(here, 'allow')):
        say('refused: “%s” doesn\'t take text from ccc tell: run /sessions tell on in it first' % name)
        return 1
    now = now_ms()
    if is_live(s) and heartbeat_status(read_heartbeat(s['sessionId']), s.get('pid'), now) != 'ok':
        say("refused: “%s”'s panel isn't running, or runs another version of the sessions mod: restart it (u)" % name)
        return 1
    too_many = tell_too_many(here, name, now)
    if too_many:
        say('refused: %s' % too_many)
        return 1
    rid = '%d-%d' % (now, os.getpid())
    os.makedirs(here, exist_ok=True)
    temporary = os.path.join(here, '.%s.txt' % rid)
    with open(temporary, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(temporary, os.path.join(here, rid + '.txt'))
    tell_status(here, rid, 'queued', 'it goes as a turn of its own when “%s” is idle' % name)
    write_key_lines(os.path.join(here, rid + '.req'), [('format', FORMAT), ('from', caller_name()), ('at', now)])
    status = os.path.join(here, rid + '.status')
    if not is_live(s):
        # Stopped: a running session's mod wakes it, if the rules allow (retired for being idle)
        others = [x for x in sessions if x['sessionId'] != s['sessionId'] and is_live(x)
                  and heartbeat_status(read_heartbeat(x['sessionId']), x.get('pid'), now) == 'ok']
        homes = session_homes(others + [s])
        answer = ask_helpers(sorted(others, key=lambda x: not in_project(homes[x['sessionId']], homes[s['sessionId']], HOME)), 'wake', ref=ref)
        if not answer or answer.get('state') not in ('running', 'queued'):
            reason = answer.get('reason') if answer else 'it is stopped, and no session with a running panel answered to wake it'
            for ending in ('.req', '.txt'):
                try:
                    os.remove(os.path.join(here, rid + ending))
                except OSError:
                    pass
            tell_status(here, rid, 'refused', reason)
        elif parse_key_lines(read_text(status)).get('state') == 'queued':
            tell_status(here, rid, 'queued', '%s; it goes once its panel is up and it is idle' % (answer.get('reason') or 'it was woken'))
    # What its mod says (delivered, held, refused): within 2 s, or with --wait until it says it or the time is up
    deadline = time.time() + (wait if wait is not None else 0 if not is_live(s) else 2)
    while time.time() < deadline and parse_key_lines(read_text(status)).get('state') == 'queued':
        time.sleep(0.2 if wait is not None else 0.1)
    k = parse_key_lines(read_text(status))
    state = k.get('state') or 'queued'
    late = ' (still queued after %g s)' % wait if wait is not None and state == 'queued' else ''
    say('%s%s%s' % (state, ': %s' % k['reason'] if k.get('reason') else '', late))
    say('status file: %s' % status)
    if state == 'refused':
        return 1
    if wait is None or state == 'delivered':
        return 0
    return 3 if state == 'held' else 4


# --- ccc section ---------------------------------------------------------------------------------------------------
#
# ccc section [--session NAME|ID] [TITLE | -] puts a session in one of the person's sections from the shell, the same
# way /sessions section does in the session: the section me:<slug> is made if needed, the person's choice wins over any
# plugin's, and - takes it out. The session is the one this folder's project shows in a window (its viewer, or a regular
# session's own terminal), or the one --session names (its id, or its name in this folder's project). Without a title
# it says which section it's in. It writes <data>/sections.json, the person's data with its own version
# (sectionsFormat), under the lock the mods take (sections.json.lock), keeping the fields it doesn't know; the panels
# draw it on their next refresh.

# slugOf in state.ts: "Big renders!" -> "big-renders"
def slug_of(title):
    t = unicodedata.normalize('NFD', title.lower())
    t = re.sub(r'[̀-ͯ]', '', t)
    t = re.sub(r'[^a-z0-9]+', '-', t)
    return re.sub(r'^-+|-+$', '', t)[:40].rstrip('-')


# parseSectionsFile in state.ts: the file, or why it can't be used (a newer one is never read as this one)
def read_sections(path):
    if not os.path.exists(path):
        return {'sectionsFormat': SECTIONS_FORMAT, 'sections': [], 'members': {}}, None
    try:
        with open(path, encoding='utf-8') as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None, "sections.json isn't valid JSON: fix it or remove it"
    if not isinstance(d, dict):
        return None, "sections.json isn't an object: fix it or remove it"
    try:
        version = float(d.get('sectionsFormat'))
    except (TypeError, ValueError):
        version = 0
    if version > SECTIONS_FORMAT:
        return None, 'sections.json is from a newer sessions (sectionsFormat %s): update the plugin' % d.get('sectionsFormat')
    if version != SECTIONS_FORMAT:
        return None, 'sections.json has no sectionsFormat %d: fix it or remove it' % SECTIONS_FORMAT
    d['sections'] = d['sections'] if isinstance(d.get('sections'), list) else []
    d['members'] = d['members'] if isinstance(d.get('members'), dict) else {}
    return d, None


def section_title(d, section_id):
    for s in d['sections']:
        if isinstance(s, dict) and s.get('id') == section_id and isinstance(s.get('title'), str):
            return s['title']
    return None


# personAssign in state.ts (with setMember and dropEmptyPersonSections): the file with the session in the person's
# section of that title (made if needed, order 100), or out of any (None); or why not
def person_assign(d, ref, title):
    members = dict(d['members'])
    if title is None:
        members.pop(ref, None)
        section = None
        sections = list(d['sections'])
    else:
        clean = ' '.join(title.split())
        slug = slug_of(clean)
        if not slug:
            return None, None, 'A section title needs a letter or a digit'
        if len(clean) > 60:
            return None, None, 'A section title is up to 60 characters'
        sid = 'me:' + slug
        existing = section_title(d, sid)
        section = {'id': sid, 'title': existing if existing is not None else clean, 'order': 100, 'owner': 'person'}
        sections = list(d['sections']) if existing is not None else list(d['sections']) + [dict(section)]
        kept = {k: v for k, v in (members.get(ref) or {}).items() if k != 'parent'} if isinstance(members.get(ref), dict) else {}
        members[ref] = dict(kept, section=sid, by='person')
    used = {m.get('section') for m in members.values() if isinstance(m, dict)}
    sections = [s for s in sections if not (isinstance(s, dict) and isinstance(s.get('id'), str) and s['id'].startswith('me:') and s['id'] not in used)]
    return dict(d, sections=sections, members=members), section, None


# The lock the mods take to change sections.json (withLock in register.tsx): a folder, stale after 5 s
def with_sections_lock(path, body):
    lock = path + '.lock'
    for _ in range(40):
        try:
            os.mkdir(lock)
        except FileExistsError:
            try:
                if time.time() - os.stat(lock).st_mtime > 5:
                    os.rmdir(lock)
            except OSError:
                pass
            time.sleep(0.05)
            continue
        try:
            return body()
        finally:
            try:
                os.rmdir(lock)
            except OSError:
                pass
    return 'busy'


def section_target(sessions, rows, name, root):
    if name:
        if re.match(r'^[0-9a-f]{8}$', name):
            for s in sessions:
                if s.get('id') == name:
                    return s, None
        for test in (lambda s: s.get('name') == name, lambda s: str(s.get('name') or '').casefold() == name.casefold()):
            found = [s for s in rows if test(s)]
            if found:
                return found[0], None
        return None, 'no session is named “%s” in %s' % (name, root)
    w = read_windows()
    shown = [s for s in rows if (s.get('id') and w['by_id'].get(s['id'])) or (s.get('kind') != 'background' and is_live(s) and str(s.get('pid')) in w['by_pid'])]
    if len(shown) == 1:
        return shown[0], None
    if not shown:
        return None, 'no window shows a session of %s: name it with --session <name|id>' % root
    return None, 'windows show several sessions of %s (%s): name one with --session <name|id>' % (root, ', '.join('“%s”' % title_of(s) for s in shown))


def section(argv):
    words, name = list(argv), None
    if '--session' in words:
        i = words.index('--session')
        if i + 1 >= len(words):
            say('usage: ccc section [--session <name|id>] [<title> | -]')
            return 2
        name = words[i + 1]
        words = words[:i] + words[i + 2:]
    title = ' '.join(words).strip()
    sessions = list_sessions()
    if sessions is None:
        say("Couldn't read the session list (claude agents --json)")
        return 1
    root = project_root(os.path.realpath(os.getcwd()))
    rows = project_sessions(sessions, root)
    s, why = section_target(sessions, rows, name, root)
    if not s:
        say(why)
        return 1
    ref = s['id'] if isinstance(s.get('id'), str) and s['id'] else 'sid:' + s['sessionId']
    who = '“%s”' % title_of(s)
    path = os.path.join(DATA, 'sections.json')
    if not title:
        d, problem = read_sections(path)
        if problem:
            say(problem)
            return 1
        m = d['members'].get(ref) if isinstance(d['members'].get(ref), dict) else None
        t = section_title(d, m.get('section')) if m else None
        if t is None:
            say("%s isn't in a section. ccc section <title> puts it in one of yours, ccc section - takes it out" % who)
        else:
            say('%s is in “%s”%s' % (who, t, '' if m.get('by') == 'person' else ' (put there by %s)' % m.get('by')))
        return 0

    def change():
        d, problem = read_sections(path)
        if problem:
            return problem
        out, sec, problem = person_assign(d, ref, None if title == '-' else title)
        if problem:
            return problem
        os.makedirs(DATA, exist_ok=True)
        temporary = '%s.ccc-%d.tmp' % (path, os.getpid())
        with open(temporary, 'w', encoding='utf-8') as f:
            f.write(json.dumps(out, indent=2, ensure_ascii=False) + '\n')
        os.replace(temporary, path)
        return sec
    os.makedirs(DATA, exist_ok=True)
    result = with_sections_lock(path, change)
    if result == 'busy':
        say('Another session is changing the sections: try again')
        return 1
    if isinstance(result, str):
        say(result)
        return 1
    ring('sections')
    say('%s is in “%s” now' % (who, result['title']) if result else '%s is in no section now' % who)
    return 0


# A bell (<data>/bell/<name>, hooks/watch.ts): the panels, which watch that folder, read again what it names
def ring(name):
    try:
        write_key_lines(os.path.join(DATA, 'bell', name), [('format', FORMAT), ('from', 'ccc'), ('at', now_ms())])
    except OSError:
        pass


# --- ccc tidy ------------------------------------------------------------------------------------------------------
#
# ccc tidy [--here] [--pinned] [--days N] [--list] lists the sessions of every folder (--here: of this folder's project,
# by the root ccc uses) from `claude agents --json --all`, and ends the ones the person picks by number: a stopped one is
# removed from the list (claude rm), an idle background one is stopped and removed (claude stop, then claude rm). Never
# offered, each with why: a session that works or waits for him, one with tasks in the background, one a window shows,
# a pinned one (unless --pinned) and a regular one. Nothing is done without a pick, running sessions need a second yes,
# and each one is checked again just before it's stopped. --days N offers only the stopped sessions last used more than
# N days ago (their transcript's time; without one, when they started); --list prints the list and asks nothing. It
# reads, never writes: pins.json and each job's state.json in the service's folder (JOBS), the registry file of a running
# session for how long it's been idle (REGISTRY), when each stopped session's transcript was last written (PROJECTS),
# the service's log for the stopped ones that ended with the service, marked as such (DAEMON_LOG), ps for the windows.
# Exits 0 when it ran, picked or not; 1 when the list can't be read or a claude stop or rm failed; 2 for usage.

TIDY_USAGE = 'usage: ccc tidy [--here] [--pinned] [--days <n>] [--list]'


def read_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# The pinned sessions' short ids (pins.json: Ctrl+T in claude agents writes it, and the mod for Remote Control): an
# empty set without the file; None when it isn't a list of ids (then any session may be pinned)
def read_pins():
    path = os.path.join(JOBS, 'pins.json')
    if not os.path.exists(path):
        return set()
    d = read_json(path)
    if not isinstance(d, list) or not all(isinstance(x, str) for x in d):
        return None
    return set(d)


# A background session's state in the service's folder (its tasks, its Remote Control), or None
def job_state(short):
    if not re.match(r'^[A-Za-z0-9_-]+$', short or ''):
        return None
    d = read_json(os.path.join(JOBS, short, 'state.json'))
    return d if isinstance(d, dict) else None


def number(x):
    if isinstance(x, bool):
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


# realTasks in state.ts: what a session runs in the background beside its turn (an artifact watch isn't work), as
# (count, kinds); none known is none
def real_tasks(job):
    flight = (job or {}).get('inFlight')
    total = number(flight.get('tasks')) if isinstance(flight, dict) else None
    if total is None:
        return 0, []
    drainable = number(flight.get('drainableMonitors')) or 0
    kinds = []
    for k in flight.get('kinds') if isinstance(flight.get('kinds'), list) else []:
        if str(k) not in kinds and (str(k) != 'artifact_watch' or drainable == 0):
            kinds.append(str(k))
    return max(0, int(total - drainable)), kinds


# Since when a running session has been idle: statusUpdatedAt in Claude's registry file of its process, when that file
# is still its own and says idle (claude agents --json doesn't give it)
def idle_since(s):
    pid = s.get('pid')
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    d = read_json(os.path.join(REGISTRY, '%d.json' % pid))
    if not isinstance(d, dict) or d.get('sessionId') != s['sessionId'] or d.get('status') != 'idle':
        return None
    t = number(d.get('statusUpdatedAt'))
    return t if t and t > 0 else None


def span(ms):
    s = int(max(0, ms) // 1000)
    if s < 60:
        return '%d s' % s
    if s < 3600:
        return '%d min' % (s // 60)
    if s < 48 * 3600:
        return '%d h' % (s // 3600)
    return '%d d' % (s // 86400)


def started_ago(s, now):
    t = number(s.get('startedAt'))
    return 'started %s ago' % span(now - t) if t else 'start time unknown'


# Each session's transcript, <projects>/<folder>/<sessionId>.jsonl, and when it was last written (ms). Found by its name
# in every folder, one listing of each for all the sessions at once: a folder's name is the project's path with each
# character other than a letter or a digit written as -, which can't be read back, and Claude moves the file to another
# folder when the session moves (/cd, a worktree). {sessionId: (path, ms)}, the newest file when there are two; a
# session missing has no transcript
def transcripts(session_ids):
    wanted = {sid + '.jsonl': sid for sid in session_ids if re.match(r'^[A-Za-z0-9-]+$', sid or '')}
    found = {}
    if not wanted:
        return found
    try:
        with os.scandir(PROJECTS) as entries:
            folders = [e.path for e in entries if e.is_dir()]
    except OSError:
        return found
    for folder in folders:
        try:
            names = os.listdir(folder)
        except OSError:
            continue
        for name in wanted.keys() & set(names):
            path = os.path.join(folder, name)
            try:
                t = os.stat(path).st_mtime * 1000
            except OSError:
                continue
            if t >= found.get(wanted[name], ('', -1))[1]:
                found[wanted[name]] = (path, t)
    return found


# When each session was last used: the modification time of its transcript (transcripts), in ms. {sessionId: ms}
def last_used(session_ids):
    return {sid: t for sid, (_, t) in transcripts(session_ids).items()}


# The cwd of a transcript's first row that has one: where its session started (the rows after a move carry the new
# folder, and the file moves, but the first row stays); '' without one (usage.py's first_cwd)
def first_cwd(path):
    try:
        with open(path, 'rb') as f:
            for n, line in enumerate(f):
                if b'"cwd":"' in line:
                    try:
                        cwd = json.loads(line).get('cwd')
                    except (ValueError, AttributeError):
                        return ''
                    return cwd if isinstance(cwd, str) and cwd.startswith('/') else ''
                if n >= 1000:
                    break
    except OSError:
        pass
    return ''


# A stopped session's time: when it was last used (its transcript), else when it started, saying why
def stopped_ago(s, used, now):
    if used:
        return 'last used %s ago' % span(now - used)
    return "%s (its transcript wasn't found)" % started_ago(s, now)


# stopLog in state.ts: from the background service's log (its last 4000 lines, as the mod reads it), why each stopped
# session stopped (retire: the service retired it; settled with no retire before: its process ended, killed by a claude
# stop or by itself), when each last started (claimed-spare, spawned: that clears its stop), and when the service found
# its workers dead (adopt: … dead=N, at its next start). Nothing when the log can't be read
LOG_EVENT = re.compile(r'^\[([^\]]+)\] \[bg\] bg (retire|settled|claimed-spare|spawned) ([0-9a-f]{8})\b(.*)$')
LOG_ADOPT = re.compile(r'^\[([^\]]+)\] \[bg\] bg adopt: .*\bdead=(\d+)')


def log_time(text):
    try:
        return datetime.datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp() * 1000
    except ValueError:
        return 0


def stop_log(lines):
    reasons, started, deaths = {}, {}, []
    for line in lines:
        line = line.rstrip('\n')
        m = LOG_ADOPT.match(line)
        if m:
            if int(m.group(2)) > 0:
                deaths.append(log_time(m.group(1)))
            continue
        m = LOG_EVENT.match(line)
        if not m:
            continue
        at, event, sid, rest = log_time(m.group(1)), m.group(2), m.group(3), m.group(4)
        if event == 'retire':
            reasons[sid] = 'low-memory' if re.search(r'\[low memory', rest) else 'idle'
        elif event == 'settled':
            reasons.setdefault(sid, 'stopped' if re.match(r'^\s*\(killed\)', rest) else 'ended')
        else:
            reasons.pop(sid, None)
            started[sid] = at
    return reasons, started, deaths


def read_stop_log():
    try:
        with open(DAEMON_LOG, encoding='utf-8', errors='replace') as f:
            return stop_log(collections.deque(f, maxlen=4000))
    except OSError:
        return {}, {}, []


# diedWithService in state.ts: a stopped background session ended with the background service when nothing of its own
# came after it last ran (no retire, no end of its process: a claude stop's is the person's) and the service found
# workers dead at or after that; when: the first such death. The mod also leaves out one the person stopped from a
# panel once the log no longer shows that stop (it keeps it in Claude's store, which ccc doesn't read): here it's a
# mark beside the session, nothing is done with it
def died_with_service(reason, last_run, deaths):
    if reason or not last_run or last_run <= 0:
        return None
    after = [t for t in deaths if t >= last_run]
    return min(after) if after else None


# The stopped background sessions that ended with the service: {sessionId: when}. When each one last ran: its last start
# in the log, or its mod's last heartbeat
def ended_with_service(sessions):
    stopped = [s for s in sessions if s.get('kind') == 'background' and not s.get('pid') and s.get('id')]
    if not stopped:
        return {}
    reasons, started, deaths = read_stop_log()
    if not deaths:
        return {}
    out = {}
    for s in stopped:
        beat = read_heartbeat(s['sessionId'])
        runs = [t for t in (started.get(s['id']), beat['at'] if beat else None) if t]
        at = died_with_service(reasons.get(s['id']), max(runs) if runs else None, deaths)
        if at is not None:
            out[s['sessionId']] = at
    return out


# clockText in state.ts: a time of day, local ("14:05"), with its day when it isn't today's ("14:05 on Oct 30")
MONTHS = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')


def clock_text(ms, now):
    at, today = time.localtime(ms / 1000), time.localtime(now / 1000)
    hm = '%02d:%02d' % (at.tm_hour, at.tm_min)
    if (at.tm_year, at.tm_yday) == (today.tm_year, today.tm_yday):
        return hm
    return '%s on %s %d' % (hm, MONTHS[at.tm_mon - 1], at.tm_mday)


# What ccc tidy may do with a session, and the words for it: ('stopped', when) it can be removed, ('running', when) it
# can be stopped and removed, ('kept', why) it's never offered. windows: read_windows(); pins: read_pins(); job: its
# job_state(); pinned_ok: --pinned; used: when it was last used (last_used), if known; ended: when it ended with the
# background service (ended_with_service), if it did
def tidy_verdict(s, windows, pins, job, pinned_ok, now, used=None, ended=None):
    sid = s.get('id')
    if s.get('kind') != 'background':
        return 'kept', 'a regular session: /exit it in its window'
    if not sid:
        return 'kept', "no id: claude stop and claude rm can't name it"
    shown = windows['by_id'].get(sid, [])
    where = 'shown in a window now (%s)' % ', '.join(t.replace('/dev/', '') for t in shown)
    remote = bool(s.get('pid') and job and isinstance(job.get('bridgeSessionId'), str) and job['bridgeSessionId'])
    # pinned: why a pinned one is left alone; note: what an offered one says it is (--pinned)
    pinned, note = None, ''
    if pins is None and not pinned_ok:
        pinned = "pins.json can't be read, so it may be pinned: --pinned to offer it"
    elif pins is not None and sid in pins:
        note = ' · pinned, Remote Control on' if remote else ' · pinned'
        if not pinned_ok:
            pinned = 'pinned: --pinned to offer it'
            if s.get('pid'):
                pinned = ('pinned, Remote Control on: turn off Remote Control, or --pinned to offer it' if remote
                          else 'pinned: unpin it (Ctrl+T in claude agents), or --pinned to offer it')
    if not s.get('pid'):
        if shown:
            return 'kept', where
        if pinned:
            return 'kept', pinned
        why = ' · ended with the background service at %s' % clock_text(ended, now) if ended else ''
        return 'stopped', stopped_ago(s, used, now) + why + note
    status = s.get('status')
    if status == 'busy':
        return 'kept', 'busy: never stopped while it works'
    if status == 'waiting':
        return 'kept', 'waiting for you (a question or a permission)'
    if status != 'idle':
        return 'kept', 'running, its status unknown'
    count, kinds = real_tasks(job)
    if count:
        return 'kept', 'idle, but %s in the background%s' % (
            '1 task runs' if count == 1 else '%d tasks run' % count, ' (%s)' % ', '.join(kinds) if kinds else '')
    if shown:
        return 'kept', where
    if pinned:
        return 'kept', pinned
    since = idle_since(s)
    return 'running', ('idle %s' % span(now - since) if since else 'idle, %s' % started_ago(s, now)) + note


# A folder with the home folder as ~ (as it's written, or as its real path: the list has real paths)
def short_path(p):
    for home in (HOME, os.path.realpath(HOME) if HOME else ''):
        if home and home != '/' and (p == home or p.startswith(home + '/')):
            return '~' + p[len(home):]
    return p


def clip(text, width, left=False):
    if len(text) <= width:
        return text
    return '…' + text[-(width - 1):] if left else text[:width - 1] + '…'


# The inventory: the sessions to offer, numbered (stopped first, used longest ago first; then idle running ones, idle
# longest first), the ones left alone with why, and how many stopped ones --days left out. used: last_used(); ended:
# ended_with_service()
def tidy_inventory(sessions, windows, pins, pinned_ok, days, now, used, ended=None):
    stopped, running, kept, recent = [], [], [], 0
    for s in sessions:
        verdict, words = tidy_verdict(s, windows, pins, job_state(s.get('id')), pinned_ok, now, used.get(s['sessionId']),
                                      (ended or {}).get(s['sessionId']))
        item = {'session': s, 'group': verdict, 'words': words}
        if verdict == 'stopped':
            # When it was last used, or else when it started
            item['at'] = used.get(s['sessionId']) or number(s.get('startedAt'))
            if days is not None and (not item['at'] or now - item['at'] <= days * 86400000):
                recent += 1
                continue
            stopped.append(item)
        elif verdict == 'running':
            running.append(item)
        else:
            kept.append(item)
    stopped.sort(key=lambda i: i['at'] or 0)
    running.sort(key=lambda i: idle_since(i['session']) or number(i['session'].get('startedAt')) or 0)
    kept.sort(key=lambda i: (i['session']['cwd'], title_of(i['session']).casefold()))
    for n, item in enumerate(stopped + running, 1):
        item['n'] = n
    return {'stopped': stopped, 'running': running, 'kept': kept, 'recent': recent}


def tidy_print(inv, heading, days, windows, pinned_ok):
    rows = inv['stopped'] + inv['running'] + inv['kept']
    width = len(str(len(inv['stopped']) + len(inv['running'])))
    names = min(32, max([len(title_of(i['session'])) for i in rows] or [0]))
    folders = min(48, max([len(short_path(i['session']['cwd'])) for i in rows] or [0]))

    def line(item):
        n = str(item['n']).rjust(width) if 'n' in item else ' ' * width
        folder = clip(short_path(item['session']['cwd']), folders, left=True).ljust(folders)
        say('  %s%s%s  %s  %s%s  %s%s' % (BOLD, n, RESET, clip(title_of(item['session']), names).ljust(names), DIM, folder, item['words'], RESET))
    say('%sSessions · %s%s' % (DIM, heading, RESET))
    if not rows and not inv['recent']:
        say('No sessions.')
        return
    if inv['stopped'] or inv['recent']:
        say('Stopped (no process: a list entry and its conversation on disk) · remove')
        for item in inv['stopped']:
            line(item)
        if inv['recent']:
            say('  %s%d more stopped, used in the last %g days (--days %g)%s' % (DIM, inv['recent'], days, days, RESET))
    if inv['running']:
        say('Running in the background, idle%s · stop and remove' % ('' if pinned_ok else ', not pinned'))
        for item in inv['running']:
            line(item)
    if inv['kept']:
        say('Left alone')
        for item in inv['kept']:
            line(item)
    if windows['views']:
        say('%sAn agent view is open (%s): a session open in it doesn\'t count as shown in a window.%s' % (
            DIM, ', '.join(sorted(t.replace('/dev/', '') for t in windows['views'])), RESET))


# A pick: numbers and ranges (1 3-5), s for every stopped one. The numbers picked, or None and why not
def parse_pick(text, count, stopped):
    picked = set()
    for word in re.split(r'[\s,]+', text.strip()):
        if not word:
            continue
        if word.lower() == 's':
            if not stopped:
                return None, 's: no stopped session is offered'
            picked.update(range(1, stopped + 1))
            continue
        m = re.match(r'^(\d+)(?:-(\d+))?$', word)
        if not m:
            return None, '%s: not a number or a range' % word
        a, b = sorted((int(m.group(1)), int(m.group(2) or m.group(1))))
        if a < 1 or b > count:
            return None, '%s: the numbers go from 1 to %d' % (word, count)
        picked.update(range(a, b + 1))
    return sorted(picked), None


def cli_failure(code, out, err):
    text = (err or '').strip() or (out or '').strip()
    return text.replace('\n', '\n      ') if text else 'claude exited with %d' % code


def tidy_result(item, outcome):
    say('  %s%s%s  %s  %s' % (BOLD, item['n'], RESET, title_of(item['session']), outcome))


# Acts on one picked session, on what it is now (fresh: the list, windows and pins just read). True unless the list
# couldn't be read again or a claude stop or rm failed
def tidy_act(item, fresh, pinned_ok):
    rows, windows, pins = fresh
    if rows is None:
        tidy_result(item, "skipped: couldn't read the session list again")
        return False
    s = next((x for x in rows if x['sessionId'] == item['session']['sessionId']), None)
    if not s:
        tidy_result(item, 'skipped: it left the list meanwhile')
        return True
    verdict, words = tidy_verdict(s, windows, pins, job_state(s.get('id')), pinned_ok, now_ms())
    if verdict == 'kept':
        tidy_result(item, 'skipped: %s' % words)
        return True
    if verdict == 'running' and item['group'] == 'stopped':
        tidy_result(item, "skipped: it's running again")
        return True
    if verdict == 'running':
        code, out, err = run([CLAUDE, 'stop', s['id']], timeout=60)
        if code != 0:
            tidy_result(item, 'failed: %s' % cli_failure(code, out, err))
            return False
    code, out, err = run([CLAUDE, 'rm', s['id']], timeout=60)
    if code != 0:
        tidy_result(item, '%s: %s' % ('stopped, but not removed' if verdict == 'running' else 'failed', cli_failure(code, out, err)))
        return False
    if verdict == 'running':
        tidy_result(item, 'stopped and removed')
    else:
        tidy_result(item, 'removed%s' % (' (it had stopped meanwhile)' if item['group'] == 'running' else ''))
    return True


def tidy_fresh():
    return list_sessions(), read_windows(), read_pins()


def tidy(argv):
    here = pinned_ok = only_list = False
    days = None
    words = list(argv)
    while words:
        flag = words.pop(0)
        value = None
        if flag.startswith('--days='):
            flag, value = '--days', flag[7:]
        elif flag == '--days':
            value = words.pop(0) if words else ''
        if flag == '--here':
            here = True
        elif flag == '--pinned':
            pinned_ok = True
        elif flag == '--list':
            only_list = True
        elif flag == '--days' and re.match(r'^\d+(\.\d+)?$', value or ''):
            days = float(value)
        elif flag in ('-h', '--help'):
            say(TIDY_USAGE)
            return 0
        else:
            say(TIDY_USAGE)
            return 2
    sessions = list_sessions()
    if sessions is None:
        say("Couldn't read the session list (claude agents --json --all)")
        return 1
    now = now_ms()
    heading = 'every folder'
    if here:
        root = project_root(os.path.realpath(os.getcwd()))
        sessions = project_sessions(sessions, root)
        heading = os.path.basename(root) or root
    windows = read_windows()
    used = last_used([s['sessionId'] for s in sessions if not s.get('pid')])
    inv = tidy_inventory(sessions, windows, read_pins(), pinned_ok, days, now, used, ended_with_service(sessions))
    tidy_print(inv, heading, days, windows, pinned_ok)
    offered = inv['stopped'] + inv['running']
    if only_list:
        return 0
    if not offered:
        if inv['kept']:
            say('Nothing to offer: each session above is left alone for the reason beside it.')
        return 0
    hint = 'numbers or ranges (e.g. 1 3-5)%s, Enter = nothing' % (', s = every stopped one' if inv['stopped'] else '')
    say('%s%s%s' % (DIM, hint, RESET))
    while True:
        try:
            text = input('Remove which? ').strip()
        except (EOFError, KeyboardInterrupt):
            say()
            text = ''
        if not text:
            say('Nothing changed.')
            return 0
        numbers, problem = parse_pick(text, len(offered), len(inv['stopped']))
        if problem:
            say('%s%s%s' % (DIM, problem, RESET))
            continue
        break
    picked = [offered[n - 1] for n in numbers]
    running = [i for i in picked if i['group'] == 'running']
    declined = False
    if running:
        for item in running:
            say('  %s%s%s  %s  %s%s  %s%s' % (BOLD, item['n'], RESET, title_of(item['session']), DIM, short_path(item['session']['cwd']), item['words'], RESET))
        declined = not ask_yes('Stop and remove %s?' % ('this running session' if len(running) == 1 else 'these %d running sessions' % len(running)), False)
    ok = True
    try:
        # The stopped ones on one fresh look; each running one on its own, just before it's stopped
        fresh = tidy_fresh() if any(i['group'] == 'stopped' for i in picked) else None
        for item in picked:
            if item['group'] == 'running' and declined:
                tidy_result(item, 'skipped: not confirmed')
                continue
            ok = tidy_act(item, fresh if item['group'] == 'stopped' else tidy_fresh(), pinned_ok) and ok
    except KeyboardInterrupt:
        say()
        say('Interrupted: nothing more was done (the one it was on may be stopped and still in the list).')
        return 1
    return 0 if ok else 1


# --- watching files: the window's watcher and the mod's own watch ---------------------------------------------------
#
# Both sleep in the kernel until a path they watch changes. A watch is armed with the paths to watch (arm: exactly those
# from then on, armed again after each look) and waits (wait) until one of them changes, the time runs out, or the
# process it was told to follow (its parent) ends, which raises Ended (so does its output closing, where it watches that).
# - kqueue (macOS, the BSDs): one descriptor per path. A folder's says entries came or went, but not that bytes reached
#   a file already there (and $.fs.write creates a file first, then writes it), so each file gets its own; a path whose
#   file was replaced (written beside it and renamed over it) gets the new file's. The parent's end is a kernel event too.
# - inotify (Linux): one watch per folder, which reports every change of every file in it (a file is watched through its
#   folder). The parent's end comes through its pidfd (Linux 5.3, Python 3.9), else a look every PARENT_CHECK_S.
# - poll (the window's watcher alone, where neither can be had): a look every POLL_S.

POLL_S = 0.2
PARENT_CHECK_S = 30.0
KQUEUE_NOTES = ('KQ_NOTE_WRITE', 'KQ_NOTE_EXTEND', 'KQ_NOTE_DELETE', 'KQ_NOTE_RENAME')
# Paths that went away between a look and the watch: watched again once they're back
MISSING = (FileNotFoundError, NotADirectoryError, PermissionError)


class Ended(Exception):
    pass


class KqueueWatch:
    def __init__(self, parent=None):
        import select
        self.select = select
        self.kq = select.kqueue()
        self.notes = 0
        for name in KQUEUE_NOTES:
            self.notes |= getattr(select, name)
        self.held = {}  # path: (descriptor, inode)
        if parent:
            # Fails when the parent is gone already
            self.kq.control([select.kevent(parent, select.KQ_FILTER_PROC, select.KQ_EV_ADD | select.KQ_EV_ONESHOT, select.KQ_NOTE_EXIT)], 0)

    def count(self):
        return len(self.held)

    def arm(self, paths):
        s = self.select
        for path in [p for p in self.held if p not in paths]:
            os.close(self.held.pop(path)[0])
        for path in paths:
            try:
                inode = os.stat(path).st_ino
            except OSError:
                inode = None
            held = self.held.get(path)
            if held and held[1] != inode:
                os.close(self.held.pop(path)[0])
                held = None
            if inode is None or held:
                continue
            try:
                fd = os.open(path, getattr(os, 'O_EVTONLY', os.O_RDONLY))
            except MISSING:
                continue
            try:
                self.kq.control([s.kevent(fd, s.KQ_FILTER_VNODE, s.KQ_EV_ADD | s.KQ_EV_CLEAR, self.notes)], 0)
            except OSError:
                os.close(fd)
                continue
            self.held[path] = (fd, os.fstat(fd).st_ino)

    # True when something changed; seconds=None waits for as long as it takes
    def wait(self, seconds):
        events = self.kq.control(None, 64, seconds)
        if any(e.filter == self.select.KQ_FILTER_PROC for e in events):
            raise Ended()
        return bool(events)


class InotifyWatch:
    # IN_MODIFY, IN_CLOSE_WRITE, IN_MOVED_FROM, IN_MOVED_TO, IN_CREATE, IN_DELETE, IN_DELETE_SELF, IN_MOVE_SELF
    MASK = 0x2 | 0x8 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800

    def __init__(self, parent=None, output=None):
        import ctypes
        import select
        self.ctypes = ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        init, self.add, self.rm = libc.inotify_init1, libc.inotify_add_watch, libc.inotify_rm_watch
        init.argtypes, self.add.argtypes, self.rm.argtypes = [ctypes.c_int], [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32], [ctypes.c_int, ctypes.c_int]
        self.fd = init(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), 'inotify_init1 (fs.inotify.max_user_instances?)')
        self.held = {}  # folder: (watch, inode)
        self.poll = select.poll()
        self.poll.register(self.fd, select.POLLIN)
        self.parent, self.pidfd, self.output = parent, None, output
        if parent:
            try:
                self.pidfd = os.pidfd_open(parent)
                self.poll.register(self.pidfd, select.POLLIN)
            except (AttributeError, OSError):
                self.pidfd = None
            if self.pidfd is None and os.getppid() != parent:
                raise Ended()
        # A pipe whose reader is gone reports an error (POLLERR) on its writer's end
        if output is not None:
            self.poll.register(output, 0)

    def count(self):
        return len(self.held)

    def arm(self, paths):
        import errno
        from stat import S_ISDIR
        folders = {}
        for path in paths:
            try:
                st = os.stat(path)
            except OSError:
                continue
            if S_ISDIR(st.st_mode):
                folders[path] = st.st_ino
        for path, (wd, inode) in list(self.held.items()):
            if folders.get(path) != inode:
                self.rm(self.fd, wd)
                del self.held[path]
        for path, inode in folders.items():
            if path in self.held:
                continue
            wd = self.add(self.fd, os.fsencode(path), self.MASK)
            if wd < 0:
                err = self.ctypes.get_errno()
                if err in (errno.ENOENT, errno.ENOTDIR, errno.EACCES):
                    continue
                raise OSError(err, 'inotify_add_watch %s (fs.inotify.max_user_watches?)' % path)
            self.held[path] = (wd, inode)

    def wait(self, seconds):
        end = None if seconds is None else time.time() + seconds
        while True:
            left = None if end is None else max(0.0, end - time.time())
            if self.parent and self.pidfd is None:
                left = PARENT_CHECK_S if left is None else min(left, PARENT_CHECK_S)
            ready = [fd for fd, _ in self.poll.poll(None if left is None else int(left * 1000))]
            if self.parent and (self.pidfd in ready or (self.pidfd is None and os.getppid() != self.parent)):
                raise Ended()
            if self.output is not None and self.output in ready:
                raise Ended()
            if self.fd in ready:
                try:
                    while os.read(self.fd, 65536):
                        pass
                except OSError:
                    pass
                return True
            if end is not None and time.time() >= end:
                return False


class PollWatch:
    def count(self):
        return 0

    def arm(self, paths):
        pass

    def wait(self, seconds):
        time.sleep(POLL_S if seconds is None else min(seconds, POLL_S))
        return True


WATCHES = {'kqueue': KqueueWatch, 'inotify': InotifyWatch, 'poll': PollWatch}


# --- the window's watcher -------------------------------------------------------------------------------------------
#
# launcher.py watch --file FILE --launcher PID [--how kqueue|inotify|poll]: runs beside visor.sh's loop in a window
# opened with ccc, one per window for as long as its launcher (PID, its parent) runs, and ends that window's viewer as
# soon as a panel asks for a switch, so the panel neither looks for the viewer nor closes it: the panel writes the next
# session to FILE (the window's file) with end=1 as its last line, the watcher sends the viewer FILE.showing names (the
# launcher writes it as each viewer starts) a SIGHUP, and the loop opens the next one; what's typed meanwhile is
# dropped (drop_typed). A file with no end=1 (claude respawn's reopen, ccc switching another window, a panel of an older
# version, which closes the viewer itself) is left to the loop, which reads it once the viewer ends.
#
# It watches FILE's folder (FILE appears or goes) and FILE itself while it's there, and besides looks every
# WATCH_PASS_S, in case. --how picks the watch (tests); by default the first one this system has

WATCH_PASS_S = 1.0
# After it ends a viewer, what's typed until the next one takes the terminal is dropped (drop_typed), for this long at most
DROP_S = 2.0


# The window's file asks for its viewer to be ended now: whole (end=1 is its last line) and in this format
def switch_asked(text):
    k = parse_key_lines(text)
    return text.endswith('\n') and k.get('end') == '1' and k.get('format') == str(FORMAT)


# The first watch this system has, armed on the folder and the file; the one named, or an error, when one is named
def folder_watch(folder, path, how=None):
    for name in [how] if how else ['kqueue', 'inotify']:
        try:
            w = WATCHES[name]()
            w.arm([folder, path])
            return w
        except (AttributeError, ImportError, OSError):
            if how:
                raise
    return PollWatch()


# What's typed during a switch is dropped, so a key meant for the panel you're leaving (a second Enter, an arrow)
# never lands in the next session's prompt box: the next viewer (claude attach) takes the terminal (raw) about 0.1 s
# after it starts, and would get every key typed meanwhile. From the moment the launcher puts the terminal in its own
# mode between viewers (canonical, no echo, Enter no line end: stty sane -echo -icrnl, so nothing typed is a whole line
# that the viewer, which reads from its start, could take first) until the next viewer takes it (raw), its input is
# flushed every 2 ms; DROP_S at most. The shell's mode (echo on) is never touched, so the first viewer isn't either.
# tty: this window's terminal, open; None where there's none (tests)
def drop_typed(tty, seconds=DROP_S):
    import termios
    if tty is None:
        return
    end = time.time() + seconds
    dropping = False
    while time.time() < end:
        try:
            flags = termios.tcgetattr(tty)[3]
            if flags & termios.ICANON and not flags & termios.ECHO:
                termios.tcflush(tty, termios.TCIFLUSH)
                dropping = True
            elif dropping:
                return
        except (termios.error, OSError):
            return
        time.sleep(0.002)


def open_terminal():
    try:
        return os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY)
    except OSError:
        return None


def watch(argv):
    import argparse
    import signal
    parser = argparse.ArgumentParser(prog='launcher.py watch')
    parser.add_argument('--file', required=True)
    parser.add_argument('--launcher', type=int, required=True)
    parser.add_argument('--how', choices=sorted(WATCHES))
    args = parser.parse_args(argv)
    folder = os.path.dirname(args.file)
    w = folder_watch(folder, args.file, args.how)
    tty = open_terminal()
    ended = None
    while os.getppid() == args.launcher:
        w.arm([folder, args.file])
        if switch_asked(read_text(args.file)):
            # The viewer the launcher published, from a whole .showing that names this watcher (never a pid read off
            # a file being written). Once per viewer: the file stays until the loop reads it, after the viewer ended
            shown = read_text(args.file + '.showing')
            k = parse_key_lines(shown)
            viewer = k.get('viewer', '') if shown.endswith('\n') and k.get('watcher') == str(os.getpid()) else ''
            if viewer.isdigit() and viewer != ended:
                ended = viewer
                try:
                    os.kill(int(viewer), signal.SIGHUP)
                except OSError:
                    pass
                else:
                    drop_typed(tty)
        w.wait(WATCH_PASS_S)
    return 0


# --- the mod's own watch --------------------------------------------------------------------------------------------
#
# launcher.py watch-paths --how kqueue|inotify [--depth N] PATH...: the file events of a session no classic.SessionStart
# reached (a plugin ahead of sessions sent it on past it, or the session was updated in place), whose Claude watches
# nothing for the mod. Its mod runs one with $.process.spawn over the paths SessionStart would hand Claude (watchPaths in
# watch.ts) and reads its lines as classic.FileChanged: `ready<TAB>how<TAB>pid<TAB>watched` once every watch is armed,
# then `add|change|unlink<TAB>path` for each file that came, changed or went.
#
# Each PATH is a folder (its files and its subfolders' to --depth levels below it) or a file; one that's missing is
# waited for in its folder. After an event it waits SETTLE_S for the rest of a burst, then looks at every file it watches
# (one stat each) and prints what differs from the last look. Which watch to use is the platform's (fileWatch in
# hooks/platform): one that can't be had, or a limit of the system it meets (descriptors for kqueue, which needs one per
# file, raised here to what the system allows; fs.inotify.max_user_instances or max_user_watches), ends it with the
# reason on stderr and exit code 1, and the mod reads on its short timer meanwhile. It ends when its parent (the
# session's process) does, or when it finds its output closed (the mod's loop ended or its module reloaded); and the
# mod ends it when a SessionStart comes and Claude watches the paths itself.

SETTLE_S = 0.02
FILES_WANTED = 10240


# The files under the watched folders and the watched files, {path: (inode, mtime, size)}, and the folders to watch: the
# watched ones and their subfolders to depth, and the folder of a watched file (or folder) that's missing
def path_snapshot(roots, depth):
    files, folders = {}, set()

    def walk(folder, left):
        try:
            entries = list(os.scandir(folder))
        except OSError:
            return
        folders.add(folder)
        for e in entries:
            try:
                st = e.stat(follow_symlinks=False)
                is_dir = e.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if is_dir:
                if left > 0:
                    walk(e.path, left - 1)
            else:
                files[e.path] = (st.st_ino, st.st_mtime_ns, st.st_size)

    for p in roots:
        if os.path.isdir(p):
            walk(p, depth)
            continue
        try:
            st = os.stat(p)
            files[p] = (st.st_ino, st.st_mtime_ns, st.st_size)
        except OSError:
            pass
        if os.path.isdir(os.path.dirname(p)):
            folders.add(os.path.dirname(p))
    return files, folders


def path_changes(old, new):
    out = [('add' if p not in old else 'change', p) for p, sig in sorted(new.items()) if old.get(p) != sig]
    return out + [('unlink', p) for p in sorted(old) if p not in new]


def emit(lines):
    try:
        for fields in lines:
            sys.stdout.write('\t'.join(fields) + '\n')
        sys.stdout.flush()
    except OSError:
        os._exit(0)  # the reader is gone: the mod's loop ended, or its module reloaded


# A descriptor per watched file for kqueue: the soft limit raised as far as the system lets it (a session's own is
# usually high already)
def raise_file_limit():
    try:
        import resource
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        for want in (FILES_WANTED, 4096, 1024):
            if soft < want and (hard == resource.RLIM_INFINITY or hard >= want):
                try:
                    resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
                    return
                except (ValueError, OSError):
                    continue
    except (ImportError, ValueError, OSError):
        pass


def watch_paths(argv):
    import argparse
    parser = argparse.ArgumentParser(prog='launcher.py watch-paths')
    parser.add_argument('--how', choices=('kqueue', 'inotify'), required=True)
    parser.add_argument('--depth', type=int, default=2)
    parser.add_argument('paths', nargs='+')
    args = parser.parse_args(argv)
    roots = [os.path.abspath(p) for p in args.paths]
    parent = os.getppid()
    if parent <= 1:
        return 0
    try:
        if args.how == 'kqueue':
            raise_file_limit()
            w = KqueueWatch(parent)
        else:
            w = InotifyWatch(parent, sys.stdout.fileno())

        # Armed again after every look: a folder or file that came, went or was replaced (renamed over) is watched as
        # it is now (inotify watches the folders alone)
        def arm(files, folders):
            w.arm(set(folders) | (set(files) if args.how == 'kqueue' else set()))

        files, folders = path_snapshot(roots, args.depth)
        arm(files, folders)
        emit([('ready', args.how, str(os.getpid()), str(w.count()))])
        while w.wait(None):
            time.sleep(SETTLE_S)
            w.wait(0)
            new, new_folders = path_snapshot(roots, args.depth)
            arm(new, new_folders)
            if new_folders != folders:
                # What came in a folder before its watch was armed is in a look taken after it
                new, new_folders = path_snapshot(roots, args.depth)
                arm(new, new_folders)
            folders = new_folders
            changes = path_changes(files, new)
            files = new
            if changes:
                emit(changes)
    except Ended:
        return 0
    except (AttributeError, ImportError, OSError) as err:
        sys.stderr.write("launcher.py watch-paths: can't watch with %s: %s\n" % (args.how, err))
        return 1
    except KeyboardInterrupt:
        return 0
    return 0

def main(argv):
    if argv[:1] == ['watch']:
        return watch(argv[1:])
    if argv[:1] == ['watch-paths']:
        return watch_paths(argv[1:])
    if argv[:1] == ['tell']:
        return tell(argv[1:])
    if argv[:1] == ['section']:
        return section(argv[1:])
    if argv[:1] == ['tidy']:
        return tidy(argv[1:])
    import argparse
    parser = argparse.ArgumentParser(prog='launcher.py')
    parser.add_argument('mode', choices=['start', 'pick'])
    parser.add_argument('--tty', default='')
    parser.add_argument('--file', default='')
    parser.add_argument('--new', action='store_true')
    parser.add_argument('--agents', action='store_true')
    parser.add_argument('--exclude', action='append', default=[])
    parser.add_argument('name', nargs='*')
    args = parser.parse_intermixed_args(argv)
    if args.mode == 'pick':
        ctx = context(args.tty, exclude=args.exclude)
        print(json.dumps(summary(decide(ctx, new=args.new, agents=args.agents, name=' '.join(args.name).strip() or None))))
        return 0
    if not args.file:
        say('launcher.py start needs --file')
        return 2
    return start(args, args.tty, args.file)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
