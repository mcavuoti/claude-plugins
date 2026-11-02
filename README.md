# claude-plugins

A [Claude Code](https://code.claude.com) plugin marketplace: one repository that holds several plugins (mods, skills, agents, commands), each in its own folder under `plugins/`, listed in `.claude-plugin/marketplace.json`.

| Plugin | What it does |
|---|---|
| [`sessions`](plugins/sessions/README.md) | A side panel with the current folder's Claude Code sessions: status colors, switching between sessions in one terminal window, stop, restart, rename, auto-pinning (and reopening) sessions with Remote Control, a notification (on the phone with Remote Control) when a session has waited for you too long or spends far above its usual, token usage, a status line, `ccc tell` and `ccc section` for scripts, and an API other plugins use to start, wake and mark sessions. |
| [`fleet`](plugins/fleet/README.md) | Turned on per project, on top of `sessions`: a roster of permanent background sessions, started with `/fleet up` from a template (`solo`, `software`, `proposal`), each seeded, budgeted and placed in the panel, with a chief that interviews you; they ask you their decisions without stopping, and you answer them from any session of the project with `/fleet`, at no token cost; a session hears when a shared file it read changed, and its write of a stale one is refused once; records cited by version (`R-12@4`) turn their citers suspect when revised; the charter, the roster and the requirements change only when you apply a drafted change. |

## Install

Add the marketplace once per machine, then install the plugins you want:

```sh
claude plugin marketplace add mcavuoti/claude-plugins
claude plugin install sessions@mcavuoti
```

Then open a new Claude Code session (or run `/reload-plugins` in an open one).

`fleet` is installed turned off and turned on in each project that uses it: see [its install](plugins/fleet/README.md#install).

Some plugins need a one-time setup step for things a plugin can't configure on its own (your status line, keyboard shortcuts, shell commands). Each plugin's README says so; for `sessions`, run this inside Claude Code:

```
/sessions setup
```

## Update

Plugins don't update themselves by default for marketplaces like this one. Either update by hand:

```sh
claude plugin marketplace update mcavuoti
claude plugin update sessions@mcavuoti
```

or turn on auto-update once: `/plugin` → Marketplaces → `mcavuoti` → Enable auto-update. A plugin stays on its `version` (in its `.claude-plugin/plugin.json`) until that string changes, so a release is: bump the version, commit, push.

## Add a plugin

1. Create `plugins/<name>/` with at least `.claude-plugin/plugin.json` (`{"name": "<name>", "version": "0.1.0", "description": "…"}`) and the components it needs: `skills/<skill>/SKILL.md`, `agents/*.md`, `commands/*.md`, `hooks/hooks.json` (hooks or a mod module), `.mcp.json`, `bin/` (executables on the Bash tool's PATH).
2. Add an entry to `plugins[]` in `.claude-plugin/marketplace.json` with the same `name` and `"source": "./plugins/<name>"`.
3. Check it:
   ```sh
   claude plugin validate .
   claude plugin validate plugins/<name>
   ```
4. Optionally, add the plugin's own checks to `dev/<name>/ci.sh` (the GitHub check runs it on macOS and Linux) and rules Claude should follow when editing its files to `.claude/rules/` (with `paths:`; see [CONTRIBUTING.md](CONTRIBUTING.md)).
5. Commit, push, and on each machine `claude plugin marketplace update mcavuoti` + `claude plugin install <name>@mcavuoti`.

Marketplace names starting with `claude-` or `anthropic-` are reserved, which is why the marketplace is called `mcavuoti` while the repository is `claude-plugins`.

## Develop

Developing on macOS and Linux (some code can only be tried on its own system): see [CONTRIBUTING.md](CONTRIBUTING.md). Every push runs the validation and tests of every plugin on macOS and Linux (`.github/workflows/test.yml`).


- Work on a clone of this repository, not on the installed copy (`~/.claude/plugins/cache/…`).
- Try a plugin from the clone without installing it, in a throwaway session, by loading its folder for that session only (the `env` in `--settings` overrides the one in your `settings.json`). A folder loaded that way shows up as `<name>@inline`; enable it explicitly in case your settings disable it:
  ```sh
  claude --bg --settings '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"/path/to/claude-plugins/plugins/sessions"},"enabledPlugins":{"sessions@inline":true}}' -n "TEST A" "Reply only: ok"
  ```
  An enabled `@inline` copy wins over the installed plugin with the same name.
- `claude plugin test plugins/<name>` runs a plugin's tests (for mods, the `tests/` folder).
- `dev/` has tools for developing and testing the plugins here; they aren't installed with them. See [`dev/sessions`](dev/sessions) for driving Claude Code in a hidden terminal.
