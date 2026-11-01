#!/usr/bin/env python3
"""Tokens spent by Claude Code on this computer, for the usage block of the sessions panel.

Reads the conversation logs (~/.claude/projects/**/*.jsonl): each response carries its usage (input, output, cache
read and written, and thinking as part of the output). Reads only what's new in each file since the previous run and
keeps totals per day (35 days) and per hour (48 hours), split by the session's folder (cwd).

The same response shows up several times (one line per block) and is also copied into another file when a session is
resumed: it's counted only once, by its message id and request id (the same thing ccusage does).

Prints a JSON: {"hoy", "hora", "dias": {cwd: {day: [in, out, cache_read, cache_written, thinking]}}, "horas": ...}
Usage: uso.py [logs folder] [cache folder]

The keys of the printed JSON and of the cache file (version, generado, hoy, hora, dias, horas; archivos, vistos,
desde, tam) are a wire format: the panel of any mod version reads the output, and the cache on disk is shared by every
session, so they stay in Spanish. hoy = today, hora = current hour, dias = per-day totals, horas = per-hour totals,
generado = generated at (ms), archivos = per-file read position, vistos = responses already counted (by day),
desde = byte offset read up to, tam = file size at that point.
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
VERSION = 1


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
        if c.get('version') == VERSION:
            return c
    except (OSError, ValueError):
        pass
    return {'version': VERSION, 'archivos': {}, 'vistos': {}, 'dias': {}, 'horas': {}}


def prune(c, now):
    first_day = day_key(now - timedelta(days=DAYS))
    first_hour = hour_key(now - timedelta(hours=HOURS))
    for cwd in list(c['dias']):
        c['dias'][cwd] = {d: v for d, v in c['dias'][cwd].items() if d >= first_day}
        if not c['dias'][cwd]:
            del c['dias'][cwd]
    for cwd in list(c['horas']):
        c['horas'][cwd] = {h: v for h, v in c['horas'][cwd].items() if h >= first_hour}
        if not c['horas'][cwd]:
            del c['horas'][cwd]
    c['vistos'] = {k: d for k, d in c['vistos'].items() if d >= first_day}


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
    if key in c['vistos']:
        return
    day = day_key(t)
    c['vistos'][key] = day
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
    add(c['dias'].setdefault(cwd, {}), day, values)
    add(c['horas'].setdefault(cwd, {}), hour_key(t), values)


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
            previous = c['archivos'].get(path)
            # A file that hasn't changed since before the period can't have anything to count
            if previous is None and st.st_mtime < cutoff:
                c['archivos'][path] = {'desde': st.st_size, 'tam': st.st_size}
                continue
            start_byte = previous['desde'] if previous and previous['tam'] <= st.st_size else 0
            if previous and start_byte == st.st_size:
                continue
            with open(path, 'rb') as f:
                f.seek(start_byte)
                data = f.read()
            # Only complete lines: the last one may still be being written
            end = data.rfind(b'\n') + 1
            for line in data[:end].splitlines():
                process_line(line, c, since)
            c['archivos'][path] = {'desde': start_byte + end, 'tam': st.st_size}
    for path in list(c['archivos']):
        if path not in present:
            del c['archivos'][path]


def main():
    home = os.path.expanduser('~')
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(home, '.claude', 'projects')
    folder = sys.argv[2] if len(sys.argv) > 2 else os.path.join(home, '.claude', 'mods', 'sessions-uso')
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
        'version': VERSION,
        'generado': int(time.time() * 1000),
        'hoy': day_key(now),
        'hora': hour_key(now),
        'dias': c['dias'],
        'horas': c['horas'],
    }, sys.stdout, separators=(',', ':'))


if __name__ == '__main__':
    main()
