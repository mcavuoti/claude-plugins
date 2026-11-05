# The sessions panel's benchmark

Measures what the panel costs and how fast it answers, the same way for any copy of `plugins/sessions`, so a change is
measured before and after with identical scenarios: run it on a copy of the old commit, then on the new one, and
compare the two JSON files (`compare.py`).

```
python3 -m venv venv && venv/bin/pip install pyte          # once: the hidden terminal needs pyte
git archive --format=tar <commit> plugins/sessions | tar -x -C /tmp/before
venv/bin/python dev/sessions/ui-bench/bench.py --plugin /tmp/before/plugins/sessions \
  --folder <a trusted test folder> --out before.json --label "before"
venv/bin/python dev/sessions/ui-bench/compare.py before.json after.json
```

Measure a copy outside the clone you're editing (`git archive` above): test sessions load the copy inline, and Claude
reloads an inline plugin whenever a file of it changes.

## What it starts, and what it never touches

- **Test sessions.** `TEST A` … (`--sessions`, 6 by default) in `<folder>/mod` with the copy loaded inline
  (`CLAUDE_CODE_PLUGIN_DIRS`, the installed `sessions` and `fleet` disabled), and `TEST CTRL` in `<folder>/ctrl` with no
  panel: what a session costs without the mod. Each starts from an empty environment (`env -i`), with Haiku, a debug
  log (`--debug-file`) and its first prompt `Reply only: ok`.
- **Nothing real.** Every location the mod acts on points into a temporary folder: `SESSIONS_DATA_DIR`,
  `SESSIONS_JOBS_DIR` (an empty folder: no pins, no Remote Control) and `SESSIONS_DAEMON_LOG` (an empty log: nothing to
  reopen). The panel's notifications are off (`notificationsPerDay` 0). The token usage it shows is read from
  `~/.claude/projects` (read only) into the temporary folder once before the sessions start, as a running machine has
  it. It reads `~/.claude/sessions/<pid>.json` (read only) to time status changes.
- **Hidden terminals only** (`../hidden-terminal.py`, with `HT_TRACE` for the timings), and viewers are closed with
  SIGHUP. `--platform portable` (the default) runs the panel's Linux code (`SESSIONS_PORTABLE=1`): on a Mac it finds
  windows by process and has no tool to touch a real one. `--platform macos` runs the macOS code and allows only `idle`
  and `propagation`, which press no key in a panel (an Enter could open a Terminal window).
- **Its own folder.** It refuses to start if `<folder>` already has background sessions, because at the end it stops
  and removes every one of them (`../clean-test-sessions.sh <folder>`), then deletes the transcripts of the sessions it
  started, the subfolders it made and the temporary folder. `--keep` leaves all of it for a look.

## The scenarios

| Scenario | What happens | What's measured |
|---|---|---|
| `idle` | nothing for `--idle-seconds` (120), with no viewer, then again with `TEST A` open in a hidden terminal (`idleWithViewer`) | pane and band renders, the mod's spawns by command, what those spawned in turn, CPU, store and file writes |
| `propagation` | `TEST B`, open in a second hidden terminal, runs `sleep 6` through Bash (`--rounds`, 5) | from `TEST B`'s registry status changing to `TEST A`'s panel drawing its dot in the new colour, for busy and for done; the same in `TEST B`'s own panel |
| `switch` | Enter on `TEST B`'s row in `TEST A`'s panel, then back (`--rounds` each way) | from the key to the target's own panel showing it as the current session; the row focused on arrival |
| `ccc` | the copy's `setup/ccc` in a fresh hidden terminal in `<folder>/mod` (`--rounds`) | from the terminal starting to the opened session's panel; the commands it ran |

## Where each number comes from

- **Renders** (`paneRenders`, `bandRenders`): the engine's debug log has one line per render of a mod's component,
  `hooks module sessions@… ui.render settled in <ms> … key=sessions` (the pane, its id) or `key=above-prompt` (the band),
  for every version of the mod with no counter of its own. A session draws its pane with no window attached too.
- **Spawns** (`modSpawns`, `modSpawnsByCommand`): the debug log's `$.process.run (sessions): <program> with <n> args …
  (pid <n>)`, exact. The names come from the sampler when it caught the process (`claude agents`, `python3 usage.py`),
  else `claude (<n> args)`.
- **What those spawned** (`modGrandchildren…`): `procs.py watch`, a sampler of the process table every 2 ms (libproc on
  macOS, `/proc` on Linux) under the test sessions' pids. A process shorter than a pass can be missed, so these are lower
  bounds; `samplerCoverage` says how many of the mod's own spawns (known exactly) it caught. `engineChildrenByCommand`
  is what a session ran with no mod call behind it.
- **CPU** (`cpuPerSession`): `proc_pid_rusage` (macOS) or `/proc/<pid>/stat`: the session's own CPU and its reaped
  children's, over the window, as a percentage of one core; `control…` is `TEST CTRL`. The debug log costs every session
  a little, the control too.
- **Store and file writes**: the debug log's `$.store.set|delete (sessions@…): <key>` and `$.fs.write (sessions): <path>`
  lines, grouped by key or folder (the engine logs no reads, only failed ones).
- **Screens**: `HT_TRACE` records each changed row of a hidden terminal with its time and the colours of `●` and `▌`.
  The colours are named from the panel's own legend line (Attention, Working, Done, Idle, Stopped), else by hue. A row
  is a session's when `●` comes just before its name; `▌` before it marks the current session; `[`…`]` (reverse video)
  the focused one. `viewerScreenChangesPerMinute` counts the viewer's screen updates.

A newer copy can expose a counter of its own behind an environment variable: pass it with `--env KEY=VALUE` (every
test session gets it) and read it from the debug log the same way.

## The result

One JSON file: `label`, `plugin`, `version`, `claudeVersion`, `date`, `platform`, `conditions` (sessions, model, load
average, how many other sessions were running), `scenarios` and `errors`. Times are seconds; each timed list has `n`,
`median`, `p95`, `min`, `max` and the `values`. Rates are per minute, for all the test sessions with the mod together
(`perMinute`) or for one (`perSessionPerMinute`). A scenario that fails leaves its error in `errors` and the others run.

## Files

- `bench.py`: the run.
- `procs.py`: the process sampler and the CPU reading (`procs.py watch`, `procs.py cpu`).
- `compare.py`: two results side by side.
- `equivalence.py`: read only, on the real machine: whether reading Claude's files (`~/.claude/sessions/<pid>.json`
  and each background session's `~/.claude/jobs/<id>/state.json`) gives the list `claude agents --json --all` gives,
  every minute for as long as you let it run. It writes counts and field names only.
