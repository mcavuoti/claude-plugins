#!/usr/bin/env python3
"""The process sampler of /sessions debug perf: what every session's process did over one window, read from the system.

    sampler.py perf --how libproc|procfs --seconds 60 [--interval 0.5]
            --sessions <pid>:<sessionId>[,<pid>:<sessionId>...]
            --programs git,mv,mkdir,...       the program names the output may hold; any other program is `other`
            --terminals Terminal,iTerm2,...   the programs that are "the terminal"
            [--projects-dir <dir>]            the conversations, <dir>/*/<sessionId>.jsonl: the size of each session's
            --out <absolute file>             written once at the end (a file beside it, renamed over it)

It runs for the window and writes one JSON file, SamplerOutput in types.ts (format 1). SIGTERM or SIGINT closes the
window early: the file is written all the same, with the window as it was. Exit code 0 with the file written, 1 with
one line on stderr when --how can't work on this system, 2 for a command line it doesn't take.

--how says which system's readings to take (Libproc: macOS; Procfs: Linux). The program never looks at which system it
runs on: it does what --how says, or ends with code 1.

What it reads, and how:
- Each session's process, at the open, at every --interval and at the close: its CPU time, memory, wake-ups and
  threads. One that ends inside the window is `gone`, with its last reading. One that isn't there at the open, or
  can't be read, is left out of `processes`.
- The process list, at every --interval, with calls into the system and no process started: the processes under each
  session (its children, their children and so on). One that appears inside the window is a start, by program; the
  ones alive at the close are its helpers, with their memory. A process that lives shorter than about one interval can
  be missed, and so can one whose parent ended before it was seen: starts are under-read, and that's accepted.
- The CPU of a session's children: what the session and every process under it used over the window, less the
  session's own. A process's reading here is its own CPU time plus that of the children it has waited for, so a child
  that ended inside the window is counted through its parent; the readings taken at the open are taken off, so nothing
  from before the window is counted. A child nobody waited for is missed. A session started by a process under
  another session is counted on its own, not as the outer one's child. (The rules are above Trees.)
- Other software: the CPU time of every process outside the sessions' trees, the terminal, the service and the sampler
  itself, read once at the open and once at the close (macOS: two runs of ps, which can show the time of processes a
  normal user can't read; Linux: /proc). A process that ended inside the window is missed.
- The roles: the terminal is every process whose program is in --terminals; the service is Claude Code's background
  service, a process started as `claude daemon`. Their own CPU over the window, memory and threads at the close.
- The machine: cores, memory, and at both ends the memory free to use, the swap in use and the memory pressure; and
  whether it runs on battery.

A reading the system doesn't have, or that failed, is null and its name is in `unavailable`. Nothing stands in for it.

What the file holds: numbers, booleans, a few fixed words and program names from --programs. A process's program is the
first of these that's on the list: the name it was started as (its first argument, without the folders), the short
name the system keeps for it, its executable file's name. They differ where the system runs one program as another:
macOS runs `sh` as bash, and the developer tools' python3 as a program named Python (counted as `python3`). Anything
off the list is `other`. Paths, arguments, user and host names and session ids are never written: arguments are read
only for that first name and to tell the service, and of a conversation only its file's size.

The sampler and what it starts (the two ps on macOS), and a wrapper between a session and the sampler, are nobody's
starts, helpers or CPU, and are no part of the other software.

Standard library only, Python 3.7 or newer.
"""
import json
import os
import re
import struct
import sys
import time

FORMAT = 1
# The other software that counts as heavy: over this share of one core for the whole window
HEAVY_SHARE = 0.20
# How many times a new process's name is read: one caught between its fork and its exec shows its parent's
LOOKS = 3
# How far up a process's parents are followed
MAX_DEPTH = 64
# In the owner map: the sampler's own processes
MINE = -1
# The states of /proc/<pid>/stat for a process that ended and waits for its parent to collect it
ENDED = ('Z', 'X', 'x')
PROGRAM_NAME = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9._+-]{0,47}$')
SESSION_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
MB = 1048576.0
USAGE_LINE = ('usage: sampler.py perf --how libproc|procfs --seconds N [--interval S] --sessions PID:ID[,PID:ID...] '
              '--programs A,B,... --terminals A,B,... [--projects-dir DIR] --out FILE\n')


# --- reading text and bytes: pure, so each is tested with made-up input on either system -------------------------------

# ps's cumulative CPU time in ms: "M:SS.cc" on macOS, "[DD-]HH:MM:SS" on Linux. None when the text isn't one
def parse_cputime(text):
    text = text.strip().replace(',', '.')
    days = 0
    if '-' in text:
        head, text = text.split('-', 1)
        if not head.isdigit():
            return None
        days = int(head)
    parts = text.split(':')
    if not 1 <= len(parts) <= 3 or not all(p and p.replace('.', '', 1).isdigit() for p in parts):
        return None
    if any('.' in p for p in parts[:-1]):
        return None
    seconds = float(parts[-1])
    if len(parts) > 1:
        seconds += 60 * int(parts[-2])
    if len(parts) > 2:
        seconds += 3600 * int(parts[-3])
    return (days * 86400 + seconds) * 1000.0


# The lines of `ps -axo pid=,time=`: {pid: CPU time in ms}. A line that isn't a pid and a time is skipped
def parse_ps_times(text):
    out = {}
    for line in text.splitlines():
        words = line.split()
        if len(words) != 2 or not words[0].isdigit():
            continue
        ms = parse_cputime(words[1])
        if ms is not None:
            out[int(words[0])] = ms
    return out


