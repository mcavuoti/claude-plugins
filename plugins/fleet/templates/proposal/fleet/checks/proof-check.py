#!/usr/bin/env python3
# proof-check-version: 2 (fleet's /fleet status says when a project's copy lacks this line: an older one)
r"""The proposal template's proofs check: a finding or a result says what it rests on, and this checks that it holds.

    python3 .claude/fleet/checks/proof-check.py [--budget SECONDS] [FILE...]

world.json's "checks" runs it from the project's folder after each landing of a finding (findings/) or a result
(poc/results/), with the files as its last arguments, and again on a finding when the source it quotes lands. With no
file named it checks every file under world.json's proofs.paths and says on standard error how many: the verifier's
full sweep. fleet runs a check as the person, with no prompt, so it runs this
one only after he types /fleet accept checks, and only while the checks and this script stay as he stamped them.

The convention, in a record's front matter (between --- lines) or among its first 30 lines, a value wrapped whole in
quotes or not (inside double quotes, \" is a quote and \\ a backslash):

    kind: result                                  kind: finding
    run: python3 poc/area-a/bench.py --n 1000     source: notes/sheet.md (a path in the project, or a URL)
    sha: 3f2a9c41d07e                             quote: "the exact text it rests on"

A run: is the exact command, as run from the project's folder; its sha: is the sha256 of the command's standard output
(`<command> | shasum -a 256`), 12 to 64 hex digits, `sha256:` in front or not. A quote: is copied from its source as it
is, 10 characters or more. Several pairs may follow each other: a run: pairs with the next sha:, a source: with the
next quote:.

What fails a record:
- a run: with no sha: after it, or one that isn't 12 to 64 hex digits; a source: with no quote:, or a shorter one;
- a local source outside the project (an absolute path elsewhere, a ../ that leaves it), or not there; a text source
  the quote isn't in (spaces and line breaks aside; a :12 or #part after the path is ignored), said "no longer in"
  when the source changed after the file that quotes it;
- a run: world.json's proofs.rerun lists whose output's sha256 doesn't start with its sha:, or that can't start.

What it leaves to the verifier role, never failing for it: a URL, a source that isn't text, and every run: it doesn't
run again. It runs a command again only when one of proofs.rerun's patterns (fnmatch, over the whole command line)
matches it and it has none of ; | & $ ` < > ( ), a newline or a ../ in it: split as a shell would, run with no shell
from the project's folder, within proofs.timeoutS each (30 s by default) and --budget for all of them (100 s by
default). One past its time, or once the budget is used up, keeps its stored hash, and so does a long run (a
simulation) nobody lists.

proofs.rerun is empty by default because a run: line is written by an instance, and this script runs it as the person
with no prompt: list only commands you'd run blind (`make test`, `python3 -m pytest -q poc/area-a`), never a pattern
that takes any script (`python3 *`: an instance writes the scripts too).

A record with no proof at all is no failure here: fleet marks it unproven itself, when world.json's proofs.paths or
proofs.kinds say it must carry one. A failing file gets one or two lines `<path>: <why>` on standard output, and the
exit is 1; notes that fail nothing go to standard error, and never start with a file's path.
"""
import argparse
import fnmatch
import hashlib
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

KEY = re.compile(r'^\s*(run|sha|source|quote)\s*:\s*(.*)$')
SHA = re.compile(r'^(?:sha256:)?([0-9a-f]{12,64})$')
SHELL = re.compile(r'[;|&$`<>()\n]')
URL = re.compile(r'^[A-Za-z][A-Za-z0-9+.-]*://')
TAIL = re.compile(r'^(.+?)(?::\d+(?:-\d+)?|#.*)$')
MAX_SOURCE = 32 * 1024 * 1024


def note(text):
    print(f'proof-check: {text}', file=sys.stderr)


def settings():
    """proofs.rerun, proofs.timeoutS and proofs.paths from the project's world.json (nothing re-runs without them)"""
    try:
        proofs = json.loads(Path('.claude/fleet/world.json').read_text()).get('proofs') or {}
    except (OSError, ValueError, AttributeError):
        return [], 30.0, []
    if not isinstance(proofs, dict):
        return [], 30.0, []
    rerun = proofs.get('rerun')
    rerun = [p for p in rerun if isinstance(p, str) and p.strip()] if isinstance(rerun, list) else []
    t = proofs.get('timeoutS')
    paths = proofs.get('paths')
    paths = [p for p in paths if isinstance(p, str) and p.strip()] if isinstance(paths, list) else []
    return rerun, float(t) if isinstance(t, (int, float)) and not isinstance(t, bool) and t > 0 else 30.0, paths


