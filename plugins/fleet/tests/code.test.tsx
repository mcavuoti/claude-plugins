import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { BAND, DEC, FAKE_LOG, FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// The code watch, run by the sweeper with git and p4 standing in (git's output shaped as git 2.50 prints it, p4's
// through ssh as a server's -ztag is), and the command repository's two commands; then the proofs findings and
// results carry, and the record /fleet up --wave n shows of the waves before it

const STATE = `${FLEET}/state`
const WT = `${ROOT}/.claude/worktrees`
const SHA = '436d16c0d7b5a1f3e2c4b6a8d0e2f4a6b8c0d2e4'
const OWNER = '---\nname: owner\ndescription: owns an area of the code\ntools: Read, Write, Edit, Bash, mcp__fleet__*\n---\nYou own an area.\n'
const ROSTER = {
  rosterFormat: 1,
  roles: { owner: { agent: 'owner', code: { depot: { client: 'project-{slug}' } } } },
  instances: [
    { name: 'Area A', role: 'owner', code: { tools: {} } },
    { name: 'Area B', role: 'owner' },
  ],
}

function project(code: Record<string, unknown>, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [`${FLEET}/roster.json`]: JSON.stringify(ROSTER),
    [`${ROOT}/.claude/agents/owner.md`]: OWNER,
    [`${FLEET}/seeds/owner.md`]: 'Take an item.',
    [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], code }),
    [`${ROOT}/notes/a.md`]: 'a\n',
    ...extra,
  }
}

function beat(name: string, slug: string, ref: string, at: number, cwd = ROOT): string {
  return JSON.stringify({ format: 1, instance: name, slug, ref, sessionId: `${ref}-0000-0000-0000-000000000000`, at, cwd, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: at, lastLanding: at })
}

