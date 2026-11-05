#!/usr/bin/env python3
"""The sessions panel's benchmark: the same scenarios against any copy of the plugin, so a change is measured before and
after the same way. README.md in this folder says what each number means and how it's read.

    <python with pyte> bench.py --plugin <copy>/plugins/sessions --folder <trusted test folder> --out result.json
                                [--label TEXT] [--sessions 6] [--scenarios idle,propagation,switch,ccc]
                                [--idle-seconds 120] [--rounds 5] [--warmup 30] [--platform portable|macos]
                                [--model haiku] [--env KEY=VALUE]... [--keep]

It starts the sessions "TEST A", "TEST B", ... in <folder>/mod with the copy loaded inline, and "TEST CTRL" in
<folder>/ctrl without it (the cost of a session with no mod). Every one of them starts from an empty environment, with
its own data folder, an empty folder for Claude's background service (SESSIONS_JOBS_DIR) and an empty daemon log
(SESSIONS_DAEMON_LOG) in a temporary folder, so nothing a test session does (pins, reopen, restarts) can reach a real
session; the panel's notifications are off (notificationsPerDay 0). Terminals are hidden ones (../hidden-terminal.py);
--platform portable (the default) runs the panel's Linux code (SESSIONS_PORTABLE=1), which can't touch a window on a Mac.
--platform macos (the mod's macOS code) only allows idle and propagation, which press no key in a panel: an Enter
there could open a Terminal window.

Afterwards it stops and removes every background session of <folder> (../clean-test-sessions.sh), deletes the
transcripts of the sessions it started, the subfolders it made and the temporary folder; --keep leaves them all.
"""
import argparse
import datetime
import json
import os
import random
import re
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HIDDEN = os.path.join(os.path.dirname(HERE), 'hidden-terminal.py')
CLEAN = os.path.join(os.path.dirname(HERE), 'clean-test-sessions.sh')
sys.path.insert(0, HERE)
import procs  # noqa: E402

HOME = os.environ.get('HOME', '')
REGISTRY = os.path.join(HOME, '.claude', 'sessions')
PROJECTS = os.path.join(HOME, '.claude', 'projects')
FIRST_PROMPT = 'Reply only: ok'
# A turn that keeps the session busy long enough to see it from another panel (the allow rule in its settings lets
# the command run without a question)
BUSY_PROMPT = 'Run the shell command sleep 6 with the Bash tool, then reply only: ok'
LEGEND = ('Attention', 'Working', 'Done', 'Idle', 'Stopped')
LEGEND_COLOURS = ('red', 'blue', 'yellow', 'green', 'gray')


def log(text):
    print('[%s] %s' % (time.strftime('%H:%M:%S'), text), flush=True)


# ---- clean processes ----------------------------------------------------------------------------------------------

def clean_env(extra=None):
    claude = shutil.which('claude') or ''
    dirs = [os.path.dirname(os.path.realpath(claude))] if claude else []
    if claude:
        dirs.insert(0, os.path.dirname(claude))
    dirs += ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    env = {'HOME': HOME, 'USER': os.environ.get('USER', ''), 'PATH': ':'.join(dict.fromkeys(d for d in dirs if d)),
           'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8'}
    env.update(extra or {})
    return env


def clean(argv, extra=None):
    return ['env', '-i'] + ['%s=%s' % kv for kv in clean_env(extra).items()] + list(argv)


