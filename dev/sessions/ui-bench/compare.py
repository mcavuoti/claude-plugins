#!/usr/bin/env python3
"""Two (or more) results of bench.py side by side: the numbers each phase of a change is judged by.

    compare.py before.json after.json [more.json ...]
"""
import json
import sys

ROWS = [
    ('Idle pane renders a minute, per session', ('idle', 'perSessionPerMinute', 'paneRenders')),
    ('Idle band renders a minute, per session', ('idle', 'perSessionPerMinute', 'bandRenders')),
    ('Idle mod spawns a minute, per session', ('idle', 'perSessionPerMinute', 'modSpawns')),
    ('Idle mod processes a minute (spawns and theirs), per session', ('idle', 'perSessionPerMinute', 'modProcesses')),
    ('Idle CPU per session, % of a core (median)', ('idle', 'cpuPerSession', 'medianPercentOfCore')),
    ('Idle children CPU per session, % of a core (median)', ('idle', 'cpuPerSession', 'medianChildrenPercentOfCore')),
    ('Idle CPU of the session without the mod, % of a core', ('idle', 'cpuPerSession', 'controlPercentOfCore')),
    ('Idle store writes a minute, all sessions', ('idle', 'perMinute', 'storeWrites')),
    ('Idle file writes a minute, all sessions', ('idle', 'perMinute', 'fsWrites')),
    ('With a viewer: pane renders a minute in the viewed session', ('idleWithViewer', 'viewerPaneRendersPerMinute')),
    ('With a viewer: screen updates a minute', ('idleWithViewer', 'viewerScreenChangesPerMinute')),
    ("Another session's busy shows, s (median)", ('propagation', 'otherBusy', 'median')),
    ("Another session's done shows, s (median)", ('propagation', 'otherDone', 'median')),
    ('Own row busy, s (median)', ('propagation', 'ownBusy', 'median')),
    ('Own row done, s (median)', ('propagation', 'ownDone', 'median')),
    ('Enter switch A to B, s (median)', ('switch', 'AtoB', 'median')),
    ('Enter switch B to A, s (median)', ('switch', 'BtoA', 'median')),
    ('ccc to the panel, s (median)', ('ccc', 'toPanel', 'median')),
]


def get(result, path):
    v = result.get('scenarios', {})
    for k in path:
        if not isinstance(v, dict) or k not in v:
            return None
        v = v[k]
    return v


def main(paths):
    if len(paths) < 2:
        print(__doc__)
        return 2
    results = [json.load(open(p)) for p in paths]
    heads = [r.get('label') or r.get('version') or p for r, p in zip(results, paths)]
    width = max(len(t) for t, _ in ROWS)
    print('%-*s  %s' % (width, '', '  '.join('%14s' % h[:14] for h in heads)))
    for title, path in ROWS:
        cells = [get(r, path) for r in results]
        print('%-*s  %s' % (width, title, '  '.join('%14s' % ('-' if c is None else c) for c in cells)))
    for r, h in zip(results, heads):
        if r.get('errors'):
            print('%s: errors: %s' % (h, '; '.join(r['errors'])))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
