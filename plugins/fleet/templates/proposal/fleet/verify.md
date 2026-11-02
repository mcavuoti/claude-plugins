# How we prove it works

How this project proves what it claims: the commands, the testbenches, what counts as proof for a finding, a result and
a proof of concept. Drafted by the chief from the kickstart interview, and applied by you (`/fleet <n> apply`), or
written by you. Every instance reads it before it lands anything, and the verifier checks against it; only you, or a
change you apply, rewrite it.

## The commands

- Build the proofs of concept:
- Their tests, and how to run one:
- Where each runs (this machine, or the dev machine over ssh):

## Testbenches and long runs

- The testbenches and simulations: what each shows, where it runs (a dev machine over ssh), how long it takes, and the
  slot it needs (.claude/fleet/slots.json).
- A long run (a simulation, a regression of hours) is recorded once: its result keeps its stored hash, and the proofs
  check doesn't run it again (it runs only what world.json's `proofs.rerun` lists, within its budget). The verifier
  checks that it ran where its record says: the host, the branch or changelist, the commit, the log.
- Where the logs and the outputs are kept, so a result can be found again.

## What counts as proof

- A result (poc/results/): `kind: result`, the exact command as run from the project's folder (`run:`) and the sha256
  of its standard output (`sha:`, from `<command> | shasum -a 256`, 12 digits or more). Several runs: a `run:` and its
  `sha:` each, in turn.
- A finding (findings/F-<n>.md): `kind: finding`, where it comes from (`source:`, a path in the project or a URL) and
  the exact text it rests on (`quote:`, copied as it is there, 10 characters or more). Several sources: a `source:` and
  its `quote:` each, in turn.
- A proof of concept's code: its tests pass on a branch rebased on the main branch, or a changelist synced to the
  depot's head; its record names the host, the branch or changelist and the commit.
- A finding or a result without its proof is marked unproven, and one whose proofs check fails holds nothing: the gap
  matrix and the proposal don't count either.
- What a result doesn't show, its record says: a run on one testbench isn't a run on the others.

## Before you land

- The run behind a result was made from what you land (the commit or the changelist its record names).
- Its `run:` is the exact command, and its `sha:` the sha256 of that command's output.
- A quote is copied from its source as it is, not paraphrased.
- Code: rebased on the main branch (or synced to the depot's head), and its tests above pass after it.
