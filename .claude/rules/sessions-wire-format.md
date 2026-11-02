---
paths:
  - "plugins/sessions/hooks/**"
  - "plugins/sessions/setup/**"
  - "plugins/sessions/types/**"
---

# sessions: shared formats carry a version, and nothing keeps old ones alive

Several sessions run the `sessions` mod at once and talk through shared data: the store, the files in the data folder, the notices between sessions, and the launcher. After an update the owner restarts every session, so there is no compatibility code for older versions of the mod. Instead, version skew must be harmless and visible:

- **Files and notices carry `format`.** `FORMAT` in `hooks/state.ts` (and the same constant in `hooks/launcher.py`, `hooks/visor.sh` and `hooks/usage.py`) is the format of the heartbeats (`alive/`), the order file (`order/`), the inbox requests (`inbox/`), the launcher's window files (`windows/`), the mirrored settings (`config`), `ccc tell`'s requests, status files and opt-in (`tell/`), `usage.py`'s output and cache, and the notices (`sessions-notice:7f3a` + JSON with `format` and `kind`). Change any of their keys or meanings → raise the format in all of those places in the same commit.
- **A reader that meets another format does nothing harmful and says so:** it doesn't act on the data, consumes a notice so it never reaches the model, and tells the person to restart sessions (`u`, or `claude respawn <id>`). Senders only send notices to sessions whose heartbeat shows the same format.
- **Person data has its own version.** What the person chose and keeps for good, such as `sections.json` (`sectionsFormat`, `SECTIONS_FORMAT` in `hooks/state.ts`), isn't wire data: it doesn't follow `FORMAT`, changes only by adding fields, and a write keeps the fields it doesn't know. It's never silently ignored: a reader that meets a newer version leaves the file untouched and says so (restart, `u`). A breaking change would ship a one-time rewrite into a new key or file in the same commit, never code that reads two shapes.
- **Store keys are English.** When a stored value changes meaning, give it a new key name rather than reading two shapes.
- **Locations are overridable** for tests: `SESSIONS_DATA_DIR` (the mod's files), `SESSIONS_JOBS_DIR` and `SESSIONS_DAEMON_LOG` (Claude's background service), `SESSIONS_CLAUDE` (the claude command), `SESSIONS_PLUGIN_VERSION`/`SESSIONS_PLUGIN_SINCE` (the installed plugin). A new location gets an override too, so test sessions never touch the owner's files. A session with any of them set keeps all its store keys under a namespace of its own (`storeNamespace` in `hooks/state.ts`): every store access goes through `storeGet`/`storeSet`/`storeDelete`/`storeKeys` (a new override joins the list there and in `storeNamespaceOf`).
- **Nothing a running session does rewrites what other sessions or the shell run.** The `ccc` command and the status line copy are installed by the setup (`~/.claude/mods/sessions-data/bin/`); `ccc` finds the enabled plugin each time it runs.

The keys, files and fields are listed where they're defined: the comment above `storeGet` in `register.tsx`, and `state.ts` (Heartbeat, orderFileText, InboxRequest, WindowTarget, TELL_MAX_BYTES, buildNotice, MarkSlot, SECTIONS_FORMAT). The API other plugins call (`$.sessions`) has its own rule: `.claude/rules/plugin-contract.md`.