# /proc/<pid>/stat: the fields used here, times in clock ticks and rss in pages. The program's name sits between the
# first "(" and the last ")", and may itself hold spaces and parentheses. None when the text isn't a stat line
def parse_stat(text):
    left, right = text.find('('), text.rfind(')')
    if left < 0 or right < left:
        return None
    rest = text[right + 1:].split()
    if len(rest) < 22:
        return None
    try:
        return {'comm': text[left + 1:right], 'state': rest[0], 'ppid': int(rest[1]), 'utime': int(rest[11]),
                'stime': int(rest[12]), 'cutime': int(rest[13]), 'cstime': int(rest[14]), 'threads': int(rest[17]),
                'start': int(rest[19]), 'rss': int(rest[21])}
    except ValueError:
        return None


# /proc/<pid>/status: resident size and its peak in kB, threads, context switches. A line that's missing gives None
def parse_status(text):
    want = {'VmRSS': 'rss', 'VmHWM': 'peak', 'Threads': 'threads', 'voluntary_ctxt_switches': 'voluntary',
            'nonvoluntary_ctxt_switches': 'involuntary'}
    out = {'rss': None, 'peak': None, 'threads': None, 'voluntary': None, 'involuntary': None}
    for line in text.splitlines():
        key, colon, value = line.partition(':')
        words = value.split()
        if colon and key in want and words and words[0].isdigit():
            out[want[key]] = int(words[0])
    return out


# /proc/meminfo: {name: kB}
def parse_meminfo(text):
    out = {}
    for line in text.splitlines():
        key, colon, value = line.partition(':')
        words = value.split()
        if colon and words and words[0].isdigit():
            out[key.strip()] = int(words[0])
    return out


# /proc/pressure/memory: the `some avg10` value, the percent of the last 10 s in which a task waited for memory. None
# when the text has none
def parse_pressure(text):
    for line in text.splitlines():
        words = line.split()
        if words[:1] != ['some']:
            continue
        for word in words[1:]:
            key, eq, value = word.partition('=')
            if key == 'avg10' and eq:
                try:
                    return float(value)
                except ValueError:
                    return None
    return None


# /proc/<pid>/smaps_rollup: the proportional size in kB, or None
def parse_pss(text):
    for line in text.splitlines():
        key, colon, value = line.partition(':')
        words = value.split()
        if colon and key == 'Pss' and words and words[0].isdigit():
            return int(words[0])
    return None


# /proc/<pid>/cmdline: the arguments, which the kernel separates with a zero byte
def parse_cmdline(raw):
    return [part.decode('utf-8', 'replace') for part in raw.split(b'\0') if part]


# What /sys/class/power_supply says, as one {'type', 'status', 'scope'} per supply: True on battery, False on mains,
# None where the machine has no supply of its own to ask (a server, a desktop). A mouse's or a keyboard's battery
# (scope Device) isn't the machine's
def on_battery_supplies(supplies):
    own = [s for s in supplies if s.get('scope') != 'Device']
    batteries = [s for s in own if s.get('type') == 'Battery']
    if any(s.get('status') == 'Discharging' for s in batteries):
        return True
    if batteries or any(s.get('type') in ('Mains', 'USB') for s in own):
        return False
    return None


# macOS's sysctl vm.swapusage, a struct xsw_usage (total, available and used bytes, page size, encrypted): the bytes in
# use. None when it's too short
def parse_swapusage(raw):
    if len(raw) < 24:
        return None
    return struct.unpack_from('<3Q', raw)[2]


# macOS's rusage_info_v4 (proc_pid_rusage, flavor 4) as a reading. Its times are in mach time units, each worth
# ns_per_unit nanoseconds; the peak is 0 on a system that doesn't keep it. A process that ended and waits for its
# parent to collect it still answers, with an exit time: `ended`. None when it's too short
def parse_rusage(raw, ns_per_unit):
    if len(raw) < 296:
        return None
    f = struct.unpack_from('<16s35Q', raw)
    return {'start': f[9], 'ended': f[10] != 0, 'cpuMs': (f[1] + f[2]) * ns_per_unit / 1e6,
            'reapedMs': (f[11] + f[12]) * ns_per_unit / 1e6, 'memoryMB': f[8] / MB, 'peakMB': f[29] / MB if f[29] else None,
            'wakeups': {'idle': f[3], 'interrupt': f[4]}, 'threads': None}


# macOS's proc_bsdshortinfo (proc_pidinfo, flavor 13): (parent pid, the program's short name). None when it's too short
def parse_shortinfo(raw):
    if len(raw) < 64:
        return None
    f = struct.unpack_from('<4I16s', raw)
    return f[1], f[4].split(b'\0')[0].decode('utf-8', 'replace')


# macOS's proc_taskinfo (proc_pidinfo, flavor 4): the number of threads. None when it's too short
def parse_taskinfo(raw):
    if len(raw) < 96:
        return None
    return struct.unpack_from('<6Q12i', raw)[15]


# macOS's sysctl kern.procargs2: the count of arguments, the executable's path, zero bytes, then the arguments and the
# environment, each ended by a zero byte. Only the arguments are returned
def parse_procargs(raw):
    if len(raw) < 4:
        return []
    count = struct.unpack_from('<i', raw)[0]
    rest = raw[4:]
    end = rest.find(b'\0')
    if count <= 0 or end < 0:
        return []
    parts = rest[end:].lstrip(b'\0').split(b'\0', count)
    return [part.decode('utf-8', 'replace') for part in parts[:count]]


# macOS's vm_statistics64 (host_statistics64): the pages free to use, the free ones and the inactive ones (kept only
# until something needs them). None when it's too short
def parse_vm_free_pages(raw):
    if len(raw) < 12:
        return None
    free, _active, inactive = struct.unpack_from('<3I', raw)
    return free + inactive


# What macOS says is providing power: on battery or not
def on_battery_source(kind):
    return kind == 'Battery Power'


# The name a process is counted under: the first of its names (some may be None) that is on the list, itself or as the
# name the system's `same` gives for it; None when none is (the caller counts it as `other`)
def program_of(candidates, names, same):
    for name in candidates:
        if name is None:
            continue
        if name in names:
            return name
        if same.get(name) in names:
            return same[name]
    return None


