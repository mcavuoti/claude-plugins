#!/usr/bin/env python3
"""The child processes and the CPU of a few process trees, for the sessions benchmark (bench.py).

    procs.py watch --roots-file FILE --out FILE [--interval S]
        Samples the process table every S seconds (0.003 by default) until SIGTERM or SIGINT. FILE lists the root pids,
        one per line, and is read again whenever it changes. Every process that appears under a root (its parent, or its
        parent's parent and so on, is a root) is written to --out when it ends, or when the watch stops, as one JSON
        line: {"pid", "ppid", "root", "comm", "args", "start", "end"} (times from time.time(); end is null for a process
        still running, and "pre" is true for one that was already running when its root was first seen). Nothing about
        any other process is written.
        macOS: libproc (a pass over the whole table takes well under a millisecond), so a process that lives shorter
        than about one interval can be missed: the engine's debug log has the exact count of a mod's own spawns
        (bench.py reads it), and this adds what they spawn in turn (grandchildren) and their command lines.
        Linux: /proc.
    procs.py cpu PID...
        Prints {"<pid>": [own_cpu_seconds, children_cpu_seconds]}: the children are the descendants already reaped.
"""
import ctypes
import json
import os
import signal
import sys
import time

MAC = sys.platform == 'darwin'

if MAC:
    _proc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    _libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)

    class _ShortInfo(ctypes.Structure):
        # struct proc_bsdshortinfo (PROC_PIDT_SHORTBSDINFO): readable for every process, setuid ones (ps) included
        _fields_ = [('pid', ctypes.c_uint32), ('ppid', ctypes.c_uint32), ('pgid', ctypes.c_uint32),
                    ('status', ctypes.c_uint32), ('comm', ctypes.c_char * 16), ('flags', ctypes.c_uint32),
                    ('uid', ctypes.c_uint32), ('gid', ctypes.c_uint32), ('ruid', ctypes.c_uint32),
                    ('rgid', ctypes.c_uint32), ('svuid', ctypes.c_uint32), ('svgid', ctypes.c_uint32),
                    ('rfu', ctypes.c_uint32)]

    class _RUsage(ctypes.Structure):
        # struct rusage_info_v1 (proc_pid_rusage flavor 1): times in mach absolute time units
        _fields_ = [('uuid', ctypes.c_uint8 * 16), ('user_time', ctypes.c_uint64), ('system_time', ctypes.c_uint64),
                    ('pkg_idle_wkups', ctypes.c_uint64), ('interrupt_wkups', ctypes.c_uint64),
                    ('pageins', ctypes.c_uint64), ('wired_size', ctypes.c_uint64), ('resident_size', ctypes.c_uint64),
                    ('phys_footprint', ctypes.c_uint64), ('proc_start_abstime', ctypes.c_uint64),
                    ('proc_exit_abstime', ctypes.c_uint64), ('child_user_time', ctypes.c_uint64),
                    ('child_system_time', ctypes.c_uint64), ('child_pkg_idle_wkups', ctypes.c_uint64),
                    ('child_interrupt_wkups', ctypes.c_uint64), ('child_pageins', ctypes.c_uint64),
                    ('child_elapsed_abstime', ctypes.c_uint64)]

    class _Timebase(ctypes.Structure):
        _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]

    _tb = _Timebase()
    _libc.mach_timebase_info(ctypes.byref(_tb))
    _NS = _tb.numer / _tb.denom
    _pids = (ctypes.c_int * 16384)()
    _argmax = ctypes.c_int(0)
    _size = ctypes.c_size_t(ctypes.sizeof(_argmax))
    _libc.sysctl((ctypes.c_int * 2)(1, 8), 2, ctypes.byref(_argmax), ctypes.byref(_size), None, 0)  # KERN_ARGMAX
    _argbuf = ctypes.create_string_buffer(max(_argmax.value, 262144))


