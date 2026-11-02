#!/usr/bin/env python3
"""The templates /fleet init copies (plugins/fleet/templates/<name>/): each one whole and consistent.

A cheap check of the data, run by dev/fleet/ci.sh: the JSON files parse and carry their versions, every role of the
roster has its role file with fleet's tools in it (without them they'd be hidden from the instance), every instance's
role, section and parent exist, and every role has its seed. /fleet up --dry-run lints a project's own roster fully.
"""
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'plugins/fleet/templates')
problems = []


def say(where, what):
    problems.append(f'{where}: {what}')


def front_matter(text):
    lines = text.splitlines()
    if not lines or lines[0].strip() != '---':
        return {}
    out = {}
    for line in lines[1:]:
        if line.strip() == '---':
            break
        m = re.match(r'^([A-Za-z_][\w-]*)\s*:\s*(.*)$', line)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


templates = sorted(p for p in root.iterdir() if p.is_dir())
if not templates:
    say(root, 'no templates')
for t in templates:
    meta_path = t / 'template.json'
    try:
        meta = json.loads(meta_path.read_text())
        if not isinstance(meta.get('templateFormat'), int):
            say(meta_path, 'no templateFormat')
    except (OSError, ValueError) as e:
        say(meta_path, e)
        continue
    try:
        world = json.loads((t / 'fleet/world.json').read_text())
        if not isinstance(world.get('worldFormat'), int) or not isinstance(world.get('paths'), list):
            say(t / 'fleet/world.json', 'needs worldFormat and paths')
    except (OSError, ValueError) as e:
        say(t / 'fleet/world.json', e)
    try:
        roster = json.loads((t / 'fleet/roster.json').read_text())
    except (OSError, ValueError) as e:
        say(t / 'fleet/roster.json', e)
        continue
    if not isinstance(roster.get('rosterFormat'), int):
        say(t / 'fleet/roster.json', 'no rosterFormat')
    roles = roster.get('roles', {})
    sections = {s.get('id') for s in roster.get('sections', [])}
    instances = roster.get('instances', [])
    names = [i.get('name', '').lower() for i in instances]
    for name in {n for n in names if names.count(n) > 1}:
        say(t / 'fleet/roster.json', f'two instances are named {name}')
    for i in instances:
        where = f"{t / 'fleet/roster.json'} ({i.get('name')})"
        if i.get('role') not in roles:
            say(where, f"its role {i.get('role')} isn't in roles")
        if 'section' in i and i['section'] not in sections:
            say(where, f"its section {i['section']} isn't in sections")
        if 'parent' in i and i['parent'].lower() not in names:
            say(where, f"its parent {i['parent']} isn't an instance")
    for role, spec in roles.items():
        agent = spec.get('agent', role)
        path = t / 'agents' / f'{agent}.md'
        if not path.is_file():
            say(path, f'missing: the role file of {role}')
            continue
        fm = front_matter(path.read_text())
        if fm.get('name') != agent:
            say(path, f'its name is {fm.get("name")}, not {agent}')
        tools = [x.strip() for x in fm.get('tools', '').strip('[]').split(',') if x.strip()]
        if 'tools' in fm and not any(x in ('mcp__fleet__*', 'mcp__fleet') for x in tools):
            say(path, "its tools don't list mcp__fleet__*")
        seed = t / 'fleet' / spec.get('seed', f'seeds/{role}.md')
        if not seed.is_file():
            say(seed, f'missing: the seed of {role}')

for p in problems:
    print(f'fleet templates: {p}', file=sys.stderr)
if problems:
    sys.exit(1)
print(f'fleet: {len(templates)} templates whole ({", ".join(t.name for t in templates)})')