# The name a process was started as: its first argument without the folders, and without the "-" a login shell gets
def started_as(args):
    return (os.path.basename(args[0]).lstrip('-') or None) if args else None


# Claude Code's background service, from a process's arguments: `claude daemon ...`
def is_service(args):
    return len(args) >= 2 and os.path.basename(args[0]) == 'claude' and args[1] == 'daemon'


# "<pid>:<sessionId>,<pid>:<sessionId>": {pid: sessionId}, or None when it isn't that
def parse_sessions(text):
    out = {}
    for item in text.split(','):
        pid, colon, session = item.partition(':')
        if not colon or not pid.isdigit() or int(pid) <= 1 or not SESSION_ID.match(session):
            return None
        out[int(pid)] = session
    return out


# A list of program names, "a,b,c": the names, or None when one of them isn't a plain name (it could be written out)
def parse_names(text):
    names = [name for name in text.split(',') if name]
    if not all(PROGRAM_NAME.match(name) for name in names):
        return None
    return names


class PerfArgs:
    def __init__(self, how, seconds, interval, sessions, programs, terminals, projects_dir, out):
        self.how, self.seconds, self.interval, self.sessions = how, seconds, interval, sessions
        self.programs, self.terminals, self.projects_dir, self.out = programs, terminals, projects_dir, out


# The command line, read by hand as watcher.py does. None: not a command line this takes
def perf_args(argv):
    names = ('--how', '--seconds', '--interval', '--sessions', '--programs', '--terminals', '--projects-dir', '--out')
    got = {}
    i = 0
    while i < len(argv):
        name, eq, value = argv[i].partition('=')
        if name not in names:
            return None
        if not eq:
            if i + 1 >= len(argv):
                return None
            value = argv[i + 1]
            i += 1
        got[name] = value
        i += 1
    if any(name not in got for name in ('--how', '--seconds', '--sessions', '--programs', '--terminals', '--out')):
        return None
    try:
        seconds, interval = float(got['--seconds']), float(got.get('--interval', '0.5'))
    except ValueError:
        return None
    if not 0 < seconds <= 86400 or not 0.01 <= interval <= 86400:
        return None
    sessions, programs = parse_sessions(got['--sessions']), parse_names(got['--programs'])
    terminals = [name for name in got['--terminals'].split(',') if name]
    if got['--how'] not in SYSTEMS or sessions is None or programs is None or not os.path.isabs(got['--out']):
        return None
    return PerfArgs(got['--how'], seconds, interval, sessions, frozenset(programs), frozenset(terminals),
                    got.get('--projects-dir'), got['--out'])


# --- the two systems --------------------------------------------------------------------------------------------------
#
# Each gives the same readings to sample() below:
#   pids()             every process there is
#   look(pid)          (its parent, its short name), or None once it's gone
#   exe(pid)           its executable file's name, or None where it can't be read
#   args(pid)          its arguments, or [] where they can't be read
#   usage(pid, full)   a reading: start (which process this is), cpuMs (its own), reapedMs (the children it waited
#                      for), memoryMB, and with full also peakMB, wakeups and threads where the system has them. None
#                      once it's gone, or where it can't be read
#                      (a process that ended and waits for its parent to collect it is still in pids() and gone for
#                      look(); usage() still reads its times, with `ended` true)
#   pss(pid)           its proportional size in MB, or None
#   cpu_table()        {pid: its own CPU time in ms} of every process, or None
#   machine()          (cores, memory in MB)
#   memory_now()       (free to use in MB, swap in use in MB, pressure), each None where it can't be read
#   battery()          True, False, or None where it can't be told
#   same               {a program's name here: the name it's known by}, for the programs the system runs under another
# A constructor that can't work on this system raises OSError (or AttributeError, for a call the system lacks).

