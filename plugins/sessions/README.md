# sessions

A Claude Code mod (a plugin built on function hooks) that adds a side panel to every session with the sessions of the current project: what each one is doing, switching between them in a single terminal window, stopping, restarting and renaming them, and how many tokens you're spending. It also keeps background sessions with Remote Control alive while you drive them from your phone, and ships a status line.

Tested on macOS (Terminal.app) with Claude Code 2.1.289 to 2.1.316. On Linux it switches windows through its launcher instead of driving the terminal app; that mode was tested on macOS, and on a real Linux desktop it still needs the short check in [`dev/sessions/linux-checklist.md`](../../dev/sessions/linux-checklist.md) (see [Linux](#linux)).

```
s: Stop · u: Restart · r: Rename · n: New · a: Agents
 · ↑↓ Select · Enter Switch · ← Back

 ● Data pipeline       ↑◆ Opus 5.5   43%   1m
 ● Release notes        ◆ Opus 5.5   40%  45m
▌● panel work             Opus 5.5   63%   2m

● Attention  ● Working  ● Done  ● Idle  ● Stopped
↑ Claude 2.1.291 available · u: Restart
◆ Pinned (auto with Remote Control)

            (free space)

d: Day · w: Week · m: Month · p: All
▁▁▂▃▅▇█▆▄▃▂▁▂▃▅▆▄▂▁               1.2B
in 1.2B (97% cached) · out 3.4M (think 1.1M)
cache 1.1B read · 40M written · 20k uncached
```

## Install

Requirements: Claude Code 2.1.287 or newer (mods are on by default from there), `bash`, `python3` (token usage and the setup), `jq` (status line), `git`. On macOS the window switching drives Terminal.app (not iTerm); the first time, macOS asks to let Claude control Terminal.

1. Add the marketplace and install the plugin (once per machine):
   ```sh
   claude plugin marketplace add mcavuoti/claude-plugins
   claude plugin install sessions@mcavuoti
   ```
2. Open Claude Code in any folder (`claude`). The panel shows up on the right in fullscreen windows 110 columns wide or more, and in a box above the prompt otherwise.
3. In that session, run the one-time setup for the pieces a plugin can't configure on its own:
   ```
   /sessions setup
   ```
   It sets the status line, the keyboard shortcuts (`shift+→` to the panel, `←` back to the prompt) and the `ccc` shell command, backing up every file it changes (`<file>.bak-antes-<what>-<date>`), and tells you which shell it detected. Add `--dry-run` to see what it would do first. Already have a status line? It's kept unless you add `--force-statusline`. On macOS, `--macos-launcher` also stops macOS from asking again for Desktop/Documents access after every Claude update (see [Background sessions on macOS](#background-sessions-on-macos)). You can also run it from a terminal: `bash ~/.claude/plugins/marketplaces/mcavuoti/plugins/sessions/setup/setup.sh --help`.
4. Open a new terminal (so `ccc` exists), go to a project folder and run `ccc`. It opens the folder's top session (the first row of its panel) right there, with the panel showing and holding the keyboard. In a folder with no sessions it asks for a name, starts the session and opens it. See [Opening sessions with ccc](#opening-sessions-with-ccc). Claude only starts background sessions in a folder you trusted: the first time in a folder, run `claude` there once (or `ccc --agents`) and accept its question.

Optional: turn on auto-update for this marketplace in `/plugin` → Marketplaces → `mcavuoti` → Enable auto-update. Otherwise, update with `claude plugin marketplace update mcavuoti && claude plugin update sessions@mcavuoti`.

Sessions that were already open pick the plugin up when they restart (`u` in the panel, or `claude respawn <id>`). `ccc` always runs the installed version's launcher; the status line is a copy, so run `/sessions setup` again after an update that changes it.

**Coming from 0.9 or earlier:** run `/sessions setup` once (it moves `ccc` and the status line to `~/.claude/mods/sessions-data/bin/`, with backups), then restart every open session: until they restart, the sessions still on the old version and the new ones show in each other's panels but don't talk to each other (no arrival focus, questions asked locally). Once they're all restarted, the old folders `~/.claude/mods/sessions-bin`, `sessions-visor` and `sessions-uso` are no longer used.

**Coming from a folder install** (the mod loaded with `CLAUDE_CODE_PLUGIN_DIRS`): remove that variable from `env` in `~/.claude/settings.json` and disable the folder copy with `"enabledPlugins": {"sessions@inline": false}` in the same file. The second step matters because Claude's background service keeps the environment it started with and passes the old variable to every session it launches until it restarts.

## Opening sessions with ccc

| Command | Opens |
|---|---|
| `ccc` | The project's top session in this window: the first row of its panel (waiting for you, then done and unseen, working, idle), skipping stopped ones. If another window already shows a session of this project, that window comes to the front instead and nothing opens here. With no session to open, a Name prompt. |
| `ccc <name>` | The session with that name. If a window already shows it, that window comes to the front; if another window shows another session of the project, that window switches to it. A name that doesn't exist yet starts a new session with it. |
| `ccc --new` | This window, even if the project is open in another one: the top session not shown anywhere else (or the Name prompt if they all are). |
| `ccc --agents` | Claude's agent view for this folder. |

- **On arrival** the panel has the keyboard, on the row after the session you're in, as when you switch with Enter: Enter again hops on. A session waiting on a question or a permission keeps it: you land on the question.
- **The Name prompt** (an empty folder, or only stopped sessions) lists the stopped sessions with numbers: a number or a name reopens one, a new name starts a background session in the project folder and opens it once its panel is up (`Starting “name”…`). Enter on an empty line, or Ctrl+C, goes back to the shell; nothing is created until you type a name.
- **A session whose panel isn't running** (see [Old pre-started sessions](#old-pre-started-sessions)): `ccc` asks `Restart it first? [Y/n]` before opening it, Yes by default only when it's idle, since a restart cuts what it's doing. A session `ccc` itself just created and whose panel doesn't come up is restarted once without asking: it has no conversation to lose.
- **The project's window is brought forward** by a running session's panel (the platform code lives in the mod). Where that can't be done (Linux without `wmctrl` or `xdotool`, Wayland, a window Terminal.app doesn't have, or no session's panel answering), `ccc` says so and opens here, as `ccc --new` would.
- **Not trusted yet:** in a folder Claude never trusted, `claude --bg` refuses to start a session; `ccc` says so and how to trust it. In your home folder Claude doesn't start background sessions at all.

## What it does

- **Session list** for the project folder and its subfolders. The project is the nearest folder upwards with an `AGENTS.md` or `CLAUDE.md`, or else the folder the session started in. A session opened in your home folder (~) lists only that folder, not everything under it. Each row has a colored dot, the name, the model, the share of the context window used and how long ago:
  - red: waiting for you (a permission, a question);
  - blue: working;
  - yellow: finished and you haven't looked yet;
  - green: idle and seen;
  - gray: stopped.
- **The session you're in** is highlighted with a bar on the left. You can select it with the arrows like the others (even when it's the only one), to restart or rename it; Enter there does nothing, and `s` won't stop it (that would leave you without a window).
- **Switching sessions in the same window**: Enter on a row. On arrival, the other session's panel already has the keyboard, so you can hop through several with Enter. If the other session is already open in another window, that window comes to the front. Windows switch in place when they were opened with `ccc` (or by the panel); from a window opened another way (`claude attach` typed by hand), Enter opens the session in a new window next to it. A regular session (plain `claude`, not a background one) lives in its own window: Enter brings that window up, and if it runs somewhere the panel can't reach (tmux, another app), it tells you.
- **`!` after a name**: that session's panel isn't running (its mod never started, or it runs another version of the mod). Nothing is sent to it, questions about it are asked here, and `u` restarts it.
- **Stop** (`s`): Stop, Stop & Remove, or Cancel. The question shows up in the session you're stopping: the window goes there, you answer, and it comes back.
- **Restart** (`u`): restarts the selected session, yours included: a new process with the same conversation and name, which reloads MCP servers, plugins and settings (say, after adding an MCP server) and moves to the installed Claude version. Sessions on an older version are marked ↑. It always asks first: if the other session is working, waiting for you or has background tasks, the question shows up there; if it's idle, here. Restarting your own session, the window comes back to it by itself and says "Restarted". Background sessions only: restart a regular one with `/exit` and `claude -c`.
- **Rename** (`r`): opens a field under the list for the selected session's new name (yours, if it's the only one). The session renames itself with the official `/rename`, so the name changes in `claude agents` and on your phone too; if it's busy, it does so when it finishes. A session started with plain `claude` gets an automatic name (folder + two characters, like `myapp-1f`): rename it with `r` from another panel or `/rename <name>` inside it, and the panel picks it up within 3 s. You can also start with a name: `claude -n "name"`.
- **Pinning with Remote Control** (◆): Claude's background service closes an idle session with no window attached after an hour, or after 8 hours if it has Remote Control. A pinned session (Ctrl+T in `claude agents`) isn't closed. The mod pins every background session you turn Remote Control on for, in any folder, within 20 s, and unpins it when you turn it off. It only unpins the ones it pinned: yours stay. If you unpin one it pinned, it won't pin it again until Remote Control goes off and on again.
- **Reopening after a memory shortage**: when the machine runs out of memory (critical memory pressure on macOS, less than 1 GB free on Linux), the background service closes idle sessions, pinned ones too. The mod reopens the pinned ones with Remote Control that were closed for that reason once memory has been back to normal for 3 minutes in a row: same conversation, same Remote Control address, one at a time, at most 3 times in 2 hours each. One you stopped yourself isn't reopened. It needs at least one other live session running the mod.
- **New** (`n`): asks for a name, creates a background session and switches to it. Enter without a name gives it one after the folder, like the names Claude gives regular sessions (`myapp-1f`), unused by the project's other sessions. (In `ccc`'s Name prompt, Enter on an empty line still goes back to the shell.)
- **The New and Rename fields** keep you in them until you're done: Enter does it (an empty Rename field cancels), Esc cancels, and the arrows and Tab don't take you out, so a half-typed field can't be left behind.
- **Agents** (`a`): opens Claude's agent view (`claude agents`) in the same window. The agent view draws no panels (they show only in a session's own screen): open a session from it, or `←` back from one, to see the panel again.
- **Token usage**, at the bottom: bars for today by hour (`d`), 7 days (`w`) or 30 days (`m`), for all of Claude on this machine or just this project (`p`).
- **Status line** (after `/sessions setup`): model · effort · folder · git branch · context % · cost.
- **Closing the panel**: close it yourself (its ✕ or close key, or `/sessions` while it has the keyboard) and it stays closed, in this session and in every session that starts afterwards, until you open it again with `/sessions` or the button on the line above the prompt (`shift+→` then Enter, or a click). What you chose wins: arriving with `ccc` or Enter then lands on the prompt instead of the panel.
- Above each session's prompt, one line: how many sessions are waiting for you (red) or have something unseen (yellow), and when the panel isn't shown, why: `panel closed · /sessions to open`, or `panel hidden: window too narrow · /sessions to show` (Claude draws a panel the mod opened on its own only from 144 columns, 110 once you've opened it yourself; one you open with `/sessions` shows at any width).

## Keys

With the panel focused (`shift+→` after the setup, `ctrl+x Tab`, or `/sessions`):

| Key | Does |
|---|---|
| ↑ ↓ | move between sessions (never out of the list) |
| Enter | switch to that session |
| `s` | Stop / Stop & Remove (or Remove from list if it was already stopped) |
| `u` | Restart the selected session (yours too) |
| `r` | Rename the selected session |
| `n` | New: ask for a name (or Enter for an automatic one) and create a session |
| `a` | Agents: Claude's agent view |
| `d` `w` `m` | tokens for today, 7 days, 30 days |
| `p` | tokens for all of Claude or just this project |
| ← or Esc | back to the prompt |

`/sessions` opens the panel with the keyboard (or closes it, if it has it). `/sessions status` says whether the mod runs in this session and what started it (`session.start`, or the first draw, prompt or notice when that never came), the session's id and project folder, the mod's version and whether it's the installed copy or a folder copy, when it last wrote its heartbeat, and which sessions of the project have no running panel.

A plain `→` can't go to the panel only when the prompt is empty, the way `←` goes to the agent view: that `←` is built into the prompt box, and Claude's key bindings can't be conditioned on an empty prompt. Hence `shift+→`.

## Debug logs

Off by default. Turn on **Debug logs for new sessions** in the plugin's options (`/config`, or `"pluginConfigs": {"sessions@mcavuoti": {"options": {"debugLogs": true}}}` in `~/.claude/settings.json`). Then every session the panel (`n`) or `ccc` creates starts with `--debug-file ~/.claude/mods/sessions-data/debug/<name>.log` (Claude's own debug log, which works with background sessions), and the mod writes a line there for each step of its start. Restarting such a session (`u`, `claude respawn`) keeps writing to the same file. Sessions created before you turned it on, or another way, don't log. The mod mirrors the option to `~/.claude/mods/sessions-data/config` for `ccc`, which can't read plugin options.

