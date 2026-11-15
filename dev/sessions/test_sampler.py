#!/usr/bin/env python3
"""Tests of the process sampler of /sessions debug perf (plugins/sessions/hooks/debug/sampler.py). test-sampler.sh runs it.

    test_sampler.py                     the parsers of both systems with made-up text and bytes, the window's sums
                                        against a made-up process list, and the Linux reader against a made-up /proc
    test_sampler.py check FILE HOW SESSION_PID GONE_PID MISSING_PID PROGRAMS yes|no
                                        a real output: its shape, the session's numbers, and that every string in it is
                                        a fixed word or a program on the list (yes|no: whether `sleep` is on it)

Everything here runs on macOS and on Linux alike. Every value is made up.
"""
import importlib.util
import json
import os
import shutil
import struct
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLER = os.path.join(HERE, '..', '..', 'plugins', 'sessions', 'hooks', 'debug', 'sampler.py')
spec = importlib.util.spec_from_file_location('sampler', SAMPLER)
sampler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler)

# Every word the output may hold besides numbers, pids and the programs on the list
KEYS = {'format', 'how', 'seconds', 'samples', 'machine', 'cores', 'memoryMB', 'freeMB', 'swapUsedMB', 'pressure',
        'pressureKind', 'battery', 'processes', 'cpuMs', 'childCpuMs', 'memoryKind', 'peakMB', 'pssMB', 'wakeups',
        'threads', 'gone', 'started', 'helpers', 'count', 'transcriptMB', 'other', 'largestMs', 'over20', 'roles',
        'terminal', 'service', 'unavailable', 'idle', 'interrupt', 'voluntary', 'involuntary'}
WORDS = {'libproc', 'procfs', 'footprint', 'rss', 'level', 'psi'}
UNAVAILABLE = {'battery', 'free', 'swap', 'pressure', 'pss', 'peak', 'wakeups', 'threads', 'helpers', 'transcript',
               'terminal', 'service', 'other'}
TOP = ['format', 'how', 'seconds', 'samples', 'machine', 'processes', 'other', 'roles', 'unavailable']
PROCESS = ['cpuMs', 'childCpuMs', 'memoryMB', 'memoryKind', 'peakMB', 'pssMB', 'wakeups', 'threads', 'gone', 'started',
           'helpers', 'transcriptMB']


def expect(got, want, what):
    if got != want:
        raise AssertionError('%s: expected %r, got %r' % (what, want, got))


def near(got, want, what, slack=0.01):
    if got is None or abs(got - want) > slack:
        raise AssertionError('%s: expected about %r, got %r' % (what, want, got))


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# Every string in an output, keys and values, with where it sits
def strings(value, where=''):
    if isinstance(value, str):
        yield where, value
    elif isinstance(value, list):
        for item in value:
            for found in strings(item, where):
                yield found
    elif isinstance(value, dict):
        for key, item in value.items():
            yield where + '{}', key
            for found in strings(item, where + '.' + (key if key in KEYS else '*')):
                yield found


# No string in an output is anything but a field's name, a fixed word, a pid (the keys of `processes` alone), a
# reading's name in `unavailable`, or a program on the list (the keys of `started` and `helpers` alone)
def check_strings(output, programs):
    for where, text in strings(output):
        if where == '.processes{}':
            ok = text.isdigit()
        elif where in ('.processes.*.started{}', '.processes.*.helpers{}'):
            ok = text in programs or text == 'other'
        elif where == '.unavailable':
            ok = text in UNAVAILABLE
        elif where.endswith('{}'):
            ok = text in KEYS
        else:
            ok = text in WORDS
        if not ok:
            raise AssertionError('a string that may not be in the output, at %s: %r' % (where or 'the top', text))


# The shape every output has, whatever was read
def check_shape(output, how):
    expect(list(output), TOP, 'the output\'s keys')
    expect(output['format'], 1, 'format')
    expect(output['how'], how, 'how')
    assert number(output['seconds']) and output['seconds'] > 0, 'seconds'
    assert isinstance(output['samples'], int) and output['samples'] >= 2, 'samples'
    unavailable = output['unavailable']
    assert isinstance(unavailable, list) and all(isinstance(name, str) for name in unavailable), 'unavailable is a list'
    expect(sorted(set(unavailable)), unavailable, 'unavailable, sorted and each once')
    machine = output['machine']
    expect(list(machine), ['cores', 'memoryMB', 'freeMB', 'swapUsedMB', 'pressure', 'pressureKind', 'battery'], 'machine')
    assert isinstance(machine['cores'], int) and machine['cores'] >= 1, 'cores'
    assert number(machine['memoryMB']) and machine['memoryMB'] > 0, 'memoryMB'
    for key, name in (('freeMB', 'free'), ('swapUsedMB', 'swap'), ('pressure', 'pressure')):
        value = machine[key]
        if value is None:
            assert name in unavailable, '%s is null and not in unavailable' % key
        else:
            assert name not in unavailable, '%s is read and in unavailable' % key
            assert len(value) == 2 and all(number(v) and v >= 0 for v in value), '%s is a pair' % key
    expect(machine['pressureKind'], None if machine['pressure'] is None else {'libproc': 'level', 'procfs': 'psi'}[how],
           'pressureKind')
    assert (machine['battery'] is None) == ('battery' in unavailable), 'battery and unavailable'
    assert machine['battery'] in (None, True, False), 'battery'
    for pid, process in output['processes'].items():
        assert pid.isdigit(), 'a process is keyed by its pid'
        expect(list(process), PROCESS, 'a process\'s keys')
        assert number(process['cpuMs']) and process['cpuMs'] >= 0, 'cpuMs'
        assert number(process['childCpuMs']) and process['childCpuMs'] >= 0, 'childCpuMs'
        assert len(process['memoryMB']) == 2 and all(number(v) and v >= 0 for v in process['memoryMB']), 'memoryMB'
        expect(process['memoryKind'], {'libproc': 'footprint', 'procfs': 'rss'}[how], 'memoryKind')
        assert isinstance(process['gone'], bool), 'gone'
        for key, name in (('peakMB', 'peak'), ('wakeups', 'wakeups'), ('threads', 'threads')):
            assert process[key] is not None or name in unavailable, '%s is null and not in unavailable' % key
        assert process['pssMB'] is not None or process['gone'] or 'pss' in unavailable, 'pssMB and unavailable'
        if process['wakeups'] is not None:
            kinds = {'libproc': ['idle', 'interrupt'], 'procfs': ['involuntary', 'voluntary']}[how]
            expect(sorted(process['wakeups']), kinds, 'the kinds of wake-ups')
            assert all(isinstance(v, int) and v >= 0 for v in process['wakeups'].values()), 'wake-ups are counts'
        assert all(isinstance(v, int) and v >= 1 for v in process['started'].values()), 'started are counts'
        for helper in process['helpers'].values():
            expect(list(helper), ['count', 'memoryMB'], 'a helper\'s keys')
            assert isinstance(helper['count'], int) and helper['count'] >= 1 and number(helper['memoryMB']), 'a helper'
        assert process['transcriptMB'] is None or number(process['transcriptMB']), 'transcriptMB'
    other = output['other']
    assert (other is None) == ('other' in unavailable), 'other and unavailable'
    if other is not None:
        expect(list(other), ['cpuMs', 'largestMs', 'over20'], 'other\'s keys')
        assert 0 <= other['largestMs'] <= other['cpuMs'] and isinstance(other['over20'], int), 'other\'s numbers'
    expect(list(output['roles']), ['terminal', 'service'], 'the roles')
    for name, role in output['roles'].items():
        assert (role is None) == (name in unavailable), 'the %s and unavailable' % name
        if role is not None:
            expect(list(role), ['count', 'cpuMs', 'memoryMB', 'threads'], 'a role\'s keys')
            assert isinstance(role['count'], int) and number(role['cpuMs']) and number(role['memoryMB']), 'a role'


