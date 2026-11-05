# Kickstart interview

The chief asks these, in batches of at most 4 through mcp__fleet__decide, each with options and the one it recommends;
the person may always answer in their own words. Skip what earlier answers settled; ask a follow-up only when an answer
leaves the charter or the roster unclear.

1. The goal: what the code must do when this is done, and for whom.
2. Not in scope: what the fleet must leave alone.
3. Done: how we know it worked (tests that pass, a measure with a target).
4. The areas: how the codebase splits into parts one owner can hold, and which matter first.
5. How work lands: branches and worktrees, review, the tests that must pass, who merges.
6. How a change is proved here: the build and test commands, how to run one test, the slow suites and where they run
   (a CI box, a dev machine over ssh), what counts as proof. They go in verify.md.
7. The spec: where the requirements live (spec/), who may change them (only through an applied change).
8. Deadline and milestones.
9. Budget: dollars a day, at list price, for the fleet and for each role or instance (roster.json's "budget":
   { "usdDay": n }, at its top and on a role or an instance).
10. Confidentiality: what must never leave this machine or reach a third party.
11. The person's own places: their SSH hosts (a dev machine, a CI box), the git remotes pushes may go to, their
    addresses. They go in outbound.json, so the fleet's sends there need no draft; anything else is drafted for the
    person to approve (by default, nobody but the person).
12. Where the code is: an existing repository (its path), or a new one in a subfolder such as code/ (never the folder
    that holds .claude/fleet/: a repository there moves background sessions into worktree copies of the shared files);
    or a Perforce depot on a dev machine reached by ssh (its host and depot path).
13. The code to watch: the branch each code role's work is compared with (main, or origin/main fetched first) or the
    depot path, and each code role's worktree or client workspace. fleet tells a role at its next step when that
    branch changed a file it changed, or someone submitted a file it has open.
14. Cadence: how often each owner lands something; quiet hours; time zone. And the pace: how often fleet may wake or nudge an idle instance (roster.json's "wakes"). The
    template's, one every 60 min and at most 8 a day, keeps the cost low; offer `{ "everyMin": 20, "perDay": null }`
    (one every 20 min, no daily cap: the dry run prices it) and recommend it when results are wanted within the day.
    A role that checks something on a schedule (a mailbox, a queue) gets roster.json's `"poll": { "everyMin": n,
    "prompt": "..." }`, which fleet sends while it's idle, rather than a CronCreate of its own.
15. The roster: how many area owners, which instances start in the first wave.
16. Models and effort per role (roster.json's "model" and "effort", on a role or an instance): the strong model on
    hands-on technical work. Recommend opus for the integrator, the area owners and the reviewer, haiku only for the
    janitor, and effort xhigh for the reviewer and the integrator; the dry run prices each.
17. Deciding alone: what each role may decide without asking (by default, what is reversible inside its own area),
    and what must reach the person (by default: the goal or the scope, a conflict the owners couldn't settle, money,
    anything that leaves the project or touches its confidential material, what can't be undone). It's the charter's
    "Deciding alone, and asking the person" section; the fewer questions reach the person, the faster the fleet goes.

Then the drafts, each filed as mcp__fleet__decide kind "change": the charter (.claude/fleet/charter.md, the whole
content, with where the code is), how a change is proved here (.claude/fleet/verify.md, the whole content), the
roster's changes (.claude/fleet/roster.json, edits: a code role's worktree or client workspace too), the shared files'
(.claude/fleet/world.json, edits: the code to watch too) and the person's own places (.claude/fleet/outbound.json:
"hosts", "remotes", "recipients").

The shapes fleet reads for the code (only these keys):
- world.json's "code": `{ "repo": { "kind": "git", "path": ".", "upstream": "main", "everyMin": 5 } }`, one entry per
  repository or depot, named with lowercase letters, digits and -. A repository's path is relative to the project
  (`"fetch": true` fetches before it compares; with `"host"`, a machine reached by ssh, the path is absolute there); a
  depot is `{ "kind": "p4", "host": "<ssh host>", "depot": "//depot/<project>/...", "everyMin": 5 }`, with `"port"`
  and `"user"` when it needs them. `"off": true` leaves one unwatched.
- "code" on a role or an instance of roster.json: `{ "<repo name>": { "client": "<its client workspace>" } }`, or
  `{ "<repo name>": { "worktree": ".claude/worktrees/{slug}-*" } }` ({slug} is the instance's file name). Without it
  fleet finds an instance's worktrees at .claude/worktrees/<slug> and .claude/worktrees/<slug>-<anything>.