function calls(w: World, kind: string): any[] {
  return (w.files.get(FAKE_LOG) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(c => c[kind])
    .map(c => c[kind])
}

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

/** Time goes by with Area A's and Area B's own fleet beating, as running instances' do */
async function run(w: World, n: number, step = 30000) {
  for (let i = 0; i < n; i++) {
    w.touch(`${FLEET}/instances/area-a/state.json`, beat('Area A', 'area-a', 'aaaaaaa1', w.clock.now()))
    w.touch(`${FLEET}/instances/area-b/state.json`, beat('Area B', 'area-b', 'bbbbbbb1', w.clock.now()))
    await tick(w, step)
  }
}

const TREES = `worktree ${ROOT}\nHEAD ${SHA}\nbranch refs/heads/main\n\nworktree ${WT}/area-a-1\nHEAD aaaa\nbranch refs/heads/area-a-1\n\nworktree ${WT}/area-b-1\nHEAD bbbb\nbranch refs/heads/area-b-1\n\nworktree ${WT}/someone-else\nHEAD cccc\nbranch refs/heads/other\n\n`
const LOG = `\x01${SHA}\t1793628120\tTEST Integrator\n\nsrc/x.c\nsrc/y.c\n`

/** git as the repository answers: main at SHA, three linked worktrees; what each lacks and changed */
function fakeGit(w: World, lacking: Record<string, string>, changed: Record<string, string>, status: Record<string, string> = {}) {
  const seen: string[][] = []
  w.exec.value = argv => {
    if (argv[0] !== 'git' || argv[3] !== '-c') return undefined
    seen.push(argv)
    const dir = argv[2] as string
    const sub = argv[5]
    if (sub === 'rev-parse') return argv.includes('main^{commit}') ? { exitCode: 0, stdout: `${SHA}\n` } : { exitCode: 1, stderr: 'fatal: no such ref' }
    if (sub === 'worktree') return { exitCode: 0, stdout: TREES }
    if (sub === 'log') return { exitCode: 0, stdout: lacking[dir] ?? '' }
    if (sub === 'diff') return { exitCode: 0, stdout: changed[dir] ?? '' }
    if (sub === 'status') return { exitCode: 0, stdout: status[dir] ?? '' }
    return { exitCode: 1, stderr: 'unknown' }
  }
  return seen
}

test('git: the sweeper finds what moved on main under an instance\'s own changes; its row is marked ↻ until it rebased', WITH_SESSIONS, async ($, on) => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  const w = world(on, {
    background: false,
    files: project({ repo: { kind: 'git', upstream: 'main' } }, { [`${FLEET}/instances/area-a/state.json`]: beat('Area A', 'area-a', 'aaaaaaa1', now), [`${FLEET}/instances/area-b/state.json`]: beat('Area B', 'area-b', 'bbbbbbb1', now) }),
  })
  const seen = fakeGit(w, { [`${WT}/area-a-1`]: LOG, [`${WT}/area-b-1`]: LOG }, { [`${WT}/area-a-1`]: 'src/x.c\n', [`${WT}/area-b-1`]: 'src/z.c\n' }, { [`${WT}/area-a-1`]: '?? notes/n.md\0' })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Area A', 'idle'), bbbbbbb1: row('bbbbbbb1', 'Area B', 'working') } })
  await startSession($, w)
  await run(w, 6)
  // Read-only commands, from / with every path absolute
  expect(seen.every(a => ['rev-parse', 'worktree', 'log', 'diff', 'status'].includes(a[5] as string))).toBe(true)
  expect(seen).toContainEqual(['git', '-C', `${WT}/area-a-1`, '-c', 'core.quotePath=false', 'log', '--max-count=200', '--name-only', '--format=%x01%H%x09%ct%x09%an', `HEAD..${SHA}`])
  expect(w.runs.some(r => r[0] === 'git' && r.includes(`${WT}/someone-else`))).toBe(false)
  const st = json(w, `${STATE}/code.json`)
  expect(st.repos.repo).toMatchObject({ kind: 'git', marker: SHA, ok: true, seats: { 'area-a': '.claude/worktrees/area-a-1', 'area-b': '.claude/worktrees/area-b-1' } })
  // Area B changed only src/z.c: nothing moved under it
  expect(st.overlaps).toEqual([{ slug: 'area-a', name: 'Area A', repo: 'repo', kind: 'git', upstream: 'main', path: 'src/x.c', rev: SHA, who: 'TEST Integrator', at: 1793628120000, where: '.claude/worktrees/area-a-1', since: expect.any(Number) }])
  const marks = calls(w, 'setMarks')
  expect(marks[marks.length - 1].rows.aaaaaaa1).toEqual({ badge: '↻1', tint: 'warning', line: 'main moved under 1 of its file: rebase' })
  expect(marks[marks.length - 1].rows.bbbbbbb1).toBeUndefined()
  const status = await fleet($, 'status')
  expect(status).toContain('code: repo (git, main in .), every 5 min: polled at ')
  expect(status).toContain('watching Area A (.claude/worktrees/area-a-1), Area B (.claude/worktrees/area-b-1)')
  expect(status).toMatch(/ {2}Area A: main moved under src\/x\.c \(436d16c by TEST Integrator at \d\d:\d\d\), in \.claude\/worktrees\/area-a-1, since \d\d:\d\d/)
  expect(await fleet($, 'brief')).toMatch(/ {3}- Area A: main moved under src\/x\.c \(436d16c by TEST Integrator at \d\d:\d\d\), since \d\d:\d\d: it hears it at its next step \(rebase\)/)
  // It rebases: its branch has main's commit, so it lacks nothing; at the next poll (5 min) the overlap goes, and its mark
  fakeGit(w, {}, { [`${WT}/area-a-1`]: 'src/x.c\n' })
  await run(w, 12)
  expect(json(w, `${STATE}/code.json`).overlaps).toEqual([])
  const after = calls(w, 'setMarks')
  expect(after[after.length - 1].rows.aaaaaaa1).toBeUndefined()
  expect(w.logs.some(l => l.includes('fleet: code repo: polled, at 436d16c0d7b5; overlaps: Area A src/x.c'))).toBe(true)
})