def glob_regex(glob):
    """A world.json glob as fleet reads it: ** any depth, * and ? within a name, {a,b} either"""
    out, i = '', 0
    while i < len(glob):
        c = glob[i]
        if glob.startswith('**/', i):
            out, i = out + '(?:.*/)?', i + 3
            continue
        if glob.startswith('**', i):
            out, i = out + '.*', i + 2
            continue
        if c == '*':
            out += '[^/]*'
        elif c == '?':
            out += '[^/]'
        elif c == '{' and '}' in glob[i:]:
            end = glob.index('}', i)
            out += '(?:' + '|'.join(re.escape(x) for x in glob[i + 1:end].split(',')) + ')'
            i = end
        else:
            out += re.escape(c)
        i += 1
    return re.compile(f'^{out}$')


def files_under(globs, root):
    """Every file under the globs, from the project's folder (not into .git or fleet's own folder), sorted"""
    res = [glob_regex(g) for g in globs]
    out = []
    for folder, dirs, names in os.walk(root):
        rel = Path(folder).relative_to(root).as_posix()
        dirs[:] = [d for d in dirs if d != '.git' and (rel, d) != ('.claude', 'fleet')]
        for n in names:
            p = n if rel == '.' else f'{rel}/{n}'
            if any(r.match(p) for r in res):
                out.append(p)
    return sorted(out)


def scope(text):
    """The front matter when there is one, else the first 30 lines (as fleet reads a record's change: line)"""
    lines = text.lstrip('﻿').splitlines()
    if lines and lines[0].strip() == '---':
        for i, line in enumerate(lines[1:], 1):
            if line.strip() == '---':
                return lines[1:i]
    return lines[:30]


def value(raw):
    r"""A value as written, or what's inside the quotes that wrap it whole ("…" or '…': a command that ends on a quote,
    printf 'x', keeps it); inside double quotes, \" is a quote and \\ a backslash"""
    v = raw.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
        double = v[0] == '"'
        v = v[1:-1].strip()
        if double:
            v = re.sub(r'\\(["\\])', r'\1', v)
    return v


def proofs_of(text):
    """The run:/sha: and source:/quote: pairs, in order, and what's wrong with their shape"""
    pairs, wrong = [], []
    run = source = None
    for line in scope(text):
        m = KEY.match(line)
        if not m:
            continue
        key, v = m.group(1), value(m.group(2))
        if key == 'run':
            if run is not None:
                wrong.append(f'run: {short(run)} has no sha: after it')
            run = v
            if not v:
                wrong.append('an empty run:')
                run = None
        elif key == 'sha':
            if run is None:
                wrong.append('a sha: with no run: before it')
                continue
            sha = SHA.match(v.lower())
            if sha:
                pairs.append(('run', run, sha.group(1)))
            else:
                wrong.append(f"run: {short(run)}: its sha: isn't a sha256 (12 to 64 hex digits)")
            run = None
        elif key == 'source':
            if source is not None:
                wrong.append(f'source: {short(source)} has no quote: after it')
            source = v
            if not v:
                wrong.append('an empty source:')
                source = None
        else:
            if source is None:
                wrong.append('a quote: with no source: before it')
                continue
            if len(normal(v)) < 10:
                wrong.append(f'source: {short(source)}: its quote: is shorter than 10 characters')
            else:
                pairs.append(('source', source, v))
            source = None
    if run is not None:
        wrong.append(f'run: {short(run)} has no sha: after it')
    if source is not None:
        wrong.append(f'source: {short(source)} has no quote: after it')
    return pairs, wrong


def short(s, n=60):
    return s if len(s) <= n else s[:n - 1] + '…'


def normal(s):
    return ' '.join(unicodedata.normalize('NFC', s).split())


def inside(path, root):
    return path == root or root in path.parents