## Linux

On macOS the panel drives Terminal.app (which window is in front, bring one forward, open one). On Linux there's no portable way to do that, so the panel works from processes and its launcher only, which every terminal has:

- **The window you're in** is the one whose launcher has your session open (found with `ps`). Open your windows with `ccc` (or the panel's Enter, New and Agents, which use the launcher too). `ccc` brings the project's window forward the same way the panel does (`wmctrl`/`xdotool`), or opens here when it can't.
- **Switching** happens in that same window, through the launcher, exactly as on macOS.
- **A session already open in another window** is brought forward with `wmctrl` or `xdotool` when one is installed (X11; the launcher titles each window with its session's name). On Wayland, or without either tool, the session opens in the current window too.
- **A new window** (for example, pressing Enter in the panel of a regular `claude` session, which can't be switched in place) opens with `$TERMINAL` if it's a known one, else `x-terminal-emulator`, GNOME Terminal (`gnome-terminal`, `kgx`, `ptyxis`), Konsole, Xfce Terminal, kitty, Alacritty, WezTerm, foot, Tilix, Terminator or xterm, whichever is found first.

| Feature | On Linux |
|---|---|
| List with colors, model, context % and time | works |
| Enter to switch, New, Agents (`a`) | works in windows that run the launcher (`ccc`) |
| Stop, Stop & Remove, Restart, Rename | works; questions show up in the other session, as on macOS |
| Bring forward a window showing another session | X11 with `wmctrl` or `xdotool`; otherwise it opens in the current window |
| A window opened without the launcher (`claude attach` typed by hand) | can't be switched in place (there's no way to type into it): open it with `ccc` |
| ↑ for an outdated version, token usage, pinning (◆), reopening after a memory shortage | works (version and folders read from `/proc`, memory from `/proc/meminfo`) |
| Automatic "seen" (yellow → green) | no: there's no telling which window is in front, so it stays yellow until you type in that session |
| Closing the windows of a stopped session | not needed: the viewer ends with the session and the launcher leaves the shell |

To try this mode on a Mac, start test sessions with `SESSIONS_PORTABLE=1` in their `--settings` `env`.

## Background sessions on macOS

macOS stores a program's permission for protected folders (Desktop, Documents, Downloads) by its path and signature, and each Claude version installs to a new path. Background sessions then ask for that permission again after every update, and one relaunched while nobody is at the Mac dies waiting for the prompt. `/sessions setup --macos-launcher` installs `extras/macos/claude-bg-launcher` as Claude's process launcher (`CLAUDE_CODE_PROCESS_WRAPPER`): it runs background sessions from a copy of Claude at a fixed path, so the permission is granted once. It only changes which file is run, following Claude's launcher contract.

## How it works

**Session data.** Only official sources: `claude agents --json --all` (its `status`, not `state`, which is an AI summary and gets things wrong), `claude plugin list --json`, the mod's events (`turn.start`, `turn.complete`, `session.receive`, `prompt.submit`) and `$.store`, the shared store Claude manages. Each session records its model, context %, version and when it finished there. The official list is fetched at most every 3.5 s across all sessions, shared through the store.

**Starting in a session.** The mod starts once per session, from whichever comes first: `session.start`, the first draw of the line above the prompt (a background session draws even with no window attached, and a draw's own `$` can start timers, open the panel and register `/sessions`), a prompt you type, or a notice from another session. The steps go one by one, each able to fail alone: the session's id and folders, its record, its heartbeat, the timers, the panel, and `/sessions` last. `/clear` (and `/resume`) keep the process but give the session a new id (the short id `claude attach` takes stays) and raise no new `session.start`: the mod follows the new id (on `session.end`, and on its 15 s beat in case nothing announced it), moving the session's record, heartbeat and inbox over; the old conversation's title and finish time don't carry over.

**Heartbeats.** Each session's mod rewrites `~/.claude/mods/sessions-data/alive/<sessionId>` every 15 s (its process id, the time, the mod's version, what started it). A session that runs, started more than 30 s ago and after a version with heartbeats was installed (`claude plugin list --json`), but has no fresh heartbeat from its current process, has a mod that never started: its row gets `!`, and `ccc` offers to restart it. A session started before that version was installed isn't flagged: it runs an older mod, which isn't broken.

**Shared formats.** Every file in `~/.claude/mods/sessions-data/` and every notice between sessions carries `format=<n>`. A session or launcher that meets another format acts on nothing and says to restart the sessions (`u`, or `claude respawn <id>`); the panel marks sessions on another format with `!` and sends them nothing. There's no compatibility code for older versions: after an update, restart every session.

**ccc.** The setup installs `~/.claude/mods/sessions-data/bin/ccc`, which nothing rewrites afterwards. Each time it runs it asks `claude plugin list --json` for the enabled copy of the plugin and runs that copy's launcher (`hooks/visor.sh start`), so it always matches the installed version (without an installed plugin, it uses the copy the setup ran from). `hooks/launcher.py` decides what opens:
- the project root as the panel computes it (the nearest folder upwards with `AGENTS.md` or `CLAUDE.md`);
- the order from `order/<root>`, which every panel of the project writes when its rows change (the unfocused order, the one rule in `state.ts`), or without a fresh one: waiting, working, idle, then by name;
- which windows show which session, from `ps` (a `claude attach <id>` per terminal);
- what to bring forward or open, as in the table above.

To bring a window forward it writes a request to a running session's `inbox/<sessionId>`; that session's mod polls its inbox every 0.5 s, brings the window forward with the platform code (`hooks/platform/`) and answers in `replies/`. Before opening a session, `ccc` writes a focus request in its inbox: the panel takes the keyboard then, even before the viewer attaches (it holds when the window attaches). If `claude attach` fails within 3 s of the first open, `ccc` picks again once without that session, unless the panel wrote a switch for the window meanwhile.

**Switching in one window.** Every window opened with `ccc` (or by the panel) runs the launcher, which opens `claude attach <id>`. To switch, the mod writes the next session to `~/.claude/mods/sessions-data/windows/<tty>` and closes the current viewer with `kill -HUP`; the launcher clears the screen and opens the next one. It takes about 0.6 s and nothing is typed into the terminal. A window without the launcher can't be switched in place: the panel opens the session in a new window next to it.

**Focus on arrival.** If you switched with the keyboard, the origin session sends the target a notice with `$.session.send`. The target's mod intercepts it in `session.receive` by returning `{ consumed }`, so it never reaches the model, and gives its panel the keyboard. Stop and Restart questions work the same way: the origin asks "ask there", the target asks, sends the window back and the answer, and the origin does what was chosen. Notices only go to sessions whose heartbeat shows they run the same format, so a session whose mod doesn't run never gets one as text.

**Restart.** `claude respawn <id>`: the same session (id, name, conversation) in a new process that reloads MCP servers, plugins and settings, on the installed version. The installed version comes from `claude --version` (every 5 minutes, shared), each session's from `$.session.version()`. To restart its own session, `claude respawn` can't run as that session's child: the service closes the session and takes the command with it before restarting it (it ends up stopped). So it runs detached, in its own process session (`perl -MPOSIX`, `fork` + `setsid`), after each window's launcher is told to reopen the session. If the session is still alive 15 s later, the restart failed: the notes are removed and you're told. "Restarted" is announced by the new process once it sees, by process, that the window reattached (`session.attach` doesn't fire for `claude attach`).

