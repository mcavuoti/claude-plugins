---
name: coherence
description: Check that this repository's guidance for Claude (CLAUDE.md, .claude/rules/, CONTRIBUTING.md, each plugin's README and dev checklists, and this session's auto-memory) still matches the code and each other, then propose fixes. Use after a release, after a large change, or when asked whether the docs, rules or memory are current ("/coherence", "coherence check", "are the rules up to date", "audit the docs and memory").
---

# Coherence check

What guides Claude in this repository lives in a few places, each with one job. A fact is written in one place, and the others point to it.

| Place | Its job |
|---|---|
| `CLAUDE.md` | rules for every task in the repository: short, public, nothing personal |
| `.claude/rules/*.md` | rules for specific files, chosen by the `paths:` in their front matter |
| `CONTRIBUTING.md` | how to work here: platform code, checks, git, releases, shared formats |
| `plugins/<name>/README.md` | what the plugin does and how it works: install, features, internals, Files, Lessons |
| `dev/<plugin>/*.md` | checklists for things only a person can try |
| this session's auto-memory, if it has one | the owner's preferences and this machine's state; it lives outside the repository and is never copied into it |

## 1. Mechanical checks

Run `python3 .claude/skills/coherence/check.py` from the repository. It lists every repository path a guidance file names that no longer exists, every rule whose `paths:` matches no tracked file, and every `SESSIONS_*` variable no code uses. Each line is a finding.

## 2. Read and compare

For each guidance file, check its statements of fact against the code (grep it, read it):

- **Still true:** names of stored keys, files, commands, flags, environment variables, defaults, limits, timings and versions are what the code does now.
- **One place each:** a fact that appears in two places, or two places that disagree, is a finding. Keep the fact where its job is (table above) and make the other place point to it.
- **READMEs:** the Files section matches the tree. The install and setup steps match what `setup/` does. No Lesson is contradicted by the current code.
- **Rules:** each rule's `paths:` still covers the files it talks about.
- **Public files:** nothing about the owner's machines, folders, projects or sessions, and no real ids or values copied from a log or store (CLAUDE.md lists the rules).

## 3. This session's memory

If the session has an auto-memory directory (the system prompt names it):

- **Still true:** paths it names exist, versions and installs it states match this machine, pending items are still open, and anything it calls removed is gone.
- **Not a copy of the repository:** a note that repeats what the repository records keeps only what's non-obvious, or goes.
- **The index:** `MEMORY.md` has one line per note, each link resolves, and each line still describes its note.
- Memory is Claude's own notes: fix it directly, in the language it's written in, and list each change in the report.

## 4. Report, then fix

- One table: place, line, what's wrong, the fix you propose. If nothing is wrong, say so in one line.
- For repository files, show the proposed edits and apply only the ones the owner approves. Commit as CONTRIBUTING.md says: the checks first, small commits.
- Run `check.py` again after the fixes: it should report 0 findings.
