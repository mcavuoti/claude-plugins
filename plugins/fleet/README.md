# fleet

A Claude Code mod, turned on per project, for running several sessions on one project at once. In 0.1.0 it does one thing: a background session that needs your decision asks it without stopping, keeps working on what doesn't depend on it, and gets your answer later; you answer from any session of the project, with a slash command that spends no tokens.

It builds on [`sessions`](../sessions/README.md) (0.11.0 or newer): the names and states of the asking sessions come from its panel, through its API for other plugins.

```
? 2 for you · /fleet                                   (above the prompt, in every session of the project)

> /fleet
2 questions for you · answer with /fleet 1a 2b · /fleet help

1. Which database for the cache?
   a) SQLite: one file, no server
   b) Redis
   Recommended: b, the queue already runs it
   Data pipeline (idle) · D-3 (1 of 2) · 4m ago

2. Should entries expire?
   a) After a day
   b) Never
   Recommended: a, stale data hurts more than misses
   Data pipeline (idle) · D-3 (2 of 2) · 4m ago

> /fleet 1a 2b
1: Which database for the cache? → a) SQLite
2: Should entries expire? → b) Never
D-3 goes to Data pipeline when it's idle
```

Tested on macOS with Claude Code 2.1.316. It has no code that differs by system, so it runs on Linux unchanged.

## Install

