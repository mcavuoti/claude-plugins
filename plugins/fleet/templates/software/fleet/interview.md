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
8. Budget: dollars a day for the fleet (at list price), or a share of the plan's weekly limit.
9. Confidentiality: what must never leave this machine or reach a third party.
10. Outbound: who the fleet may send anything to (by default, nobody but the person).
11. Cadence: how often each owner lands something; quiet hours; time zone.
12. The roster: how many area owners, which instances start in the first wave.

Then the drafts, each filed as mcp__fleet__decide kind "change": the charter (.claude/fleet/charter.md, the whole
content), the roster's changes (.claude/fleet/roster.json, edits) and the shared files' (.claude/fleet/world.json).
