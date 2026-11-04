import { expect, test } from 'claude-code/testing'

import { BAND, FAKE_LOG, FLEET, HOME, ROOT, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// The roster from the person's side: /fleet init <template>, /fleet up (--dry-run), down, remove, budget, worktrees,
// and the sweeper's marks and wakes. The instances' own side is in instance.test.tsx

const STATE = `${FLEET}/state`
export const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, mcp__fleet__*\n---\nYou own a part of the notes.\n'
export const ROSTER = {
  rosterFormat: 1,
  sections: [{ id: 'owners', title: 'Owners' }],
  roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 } } },
  instances: [
    { name: 'Owner A', role: 'owner', section: 'owners', brief: 'You own notes/a.' },
    { name: 'Owner B', role: 'owner', section: 'owners', parent: 'Owner A' },
    { name: 'Owner C', role: 'owner', section: 'owners', wave: 2 },
  ],
  budget: { usdDay: 5 },
  settings: { env: { SESSIONS_DATA_DIR: '/tmp/x/data' } },
}
export const PROJECT = {
  [`${FLEET}/roster.json`]: JSON.stringify(ROSTER),
  [`${ROOT}/.claude/agents/owner.md`]: OWNER,
  [`${FLEET}/seeds/owner.md`]: 'Read the charter, then plan your part ({name}).',
}
const SOLO = {
  'template.json': JSON.stringify({ templateFormat: 1, description: 'three owners', folders: ['notes'], next: ['Next: /fleet up --dry-run.'] }),
  'fleet/world.json': JSON.stringify({ worldFormat: 1, paths: ['notes/**'] }),
  'fleet/roster.json': JSON.stringify(ROSTER),
  'fleet/charter.md': '# Charter\n',
  'fleet/seeds/owner.md': 'Seed.',
  'agents/owner.md': OWNER,
}

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

function calls(w: World, kind: string): any[] {
  return (w.files.get(FAKE_LOG) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(c => c[kind])
    .map(c => c[kind])
}

test('/fleet init <template> copies its files, never over yours, and stamps the command-level ones', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { fleet: false, background: false, templates: { solo: SOLO } })
  await startSession($, w)
  const said = await fleet($, 'init solo')
  expect(said).toContain(`Set up in ${FLEET}/ (template solo: three owners).`)
  expect(said).toContain('Written: .claude/fleet/charter.md, .claude/fleet/roster.json, .claude/fleet/seeds/owner.md, .claude/fleet/world.json, .claude/agents/owner.md, .claude/fleet/outbound.json, .claude/fleet/principles.md, .claude/fleet/slots.json.')
  expect(w.files.get(`${FLEET}/principles.md`)).toContain("# Principles\n\nThe person's standing answers")
  expect(json(w, `${FLEET}/slots.json`)).toEqual({ slotsFormat: 1, slots: {} })
  expect(json(w, `${FLEET}/outbound.json`)).toEqual({ outboundFormat: 1, hosts: [], remotes: [], recipients: [], tools: { outbound: [], free: [] }, commands: [], outside: [] })
  expect(said).toContain('Shared files (world.json): `notes/**`.')
  expect(said).toContain('Next: /fleet up --dry-run.')
  expect(json(w, `${FLEET}/config.json`)).toEqual({ configFormat: 1, template: 'solo', commitRegister: false })
  expect(w.files.get(`${ROOT}/.claude/agents/owner.md`)).toBe(OWNER)
  expect(w.dirs.has(`${ROOT}/notes`)).toBe(true)
  expect(w.files.get(`${FLEET}/.gitignore`)).toContain('\ninstances/\n')
  expect(Object.keys(json(w, `${STATE}/stamps.json`).files)).toEqual(['.claude/fleet/charter.md', '.claude/fleet/principles.md', '.claude/fleet/verify.md', '.claude/fleet/roster.json', '.claude/fleet/world.json', '.claude/fleet/outbound.json', '.claude/fleet/slots.json', '.claude/agents/owner.md'])
  // Again, with a file of the person's changed: kept as it is
  w.files.set(`${ROOT}/.claude/agents/owner.md`, `${OWNER}Mine.\n`)
  const again = await fleet($, 'init')
  expect(again).toContain('Up to date')
  expect(again).toContain('Kept as they were (yours): .claude/fleet/charter.md, .claude/fleet/roster.json')
  expect(w.files.get(`${ROOT}/.claude/agents/owner.md`)).toBe(`${OWNER}Mine.\n`)
  expect(await fleet($, 'init nothing')).toBe('No template "nothing": there are blank, solo')
  expect(await fleet($, 'init solo', { kind: 'plugin', name: 'other' })).toContain('Only the person sets a project up')
})