# A real output of test-sampler.sh: a stand-in session that keeps one `sleep` and starts short ones, a second one that
# ends inside the window, and a pid that isn't a process
def check(path, how, session, gone, missing, programs, listed):
    with open(path) as f:
        output = json.load(f)
    programs = [name for name in programs.split(',') if name]
    check_shape(output, how)
    check_strings(output, programs)
    expect(sorted(output['processes']), sorted([session, gone]), 'the processes (a pid that isn\'t one is left out)')
    assert 2.5 <= output['seconds'] <= 10, 'the window\'s length: %r' % output['seconds']
    assert output['samples'] >= 5, 'the looks at the process list: %r' % output['samples']
    process = output['processes'][session]
    expect(process['gone'], False, 'the session is still there')
    assert process['cpuMs'] < 3000 and process['childCpuMs'] < 3000, 'the CPU of a stand-in that does next to nothing'
    assert all(0 < v < 500 for v in process['memoryMB']), 'the stand-in\'s memory: %r' % process['memoryMB']
    assert process['threads'] is None or 1 <= process['threads'] < 50, 'the stand-in\'s threads'
    name = 'sleep' if listed else 'other'
    assert process['started'].get(name, 0) >= 2, 'the short sleeps, as %s: %r' % (name, process['started'])
    assert name in process['helpers'] and process['helpers'][name]['count'] >= 1, 'the sleep that stays, as %s' % name
    if not listed:
        assert 'sleep' not in process['started'] and 'sleep' not in process['helpers'], 'a program off the list'
    expect(process['transcriptMB'], 2.0, 'the conversation file\'s size')
    expect(output['processes'][gone]['gone'], True, 'the process that ended inside the window')
    expect(output['processes'][gone]['transcriptMB'], None, 'a session with no conversation file')
    if how == 'libproc':
        assert 'pss' in output['unavailable'], 'macOS has no proportional size'
    print('ok: the output for --programs %s' % ','.join(programs))


# ---- the parsers, with made-up text ----

def test_cputime():
    expect(sampler.parse_cputime('0:00.03'), 30.0, 'macOS, hundredths')
    expect(sampler.parse_cputime('123:45.67'), (123 * 60 + 45.67) * 1000, 'macOS, minutes past 59')
    expect(sampler.parse_cputime('0:01,50'), 1500.0, 'a comma for the decimal point')
    expect(sampler.parse_cputime('01:02:03'), 3723000.0, 'Linux, hours')
    expect(sampler.parse_cputime('2-01:00:00'), (2 * 86400 + 3600) * 1000.0, 'Linux, days')
    for bad in ('', 'TIME', '1:2:3:4', '-', 'a:00', '1.5:00', 'inf', '1:nan'):
        expect(sampler.parse_cputime(bad), None, 'not a time: %r' % bad)
    text = '    1   5:00.00\n  200   0:00.10\nPID TIME\n  300 what\n  400   1:00.00 extra\n\n'
    expect(sampler.parse_ps_times(text), {1: 300000.0, 200: 100.0}, 'ps lines')


def stat_line(pid, comm, ppid, utime=0, stime=0, cutime=0, cstime=0, threads=1, start=1000, rss=100, state='S'):
    fields = [state, ppid, pid, pid, 0, -1, 4194304, 0, 0, 0, 0, utime, stime, cutime, cstime, 20, 0, threads, 0, start,
              1000000, rss] + [0] * 28
    return '%d (%s) %s\n' % (pid, comm, ' '.join(str(f) for f in fields))


def test_stat():
    got = sampler.parse_stat(stat_line(100, 'bash', 50, 7, 3, 20, 10, threads=4, start=555, rss=250))
    expect(got, {'comm': 'bash', 'state': 'S', 'ppid': 50, 'utime': 7, 'stime': 3, 'cutime': 20, 'cstime': 10,
                 'threads': 4, 'start': 555, 'rss': 250}, 'a stat line')
    got = sampler.parse_stat(stat_line(100, 'a b) R 1 (c', 50, 7))
    expect((got['comm'], got['state'], got['ppid'], got['utime']), ('a b) R 1 (c', 'S', 50, 7),
           'a name with spaces and parentheses')
    expect(sampler.parse_stat('100 (short) S 1 2 3'), None, 'too few fields')
    expect(sampler.parse_stat('nothing'), None, 'not a stat line')
    expect(sampler.parse_stat(stat_line(1, 'x', 0).replace(' 0 ', ' zero ', 1)), None, 'a field that isn\'t a number')


STATUS = ('Name:\tbash\nState:\tS (sleeping)\nPid:\t100\nVmPeak:\t  900000 kB\nVmHWM:\t  204800 kB\nVmRSS:\t  102400 kB\n'
          'Threads:\t7\nvoluntary_ctxt_switches:\t1500\nnonvoluntary_ctxt_switches:\t30\n')