class Libproc:
    """macOS: libproc and sysctl through ctypes, and ps for the processes a normal user can't read"""
    how = 'libproc'
    memory_kind = 'footprint'
    pressure_kind = 'level'
    # The developer tools' python3 is a launcher that runs a program named Python
    same = {'Python': 'python3'}

    def __init__(self):
        import ctypes
        self.c = c = ctypes
        self.proc = proc = c.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        self.libc = libc = c.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        proc.proc_listpids.argtypes = [c.c_uint32, c.c_uint32, c.c_void_p, c.c_int]
        proc.proc_pidinfo.argtypes = [c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int]
        proc.proc_pid_rusage.argtypes = [c.c_int, c.c_int, c.c_void_p]
        proc.proc_pidpath.argtypes = [c.c_int, c.c_void_p, c.c_uint32]
        libc.sysctl.argtypes = [c.POINTER(c.c_int), c.c_uint, c.c_void_p, c.POINTER(c.c_size_t), c.c_void_p, c.c_size_t]
        libc.sysctlbyname.argtypes = [c.c_char_p, c.c_void_p, c.POINTER(c.c_size_t), c.c_void_p, c.c_size_t]
        libc.mach_host_self.restype = c.c_uint
        libc.host_statistics64.argtypes = [c.c_uint, c.c_int, c.c_void_p, c.POINTER(c.c_uint)]
        timebase = (c.c_uint32 * 2)()
        if libc.mach_timebase_info(timebase) != 0 or not timebase[1]:
            raise OSError('mach_timebase_info failed')
        self.ns_per_unit = timebase[0] / timebase[1]
        self.host = libc.mach_host_self()
        self.pid_buf = (c.c_int * 4096)()
        self.rusage_buf = c.create_string_buffer(296)
        self.short_buf = c.create_string_buffer(64)
        self.task_buf = c.create_string_buffer(96)
        self.path_buf = c.create_string_buffer(4096)
        self.args_buf = None
        self.page = self.sysctl_int('hw.pagesize')
        self.pids()
        if not self.page:
            raise OSError('hw.pagesize can\'t be read')

    # A sysctl value's bytes, or None
    def sysctl_raw(self, name, room=64):
        c = self.c
        buf, size = c.create_string_buffer(room), c.c_size_t(room)
        if self.libc.sysctlbyname(name.encode(), buf, c.byref(size), None, 0) != 0:
            return None
        return buf.raw[:size.value]

    # A sysctl number (4 or 8 bytes), or None
    def sysctl_int(self, name):
        raw = self.sysctl_raw(name)
        if raw is None or len(raw) not in (4, 8):
            return None
        return struct.unpack('<i' if len(raw) == 4 else '<q', raw)[0]

    def pids(self):
        c = self.c
        while True:
            room = c.sizeof(self.pid_buf)
            n = self.proc.proc_listpids(1, 0, self.pid_buf, room)  # PROC_ALL_PIDS
            if n <= 0:
                raise OSError('the process list can\'t be read (proc_listpids)')
            if n < room:
                break
            self.pid_buf = (c.c_int * (len(self.pid_buf) * 2))()
        out = set(self.pid_buf[:n // 4])
        out.discard(0)
        return out

    def look(self, pid):
        if self.proc.proc_pidinfo(pid, 13, 0, self.short_buf, 64) < 64:  # PROC_PIDT_SHORTBSDINFO: any process
            return None
        return parse_shortinfo(self.short_buf.raw)

    def exe(self, pid):
        n = self.proc.proc_pidpath(pid, self.path_buf, 4096)
        if n <= 0:
            return None
        return os.path.basename(self.c.string_at(self.path_buf, n).decode('utf-8', 'replace'))

    def args(self, pid):
        c = self.c
        if self.args_buf is None:
            self.args_buf = c.create_string_buffer(max(self.sysctl_int('kern.argmax') or 0, 262144))
        size = c.c_size_t(len(self.args_buf))
        if self.libc.sysctl((c.c_int * 3)(1, 49, pid), 3, self.args_buf, c.byref(size), None, 0) != 0:  # KERN_PROCARGS2
            return []
        return parse_procargs(self.c.string_at(self.args_buf, size.value))

    def usage(self, pid, full=False):
        if self.proc.proc_pid_rusage(pid, 4, self.rusage_buf) != 0:  # RUSAGE_INFO_V4: the user's own processes
            return None
        reading = parse_rusage(self.rusage_buf.raw, self.ns_per_unit)
        if full and self.proc.proc_pidinfo(pid, 4, 0, self.task_buf, 96) >= 96:  # PROC_PIDTASKINFO
            reading['threads'] = parse_taskinfo(self.task_buf.raw)
        return reading

    def pss(self, pid):
        return None

    # Two of these in a window, one at each end: ps is the one program that shows the CPU time of every process,
    # root's too. Its own line is taken out
    def cpu_table(self):
        import subprocess
        try:
            ps = subprocess.Popen(['/bin/ps', '-axo', 'pid=,time='], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env={'LC_ALL': 'C', 'PATH': '/usr/bin:/bin'})
        except OSError:
            return None
        try:
            out = ps.communicate(timeout=20)[0]
        except subprocess.SubprocessError:
            ps.kill()
            ps.communicate()
            return None
        table = parse_ps_times(out.decode('ascii', 'replace')) if ps.returncode == 0 else {}
        table.pop(ps.pid, None)
        return table or None

    def machine(self):
        cores, memory = self.sysctl_int('hw.ncpu'), self.sysctl_int('hw.memsize')
        if not cores or not memory:
            raise OSError('hw.ncpu and hw.memsize can\'t be read')
        return cores, memory / MB

    def memory_now(self):
        c = self.c
        free = swap = None
        buf, count = (c.c_uint32 * 64)(), c.c_uint(64)
        if self.libc.host_statistics64(self.host, 4, buf, c.byref(count)) == 0:  # HOST_VM_INFO64
            pages = parse_vm_free_pages(bytes(buf))
            free = None if pages is None else pages * self.page / MB
        raw = self.sysctl_raw('vm.swapusage')
        used = None if raw is None else parse_swapusage(raw)
        if used is not None:
            swap = used / MB
        return free, swap, self.sysctl_int('kern.memorystatus_vm_pressure_level')

    # Which source provides power, asked of IOKit: no program is started for it
    def battery(self):
        c = self.c
        try:
            iokit = c.CDLL('/System/Library/Frameworks/IOKit.framework/IOKit')
            cf = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
            iokit.IOPSCopyPowerSourcesInfo.restype = c.c_void_p
            iokit.IOPSGetProvidingPowerSourceType.restype = c.c_void_p
            iokit.IOPSGetProvidingPowerSourceType.argtypes = [c.c_void_p]
            cf.CFStringGetCString.argtypes = [c.c_void_p, c.c_char_p, c.c_long, c.c_uint32]
            cf.CFRelease.argtypes = [c.c_void_p]
        except (AttributeError, OSError):
            return None
        info = iokit.IOPSCopyPowerSourcesInfo()
        if not info:
            return None
        try:
            kind, text = iokit.IOPSGetProvidingPowerSourceType(info), c.create_string_buffer(64)
            if not kind or not cf.CFStringGetCString(kind, text, 64, 0x08000100):  # UTF-8
                return None
            return on_battery_source(text.value.decode('utf-8', 'replace'))
        finally:
            cf.CFRelease(info)


class Procfs:
    """Linux: /proc and /sys, and no program started at all"""
    how = 'procfs'
    memory_kind = 'rss'
    pressure_kind = 'psi'
    same = {}

    # The two folders can be pointed elsewhere, for a test with made-up files
    def __init__(self, proc='/proc', power='/sys/class/power_supply'):
        self.proc, self.power = proc, power
        if self.read('%s/self/stat' % proc) is None:
            raise OSError('%s/self/stat can\'t be read' % proc)
        self.tick_ms = 1000.0 / os.sysconf('SC_CLK_TCK')
        self.page_mb = os.sysconf('SC_PAGE_SIZE') / MB

    # A file's text, or None when it isn't there, can't be read, or its process ended meanwhile
    @staticmethod
    def read(path, raw=False):
        try:
            with open(path, 'rb') as f:
                data = f.read()
        except OSError:
            return None
        return data if raw else data.decode('utf-8', 'replace')

    def pids(self):
        return {int(name) for name in os.listdir(self.proc) if name.isdigit()}

    def stat(self, pid):
        text = self.read('%s/%d/stat' % (self.proc, pid))
        return None if text is None else parse_stat(text)

    def look(self, pid):
        st = self.stat(pid)
        return None if st is None or st['state'] in ENDED else (st['ppid'], st['comm'])

    def exe(self, pid):
        try:
            name = os.path.basename(os.readlink('%s/%d/exe' % (self.proc, pid)))
        except OSError:
            return None
        return name[:-10] if name.endswith(' (deleted)') else name

    def args(self, pid):
        raw = self.read('%s/%d/cmdline' % (self.proc, pid), raw=True)
        return [] if raw is None else parse_cmdline(raw)

    def usage(self, pid, full=False):
        st = self.stat(pid)
        if st is None:
            return None
        reading = {'start': st['start'], 'ended': st['state'] in ENDED, 'cpuMs': (st['utime'] + st['stime']) * self.tick_ms,
                   'reapedMs': (st['cutime'] + st['cstime']) * self.tick_ms, 'memoryMB': st['rss'] * self.page_mb,
                   'peakMB': None, 'wakeups': None, 'threads': st['threads']}
        if full:
            status = parse_status(self.read('%s/%d/status' % (self.proc, pid)) or '')
            if status['rss'] is not None:
                reading['memoryMB'] = status['rss'] / 1024.0
            if status['peak'] is not None:
                reading['peakMB'] = status['peak'] / 1024.0
            if status['voluntary'] is not None and status['involuntary'] is not None:
                reading['wakeups'] = {'voluntary': status['voluntary'], 'involuntary': status['involuntary']}
        return reading

    # Linux 4.14 and later; an older kernel has no such file
    def pss(self, pid):
        text = self.read('%s/%d/smaps_rollup' % (self.proc, pid))
        kb = None if text is None else parse_pss(text)
        return None if kb is None else kb / 1024.0

    def cpu_table(self):
        table = {}
        for pid in self.pids():
            st = self.stat(pid)
            if st is not None:
                table[pid] = (st['utime'] + st['stime']) * self.tick_ms
        return table or None

    def machine(self):
        cores, total = os.cpu_count(), parse_meminfo(self.read('%s/meminfo' % self.proc) or '').get('MemTotal')
        if not cores or not total:
            raise OSError('the cores and /proc/meminfo\'s MemTotal can\'t be read')
        return cores, total / 1024.0

    # MemAvailable is Linux 3.14 and later, /proc/pressure 4.20 and later (and only where the kernel was built with it)
    def memory_now(self):
        info = parse_meminfo(self.read('%s/meminfo' % self.proc) or '')
        free = info['MemAvailable'] / 1024.0 if 'MemAvailable' in info else None
        swap = (info['SwapTotal'] - info['SwapFree']) / 1024.0 if 'SwapTotal' in info and 'SwapFree' in info else None
        text = self.read('%s/pressure/memory' % self.proc)
        return free, swap, None if text is None else parse_pressure(text)

    def battery(self):
        folder = self.power
        try:
            names = os.listdir(folder)
        except OSError:
            return None
        supplies = []
        for name in names:
            supply = {}
            for key in ('type', 'status', 'scope'):
                text = self.read('%s/%s/%s' % (folder, name, key))
                if text is not None:
                    supply[key] = text.strip()
            supplies.append(supply)
        return on_battery_supplies(supplies)


SYSTEMS = {'libproc': Libproc, 'procfs': Procfs}


# --- the window -------------------------------------------------------------------------------------------------------

class Group:
    """A session: its process and the processes under it. The sampler's own processes are a group too (Trees.mine),
    with no process of its own"""

    def __init__(self):
        self.open = None      # its process's reading at the open
        self.last = None      # its process's latest reading while it lived
        self.final = None     # the last reading of all: one taken after it ended too, until its parent collected it
        self.gone = False
        self.handed = False   # it ended and its parent collected it: all its CPU time is in its parent's now
        self.members = set()  # the processes under it that are there (not those under a session inside it)
        self.base = {}        # the ones under it at the open: (own CPU, waited-for children's CPU), in ms
        self.unread = set()   # the ones under it at the open that couldn't be read
        self.started = {}     # the ones that appeared inside the window: their program, or None for `other`
        self.inside = []      # the sessions right inside it (a session started by a process under it)
        self.below = 0.0      # what the processes under it used over the window, in ms (settle)
        self.helpers = {}     # the ones alive at the close, by program (settle)
        self.children = None  # its children's CPU over the window, in ms (children)


# What a process used between two readings: (its own CPU, its waited-for children's), in ms. Neither goes below zero:
# macOS forgets a process's waited-for time when it becomes another program (exec)
def spent(first, last):
    return max(0.0, last['cpuMs'] - first['cpuMs']), max(0.0, last['reapedMs'] - first['reapedMs'])


# The CPU of a session's children, and why it's done this way.
#
# A process's reading has its own CPU time and the time of the children it has waited for. When a process ends and its
# parent collects it, both go into the parent's waited-for time. So over a session's process and every process under it,
# the sum of own plus waited-for only grows by the CPU they use: taking the sum at the close, less the sum at the open,
# gives what the whole tree used, the processes that came and went inside the window included, with no need to have seen
# them. The session's own CPU taken off, that's its children's.
#
# What has to be right for the sum to hold, and is handled here:
# - A process under the session at the open is in the sum at the open, whatever becomes of it (Group.base).
# - A process that ended and wasn't collected yet still holds its time (a reading marked `ended`).
# - A session inside another (started by a process under it) is counted on its own, and what the outer one's sum got
#   from it is taken off: all its time, the time from before the window too, once it ended and was collected (under()).
# - The sampler's own processes, where a session started the sampler, are a group taken off the same way.
# What isn't, and under- or over-reads: a child nobody waits for; a process under the session at the open that can't be
# read (another user's, such as a setuid program) or had ended already, whose whole time arrives when it's collected;
# and on macOS the waited-for time a process had before it became another program.

class Trees:
    """Which process is under which session, kept up with each look at the process list"""

    def __init__(self, system, session_pids, programs, me):
        self.system, self.programs, self.me = system, programs, me
        self.sessions = {pid: Group() for pid in session_pids}
        self.mine = Group()
        self.mine_outer = None  # the session the sampler was started under
        self.parent = {}        # every process there is: its parent
        self.comm = {}          # every process there is: its short name
        self.owner = {}         # a process: the session it's under (a session: itself), MINE, or None
        self.pending = {}       # a new process: how many times its name was read
        self.looks = 0
        self.unreadable_helper = False

    # The session a process is under (a session's pid), MINE for the sampler's own, None for neither. A session inside
    # another session is its own: what's under it isn't the outer one's
    def owner_of(self, pid):
        chain, p = [], pid
        while True:
            if p in self.owner:
                found = self.owner[p]
                break
            chain.append(p)
            up = self.parent.get(p)
            if up is None or up <= 1 or len(chain) > MAX_DEPTH:
                found = None
                break
            if up in self.sessions and not self.sessions[up].gone:
                found = up
                break
            p = up
        for p in chain:
            self.owner[p] = found
        return found

    def group(self, owner):
        return self.mine if owner == MINE else self.sessions.get(owner)

    # A process's program, or None for one off the list. Each of its names is read only when the one before didn't do
    def program(self, pid):
        system = self.system

        def names():
            yield started_as(system.args(pid))
            yield self.comm.get(pid)
            yield system.exe(pid)

        return program_of(names(), self.programs, system.same)

    # One look at the process list: who went, who came. Returns the new ones
    def look(self):
        system = self.system
        self.looks += 1
        pids = system.pids()
        for pid in [p for p in self.parent if p not in pids]:
            group = self.group(self.owner.get(pid))
            if group is not None:
                group.members.discard(pid)
            if pid not in self.sessions:
                self.owner.pop(pid, None)
            del self.parent[pid]
            self.comm.pop(pid, None)
            self.pending.pop(pid, None)
        fresh = []
        for pid in pids:
            if pid in self.parent:
                continue
            got = system.look(pid)
            if got is not None:
                self.parent[pid], self.comm[pid] = got
                fresh.append(pid)
        return fresh

    # The open: every session's first reading, which session is inside which, the processes already under each, and the
    # sampler's own set apart
    def start(self):
        system = self.system
        fresh = self.look()
        for pid in list(self.sessions):
            reading = system.usage(pid, True) if pid in self.parent else None
            if reading is None or reading['ended']:
                del self.sessions[pid]
                continue
            session = self.sessions[pid]
            session.open = session.last = session.final = reading
        for pid in self.sessions:
            self.owner[pid] = pid
        # The sampler, and a wrapper between a session and the sampler: nobody's helpers
        self.owner[self.me] = MINE
        chain, p = [], self.parent.get(self.me)
        while p is not None and p > 1 and p not in self.sessions and len(chain) < MAX_DEPTH:
            chain.append(p)
            p = self.parent.get(p)
        if p in self.sessions:
            self.mine_outer = p
            for wrapper in chain:
                self.owner[wrapper] = MINE
        for pid in self.sessions:
            up = self.parent.get(pid)
            outer = self.owner_of(up) if up is not None and up > 1 else None
            if outer in self.sessions:
                self.sessions[outer].inside.append(pid)
        for pid in fresh:
            if pid in self.sessions:
                continue
            group = self.group(self.owner_of(pid))
            if group is None:
                continue
            group.members.add(pid)
            reading = system.usage(pid)
            if reading is None:
                group.unread.add(pid)
            else:
                group.base[pid] = (reading['cpuMs'], reading['reapedMs'])

    # A look inside the window, and the one at the close: the new processes under a session are starts, a new one's
    # name is read again while it lives, and each session is read
    def tick(self):
        system = self.system
        fresh = self.look()
        for pid in list(self.pending):
            got = system.look(pid)
            if got is not None:
                self.comm[pid] = got[1]
                self.sessions[self.owner[pid]].started[pid] = self.program(pid)
            self.pending[pid] += 1
            if got is None or self.pending[pid] >= LOOKS:
                del self.pending[pid]
        for pid in fresh:
            if pid in self.sessions:
                continue
            group = self.group(self.owner_of(pid))
            if group is None:
                continue
            group.members.add(pid)
            if group is not self.mine:
                group.started[pid] = self.program(pid)
                self.pending[pid] = 1
        for pid, session in self.sessions.items():
            if session.gone:
                continue
            reading = system.usage(pid, True) if pid in self.parent else None
            if reading is None or reading['ended'] or reading['start'] != session.open['start']:
                session.gone = True
            else:
                session.last = session.final = reading

    # Every process that is a session, under one, or the sampler's own
    def taken(self):
        return {pid for pid, owner in self.owner.items() if owner is not None} | set(self.sessions) | {self.me}

    # After the look at the close: what the processes under each session used and which are its helpers, and what
    # became of a session that ended
    def settle(self):
        system = self.system
        for group in list(self.sessions.values()) + [self.mine]:
            counted = set()
            for member in sorted(group.members):
                reading = system.usage(member)
                if reading is None and system.look(member) is None:
                    continue  # collected since the look: its time went to its parent
                counted.add(member)
                if group is not self.mine and (reading is None or not reading['ended']):
                    helper = group.helpers.setdefault(self.program(member) or 'other', {'count': 0, 'memoryMB': 0.0})
                    helper['count'] += 1
                    if reading is None:
                        self.unreadable_helper = True
                    else:
                        helper['memoryMB'] += reading['memoryMB']
                if reading is None or member in group.unread:
                    continue
                base = group.base.get(member, (0.0, 0.0))
                group.below += max(0.0, reading['cpuMs'] - base[0]) + max(0.0, reading['reapedMs'] - base[1])
            # One that was under it at the open and is no more: its parent has its time now
            for member, base in group.base.items():
                if member not in counted:
                    group.below -= base[0] + base[1]
        for pid, session in self.sessions.items():
            if not session.gone:
                continue
            reading = system.usage(pid) if pid in self.parent else None
            if reading is not None and reading['ended']:
                session.final = reading
            else:
                session.handed = True

    # What the processes under a session used over the window, with the sessions inside it and the sampler's own. An
    # inner session that ended and was collected has put all its time in a process of this one, the time from before
    # the window too: its reading at the open is taken off
    def under(self, pid):
        session = self.sessions[pid]
        total = session.below + (self.mine.below if self.mine_outer == pid else 0.0)
        for inner_pid in session.inside:
            inner = self.sessions[inner_pid]
            total += self.under(inner_pid)
            if inner.handed:
                total -= inner.open['cpuMs'] + inner.open['reapedMs']
            else:
                total += sum(spent(inner.open, inner.final))
        return total

    # The CPU of a session's children: what it waited for and what's under it, less what the sessions inside it are
    # counted for and the sampler's own. So each ms is counted once, in the innermost session that shows it
    def children(self, pid):
        session = self.sessions[pid]
        if session.children is None:
            total = spent(session.open, session.final)[1] + self.under(pid) - sum(self.counted(inner) for inner in session.inside)
            if self.mine_outer == pid:
                total -= max(0.0, self.mine.below)
            session.children = max(0.0, total)
        return session.children

    # What the output counts for a session in all: its own CPU, its children's, and the same for the sessions inside it
    def counted(self, pid):
        session = self.sessions[pid]
        return spent(session.open, session.final)[0] + self.children(pid) + sum(self.counted(inner) for inner in session.inside)

    # One session's part of the output, after settle()
    def result(self, pid, memory_kind):
        session = self.sessions[pid]
        first, last = session.open, session.last
        own = spent(first, session.final)[0]
        child_ms = self.children(pid)
        for helper in session.helpers.values():
            helper['memoryMB'] = round(helper['memoryMB'], 2)
        started = {}
        for name in session.started.values():
            started[name or 'other'] = started.get(name or 'other', 0) + 1
        wakeups = None
        if first['wakeups'] is not None and last['wakeups'] is not None:
            wakeups = {kind: max(0, last['wakeups'][kind] - first['wakeups'][kind]) for kind in sorted(last['wakeups'])}
        return {
            'cpuMs': round(own, 1),
            'childCpuMs': round(child_ms, 1),
            'memoryMB': [round(first['memoryMB'], 2), round(last['memoryMB'], 2)],
            'memoryKind': memory_kind,
            'peakMB': None if last['peakMB'] is None else round(last['peakMB'], 2),
            'pssMB': None,
            'wakeups': wakeups,
            'threads': last['threads'],
            'gone': session.gone,
            'started': started,
            'helpers': session.helpers,
            'transcriptMB': None,
        }


# The processes that play a role, among `pids`: the terminal by its program, the service by how it was started
def find_roles(system, trees, pids, terminals):
    taken = trees.taken()
    found = {'terminal': set(), 'service': set()}
    for pid in pids:
        if pid in taken:
            continue
        comm = trees.comm.get(pid)
        if comm in terminals or system.exe(pid) in terminals:
            found['terminal'].add(pid)
        elif is_service(system.args(pid)):
            found['service'].add(pid)
    return found


# A full reading of a process that is alive, or None
def live_reading(system, pid):
    reading = system.usage(pid, True)
    return None if reading is None or reading['ended'] else reading


# A role's part of the output from its processes' readings at both ends ({pid: reading or None}): how many are alive at
# the close, their own CPU over the window, their memory and threads at the close. None when no reading could be taken
def role_result(first, last):
    if not any(reading is not None for reading in list(first.values()) + list(last.values())):
        return None
    alive = {pid: reading for pid, reading in last.items() if reading is not None}
    cpu = 0.0
    for pid, reading in alive.items():
        before = first.get(pid)
        same = before is not None and before['start'] == reading['start']
        cpu += max(0.0, reading['cpuMs'] - (before['cpuMs'] if same else 0.0))
    threads = [reading['threads'] for reading in alive.values()]
    return {'count': len(alive), 'cpuMs': round(cpu, 1),
            'memoryMB': round(sum(reading['memoryMB'] for reading in alive.values()), 2),
            'threads': None if any(n is None for n in threads) else sum(threads)}


# Other software's part of the output from the CPU tables at both ends, leaving out the pids in `skip`: its CPU in all,
# the largest single process's, and how many used more than HEAVY_SHARE of a core. A process that wasn't there at the
# open, or whose time went down (its pid was used again), counts from zero
def other_result(first, last, skip, seconds):
    total, largest, heavy = 0.0, 0.0, 0
    limit = HEAVY_SHARE * seconds * 1000.0
    for pid, ms in last.items():
        if pid in skip:
            continue
        used = ms - first.get(pid, 0.0)
        if used < 0:
            used = ms
        total += used
        largest = max(largest, used)
        if used > limit:
            heavy += 1
    return {'cpuMs': round(total, 1), 'largestMs': round(largest, 1), 'over20': heavy}


# The size in MB of each session's conversation file, <folder>/*/<sessionId>.jsonl (the latest written when there are
# several), or None for a session with none. Only sizes are read. Returns None when the folder can't be listed
def transcript_sizes(folder, session_ids):
    try:
        with os.scandir(folder) as entries:
            subfolders = [entry.path for entry in entries if entry.is_dir()]
    except OSError:
        return None
    out = {}
    for session in session_ids:
        best = None
        for sub in subfolders:
            try:
                st = os.stat(os.path.join(sub, session + '.jsonl'))
            except OSError:
                continue
            if best is None or st.st_mtime > best.st_mtime:
                best = st
        out[session] = None if best is None else round(best.st_size / MB, 2)
    return out


# A reading taken at both ends as a pair, or None (and its name noted) when either end is missing
def pair(first, last, name, unavailable, digits=1):
    if first is None or last is None:
        unavailable.add(name)
        return None
    return [round(first, digits), round(last, digits)]


# The whole window against a system: `clock` gives seconds that only go forward, `wait(seconds)` waits and says True
# when the window was asked to close early. Returns the output
def sample(system, args, clock, wait, me):
    unavailable = set()
    cores, memory = system.machine()
    battery = system.battery()
    if battery is None:
        unavailable.add('battery')
    table_open = system.cpu_table()
    trees = Trees(system, list(args.sessions), args.programs, me)
    began = clock()
    memory_open = system.memory_now()
    trees.start()
    roles = find_roles(system, trees, list(trees.parent), args.terminals)
    roles_open = {name: {pid: live_reading(system, pid) for pid in pids} for name, pids in roles.items()}
    seen = set(trees.parent)

    # A look every interval, none in the last half interval before the close; a look that ran late skips the ones missed
    step = 1
    while True:
        due = began + step * args.interval
        if due > began + args.seconds - args.interval / 2:
            break
        if wait(due - clock()):
            break
        trees.tick()
        step = max(step, int((clock() - began) / args.interval)) + 1
    wait(began + args.seconds - clock())
    trees.tick()
    trees.settle()
    ended = clock()
    seconds = max(ended - began, 0.001)
    memory_close = system.memory_now()

    processes = {}
    for pid in sorted(trees.sessions):
        result = trees.result(pid, system.memory_kind)
        if not trees.sessions[pid].gone:
            result['pssMB'] = system.pss(pid)
            if result['pssMB'] is not None:
                result['pssMB'] = round(result['pssMB'], 2)
        for name, key in (('peak', 'peakMB'), ('pss', 'pssMB'), ('wakeups', 'wakeups'), ('threads', 'threads')):
            if result[key] is None and not (key == 'pssMB' and trees.sessions[pid].gone):
                unavailable.add(name)
        processes[str(pid)] = result
    if trees.unreadable_helper:
        unavailable.add('helpers')
    if args.projects_dir is not None:
        sizes = transcript_sizes(args.projects_dir, [args.sessions[pid] for pid in trees.sessions])
        if sizes is None:
            unavailable.add('transcript')
        else:
            for pid in trees.sessions:
                processes[str(pid)]['transcriptMB'] = sizes[args.sessions[pid]]

    # The roles: the processes found at the open, and those that came since
    later = find_roles(system, trees, [pid for pid in trees.parent if pid not in seen], args.terminals)
    role_pids = set()
    role_out = {}
    for name in ('terminal', 'service'):
        pids = roles[name] | later[name]
        role_pids |= pids
        role_out[name] = role_result(roles_open[name], {pid: live_reading(system, pid) for pid in pids if pid in trees.parent})
        if role_out[name] is None:
            unavailable.add(name)
        elif role_out[name]['threads'] is None:
            unavailable.add('threads')

    table_close = system.cpu_table()
    other = None
    if table_open is None or table_close is None:
        unavailable.add('other')
    else:
        other = other_result(table_open, table_close, trees.taken() | role_pids, seconds)

    pressure = pair(memory_open[2], memory_close[2], 'pressure', unavailable, 2)
    return {
        'format': FORMAT,
        'how': system.how,
        'seconds': round(seconds, 3),
        'samples': trees.looks,
        'machine': {
            'cores': cores,
            'memoryMB': round(memory, 1),
            'freeMB': pair(memory_open[0], memory_close[0], 'free', unavailable),
            'swapUsedMB': pair(memory_open[1], memory_close[1], 'swap', unavailable),
            'pressure': pressure,
            'pressureKind': None if pressure is None else system.pressure_kind,
            'battery': battery,
        },
        'processes': processes,
        'other': other,
        'roles': role_out,
        'unavailable': sorted(unavailable),
    }


# --- the program ------------------------------------------------------------------------------------------------------

class Wake:
    """The wait between two looks, which SIGTERM or SIGINT ends at once: the window then closes early"""

    def __init__(self):
        import select
        import signal
        self.select = select
        self.reader, writer = os.pipe()
        os.set_blocking(self.reader, False)
        os.set_blocking(writer, False)
        signal.set_wakeup_fd(writer)
        self.asked = False
        signal.signal(signal.SIGTERM, self.ask)
        signal.signal(signal.SIGINT, self.ask)

    def ask(self, *_):
        self.asked = True

    def wait(self, seconds):
        if not self.asked and seconds > 0:
            self.select.select([self.reader], [], [], seconds)
        return self.asked


# The output, written beside its place and renamed over it: a reader never finds half a file
def write_output(path, output):
    temp = '%s.%d.tmp' % (path, os.getpid())
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(output, f, separators=(',', ':'))
            f.write('\n')
        os.replace(temp, path)
    except OSError:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def perf(argv):
    args = perf_args(argv)
    if args is None:
        sys.stderr.write(USAGE_LINE)
        return 2
    try:
        system = SYSTEMS[args.how]()
    except (AttributeError, ImportError, OSError) as err:
        sys.stderr.write("sampler.py perf: can't sample with %s on this system: %s\n" % (args.how, ' '.join(str(err).split())))
        return 1
    try:
        output = sample(system, args, time.monotonic, Wake().wait, os.getpid())
        write_output(args.out, output)
    except OSError as err:
        sys.stderr.write('sampler.py perf: %s\n' % ' '.join(str(err).split()))
        return 1
    return 0


def main(argv):
    if argv[:1] == ['perf']:
        return perf(argv[1:])
    sys.stderr.write(USAGE_LINE)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
