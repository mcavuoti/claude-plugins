#!/usr/bin/env python3
"""Does reading Claude's files directly give the session list `claude agents --json --all` gives? Read only.

    equivalence.py [--samples N] [--every S] [--out FILE]

Every S seconds (60 by default), N times (5), it reads the session registry (~/.claude/sessions/<pid>.json, the files
the CLI itself lists: /^\\d+\\.json$/) and each background session's ~/.claude/jobs/<id>/state.json, builds the list
from them, runs `claude agents --json --all`, and compares the two: which sessions only one of them has, and for the
others which fields differ (status, name, cwd, sessionId, pid). What it writes holds counts, kinds and field names only,
never a name, a folder or an id, so it can be kept with test results.

Status is compared as `claude agents` reports it: anything but idle and waiting counts as busy (shell included).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HOME = os.environ.get('HOME', '')
REGISTRY = os.path.join(HOME, '.claude', 'sessions')
JOBS = os.path.join(HOME, '.claude', 'jobs')


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def direct():
    rows, raw_status = {}, {}
    reg_files = [n for n in os.listdir(REGISTRY) if re.match(r'^\d+\.json$', n)] if os.path.isdir(REGISTRY) else []
    jobs_seen = set()
    dead = 0
    for n in reg_files:
        d = read_json(os.path.join(REGISTRY, n))
        if not isinstance(d, dict):
            continue
        pid = d.get('pid')
        if isinstance(pid, int) and not alive(pid):
            dead += 1
        job = d.get('jobId') if isinstance(d.get('jobId'), str) else None
        short = job[:8] if job else None
        if short:
            jobs_seen.add(short)
        st = d.get('status')
        raw_status[st] = raw_status.get(st, 0) + 1
        key = short or d.get('sessionId')
        rows[key] = {'kind': 'background' if d.get('kind') == 'bg' else 'interactive', 'pid': pid,
                     'status': st if st in ('idle', 'waiting') else ('busy' if st is not None else None),
                     'name': d.get('name'), 'cwd': d.get('cwd'), 'sessionId': d.get('sessionId'),
                     'alive': isinstance(pid, int) and alive(pid), 'parked': bool(d.get('parkedJobId'))}
    for short in (os.listdir(JOBS) if os.path.isdir(JOBS) else []):
        if short in jobs_seen or not re.match(r'^[0-9a-f]{8}$', short):
            continue
        s = read_json(os.path.join(JOBS, short, 'state.json'))
        if not isinstance(s, dict):
            continue
        rows[short] = {'kind': 'background', 'pid': None, 'status': None, 'name': s.get('name'), 'cwd': s.get('cwd'),
                       'sessionId': s.get('sessionId') or s.get('resumeSessionId'), 'alive': False, 'state': s.get('state')}
    return rows, {'registryFiles': len(reg_files), 'deadPids': dead, 'registryStatus': raw_status}


def official():
    r = subprocess.run(['claude', 'agents', '--json', '--all'], capture_output=True, text=True, timeout=120)
    try:
        rows = json.loads(r.stdout)
    except ValueError:
        return None
    out = {}
    for x in rows if isinstance(rows, list) else []:
        key = x.get('id') or x.get('sessionId')
        out[key] = {'kind': x.get('kind'), 'pid': x.get('pid'), 'status': x.get('status'), 'name': x.get('name'),
                    'cwd': x.get('cwd'), 'sessionId': x.get('sessionId')}
    return out


def compare(mine, theirs):
    report = {'official': len(theirs), 'direct': len(mine), 'matched': 0, 'onlyOfficial': {}, 'onlyDirect': {},
              'fieldDiffs': {}}

    def kind_of(r):
        return '%s %s' % (r.get('kind'), 'running' if r.get('pid') else 'not running')

    for k, o in theirs.items():
        m = mine.get(k)
        if m is None:
            report['onlyOfficial'][kind_of(o)] = report['onlyOfficial'].get(kind_of(o), 0) + 1
            continue
        report['matched'] += 1
        for f in ('status', 'name', 'cwd', 'sessionId', 'pid'):
            if (m.get(f) or None) != (o.get(f) or None):
                report['fieldDiffs'][f] = report['fieldDiffs'].get(f, 0) + 1
    for k, m in mine.items():
        if k not in theirs:
            why = kind_of(m) + (', pid gone' if m.get('pid') and not m.get('alive') else '') + (', parked' if m.get('parked') else '') + (', state %s' % m['state'] if m.get('state') else '')
            report['onlyDirect'][why] = report['onlyDirect'].get(why, 0) + 1
    return report


def main(argv):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--samples', type=int, default=5)
    p.add_argument('--every', type=float, default=60)
    p.add_argument('--out')
    a = p.parse_args(argv)
    samples = []
    for i in range(a.samples):
        t0 = time.time()
        mine, facts = direct()
        read_ms = (time.time() - t0) * 1000
        t1 = time.time()
        theirs = official()
        list_ms = (time.time() - t1) * 1000
        if theirs is None:
            samples.append({'error': 'claude agents gave no JSON'})
        else:
            # The direct read again right after, so a change during the listing shows as such
            mine2, _ = direct()
            r = compare(mine, theirs)
            r2 = compare(mine2, theirs)
            r['afterListing'] = {'matched': r2['matched'], 'fieldDiffs': r2['fieldDiffs'], 'onlyOfficial': r2['onlyOfficial'], 'onlyDirect': r2['onlyDirect']}
            r.update(facts, directReadMs=round(read_ms, 1), listingMs=round(list_ms, 1), at=time.strftime('%H:%M:%S'))
            samples.append(r)
        print(json.dumps(samples[-1]), flush=True)
        if i + 1 < a.samples:
            time.sleep(max(0, a.every - (time.time() - t0)))
    if a.out:
        with open(a.out, 'w') as f:
            json.dump({'samples': samples}, f, indent=2)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