test('/fleet init in a git repository: the roster it writes keeps the instances in the main checkout; one that says so already is left alone', WITH_SESSIONS, async ($, on) => {
  const SAYS = { ...SOLO, 'fleet/roster.json': JSON.stringify({ ...ROSTER, settings: { worktree: { bgIsolation: 'worktree' } } }) }
  const w = world(on, { fleet: false, background: false, templates: { solo: SOLO, says: SAYS } })
  w.exec.value = argv => (argv[0] === 'git' && argv.includes('rev-parse') ? { exitCode: 0, stdout: `${ROOT}\n${ROOT}/.git\n${ROOT}/.git\n` } : undefined)
  await startSession($, w)
  const said = await fleet($, 'init solo')
  expect(said).toContain('This project is in a git repository: roster.json keeps the instances in the main checkout ("worktree": { "bgIsolation": "none" })')
  expect(json(w, `${FLEET}/roster.json`).settings).toEqual({ env: { SESSIONS_DATA_DIR: '/tmp/x/data' }, worktree: { bgIsolation: 'none' } })
  // Stamped as written: the dry run doesn't flag it as changed outside fleet
  expect(json(w, `${FLEET}/state/stamps.json`).files['.claude/fleet/roster.json']).toBeTruthy()
  expect(await fleet($, 'up --dry-run')).not.toContain('changed outside fleet')
  // A roster already saying where its instances work is the person's word
  w.files.delete(`${FLEET}/roster.json`)
  const other = await fleet($, 'init says')
  expect(other).not.toContain('keeps the instances in the main checkout')
  expect(json(w, `${FLEET}/roster.json`).settings).toEqual({ worktree: { bgIsolation: 'worktree' } })
})