def check_source(src, quote, root, since=None):
    """None when it holds or isn't this script's to check; else why it fails (since: when the file that quotes it was
    last written, to tell a source that changed after it)"""
    if URL.match(src):
        return None
    path = Path(src)
    if not path.is_absolute() and not (root / path).exists():
        m = TAIL.match(src)
        if m and (root / m.group(1)).exists():
            path = Path(m.group(1))
    full = (path if path.is_absolute() else root / path).resolve()
    if not inside(full, root):
        return f'source {short(src)} must be inside the project'
    if not full.exists():
        return f"source {short(src)} isn't there"
    try:
        if not full.is_file() or full.stat().st_size > MAX_SOURCE:
            raise ValueError
        data = full.read_bytes()
        if b'\0' in data:
            raise ValueError
        text = data.decode('utf-8')
    except (OSError, ValueError):
        note(f"a source isn't readable text ({short(src)}): the verifier checks its quote")
        return None
    if normal(quote) in normal(text):
        return None
    if since is not None and full.stat().st_mtime > since:
        return f'quote no longer in {short(src)} (it changed after this file)'
    return f'quote not found in {short(src)}'


class Runs:
    def __init__(self, patterns, timeout, budget):
        self.patterns, self.timeout, self.left = patterns, timeout, budget

    def listed(self, command):
        if not any(fnmatch.fnmatchcase(command, p) for p in self.patterns):
            return None
        if SHELL.search(command):
            note(f'{short(command)} has shell syntax: not run again, its stored hash stands')
            return None
        try:
            argv = shlex.split(command)
        except ValueError:
            note(f"{short(command)} can't be split into words: not run again, its stored hash stands")
            return None
        if not argv or any('..' in re.split(r'[/=\s]', a) for a in argv):
            note(f'{short(command)} names a ../ path: not run again, its stored hash stands')
            return None
        return argv

    def check(self, command, sha, root):
        """None when it holds, or isn't run again; else why it fails"""
        argv = self.listed(command)
        if argv is None:
            return None
        if self.left <= 0:
            note(f'the budget is used up: {short(command)} not run again, its stored hash stands')
            return None
        limit = min(self.timeout, self.left)
        started = time.monotonic()
        try:
            p = subprocess.Popen(argv, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError as e:
            return f"run: {short(command)} can't start ({e.strerror or e})"
        try:
            out, _ = p.communicate(timeout=limit)
        except subprocess.TimeoutExpired:
            # Its whole group, so a child holding the output open can't keep this waiting
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                p.kill()
            p.communicate()
            self.left -= time.monotonic() - started
            note(f'{short(command)} ran past {limit:g} s: its stored hash stands')
            return None
        self.left -= time.monotonic() - started
        got = hashlib.sha256(out).hexdigest()
        if got.startswith(sha):
            return None
        return f'run: {short(command)} gave sha256 {got[:12]}…, not {sha[:12]}… (exit {p.returncode})'


def main():
    parser = argparse.ArgumentParser(description='Check the proofs of findings and results (see this script\'s top).')
    parser.add_argument('--budget', type=float, default=100.0, help='seconds for all re-runs together (100)')
    parser.add_argument('files', nargs='*')
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8', errors='replace')
    root = Path.cwd().resolve()
    patterns, timeout, paths = settings()
    runs = Runs(patterns, timeout, args.budget)
    failed = False
    files = args.files
    if not files:
        if not paths:
            note('no file named, and world.json has no proofs.paths: nothing to check')
            sys.exit(0)
        files = files_under(paths, root)
        note(f'checked {len(files)} file(s) under proofs.paths')
    for name in files:
        try:
            text = (root / name).read_text(encoding='utf-8', errors='replace')
            since = (root / name).stat().st_mtime
        except OSError as e:
            note(f"can't read a file it was given ({short(name)}: {e.strerror or e})")
            continue
        pairs, wrong = proofs_of(text)
        for kind, a, b in pairs:
            why = runs.check(a, b, root) if kind == 'run' else check_source(a, b, root, since)
            if why:
                wrong.append(why)
        if wrong:
            failed = True
            print(f'{name}: {wrong[0]}')
            if len(wrong) > 1:
                more = f' (and {len(wrong) - 2} more)' if len(wrong) > 2 else ''
                print(f'{name}: {wrong[1]}{more}')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