test('an instance hears what moved upstream under its own change once, as a nudge when idle; then nothing more', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Area A', FLEET_ROLE: 'owner' }, files: project({ repo: { kind: 'git' } }, { [`${FLEET}/instances/area-a.json`]: '{"env":{}}\n' }) })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('classic.SessionStart', () => ({}))
  // This session is Area A, working in its worktree (its session's folder is there), and the project's sweeper
  w.root.value = `${WT}/area-a-1`
  w.dirs.add(`${WT}/area-a-1`)
  fakeGit(w, { [`${WT}/area-a-1`]: LOG }, { [`${WT}/area-a-1`]: 'src/x.c\nsrc/y.c\n' })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Area A', root: ROOT, background: true, agent: 'owner' }, rows: { [REF]: row(REF, 'Area A', 'idle') } })
  await startSession($, w)
  const ctx: any = await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  expect(ctx.additionalContext.join('\n')).toContain('fleet watches this project\'s code upstream: main (git). When upstream changes a file you changed or have open, fleet tells you at your next step')
  for (let i = 0; i < 8; i++) await tick(w, 30000)
  const nudge = w.submits.find(s => s.includes('main moved'))
  expect(nudge).toContain(`fleet: main moved under files you changed (nothing is held; rebase now (git -C .claude/worktrees/area-a-1 rebase main), then run the tests before you land):\n- src/x.c: changed by TEST Integrator in 436d16c at `)
  expect(nudge).toContain('- src/y.c: changed by TEST Integrator in 436d16c at ')
  expect(nudge).not.toContain('main: x y')
  const r: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect((r.context ?? []).join('\n')).not.toContain('main moved')
  expect(w.submits.filter(s => s.includes('main moved')).length).toBe(1)
})

test('Perforce through ssh: the first poll takes the marker; a change submitted to a file an instance has open is an overlap until it syncs', WITH_SESSIONS, async ($, on) => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  const w = world(on, {
    background: false,
    files: project(
      { depot: { kind: 'p4', host: 'dev.example.invalid', depot: '//depot/project/...' } },
      {
        [`${FLEET}/outbound.json`]: JSON.stringify({ outboundFormat: 1, hosts: ['dev.example.invalid'], remotes: [], recipients: [], commands: [], outside: [] }),
        [`${FLEET}/instances/area-a/state.json`]: beat('Area A', 'area-a', 'aaaaaaa1', now),
        [`${FLEET}/instances/area-b/state.json`]: beat('Area B', 'area-b', 'bbbbbbb1', now),
      },
    ),
  })
  const remote: string[] = []
  let opened = '... depotFile //depot/project/src/x.c\n... rev 6\n... action edit\n\n'
  w.exec.value = argv => {
    if (argv[0] !== 'ssh') return undefined
    expect(argv.slice(0, 7)).toEqual(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'dev.example.invalid', '--'])
    const cmd = argv[7] as string
    remote.push(cmd)
    if (cmd === 'p4 -ztag changes -s submitted -m 1 //depot/project/...') return { exitCode: 0, stdout: '... change 1234\n... time 1793617200\n... user areab\n... client project-area-b\n\n' }
    if (cmd === "p4 -ztag changes -s submitted -m 300 '//depot/project/...@1235,#head'") return { exitCode: 0, stdout: '... change 1235\n... time 1793620800\n... user jdoe\n... client jdoe-ws\n... desc a fix\nover two lines\n\n' }
    if (cmd === "p4 -ztag changes -s submitted -m 300 '//depot/project/...@1236,#head'") return { exitCode: 0, stdout: '' }
    if (cmd === 'p4 -ztag describe -s 1235') return { exitCode: 0, stdout: '... change 1235\n... user jdoe\n... client jdoe-ws\n... depotFile0 //depot/project/src/x.c\n... action0 edit\n... rev0 7\n\n' }
    if (cmd === 'p4 -c project-area-a -ztag opened //depot/project/...') return { exitCode: 0, stdout: opened }
    if (cmd === 'p4 -c project-area-b -ztag opened //depot/project/...') return { exitCode: 1, stderr: '//depot/project/... - file(s) not opened on this client.' }
    return { exitCode: 1, stderr: `unexpected: ${cmd}` }
  }
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Area A', 'idle'), bbbbbbb1: row('bbbbbbb1', 'Area B', 'idle') } })
  await startSession($, w)
  await run(w, 4)
  // The first poll: the marker only (what came before isn't news), and nobody's open files asked for
  expect(remote).toEqual(['p4 -ztag changes -s submitted -m 1 //depot/project/...'])
  expect(json(w, `${STATE}/code.json`).repos.depot).toMatchObject({ kind: 'p4', marker: '1234', ok: true, seats: { 'area-a': 'project-area-a', 'area-b': 'project-area-b' } })
  await run(w, 10)
  expect(remote.slice(1, 5)).toEqual(["p4 -ztag changes -s submitted -m 300 '//depot/project/...@1235,#head'", 'p4 -ztag describe -s 1235', 'p4 -c project-area-a -ztag opened //depot/project/...', 'p4 -c project-area-b -ztag opened //depot/project/...'])
  const st = json(w, `${STATE}/code.json`)
  expect(st.repos.depot).toMatchObject({ marker: '1235', ok: true })
  expect(st.repos.depot.changes).toEqual([{ rev: '1235', who: 'jdoe', client: 'jdoe-ws', at: 1793620800000, files: [{ path: '//depot/project/src/x.c', rev: 7 }] }])
  expect(st.overlaps).toEqual([{ slug: 'area-a', name: 'Area A', repo: 'depot', kind: 'p4', upstream: '//depot/project/...', path: 'src/x.c', rev: '1235', who: 'jdoe', client: 'jdoe-ws', at: 1793620800000, where: 'project-area-a', since: expect.any(Number) }])
  const marks = calls(w, 'setMarks')
  expect(marks[marks.length - 1].rows.aaaaaaa1).toEqual({ badge: '↻1', tint: 'warning', line: '//depot/project/... moved under 1 of its file: sync' })
  // It synced and resolved (the file is open at #7 now): at the next poll the overlap goes
  opened = '... depotFile //depot/project/src/x.c\n... rev 7\n... action edit\n\n'
  await run(w, 12)
  expect(json(w, `${STATE}/code.json`).overlaps).toEqual([])
  expect(json(w, `${STATE}/code.json`).repos.depot).toMatchObject({ marker: '1235', ok: true })
})