def all_pids():
    if MAC:
        n = _proc.proc_listpids(1, 0, _pids, ctypes.sizeof(_pids))  # PROC_ALL_PIDS
        return {_pids[i] for i in range(max(0, n) // 4) if _pids[i] > 0}
    return {int(p) for p in os.listdir('/proc') if p.isdigit()}


# (ppid, comm) of a process, or None once it's gone
def info(pid):
    if MAC:
        si = _ShortInfo()
        if _proc.proc_pidinfo(pid, 13, 0, ctypes.byref(si), ctypes.sizeof(si)) <= 0:  # PROC_PIDT_SHORTBSDINFO
            return None
        return si.ppid, si.comm.decode('utf-8', 'replace')
    try:
        with open('/proc/%d/stat' % pid) as f:
            text = f.read()
    except OSError:
        return None
    comm = text[text.index('(') + 1:text.rindex(')')]
    return int(text[text.rindex(')') + 2:].split()[1]), comm


# The command line, or [] where it can't be read (another user's process, such as the setuid ps on macOS)
def args(pid):
    if MAC:
        size = ctypes.c_size_t(len(_argbuf))
        if _libc.sysctl((ctypes.c_int * 3)(1, 49, pid), 3, _argbuf, ctypes.byref(size), None, 0) != 0:  # KERN_PROCARGS2
            return []
        raw = _argbuf.raw[:size.value]
        argc = int.from_bytes(raw[:4], sys.byteorder)
        rest = raw[4:]
        rest = rest[rest.index(b'\0'):] if b'\0' in rest else b''  # skip the executable's path
        parts = [p for p in rest.split(b'\0') if p]
        return [p.decode('utf-8', 'replace') for p in parts[:argc]]
    try:
        with open('/proc/%d/cmdline' % pid, 'rb') as f:
            return [p.decode('utf-8', 'replace') for p in f.read().split(b'\0') if p]
    except OSError:
        return []


def cpu(pid):
    """(own CPU seconds, reaped children's CPU seconds), or None"""
    if MAC:
        ru = _RUsage()
        if _proc.proc_pid_rusage(pid, 1, ctypes.byref(ru)) != 0:
            return None
        return ((ru.user_time + ru.system_time) * _NS / 1e9, (ru.child_user_time + ru.child_system_time) * _NS / 1e9)
    try:
        with open('/proc/%d/stat' % pid) as f:
            fields = f.read().rsplit(')', 1)[1].split()
    except OSError:
        return None
    tick = os.sysconf('SC_CLK_TCK')
    return ((int(fields[11]) + int(fields[12])) / tick, (int(fields[13]) + int(fields[14])) / tick)


def read_roots(path):
    try:
        with open(path) as f:
            return {int(x) for x in f.read().split() if x.strip().isdigit()}
    except OSError:
        return set()


def watch(roots_file, out_path, interval):
    out = open(out_path, 'a', buffering=1)
    stop = []
    signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
    signal.signal(signal.SIGINT, lambda *_: stop.append(1))
    roots, roots_stamp = set(), None
    known = {}   # every live pid: ppid
    tracked = {}  # live pids under a root: their record
    seen = set()
    first = True
    while not stop:
        try:
            stamp = os.stat(roots_file).st_mtime_ns
        except OSError:
            stamp = None
        if stamp != roots_stamp:
            roots_stamp, added = stamp, read_roots(roots_file) - roots
            roots |= added
            # Processes already running under a new root: recorded as "pre"
            for pid in sorted(known):
                if pid in tracked or pid in roots:
                    continue
                root = root_of(pid, known, roots)
                if root:
                    tracked[pid] = record(pid, known[pid], root, True)
        now = time.time()
        pids = all_pids()
        for pid in pids - seen:
            got = info(pid)
            if got is None:
                continue
            known[pid] = got[0]
            if pid in roots:
                continue
            root = root_of(pid, known, roots)
            if root:
                tracked[pid] = record(pid, got[0], root, first, now, got[1])
        for pid in seen - pids:
            known.pop(pid, None)
            r = tracked.pop(pid, None)
            if r:
                r['end'] = now
                out.write(json.dumps(r) + '\n')
        # A process caught between its fork and its exec shows its parent's program: look again while it runs
        for pid, r in tracked.items():
            if r['looks'] < 3:
                r['looks'] += 1
                got = info(pid)
                if got and (got[1] != r['comm'] or not r['args']):
                    r['comm'] = got[1]
                    r['args'] = args(pid)
        seen = pids
        first = False
        time.sleep(interval)
    for r in tracked.values():
        r['end'] = None
        out.write(json.dumps(r) + '\n')
    out.close()


def root_of(pid, known, roots):
    p, hops = known.get(pid), 0
    while p and hops < 64:
        if p in roots:
            return p
        p, hops = known.get(p), hops + 1
    return None


def record(pid, ppid, root, pre, start=None, comm=None):
    if comm is None:
        got = info(pid)
        comm = got[1] if got else ''
    return {'pid': pid, 'ppid': ppid, 'root': root, 'comm': comm, 'args': args(pid), 'start': start or time.time(),
            'end': None, 'pre': pre, 'looks': 0}


def main(argv):
    if argv[:1] == ['cpu']:
        print(json.dumps({p: cpu(int(p)) for p in argv[1:]}))
        return 0
    if argv[:1] == ['watch']:
        opts = dict(zip(argv[1::2], argv[2::2]))
        watch(opts['--roots-file'], opts['--out'], float(opts.get('--interval', '0.003')))
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
