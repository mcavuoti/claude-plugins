# `$.sessions`: the contract for other plugins (api 1)

From 0.11.0 the `sessions` mod adds a noun to `$` that other plugins call: what this session is, the state of other sessions, and sections in the panel; from 0.12.0 also starting and waking sessions, and marks on rows. Its methods never spend tokens nor talk to the model (the mod's one turn of its own is `ccc tell`'s, which hands a script's text to a background session the person opted in). Its types are written in one place, [`types/index.d.ts`](../types/index.d.ts) (from `SessionsApi` down); this page says how to use it and how it changes, and doesn't repeat the shapes.

## Depending on it

- List it in your `plugin.json`: `"dependencies": ["sessions"]`, or with a floor, `[{ "name": "sessions", "version": ">=0.11.0" }]`. Each time Claude loads your plugin from a folder it lays the contract into `.claude-plugin/types/sessions/`, so `$.sessions` is typed.
- **Calls only.** Never hook a `sessions.*` event: if `sessions` fails to load, or lacks that method, Claude unloads your whole plugin. A call fails only where it's made, with an error you can catch. Never read `sessions`' `$.state`, its store or its files (`sessions-data/`): they change without notice.
- **Find what's served first.** A method a copy doesn't have throws `TypeError`, and reading `$.sessions` itself is refused by the validator, so ask the copy you got. Once per process, lazily, raced against 500 ms (a `$` call isn't cut short by your hook's budget):

  ```ts
  let found: SessionsContract | null | undefined
  async function has($: EngineInterface, method: SessionsMethod): Promise<boolean> {
    if (found === undefined) {
      try {
        found = await Promise.race([$.sessions.contract(), $.clock.sleep(500).then(() => null)])
      } catch {
        found = null
      }
    }
    return !!found && found.api === 1 && found.methods.includes(method)
  }
  // if (await has($, 'status')) try { … } catch { /* say: restart the session (u) */ }
  ```

  Reset `found` in your `session.start`: when a plugin that adds a noun reloads, every plugin's module reloads with it.
- **Not in your `session.start`.** Your plugin runs before `sessions` (a plugin runs before the ones it depends on), so `sessions` hasn't started yet there. Call from a `$.clock.after` timer you start there, or from later hooks.
- From a hook the model waits on, race every call against `$.clock.sleep(500)` as above.

## The methods

| Method | What it does |
|---|---|
| `contract()` | the api number, `sessions`' version and wire format, and the methods this copy serves |
| `current()` | this session from memory: its ref, session id, name as the panel shows it, project root, whether it's a background session, and the agent it runs as (`claude --agent`) |
| `status({ refs, names })` | other sessions from the panel's last refresh (every 3 s): by ref (one not in the official list comes back `gone`) and by exact name (every session with that name, in any project), once each; a stopped background session says why (0.13.4, `stopped`) |
| `sections()` | every section and who's in which |
| `defineSection({ source, spec })` | creates or updates one of your sections |
| `assignSection({ source, ref, section, parent })` | puts a session in one of your sections, or takes it out of it (`null`); from 0.12.0 under a parent session |
| `start({ name, cwd, agent, settings })` (0.12.0) | starts a background session named `name` in the folder `cwd`, running as `agent` with the settings file `settings` (both optional): queued, and started a moment later |
| `wake({ ref, reason })` (0.12.0) | brings back a stopped background session the background service retired for being idle, or (0.13.4) that ended by itself (a crash, a restart of the machine or the service): `running`, `queued` or `refused` |
| `setMarks({ source, rows, ttlMs })` (0.12.0) | marks rows (by ref) in every session's panel for `ttlMs`: a badge, its tint, a status line under the row, whether the session needs the person |

- **Refs.** A session is named by its official short id from `claude agents` (it stays across `/clear`), or `sid:<sessionId>` for a regular session, which has none.
- **Before `sessions` has started** in this session, `current()` and `status()` answer `ready: false`; the section methods work, finding the data folder from the environment.
- **Sections.** `source` is your plugin's name; your section ids are `<source>:<name>`, and `me:` and `sessions:` are reserved (the person's own sections are `me:<slug>`, made with `/sessions section <title>`). You define and assign only your own, never over the person's choice or another plugin's: those answer `{ ok: false, reason: 'refused', detail }`. Bad input is `invalid`. Sections live in `sessions-data/sections.json` under a lock; when another session holds it, the call answers `busy` after about 300 ms: try again on a later tick. A `sections.json` written by a newer `sessions` is never rewritten: `defineSection` and `assignSection` are refused with a restart in the detail, and `sections()` rejects. From 0.13.1 a section of yours that stays empty goes: the cleanup (every 10 minutes in each session) drops one that two of its passes in a row found empty, so a section you just defined stays until its first member comes. Define a section again before you assign to it after it may have emptied (`assignSection` to a section that's gone answers `invalid`, "define it first").
- **How they're drawn.** The project's sessions in no section come first with no header, then each section by `order` (a plugin's default 200, the person's 100) and title, each with a dim header line, only when two or more groups have rows. While the panel has the keyboard nothing moves: a section or member you set then shows when the person leaves the panel. The order `ccc` opens sessions in doesn't change with sections. The person can fold a section into one line (`c`).
- **Parents** (0.12.0). `assignSection` with `parent: <ref>` draws the session right under that one, two columns in, in the parent's section (whatever its own), while the parent is in the list; one level only (a parent that is itself a child makes no children). From 0.13.1 a parent that waits for the person (red, or marked `needsPerson`) in another section than the child's own doesn't take the child along: the child is drawn as any row of its own section (a plugin that moves an asking session to an attention section of its own leaves its helpers where they were). It needs a section of yours (`section` not null); an assignment without `parent` (or with `null`) clears it, and so does the person moving the session. `sections()` shows it in the member.
- **Starting.** `start` checks what it can at once and answers `{ ok: true, queued: true }`; `sessions`' own timer then runs `claude --bg [--agent <agent>] [--settings <settings>] -n <name>` in `cwd`, with no prompt (a launch prompt would read as typed by the person). Find the session afterwards with `status({ names: [name] })`. Refused: a name the folder's project already has (or that's queued), a settings file outside `<cwd>/.claude/`, and the home folder. A folder Claude doesn't trust is only found out when it's tried: the session the call came from says so. Before `sessions` has read the session list here, `not-ready`.
- **Waking.** The background service retires an idle background session after an hour (8 with Remote Control); `wake` restarts such a session (`claude respawn`, from `sessions`' own timer) and answers `{ ok: true, state: 'queued' }`, or `state: 'running'` when it runs already. Why a session stopped comes from the service's log (`~/.claude/daemon.log`). From 0.13.4 it also restarts one that ended by itself: a crash, or the machine or the service restarting under it, which leave no line in the log (`status` says `stopped: 'ended'`). It never restarts a regular session, one the person stopped (`stopped: 'person'`: a `claude stop` the log shows, or the panel's `s`, which `sessions` remembers until the session runs again), nor one closed for lack of memory while memory is still short (`stopped: 'memory'`): those answer `{ ok: false, reason: 'refused', detail, state: 'refused' }`. A plugin that keeps instances up can call `wake` for each one whose `stopped` is `ended` after a restart, and leave the person's stops alone. `reason` is yours, for the debug log.
- **Marks.** A badge is up to 3 columns (`?2`), drawn after the name in its tint (or dim); the status line is up to 60 characters ("doing X / blocked on Y"), drawn under the row in the same tint; `needsPerson` puts the row in the `f` filter, "waiting for you", whatever its color. Each session of your plugin keeps its own set: a call replaces what it set before, and empty `rows` clears it. From 0.13.1 a row that breaks a limit is left out alone: the call sets the others and answers `{ ok: true, rejected: { <ref>: why } }` (before, the whole call was `invalid`); clip your text to the limits, and log what comes back in `rejected`. A call that's wrong as a whole (`source`, `ttlMs`, `rows` not an object or over 200 of them) is still `invalid`. They last `ttlMs`, at most 600000 (10 minutes): call again before then to keep them, so the marks of a plugin that stopped go by themselves. When several marks name one row, the newest wins (and it needs the person if any says so). Every panel picks them up within 3 s; while the panel has the keyboard a badge or a line's text changes in place, but a line never appears or goes (the rows would move). `/sessions status` lists whose marks are up.
- **What a method never does.** A method's `$` calls run inside your hook (Claude lends it your hook's context), so none submits a prompt, asks the person or moves the focus, every path is absolute and every command runs from a folder that exists.

## How it changes

| Number | Where | Raised when |
|---|---|---|
| plugin `version` | `.claude-plugin/plugin.json` | every release |
| `SessionsApi` | the literal in `types/index.d.ts` and `SESSIONS_API` in `hooks/register.tsx` | only when a method is removed or renamed, or a field changes meaning or shape |
| wire `FORMAT` | `hooks/state.ts` and the launcher's files | a change to the files and notices sessions share among themselves (`.claude/rules/sessions-wire-format.md`) |
| `sectionsFormat` | `SECTIONS_FORMAT` in `hooks/state.ts` | never in practice: sections only gain fields; a breaking change ships a one-time rewrite into a new key or file |

1. **Within an api, changes only add**: new methods, new optional input fields, new output fields. Ignore output fields you don't know, and check `contract().methods` for a method newer than the api. A method added after the api's first release is optional in the type (`start?:`), since an older copy lacks it: once `has()` said yes, call it as `$.sessions.start!(…)` (the validator wants a plain call: it refuses `$.sessions.start?.(…)`).
2. **A removal or a change of meaning raises `SessionsApi`** in one commit that also updates every plugin of this repository that calls it, and releases them together. There's no deprecation period: after an update every session is restarted.
3. **One list of methods.** `METHODS` in `hooks/register.tsx` is what `contract()` serves; `satisfies Record<SessionsMethod, 1>` makes a method missing from the type, or one too many, fail the type check. The golden list in `tests/contract.test.tsx` fails when a method disappears.

## Trying a plugin that depends on it

- In `claude plugin test`, load your plugin and an inline stand-in, or the real `sessions`, with `test(name, { plugins: [...] }, body)`. The test's own `$` has no plugin nouns: call through a plugin's hook, as `tests/contract.test.tsx` does with its probe.
- In a test session, load both folders for that session only: `CLAUDE_CODE_PLUGIN_DIRS` takes a `:`-separated list, with `"enabledPlugins": {"sessions@inline": true, "<yours>@inline": true}` (see the README's [Develop](../README.md#develop)). A bare `"dependencies": ["sessions"]` is met by the folder copy.