test("a host outbound.json doesn't list as the person's is never reached: the poll says why, and so does the dry run", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, files: project({ depot: { kind: 'p4', host: 'dev.example.invalid', depot: '//depot/project/...' } }) })
  w.exec.value = argv => (argv[0] === 'ssh' ? { exitCode: 0, stdout: '' } : undefined)
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  await run(w, 4)
  expect(w.runs.some(r => r[0] === 'ssh')).toBe(false)
  expect(json(w, `${STATE}/code.json`).repos.depot).toMatchObject({ ok: false, problem: `it's on dev.example.invalid, which outbound.json doesn't list as yours ("hosts"): fleet reaches a host over ssh only there` })
  expect(await fleet($, 'status')).toContain("  its last poll failed: it's on dev.example.invalid, which outbound.json doesn't list as yours")
  expect(await fleet($, 'up --dry-run')).toContain(`  ! world.json's code depot is on dev.example.invalid: fleet reaches a host over ssh only when outbound.json lists it as yours ("hosts"), so it isn't watched until then`)
})

test("with no stamps the code watch says so, not that outbound.json doesn't list its host", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, stamps: false, files: project({ depot: { kind: 'p4', host: 'dev.example.invalid', depot: '//depot/project/...' } }, { [`${FLEET}/outbound.json`]: JSON.stringify({ outboundFormat: 1, hosts: ['dev.example.invalid'] }) }) })
  w.exec.value = argv => (argv[0] === 'ssh' ? { exitCode: 0, stdout: '' } : undefined)
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  await run(w, 4)
  expect(w.runs.some(r => r[0] === 'ssh')).toBe(false)
  expect(json(w, `${STATE}/code.json`).repos.depot.problem).toBe('no stamps: read outbound.json and type /fleet accept outbound.json (fleet reaches dev.example.invalid over ssh only once it is stamped)')
})

