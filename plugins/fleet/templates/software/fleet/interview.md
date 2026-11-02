# Kickstart interview

The chief asks these, in batches of at most 4 through mcp__fleet__decide, each with options and the one it recommends;
the person may always answer in their own words. Skip what earlier answers settled; ask a follow-up only when an answer
leaves the charter or the roster unclear.

1. The goal: what the code must do when this is done, and for whom.
2. Not in scope: what the fleet must leave alone.
3. Done: how we know it worked (tests that pass, a measure with a target).
4. The areas: how the codebase splits into parts one owner can hold, and which matter first.
5. How work lands: branches and worktrees, review, the tests that must pass, who merges.
6. The spec: where the requirements live (spec/), who may change them (only through an applied change).
7. Deadline and milestones.
8. Budget: dollars a day, at list price, for the fleet and for each role or instance (roster.json's "budget":
   { "usdDay": n }, at its top and on a role or an instance).
9. Confidentiality: what must never leave this machine or reach a third party.
10. The person's own places: their SSH hosts (a dev machine, a CI box), the git remotes pushes may go to, their
    addresses. They go in outbound.json, so the fleet's sends there need no draft; anything else is drafted for the
    person to approve (by default, nobody but the person).
11. Where the code is: an existing repository (its path), or a new one in a subfolder such as code/ (never the folder
    that holds .claude/fleet/: a repository there moves background sessions into worktree copies of the shared files).
12. Cadence: how often each owner lands something; quiet hours; time zone.
13. The roster: how many area owners, which instances start in the first wave.

Then the drafts, each filed as mcp__fleet__decide kind "change": the charter (.claude/fleet/charter.md, the whole
content, with where the code is), the roster's changes (.claude/fleet/roster.json, edits), the shared files'
(.claude/fleet/world.json) and the person's own places (.claude/fleet/outbound.json: "hosts", "remotes",
"recipients").
