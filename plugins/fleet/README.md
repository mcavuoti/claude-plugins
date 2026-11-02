# fleet

A Claude Code mod, turned on per project, for running a project as a fleet of permanent background sessions. In 0.3.0 it does five things:

- **a roster**: a project lists its roles and instances in `roster.json` (a template writes the first one), and `/fleet up` starts the instances that aren't running, each as a background session of its role's agent file, with its own settings, budget and place in the panel; each one seeds itself, and a chief interviews you and drafts the charter ([below](#the-roster-fleet-up));
- a background session that needs your decision asks it without stopping, keeps working on what doesn't depend on it, and gets your answer later; you answer from any session of the project, with a slash command that spends no tokens;
- the files the sessions share (the world: notes, plans, specs) behave like code with a compiler: a session's write of a shared file that changed since it read it is refused once, with who changed it and when, and a session hears at its next step that something it read has changed. No session has to remember to read a log ([below](#shared-files-changed-since-you-read-it));
- shared files others rely on can be records with versions: a work item cites what it relied on as `R-12@4`, and when R-12 is revised the work item turns suspect, the session that wrote it hears it, and a landing that cites the old version without having read the new one is refused once. One session sweeps the project every minute: the suspects, the project's own check scripts, and, if you want, a commit of the shared files ([below](#records-and-pins));
- **the command-level files** (the charter, the roster, `world.json`, the role files, the check scripts, and the records a template marks as requirements) are never written by an instance's own tools: an instance drafts a change, you read its diff, and `fleet` writes it once you apply it, if the file is still as it was drafted on ([below](#changes-to-command-level-files)).

It builds on [`sessions`](../sessions/README.md) (0.12.0 or newer): `fleet` starts, wakes, places and marks sessions through its API for other plugins.

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

**Light by design.** The one thing `fleet` blocks is an instance's own tools writing a command-level file (its settings deny it). Everything else marks or flags and holds nothing: a stale write is refused once and passes after a read, a Bash write is recorded after the fact, a budget used up stops new helpers and wakes but never a turn or another tool. There is no sandbox and no zone unless a roster asks for one.

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
/fleet init <template>
```

(Installing with `--scope local` instead also works, but it adds a second install record of `sessions` for that project, which a later update of `sessions` doesn't reach.)

Whatever the install says about versions, `fleet` asks `sessions` at run time which API it serves. Without it (`sessions` missing, failed or too old), `fleet` still queues and delivers decisions but shows no session names or states and no section, can't start instances (`/fleet up` prints the `claude --bg` lines to paste instead), and `/fleet status` says to restart.

## Kickstart: from nothing to a running fleet

```
> /fleet init proposal                    the template's roster, roles, seeds, charter stub and interview
> /fleet up --dry-run                     the plan: each instance, its model, budget and wave; the cost; the lints
> /fleet up Chief                         starts the chief, who seeds itself and asks you the interview
? 3 for you · /fleet
> /fleet 1a 2a 3 "a business case for the people who approve it"
                                          … a batch or two later, the chief files its drafts:
> /fleet
2 changes for you · answer with /fleet 1 apply · /fleet help

1. Change .claude/fleet/charter.md: "the charter, from the interview" (+22 −6 lines)
   @@ -6,25 +6,41 @@
    ## Goal
   -What the proposal must show, and to whom.
   +Produce a business case for the people who approve the work. …
   and 36 more lines in <project>/.claude/fleet/decisions/drafts/D-4.diff
   draft <project>/.claude/fleet/decisions/drafts/D-4.md (h0309395b) · /fleet 1 apply, /fleet 1 reject, or /fleet 1 edit to change the draft first
   Chief (idle) · D-4 · 31s ago

2. Change req/R-1.md: "R-1, the business case and its parts" (a new file, 34 lines)
   …

> /fleet 1 apply 2 apply
1: applied D-4: fleet wrote .claude/fleet/charter.md as drafted (h0309395b). Chief hears it.
2: applied D-5: fleet wrote req/R-1.md as drafted (h14b36530). Chief hears it.
> /fleet up --wave 1                      the leads and owners of the first wave
```

The chief is a role of the template, not code of `fleet`: it asks through `mcp__fleet__decide` (numbered questions, its recommendation marked, at most four at a time), so you answer from any session whenever you come by. With `solo` there's no chief: you write the charter yourself and talk to each owner directly.

## Setting a project up: `/fleet init [template]`

`/fleet init <template>` (typed by you) creates `<project>/.claude/fleet/` in the session's folder and copies the template into the project, never over a file that's there (it says which it kept):

| Template | What it starts |
|---|---|
| `blank` | nothing: the shared files are `<project>/notes/` and `<project>/docs/`, and the roster has no instances yet |
| `solo` | three owners sharing `<project>/notes/`, no chief: you talk to each one directly |
| `software` | a codebase: a chief, an integrator, owners per area (children of the integrator), a reviewer and a janitor, coordinating through the board and the spec (command-level) |
| `proposal` | research and convergence: a chief, a requirements owner (the requirements are command-level), an integrator who owns the proposal, researchers outside, inside and on the market, a lead proof of concept with its specialists, testers taking board items, a verifier, a janitor and a business-plan owner, in three waves |

A template is a folder (`templates/<name>/` in the plugin, or your own under the folder `FLEET_TEMPLATES_DIR` names, looked in first): `template.json` (`templateFormat`, a description, the folders to create, the next steps), `fleet/` (copied into `<project>/.claude/fleet/`: `roster.json`, `world.json`, `charter.md`, `interview.md`, `seeds/<role>.md`) and `agents/` (copied into `<project>/.claude/agents/`: one role file per role). Domain words live only in templates; `fleet`'s code knows roles, paths, ids and versions.

It also writes:

- `config.json`: the template and whether the register is committed (`"commitRegister": false`);
- `world.json`, when the template has none: the shared files, as globs relative to the project ([below](#shared-files-changed-since-you-read-it));
- `<project>/.claude/fleet/decisions/`: the open decisions, the answers, the drafts of changes and the register;
- `<project>/.claude/fleet/events/` and `<project>/.claude/fleet/reads/`: the landings on shared files, and what each session read of them;
- `<project>/.claude/fleet/state/`: the records' versions, the suspects, the check results, the sweeper's lease, the stamps of the command-level files ([below](#records-and-pins));
- `<project>/.claude/fleet/instances/`: each instance's settings file and its heartbeat, spend and nudges;
- `.gitignore`: keeps `<project>/.claude/fleet/decisions/`, `<project>/.claude/fleet/events/`, `<project>/.claude/fleet/reads/`, `<project>/.claude/fleet/state/` and `<project>/.claude/fleet/instances/` out of git (`state/` has a `.gitignore` of its own too). `/fleet init --commit-register` sets `commitRegister` and commits the register (`<project>/.claude/fleet/decisions/register/`) with the project, the rest of `<project>/.claude/fleet/decisions/` still ignored. The roster, the world, the charter, the seeds and the role files are the project's: commit them if you like.

Running it again only adds what's missing and brings `.gitignore` in line with `config.json`. A session in a subfolder of the project uses the nearest `<project>/.claude/fleet/` above it (an instance, the one its settings name); your home folder is never a project. Sessions that were already running join within a minute.

## The roster: `/fleet up`

`<project>/.claude/fleet/roster.json` (person data, `rosterFormat`) lists the roles and their instances:

```json
{
  "rosterFormat": 1,
  "sections": [{ "id": "work", "title": "Proofs of concept" }],
  "roles": {
    "poc": { "agent": "poc", "model": "sonnet", "effort": "high", "budget": { "usdDay": 12 }, "cadenceH": 6 }
  },
  "instances": [
    { "name": "Lead PoC", "role": "poc", "section": "work", "wave": 1, "model": "opus", "brief": "You lead the proofs of concept." },
    { "name": "PoC A", "role": "poc", "section": "work", "parent": "Lead PoC", "wave": 2, "brief": "You own area A." }
  ],
  "budget": { "usdDay": 150 },
  "wakes": { "everyMin": 60, "perDay": 8 }
}
```

- **A role** is a native agent file, `<project>/.claude/agents/<agent>.md`: its body is the role's charter (it replaces Claude Code's own system prompt for that session), its front matter its `name` and `tools`. The tools must list `mcp__fleet__*`, or `fleet`'s tools are hidden from it (and its start holds 8 s).
- **An instance** is one background session of a role. Its own fields win over its role's: `model`, `effort`, `budget.usdDay`, `cadenceH` (kept for a later release), `seed` (default `seeds/<role>.md`), `permissions` (`defaultMode`, `allow`, `ask`, `deny`) and `settings` (any other settings for its session: env, plugins, `worktree`…; the roster's top-level `settings` go to every instance). `section` and `parent` place it in the panel (one level: a parent's children are drawn under it); `wave` says when `/fleet up --wave n` starts it; `brief` goes with its seed.
- **`zones`** (optional, off unless a roster has them): named sets of `permissions` and `settings` a role or an instance takes with `"zone": "<name>"`.
- **`budget.usdDay`** at the top is the project's cap; **`wakes`** coalesce the nudges and wakes ([below](#budgets-and-wakes)).

`/fleet up [--dry-run] [--wave n] [name…]` (typed by you; `--dry-run` from anywhere):

- lints the roster: a role file missing, or not listing `mcp__fleet__*`, or named otherwise in its front matter; two instances with one name; a parent, section, role or zone that isn't there; `bypassPermissions` (never started); and warns when the budgets add up past the project's cap or the wake forecast passes half of it. An error stops it;
- prints the plan: each instance with its role file, section and parent, wave, model and effort, budget and wake forecast, and what it would do (start, running, wake, down); the cost; the command-level files changed outside fleet;
- writes each chosen instance's settings, `<project>/.claude/fleet/instances/<slug>.json`: the roster's settings for it, then `fleet`'s own, which can't be taken out: the env `FLEET_ROOT`, `FLEET_INSTANCE` and `FLEET_ROLE`, `model` and `effortLevel`, and deny rules, `Edit(//<path>)`, for each command-level file and for `<project>/.claude/fleet/instances/` (Edit covers Write; checked in a probe). No sandbox, no other denies;
- starts each instance that isn't running through `sessions` (`claude --bg --agent <agent> --settings <its file> -n <name>`, from the project's folder, with no prompt: a launch prompt would read as yours), and wakes one that's stopped. Names given start those (and bring back one you took down); `--wave n` starts waves 1 to n; neither starts them all. A running instance takes rewritten settings when you restart it (`u`): `/fleet status` says when its file changed since it started.

What each instance does when it starts (its own `fleet`):

- **binds**: its name from its settings (`FLEET_INSTANCE`), its role from the agent it runs as; its conversation starts with who it is, what it can't write, and its budget (again after `/clear` and compaction);
- **writes a heartbeat** every 30 s (`<project>/.claude/fleet/instances/<slug>/state.json`) with its spend;
- **seeds itself once** per session: a prompt of `fleet`'s own (never typed as yours) from its role's seed and its brief;
- **sits in its section**, under its parent once the parent's `fleet` runs, and in "Asking you" while it waits on you.

The sweeper marks the instances' rows in every panel: **✗ "no fleet in this session: u in the panel restarts it"** for one running with no heartbeat for 90 s (an old pre-started process that came up without the mod), **$** near or past its budget, **↓** for one you took down that still runs.

| Command | Does |
|---|---|
| `/fleet down [name…]` | takes instances down (all with no names): no wakes or nudges, `/fleet up` skips them; one that runs keeps running until you stop it (`s` in the panel: `fleet` never stops a session) |
| `/fleet remove <name> [--yes]` | lists, then with `--yes` deletes, a stopped instance's settings, heartbeat, spend and reads; it stays in the roster, down, and `/fleet up <name>` starts it afresh (a new session, seeded again) |
| `/fleet worktrees [prune [--yes]]` | the linked worktrees under `<project>/.claude/worktrees/`, which instance works in each; `prune --yes` runs `git worktree remove` on those no instance is in (git refuses one with changes not committed) |
| `/fleet budget [name\|project] [amount\|+n]` | today's spend and caps; sets or raises one for today ([below](#budgets-and-wakes)) |

## Changes to command-level files

The command-level files change only when `fleet` writes a change you approved. They are `<project>/.claude/fleet/charter.md`, `roster.json` and `world.json`, the role files in `<project>/.claude/agents/`, the check scripts `world.json` names, and the records `world.json` lists under `"command"` (`"command": ["req/**"]` in the `proposal` template).

- **Filing.** An instance calls `mcp__fleet__decide` with `kind: "change"`, the `path`, a one-line `summary`, and `edits` (`old_string` → `new_string`, as with Edit) or the whole `content`. `fleet` checks the path is command-level, applies the edits to the file as it is now, checks that a roster or a world draft parses, and keeps the draft and a line diff in `<project>/.claude/fleet/decisions/drafts/`. The ticket says nothing changes until you apply it.
- **Its own tools are refused** on those files, every time, with how to file a change instead (its settings deny them too, so it holds even where `fleet` didn't load).
- **`/fleet`** lists a change with its file, summary, size, the first lines of its diff, where the draft is and its version.
- **`/fleet <n> apply`** (typed by you): `fleet` claims the decision once (`<project>/.claude/fleet/decisions/applied/`), checks the file is still at the version it was drafted on and the draft is the one filed, and writes it. A file that moved since is refused ("not applied: … changed after D-5 was drafted") and the asker is told to draft it again; a draft that changed is refused until you type its new version (`/fleet <n> apply h1a2b3c4d`, after `/fleet <n> edit` shows where it is); a second apply is refused. A shared file lands as yours (`changed … by the person (a change applied by fleet)`), and its record gets a version.
- **`/fleet <n> reject`**, and `/fleet drop <n>`, close it unapplied. The asker hears the outcome as a message from `fleet` (`[D-5] The person applied your change to …`).
- **Your own edits** are always yours: `fleet` keeps a stamp of each command-level config file as it wrote it or you stamped it, and lists one changed another way in `/fleet status`, `/fleet up` and `/fleet accept`; `/fleet accept roster.json` (or `charter.md`, `world.json`, a role file's path) stamps it as yours. A flag, never a block.

## Budgets and wakes

- **Budgets** are in US dollars at list price, in both kinds of account (on a subscription they're a proxy for each instance's share of your plan's limits): `budget.usdDay` per role or instance, and the roster's top-level `budget.usdDay` for the whole project. Each instance's `fleet` turns its session's cost into today's spend (`<project>/.claude/fleet/instances/<slug>/spend.json`, your local day; a `/clear` or a restart counts from where it was).
- **At 80%** the instance hears it at its next step: land what you have.
- **At 100%** (its own budget, or the project's): its row is marked (`$`, needs you), the band says `$ 1 over budget · /fleet budget`, `fleet` doesn't wake or nudge it, and a new helper (the Agent tool) is refused with why and how you lift it. Its turn goes on and every other tool works: nothing else is held.
- **`/fleet budget "Tester 2" +5`** (or `20`, or `project 200`) sets or raises one for today; `/fleet budget` alone lists today's spend and caps. Tomorrow it's the roster's again.
- **The forecast** in `/fleet up --dry-run` and `/fleet status`: the budgets' sum, and what the wakes cost, each one reopening a context of about 40k tokens at the model's cache-write price, at most `wakes.perDay` a day.
- **Wakes, coalesced.** When an idle instance has something to act on (a shared file it read changed, a file it wrote is flagged), its own `fleet` nudges it with what changed, at most once per `wakes.everyMin` (60 by default) and `wakes.perDay` (8) a day. An instance the background service retired for being idle is woken by the sweeper (through `sessions`) when you answered its decision (within ten minutes) or when files it read changed (once per window). Never one you took down, nor one over its budget.

## What a background session gets: `mcp__fleet__decide`

In a background session (`claude --bg`, or one started from the panel or `ccc`) of a project with `<project>/.claude/fleet/`, the model gets a tool, `mcp__fleet__decide`, present from its first request. Its description tells the model to use it instead of AskUserQuestion or a question in its reply, which would leave the work waiting until you come by:

- 1 to 4 questions, each with 2 to 4 options, the option it recommends and one line on why, and optionally what waits on the answer (`blocks`);
- it answers at once: `Queued as D-3 for the person … The answer arrives later as a message from the fleet plugin that starts with [D-3]`, and the model goes on with what doesn't depend on it, or ends its turn;
- with `kind: "change"` it files a change to a command-level file instead ([above](#changes-to-command-level-files));
- a subagent can't use it ("put the question in your report to the main thread"), and a bad call (an option recommended that isn't one of the options, no reason) is refused with what to fix.

A regular session (plain `claude`, with you at the keyboard) doesn't get the tool: there the model asks with AskUserQuestion, and `fleet` records your answer (below).

## Answering: `/fleet`

In any session of the project, typed by you (`fleet` takes answers only from your own typing at a terminal, never from the model or another plugin):

| Command | Does |
|---|---|
| `/fleet` | lists the questions and changes waiting for you, oldest first, numbered, with who asked, its state and since when; then the decisions answered but not delivered yet |
| `/fleet 1a 2b` | answers questions 1 and 2 (also `1) a 2) b`, `1a, 2b`, `1a2b`) |
| `/fleet 3 "your words"` | answers in your own words |
| `/fleet 4 apply` | applies the change of item 4 as drafted (`4 reject`; `4 edit` says where the draft is, and `4 apply <version>` applies your edited draft) |
| `/fleet note 1 <text>` | adds a note for whoever asked question 1, delivered with the answer |
| `/fleet drop 1 [why]` | drops the decision of question 1 without answering it (also `/fleet drop D-3`): the asker is told to go on as it thinks best |
| `/fleet status` | what `fleet` does in this session: the project, whether `decide` is offered here and why not, `sessions`' API, the counts; the shared files, the last changes to them, and which session read a version that has changed since; the roster's instances (running, their `fleet`, seeded, spend and wakes today, settings changed since they started), the command-level files changed outside fleet; the records, the suspect files, the checks and what fails them, the sweeper and the world commits |
| `/fleet world` | the shared files (`world.json`); `/fleet world add <glob>` and `/fleet world remove <glob>` change them ([below](#shared-files-changed-since-you-read-it)) |
| `/fleet accept <path>` | stamps a change to a shared file, or to a command-level config file (`roster.json`, `charter.md`, `world.json`, a role file), made outside fleet (your editor, a script) as yours; `/fleet accept` alone lists those changes |
| `/fleet accept checks` | lets `fleet` run the check scripts `world.json` lists, as they are now ([below](#check-scripts)) |
| `/fleet init [template]` | sets the project up (above) |
| `/fleet up`, `down`, `remove`, `worktrees`, `budget` | the roster's commands ([above](#the-roster-fleet-up)) |

- The numbers are those of the last `/fleet` list shown in that session, so a question asked meanwhile doesn't shift them.
- The first answer wins: answering again (from another session, or twice) says `already answered … in <session>: a) SQLite`, and after delivery when it was delivered.
- A decision from a session that's gone from the list (removed) shows as `gone: /fleet drop D-3 clears it`; dropping it closes it at once.
- Answers typed over Remote Control from the phone aren't taken yet: that a plugin's command typed there runs and is told apart from the model hasn't been tried. Answer from a terminal session.

Above the prompt of every session of the project, `? 2 for you · /fleet` counts the questions and changes nobody answered yet (after whatever else is drawn there). And in the `sessions` panel, a background session that waits on you sits in an `Asking you` section until its questions are answered (never over a section you put it in yourself).

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

## Shared files: changed since you read it

Sessions of a project that work on the same notes, plans or specs coordinate through those files. In code a stale assumption fails loudly (the compiler, the tests); in documents it doesn't, and Claude Code doesn't refuse a write of a file that changed since the model read it either (it writes, and at most adds a note). So `fleet` does the checking, for the files listed in `world.json`:

```json
{ "worldFormat": 1, "paths": ["notes/**", "docs/**"] }
```

Globs relative to the project folder: `**` any folders, `*` within a name, `{a,b}` either. `fleet`'s own folder is never part of it. `/fleet world add specs` (a folder means everything under it) and `/fleet world remove docs/**` change the list, typed by you; every session follows within 2 seconds.

What happens, in every session of the project (background or not), for each thread (the session's main loop, and each of its helpers on its own):

- **A read** of a shared file (Read, or a Bash `cat`, `head`, `tail`, `sed -n` of one file) is noted with the version read (a hash of the text).
- **A write** (Write, Edit, NotebookEdit) of a shared file that changed since this thread read it, or that it never read, is refused once:

  ```
  fleet: notes/plan.md changed at 14:02 by TEST B (Edit), after you read it. Read it again, then redo this write
  so it agrees with that change (this write was not made).
  ```

  After a new read it passes. The gate is soft: a second try at the same version passes too, the model having been told. A new file, and anything outside the world, is never held. A helper's read doesn't count for the main thread, nor the reverse: whoever writes has to have seen it.
- **Every landing** (a write to a shared file by any session) is one small event: the file, who (session and helper), the tool, the versions, when. Never the content.
- **At its next step**, a thread that read a file someone else changed hears it, with no content, at most ten lines:

  ```
  fleet: a shared file you read has changed since you read it. Read it again before you rely on it or write it:
  - notes/plan.md: changed at 14:02 by TEST B (Edit)
  ```

  Mid-turn it rides the next tool result (Read, Write, Edit, NotebookEdit, Bash); otherwise it goes with the next prompt that starts a turn. Each change is told once, and nothing is added when nothing it read changed.
- **A Bash command** that writes a shared file isn't stopped: `fleet` compares the shared files before and after the command and records what changed as that thread's landing, marked *landed blind*. When the command changed a file someone else had changed after this thread read it, the model is told to check that change is still there.
- **Outside changes** (your editor, a script, a session without `fleet`) are found by a scan every 10 seconds and recorded once for the project as changed *outside fleet*. `/fleet accept notes/plan.md` stamps the current version as yours: the sessions that read an older version hear it as your change. `/fleet accept` alone lists the outside changes not stamped yet.
- **`/fleet status`** shows the shared files, the last changes and, for every session of the project, the files it read whose version has changed since.

This is coordination, not security: if `fleet` errs, or can't place a path, it lets the tool run. A `world.json` from a newer `fleet` is left untouched and nothing is held until the session restarts (`u`). Bash is never restricted. `claude -p` runs in a `fleet` project aren't followed (their writes show as outside changes).

## Records and pins

A project's templates can make some shared files records that others cite. These are conventions; `fleet`'s code knows nothing of what the records mean (it knows paths, ids, versions and globs):

```
<project>/req/R-12.md                          <project>/board/B-7.md
change: revision: max rate revised down        relies_on: [R-12@4]
R-12: …                                        status: started
                                               B-7: the proof of concept, built on R-12@4
```

- **A record** is a shared file whose name starts with an id: `R-12.md`, `R-12-max-rate.md` (capitals, a dash, digits; `world.json`'s `"idPattern"` sets another, as a pattern without groups or anchors). One record per file.
- **Versions.** `fleet` gives a record a version at each landing (Write, Edit, a Bash command, a change outside fleet, `/fleet accept`): v1 is the one it first sees, then v2, v3… They live in `fleet`'s own files, never in the record, so no model has to keep them right. A read of a record tells the model which version it is: `fleet: this is R-12@4 (cite it so; fleet tells whoever cites it when it changes).`
- **Pins.** A file, a record or not, cites what it relied on as `R-12@4`, anywhere in its text; the templates' convention is a front-matter line `relies_on: [R-12@4, F-40@2]`. Every `ID@n` in a shared file counts.
- **The kind of a change.** A record's `change:` line (in its front matter, or among its first lines) says what its last landing was: `editorial`, `addition`, `revision` or `retraction`, then one line, as in `change: "editorial: a typo"`. Only a revision or a retraction moves a pin on: an editorial fix to R-12 leaves B-7's `R-12@4` current. A change line that names no kind, or wasn't rewritten, counts as a revision; a removed record is a retraction. Only the kind is kept, never the line.

What happens:

- **At the gate**, besides "changed since you read it": a Write or Edit is refused once when it cites a version since revised that this thread hasn't read as it is now, or adds a pin of a record this thread never read in this conversation, with what to read:

  ```
  fleet: this write cites records you need to read first (this write was not made):
  - R-12@4: R-12 is at v5 now (a revision at 14:02 by TEST R). Read req/R-12.md, decide whether your work still holds,
    then cite R-12@5, or say in your record why v4 still holds.
  Then write again.
  ```

  It passes after the read, or on a second try (told once). A pin the file had already that is still current needs no read: a long document citing seventy records lands without re-reading them.
- **Suspects.** A file is suspect when it cites a version since revised or retracted, a version not there yet, or an id no shared file has; or when a Bash command wrote it citing pins its thread hadn't read as they are (it landed blind). A stale pin kept on purpose isn't: a landing whose thread read R-12 at v5 and still cites `R-12@4` confirms it, until R-12 moves again. A file that cites a suspect record is indirectly suspect (shown in `/fleet status`, not told). Suspects are flags: nothing is held for them.
- **Its owner hears it.** The session that wrote a suspect file last hears it at its next step, once per change:

  ```
  fleet: shared files you wrote last are flagged (nothing is held; fix them when you can: read what they cite, then
  update them, or say why they still hold):
  - board/B-7.md (B-7) cites R-12@4, and R-12 is at v5 (a revision at 14:02 by TEST R)
  ```

- **A Bash command** that writes a file whose pins its thread hadn't read as they are is told so at once (`fleet: your command wrote board/B-7.md, which cites R-12@4 (R-12 is at v5, …). It is marked suspect until it lands again: …`), and the file stays suspect until it lands again through Write or Edit.
- **The band** above the prompt, in every session of the project, counts the flagged files (suspect, or failing a check): `!! 2 flagged · /fleet status`, after the questions when there are any. `/fleet status` lists them with who wrote them last.
- **`strict`**: `"strict": true` in `world.json` (or a list of globs, `"strict": ["docs/proposal/**"]`) makes the gate refuse until the read, with no pass on a second try, for a file that changed since this thread read it and for its pins. Off by default.

## Check scripts

The project's own checks (a schema, citations, consistency) act as its linters, listed in `world.json`:

```json
"checks": [{ "glob": "board/**", "argv": ["bash", "checks/board.sh"] }]
```

- A check runs from the project's folder with the files to check as its last arguments. Exit 0 passes them all; otherwise a line that starts with a file's path (`board/B-7.md: no status line`, `board/B-7.md:3: …`) fails that file, and when no line names one, every file given fails with the first lines. A command that can't start, or runs past `timeoutMs` (20 s by default), is shown in `/fleet status` and fails nothing.
- `"when": "land"` (the default) runs it after each landing of a matching file, in the session that landed it, without holding the landing; the sweeper catches up every minute with what changed some other way. `"when": "sweep"` runs it from the sweeper every `"everyMin"` minutes (10 by default). `"name"` names it (by default its script's file name).
- Each result is stamped with the file's version: a file that didn't change isn't checked again.
- A failure goes to whoever wrote the file last, at its next step (`- board/B-7.md failed the check board.sh: no status line`), and shows in `/fleet status` and the band. Nothing is held.
- **You stamp them first.** `fleet` runs the checks as you, in every session of the project, with no permission prompt, so it runs them only after you type `/fleet accept checks`, and only while `world.json`'s checks and the scripts they name stay as you stamped them (`/fleet status` says so when they changed).

## The sweeper

One session of the project does the project-wide work, at no token cost: the first to take the lease in `<project>/.claude/fleet/state/sweeper.json` (one not renewed for 90 s is taken by another). Every minute, and within seconds of each landing, it reckons the suspects; it runs the checks that are due; and it makes the world commit when it's time. `/fleet status` names it.

## The world commit

Off by default; `"commit": { "everyMin": 60 }` in `world.json` turns it on. Every 60 minutes the sweeper commits the shared files that changed, and only them: it adds those paths and commits them with `--only` and the message `fleet: world 2026-11-02 14:00`, so whatever else you staged stays staged and out of it. It skips when nothing changed, outside a repository, while the index is locked, without a `user.name` and `user.email`, and when the project is a linked worktree; it never pushes. Claude runs a plugin's commands with the repository's hooks off, so the project's commit hooks don't run for it.

## Worktrees

- **A session started in a linked worktree** of the project's repository (under `<project>/.claude/worktrees/`, or made anywhere with `worktree add`) belongs to the main checkout's project: one world, one set of events, even when the project commits `<project>/.claude/fleet/` and the worktree has a copy of it.
- **A worktree's copy of a shared file isn't the world.** A read of the copy counts as a read of the shared file when they're the same; when they differ, the model hears it once. A write of the copy is refused once with the main checkout's path; a second try writes the copy only, and nobody is told. The scans never look inside a linked worktree.
- **Roles that write shared files** should stay in the main checkout. By default a background session in a repository moves into a worktree of its own before its first edit, and from there Claude refuses its edits of the main checkout, so its shared files would land in its copy. Give such sessions `"worktree": { "bgIsolation": "none" }` (in `<project>/.claude/settings.json`, or in the session's `--settings`: for an instance, the roster's `"settings": { "worktree": { "bgIsolation": "none" } }` on its role or at the top. Claude's settings reference says any settings file may set it; that a `--settings` value keeps a `--bg` session in the main checkout hasn't been tried, since a test folder that is a repository's root isn't trusted, so `fleet` doesn't add it by itself), and have them do code work in an explicit worktree, `<project>/.claude/worktrees/<name>` on a branch of their own, running its commands with `-C` and never `cd` (a `cd` moves the session's folder). A session that has to stay isolated reports its change to a shared file, or asks with `mcp__fleet__decide`, instead of writing its copy.

## The register

Every closed decision, and every AskUserQuestion of the model that you answered in a dialog (an option or text you typed; "Chat about this" and Esc record as not answered), is one JSON file in `<project>/.claude/fleet/decisions/register/<YYYY-MM>/`: the questions, the options, who asked, your answers and notes, where you typed them, and when it was delivered. Another plugin's dialog isn't recorded. It's out of git unless you chose `--commit-register`.

Once a day the first session to get there closes the decisions of sessions gone from the list as `abandoned` (their answers kept), and removes stray answer files and old temporary files.

## Files

```
plugins/fleet/
├── .claude-plugin/plugin.json   name, version, the sessions dependency, where the state types are
├── hooks/hooks.json             which module Claude loads
├── hooks/register.tsx           the mod: decide, /fleet, delivery, the recorder, the band, the section, the prune; the gate, the reads, the events, the scans, the digest; the roster, /fleet up, instances (binding, heartbeat, seed, nudges, budget), the change decision applied, the sweeper's marks and wakes
├── hooks/decisions.ts           pure logic: records and their files, decide's input, the /fleet grammar, the texts (tested)
├── hooks/changes.ts             pure logic of the shared files: world.json, globs, placing a path, versions, events, the gate's and the digest's words (tested)
├── hooks/records.ts             pure logic of records: ids, pins, change kinds, whether a pin is current, the gate's and the post-scan's verdict on pins, suspects, check results, the lease, the commit, worktree copies (tested)
├── hooks/roster.ts              pure logic of the roster: roster.json, instances, the lints, the generated settings and their denies, the forecast, budgets, wakes (tested)
├── hooks/drafts.ts              pure logic of the change decision: its input, edits, the line diff, the checks before applying, the words (tested)
├── templates/<name>/            blank, solo, software, proposal: template.json, fleet/ and agents/, copied by /fleet init
├── types/index.d.ts             fleet's state ($.state)
└── tests/                       decisions, changes, records, roster and drafts tests (pure); fleet, gate, pins, up and instance tests (the mod, with a stand-in for sessions typed by its contract and for the engine's file tools and shell); world.tsx
```

What it writes, all in the project (`fleet` keeps no store and nothing in your home folder): in `<project>/.claude/fleet/`, and on `/fleet init` the role files in `<project>/.claude/agents/` and the template's folders, never over a file that's there.

| Path | What | Version |
|---|---|---|
| `config.json` | the template, `commitRegister` | `configFormat` (person data: only gains fields) |
| `world.json` | the shared files' globs; `"command"`, the command-level records | `worldFormat` (person data) |
| `roster.json` | roles, instances, sections, budgets, wakes, settings | `rosterFormat` (person data) |
| `charter.md`, `interview.md`, `seeds/<role>.md` | the project's charter (command-level), the chief's interview, each role's first prompt | the template's |
| `<project>/.claude/fleet/decisions/queue/D-<n>.json` | an open decision (a choice, or a `change` with its path, summary and versions), written once by the session that asked | `format` |
| `<project>/.claude/fleet/decisions/answers/D-<n>.<q>.json`, `….note.json`, `D-<n>.drop.json` | answers (no-clobber: the first wins), notes, drops | `format` |
| `<project>/.claude/fleet/decisions/drafts/D-<n>.<ext>`, `D-<n>.diff`, `<project>/.claude/fleet/decisions/applied/D-<n>.json` | a change's draft and its diff, written once; its claim when you apply it (no-clobber: applied once) | `format` (the claim) |
| `<project>/.claude/fleet/decisions/register/<YYYY-MM>/<id>.json` | closed decisions and recorded dialogs | `registerFormat` (person data) |
| `<project>/.claude/fleet/decisions/last`, `<project>/.claude/fleet/decisions/prune/<day>`, `<project>/.claude/fleet/decisions/tmp/` | the last number handed out, the daily prune's marker, files about to be put in place | `format` |
| `<project>/.claude/fleet/events/<YYYY-MM-DD>/<HH>/<ms>-<session>-<n>.json` | one landing on a shared file (UTC hours), written once by the session that saw it; removed after 7 days | `format` |
| `<project>/.claude/fleet/events/latest`, `<project>/.claude/fleet/events/claims/` | the last event's name, which every session watches; outside changes claimed no-clobber, so one session records each | `format` |
| `<project>/.claude/fleet/reads/<session id>.json` | what that session's threads read of the shared files, written only by it (for `/fleet status` elsewhere and after a restart) | `format` |
| `<project>/.claude/fleet/state/revs/<id>/<n>.json` | version n of a record: its file's version, the kind, who, the pins it cites, a blind landing's suspect pins, the stale pins kept on purpose; written once (no-clobber: the first wins, the next landing takes n+1) | `format` |
| `<project>/.claude/fleet/state/suspects.json` | the suspect files and why, with who wrote each last; written by the sweeper | `format` |
| `<project>/.claude/fleet/state/checks/<hash>.json`, `<project>/.claude/fleet/state/checks-stamp.json` | the last results of the checks on one file, by its version (the last run wins); the checks you stamped | `format` |
| `<project>/.claude/fleet/state/sweeper.json`, `<project>/.claude/fleet/state/commit.json` | the sweeper's lease, rewritten by whoever holds or takes it; the last world commit | `format` |
| `<project>/.claude/fleet/state/stamps.json` | the command-level config files' versions as `fleet` wrote them or you stamped them (the last write wins) | `format` |
| `<project>/.claude/fleet/state/lifts.json`, `<project>/.claude/fleet/state/down.json`, `<project>/.claude/fleet/state/wakes.json` | today's budgets you set; the instances you took down; the sweeper's wakes today | `format` |
| `<project>/.claude/fleet/instances/<slug>.json` | an instance's `--settings` file, written by `/fleet up` | generated |
| `<project>/.claude/fleet/instances/<slug>/state.json`, `spend.json`, `nudges.json`, `seed-<ref>.json` | its heartbeat, today's spend, its nudges today, its seed sent; written only by its own `fleet` | `format` |

A session whose `fleet` meets another `format` (a session still on an older or newer version) acts on nothing and says to restart (`u`); a `config.json`, `world.json` or `roster.json` from a newer `fleet` is left untouched (a newer roster: `/fleet up` refuses it), and a decision of a kind it doesn't know is listed apart and never answered. The rules: [`.claude/rules/fleet-wire-format.md`](../../.claude/rules/fleet-wire-format.md).

## Turning it off

In a project: `claude plugin disable fleet@mcavuoti --scope local` (or remove the `fleet@mcavuoti` line from `<project>/.claude/settings.local.json`), then restart its sessions. `<project>/.claude/fleet/` stays with your register: delete it, or move it to the Trash, if you don't want it.

## Develop

- Try the repository's copy in throwaway sessions that load both plugins for that session only, with `sessions`' files pointed elsewhere, in a test folder with `<project>/.claude/fleet/` (run `/fleet init` there once):
  ```sh
  claude --bg --model claude-haiku-5-5 --settings '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"/path/to/claude-plugins/plugins/sessions:/path/to/claude-plugins/plugins/fleet","SESSIONS_DATA_DIR":"/tmp/t/data","SESSIONS_JOBS_DIR":"/tmp/t/jobs","SESSIONS_DAEMON_LOG":"/tmp/t/daemon.log"},"enabledPlugins":{"sessions@inline":true,"fleet@inline":true,"sessions@mcavuoti":false}}' -n "TEST A" "<a prompt that calls mcp__fleet__decide>"
  ```
  Attach another test session in `dev/sessions/hidden-terminal.py` to type `/fleet` there, and clean up with `dev/sessions/clean-test-sessions.sh <folder>`. With `--debug-file`, every step shows in Claude's debug log as `fleet: …` (`D-3 queued`, `delivering D-3`, `D-3 closed: delivered (turn …)`; for the shared files `notes/plan.md: tool (Edit)`, `refused once: Edit of notes/plan.md by main (stale)`, `digest to main: notes/plan.md`, `notes/plan.md: bash (Bash), landed blind`; for records `refused once: Write of board/B-3.md by main (pins R-1@1 stale)`, `board/B-2.md: landed blind citing R-1@1:stale, R-2@1:unread: suspect`, `flags to main: board/B-1.md`, `sweeper: this session`, `suspects: board/B-2.md`, `check board.sh on 1 file(s): failed board/B-2.md`, `world commit: fleet: world 2026-11-02 00:35 (1 file(s))`).
- **A TEST fleet.** The instances `/fleet up` starts get only their settings file, not your test session's `--settings`, so the roster carries the same thing for them: in the copied `roster.json`, `"settings": { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "…/sessions:…/fleet", "SESSIONS_DATA_DIR": "…", "SESSIONS_JOBS_DIR": "…", "SESSIONS_DAEMON_LOG": "…" }, "enabledPlugins": { "sessions@inline": true, "fleet@inline": true, "sessions@mcavuoti": false } }`, and a cheap model on every role (`"model": "claude-haiku-5-5"`); then `/fleet accept roster.json`. Without them an instance would load the installed `sessions`, and its real files. `/fleet status` shows each instance's heartbeat; `<project>/.claude/fleet/instances/<slug>/state.json` says how it bound (`boundBy: env`) and as which agent. The steps show in the person's session's debug log as `fleet: start Owner A: queued`, `marks: <ref>`, `woke <name> (…)`, `<D-n> applied: <path>`, `<D-n> not applied: <path> moved`; and in an instance's (when it has one) `instance Owner A (owner)`, `seed for Owner A`, `nudge to Owner A`, `refused a helper: over budget`. Clean up with `dev/sessions/clean-test-sessions.sh <folder>`, which stops the instances too.
- A test folder that is a repository's root isn't covered by the trust of the folder above it: `claude --bg` there exits with "Workspace not trusted", and accepting that prompt is yours. To try the world commit in a test folder, keep the repository's git folder outside it (move `.git` away, set its `core.worktree` to the folder, and put `"GIT_DIR": "<it>"` in the test sessions' `--settings` env): `fleet`'s commands follow `GIT_DIR`, while Claude itself then sees no repository, so worktree isolation can't be tried that way.
- A test folder under `~/.claude` makes every Write and Edit there a "sensitive file": `claude -p` refuses them whatever the allow rules, and a session asks (auto mode lets them through). Headless probes of the gate run from a folder outside it.
- After every change: `claude plugin validate plugins/fleet` and `claude plugin test plugins/fleet`; `dev/fleet/ci.sh` checks that `fleet` only calls `sessions`, runs every command from a folder that exists, and that each template is whole (`dev/fleet/check-templates.py`: its JSON, a role file with `fleet`'s tools for every role, a seed, sections and parents that exist).
- The tests load a stand-in for `sessions` typed by its contract (`EngineInterface['sessions']`), with the same golden list of methods as `sessions`' own contract test. Type-check with `npx -p typescript@5.6.3 tsc --noEmit -p tsconfig.json` in this folder once a session has loaded it (Claude lays the types, `sessions`' contract included, in `.claude-plugin/types/`).
