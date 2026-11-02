---
paths:
  - "plugins/fleet/**"
---

# fleet: its files carry a version, and it only calls `sessions`

`fleet` is turned on per project, and several sessions of a project run it at once, sharing the files under the project's `<project>/.claude/fleet/` (the list is at the top of `hooks/decisions.ts`). After an update the owner restarts every session, so there is no code for older versions: version skew must be harmless and visible, as in `sessions` (`.claude/rules/sessions-wire-format.md`).

- **Wire files carry `format`** (`FORMAT` in `hooks/decisions.ts`): `<project>/.claude/fleet/decisions/queue/`, `<project>/.claude/fleet/decisions/answers/`, `<project>/.claude/fleet/decisions/last`, `<project>/.claude/fleet/decisions/prune/`, `<project>/.claude/fleet/events/` (the landings, `latest`, `claims/`) and `<project>/.claude/fleet/reads/`. Change a key or its meaning → raise `FORMAT` in the same commit. A reader that meets another format acts on nothing and says to restart (`u`): `/fleet` lists such decisions apart and refuses to answer them, an asker doesn't deliver an answer it can't read, and an event or reads file of another format is counted in `/fleet status` and not used.
- **Person data has its own version**: the register (`registerFormat`, `REGISTER_FORMAT`), `config.json` (`configFormat`, `CONFIG_FORMAT`) and `world.json` (`worldFormat`, `WORLD_FORMAT` in `hooks/changes.ts`; a newer one turns the world off in that session, it never holds a write it can't read). They only gain fields, a write keeps the fields it doesn't know, and a newer version is left untouched and said (restart, `u`), never silently ignored.
- **The project folder is fleet's data folder.** `fleet` keeps no `$.store` and writes nothing outside `<project>/.claude/fleet/`. It reads outside it only what Claude gives it (`CLAUDE_JOB_DIR`'s `state.json`, its own `plugin.json`); a new place it reads or writes outside the project gets an environment override, so test sessions never touch the owner's files.
- **Single writer or no-clobber.** A queue file is written once, by the session that asked; answers, drops, register records, prune markers, events (each under a name of its own) and outside-change claims are published with `ln` from a file in `<project>/.claude/fleet/decisions/tmp/` (the first one wins); notes, `last` and a session's own reads file replace with `mv`; `<project>/.claude/fleet/events/latest` is only a trigger, rewritten in place. No locks.
- **Every command through `run`**, from `/` (it exists; every path is absolute), with a timeout. `$.process.run` appears nowhere else.
- **Calls only to `sessions`** (`plugins/sessions/docs/plugin-contract.md`): never hook a `sessions.*` event, never read its state, store or `sessions-data/` files; find what's served with `has()` (raced against 500 ms) and race every call; no `$.sessions` call in `session.start` (it runs before `sessions` starts). `dev/fleet/ci.sh` checks the first and the second.
- **Delivery state lives in `$.state`** (it survives a hot reload; module variables don't, and one double submit came from that): the decisions in flight, and each thread's reads and the gate's "told once". What must outlive a restart is in the files.
- **The shared files are coordination, not security.** The gate refuses a stale write once and fails open (`.catch` → `next(e)`); Bash is never held, only recorded after the fact (landed blind); a digest carries path, who and when, never a file's content.
- **No platform code.** `fleet` runs the same on macOS and Linux: `$.fs`, `$.clock`, `ln`, `mv`, `rm`, `mkdir`.