def run(argv, cwd=None, timeout=120, extra=None):
    r = subprocess.run(clean(argv, extra), cwd=cwd or '/', capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def agents():
    code, out, _ = run(['claude', 'agents', '--json', '--all'], timeout=60)
    try:
        rows = json.loads(out) if code == 0 else []
    except ValueError:
        rows = []
    return rows if isinstance(rows, list) else []


def registry_status(pid):
    try:
        with open(os.path.join(REGISTRY, '%d.json' % pid)) as f:
            return json.load(f).get('status')
    except (OSError, ValueError, AttributeError):
        return None


def stats(values):
    v = sorted(x for x in values if x is not None)
    if not v:
        return {'n': 0, 'median': None, 'min': None, 'max': None, 'values': []}
    p95 = v[min(len(v) - 1, int(round(0.95 * (len(v) - 1))))]
    return {'n': len(v), 'median': round(statistics.median(v), 3), 'p95': round(p95, 3), 'min': round(v[0], 3),
            'max': round(v[-1], 3), 'values': [round(x, 3) for x in values if x is not None]}


# ---- sessions ------------------------------------------------------------------------------------------------------

class Session:
    def __init__(self, name, cwd, mod, debug_log):
        self.name, self.cwd, self.mod, self.log = name, cwd, mod, debug_log
        self.id = self.session_id = None
        self.pid = None


class Bench:
    def __init__(self, a):
        self.a = a
        self.plugin = os.path.realpath(a.plugin)
        self.folder = os.path.realpath(a.folder)
        self.tmp = tempfile.mkdtemp(prefix='ui-bench.')
        self.data = os.path.join(self.tmp, 'data')
        self.jobs = os.path.join(self.tmp, 'jobs')
        self.daemon_log = os.path.join(self.tmp, 'daemon.log')
        for d in (self.data, self.jobs, os.path.join(self.tmp, 'debug'), os.path.join(self.tmp, 'ht')):
            os.makedirs(d, exist_ok=True)
        open(self.daemon_log, 'a').close()
        self.mod_dir = os.path.join(self.folder, 'mod')
        self.ctrl_dir = os.path.join(self.folder, 'ctrl')
        self.made_dirs = [d for d in (self.mod_dir, self.ctrl_dir) if not os.path.isdir(d)]
        for d in (self.mod_dir, self.ctrl_dir):
            os.makedirs(d, exist_ok=True)
        self.sessions = []
        self.control = None
        self.terminals = []
        self.result = {'label': a.label, 'plugin': self.plugin, 'version': plugin_version(self.plugin),
                       'date': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
                       'platform': a.platform, 'scenarios': {}, 'errors': []}
        try:
            plugins = json.loads(run(['claude', 'plugin', 'list', '--json'])[1] or '[]')
        except ValueError:
            plugins = []
        self.installed = sorted({p['id'] for p in plugins if isinstance(p, dict) and str(p.get('id', '')).split('@')[0] in ('sessions', 'fleet') and not str(p.get('id')).endswith('@inline')})

    # The settings a test session starts with (--settings): the copy inline (or no panel at all), every location the
    # mod acts on pointed into the temporary folder
    def settings(self, mod):
        env = {'SESSIONS_DATA_DIR': self.data, 'SESSIONS_JOBS_DIR': self.jobs, 'SESSIONS_DAEMON_LOG': self.daemon_log}
        if mod:
            env['CLAUDE_CODE_PLUGIN_DIRS'] = self.plugin
        if self.a.platform == 'portable':
            env['SESSIONS_PORTABLE'] = '1'
        for kv in self.a.env:
            k, _, v = kv.partition('=')
            env[k] = v
        enabled = {p: False for p in self.installed}
        enabled['sessions@inline'] = bool(mod)
        return {'env': env, 'enabledPlugins': enabled,
                'pluginConfigs': {'sessions@inline': {'options': {'notificationsPerDay': 0}}},
                'permissions': {'allow': ['Bash(sleep:*)', 'Bash(sleep 6)']}}

    def start(self):
        busy = [r.get('id') for r in agents() if str(r.get('cwd', '')).startswith(self.folder + '/')]
        if busy:
            raise RuntimeError('%s already has sessions (%s): the end of a run removes every one of them' % (self.folder, ', '.join(map(str, busy))))
        log('temporary folder %s' % self.tmp)
        # The token usage the panel shows, read once beforehand as a running machine has it (the first read of a new
        # data folder reads every conversation log)
        usage = os.path.join(self.plugin, 'hooks', 'usage.py')
        if os.path.isfile(usage):
            run(['python3', usage, PROJECTS, os.path.join(self.data, 'usage')], timeout=600)
        names = ['TEST %s' % chr(ord('A') + i) for i in range(self.a.sessions)]
        for name in names + ['TEST CTRL']:
            mod = name != 'TEST CTRL'
            s = Session(name, self.mod_dir if mod else self.ctrl_dir, mod, os.path.join(self.tmp, 'debug', name.replace(' ', '_') + '.log'))
            code, out, err = run(['claude', '--bg', '--model', self.a.model, '--debug-file', s.log, '--settings',
                                  json.dumps(self.settings(mod)), '-n', name, FIRST_PROMPT], cwd=s.cwd, timeout=120)
            m = re.search(r'\b([0-9a-f]{8})\b', out)
            if code != 0 or not m:
                raise RuntimeError('claude --bg for %s failed: %s %s' % (name, out.strip(), err.strip()))
            s.id = m.group(1)
            if mod:
                self.sessions.append(s)
            else:
                self.control = s
            log('started %s (%s)' % (name, s.id))
        everyone = self.sessions + [self.control]
        deadline = time.time() + 240
        while time.time() < deadline:
            rows = {r.get('id'): r for r in agents()}
            for s in everyone:
                r = rows.get(s.id) or {}
                s.pid, s.session_id = r.get('pid'), r.get('sessionId')
            if all(s.pid and (rows.get(s.id) or {}).get('status') == 'idle' for s in everyone) and all(count(s.log, PANE_RENDER) for s in self.sessions):
                break
            time.sleep(2)
        else:
            raise RuntimeError('the test sessions did not all come up idle with their panel drawn within 240 s')
        log('all idle; warming up %d s' % self.a.warmup)
        time.sleep(self.a.warmup)
        self.result['claudeVersion'] = run(['claude', '--version'])[1].strip()
        rows = agents()
        self.result['conditions'] = {
            'sessions': self.a.sessions, 'model': self.a.model, 'os': '%s %s' % (os.uname().sysname, os.uname().release),
            'machine': os.uname().machine, 'cpus': os.cpu_count(), 'loadavg': [round(x, 2) for x in os.getloadavg()],
            'otherSessionsRunning': sum(1 for r in rows if r.get('pid') and not str(r.get('cwd', '')).startswith(self.folder)),
        }

    def by_name(self, letter):
        return next(s for s in self.sessions if s.name == 'TEST %s' % letter)

    # ---- scenarios ---------------------------------------------------------------------------------------------------

    def idle(self, key, viewer):
        x = None
        if viewer:
            x = self.terminal('viewer', ['bash', os.path.join(self.plugin, 'hooks', 'visor.sh'), 'attach', self.by_name('A').id])
            if x.wait(lambda t: t.current() == 'TEST A', timeout=60) is None:
                raise RuntimeError('the viewer of TEST A never showed its panel')
            time.sleep(5)
        roots = os.path.join(self.tmp, 'roots-%s' % key)
        out = os.path.join(self.tmp, 'procs-%s.jsonl' % key)
        everyone = self.sessions + [self.control]
        with open(roots, 'w') as f:
            f.write('\n'.join(str(s.pid) for s in everyone) + '\n')
        sampler = subprocess.Popen([sys.executable, procs.__file__, 'watch', '--roots-file', roots, '--out', out, '--interval', '0.002'])
        time.sleep(1)
        log('%s: %d s' % (key, self.a.idle_seconds))
        cpu0 = {s.name: procs.cpu(s.pid) for s in everyone}
        t0 = time.time()
        time.sleep(self.a.idle_seconds)
        t1 = time.time()
        cpu1 = {s.name: procs.cpu(s.pid) for s in everyone}
        screens = x.count_screens(t0, t1) if x else None
        sampler.send_signal(signal.SIGTERM)
        sampler.wait(timeout=30)
        time.sleep(1)  # the debug logs' last lines
        minutes = (t1 - t0) / 60
        sampled = [json.loads(line) for line in open(out)] if os.path.exists(out) else []
        per, totals = {}, {'paneRenders': 0, 'bandRenders': 0, 'modSpawns': 0, 'modGrandchildren': 0, 'storeWrites': 0, 'fsWrites': 0}
        spawn_cmds, grand_cmds, engine_cmds = {}, {}, {}
        coverage = [0, 0]
        for s in everyone:
            c = debug_counts(s.log, t0, t1)
            mine = [r for r in sampled if r['root'] == s.pid and not r['pre'] and t0 <= r['start'] <= t1]
            by_pid = {r['pid']: r for r in mine}
            mod_pids = set()
            for pid, argv0, nargs in c['spawnList']:
                r = by_pid.get(pid)
                k = command_key(argv0, r['args'] if r else [], r['comm'] if r else '', nargs)
                c['spawns'][k] = c['spawns'].get(k, 0) + 1
                mod_pids.add(pid)
                coverage[1] += 1
                coverage[0] += 1 if r else 0
            del c['spawnList']
            # What the mod's own children ran in turn (claude agents runs ps and security, for one), and what the engine
            # ran by itself (a direct child the debug log doesn't name as the mod's)
            grand, engine, unknown = [], [], 0
            for r in mine:
                if r['pid'] in mod_pids:
                    continue
                if r['ppid'] == s.pid:
                    engine.append(r)
                    continue
                p, hops, verdict = by_pid.get(r['ppid']), 0, None
                while p and hops < 32:
                    if p['pid'] in mod_pids:
                        verdict = 'mod'
                        break
                    if p['ppid'] == s.pid:
                        verdict = 'engine'
                        break
                    p, hops = by_pid.get(p['ppid']), hops + 1
                if verdict == 'mod':
                    grand.append(r)
                elif verdict == 'engine':
                    engine.append(r)
                else:
                    unknown += 1
            own = None
            if cpu0.get(s.name) and cpu1.get(s.name):
                own = {'cpuSeconds': round(cpu1[s.name][0] - cpu0[s.name][0], 3), 'childrenCpuSeconds': round(cpu1[s.name][1] - cpu0[s.name][1], 3)}
                own['cpuPercentOfCore'] = round(100 * own['cpuSeconds'] / (t1 - t0), 2)
                own['childrenCpuPercentOfCore'] = round(100 * own['childrenCpuSeconds'] / (t1 - t0), 2)
            per[s.name] = dict(c, cpu=own, modGrandchildren=tally(sampled_key(r) for r in grand),
                               engineChildren=tally(sampled_key(r) for r in engine), unattributed=unknown)
            if s.mod:
                totals['paneRenders'] += c['paneRenders']
                totals['bandRenders'] += c['bandRenders']
                totals['modSpawns'] += sum(c['spawns'].values())
                totals['modGrandchildren'] += len(grand)
                totals['storeWrites'] += sum(c['storeWrites'].values())
                totals['fsWrites'] += sum(c['fsWrites'].values())
                for k, v in c['spawns'].items():
                    spawn_cmds[k] = spawn_cmds.get(k, 0) + v
                for r in grand:
                    grand_cmds[sampled_key(r)] = grand_cmds.get(sampled_key(r), 0) + 1
                for r in engine:
                    engine_cmds[sampled_key(r)] = engine_cmds.get(sampled_key(r), 0) + 1
        mods = [per[s.name] for s in self.sessions]
        cpus = [p['cpu'] for p in mods if p['cpu']]
        ctrl = per[self.control.name]
        res = {
            'seconds': round(t1 - t0, 1), 'viewer': 'TEST A' if viewer else None,
            'perMinute': {  # all the sessions with the mod together
                'paneRenders': round(totals['paneRenders'] / minutes, 1),
                'bandRenders': round(totals['bandRenders'] / minutes, 1),
                'modSpawns': round(totals['modSpawns'] / minutes, 1),
                'modSpawnsByCommand': per_minute(spawn_cmds, minutes),
                'modGrandchildren': round(totals['modGrandchildren'] / minutes, 1),
                'modGrandchildrenByCommand': per_minute(grand_cmds, minutes),
                'engineChildrenByCommand': per_minute(engine_cmds, minutes),
                'storeWrites': round(totals['storeWrites'] / minutes, 1),
                'fsWrites': round(totals['fsWrites'] / minutes, 1),
            },
            'perSessionPerMinute': {
                'paneRenders': round(totals['paneRenders'] / minutes / len(mods), 1),
                'bandRenders': round(totals['bandRenders'] / minutes / len(mods), 1),
                'modSpawns': round(totals['modSpawns'] / minutes / len(mods), 1),
                'modProcesses': round((totals['modSpawns'] + totals['modGrandchildren']) / minutes / len(mods), 1),
            },
            'cpuPerSession': {
                'medianPercentOfCore': round(statistics.median(c['cpuPercentOfCore'] for c in cpus), 2) if cpus else None,
                'medianChildrenPercentOfCore': round(statistics.median(c['childrenCpuPercentOfCore'] for c in cpus), 2) if cpus else None,
                'controlPercentOfCore': (ctrl['cpu'] or {}).get('cpuPercentOfCore'),
                'controlChildrenPercentOfCore': (ctrl['cpu'] or {}).get('childrenCpuPercentOfCore'),
            },
            'samplerCoverage': {'modSpawnsSeen': coverage[0], 'modSpawns': coverage[1]},
            'sessions': per,
        }
        if x:
            res['viewerScreenChangesPerMinute'] = round(screens / minutes, 1)
            res['viewerPaneRendersPerMinute'] = round(per['TEST A']['paneRenders'] / minutes, 1)
        return res

    def propagation(self):
        a, b = self.by_name('A'), self.by_name('B')
        x = self.viewer_of_a()
        y = self.terminal('typist', ['claude', 'attach', b.id])
        if y.wait(lambda t: t.current() == 'TEST B', timeout=60) is None:
            raise RuntimeError("TEST B's viewer never showed its panel")
        time.sleep(3)
        rounds = []
        for i in range(self.a.rounds):
            log('propagation round %d' % (i + 1))
            y.keys(BUSY_PROMPT, 'ENTER')
            sent = y.last_key_time('ENTER')
            r = {'sent': sent, 'busy': None, 'idle': None, 'aBusy': None, 'aDone': None, 'ownBusy': None, 'ownDone': None}
            deadline = time.time() + 120
            last = None
            while time.time() < deadline:
                st = registry_status(b.pid)
                now = time.time()
                if st != last:
                    if st == 'busy' and r['busy'] is None:
                        r['busy'] = now
                    if st == 'idle' and r['busy'] is not None and r['idle'] is None:
                        r['idle'] = now
                    last = st
                x.pump(lambda t, term=x: watch_row(r, term, t, 'TEST B', 'aBusy', 'aDone'))
                y.pump(lambda t, term=y: watch_row(r, term, t, 'TEST B', 'ownBusy', 'ownDone'))
                if r['idle'] and all(r[d] or (r[b] is None and now - r['idle'] > 20) or now - r['idle'] > 60
                                     for b, d in (('aBusy', 'aDone'), ('ownBusy', 'ownDone'))):
                    break
                time.sleep(0.01)
            rounds.append(r)
            time.sleep(random.uniform(1.5, 3.5))
        y.close()
        self.terminals.remove(y)

        def delta(r, k, base):
            return r[k] - r[base] if r[k] is not None and r[base] is not None else None
        return {
            'rounds': len(rounds),
            'otherBusy': stats([delta(r, 'aBusy', 'busy') for r in rounds]),
            'otherDone': stats([delta(r, 'aDone', 'idle') for r in rounds]),
            'ownBusy': stats([delta(r, 'ownBusy', 'busy') for r in rounds]),
            'ownDone': stats([delta(r, 'ownDone', 'idle') for r in rounds]),
            'enterToBusy': stats([delta(r, 'busy', 'sent') for r in rounds]),
            'busyMissed': sum(1 for r in rounds if r['busy'] and r['aBusy'] is None),
            'turnSeconds': stats([delta(r, 'idle', 'busy') for r in rounds]),
            'note': "otherBusy/otherDone: from TEST B's registry status changing (~/.claude/sessions/<pid>.json, read every 10 ms) to TEST A's panel drawing TEST B's dot in the new colour; own*: TEST B's own row in its own panel",
        }

    def switch(self):
        x = self.viewer_of_a()
        results = {'AtoB': [], 'BtoA': [], 'AtoBTitle': [], 'BtoATitle': [], 'arrivalFocus': []}
        for i in range(self.a.rounds):
            for src, dst, k in (('TEST A', 'TEST B', 'AtoB'), ('TEST B', 'TEST A', 'BtoA')):
                if x.wait(lambda t: t.current() == src, timeout=30) is None:
                    raise RuntimeError('the viewer is not showing %s' % src)
                time.sleep(1.5)
                if not x.focus_on(dst):
                    raise RuntimeError("couldn't select %s in %s's panel" % (dst, src))
                time.sleep(0.5)
                x.keys('ENTER')
                pressed = x.last_key_time('ENTER')
                x.wait(lambda t: t.current() == dst, after=pressed, timeout=30)
                # From the trace, replayed: keys() reads the frames that come while it waits for its key, unchecked, so
                # an arrival within its 0.2 s would only be seen at the next redraw
                arrived = x.first_since(pressed, lambda t: t.current() == dst)
                title = x.first_since(pressed, lambda t: any(('→ %s' % dst) in row for row in t.rows.values()))
                results[k].append(arrived - pressed if arrived else None)
                results[k + 'Title'].append(title - pressed if title else None)
                time.sleep(1.5)
                x.pump()
                results['arrivalFocus'].append({'from': src, 'to': dst, 'focused': x.focused()})
                log('switch %s: %s' % (k, '%.3f s' % (arrived - pressed) if arrived else 'no arrival'))
        return {
            'AtoB': stats(results['AtoB']), 'BtoA': stats(results['BtoA']),
            'AtoBToTitle': stats(results['AtoBTitle']), 'BtoAToTitle': stats(results['BtoATitle']),
            'arrivalFocus': results['arrivalFocus'],
            'note': "from the Enter key to the first frame where the target's own panel shows it as the current session (▌); ToTitle: to the launcher's '→ <name>' line",
        }

    def ccc(self):
        for t in list(self.terminals):
            t.close()
            self.terminals.remove(t)
        time.sleep(3)
        script = os.path.join(self.plugin, 'setup', 'ccc')
        shim = self.claude_shim()
        totals, attaches, opened = [], [], []
        roots = os.path.join(self.tmp, 'roots-ccc')
        out = os.path.join(self.tmp, 'procs-ccc.jsonl')
        open(roots, 'w').close()
        sampler = subprocess.Popen([sys.executable, procs.__file__, 'watch', '--roots-file', roots, '--out', out, '--interval', '0.002'])
        time.sleep(1)
        windows = []
        for i in range(self.a.rounds):
            z = self.terminal('ccc-%d' % i, ['bash', script], cwd=self.mod_dir, env={'SESSIONS_CLAUDE': shim}, roots=roots)
            started = z.started_at()
            pane = z.wait(lambda t: (t.current() or '').startswith('TEST '), timeout=60)
            attach = z.first_since(started, lambda t: any('Claude Code v' in row for row in t.rows.values()))
            totals.append(pane - started if pane else None)
            attaches.append(attach - started if attach else None)
            opened.append(z.current())
            windows.append((z.proc.pid, started, pane or time.time()))
            log('ccc %d: %s' % (i + 1, '%.3f s' % (pane - started) if pane else 'no panel'))
            time.sleep(2)
            z.close()
            self.terminals.remove(z)
            time.sleep(3)
        sampler.send_signal(signal.SIGTERM)
        sampler.wait(timeout=30)
        sampled = [json.loads(line) for line in open(out)] if os.path.exists(out) else []
        per_run = []
        for pid, t0, t1 in windows:
            mine = [r for r in sampled if r['root'] == pid and t0 <= r['start'] <= t1]
            per_run.append(tally(sampled_key(r) for r in mine))
        return {'toPanel': stats(totals), 'toAttach': stats(attaches), 'opened': opened,
                'sampledCommandsUntilPanel': per_run,
                'note': "from the hidden terminal starting the copy's setup/ccc (claude's plugin lookup included) to the first frame of the opened session's panel with its current row; toAttach: to Claude Code's header"}

    # ---- terminals ---------------------------------------------------------------------------------------------------

    def terminal(self, name, argv, cwd=None, env=None, roots=None):
        extra = {'SESSIONS_DATA_DIR': self.data}
        extra.update(env or {})
        t = Terminal(os.path.join(self.tmp, 'ht', name), argv, cwd or self.mod_dir, extra)
        if roots:
            with open(roots, 'a') as f:
                f.write('%d\n' % t.proc.pid)
        self.terminals.append(t)
        return t

    def viewer_of_a(self):
        for t in self.terminals:
            if t.name == 'viewer':
                return t
        x = self.terminal('viewer', ['bash', os.path.join(self.plugin, 'hooks', 'visor.sh'), 'attach', self.by_name('A').id])
        if x.wait(lambda t: t.current() == 'TEST A', timeout=60) is None:
            raise RuntimeError('the viewer of TEST A never showed its panel')
        time.sleep(3)
        return x

    # A stand-in for claude, for ccc only: `plugin list --json` answers what claude answers, with the sessions plugin's
    # folder and version being the copy under test (so ccc pays the real lookup and runs this copy's launcher)
    def claude_shim(self):
        real = shutil.which('claude')
        path = os.path.join(self.tmp, 'claude-shim')
        fix = os.path.join(self.tmp, 'claude-shim-fix.py')
        with open(fix, 'w') as f:
            f.write('import json, sys\nrows = json.load(sys.stdin)\nfor p in rows:\n'
                    '    if str(p.get("id", "")).startswith("sessions@") and p.get("enabled"):\n'
                    '        p["installPath"] = sys.argv[1]\n        p["version"] = sys.argv[2]\n'
                    'print(json.dumps(rows))\n')
        with open(path, 'w') as f:
            f.write('#!/bin/bash\nif [ "$1" = plugin ] && [ "$2" = list ]; then\n'
                    '  %s "$@" | python3 %s %s %s\n  exit "${PIPESTATUS[0]}"\nfi\nexec %s "$@"\n'
                    % (sh_quote(real), sh_quote(fix), sh_quote(self.plugin), sh_quote(self.result['version'] or ''), sh_quote(real)))
        os.chmod(path, 0o755)
        return path

    # ---- the end -----------------------------------------------------------------------------------------------------

    def cleanup(self):
        for t in self.terminals:
            t.close()
        if self.a.keep:
            log('kept: %s and the sessions in %s' % (self.tmp, self.folder))
            return
        subprocess.run(['bash', CLEAN, self.folder], capture_output=True, text=True, env=clean_env())
        for s in self.sessions + ([self.control] if self.control else []):
            if not s.session_id:
                continue
            project = os.path.join(PROJECTS, re.sub(r'[^A-Za-z0-9]', '-', s.cwd))
            for p in (os.path.join(project, s.session_id + '.jsonl'), os.path.join(project, s.session_id)):
                if os.path.isdir(p):
                    shutil.rmtree(p, ignore_errors=True)
                elif os.path.exists(p):
                    os.remove(p)
            for p in (os.path.join(project, 'memory'), project):
                try:
                    os.rmdir(p)
                except OSError:
                    pass
        for d in self.made_dirs:
            try:
                os.rmdir(d)
            except OSError:
                log('left %s (not empty)' % d)
        shutil.rmtree(self.tmp, ignore_errors=True)


def sh_quote(s):
    return "'" + str(s).replace("'", "'\\''") + "'"


def plugin_version(plugin):
    try:
        with open(os.path.join(plugin, '.claude-plugin', 'plugin.json')) as f:
            return json.load(f).get('version')
    except (OSError, ValueError):
        return None


def tally(keys):
    out = {}
    for k in keys:
        out[k] = out.get(k, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def per_minute(counts, minutes):
    return {k: round(v / minutes, 1) for k, v in sorted(counts.items(), key=lambda kv: -kv[1])}


# A sampled process's name: its command line when it could be read (another user's process, the setuid ps, has none;
# claude's program is named after its version, as in versions/2.1.318)
def sampled_key(r):
    comm = 'claude' if re.match(r'^\d+\.\d+\.\d+$', r['comm'] or '') else r['comm']
    return command_key(r['args'][0] if r['args'] else comm, r['args'], comm, None)


# A child process's name for the tables: its program, and for claude and python what they run
def command_key(argv0, args, comm, nargs):
    base = os.path.basename(argv0 or comm or '?')
    if args and len(args) > 1:
        if base == 'claude':
            return 'claude ' + args[1]
        if base.startswith('python'):
            return base + ' ' + os.path.basename(args[1])
    if base == 'claude' and nargs is not None:
        return 'claude (%d args)' % nargs
    return base


# ---- the engine's debug log ----------------------------------------------------------------------------------------

STAMP = re.compile(r'^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z \[\w+\] (.*)$')
PANE_RENDER = re.compile(r'hooks module sessions@\S+ ui\.render settled in ([\d.]+)ms .*key=sessions\b')
ANY_RENDER = re.compile(r'hooks module sessions@\S+ ui\.render settled in ([\d.]+)ms .*key=(\S+)')
SPAWN = re.compile(r'\$\.process\.(?:run|spawn) \(sessions\): (.+?) with (\d+) args? in .* \(pid (\d+)\)')
STORE = re.compile(r'\$\.store\.(?:set|delete) \(sessions@\S+\): (\S+)')
FS_WRITE = re.compile(r'\$\.fs\.write \(sessions\): (\S+)')


def stamp(text):
    return datetime.datetime.strptime(text[:23], '%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=datetime.timezone.utc).timestamp()


def log_lines(path, t0=None, t1=None):
    try:
        f = open(path, errors='replace')
    except OSError:
        return
    with f:
        for line in f:
            m = STAMP.match(line)
            if not m:
                continue
            t = stamp(m.group(1))
            if (t0 is None or t >= t0) and (t1 is None or t <= t1):
                yield t, m.group(2)


def count(path, pattern):
    return sum(1 for _, text in log_lines(path) if pattern.search(text))


def debug_counts(path, t0, t1):
    c = {'paneRenders': 0, 'bandRenders': 0, 'otherRenders': 0, 'renderMs': [], 'spawns': {}, 'spawnList': [],
         'storeWrites': {}, 'fsWrites': {}}
    for _, text in log_lines(path, t0, t1):
        m = ANY_RENDER.search(text)
        if m:
            key = m.group(2)
            c['paneRenders' if key == 'sessions' else 'bandRenders' if key == 'above-prompt' else 'otherRenders'] += 1
            if key == 'sessions':
                c['renderMs'].append(float(m.group(1)))
            continue
        m = SPAWN.search(text)
        if m:
            c['spawnList'].append((int(m.group(3)), m.group(1), int(m.group(2))))
            continue
        m = STORE.search(text)
        if m:
            k = re.sub(r'^@[0-9a-f]+/', '', m.group(1)).split(':')[0]
            c['storeWrites'][k] = c['storeWrites'].get(k, 0) + 1
            continue
        m = FS_WRITE.search(text)
        if m:
            parts = m.group(1).split('/')
            k = parts[-2] if len(parts) > 1 else parts[0]
            c['fsWrites'][k] = c['fsWrites'].get(k, 0) + 1
    ms = c.pop('renderMs')
    c['paneRenderMedianMs'] = round(statistics.median(ms), 2) if ms else None
    return c


# ---- hidden terminals ----------------------------------------------------------------------------------------------

class Terminal:
    """A command in a hidden terminal (../hidden-terminal.py) with its screen followed through HT_TRACE"""

    def __init__(self, folder, argv, cwd, extra):
        os.makedirs(folder, exist_ok=True)
        self.name = os.path.basename(folder)
        self.fifo = os.path.join(folder, 'keys.fifo')
        self.trace = os.path.join(folder, 'trace.jsonl')
        os.mkfifo(self.fifo)
        self.fd = os.open(self.fifo, os.O_RDWR | os.O_NONBLOCK)
        env = dict(extra, HT_TRACE=self.trace, HT_SECONDS='3600')
        self.err = open(os.path.join(folder, 'stderr'), 'w')
        self.proc = subprocess.Popen(clean([sys.executable, HIDDEN, self.fifo, os.path.join(folder, 'out')] + list(argv), env),
                                     cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=self.err)
        self.rows, self.marks, self.palette = {}, {}, {}
        self.events = []  # (t, ev, payload) in order
        self.pos, self.partial = 0, ''

    def pump(self, on_event=None):
        try:
            with open(self.trace) as f:
                f.seek(self.pos)
                data = f.read()
                self.pos = f.tell()
        except OSError:
            return
        data = self.partial + data
        lines = data.split('\n')
        self.partial = lines.pop()
        for line in lines:
            if not line:
                continue
            e = json.loads(line)
            if e['ev'] == 'screen':
                for y, text in e['rows'].items():
                    self.rows[int(y)] = text
                    self.marks[int(y)] = e['marks'].get(y, [])
                    if not self.palette and all(w in text for w in LEGEND[:4]):
                        cols = e['marks'].get(y, [])
                        if len(cols) >= 4:
                            self.palette = dict(zip(cols, LEGEND_COLOURS))
            self.events.append((e['t'], e['ev'], e.get('key')))
            if on_event:
                on_event(e['t'])

    def wait(self, pred, after=0.0, timeout=30.0):
        """The time of the first trace event at or after `after` from which pred(self) holds, or None"""
        found = []

        def check(t):
            if not found and t >= after and pred(self):
                found.append(t)
        deadline = time.time() + timeout
        self.pump(check)
        # Already so, from frames an earlier pump read (keys() pumps too): a quiet screen may not change again
        if not found and pred(self) and self.events and self.events[-1][0] >= after:
            found.append(self.events[-1][0])
        while not found and time.time() < deadline:
            time.sleep(0.02)
            self.pump(check)
        if not found and pred(self) and self.events and self.events[-1][0] >= after:
            found.append(self.events[-1][0])
        return found[0] if found else None

    def first_since(self, after, pred):
        """Replays the trace on a copy of the screen: the first event at or after `after` from which pred held"""
        found = None
        replay = Terminal.__new__(Terminal)
        replay.rows, replay.marks, replay.palette = {}, {}, self.palette
        with open(self.trace) as f:
            for line in f:
                if not line.endswith('\n'):
                    break
                e = json.loads(line)
                if e['ev'] == 'screen':
                    for y, text in e['rows'].items():
                        replay.rows[int(y)] = text
                        replay.marks[int(y)] = e['marks'].get(y, [])
                if e['t'] >= after and e['ev'] == 'screen' and pred(replay):
                    found = e['t']
                    break
        return found

    def count_screens(self, t0, t1):
        self.pump()
        return sum(1 for t, ev, _ in self.events if ev == 'screen' and t0 <= t <= t1)

    def started_at(self):
        deadline = time.time() + 10
        while time.time() < deadline:
            self.pump()
            for t, ev, _ in self.events:
                if ev == 'start':
                    return t
            time.sleep(0.02)
        return time.time()

    def keys(self, *parts):
        os.write(self.fd, '|'.join(parts).encode())
        time.sleep(0.2 * len(parts))
        deadline = time.time() + 5
        while time.time() < deadline:
            self.pump()
            if sum(1 for _, ev, _ in self.events if ev == 'key') >= self._sent + len([p for p in parts if p != 'DUMP']):
                break
            time.sleep(0.02)
        self._sent = sum(1 for _, ev, _ in self.events if ev == 'key')

    _sent = 0

    def last_key_time(self, key):
        for t, ev, k in reversed(self.events):
            if ev == 'key' and k == key:
                return t
        return None

    # ---- what the screen shows ----

    def pane_rows(self):
        """[(y, name, colour, focused, current)] for the panel's session rows, top to bottom"""
        out = []
        for y in sorted(self.rows):
            text = self.rows[y]
            for m in re.finditer(r'(▌)?\s?●\s(\[)?(TEST [A-Z]+)(?![A-Za-z0-9])', text):
                dot = m.start() + text[m.start():].index('●')
                k = sum(1 for ch in text[:dot] if ch in '●▌')
                cols = self.marks.get(y, [])
                colour = cols[k] if k < len(cols) else None
                out.append((y, m.group(3), self.colour_name(colour), bool(m.group(2)), bool(m.group(1))))
        return out

    def colour_name(self, colour):
        if colour is None:
            return None
        if colour in self.palette:
            return self.palette[colour]
        return hue_name(colour)

    def current(self):
        for _, name, _, _, cur in self.pane_rows():
            if cur:
                return name
        return None

    def focused(self):
        for _, name, _, foc, _ in self.pane_rows():
            if foc:
                return name
        return None

    def colour_of(self, name):
        for _, n, colour, _, cur in self.pane_rows():
            if n == name:
                return colour
        return None

    def focus_on(self, name):
        """Puts the panel's focus on that session's row with the arrows (shift+→ first if the panel isn't focused)"""
        self.pump()
        if self.focused() is None:
            self.keys('SRIGHT')
            self.wait(lambda t: t.focused() is not None, timeout=5)
        for _ in range(16):
            self.pump()
            now = self.focused()
            if now == name:
                return True
            rows = [(y, n) for y, n, _, _, _ in self.pane_rows()]
            ys = {n: y for y, n in rows}
            if now is None or name not in ys:
                self.keys('SRIGHT')
            else:
                self.keys('DOWN' if ys[name] > ys[now] else 'UP')
            self.wait(lambda t: t.focused() != now, timeout=3)
        return False

    def close(self):
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGHUP)
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        try:
            os.close(self.fd)
        except OSError:
            pass
        self.err.close()


def hue_name(colour):
    named = {'red': 'red', 'blue': 'blue', 'yellow': 'yellow', 'green': 'green', 'brown': 'yellow', 'cyan': 'blue',
             'magenta': 'red', 'white': 'gray', 'black': 'gray', 'default': None}
    plain = (colour or '').replace('bright', '')
    if plain in named:
        return named[plain]
    if not re.match(r'^[0-9a-fA-F]{6}$', colour or ''):
        return None
    r, g, b = (int(colour[i:i + 2], 16) / 255 for i in (0, 2, 4))
    hi, lo = max(r, g, b), min(r, g, b)
    if hi - lo < 0.12:
        return 'gray'
    if hi == r:
        h = (60 * ((g - b) / (hi - lo))) % 360
    elif hi == g:
        h = 60 * ((b - r) / (hi - lo)) + 120
    else:
        h = 60 * ((r - g) / (hi - lo)) + 240
    return 'red' if h >= 330 or h < 20 else 'yellow' if h < 70 else 'green' if h < 170 else 'blue' if h < 300 else 'red'


# Propagation: the first frame after the registry change that shows the row's dot in the new colour (done counts only
# after busy was shown: a turn the panel never showed as busy has neither)
def watch_row(r, term, t, name, busy_key, done_key):
    colour = term.colour_of(name)
    if r[busy_key] is None and r['sent'] is not None and t >= r['sent'] and colour == 'blue':
        r[busy_key] = t
    if r[done_key] is None and r[busy_key] is not None and r['idle'] is not None and t >= r['idle'] and colour not in (None, 'blue'):
        r[done_key] = t


def main(argv):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--plugin', required=True, help='the copy of plugins/sessions to measure')
    p.add_argument('--folder', required=True, help='a trusted test folder; the sessions start in its mod/ and ctrl/')
    p.add_argument('--out', required=True, help='the JSON result file')
    p.add_argument('--label', default='')
    p.add_argument('--sessions', type=int, default=6)
    p.add_argument('--scenarios', default='idle,propagation,switch,ccc')
    p.add_argument('--idle-seconds', type=int, default=120)
    p.add_argument('--rounds', type=int, default=5)
    p.add_argument('--warmup', type=int, default=30)
    p.add_argument('--platform', choices=('portable', 'macos'), default='portable')
    p.add_argument('--model', default='haiku')
    p.add_argument('--env', action='append', default=[], help='KEY=VALUE added to every test session (a counter the copy exposes)')
    p.add_argument('--keep', action='store_true', help='leave the sessions, their transcripts and the temporary folder')
    a = p.parse_args(argv)
    scenarios = [s for s in a.scenarios.split(',') if s]
    if a.sessions < 2:
        p.error('--sessions must be 2 or more')
    if a.platform == 'macos' and set(scenarios) & {'switch', 'ccc'}:
        p.error("--platform macos runs only idle and propagation: an Enter in a panel there could open a Terminal window")
    if not os.path.isfile(os.path.join(a.plugin, '.claude-plugin', 'plugin.json')):
        p.error('%s is not a copy of the sessions plugin' % a.plugin)
    try:
        import pyte  # noqa: F401
    except ImportError:
        p.error('run this with a python that has pyte (the hidden terminal needs it)')
    b = Bench(a)
    try:
        b.start()
        for s in scenarios:
            try:
                if s == 'idle':
                    b.result['scenarios']['idle'] = b.idle('idle', viewer=False)
                    b.result['scenarios']['idleWithViewer'] = b.idle('idleWithViewer', viewer=True)
                elif s == 'propagation':
                    b.result['scenarios']['propagation'] = b.propagation()
                elif s == 'switch':
                    b.result['scenarios']['switch'] = b.switch()
                elif s == 'ccc':
                    b.result['scenarios']['ccc'] = b.ccc()
                else:
                    b.result['errors'].append('unknown scenario %s' % s)
            except Exception as e:  # one scenario failing doesn't lose the others
                b.result['errors'].append('%s: %s: %s' % (s, type(e).__name__, e))
                log('%s failed: %s' % (s, e))
    except Exception as e:
        b.result['errors'].append('start: %s: %s' % (type(e).__name__, e))
        log('start failed: %s' % e)
    finally:
        with open(a.out, 'w') as f:
            json.dump(b.result, f, indent=2, ensure_ascii=False)
            f.write('\n')
        log('wrote %s' % a.out)
        b.cleanup()
    return 1 if b.result['errors'] else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