test('/fleet up --dry-run: the plan, the cost and the lints, and nothing started; /fleet up writes the settings and starts', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: PROJECT })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  const dry = await fleet($, 'up --dry-run')
  expect(dry).toContain("The plan for 3 of the roster's 3 instance(s):")
  expect(dry).toContain('  Owner A · owner (.claude/agents/owner.md) · Owners · wave 1 · haiku · $1.00/day, wakes ~$0.04/day · mode default · to start')
  // Nobody is at an instance: a mode that asks is marked (never refused)
  expect(dry).toContain("  ! Owner A, Owner B, Owner C: run in default mode (Claude's default): the first write or command waits for you, with nobody to answer.")
  expect(dry).toContain('  Owner B · owner (.claude/agents/owner.md) · Owners, under Owner A · wave 1')
  expect(dry).toContain("Cost, estimated at list price: the budgets add up to $3.00 a day (the project's cap: $5.00); wakes about $0.12 a day")
  expect(dry).toContain('Nothing was started (--dry-run).')
  expect(w.files.has(`${FLEET}/instances/owner-a.json`)).toBe(false)
  expect(calls(w, 'start')).toEqual([])
  expect(await fleet($, 'up', { kind: 'plugin', name: 'other' })).toContain('Only the person starts instances')
  // Wave 1 only: two of the three
  const up = await fleet($, 'up --wave 1')
  expect(up).toContain("/fleet up for 2 of the roster's 3 instance(s) (waves 1 to 1):")
  expect(up).toContain('  Owner A: starting')
  const s = json(w, `${FLEET}/instances/owner-a.json`)
  expect(s.env).toEqual({ SESSIONS_DATA_DIR: '/tmp/x/data', FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' })
  expect(s.model).toBe('haiku')
  expect(s.permissions.deny).toEqual([
    `Edit(/${ROOT}/.claude/fleet/charter.md)`,
    `Edit(/${ROOT}/.claude/fleet/principles.md)`,
    `Edit(/${ROOT}/.claude/fleet/verify.md)`,
    `Edit(/${ROOT}/.claude/fleet/roster.json)`,
    `Edit(/${ROOT}/.claude/fleet/world.json)`,
    `Edit(/${ROOT}/.claude/fleet/outbound.json)`,
    `Edit(/${ROOT}/.claude/fleet/slots.json)`,
    `Edit(/${ROOT}/.claude/agents/**)`,
    `Edit(/${ROOT}/.claude/fleet/instances/**)`,
  ])
  expect(calls(w, 'start')).toEqual([
    { name: 'Owner A', cwd: ROOT, agent: 'owner', settings: `${FLEET}/instances/owner-a.json` },
    { name: 'Owner B', cwd: ROOT, agent: 'owner', settings: `${FLEET}/instances/owner-b.json` },
  ])
  expect(w.files.has(`${FLEET}/instances/owner-c.json`)).toBe(false)
  // A running one is placed, not started again; a stopped one is woken
  sessionsSay(w, { rows: { aaaaaaa1: { ...row('aaaaaaa1', 'Owner A', 'idle') }, aaaaaaa2: { ...row('aaaaaaa2', 'Owner B', 'stopped') }, ccccccc1: { ...row('ccccccc1', 'Owner C', 'idle'), root: `${HOME}/elsewhere` } } })
  const again = await fleet($, 'up')
  expect(again).toContain('Owner A · owner (.claude/agents/owner.md) · Owners · wave 1 · haiku · $1.00/day, wakes ~$0.04/day · mode default · running (idle): placed, not started again')
  expect(again).toContain('  Owner B: waking')
  expect(again).toContain('  Owner C: starting')
  expect(calls(w, 'wake')).toEqual([{ ref: 'aaaaaaa2', reason: 'fleet up' }])
  expect(calls(w, 'start').map(c => c.name)).toEqual(['Owner A', 'Owner B', 'Owner C'])
  // A running one that started with other settings, and its own context in the forecast (8 wakes of 400k at haiku's
  // cache-write price), in the plan and in /fleet status
  w.files.set(`${FLEET}/instances/owner-a/state.json`, JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'aaaaaaa1', sessionId: 'aaaaaaa1-0000-0000-0000-000000000000', at: w.clock.now(), cwd: ROOT, bound: true, settingsHash: 'h0000000', agentType: 'owner', cost: 0, contextTokens: 400000 }))
  const plan = await fleet($, 'up --dry-run')
  expect(plan).toContain('$1.00/day, wakes ~$0.40/day (its context: 400k) · mode default · running (idle): placed, not started again; its settings would be rewritten: u restarts it with them')
  expect(await fleet($, 'status')).toContain('context 400k')
})

test('/fleet up stops at a lint: a role file that hides fleet’s tools, a missing one, an unknown parent', WITH_SESSIONS, async ($, on) => {
  const bad = { ...ROSTER, instances: [...ROSTER.instances, { name: 'Owner D', role: 'owner', parent: 'Nobody' }] }
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT, [`${FLEET}/roster.json`]: JSON.stringify(bad), [`${ROOT}/.claude/agents/owner.md`]: OWNER.replace(', mcp__fleet__*', '') } })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  const up = await fleet($, 'up')
  expect(up).toContain("  ✗ .claude/agents/owner.md: its tools don't list mcp__fleet__*")
  expect(up).toContain(`  ✗ "Owner D": its parent "Nobody" isn't an instance`)
  expect(up).toContain('Nothing was started: fix the errors, then /fleet up again.')
  expect(calls(w, 'start')).toEqual([])
  // A roster from a newer fleet, or none
  w.files.set(`${FLEET}/roster.json`, JSON.stringify({ ...ROSTER, rosterFormat: 2 }))
  await tick(w, 10)
  expect(await fleet($, 'up --dry-run')).toContain('roster.json is from a newer fleet (rosterFormat 2)')
  w.files.delete(`${FLEET}/roster.json`)
  expect(await fleet($, 'up --dry-run')).toContain('No roster.json in .claude/fleet/: /fleet init <template> writes one')
})

