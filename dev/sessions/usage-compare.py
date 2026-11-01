"""Compares hooks/usage.py's output (argv[1]) with usage-recount.py's (argv[2]) and prints the differences.

Usage: python3 usage-compare.py plugin.json recount.json
"""
import json
import sys

plugin = json.load(open(sys.argv[1]))
recount = json.load(open(sys.argv[2]))


def compare(label, a, b):
    differences = []
    for cwd in set(a) | set(b):
        for key in set(a.get(cwd, {})) | set(b.get(cwd, {})):
            if a.get(cwd, {}).get(key) != b.get(cwd, {}).get(key):
                differences.append((cwd[-30:], key, a.get(cwd, {}).get(key), b.get(cwd, {}).get(key)))
    print(label, 'differences:', len(differences))
    for d in differences[:5]:
        print('  ', d)


compare('days', plugin['days'], recount['days'])
compare('hours', plugin['hours'], recount['hours'])
totals = [0] * 5
for cwd in plugin['days']:
    for values in plugin['days'][cwd].values():
        totals = [p + q for p, q in zip(totals, values)]
print('35 days, everything: in %d · out %d · cache read %d · cache written %d · thinking %d' % tuple(totals))
print('today', plugin['today'], 'hour', plugin['hour'], '| folders:', len(plugin['days']))
