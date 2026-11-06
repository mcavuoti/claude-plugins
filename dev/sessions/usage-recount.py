"""Independent token usage count, from scratch and without a cache, to check the plugin's hooks/usage.py against.

Reads ~/.claude/projects/**/*.jsonl the simplest possible way and prints the same totals usage.py keeps: per folder
(the project the response's session belongs to: the root in its heartbeat, else its transcript's first cwd, a
subagent's by its session's transcript, else the row's own cwd), per day (35 days) and per hour (48 hours), each
[input, output, cache read, cache written, thinking]. Each model response is counted once, by message.id + requestId
(a response is repeated once per content block, and copied into another file when a session is resumed).

Usage: python3 usage-recount.py [heartbeats folder] > recount.json
       python3 ~/.claude/plugins/…/hooks/usage.py ~/.claude/projects /tmp/usage-cache [heartbeats folder] > plugin.json
       python3 usage-compare.py plugin.json recount.json
with the same heartbeats folder for both (~/.claude/mods/sessions-data/alive), or none. The output keys (days, hours)
match usage.py's.
"""
import glob
import json
import os
import sys
from datetime import datetime, timedelta

root = os.path.expanduser('~/.claude/projects')
alive = sys.argv[1] if len(sys.argv) > 1 else ''
roots = {}
for path in glob.glob(os.path.join(alive, '*')) if alive else []:
    lines = dict(line.split('=', 1) for line in reversed(open(path).read().split('\n')) if '=' in line)
    if lines.get('format') == '3' and lines.get('root', '').startswith('/'):
        roots[os.path.basename(path)] = lines['root']


def first_cwd(path):
    try:
        for line in open(path, 'rb'):
            record = json.loads(line)
            if isinstance(record.get('cwd'), str):
                return record['cwd']
    except (OSError, ValueError):
        pass
    return ''


def home(path):
    start = path
    if os.path.basename(os.path.dirname(path)) == 'subagents':
        start = os.path.dirname(os.path.dirname(path)) + '.jsonl'
    return roots.get(os.path.basename(start)[:-len('.jsonl')]) or first_cwd(start)


now = datetime.now().astimezone()
since = (now - timedelta(days=35)).replace(hour=0, minute=0, second=0, microsecond=0)
since_hour = (now - timedelta(hours=48)).strftime('%Y-%m-%dT%H')
seen = set()
days = {}
hours = {}
for path in sorted(glob.glob(root + '/**/*.jsonl', recursive=True)):
    folder = home(path)
    for line in open(path, 'rb'):
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if record.get('type') != 'assistant':
            continue
        message = record.get('message') or {}
        usage = message.get('usage')
        stamp = record.get('timestamp')
        if not isinstance(usage, dict) or not isinstance(stamp, str):
            continue
        when = datetime.fromisoformat(stamp.replace('Z', '+00:00')).astimezone()
        if when < since:
            continue
        key = (message.get('id'), record.get('requestId'))
        if key in seen:
            continue
        seen.add(key)
        values = [usage.get('input_tokens') or 0, usage.get('output_tokens') or 0,
                  usage.get('cache_read_input_tokens') or 0, usage.get('cache_creation_input_tokens') or 0,
                  (usage.get('output_tokens_details') or {}).get('thinking_tokens') or 0]
        if not any(values):
            continue
        cwd = folder or (record.get('cwd') if isinstance(record.get('cwd'), str) else '')
        day = when.strftime('%Y-%m-%d')
        hour = when.strftime('%Y-%m-%dT%H')
        per_day = days.setdefault(cwd, {})
        per_day[day] = [a + b for a, b in zip(per_day.get(day, [0] * 5), values)]
        if hour >= since_hour:
            per_hour = hours.setdefault(cwd, {})
            per_hour[hour] = [a + b for a, b in zip(per_hour.get(hour, [0] * 5), values)]
json.dump({'days': days, 'hours': hours}, sys.stdout)