`sessions` first ([its install](../sessions/README.md#install)). Then, once per machine, install `fleet` turned off:

```sh
claude plugin install fleet@mcavuoti
claude plugin disable fleet@mcavuoti
```

and in each project that should use it, from the project's folder:

```sh
claude plugin enable fleet@mcavuoti --scope local
```

That writes `<project>/.claude/settings.local.json` in the project (yours only, not shared with the repository), and one `claude plugin update fleet@mcavuoti` later reaches every project. Sessions of the project that were already running pick it up when they restart (`u` in the panel). Then, in any session of the project:

```
/fleet init
```

(Installing with `--scope local` instead also works, but it adds a second install record of `sessions` for that project, which a later update of `sessions` doesn't reach.)

Whatever the install says about versions, `fleet` asks `sessions` at run time which API it serves. Without it (`sessions` missing, failed or too old), `fleet` still queues and delivers decisions but shows no session names or states and no section, and `/fleet status` says to restart.

## Setting a project up: `/fleet init`

`/fleet init` (or `/fleet init blank`, the only template in 0.1.0) creates `<project>/.claude/fleet/` in the session's folder:

- `config.json`: the template and whether the register is committed (`"commitRegister": false`);
- `<project>/.claude/fleet/decisions/`: the open decisions, the answers and the register;
- `.gitignore`: keeps `<project>/.claude/fleet/decisions/` out of git. `/fleet init --commit-register` sets `commitRegister` and commits the register (`<project>/.claude/fleet/decisions/register/`) with the project, the rest of `<project>/.claude/fleet/decisions/` still ignored.

Running it again only brings `.gitignore` in line with `config.json`. A session in a subfolder of the project uses the nearest `<project>/.claude/fleet/` above it; your home folder is never a project. Sessions that were already running join within a minute.

## What a background session gets: `mcp__fleet__decide`

In a background session (`claude --bg`, or one started from the panel or `ccc`) of a project with `<project>/.claude/fleet/`, the model gets a tool, `mcp__fleet__decide`, present from its first request. Its description tells the model to use it instead of AskUserQuestion or a question in its reply, which would leave the work waiting until you come by:

- 1 to 4 questions, each with 2 to 4 options, the option it recommends and one line on why, and optionally what waits on the answer (`blocks`);
- it answers at once: `Queued as D-3 for the person … The answer arrives later as a message from the fleet plugin that starts with [D-3]`, and the model goes on with what doesn't depend on it, or ends its turn;
- a subagent can't use it ("put the question in your report to the main thread"), and a bad call (an option recommended that isn't one of the options, no reason) is refused with what to fix.

A regular session (plain `claude`, with you at the keyboard) doesn't get the tool: there the model asks with AskUserQuestion, and `fleet` records your answer (below).

## Answering: `/fleet`

In any session of the project, typed by you (`fleet` takes answers only from your own typing at a terminal, never from the model or another plugin):

| Command | Does |
|---|---|
| `/fleet` | lists the questions waiting for you, oldest first, numbered, with who asked, its state and since when; then the decisions answered but not delivered yet |
| `/fleet 1a 2b` | answers questions 1 and 2 (also `1) a 2) b`, `1a, 2b`, `1a2b`) |
| `/fleet 3 "your words"` | answers in your own words |
| `/fleet note 1 <text>` | adds a note for whoever asked question 1, delivered with the answer |
| `/fleet drop 1 [why]` | drops the decision of question 1 without answering it (also `/fleet drop D-3`): the asker is told to go on as it thinks best |
| `/fleet status` | what `fleet` does in this session: the project, whether `decide` is offered here and why not, `sessions`' API, the counts |
| `/fleet init` | sets the project up (above) |

- The numbers are those of the last `/fleet` list shown in that session, so a question asked meanwhile doesn't shift them.
- The first answer wins: answering again (from another session, or twice) says `already answered … in <session>: a) SQLite`, and after delivery when it was delivered.
- A decision from a session that's gone from the list (removed) shows as `gone: /fleet drop D-3 clears it`; dropping it closes it at once.
- Answers typed over Remote Control from the phone aren't taken yet: that a plugin's command typed there runs and is told apart from the model hasn't been tried. Answer from a terminal session.

Above the prompt of every session of the project, `? 2 for you · /fleet` counts the questions nobody answered yet (after whatever else is drawn there). And in the `sessions` panel, a background session that waits on you sits in an `Asking you` section until its questions are answered (never over a section you put it in yourself).

## How the answer gets back

The asking session's `fleet` looks at the project's files every 2 seconds. Once every question of a decision has an answer (or it was dropped) and the session is idle, it hands the model the answers as a prompt of its own, which the session shows as `Prompt from the fleet plugin`:

```
[D-3] The person answered:
1) Which database for the cache? → a) SQLite
2) Should entries expire? → b) Never

Go on with what depended on it.
```

- **Once.** The decision closes at the turn that carries its `[D-3]`: its record goes to the register and its files are removed. It's sent again only when Claude didn't take it (a refusal or a failure) or after a restart, never because it's slow: a prompt waits behind a running tool or an open dialog for as long as they take.
- **A busy session** gets it when its turn ends; several decisions answered by then go in one prompt.
- **After an Esc** (you stopped the session), Claude takes no plugin prompts until you type something there, and `fleet` waits for that too.
- **After a restart** (`u`, `claude respawn`) the session's open decisions come back from the files, by its short id, which stays across restarts and `/clear`.
- **After a `/clear`** the answer arrives as the first turn of the new conversation. It quotes the questions, so it stands on its own, but the cleared model doesn't remember what it was doing.

## The register

Every closed decision, and every AskUserQuestion of the model that you answered in a dialog (an option or text you typed; "Chat about this" and Esc record as not answered), is one JSON file in `<project>/.claude/fleet/decisions/register/<YYYY-MM>/`: the questions, the options, who asked, your answers and notes, where you typed them, and when it was delivered. Another plugin's dialog isn't recorded. It's out of git unless you chose `--commit-register`.

Once a day the first session to get there closes the decisions of sessions gone from the list as `abandoned` (their answers kept), and removes stray answer files and old temporary files.

## Files

```
plugins/fleet/
├── .claude-plugin/plugin.json   name, version, the sessions dependency, where the state types are
├── hooks/hooks.json             which module Claude loads
├── hooks/register.tsx           the mod: decide, /fleet, delivery, the recorder, the band, the section, the prune
├── hooks/decisions.ts           pure logic: records and their files, decide's input, the /fleet grammar, the texts (tested)
├── types/index.d.ts             fleet's state ($.state)
└── tests/                       decisions.test (pure), fleet.test (the mod, with a stand-in for sessions typed by its contract), world.tsx
```

What it writes, all in the project's `<project>/.claude/fleet/` (`fleet` keeps no store and nothing in your home folder):

| Path | What | Version |
|---|---|---|
| `config.json` | the template, `commitRegister` | `configFormat` (person data: only gains fields) |
| `<project>/.claude/fleet/decisions/queue/D-<n>.json` | an open decision, written once by the session that asked | `format` |
| `<project>/.claude/fleet/decisions/answers/D-<n>.<q>.json`, `….note.json`, `D-<n>.drop.json` | answers (no-clobber: the first wins), notes, drops | `format` |
| `<project>/.claude/fleet/decisions/register/<YYYY-MM>/<id>.json` | closed decisions and recorded dialogs | `registerFormat` (person data) |
| `<project>/.claude/fleet/decisions/last`, `<project>/.claude/fleet/decisions/prune/<day>`, `<project>/.claude/fleet/decisions/tmp/` | the last number handed out, the daily prune's marker, files about to be put in place | `format` |

A session whose `fleet` meets another `format` (a session still on an older or newer version) acts on nothing and says to restart (`u`); a `config.json` from a newer `fleet` is left untouched. The rules: [`.claude/rules/fleet-wire-format.md`](../../.claude/rules/fleet-wire-format.md).

## Turning it off

In a project: `claude plugin disable fleet@mcavuoti --scope local` (or remove the `fleet@mcavuoti` line from `<project>/.claude/settings.local.json`), then restart its sessions. `<project>/.claude/fleet/` stays with your register: delete it, or move it to the Trash, if you don't want it.

## Develop

- Try the repository's copy in throwaway sessions that load both plugins for that session only, with `sessions`' files pointed elsewhere, in a test folder with `<project>/.claude/fleet/` (run `/fleet init` there once):
  ```sh
  claude --bg --model claude-haiku-5-5 --settings '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"/path/to/claude-plugins/plugins/sessions:/path/to/claude-plugins/plugins/fleet","SESSIONS_DATA_DIR":"/tmp/t/data","SESSIONS_JOBS_DIR":"/tmp/t/jobs","SESSIONS_DAEMON_LOG":"/tmp/t/daemon.log"},"enabledPlugins":{"sessions@inline":true,"fleet@inline":true,"sessions@mcavuoti":false}}' -n "TEST A" "<a prompt that calls mcp__fleet__decide>"
  ```
  Attach another test session in `dev/sessions/hidden-terminal.py` to type `/fleet` there, and clean up with `dev/sessions/clean-test-sessions.sh <folder>`. With `--debug-file`, every step shows in Claude's debug log as `fleet: …` (`D-3 queued`, `delivering D-3`, `D-3 closed: delivered (turn …)`).
- After every change: `claude plugin validate plugins/fleet` and `claude plugin test plugins/fleet`; `dev/fleet/ci.sh` checks that `fleet` only calls `sessions` and runs every command from a folder that exists.
- The tests load a stand-in for `sessions` typed by its contract (`EngineInterface['sessions']`), with the same golden list of methods as `sessions`' own contract test. Type-check with `npx -p typescript@5.6.3 tsc --noEmit -p tsconfig.json` in this folder once a session has loaded it (Claude lays the types, `sessions`' contract included, in `.claude-plugin/types/`).