test('/fleet down: no wakes, /fleet up skips them until named; /fleet remove forgets one that is stopped', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT, [`${FLEET}/instances/owner-b.json`]: '{}', [`${FLEET}/instances/owner-b/state.json`]: JSON.stringify({ format: 1, sessionId: 'bbbbbbbb-0000-0000-0000-000000000000' }) } })
  sessionsSay(w, { rows: { bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  await startSession($, w)
  const down = await fleet($, 'down "Owner B"')
  expect(down).toContain('Down: Owner B.')
  expect(down).toContain('Still running: Owner B: s in the panel stops one (fleet never stops a session).')
  expect(Object.keys(json(w, `${STATE}/down.json`).instances)).toEqual(['owner-b'])
  expect(await fleet($, 'up --dry-run')).toContain('down: skipped (/fleet up <name> brings it back)')
  expect(await fleet($, 'remove owner-b')).toContain('Owner B is still running: /fleet down "Owner B", stop it with s in the panel, then /fleet remove again.')
  // sessions doesn't answer and its fleet beat a minute ago: it may run, so nothing goes, even with --yes
  const beat = w.files.get(`${FLEET}/instances/owner-b/state.json`) as string
  w.files.set(`${FLEET}/instances/owner-b/state.json`, JSON.stringify({ ...JSON.parse(beat), at: w.clock.now() - 60000 }))
  sessionsSay(w, {})
  expect(await fleet($, 'remove owner-b --yes')).toContain("Owner B may be running (sessions didn't answer, and its fleet beat 1m ago): nothing deleted.")
  expect(w.files.has(`${FLEET}/instances/owner-b.json`)).toBe(true)
  w.files.set(`${FLEET}/instances/owner-b/state.json`, beat)
  sessionsSay(w, { rows: { bbbbbbbb: row('bbbbbbbb', 'Owner B', 'stopped') } })
  const list = await fleet($, 'remove owner-b')
  expect(list).toContain(`Owner B: would delete ${FLEET}/instances/owner-b.json, ${FLEET}/instances/owner-b/`)
  expect(w.files.has(`${FLEET}/instances/owner-b.json`)).toBe(true)
  expect(await fleet($, 'remove owner-b --yes')).toContain('Removed the files of Owner B. It stays in roster.json, down')
  expect(w.files.has(`${FLEET}/instances/owner-b.json`)).toBe(false)
  expect(w.files.has(`${FLEET}/instances/owner-b/state.json`)).toBe(false)
  // Named, it comes back
  await fleet($, 'up "Owner B"')
  expect(json(w, `${STATE}/down.json`).instances).toEqual({})
})

test('/fleet budget: the day’s spend and caps; the person sets or raises one for today', WITH_SESSIONS, async ($, on) => {
  const day = '2026-11-02'
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT, [`${FLEET}/instances/owner-a/spend.json`]: JSON.stringify({ format: 1, slug: 'owner-a', day, usd: 1.2, sessionId: 's', last: 1.2, at: 0 }) } })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  const list = await fleet($, 'budget')
  expect(list).toContain('project: $1.20 of $5.00 today')
  expect(list).toContain('  Owner A: $1.20 of $1.00 today, used up')
  expect(list).toContain('  Owner B: $0.00 of $1.00 today')
  expect(await fleet($, 'budget "Owner A" +2', { kind: 'plugin', name: 'other' })).toContain('Only the person sets a budget')
  expect(await fleet($, 'budget Owner A +2')).toContain('Owner A: $3.00 for today ($1.20 spent so far)')
  expect(json(w, `${STATE}/lifts.json`)).toMatchObject({ format: 1, day, instances: { 'owner-a': 3 } })
  expect(await fleet($, 'budget owner-a')).toBe('Owner A: $1.20 of $3.00 today')
  expect(await fleet($, 'budget project 8')).toContain('the project: $8.00 for today')
})

test('the band counts an instance over its budget only while it runs: stopped, it spends nothing more', WITH_SESSIONS, async ($, on) => {
  const day = '2026-11-02'
  const beat = (at: number) => JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'aaaaaaa1', sessionId: 'aaaaaaa1-0000-0000-0000-000000000000', at, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 1.2 })
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT, [`${FLEET}/instances/owner-a/spend.json`]: JSON.stringify({ format: 1, slug: 'owner-a', day, usd: 1.2, sessionId: 's', last: 1.2, at: 0 }) } })
  w.files.set(`${FLEET}/instances/owner-a/state.json`, beat(w.clock.now()))
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  w.band.value = ''
  await tick(w, 10100)
  const band = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawn = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return drawn
  }
  expect(await band()).toContain('$ 1 over budget')
  // Stopped, as sessions says (status says so too), though its fleet beat a moment ago
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'stopped') } })
  await tick(w, 10100)
  expect(await band()).not.toContain('over budget')
  // With sessions not answering, its fleet's heartbeat says: fresh, it runs; 3 minutes old, stopped
  sessionsSay(w, {})
  await tick(w, 10100)
  expect(await band()).toContain('$ 1 over budget')
  w.files.set(`${FLEET}/instances/owner-a/state.json`, beat(w.clock.now() - 4 * 60000))
  await tick(w, 10100)
  expect(await band()).not.toContain('over budget')
  // /fleet budget still says what it spent
  expect(await fleet($, 'budget')).toContain('  Owner A: $1.20 of $1.00 today, used up')
})