**Rename.** There's no command to rename another session. A mod can run a Claude command in its own session as if you typed it: `$.command.run({ command: 'rename', args })`. For another session, the origin's mod sends a notice with `$.session.send` and the target's mod runs its own `/rename`. A session whose panel isn't running (or runs another version) doesn't get the notice; the panel tells you to use `/rename` there.

**Pinning with Remote Control.** There's no command to pin: Ctrl+T in `claude agents` just writes `~/.claude/jobs/pins.json`, a list of ids, which the background service reads every time it decides whether to close a session. The mod does the same: it takes the same lock as Claude (the `pins.json.lock` folder), writes the list to a separate file and moves it into place. Whether a session has Remote Control is in its `~/.claude/jobs/<id>/state.json`: Claude writes `bridgeSessionId` when it's turned on, keeps it across relaunches and removes it when it's turned off. One session checks every 20 s for all of them; which sessions the mod pinned is kept in the shared store. A pinned session you stop doesn't come back on its own: the service only relaunches running ones.

**Reopening after a memory shortage.** Why a session closed comes from the background service's log (`~/.claude/daemon.log`): a session counts if the last thing that happened to it is `retire <id>: … [low memory…]` and it didn't start again afterwards (`claimed-spare`/`spawned`). Memory is read with `sysctl kern.memorystatus_vm_pressure_level` on macOS (1 normal, 2 warning, 4 critical: the same figure the service uses to close sessions). It reopens with `claude respawn <id>`. To test it without running out of memory, `SESSIONS_DAEMON_LOG` (in the `env` of a test session's `--settings`) points the mod at another log file, with a closing line added by hand.

**Token usage.** `hooks/usage.py` reads `~/.claude/projects/**/*.jsonl`. Each model response carries `message.usage`:
- `input_tokens`: uncached input, a few tokens per response;
- `cache_read_input_tokens`: the conversation Claude rereads from the cache;
- `cache_creation_input_tokens`: what's new at each step, written to the cache;
- `output_tokens`: the output, thinking included (`output_tokens_details.thinking_tokens`).

The same response appears several times in a file (once per content block), and sometimes copied into another file when a session is resumed, so it's counted once, by `message.id:requestId`, like [ccusage](https://ccusage.com). It reads only what's new in each file since last time and keeps totals per day (35) and per hour (48), in `~/.claude/mods/sessions-data/usage/`. The first run takes a few seconds; afterwards, hundredths. Several sessions can run it at once: it takes a lock.

**Status line.** `statusline/statusline.sh` reads the status JSON Claude passes on stdin and prints model · effort · folder (and the working folder when it drifted) · git branch · context % (yellow from 60 %, red from 80 %) · cost and lines changed. The setup copies it to `~/.claude/mods/sessions-data/bin/`, which is what it points `statusLine` at.

## Files

```
plugins/sessions/
├── .claude-plugin/plugin.json    name, version, where the state types are
├── hooks/
│   ├── hooks.json                which module Claude loads
│   ├── register.tsx              the mod: data, panel, switching, Stop, Restart, Rename, New, pinning, usage
│   ├── state.ts                  pure logic: colors, versions, pins, bars, sums, windows from ps (tested)
│   ├── platform/                 what differs by system: windows, processes, memory
│   │   ├── types.ts              the contract each system provides
│   │   ├── macos.ts              Terminal.app (AppleScript), ioreg, lsof, sysctl
│   │   ├── linux.ts              processes + launcher, wmctrl/xdotool, terminal emulators, /proc
│   │   └── index.ts              picks one when a session starts
│   ├── visor.sh                  the launcher that runs in each window
│   ├── launcher.py               what ccc opens: the top session, one window per project, the Name prompt
│   └── usage.py                  the token usage reader
├── statusline/statusline.sh      the status line
├── setup/setup.sh                the one-time setup (/sessions setup)
├── setup/ccc                     the ccc command the setup installs
├── extras/macos/claude-bg-launcher   optional macOS launcher for background sessions
├── types/index.d.ts              the mod's state types (the validator wants them here)
├── tests/                        automated tests: shared logic and drawing (panel.test), how the mod starts (start.test), each platform's pure parts
└── tsconfig.json
```

What the plugin creates at runtime, all in `~/.claude/mods/sessions-data/` (`SESSIONS_DATA_DIR` points it elsewhere): `bin/` (the `ccc` command and the status line, from the setup), `config` (the options `ccc` reads), `debug/` (debug logs, when on), `alive/` (heartbeats), `order/` (each project's panel order), `inbox/` and `replies/` (requests from `ccc` to a session's mod), `windows/` (one file per window with a launcher: which session comes next), `usage/` (token usage cache).

## Develop

- Work on a clone of the repository. Try your copy in throwaway sessions that load it for that session only (the `env` in `--settings` overrides the one in `settings.json`; exporting `CLAUDE_CODE_PLUGIN_DIRS` in the shell doesn't), with the mod's files and Claude's background service folder pointed elsewhere, so the test sessions never touch the files of the sessions you use:
  ```sh
  claude --bg --settings '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"/path/to/claude-plugins/plugins/sessions","SESSIONS_DATA_DIR":"/tmp/t/data","SESSIONS_JOBS_DIR":"/tmp/t/jobs","SESSIONS_DAEMON_LOG":"/tmp/t/daemon.log"},"enabledPlugins":{"sessions@inline":true}}' -n "TEST A" "Reply only: ok"
  ```
  `SESSIONS_PLUGIN_VERSION=0.10.0` and `SESSIONS_PLUGIN_SINCE=0` there (and in the launcher's environment) make the test sessions expect heartbeats as if that version were installed; `SESSIONS_CLAUDE` names the `claude` the mod and the launcher run.
- `dev/sessions/test-launcher.sh` checks what `ccc` opens without Claude (a stand-in `claude` and `ps` in a throwaway home folder); `dev/sessions/ci.sh` runs it with the setup's checks.
- Use a folder only for tests, and clean up only the sessions in that folder (`dev/sessions/clean-test-sessions.sh <folder>`). Never stop or remove sessions by name across folders: you can take down a real one.
- Code that differs by system lives in `hooks/platform/` (macOS and Linux), and each file is edited from its own system: see [CONTRIBUTING.md](../../CONTRIBUTING.md). A GitHub check runs the validation, the tests and the setup on both systems on every push.
- After every change: `claude plugin validate plugins/sessions` and `claude plugin test plugins/sessions`. The tests cover the pure logic and drawing the panel in the terminal and in the read-only surfaces (desktop, VS Code, phone).
- `dev/sessions/hidden-terminal.py` drives `claude`, `claude attach` or the launcher in a hidden terminal (keys in, screen out; `HT_COLS`/`HT_ROWS` set its size), so you can test switching, focus and dialogs without touching your windows.
- Reloading isn't instant: open sessions pick up changed mod files by themselves, sometimes only when their turn ends, and an idle one can take a long time. `claude respawn <id>` reloads it right away.

## Old pre-started sessions

Claude's background service keeps a pre-started Claude process ready (a "spare") and hands it to the next session that starts: `claude --bg`, a new session in the agent view, the agent view's own hidden pre-started session, `claude respawn`. A spare runs none of a mod's code until it's claimed, and the claim checks no age: one started hours earlier, before a plugin update, can come up running no mod at all (no panel, no heartbeat, no `/sessions`). There's no setting to turn spares off. So:

- the mod starts from its first draw, prompt or notice when `session.start` didn't come;
- its heartbeat shows from outside whether it runs: the other panels mark the row with `!`, and `ccc` offers to restart the session before opening it (`u` does the same from a panel); `/sessions status` inside a session says how its mod started;
- a restart (`claude respawn`) starts a new process; right after a claim the next spare is seconds old, so a session `ccc` just created gets one automatic restart if its panel doesn't come up.

## Lessons (API pitfalls)

- **A pane's focus follows positions, not elements.** If rows reorder while the pane has the keyboard, the highlight lands on another row. So while the pane is focused, rows keep their places.
- **A field that appears with `autoFocus` doesn't take the focus if the pane already had the keyboard.** The focus stays on whatever is now at that position: with the field above the rows, what you typed went to another row (and a space opened it), and when the field closed the focus fell on `d: Day` with the arrows stuck. So the fields go below the rows, the mod moves the focus to them with `$.ui.focus`, and the arrows bring a stray focus back to the selected session.
- **`$.ui.focus({ requestId, key })`** only works with the pane already focused, can answer "the focus moved meanwhile" (retry), and doesn't fire the mod's own `ui.focus` hook.
- **`$.ui.ask`** is the AskUserQuestion dialog: up to 4 options, it adds "Type something" and "Chat about this", and it queues behind a pending permission prompt. So the panel doesn't ask in a session that's already waiting for you.
- **The panel's colors can lag a few seconds.** Before something that cuts work short, the status is checked right then.
- **`claude respawn`** cuts a running turn and closes that session's viewers. Artifact watches (`artifact_watch`) aren't work: Claude carries them over to the new process. To count background tasks, do what Claude does: `inFlight.tasks - inFlight.drainableMonitors`, from the background service's state.
- **`claude respawn` of your own session from a child process leaves it stopped**: run it detached (`setsid`).
- **A background session's process has a terminal too** (the background service's internal one): when looking for the window showing a session by its processes, only a regular session's own terminal counts.
- **`session.attach` doesn't fire for `claude attach`** clients (only for remote surfaces like the phone, desktop or VS Code).
- **An Input's `value` isn't replaced by typing**: what you type is appended to it.
- **`$.process.run` rejects** if the command doesn't exist or times out. Every call goes through `runSafe`, which turns that into an error code.
- **The validator** wants the state types (`PluginState`) in `types/index.d.ts`, with no `import`.
- **A `ui.render` hook's own `$` can start the mod**: from a timer it schedules (`$.clock.after(0, …)`, since a draw only draws), it can read the session's id, write the store and files, start more timers, open the panel and register commands. The line above the prompt is drawn even in a background session with no window attached, sometimes before `session.start`.
- **Focus taken with no window attached holds**: `$.ui.open({ focus: true })` in a background session nobody is viewing gives the panel the keyboard, and it still has it when `claude attach` connects.
- **A panel opened unasked at the pre-started process's 200 columns stays placed** when a narrower window attaches.
- **`claude --bg` refuses folders Claude never trusted** ("Workspace not trusted…", exit 1) and your home folder; a subfolder of a trusted folder is trusted. `--debug-file` works with `--bg` (in a claimed pre-started process too), and `claude respawn` keeps it.
- **The agent view draws no panes**: a mod's panel shows only in a session's own screen.
- **`/clear` changes `$.session.id()`** (the transcript's id) but not the short id of `claude agents` and `claude attach`; `session.end` comes with `reason: 'clear'` and no `session.start` follows, and the module, its timers and its panel stay.
- **The agent view's hidden pre-started session isn't in `claude agents --json`**: a cleanup of the data of sessions missing from the list must spare sessions with a fresh heartbeat.