def test_status():
    expect(sampler.parse_status(STATUS), {'rss': 102400, 'peak': 204800, 'threads': 7, 'voluntary': 1500,
                                          'involuntary': 30}, 'a status file')
    expect(sampler.parse_status('Name:\tkthreadd\nThreads:\t1\n'),
           {'rss': None, 'peak': None, 'threads': 1, 'voluntary': None, 'involuntary': None}, 'one with no memory lines')
    expect(sampler.parse_status('Name:\tVmRSS: 5 kB\nVmRSS:\t  10 kB\n')['rss'], 10, 'a name that looks like a line')


def test_meminfo_pressure_pss():
    info = sampler.parse_meminfo('MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    8000000 kB\n'
                                 'SwapTotal:       2000000 kB\nSwapFree:        1500000 kB\nHugePages_Total:       0\n')
    expect((info['MemTotal'], info['MemAvailable'], info['SwapTotal'] - info['SwapFree'], info['HugePages_Total']),
           (16000000, 8000000, 500000, 0), 'meminfo')
    assert 'MemAvailable' not in sampler.parse_meminfo('MemTotal: 1000 kB\nMemFree: 10 kB\n'), 'an old kernel\'s meminfo'
    psi = 'some avg10=1.50 avg60=0.75 avg300=0.10 total=123456\nfull avg10=0.25 avg60=0.00 avg300=0.00 total=789\n'
    expect(sampler.parse_pressure(psi), 1.5, 'pressure')
    expect(sampler.parse_pressure('full avg10=0.25 avg60=0.00 avg300=0.00 total=789\n'), None, 'no `some` line')
    expect(sampler.parse_pressure('some avg10=x\n'), None, 'not a number')
    expect(sampler.parse_pss('Rss:   2000 kB\nPss:   1500 kB\nPss_Anon:  700 kB\n'), 1500, 'smaps_rollup')
    expect(sampler.parse_pss('Rss:   2000 kB\n'), None, 'no Pss line')
    expect(sampler.parse_cmdline(b'/home/x/bin/claude\0daemon\0run\0'), ['/home/x/bin/claude', 'daemon', 'run'], 'cmdline')
    expect(sampler.parse_cmdline(b''), [], 'an empty cmdline')


def test_battery():
    expect(sampler.on_battery_supplies([]), None, 'no supply')
    expect(sampler.on_battery_supplies([{'type': 'Mains'}]), False, 'mains alone')
    expect(sampler.on_battery_supplies([{'type': 'Mains'}, {'type': 'Battery', 'status': 'Charging'}]), False, 'charging')
    expect(sampler.on_battery_supplies([{'type': 'Mains'}, {'type': 'Battery', 'status': 'Discharging'}]), True, 'discharging')
    expect(sampler.on_battery_supplies([{'type': 'Battery', 'status': 'Discharging', 'scope': 'Device'}]), None,
           'a mouse\'s battery')
    expect(sampler.on_battery_source('Battery Power'), True, 'macOS on battery')
    expect(sampler.on_battery_source('AC Power'), False, 'macOS on mains')


def test_macos_bytes():
    expect(sampler.parse_swapusage(struct.pack('<3QII', 2048 * 1048576, 1024 * 1048576, 1024 * 1048576, 4096, 1)),
           1024 * 1048576, 'vm.swapusage')
    expect(sampler.parse_swapusage(b'\0' * 8), None, 'a short vm.swapusage')
    fields = [0] * 35
    fields[0], fields[1] = 3000, 1000              # user and system time, in time units
    fields[2], fields[3] = 40, 60                  # idle and interrupt wake-ups
    fields[7] = 200 * 1048576                      # physical footprint
    fields[8] = 5555                               # when it started
    fields[10], fields[11] = 600, 400              # the waited-for children's user and system time
    fields[28] = 300 * 1048576                     # the footprint's lifetime peak
    raw = struct.pack('<16s35Q', b'\0' * 16, *fields)
    expect(sampler.parse_rusage(raw, 125 / 3), {'start': 5555, 'ended': False, 'cpuMs': 4000 * 125 / 3 / 1e6,
                                                'reapedMs': 1000 * 125 / 3 / 1e6, 'memoryMB': 200.0, 'peakMB': 300.0,
                                                'wakeups': {'idle': 40, 'interrupt': 60}, 'threads': None}, 'rusage_info_v4')
    fields[28] = 0
    expect(sampler.parse_rusage(struct.pack('<16s35Q', b'\0' * 16, *fields), 1)['peakMB'], None, 'no peak kept')
    expect(sampler.parse_rusage(raw[:100], 1), None, 'a short rusage')
    fields[9] = 7777                               # when it ended: it waits for its parent to collect it
    got = sampler.parse_rusage(struct.pack('<16s35Q', b'\0' * 16, *fields), 1)
    expect((got['ended'], got['cpuMs'], got['reapedMs']), (True, 4000 / 1e6, 1000 / 1e6), 'one that ended keeps its times')
    short = struct.pack('<4I16s8I', 100, 50, 100, 2, b'bash\0garbage', *([0] * 8))
    expect(sampler.parse_shortinfo(short), (50, 'bash'), 'proc_bsdshortinfo')
    expect(sampler.parse_shortinfo(short[:10]), None, 'a short proc_bsdshortinfo')
    task = struct.pack('<6Q12i', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 1, 31)
    expect(sampler.parse_taskinfo(task), 9, 'proc_taskinfo')
    args = struct.pack('<i', 3) + b'/Users/x/bin/claude\0\0\0\0' + b'/Users/x/bin/claude\0daemon\0run\0HOME=/Users/x\0'
    expect(sampler.parse_procargs(args), ['/Users/x/bin/claude', 'daemon', 'run'], 'kern.procargs2')
    expect(sampler.parse_procargs(b'\0\0'), [], 'a short kern.procargs2')
    expect(sampler.parse_vm_free_pages(struct.pack('<4I', 1000, 5000, 3000, 800)), 4000, 'vm_statistics64')