test('the sweeper marks an instance that runs with no fleet, and one over its budget; it wakes a retired one with answers', WITH_SESSIONS, async ($, on) => {
  const at = Date.UTC(2026, 10, 2, 11, 0, 0)
  const w = world(on, {
    background: false,
    worldPaths: ['notes/**'],
    files: {
      ...PROJECT,
      [`${FLEET}/instances/owner-b/spend.json`]: JSON.stringify({ format: 1, slug: 'owner-b', day: '2026-11-02', usd: 2, sessionId: 's', last: 2, at: 0 }),
      [`${FLEET}/instances/owner-c/state.json`]: JSON.stringify({ format: 1, instance: 'Owner C', slug: 'owner-c', ref: 'ccccccc1', sessionId: 'cccccccc-0000-0000-0000-000000000000', at, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0 }),
      [`${FLEET}/decisions/queue/D-3.json`]: JSON.stringify({ format: 1, fleet: '0.3.0', id: 'D-3', at, asker: { ref: 'ccccccc1', sessionId: 'cccccccc-0000-0000-0000-000000000000', name: 'Owner C', root: ROOT }, questions: [{ question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'w' }] }),
      [`${FLEET}/decisions/answers/D-3.1.json`]: JSON.stringify({ format: 1, id: 'D-3', q: 1, label: 'Yes', origin: 'composer', session: 'TEST', at }),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle'), bbbbbbb1: row('bbbbbbb1', 'Owner B', 'working'), ccccccc1: row('ccccccc1', 'Owner C', 'stopped') } })
  await startSession($, w)
  // The sweeper: this session takes the lease, then sweeps every minute
  for (let i = 0; i < 8; i++) await tick(w, 30000)
  const marks = calls(w, 'setMarks')
  const last = marks[marks.length - 1]
  expect(last.source).toBe('fleet')
  expect(last.ttlMs).toBe(150000)
  expect(last.rows.aaaaaaa1).toEqual({ badge: '✗', tint: 'error', line: 'no fleet in this session: u in the panel restarts it', needsPerson: true })
  // Owner B, over its budget, is marked so until its missing fleet outranks it
  expect(marks[0].rows.bbbbbbb1).toMatchObject({ badge: '$', tint: 'error', line: 'over budget: /fleet budget "Owner B" +n', needsPerson: true })
  expect(last.rows.bbbbbbb1.badge).toBe('✗')
  expect(calls(w, 'wake')).toEqual([{ ref: 'ccccccc1', reason: 'fleet: the person answered it' }])
  expect(json(w, `${STATE}/wakes.json`).instances['owner-c']).toMatchObject({ count: 1 })
  // The band counts the instances over budget
  const status = await fleet($, 'status')
  expect(status).toContain('roster: 3 instance(s) in 2 wave(s)')
  expect(status).toContain('  Owner A · owner · Owners · wave 1 · idle · no fleet (u restarts it) · $0.00 of $1.00 today')
  expect(status).toContain('  Owner B · owner · Owners under Owner A · wave 1 · working · no fleet (u restarts it) · $2.00 of $1.00 today (used up)')
  expect(status).toContain('  Owner C · owner · Owners · wave 2 · stopped · job ccccccc1, session cccccccc · $0.00 of $1.00 today · wakes 1/8 today')
})

test("the marks keep within sessions' limits: a long name over budget keeps its $ row; a session that asks gets ?n and needs the person", WITH_SESSIONS, async ($, on) => {
  const at = Date.UTC(2026, 10, 2, 12, 0, 0)
  const long = { ...ROSTER, instances: [...ROSTER.instances, { name: 'TEST Business Plan', role: 'owner', section: 'owners' }] }
  const beat = (slug: string, name: string, ref: string) => JSON.stringify({ format: 1, instance: name, slug, ref, sessionId: `${ref}-0000-0000-0000-000000000000`, at, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, fleet: '0.1.0' })
  const ask = (id: string, ref: string, name: string) => JSON.stringify({ format: 1, fleet: '0.1.0', id, at, asker: { ref, sessionId: `${ref}-0000-0000-0000-000000000000`, name, root: ROOT }, questions: [{ question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'w' }] })
  const w = world(on, {
    background: false,
    worldPaths: ['notes/**'],
    files: {
      ...PROJECT,
      [`${FLEET}/roster.json`]: JSON.stringify(long),
      [`${FLEET}/instances/test-business-plan/spend.json`]: JSON.stringify({ format: 1, slug: 'test-business-plan', day: '2026-11-02', usd: 2, sessionId: 's', last: 2, at: 0 }),
      [`${FLEET}/instances/test-business-plan/state.json`]: beat('test-business-plan', 'TEST Business Plan', 'eeeeeee1'),
      [`${FLEET}/instances/owner-a/state.json`]: beat('owner-a', 'Owner A', 'aaaaaaa1'),
      // Owner A asks; so does a background session that isn't an instance
      [`${FLEET}/decisions/queue/D-5.json`]: ask('D-5', 'aaaaaaa1', 'Owner A'),
      [`${FLEET}/decisions/queue/D-6.json`]: ask('D-6', 'ddddddd1', 'TEST Helper'),
      [`${FLEET}/decisions/queue/D-7.json`]: ask('D-7', 'ddddddd1', 'TEST Helper'),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle'), eeeeeee1: row('eeeeeee1', 'TEST Business Plan', 'working'), ddddddd1: row('ddddddd1', 'TEST Helper', 'idle') } })
  await startSession($, w)
  for (let i = 0; i < 3; i++) await tick(w, 30000)
  const marks = calls(w, 'setMarks')
  expect(marks.length).toBeGreaterThan(0)
  const last = marks[marks.length - 1]
  expect(last.rows.eeeeeee1).toEqual({ badge: '$', tint: 'error', line: 'over budget: /fleet budget "TEST Business Plan" +n', needsPerson: true })
  expect(last.rows.aaaaaaa1).toEqual({ badge: '?1', tint: 'warning', line: 'asks you 1: /fleet', needsPerson: true })
  expect(last.rows.ddddddd1).toEqual({ badge: '?2', tint: 'warning', line: 'asks you 2: /fleet', needsPerson: true })
  expect(w.logs.some(l => l.includes('fleet: marks refused'))).toBe(false)
})

test('/fleet worktrees lists the linked ones and removes only those no instance works in', WITH_SESSIONS, async ($, on) => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT, [`${FLEET}/instances/owner-a/state.json`]: JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'aaaaaaa1', sessionId: 's', at: now, cwd: `${ROOT}/.claude/worktrees/one`, bound: true }) } })
  w.exec.value = argv => {
    if (argv.includes('rev-parse')) return { exitCode: 0, stdout: `${ROOT}\n${ROOT}/.git\n${ROOT}/.git\n` }
    if (argv.includes('list')) return { exitCode: 0, stdout: `worktree ${ROOT}\n\nworktree ${ROOT}/.claude/worktrees/one\n\nworktree ${ROOT}/.claude/worktrees/two\n` }
    if (argv.includes('remove')) return { exitCode: 0 }
    return undefined
  }
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  const list = await fleet($, 'worktrees')
  expect(list).toContain('.claude/worktrees/one: Owner A works in it')
  expect(list).toContain('  .claude/worktrees/two\n')
  expect(await fleet($, 'worktrees prune')).toContain('Would remove')
  expect(await fleet($, 'worktrees prune --yes')).toBe('Worktrees:\n  .claude/worktrees/two: removed')
  expect(w.runs.some(r => r.join(' ') === `git -C ${ROOT} worktree remove ${ROOT}/.claude/worktrees/two`)).toBe(true)
  expect(w.runs.some(r => r.includes(`${ROOT}/.claude/worktrees/one`) && r.includes('remove'))).toBe(false)
})
