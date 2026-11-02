---
paths:
  - "plugins/fleet/**"
---

# fleet: its files carry a version, and it only calls `sessions`

`fleet` is turned on per project, and several sessions of a project run it at once, sharing the files under the project's `.claude/fleet/` (the list is at the top of `hooks/decisions.ts`). After an update the owner restarts every session, so there is no code for older versions: version skew must be harmless and visible, as in `sessions` (`.claude/rules/sessions-wire-format.md`).

- **Wire files carry `format`** (`FORMAT` in `hooks/decisions.ts`): `decisions/queue/`, `decisions/answers/`, `decisions/last`, `decisions/prune/`. Change a key or its meaning → raise `FORMAT` in the same commit. A reader that meets another format acts on nothing and says to restart (`u`): `/fleet` lists such decisions apart and refuses to answer them, and an asker doesn't deliver an answer it can't read.
- **Person data has its own version**: the register (`registerFormat`, `REGISTER_FORMAT`) and `config.json` (`configFormat`, `CONFIG_FORMAT`). They only gain fields, a write keeps the fields it doesn't know, and a newer version is left untouched and said (restart, `u`), never silently ignored.
- **The project folder is fleet's data folder.** `fleet` keeps no `$.store` and writes nothing outside `<project>/.claude/fleet/`. It reads outside it only what Claude gives it (`CLAUDE_JOB_DIR`'s `state.json`, its own `plugin.json`); a new place it reads or writes outside the project gets an environment override, so test sessions never touch the owner's files.
- **Single writer or no-clobber.** A queue file is written once, by the session that asked; answers, drops, register records and prune markers are published with `ln` from a file in `decisions/tmp/` (the first one wins); notes and `last` replace with `mv`. No locks.
- **Every command through `run`**, from `/` (it exists; every path is absolute), with a timeout. `$.process.run` appears nowhere else.
- **Calls only to `sessions`** (`plugins/sessions/docs/plugin-contract.md`): never hook a `sessions.*` event, never read its state, store or `sessions-data/` files; find what's served with `has()` (raced against 500 ms) and race every call; no `$.sessions` call in `session.start` (it runs before `sessions` starts). `dev/fleet/ci.sh` checks the first and the second.
- **Delivery state lives in `$.state`** (it survives a hot reload; module variables don't, and one double submit came from that). What must outlive a restart is in the files.
- **No platform code.** `fleet` runs the same on macOS and Linux: `$.fs`, `$.clock`, `ln`, `mv`, `rm`, `mkdir`.