def test_names_and_args():
    names = frozenset(['git', 'python3', 'gnome-terminal-server'])
    same = {'Python': 'python3'}
    expect(sampler.program_of([None, 'git', None], names, {}), 'git', 'the short name')
    expect(sampler.program_of(['python3', 'python3', 'python3.12'], names, {}), 'python3', 'the name it was started as')
    expect(sampler.program_of(['sh', 'bash', 'bash'], frozenset(['sh', 'bash']), {}), 'sh', 'a program run as another')
    expect(sampler.program_of(['Python', 'Python', 'Python'], names, same), 'python3', 'a program known by another name')
    expect(sampler.program_of(['Python', 'Python', 'Python'], frozenset(['git']), same), None, 'whose name is off the list')
    expect(sampler.program_of(['x', 'gnome-terminal-', 'gnome-terminal-server'], names, {}), 'gnome-terminal-server',
           'a short name that was cut')
    expect(sampler.program_of(['secret-tool', 'secret-tool', 'secret-tool'], names, same), None, 'off the list')
    expect(sampler.program_of([None, None, None], names, {}), None, 'nothing read')

    def lazy():
        yield 'git'
        raise AssertionError('the names after the one that did are not read')

    expect(sampler.program_of(lazy(), names, {}), 'git', 'the first name that does')
    expect(sampler.started_as(['/bin/sh', '-c', 'true']), 'sh', 'the first argument, without the folders')
    expect(sampler.started_as(['-bash']), 'bash', 'a login shell')
    expect((sampler.started_as([]), sampler.started_as([''])), (None, None), 'no arguments')
    expect(sampler.is_service(['/Users/x/bin/claude', 'daemon', 'run']), True, 'the service')
    expect(sampler.is_service(['claude', 'daemon']), True, 'the service, by a bare name')
    expect(sampler.is_service(['/Users/x/bin/claude', '--resume', 'daemon']), False, 'a session')
    expect(sampler.is_service(['/Users/x/bin/other', 'daemon']), False, 'another program')
    expect(sampler.is_service([]), False, 'no arguments')
    expect(sampler.parse_sessions('100:aaaaaaaa-1,200:bbbbbbbb-1'), {100: 'aaaaaaaa-1', 200: 'bbbbbbbb-1'}, 'sessions')
    for bad in ('', '100', 'x:aaaaaaaa', '100:', '100:../x', '100:a/b', '1:aaaaaaaa', '100:aaaaaaaa,'):
        expect(sampler.parse_sessions(bad), None, 'not sessions: %r' % bad)
    expect(sampler.parse_names('git,mv,,python3.12'), ['git', 'mv', 'python3.12'], 'programs')
    expect(sampler.parse_names(''), [], 'no programs')
    for bad in ('/bin/sh', 'a b', 'git,../x', 'x' * 49):
        expect(sampler.parse_names(bad), None, 'not programs: %r' % bad)
    base = ['--how', 'procfs', '--seconds', '60', '--sessions', '100:aaaaaaaa-1', '--programs', 'git,mv', '--terminals',
            'Terminal', '--out', '/home/x/out.json']
    args = sampler.perf_args(base)
    expect((args.how, args.seconds, args.interval, args.sessions, sorted(args.programs), sorted(args.terminals),
            args.projects_dir, args.out),
           ('procfs', 60.0, 0.5, {100: 'aaaaaaaa-1'}, ['git', 'mv'], ['Terminal'], None, '/home/x/out.json'), 'the arguments')
    args = sampler.perf_args(['--how=libproc', '--seconds=5', '--interval=0.2', '--sessions=100:aaaaaaaa-1', '--programs=',
                              '--terminals=', '--projects-dir=/home/x/projects', '--out=/home/x/out.json'])
    expect((args.how, args.seconds, args.interval, sorted(args.programs), args.projects_dir),
           ('libproc', 5.0, 0.2, [], '/home/x/projects'), 'the arguments, with =')

    def changed(name, value):
        words = list(base)
        words[words.index(name) + 1] = value
        return words

    for bad in (changed('--how', 'guess'), changed('--seconds', '0'), changed('--seconds', 'long'),
                changed('--out', 'out.json'), changed('--programs', '/bin/sh'), changed('--sessions', '100'),
                base[:-2], base + ['--more', '1'], base + ['--interval'], base + ['--interval', '0']):
        expect(sampler.perf_args(bad), None, 'not a command line: %r' % bad)


def test_role_and_other():
    reading = {'start': 1, 'cpuMs': 100.0, 'memoryMB': 50.0, 'threads': 4}
    later = dict(reading, cpuMs=160.0, memoryMB=55.0)
    expect(sampler.role_result({}, {}), None, 'no process plays the role')
    expect(sampler.role_result({10: None}, {10: None}), None, 'one that can\'t be read')
    expect(sampler.role_result({10: reading}, {10: later}), {'count': 1, 'cpuMs': 60.0, 'memoryMB': 55.0, 'threads': 4},
           'one process')
    expect(sampler.role_result({10: reading}, {10: later, 11: dict(reading, cpuMs=5.0)}),
           {'count': 2, 'cpuMs': 65.0, 'memoryMB': 105.0, 'threads': 8}, 'one that came inside the window')
    expect(sampler.role_result({10: reading}, {}), {'count': 0, 'cpuMs': 0.0, 'memoryMB': 0, 'threads': 0},
           'one that ended inside the window')
    expect(sampler.role_result({10: reading}, {10: dict(later, threads=None)})['threads'], None, 'threads not read')
    first = {1: 1000.0, 2: 500.0, 3: 100.0, 4: 9000.0, 5: 700.0}
    last = {1: 1100.0, 2: 3500.0, 3: 100.0, 4: 9999.0, 5: 30.0, 6: 2500.0}
    expect(sampler.other_result(first, last, {4}, 10.0), {'cpuMs': 5630.0, 'largestMs': 3000.0, 'over20': 2},
           'other software: 4 is skipped, 5\'s pid was used again, 6 is new')


# ---- the window's sums, against a made-up process list ----

