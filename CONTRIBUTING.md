# Developing on macOS and Linux

This repository is maintained by its owner and doesn't take outside pull requests.

Some code only runs, and can only be tried, on its own operating system. The repository is laid out so that changes made
on a Mac and on Linux don't step on each other, and a check on GitHub runs everything that can run on both.

## Shared code and platform code

In `plugins/sessions`:

| Files | What | Edit from |
|---|---|---|
| `hooks/register.tsx`, `hooks/state.ts`, `hooks/visor.sh`, `hooks/launcher.py`, `hooks/usage.py`, `statusline/`, `setup/` | shared: the panel, its data and actions, the launcher (`ccc`), token usage, the status line, the setup | either |
| `types/index.d.ts`, `docs/plugin-contract.md`, `tests/contract.test.tsx` | the API other plugins call (`$.sessions`): its types, how it evolves, its golden method list | either |
| `hooks/platform/types.ts` | the contract: what each system has to provide (windows, processes, memory) | either, together with both implementations |
| `hooks/platform/macos.ts` | macOS: Terminal.app through AppleScript, `ioreg`, `lsof`, `sysctl` | a Mac |
| `hooks/platform/linux.ts` | Linux: windows found by process and switched through the launcher, `wmctrl`/`xdotool`, terminal emulators, `/proc` | Linux |
| `extras/macos/` | macOS only extras | a Mac |
| `tests/panel.test.tsx`, `tests/rows.test.tsx`, `tests/start.test.tsx`, `tests/tell.test.tsx`, `tests/alerts.test.tsx` (with `tests/world.tsx`) | shared logic and drawing, what the rows show, how the mod starts, `ccc tell`'s side in the session, the notifications, ⧗ and spend marks | either |
| `tests/macos.test.tsx`, `tests/linux.test.tsx` | each platform's pure parts (they run on both systems) | its system |

`plugins/fleet` has no platform code: every file of it is shared and edited from either system.

Rules:

1. **Edit a platform file only from its own system**, where you can try it. The shared code only talks to the platform through `platform.*` (see `types.ts`).
2. **Changing the contract** (`types.ts`) updates both implementations in the same commit. The side you can't try gets the smallest change that keeps it working, and the commit message says `needs a check on <macOS|Linux>`; check it the next time you're on that system.
3. **On the system you're on**, before pushing: `claude plugin validate plugins/<plugin>` and `claude plugin test plugins/<plugin>` for each plugin you changed (`sessions`, `fleet`; a change to `sessions`' contract runs `fleet`'s too), and `shellcheck` on the shell scripts you changed (a warning that's deliberate gets an inline `# shellcheck disable=SC… # why`), and try what you changed in a test session (`dev/sessions/hidden-terminal.py` drives one without touching your windows). From a Mac, much of the Linux code can be tried with `SESSIONS_PORTABLE=1` in a test session's `--settings` env; macOS code can't be tried from Linux.
4. **The GitHub check must pass on both systems** (`.github/workflows/test.yml`: validation, every plugin's tests, a syntax check of every shell and Python script, `shellcheck` on every shell script, and each plugin's own checks in `dev/<plugin>/ci.sh`, such as the `sessions` setup in throwaway home folders). It runs on every push. The workflow itself is generic: a new plugin gets validated and tested without touching it, and adds its own checks by adding its `dev/<plugin>/ci.sh`.
5. **A real Linux desktop check** after window-related changes: `dev/sessions/linux-checklist.md`.

## Rules Claude Code loads by itself

`.claude/rules/` holds rules that Claude Code reads only when it works on matching files, so they apply on any computer without anyone opening this file:

