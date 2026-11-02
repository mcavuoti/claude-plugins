# How we prove it works

How this project proves what its notes say, written by you (or an owner's change you apply with `/fleet <n> apply`).
Each owner reads it before it lands anything.

## The commands

What to run to check a part, if anything: a build, a script, a spell check.

## Testbenches and long runs

Where they run (this machine, a dev machine over ssh), and how long they take. A long run's result keeps its stored
hash: fleet's check doesn't run it again.

## What counts as proof

- A fact in the notes: where it comes from (`source:`, a path in the project or a URL) and the exact text it rests on
  (`quote:`).
- A number someone computed: the exact command (`run:`) and the sha256 of its standard output (`sha:`).

## Before you land

- What you wrote cites where it comes from.
- What the commands above check, you ran.