class FakeSystem:
    """A system that plays a script: `steps` is one process list per look, {pid: its fields}"""
    how = 'procfs'
    memory_kind = 'rss'
    pressure_kind = 'psi'
    same = {'Python': 'python3'}

    def __init__(self, steps, tables, memory=((8000.0, 100.0, 0.5), (7000.0, 150.0, 2.0)), battery=False, pss=120.0):
        self.steps, self.tables, self.memory, self.on_battery, self.pss_mb = steps, list(tables), list(memory), battery, pss
        self.at = -1
        self.spawned = 0

    def now(self):
        return self.steps[self.at]

    def pids(self):
        self.at += 1
        return set(self.now())

    def look(self, pid):
        p = self.now().get(pid)
        return None if p is None or p.get('ended') else (p['ppid'], p['comm'])

    def exe(self, pid):
        p = self.now().get(pid)
        return None if p is None else p.get('exe', p['comm'])

    def args(self, pid):
        p = self.now().get(pid)
        return [] if p is None else p.get('args', [])

    def usage(self, pid, full=False):
        p = self.now().get(pid)
        if p is None or p.get('unreadable'):
            return None
        return {'start': p.get('start', pid), 'ended': bool(p.get('ended')), 'cpuMs': float(p.get('cpu', 0)),
                'reapedMs': float(p.get('reaped', 0)),
                'memoryMB': float(p.get('mem', 1)), 'peakMB': p.get('peak', 300.0) if full else None,
                'wakeups': {'voluntary': p.get('vol', 0), 'involuntary': p.get('invol', 0)} if full else None,
                'threads': p.get('threads', 1)}

    def pss(self, pid):
        return self.pss_mb

    def cpu_table(self):
        return self.tables.pop(0)

    def machine(self):
        return 8, 16000.0

    def memory_now(self):
        return self.memory.pop(0)

    def battery(self):
        return self.on_battery


class Clock:
    def __init__(self):
        self.t = 100.0

    def now(self):
        return self.t

    def wait(self, seconds):
        self.t += max(0.0, seconds)
        return False


def proc(ppid, comm, **more):
    return dict(more, ppid=ppid, comm=comm)


# Sessions 100 and 200. The sampler is 900, started through a wrapper (150) by session 100. 200 ends inside the window.
def script():
    always = {
        1: proc(0, 'init', unreadable=True),
        50: proc(1, 'Terminal', cpu=1000, mem=400, threads=9),
        60: proc(1, '9.9.9', args=['/Users/x/bin/claude', 'daemon', 'run'], cpu=200, mem=90, threads=14),
        150: proc(100, 'sh'),
        900: proc(150, 'python3', cpu=10),
        300: proc(1, 'secretapp', cpu=1000),
        310: proc(1, 'rootd', unreadable=True),
    }
    a0 = dict(always)
    a0.update({100: proc(50, 'claude', cpu=1000, reaped=500, mem=200, peak=250, vol=100, invol=10, threads=20),
               110: proc(100, 'node', cpu=300, mem=50), 120: proc(100, 'bash', cpu=100, mem=2),
               200: proc(60, 'claude', cpu=50, mem=180, threads=18)})
    a1 = dict(always)
    a1.update({100: proc(50, 'claude', cpu=1030, reaped=500, mem=201, peak=250, vol=130, invol=11, threads=20),
               110: proc(100, 'node', cpu=310, mem=50), 120: proc(100, 'bash', cpu=140, mem=2),
               121: proc(120, 'git', cpu=20),                       # a grandchild: a start
               130: proc(100, 'bash'),                              # between its fork and its exec: mv at the next look
               131: proc(100, 'secret-tool', args=['/Users/x/bin/secret-tool', '--name', 'x']),  # off the list: other
               132: proc(100, 'bash', args=['/bin/sh', '-c', 'true']),      # run as another program: sh
               133: proc(100, 'Python', args=['/Users/x/bin/Python', 'x.py']),  # known by another name: python3
               200: proc(60, 'claude', cpu=75, mem=185, threads=18),
               901: proc(900, 'ps', cpu=30)})                       # the sampler's own: nobody's start
    a2 = dict(always)
    # 120 ended and 100 waited for it: its 140 ms and its child's 20 ms are now in 100's waited-for time. 200 ended.
    a2.update({100: proc(50, 'claude', cpu=1060, reaped=660, mem=203, peak=250, vol=160, invol=12, threads=21),
               110: proc(100, 'node', cpu=320, mem=50), 130: proc(100, 'mv', cpu=3), 131: proc(100, 'secret-tool', cpu=5),
               134: proc(100, 'git', cpu=1)})                       # ended by the close, and not collected yet
    a3 = dict(always)
    a3.update({50: proc(1, 'Terminal', cpu=1100, mem=410, threads=9),
               60: proc(1, '9.9.9', args=['/Users/x/bin/claude', 'daemon', 'run'], cpu=240, mem=95, threads=14),
               100: proc(50, 'claude', cpu=1090, reaped=660, mem=205, peak=260, vol=190, invol=13, threads=21),
               110: proc(100, 'node', cpu=330, mem=51), 130: proc(100, 'mv', cpu=5, mem=1.5),
               131: proc(100, 'secret-tool', cpu=7, mem=3),
               134: proc(100, 'git', cpu=4, ended=True),            # its 4 ms are still its own
               900: proc(150, 'python3', cpu=30, reaped=30),        # the sampler's own, and its ps's
               135: proc(100, 'git', cpu=9, ended=True),            # came and ended between two looks: never seen
               400: proc(1, 'secretapp2')})
    tables = [{1: 10.0, 50: 1000.0, 60: 200.0, 100: 1000.0, 110: 300.0, 120: 100.0, 150: 0.0, 200: 50.0, 300: 1000.0,
               310: 5000.0, 900: 10.0},
              {1: 20.0, 50: 1100.0, 60: 240.0, 100: 1090.0, 110: 330.0, 130: 5.0, 131: 7.0, 150: 0.0, 300: 1900.0,
               310: 5100.0, 400: 50.0, 900: 60.0}]
    return [a0, a1, a2, a3], tables


def run_script(system, sessions=None, projects_dir=None):
    args = sampler.PerfArgs('procfs', 1.5, 0.5, sessions or {100: 'aaaaaaaa-1', 200: 'bbbbbbbb-1', 777: 'cccccccc-1'},
                            frozenset(['git', 'mv', 'node', 'bash', 'sh', 'python3', 'ps']), frozenset(['Terminal']),
                            projects_dir, '/home/x/out.json')
    clock = Clock()
    return sampler.sample(system, args, clock.now, clock.wait, 900)


