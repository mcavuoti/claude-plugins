#!/usr/bin/env python3
"""What `ccc` opens: the decisions of the sessions launcher (hooks/visor.sh runs this, then the window's loop).

    launcher.py start --tty TTY --file FILE [--new | --agents] [--exclude ID] [NAME...]
    launcher.py pick [--tty TTY] [--new] [NAME...]      the decision only, as JSON (tests and debugging)

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
next), <data>/config (settings the mod mirrors), with <data> = ~/.claude/mods/sessions-data or SESSIONS_DATA_DIR.
Other environment: SESSIONS_CLAUDE (the claude command), SESSIONS_PLUGIN_VERSION and SESSIONS_PLUGIN_SINCE (the
installed plugin, from the ccc command), SESSIONS_START_WAIT (seconds to wait for a new session's mod).
"""
import json
import os
import re
import subprocess
import sys
import time

FORMAT = 1
HEARTBEAT_VERSION = (0, 10, 0)
HEARTBEAT_FRESH_MS = 45000
ORDER_FRESH_MS = 60000
INBOX_FRESH_MS = 30000

HOME = os.environ.get('HOME', '')
DATA = os.environ.get('SESSIONS_DATA_DIR') or os.path.join(HOME, '.claude', 'mods', 'sessions-data')
CLAUDE = os.environ.get('SESSIONS_CLAUDE') or 'claude'
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
# CLAUDE.md, below the top two levels; else this folder
def project_root(cwd):
    d = cwd
    while True:
        if len([p for p in d.split('/') if p]) > 2 and any(os.path.isfile(os.path.join(d, n)) for n in ('AGENTS.md', 'CLAUDE.md')):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return cwd
        d = parent


def in_project(cwd, root, home):
    if cwd == root:
        return True
    if not root or root == '/' or (home and root == home):
        return False
    return cwd.startswith(root + '/')


def run(argv, cwd=None, timeout=30):
    try:
        r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout)
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
    return {'format': int(k['format']) if k['format'].isdigit() else 0, 'pid': pid, 'at': at, 'version': k.get('version', '')}


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


# Which windows show which session, from ps (parseWindows in state.ts): viewers (claude attach <id>), launchers
def parse_windows(ps):
    by_id, clients, launchers = {}, {}, {}
    for line in ps.split('\n'):
        parts = line.split()
        if len(parts) < 3 or parts[1] in ('??', '?', '-'):
            continue
        pid, tty, command = parts[0], '/dev/' + parts[1], ' '.join(parts[2:])
        m = re.match(r'^(\S*/)?claude attach ([0-9a-f]{8})$', command)
        if m:
            by_id.setdefault(m.group(2), []).append(tty)
            clients[tty] = pid
        if re.match(r'^(\S*/)?claude agents( |$)', command):
            clients[tty] = pid
        if re.match(r'^(\S*/)?bash \S*/visor\.sh( |$)', command):
            launchers[tty] = pid
    return {'by_id': by_id, 'clients': clients, 'launchers': launchers}


def read_windows():
    code, out, _ = run(['ps', '-A', '-o', 'pid=,tty=,command='])
    return parse_windows(out if code == 0 else '')


def context(tty, exclude=()):
    cwd = os.path.realpath(os.getcwd())
    root = project_root(cwd)
    now = now_ms()
    sessions = list_sessions()
    rows = [s for s in (sessions or []) if in_project(s['cwd'], root, HOME) and s.get('id') not in exclude]
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


# Asks a session's mod to bring a window forward; waits for its answer. (ok, reason)
def bring(d):
    title = title_of(d['session']) if d.get('session') else ''
    for helper in d.get('helpers') or []:
        reply = os.path.join(DATA, 'replies', '%d-%d' % (os.getpid(), now_ms()))
        os.makedirs(os.path.dirname(reply), exist_ok=True)
        request(helper, 'bring', tty=d['window'], title=title, reply=reply)
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
        if answer.get('result') == 'ok':
            return True, ''
        if answer.get('result'):
            return False, answer.get('reason') or 'it said no'
    return False, 'no session of this project answered (their panels may not be running)'


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


def main(argv):
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