- `platform-code.md` (files in `plugins/*/hooks/platform/`): edit each platform file from its own system, and the rest of the rules above.
- `sessions-wire-format.md` (the `sessions` mod's code): shared files and notices carry a format version, a mismatch is harmless and visible, person data has its own version, and every location is overridable for tests.
- `plugin-contract.md` (the `sessions` contract files): `$.sessions` is written once in `types/index.d.ts`, changes only by adding within an api, and its methods follow a few rules (one plain-data argument, work before the start, never submit, ask or focus).
- `fleet-wire-format.md` (the `fleet` mod's files): its files under a project's `<project>/.claude/fleet/` carry a format, the register, `config.json`, `world.json`, `roster.json` and `outbound.json` their own versions, it writes nothing outside the project, it only calls `sessions`, two hard lines (an instance's own tools on the command-level files, which change through a `change` the person applies or types himself; and the project's content leaving to a third party from a background session, which goes only as a draft the person approves), only its code notifies the person (through his channel, to his own address; the model's own PushNotification is refused in a background session), intake reads each item with one model call as data and never commands, a judge is one stateless call per choice behind code gates (never money, the outside world, what can't be undone or a question asked after reading outside content) whose citations code checks, which only proposes but in an area the person turned live, where its answers are labelled and he can overrule them, its gate on shared files refuses once and fails open, and everything else it finds (suspects, failed checks, blind landings, outside content read, cadence misses, budgets used up, stale derived documents) is a flag that holds nothing.

A rule that should apply only to some files goes there, with `paths:` in its front matter; what applies to every task in the repository goes in a `CLAUDE.md`.

## Git

- Once per clone: `git config core.hooksPath .githooks` and `git config user.email <id>+<user>@users.noreply.github.com` (the address GitHub shows under Settings → Emails). The `commit-msg` hook in `.githooks/` refuses a commit with any other email and drops `Claude-Session:` lines, so nothing personal reaches the public history.
- Once per machine, optionally: list in `~/.config/claude-plugins/private-words.txt` (or the file `CLAUDE_PLUGINS_PRIVATE_WORDS` names) the words that must never be published, such as your real project, client and session names, one per line. The `pre-commit` hook then refuses a commit whose added lines or file paths contain one, ignoring case. The list stays outside the repository; with no list the hook does nothing.
- `git pull --rebase` before you start, keep commits small, push when done.
- A release: bump `version` in the plugin's `.claude-plugin/plugin.json`, commit, push. Each machine that uses the plugins then runs `claude plugin marketplace update mcavuoti && claude plugin update <plugin>@mcavuoti` (or has auto-update on).
- After a release, run `/coherence` (`.claude/skills/coherence/`): it checks that `CLAUDE.md`, the rules, this file, each plugin's README and the session's memory still match the code and each other, and proposes the fixes.

## Shared formats

Sessions running the `sessions` mod share stored data, files in its data folder and notices, and the launcher (`ccc`) reads and writes the same files. There's no compatibility code for older versions: after an update every session is restarted. Instead, every shared file and notice carries `format=<n>` (`FORMAT` in `hooks/state.ts`, `hooks/launcher.py`, `hooks/visor.sh` and `hooks/usage.py`): change a format and raise it everywhere in the same commit. A reader that meets another format acts on nothing and tells the person to restart the sessions. What the person chose and keeps (`sections.json`) has its own version (`sectionsFormat`), changes only by adding fields and is never silently ignored. Store keys are English; a stored value that changes meaning gets a new key. The API other plugins call (`$.sessions`) has its own version, `SessionsApi`: see `plugins/sessions/docs/plugin-contract.md`. Every location can be pointed elsewhere for tests (`SESSIONS_DATA_DIR`, `SESSIONS_JOBS_DIR`, `SESSIONS_DAEMON_LOG`, `SESSIONS_CLAUDE`, `SESSIONS_PLUGIN_VERSION`/`SESSIONS_PLUGIN_SINCE`), so a test session never touches the files of the sessions you use. Details: `.claude/rules/sessions-wire-format.md`.

`fleet` keeps its files in each project's `<project>/.claude/fleet/`, the project folder being its data folder (a test project is a test folder). The same rule holds there: the open decisions and answers, the landings, the reads, fleet's own state (records' versions, suspects, check results, the sweeper's lease, stamps, budgets, intake's counts and dedup marks, the alerts sent, slot leases, the judges' proposals, the overrules on their way, the live areas and each session's judge calls) and each instance's heartbeat and spend carry `format` (`FORMAT` in `plugins/fleet/hooks/decisions.ts`), the register, `config.json`, `world.json`, `roster.json`, `outbound.json` and `slots.json` are person data with their own versions (`registerFormat`, `configFormat`, `worldFormat`, `rosterFormat`, `outboundFormat`, `slotsFormat`), a poller's inbox item carries `itemFormat`, and a session on another format acts on nothing and says to restart. `fleet` reaches `sessions` only through `$.sessions`, checking `contract()` first. Details: `.claude/rules/fleet-wire-format.md`.
