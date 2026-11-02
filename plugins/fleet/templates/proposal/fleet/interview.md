# Kickstart interview

The chief asks these, in batches of at most 4 through mcp__fleet__decide, each with options and the one it recommends;
the person may always answer in their own words. Skip what earlier answers settled; ask a follow-up only when an answer
leaves the charter or the roster unclear.

1. The goal: what the proposal must show, and to whom.
2. Not in scope: what the fleet must leave alone.
3. Success: how we know it worked (each measurable: a target, how it's measured).
4. The requirements: where they come from, who owns them (only an applied change rewrites req/).
5. Deadline and milestones.
6. Budget: dollars a day for the fleet (at list price), or a share of the plan's weekly limit.
7. Scarce resources: licences, machines, people's time, and how many instances may use each at once (slots.json).
8. Sources: repositories, folders, documents and people to learn from, inside and outside; which mail or chat feeds
   the project (a poller dropping items in .claude/fleet/inbox/, or a listing tool of an MCP server) and the tags that
   route them.
9. The person: their own addresses, and how alerts reach them (push to the phone, a mail to themselves through an
   MCP send tool, a script of theirs, or only here), how many a day, and quiet hours.
10. Principals: who besides the person may direct the work, and in what scope (a request for a change from a
   principal's address is drafted for the person to confirm; anyone else's is a proposal).
11. Confidentiality: what must never leave this machine or reach a third party.
12. Outbound: who the fleet may send anything to (by default, nobody but the person).
13. Cadence: how often each kind of owner lands something; quiet hours; time zone.
14. The roster: which roles and how many of each, the areas of the proof of concept, the first wave.

Then the drafts, each filed as mcp__fleet__decide kind "change": the charter (.claude/fleet/charter.md, the whole
content), the roster's changes (.claude/fleet/roster.json, edits: subscriptions and the person's channel too), the
shared files' (.claude/fleet/world.json: the tags too), the scarce resources (.claude/fleet/slots.json), and the first
requirements (req/R-<n>.md, one per file, new files with their whole content).