def test_window():
    steps, tables = script()
    output = run_script(FakeSystem(steps, tables))
    check_shape(output, 'procfs')
    check_strings(output, ['git', 'mv', 'node', 'bash', 'sh', 'python3', 'ps'])
    expect((output['seconds'], output['samples']), (1.5, 4), 'the window: an open, two looks and a close')
    expect(output['machine'], {'cores': 8, 'memoryMB': 16000.0, 'freeMB': [8000.0, 7000.0], 'swapUsedMB': [100.0, 150.0],
                               'pressure': [0.5, 2.0], 'pressureKind': 'psi', 'battery': False}, 'the machine')
    expect(sorted(output['processes']), ['100', '200'], 'the sessions: 777 isn\'t a process')
    a = output['processes']['100']
    expect(a['cpuMs'], 90.0, 'the session\'s own CPU')
    # 120 used 40 and its child 20 before both ended; 110 used 30; 130 used 5 and 131 used 7, from nothing; 134 used 4
    # and ended, not collected yet. What 110 and 120 had used before the window (400) isn't counted, nor the wrapper's
    # and the sampler's (50, with its ps)
    expect(a['childCpuMs'], 106.0, 'the CPU of its children, alive or ended inside the window')
    expect((a['memoryMB'], a['memoryKind'], a['peakMB'], a['pssMB']), ([200.0, 205.0], 'rss', 260.0, 120.0), 'its memory')
    expect((a['wakeups'], a['threads'], a['gone']), ({'involuntary': 3, 'voluntary': 90}, 21, False), 'its wake-ups')
    expect(a['started'], {'git': 2, 'mv': 1, 'other': 1, 'sh': 1, 'python3': 1},
           'its starts, each by its program: the sampler\'s ps is nobody\'s')
    expect(a['helpers'], {'node': {'count': 1, 'memoryMB': 51.0}, 'mv': {'count': 1, 'memoryMB': 1.5},
                          'other': {'count': 1, 'memoryMB': 3.0}}, 'its helpers: not the wrapper, not the sampler')
    b = output['processes']['200']
    expect((b['gone'], b['cpuMs'], b['memoryMB'], b['pssMB'], b['started'], b['helpers']),
           (True, 25.0, [180.0, 185.0], None, {}, {}), 'the session that ended, with its last reading')
    expect(output['roles'], {'terminal': {'count': 1, 'cpuMs': 100.0, 'memoryMB': 410.0, 'threads': 9},
                             'service': {'count': 1, 'cpuMs': 40.0, 'memoryMB': 95.0, 'threads': 14}}, 'the roles')
    # 1 (10), 300 (900), 310 (100), 400 (50, new): not the sessions, their children, the roles, the wrapper, the sampler
    expect(output['other'], {'cpuMs': 1060.0, 'largestMs': 900.0, 'over20': 1}, 'other software')
    expect(output['unavailable'], [], 'everything was read')


def test_unavailable():
    steps, tables = script()
    for step in steps:
        del step[50], step[60]
        for pid in (100, 200):
            if pid in step:
                step[pid]['peak'] = None
    system = FakeSystem(steps, [None, tables[1]], memory=((None, 100.0, None), (7000.0, 150.0, 2.0)), battery=None, pss=None)
    output = run_script(system, projects_dir='/home/x/no-such-folder')
    check_shape(output, 'procfs')
    expect(output['unavailable'], ['battery', 'free', 'other', 'peak', 'pressure', 'pss', 'service', 'terminal',
                                   'transcript'], 'the readings that couldn\'t be taken')
    machine = output['machine']
    expect((machine['freeMB'], machine['swapUsedMB'], machine['pressure'], machine['pressureKind'], machine['battery']),
           (None, [100.0, 150.0], None, None, None), 'nothing stands in for a reading')
    expect((output['other'], output['roles']), (None, {'terminal': None, 'service': None}), 'other and the roles')
    expect((output['processes']['100']['peakMB'], output['processes']['100']['pssMB']), (None, None), 'peak and pss')
    # A helper that can't be read is counted, with no memory, and said
    steps, tables = script()
    for step in steps:
        step[110]['unreadable'] = True
    output = run_script(FakeSystem(steps, tables))
    expect(output['processes']['100']['helpers']['node'], {'count': 1, 'memoryMB': 0.0}, 'a helper that can\'t be read')
    expect(output['processes']['100']['childCpuMs'], 76.0, 'its CPU is left out')
    expect(output['unavailable'], ['helpers'], 'and the output says so')
    # No session at all is a process
    steps, tables = script()
    output = run_script(FakeSystem(steps, tables), sessions={777: 'cccccccc-1'})
    check_shape(output, 'procfs')
    expect(output['processes'], {}, 'no session is a process')


# A session (500) started by a shell (120) under another session (100). It ends inside the window with its helper
# (510), and the shell collects it: all its time, 10 s from before the window too, lands in the shell's
def test_session_inside_another():
    always = {1: proc(0, 'init', unreadable=True), 900: proc(1, 'python3')}
    b0 = dict(always)
    b0.update({100: proc(1, 'claude', cpu=1000), 120: proc(100, 'bash', cpu=10),
               500: proc(120, 'claude', cpu=9000, reaped=1000), 510: proc(500, 'node', cpu=400)})
    b1 = dict(always)
    b1.update({100: proc(1, 'claude', cpu=1020), 120: proc(100, 'bash', cpu=11),
               500: proc(120, 'claude', cpu=9030, reaped=1000), 510: proc(500, 'node', cpu=420)})
    # After that look 510 used 10 more and 500 collected it, 500 used 20 more, ended, and 120 collected it
    b2 = dict(always)
    b2.update({100: proc(1, 'claude', cpu=1040), 120: proc(100, 'bash', cpu=12, reaped=9050 + 1430)})
    system = FakeSystem([b0, b1, b2, dict(b2)], [None, None])
    output = run_script(system, sessions={100: 'aaaaaaaa-1', 500: 'bbbbbbbb-1'})
    outer, inner = output['processes']['100'], output['processes']['500']
    expect((inner['gone'], inner['cpuMs'], inner['childCpuMs']), (True, 30.0, 0.0), 'the inner session, as last read')
    # In all, 82 ms were used under the outer session inside the window: the shell's 2, the inner session's 50 and
    # its helper's 30. The inner one shows 30 of them; the rest is the outer one's children's, and not a ms from
    # before the window
    expect((outer['cpuMs'], outer['childCpuMs']), (40.0, 52.0), 'the outer session: what the inner one handed up, less its past')
    expect((outer['helpers'], outer['started'], inner['helpers']), ({'bash': {'count': 1, 'memoryMB': 1.0}}, {}, {}),
           'whose helpers are whose')
    # While both live, each has its own: nothing of the inner one is the outer one's
    system = FakeSystem([b0, b1, dict(b1), dict(b1)], [None, None])
    output = run_script(system, sessions={100: 'aaaaaaaa-1', 500: 'bbbbbbbb-1'})
    outer, inner = output['processes']['100'], output['processes']['500']
    expect((outer['cpuMs'], outer['childCpuMs'], inner['cpuMs'], inner['childCpuMs']), (20.0, 1.0, 30.0, 20.0),
           'two live sessions, one inside the other')
    expect((outer['helpers'], inner['helpers']), ({'bash': {'count': 1, 'memoryMB': 1.0}}, {'node': {'count': 1, 'memoryMB': 1.0}}),
           'each one\'s helpers')


