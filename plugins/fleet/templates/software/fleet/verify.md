# How we prove it works

How this project proves that a change works: the commands, the test machines, what counts as proof. Drafted by the
chief from the kickstart interview, and applied by you (`/fleet <n> apply`), or written by you. Every instance reads it
before it lands anything; only you, or a change you apply, rewrite it.

## The commands

- Build:
- All the tests:
- One test:
- What CI runs besides (lint, types, format):

## Testbenches and long runs

The slow suites and the test machines: where each runs (this machine, a CI box, a dev machine over ssh), how long it
takes, and which a change must pass before it's merged. A long run's result is recorded once and keeps its stored hash:
fleet's check doesn't run it again.

## What counts as proof

- A change: its tests pass on its branch, rebased on the main branch (or on a changelist synced to the depot's head),
  and its board item names the commit they passed at.
- A result (a benchmark, a measure): `kind: result`, the exact command as run from the project's folder (`run:`) and
  the sha256 of its standard output (`sha:`, from `<command> | shasum -a 256`).
- A finding (how a library behaves, what an issue says): `kind: finding`, where it comes from (`source:`, a path in the
  project or a URL) and the exact text it rests on (`quote:`).
- A test that was skipped, or a run that didn't finish, proves nothing.

## Before you land

- Rebase on the main branch (or sync to the depot's head), then run the commands above that touch what you changed.
- They pass after the rebase, not only before it.
- The board item says the branch, the commit and what the tests showed.
- A result or a finding carries its proof.
