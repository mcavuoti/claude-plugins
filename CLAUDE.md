# claude-plugins

A Claude Code plugin marketplace: each plugin lives in `plugins/<name>/` and is listed in `.claude-plugin/marketplace.json`. How to work here (platform code, checks, releases): CONTRIBUTING.md. Rules for specific files load from `.claude/rules/`.

Dependencies, not fallbacks, and no legacy support: CONTRIBUTING.md.

## Public repository: nothing personal

- Commit messages and pull request descriptions never carry a `Claude-Session:` line (it links to a private session). The `.githooks/commit-msg` hook drops it too.
- Commits use the account's GitHub noreply address, never a personal email; the hook refuses any other.
- Code, tests, docs and commit messages say nothing about the owner's machines, projects, folders or sessions. Test data uses placeholders: `/Users/x`, `/home/x`, ids like `aaaaaaaa`, made-up session names and round numbers, never values copied from a real log, store or session list.