# A process that becomes another program (exec) loses its waited-for time on macOS: that isn't CPU given back
def test_waited_for_time_forgotten():
    steps, tables = script()
    steps[0][110]['reaped'] = 700
    output = run_script(FakeSystem(steps, tables))
    expect(output['processes']['100']['childCpuMs'], 106.0, 'a helper whose waited-for time went back to zero')


def test_transcripts():
    work = tempfile.mkdtemp()
    try:
        os.makedirs(os.path.join(work, '-Users-x-myapp'))
        os.makedirs(os.path.join(work, '-Users-x-other'))
        with open(os.path.join(work, '-Users-x-myapp', 'aaaaaaaa-1.jsonl'), 'wb') as f:
            f.write(b'x' * 1048576 * 3)
        with open(os.path.join(work, '-Users-x-other', 'aaaaaaaa-1.jsonl'), 'wb') as f:
            f.write(b'x' * 1048576)
        os.utime(os.path.join(work, '-Users-x-other', 'aaaaaaaa-1.jsonl'), (1000, 1000))
        expect(sampler.transcript_sizes(work, ['aaaaaaaa-1', 'bbbbbbbb-1']), {'aaaaaaaa-1': 3.0, 'bbbbbbbb-1': None},
               'the latest written file\'s size')
        expect(sampler.transcript_sizes(os.path.join(work, 'none'), ['aaaaaaaa-1']), None, 'a folder that isn\'t there')
        steps, tables = script()
        output = run_script(FakeSystem(steps, tables), projects_dir=work)
        expect((output['processes']['100']['transcriptMB'], output['processes']['200']['transcriptMB']), (3.0, None),
               'the conversation files in the output')
    finally:
        shutil.rmtree(work)


# ---- the Linux reader, against a made-up /proc ----

def write_proc(root, pid, comm, ppid, cmdline=b'', status=True, exe=None, **stat):
    folder = os.path.join(root, str(pid))
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, 'stat'), 'w') as f:
        f.write(stat_line(pid, comm, ppid, **stat))
    with open(os.path.join(folder, 'cmdline'), 'wb') as f:
        f.write(cmdline)
    if status:
        rss_kb = stat.get('rss', 100) * 4
        with open(os.path.join(folder, 'status'), 'w') as f:
            f.write('Name:\t%s\nVmHWM:\t%d kB\nVmRSS:\t%d kB\nThreads:\t%d\nvoluntary_ctxt_switches:\t%d\n'
                    'nonvoluntary_ctxt_switches:\t%d\n' % (comm, rss_kb * 2, rss_kb, stat.get('threads', 1),
                                                           stat.get('utime', 0) * 10, stat.get('utime', 0)))
    link = os.path.join(folder, 'exe')
    if os.path.islink(link):
        os.unlink(link)
    if exe:
        os.symlink(exe, link)


def make_proc(root, modern):
    os.makedirs(os.path.join(root, 'self'))
    with open(os.path.join(root, 'self', 'stat'), 'w') as f:
        f.write(stat_line(900, 'python3', 100))
    with open(os.path.join(root, 'meminfo'), 'w') as f:
        f.write('MemTotal:       16777216 kB\nMemFree:         1048576 kB\n')
        if modern:
            f.write('MemAvailable:    8388608 kB\n')
        f.write('SwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n')
    if modern:
        os.makedirs(os.path.join(root, 'pressure'))
        with open(os.path.join(root, 'pressure', 'memory'), 'w') as f:
            f.write('some avg10=1.25 avg60=0.00 avg300=0.00 total=1000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')
    with open(os.path.join(root, 'uptime'), 'w') as f:
        f.write('1000.00 2000.00\n')
    write_proc(root, 1, 'systemd', 0, utime=100, status=False)
    write_proc(root, 50, 'gnome-terminal-', 1, exe='/usr/libexec/gnome-terminal-server', utime=500, rss=10000, threads=5)
    write_proc(root, 60, 'claude', 1, cmdline=b'/home/x/bin/claude\0daemon\0run\0', utime=200, rss=20000, threads=14)
    write_proc(root, 100, 'claude', 50, cmdline=b'claude\0', utime=1000, stime=200, cutime=300, cstime=100, rss=50000,
               threads=20, start=7777)
    write_proc(root, 110, 'python3', 100, exe='/usr/bin/python3.12', utime=30, rss=2500)
    write_proc(root, 300, 'a (b) c', 1, utime=400)
    write_proc(root, 900, 'python3', 100, utime=5)
    if modern:
        with open(os.path.join(root, '100', 'smaps_rollup'), 'w') as f:
            f.write('00400000-7ffc00000000 ---p 00000000 00:00 0    [rollup]\nRss:   200000 kB\nPss:   153600 kB\n')