test("a command repository: the project's two commands run from its folder only once the person stamps them", WITH_SESSIONS, async ($, on) => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  const w = world(on, {
    background: false,
    files: project(
      { tools: { kind: 'command', changed: ['bash', 'tools/up.sh', '{marker}'], open: ['bash', 'tools/open.sh', '{instance}', '{slug}'] } },
      { [`${ROOT}/tools/up.sh`]: 'echo up\n', [`${ROOT}/tools/open.sh`]: 'echo open\n', [`${FLEET}/instances/area-a/state.json`]: beat('Area A', 'area-a', 'aaaaaaa1', now) },
    ),
  })
  const ran: { argv: string[]; cwd: string }[] = []
  let up = 'src/x.c\tTEST B\t41\n'
  w.exec.value = (argv, cwd) => {
    if (argv[0] !== 'bash') return undefined
    ran.push({ argv, cwd })
    if (argv[1] === 'tools/up.sh') return { exitCode: 0, stdout: up }
    return { exitCode: 0, stdout: 'src/x.c\nnotes/n.md\t40\n' }
  }
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Area A', 'idle') } })
  await startSession($, w)
  await run(w, 4)
  expect(ran).toEqual([])
  expect(json(w, `${STATE}/code.json`).repos.tools.problem).toBe('its commands run as you: fleet runs them only once you stamp them (/fleet accept checks)')
  expect(await fleet($, 'up --dry-run')).toContain("! world.json's code tools runs the project's own commands as you, so fleet runs them only once you stamp them: /fleet accept checks")
  const stamped = await fleet($, 'accept checks')
  expect(stamped).toContain('Stamped: the code watch tools (bash tools/up.sh {marker}; bash tools/open.sh {instance} {slug}, every 5 min).')
  // Its scripts are command-level now: the instances' settings deny them
  expect(await fleet($, 'up --dry-run')).not.toContain('runs the project\'s own commands as you')
  await run(w, 12)
  // The first run only takes the marker; the next one, from it, finds src/x.c moved under Area A
  expect(ran.slice(0, 1)).toEqual([{ argv: ['bash', 'tools/up.sh', ''], cwd: ROOT }])
  up = 'src/x.c\tTEST B\t42\n'
  await run(w, 12)
  expect(ran.some(r => r.argv.join(' ') === 'bash tools/up.sh 41' && r.cwd === ROOT)).toBe(true)
  expect(ran.some(r => r.argv.join(' ') === 'bash tools/open.sh Area A area-a' && r.cwd === ROOT)).toBe(true)
  expect(json(w, `${STATE}/code.json`).overlaps.map((o: any) => `${o.name} ${o.path} ${o.rev} ${o.who}`)).toEqual(['Area A src/x.c 42 TEST B'])
})

test('a finding with no proof: told at its landing, marked unproven (the band counts it), in /fleet status and the brief; its proof clears it', WITH_SESSIONS, async ($, on) => {
  const F1 = `${ROOT}/findings/F-1.md`
  const F2 = `${ROOT}/findings/F-2.md`
  const w = world(on, {
    files: {
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['findings/**', 'notes/**'], proofs: { paths: ['findings/**'], kinds: ['finding', 'result'] } }),
      [`${ROOT}/notes/n.md`]: 'n\n',
      [`${FLEET}/verify.md`]: '# How we prove it works\n',
    },
  })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST W', root: ROOT, background: true, agent: null } })
  await startSession($, w)
  for (let i = 0; i < 3; i++) await tick(w)
  const landed: any = await $.tool.call({ tool: 'Write', file_path: F1, content: '---\nkind: finding\n---\nF-1: the FIFO holds 64 entries\n' } as any)
  expect(landed.context.join('\n')).toContain('fleet: findings/F-1.md is unproven: a finding with no proof: run: and sha: (the command, and the sha256 of its output), or source: and quote: (where, and the exact text). Nothing is held: fleet marks it until it carries one (a finding carries kind: finding, source: and quote:')
  // A result written by a command: its owner hears it at its next step
  w.bash.value = () => w.touch(F2, '---\nkind: result\nrun: make sim\n---\nF-2: it passes\n')
  await $.tool.call({ tool: 'Bash', command: 'make sim > findings/F-2.md' } as any)
  for (let i = 0; i < 3; i++) await tick(w)
  const st = json(w, `${STATE}/suspects.json`)
  expect(st.unproven.map((u: any) => `${u.path} ${u.id} ${u.owner?.sessionId === SID}`)).toEqual(['findings/F-1.md F-1 true', 'findings/F-2.md F-2 true'])
  const step: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  const told = step.context.join('\n')
  expect(told).toContain('fleet: shared files you wrote last are unproven (nothing is held; a finding carries kind: finding')
  expect(told).toContain('- findings/F-2.md (F-2): a result, with run: but no sha: after it (the sha256 of its output)')
  expect(told).not.toContain('findings/F-1.md')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).toContain('!! 2 flagged')
  await ui.unmount()
  const status = await fleet($, 'status')
  expect(status).toContain("proofs: carried by the records in `findings/**`, and any record whose kind: is finding or result; unproven (marks, nothing is held):")
  expect(status).toContain('  findings/F-1.md (F-1): a finding with no proof')
  expect(await fleet($, 'brief')).toContain('   - unproven: findings/F-2.md (F-2): a result, with run: but no sha: after it')
  // Its proof: a source and the exact text
  await $.tool.call({ tool: 'Read', file_path: F1 } as any)
  const proved: any = await $.tool.call({ tool: 'Write', file_path: F1, content: '---\nkind: finding\nsource: notes/n.md\nquote: "the FIFO holds 64 entries"\n---\nF-1: the FIFO holds 64 entries\n' } as any)
  expect((proved.context ?? []).join('\n')).not.toContain('unproven')
  for (let i = 0; i < 3; i++) await tick(w)
  expect(json(w, `${STATE}/suspects.json`).unproven.map((u: any) => u.path)).toEqual(['findings/F-2.md'])
  // The instance context says it, and verify.md is command-level
  expect(await fleet($, 'accept verify.md')).toBe('.claude/fleet/verify.md: its current version is stamped as yours (fleet no longer flags it as changed outside fleet).')
})

