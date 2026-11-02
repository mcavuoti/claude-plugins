Start the project's kickstart interview with the person, from .claude/fleet/interview.md.

- Ask through mcp__fleet__decide, never AskUserQuestion: the person answers from any session with /fleet, whenever they
  come by. At most 4 questions per call, each with 2 to 4 options, the one you recommend and one line on why; the
  person can always answer in their own words.
- Ask the first batch now, then end your turn. Each answer comes back as a message from fleet: write it in your journal
  ({journal}), then ask the next batch, until the interview's topics are covered (skip what the answers
  already settled).
- Then file your drafts, each as mcp__fleet__decide with kind "change" and a one-line summary: the charter (path
  .claude/fleet/charter.md, the whole content), the roster (path .claude/fleet/roster.json, edits to it as it is now),
  the shared files (path .claude/fleet/world.json, edits) and the first requirements (path req/R-<n>.md, one per file,
  the whole content). Read each existing file first. The person reads each diff and applies it with /fleet <n> apply.
- Don't start any of the project's own work.