def procfs_window(modern):
    root, power = tempfile.mkdtemp(), tempfile.mkdtemp()
    try:
        make_proc(root, modern)
        if modern:
            os.makedirs(os.path.join(power, 'BAT0'))
            for name, text in (('type', 'Battery\n'), ('status', 'Discharging\n')):
                with open(os.path.join(power, 'BAT0', name), 'w') as f:
                    f.write(text)
        else:
            shutil.rmtree(power)
        system = sampler.Procfs(proc=root, power=power)
        tick = 1000.0 / os.sysconf('SC_CLK_TCK')
        page = os.sysconf('SC_PAGE_SIZE') / 1048576.0
        clock = Clock()
        looks = []

        # Between two looks the made-up processes move on: the session works, a `git` comes and goes, an `sh` stays
        def wait(seconds):
            clock.wait(seconds)
            looks.append(1)
            if len(looks) == 1:
                write_proc(root, 100, 'claude', 50, cmdline=b'claude\0', utime=1010, stime=205, cutime=300, cstime=100,
                           rss=50100, threads=20, start=7777)
                write_proc(root, 120, 'git', 100, exe='/usr/bin/git', utime=2)
                write_proc(root, 130, 'sh', 110, exe='/usr/bin/dash', utime=1, rss=250)
            elif len(looks) == 2:
                shutil.rmtree(os.path.join(root, '120'))
                write_proc(root, 100, 'claude', 50, cmdline=b'claude\0', utime=1020, stime=210, cutime=303, cstime=101,
                           rss=50200, threads=21, start=7777)
                write_proc(root, 110, 'python3', 100, exe='/usr/bin/python3.12', utime=36, rss=2600)
                write_proc(root, 130, 'sh', 110, exe='/usr/bin/dash', utime=3, rss=250)
                write_proc(root, 300, 'a (b) c', 1, utime=450)
                write_proc(root, 50, 'gnome-terminal-', 1, exe='/usr/libexec/gnome-terminal-server', utime=520, rss=10000,
                           threads=5)
            return False

        args = sampler.PerfArgs('procfs', 1.0, 0.5, {100: 'aaaaaaaa-1'}, frozenset(['git', 'sh', 'python3']),
                                frozenset(['gnome-terminal-server']), None, '/home/x/out.json')
        output = sampler.sample(system, args, clock.now, wait, 900)
        check_shape(output, 'procfs')
        check_strings(output, ['git', 'sh', 'python3'])
        process = output['processes']['100']
        near(process['cpuMs'], 30 * tick, 'the session\'s CPU, from clock ticks')
        # 120 used 2 ticks from nothing and was waited for (in the session's 4 more ticks of cutime and cstime), 110
        # used 6 more, 130 used 3 from nothing: 4 + 6 + 3
        near(process['childCpuMs'], 13 * tick, 'its children\'s CPU')
        expect(process['memoryMB'], [round(50000 * 4 / 1024.0, 2), round(50200 * 4 / 1024.0, 2)], 'VmRSS at both ends')
        near(process['peakMB'], 50200 * 8 / 1024.0, 'VmHWM')
        expect((process['wakeups'], process['threads'], process['gone']), ({'involuntary': 20, 'voluntary': 200}, 21, False),
               'context switches and threads')
        expect(process['started'], {'git': 1, 'sh': 1}, 'the starts')
        expect(sorted(process['helpers']), ['python3', 'sh'], 'the helpers')
        near(process['helpers']['python3']['memoryMB'], 2600 * page, 'a helper\'s memory, from pages')
        expect(output['machine']['memoryMB'], 16384.0, 'MemTotal')
        expect(output['machine']['swapUsedMB'], [1024.0, 1024.0], 'SwapTotal less SwapFree')
        near(output['roles']['terminal']['cpuMs'], 20 * tick, 'the terminal, by its executable\'s name')
        expect((output['roles']['terminal']['count'], output['roles']['terminal']['threads']), (1, 5), 'the terminal')
        expect((output['roles']['service']['count'], output['roles']['service']['threads']), (1, 14), 'the service')
        # 1 and 300 (with parentheses in its name): 300 used 50 ticks
        near(output['other']['cpuMs'], 50 * tick, 'other software')
        expect(output['other']['over20'], 1, 'one used over 20 % of a core')
        if modern:
            expect((process['pssMB'], output['machine']['freeMB'], output['machine']['pressure'],
                    output['machine']['pressureKind'], output['machine']['battery'], output['unavailable']),
                   (150.0, [8192.0, 8192.0], [1.25, 1.25], 'psi', True, []), 'a kernel with everything')
        else:
            expect((process['pssMB'], output['machine']['freeMB'], output['machine']['pressure'],
                    output['machine']['pressureKind'], output['machine']['battery'], output['unavailable']),
                   (None, None, None, None, None, ['battery', 'free', 'pressure', 'pss']),
                   'an old kernel: no smaps_rollup, no MemAvailable, no /proc/pressure; and no power supply')
    finally:
        shutil.rmtree(root)
        shutil.rmtree(power, ignore_errors=True)


def test_procfs_modern():
    procfs_window(True)


def test_procfs_old_kernel():
    procfs_window(False)


def test_procfs_reader():
    root = tempfile.mkdtemp()
    try:
        make_proc(root, True)
        system = sampler.Procfs(proc=root, power=os.path.join(root, 'no-power'))
        expect(system.pids(), {1, 50, 60, 100, 110, 300, 900}, 'the pids: the folders that are numbers')
        expect(system.look(300), (1, 'a (b) c'), 'a name with spaces and parentheses')
        expect(system.look(4999999), None, 'a process that isn\'t there')
        expect((system.exe(110), system.exe(100)), ('python3.12', None), 'the executable\'s name')
        expect(system.args(60), ['/home/x/bin/claude', 'daemon', 'run'], 'the arguments')
        expect(system.usage(4999999), None, 'no reading of a process that isn\'t there')
        write_proc(root, 400, 'sleep', 100, state='Z', status=False)
        write_proc(root, 400, 'sleep', 100, state='Z', status=False, utime=3, cutime=2)
        tick = 1000.0 / os.sysconf('SC_CLK_TCK')
        got = system.usage(400)
        expect((400 in system.pids(), system.look(400), got['ended'], got['cpuMs'], got['reapedMs']),
               (True, None, True, 3 * tick, 2 * tick), 'a process that ended and wasn\'t collected: listed, gone, with its times')
        expect(system.usage(100)['ended'], False, 'a live process')
        expect(system.usage(1, True)['peakMB'], None, 'a process with no memory lines')
        expect(system.battery(), None, 'no power supply folder')
        try:
            sampler.Procfs(proc=os.path.join(root, 'none'))
        except OSError:
            pass
        else:
            raise AssertionError('a system with no /proc must be refused')
    finally:
        shutil.rmtree(root)


def main(argv):
    if argv[:1] == ['check']:
        if len(argv) != 8 or argv[7] not in ('yes', 'no'):
            sys.stderr.write(__doc__)
            return 2
        check(argv[1], argv[2], argv[3], argv[4], argv[5], argv[6], argv[7] == 'yes')
        return 0
    tests = [(name, value) for name, value in sorted(globals().items()) if name.startswith('test_') and callable(value)]
    for name, test in tests:
        test()
        print('ok: %s' % name[5:].replace('_', ' '))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
