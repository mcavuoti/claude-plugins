#!/usr/bin/env python3
"""Tokens spent by Claude Code on this computer, for the usage block of the sessions panel.

Reads the conversation logs (~/.claude/projects/**/*.jsonl): each response carries its usage (input, output, cache
read and written, and thinking as part of the output). Reads only what's new in each file since the previous run and
keeps totals per day (35 days) and per hour (48 hours), split by the session's folder (cwd).

The same response shows up several times (one line per block) and is also copied into another file when a session is
resumed: it's counted only once, by its message id and request id (the same thing ccusage does).

Prints a JSON: {"format", "generated", "today", "hour", "days": {cwd: {day: [in, out, cache_read, cache_written,
thinking]}}, "hours": ...}
Usage: usage.py [logs folder] [cache folder]

The cache file (in the cache folder) is shared by every session: files = each log's read position (offset read up to,
size at that point), seen = responses already counted (by day), days and hours = the totals. `format` is the format of
the output and the cache (the panel reads only its own; a cache in another format is started over).
"""
import fcntl
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timedelta

DAYS = 35
HOURS = 48
FORMAT = 2


def day_key(t):
    return t.strftime('%Y-%m-%d')


def hour_key(t):
    return t.strftime('%Y-%m-%dT%H')


def add(target, key, values):
    previous = target.get(key)
    target[key] = values if previous is None else [a + b for a, b in zip(previous, values)]


def read_cache(path):
    try:
        with open(path) as f:
            c = json.load(f)
        if c.get('format') == FORMAT:
            return c
    except (OSError, ValueError):
        pass
    return {'format': FORMAT, 'files': {}, 'seen': {}, 'days': {}, 'hours': {}}


def prune(c, now):
    first_day = day_key(now - timedelta(days=DAYS))
    first_hour = hour_key(now - timedelta(hours=HOURS))
    for cwd in list(c['days']):
        c['days'][cwd] = {d: v for d, v in c['days'][cwd].items() if d >= first_day}
        if not c['days'][cwd]:
            del c['days'][cwd]
    for cwd in list(c['hours']):
        c['hours'][cwd] = {h: v for h, v in c['hours'][cwd].items() if h >= first_hour}
        if not c['hours'][cwd]:
            del c['hours'][cwd]
    c['seen'] = {k: d for k, d in c['seen'].items() if d >= first_day}


def process_line(line, c, since):
    # Quick filter before parsing the JSON: only responses with usage
    if b'"usage"' not in line or b'"assistant"' not in line:
        return
    try:
        r = json.loads(line)
    except ValueError:
        return
    if r.get('type') != 'assistant':
        return
    m = r.get('message') or {}
    u = m.get('usage')
    ts = r.get('timestamp')
    if not isinstance(u, dict) or not isinstance(ts, str):
        return
    try:
        t = datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone()
    except ValueError:
        return
    if t < since:
        return
    id_ = f"{m.get('id')}:{r.get('requestId')}"
    key = hashlib.sha1(id_.encode()).hexdigest()[:16]
    if key in c['seen']:
        return
    day = day_key(t)
    c['seen'][key] = day
    details = u.get('output_tokens_details') or {}
    values = [
        int(u.get('input_tokens') or 0),
        int(u.get('output_tokens') or 0),
        int(u.get('cache_read_input_tokens') or 0),
        int(u.get('cache_creation_input_tokens') or 0),
        int(details.get('thinking_tokens') or 0),
    ]
    if not any(values):
        return
    cwd = r.get('cwd') if isinstance(r.get('cwd'), str) else ''
    add(c['days'].setdefault(cwd, {}), day, values)
    add(c['hours'].setdefault(cwd, {}), hour_key(t), values)


def update(root, c, now):
    since = (now - timedelta(days=DAYS)).replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = since.timestamp()
    present = set()
    for folder, _, names in os.walk(root):
        for name in names:
            if not name.endswith('.jsonl'):
                continue
            path = os.path.join(folder, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            present.add(path)
            previous = c['files'].get(path)
            # A file that hasn't changed since before the period can't have anything to count
            if previous is None and st.st_mtime < cutoff:
                c['files'][path] = {'offset': st.st_size, 'size': st.st_size}
                continue
            start_byte = previous['offset'] if previous and previous['size'] <= st.st_size else 0
            if previous and start_byte == st.st_size:
                continue
            with open(path, 'rb') as f:
                f.seek(start_byte)
                data = f.read()
            # Only complete lines: the last one may still be being written
            end = data.rfind(b'\n') + 1
            for line in data[:end].splitlines():
                process_line(line, c, since)
            c['files'][path] = {'offset': start_byte + end, 'size': st.st_size}
    for path in list(c['files']):
        if path not in present:
            del c['files'][path]


def main():
    home = os.path.expanduser('~')
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(home, '.claude', 'projects')
    folder = sys.argv[2] if len(sys.argv) > 2 else os.path.join(home, '.claude', 'mods', 'sessions-data', 'usage')
    os.makedirs(folder, exist_ok=True)
    cache_path = os.path.join(folder, 'cache.json')
    # Only one update at a time (several sessions run this): the others wait and read the result
    with open(os.path.join(folder, 'cache.lock'), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        now = datetime.now().astimezone()
        c = read_cache(cache_path)
        update(root, c, now)
        prune(c, now)
        temporary = cache_path + '.tmp'
        with open(temporary, 'w') as f:
            json.dump(c, f, separators=(',', ':'))
        os.replace(temporary, cache_path)
    json.dump({
        'format': FORMAT,
        'generated': int(time.time() * 1000),
        'today': day_key(now),
        'hour': hour_key(now),
        'days': c['days'],
        'hours': c['hours'],
    }, sys.stdout, separators=(',', ':'))


if __name__ == '__main__':
    main()
