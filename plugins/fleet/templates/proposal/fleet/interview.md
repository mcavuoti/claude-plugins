# Kickstart interview

The chief asks these, in batches of at most 4 through mcp__fleet__decide, each with options and the one it recommends;
the person may always answer in their own words. Skip what earlier answers settled; ask a follow-up only when an answer
leaves the charter or the roster unclear.

1. The goal: what the proposal must show, and to whom.
2. Not in scope: what the fleet must leave alone.
3. Success: how we know it worked (each measurable: a target, how it's measured).
4. The requirements: where they come from, who owns them (only an applied change rewrites req/).
5. Deadline and milestones.
6. Budget: dollars a day, at list price, for the fleet and for each role or instance (roster.json's "budget":
   { "usdDay": n }, at its top and on a role or an instance).
7. Scarce resources: licences, machines, people's time, and how many instances may use each at once (slots.json).
8. Sources: repositories, folders, documents and people to learn from, inside and outside; which mail or chat feeds
   the project (a poller dropping items in .claude/fleet/inbox/, or a listing tool of an MCP server) and the tags that
   route them.
9. The person: their own addresses, and how alerts reach them (push to the phone, a mail to themselves through an
   MCP send tool, a script of theirs, or only here), how many a day, and quiet hours.
10. Principals: who besides the person may direct the work, and in what scope (a request for a change from a
   principal's address is drafted for the person to confirm; anyone else's is a proposal).
11. Confidentiality: what must never leave this machine or reach a third party.
12. The person's own places: their SSH hosts (a dev machine that holds the code and runs the long jobs), the git remotes
    pushes may go to, their addresses. They go in outbound.json, so the fleet's sends there need no draft; anything
    else is drafted for the person to approve (by default, nobody but the person).
13. Cadence: how often each kind of owner lands something; quiet hours; time zone.
14. The roster: which roles and how many of each, the areas of the proof of concept, the first wave.

Then the drafts, each filed as mcp__fleet__decide kind "change": the charter (.claude/fleet/charter.md, the whole
content), the roster's changes (.claude/fleet/roster.json, edits: subscriptions and the person's channel too), the
shared files' (.claude/fleet/world.json: the tags too), the scarce resources (.claude/fleet/slots.json), the person's
own places (.claude/fleet/outbound.json: "hosts", "remotes", "recipients"), and the first requirements (req/R-<n>.md,
one per file, new files with their whole content).

The shapes fleet reads (only these keys; anything else is ignored or refused when the person applies it):
- slots.json: `{ "slotsFormat": 1, "slots": { "lab": { "count": 2, "leaseMin": 30, "what": "the test machines" } } }`,
  one entry per pool: a name of lowercase letters, digits and -, how many at once, how long a lease runs, what it is.
- roster.json's "person": `{ "addresses": ["me@example.com"], "principals": ["lead@example.com"], "front": "Chief",
  "channel": { "kind": "terminal" }, "perDay": 3, "quietHours": "22-7", "waitingMin": 120 }`. The channel's kind is
  terminal (nothing sent), push (`{ "kind": "push" }`), mcp (`{ "kind": "mcp", "server": "<server>", "tool": "<its send
  tool>", "to": "<one of the addresses>" }`) or command (`{ "kind": "command", "argv": ["bash",
  ".claude/fleet/channels/append.sh", "<a file>"] }`, which the person stamps with /fleet accept channel).
