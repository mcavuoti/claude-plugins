"""Independent token usage count, from scratch and without a cache, to check the plugin's hooks/usage.py against.

Reads ~/.claude/projects/**/*.jsonl the simplest possible way and prints the same totals usage.py keeps: per folder
(the session's cwd), per day (35 days) and per hour (48 hours), each [input, output, cache read, cache written,
thinking]. Each model response is counted once, by message.id + requestId (a response is repeated once per content
block, and copied into another file when a session is resumed).

Usage: python3 usage-recount.py > recount.json
       python3 ~/.claude/plugins/…/hooks/usage.py ~/.claude/projects /tmp/usage-cache > plugin.json
       python3 usage-compare.py plugin.json recount.json
The output keys (days, hours) match usage.py's.
"""
import glob
import json
import os
import sys
from datetime import datetime, timedelta

root = os.path.expanduser('~/.claude/projects')
now = datetime.now().astimezone()
since = (now - timedelta(days=35)).replace(hour=0, minute=0, second=0, microsecond=0)
since_hour = (now - timedelta(hours=48)).strftime('%Y-%m-%dT%H')
seen = set()
days = {}
hours = {}
for path in sorted(glob.glob(root + '/**/*.jsonl', recursive=True)):
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
        cwd = record.get('cwd') if isinstance(record.get('cwd'), str) else ''
        day = when.strftime('%Y-%m-%d')
        hour = when.strftime('%Y-%m-%dT%H')
        per_day = days.setdefault(cwd, {})
        per_day[day] = [a + b for a, b in zip(per_day.get(day, [0] * 5), values)]
        if hour >= since_hour:
            per_hour = hours.setdefault(cwd, {})
            per_hour[hour] = [a + b for a, b in zip(per_hour.get(hour, [0] * 5), values)]
json.dump({'days': days, 'hours': hours}, sys.stdout)
