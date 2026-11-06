# How we prove it works

How this project proves that something works, written by you (or drafted by a chief and applied with `/fleet <n>
apply`). Every instance reads it before it lands anything.

## The commands

Build, tests, how to run one test.

## Testbenches and long runs

Where they run (this machine, a dev machine over ssh). A long run's result keeps its stored hash: fleet's check
doesn't run it again.

## What counts as proof

- A result: the exact command (`run:`) and the sha256 of its standard output (`sha:`).
- In a `run:` command, call grep as `command grep` (an instance's shell runs Claude Code's own grep, whose output order
  differs from the system's) and sort what lists several files (`| sort`): it then gives the same output wherever it's
  run again.
- A finding: where it comes from (`source:`, a path in the project or a URL) and the exact text it rests on (`quote:`).
- Code: its tests pass on a branch rebased on the main branch, or a changelist synced to the depot's head.

## Before you land
