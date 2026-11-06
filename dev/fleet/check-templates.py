#!/usr/bin/env python3
"""The templates /fleet init copies (plugins/fleet/templates/<name>/): each one whole and consistent.

A cheap check of the data, run by dev/fleet/ci.sh: the JSON files parse and carry their versions, every role of the
roster has its role file with fleet's tools in it (without them they'd be hidden from the instance), every instance's
role, section and parent exist, and every role has its seed. Every template has its verify.md; world.json's code
entries have a kind fleet knows and what it needs, its proofs lists are lists of strings, and a check's script under
.claude/fleet/ ships with the template; a role verifies roles or instances of the roster, and a role's or an
instance's code names world.json's. Sections are the person's across projects, so across the templates one id has one
title and order, and two ids never share an order. /fleet up --dry-run lints a project's own roster fully.
"""
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'plugins/fleet/templates')
problems = []
# A section's id → (title, order, where), across every template
section_seen = {}


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
    world = {}
    try:
        world = json.loads((t / 'fleet/world.json').read_text())
        if not isinstance(world.get('worldFormat'), int) or not isinstance(world.get('paths'), list):
            say(t / 'fleet/world.json', 'needs worldFormat and paths')
    except (OSError, ValueError) as e:
        say(t / 'fleet/world.json', e)
    # A template whose roles write board items has the board in its world: its items' writers are known (who wrote an
    # item is never offered it) and their edits are landings
    agents = t / 'agents'
    writes_board = agents.is_dir() and any('board/B-<n>.md' in f.read_text() for f in agents.glob('*.md'))
    if writes_board and isinstance(world, dict) and 'board/**' not in world.get('paths', []):
        say(t / 'fleet/world.json', 'its roles write board items (board/B-<n>.md) but its paths lack board/**')
    if not (t / 'fleet/verify.md').is_file():
        say(t / 'fleet/verify.md', 'missing: how the project proves something works, which every role reads before it lands')
    # The code fleet watches: each repository or depot by a name the roster's "code" uses
    code = world.get('code', {}) if isinstance(world, dict) else {}
    if not isinstance(code, dict):
        say(t / 'fleet/world.json', 'code is an object: a repository or depot by its name')
        code = {}
    for name, spec in code.items():
        where = f"{t / 'fleet/world.json'} (code {name})"
        if not re.match(r'^[a-z0-9][a-z0-9-]*$', name):
            say(where, 'a name of lowercase letters, digits and -')
        if not isinstance(spec, dict) or spec.get('kind') not in ('git', 'p4', 'command'):
            say(where, 'its kind is git, p4 or command')
            continue
        if spec['kind'] == 'p4' and not (isinstance(spec.get('depot'), str) and spec['depot'].strip()):
            say(where, 'a p4 entry needs its depot (//depot/<project>/...)')
        if spec['kind'] == 'command':
            for key in ('changed', 'open'):
                argv = spec.get(key)
                if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
                    say(where, f'a command entry needs {key} as a command line (a list of strings)')
    proofs = world.get('proofs', {}) if isinstance(world, dict) else {}
    if not isinstance(proofs, dict):
        say(t / 'fleet/world.json', 'proofs is an object')
        proofs = {}
    for key in ('paths', 'kinds', 'rerun'):
        if key in proofs and (not isinstance(proofs[key], list) or not all(isinstance(x, str) for x in proofs[key])):
            say(t / 'fleet/world.json', f'proofs.{key} is a list of strings')
    # A check's script the template ships (.claude/fleet/…) is there, or the check could never start
    for check in world.get('checks', []) if isinstance(world, dict) else []:
        for word in check.get('argv', []) if isinstance(check, dict) else []:
            if isinstance(word, str) and word.startswith('.claude/fleet/') and not (t / 'fleet' / word[len('.claude/fleet/'):]).is_file():
                say(t / 'fleet/world.json', f"the check {check.get('name', '')} runs {word}, which the template doesn't ship")
    outbound = t / 'fleet/outbound.json'
    if outbound.exists():
        try:
            o = json.loads(outbound.read_text())
            if not isinstance(o.get('outboundFormat'), int) or any(not isinstance(o.get(k, []), list) for k in ('hosts', 'remotes', 'recipients', 'commands', 'outside')):
                say(outbound, 'needs outboundFormat, and hosts, remotes, recipients, commands and outside as lists')
        except ValueError as e:
            say(outbound, e)
    try:
        roster = json.loads((t / 'fleet/roster.json').read_text())
    except (OSError, ValueError) as e:
        say(t / 'fleet/roster.json', e)
        continue
    if not isinstance(roster.get('rosterFormat'), int):
        say(t / 'fleet/roster.json', 'no rosterFormat')
    roles = roster.get('roles', {})
    sections = {s.get('id') for s in roster.get('sections', [])}
    for s in roster.get('sections', []):
        where = f"{t / 'fleet/roster.json'} (section {s.get('id')})"
        if not isinstance(s.get('order'), int):
            say(where, 'give it an order (a whole number from 201) no other template uses')
            continue
        seen = section_seen.get(s.get('id'))
        if seen and (seen[0], seen[1]) != (s.get('title'), s.get('order')):
            say(where, f'{seen[2]} has it as "{seen[0]}", order {seen[1]}: one id is one section, with one title and order')
        clash = [k for k, v in section_seen.items() if k != s.get('id') and v[1] == s.get('order')]
        if clash:
            say(where, f'its order {s.get("order")} is also section {clash[0]}\'s ({section_seen[clash[0]][2]})')
        section_seen.setdefault(s.get('id'), (s.get('title'), s.get('order'), t.name))
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
        if i.get('context', roles.get(i.get('role'), {}).get('context', 'fresh')) not in ('long', 'fresh'):
            say(where, 'context is long or fresh')
        if 'parent' in i and i['parent'].lower() not in names:
            say(where, f"its parent {i['parent']} isn't an instance")
    slots = t / 'fleet/slots.json'
    if slots.exists():
        try:
            s = json.loads(slots.read_text())
            if not isinstance(s.get('slotsFormat'), int) or not isinstance(s.get('slots', {}), dict):
                say(slots, 'needs slotsFormat, and slots as an object')
        except ValueError as e:
            say(slots, e)
    # What reaches whom: subscriptions name the world's tags and intake's kinds; derived kinds have an owner
    tags = set(world.get('tags', [])) if isinstance(world, dict) else set()
    kinds = {'information', 'proposal', 'command-claim', 'resource', 'noise'}
    for who, spec in [*roles.items(), *[(i.get('name'), i) for i in instances]]:
        sub = spec.get('subscribe') or {}
        if sub and 'intake' not in world:
            say(t / 'fleet/roster.json', f'{who} subscribes, and world.json has no intake')
        for tag in sub.get('tags', []):
            if tag not in tags:
                say(t / 'fleet/roster.json', f"{who} subscribes to the tag {tag}, which world.json's tags don't list")
        for kind in sub.get('kinds', []):
            if kind not in kinds:
                say(t / 'fleet/roster.json', f'{who} subscribes to the kind {kind}, which intake has not')
    # Whose work a verifier verifies, and which of world.json's repositories a role or an instance works in
    for role, spec in roles.items():
        for who in spec.get('verifies', []):
            if who not in roles and who.lower() not in names:
                say(t / 'fleet/roster.json', f'{role} verifies {who}, which is no role or instance')
    for who, spec in [*roles.items(), *[(i.get('name'), i) for i in instances]]:
        mine = spec.get('code', {})
        if not isinstance(mine, dict):
            say(t / 'fleet/roster.json', f'{who}: code is an object, by the names of world.json\'s code')
            continue
        for repo in mine:
            if repo not in code:
                say(t / 'fleet/roster.json', f"{who} works in the code {repo}, which world.json's code doesn't name")
    for kind, spec in (world.get('derived') or {}).items():
        owner = spec.get('owner', '')
        if owner not in roles and owner.lower() not in names:
            say(t / 'fleet/world.json', f'derived {kind}: its owner {owner} is no role or instance')
    channel = (roster.get('person') or {}).get('channel') or {}
    if channel.get('kind', 'terminal') not in ('terminal', 'push', 'mcp', 'command'):
        say(t / 'fleet/roster.json', f"person.channel.kind {channel.get('kind')} isn't terminal, push, mcp or command")
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
        # sessions' Stop and Restart ask in the instance through AskUserQuestion and answer back through SendMessage
        for need in ('AskUserQuestion', 'SendMessage'):
            if 'tools' in fm and '*' not in tools and need not in tools:
                say(path, f"its tools don't list {need} (s and u in the panel need it in that session)")
        seed = t / 'fleet' / spec.get('seed', f'seeds/{role}.md')
        if not seed.is_file():
            say(seed, f'missing: the seed of {role}')

for p in problems:
    print(f'fleet templates: {p}', file=sys.stderr)
if problems:
    sys.exit(1)
print(f'fleet: {len(templates)} templates whole ({", ".join(t.name for t in templates)})')