test("/fleet up --wave 2 shows wave 1's record first: its landings and how they stand, rejections and overrules; nothing valid warns, never refuses", WITH_SESSIONS, async ($, on) => {
  const at = Date.UTC(2026, 10, 2, 11, 0, 0)
  const roster = {
    rosterFormat: 1,
    roles: { owner: { agent: 'owner', budget: { usdDay: 4 } } },
    instances: [
      { name: 'Area A', role: 'owner', wave: 1 },
      { name: 'Area B', role: 'owner', wave: 1 },
      { name: 'Area C', role: 'owner', wave: 2 },
    ],
  }
  const by = { sessionId: 'aaaaaaa1-0000-0000-0000-000000000000', agentId: null, ref: 'aaaaaaa1', name: 'Area A' }
  const ev = (path: string, n: number) => JSON.stringify({ format: 1, at: at + n, path, from: null, to: hashText(path), via: 'tool', tool: 'Write', blind: false, by })
  const rejected = { registerFormat: 1, id: 'D-4', source: 'decide', fleet: '0.8.0', at, asker: { ref: 'aaaaaaa1', sessionId: by.sessionId, name: 'Area A', root: ROOT }, questions: [], kind: 'change', change: { path: '.claude/fleet/charter.md', summary: 's' }, answers: [{ label: 'rejected', origin: 'composer', session: 'TEST', at }], state: 'delivered', closedAt: at }
  const w = world(on, {
    background: false,
    worldPaths: ['notes/**'],
    files: {
      [`${FLEET}/roster.json`]: JSON.stringify(roster),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${ROOT}/notes/plan.md`]: 'notes/plan.md',
      [`${ROOT}/journals/area-a.md`]: 'j',
      [`${FLEET}/instances/area-a/state.json`]: beat('Area A', 'area-a', 'aaaaaaa1', at),
      [`${FLEET}/instances/area-a/spend.json`]: JSON.stringify({ format: 1, slug: 'area-a', day: '2026-11-02', usd: 1.5, sessionId: 's', last: 1.5, at }),
      [`${FLEET}/events/${hourFolder(at)}/${at + 1}-aaaaaaa1-1.json`]: ev('notes/plan.md', 1),
      [`${FLEET}/events/${hourFolder(at)}/${at + 2}-aaaaaaa1-2.json`]: ev('notes/plan.md', 2),
      [`${FLEET}/events/${hourFolder(at)}/${at + 3}-aaaaaaa1-3.json`]: ev('journals/area-a.md', 3),
      [`${DEC}/register/2026-11/D-4.json`]: JSON.stringify(rejected),
    },
  })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  const plan = await fleet($, 'up --dry-run --wave 2')
  expect(plan).toContain("Wave 1's record, what wave 2 builds on (landings of the last 7 days outside each one's journal; checks, proofs and suspects as they stand now; the register's rejections and overrules):")
  expect(plan).toContain('  Area A: 2 landings on 1 file, 1 valid; you rejected D-4; $1.50 of $4.00 today')
  expect(plan).toContain('  Area B: nothing landed; $0.00 of $4.00 today')
  expect(plan).toContain("  ! Area B has nothing valid landed (a file outside its journal it landed in the last 7 days that no check fails, carries its proof where one is due and isn't suspect): wave 2 builds on its work, so look first (/fleet up --wave 2 starts the wave anyway)")
  expect(plan).toContain('Nothing was started (--dry-run).')
  expect(await fleet($, 'up --dry-run --wave 1')).not.toContain("Wave 1's record")
  // Started for real, the record is shown the same and the wave starts anyway
  const up = await fleet($, 'up --wave 2')
  expect(up).toContain("Wave 1's record")
  expect(calls(w, 'start').map((s: any) => s.name)).toEqual(['Area A', 'Area B', 'Area C'])
})
