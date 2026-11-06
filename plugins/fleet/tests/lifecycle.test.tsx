import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { cadenceNudgeText, settingsText } from '../hooks/roster'
import { FLEET, ROOT, decide, fleet, json, row, sessionsSay, startSession, world, WITH_SESSIONS } from './world'

// An instance's lifecycle as the roster changes it (P26): an applied or accepted roster change takes effect by
// itself, the restart when idle for the settings a restart carries, the next request for a model or an effort

const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, mcp__fleet__*\n---\nYou own a part of the notes.\n'
const HB = `${FLEET}/instances/owner-a`
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const HOUR = 3600000

function roster(role: Record<string, unknown>) {
  return JSON.stringify({
    rosterFormat: 1,
    sections: [{ id: 'owners', title: 'Owners' }],
    roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 }, ...role } },
    instances: [
      { name: 'Owner A', role: 'owner', section: 'owners' },
      { name: 'Owner C', role: 'owner', section: 'owners' },
    ],
    budget: { usdDay: 5 },
  })
}

function beat(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'aaaaaaa1', sessionId: 'aaaaaaa1-0000-0000-0000-000000000000', at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: NOW - 3 * HOUR, lastLanding: NOW - 600000, ...extra })
}

// The hash an instance keeps of its settings file: without its model and effort (they reach it at its next request)
function coreHash(text: string): string {
  const { model: _m, effortLevel: _e, ...rest } = JSON.parse(text)
  return hashText(settingsText(rest))
}

test('an accepted roster.json takes effect by itself: settings a restart carries restart the instance once idle, a model alone reaches it at its next request', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${HB}/state.json`]: beat() },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  // Its settings file as the running instance started with it
  await fleet($, 'accept roster.json')
  const first = w.files.get(`${FLEET}/instances/owner-a.json`) as string
  expect(JSON.parse(first).model).toBe('haiku')
  w.touch(`${HB}/state.json`, beat({ settingsHash: coreHash(first) }))
  // A model change alone: the file is rewritten, nothing restarts
  w.touch(`${FLEET}/roster.json`, roster({ model: 'sonnet' }))
  const model = await fleet($, 'accept roster.json')
  expect(JSON.parse(w.files.get(`${FLEET}/instances/owner-a.json`) as string).model).toBe('sonnet')
  expect(w.files.has(`${HB}/restart.json`)).toBe(false)
  expect(model).toContain('Owner A: model sonnet at its next request (no restart)')
  // A change a restart carries (its env): it restarts once idle, with nothing for the person to do
  w.touch(`${FLEET}/roster.json`, roster({ model: 'sonnet', settings: { env: { NOTES_MODE: 'draft' } } }))
  const env = await fleet($, 'accept roster.json')
  expect(json(w, `${HB}/restart.json`)).toMatchObject({ format: 1 })
  expect(env).toContain('Owner A: restarts with its new settings once idle (nothing in flight)')
  expect(JSON.parse(w.files.get(`${FLEET}/instances/owner-a.json`) as string).env.NOTES_MODE).toBe('draft')
})

test('an applied change to roster.json takes effect by itself too, and the apply says what it did to each instance', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${HB}/state.json`]: beat() },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  await fleet($, 'accept roster.json')
  const first = w.files.get(`${FLEET}/instances/owner-a.json`) as string
  w.touch(`${HB}/state.json`, beat({ settingsHash: coreHash(first) }))
  expect((await decide($, { kind: 'change', path: '.claude/fleet/roster.json', summary: 'owners on sonnet at high', content: roster({ model: 'sonnet', effort: 'high' }) })).result).toContain('Queued as D-1')
  const applied = await fleet($, '1 apply')
  expect(applied).toContain('1: applied D-1: fleet wrote .claude/fleet/roster.json as drafted')
  expect(applied).toContain('It takes effect now:')
  expect(applied).toContain('Owner A: model sonnet, effort high at its next request (no restart)')
  expect(applied).not.toContain('takes effect at the next /fleet up')
  const s = JSON.parse(w.files.get(`${FLEET}/instances/owner-a.json`) as string)
  expect([s.model, s.effortLevel]).toEqual(['sonnet', 'high'])
  expect(w.files.has(`${HB}/restart.json`)).toBe(false)
})

// ---- G27: an idle fleet beside an unbuilt backlog ----

test('the cadence nudge of an instance with nothing to take says to propose an item to the front door, not to write that it waits', () => {
  const nudge = cadenceNudgeText({ cadenceH: 1, journal: 'journals/tester-1.md' }, 1, [], 3, [], { front: 'Chief', self: false })
  expect(nudge).toContain('Nothing on the board fits you: propose an item to Chief (SendMessage: what to do and what done looks like)')
  expect(nudge).toContain("a line in your journal saying you wait isn't work")
  expect(nudge).not.toContain("where you're blocked and why, in your journal")
  // The front door itself: it turns the deliverables into items
  const front = cadenceNudgeText({ cadenceH: 1, journal: 'journals/chief.md' }, 1, [], 3, [], { front: 'Chief', self: true })
  expect(front).toContain('turn what the charter and the plan still need into board items')
  // No front door: the person
  expect(cadenceNudgeText({ cadenceH: 1, journal: 'journals/a.md' }, 1, [], 3, [], { front: null, self: false })).toContain('ask the person with mcp__fleet__decide what to take on')
})

test('the front door hears, once an hour, the instances idle with no item to take', WITH_SESSIONS, async ($, on) => {
  const TEAM = { rosterFormat: 1, sections: [{ id: 'work', title: 'Work' }], roles: { chief: { agent: 'owner', model: 'haiku' }, tester: { agent: 'owner', model: 'haiku' } }, instances: [{ name: 'Chief', role: 'chief', section: 'work' }, { name: 'Tester 1', role: 'tester', section: 'work' }, { name: 'Tester 2', role: 'tester', section: 'work' }], wakes: { everyMin: 5, perDay: 8 } }
  const work = { format: 1, at: NOW, unowned: {}, capacity: { idle: ['Tester 1', 'Tester 2'], unowned: 0, oldest: null, slotsFree: null, slotsTotal: null, runs: 0, unrecorded: 0, flags: [] } }
  const w = world(on, {
    worldPaths: ['notes/**', 'board/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Chief', FLEET_ROLE: 'chief' },
    files: { [`${FLEET}/roster.json`]: JSON.stringify(TEAM), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/chief.json`]: '{"env":{}}\n', [`${FLEET}/state/work.json`]: JSON.stringify(work), [`${ROOT}/notes/plan.md`]: '# plan\n' },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: 'aaaaaaaa', sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Chief', root: ROOT, background: true, agent: 'owner' }, rows: { aaaaaaaa: row('aaaaaaaa', 'Chief', 'working'), ttttttt1: row('ttttttt1', 'Tester 1', 'idle'), ttttttt2: row('ttttttt2', 'Tester 2', 'idle') } })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  await w.clock.advance(2100)
  await w.clock.settle()
  const told = ((await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/plan.md` } as any)).context ?? []).join('\n')
  expect(told).toContain('fleet: idle with no item to take: Tester 1, Tester 2. Turn what the charter and the plan still need into board items (for:, what done looks like), or say in your journal why they wait.')
  const again = ((await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/plan.md` } as any)).context ?? []).join('\n')
  expect(again).not.toContain('idle with no item to take')
})

// ---- G30: a result that needs reproducing becomes a board item ----

const POC_TEAM = {
  rosterFormat: 1,
  sections: [{ id: 'work', title: 'Work' }],
  roles: { chief: { agent: 'owner', model: 'haiku' }, poc: { agent: 'owner', model: 'haiku' }, tester: { agent: 'owner', model: 'haiku' } },
  instances: [
    { name: 'Chief', role: 'chief', section: 'work' },
    { name: 'PoC A', role: 'poc', section: 'work' },
    { name: 'Tester 1', role: 'tester', section: 'work' },
  ],
}
const RESULT = '---\nkind: result\nrun: echo 42\nsha: 084c799cd551\n---\n# Latency at 64 B\n\n42 ns.\n'

// A landing as fleet records it: the file, its event (events/<hour>/<at>-<id>.json), then events/latest rewritten
function landed(w: any, path: string, text: string, by: { name: string; ref: string }, n: number) {
  const at = w.clock.now()
  w.touch(`${ROOT}/${path}`, text)
  w.touch(`${FLEET}/events/${hourFolder(at)}/${at}-bbbbbbbb-${n}.json`, JSON.stringify({ format: 1, at, path, from: null, to: hashText(text), via: 'tool', tool: 'Write', blind: false, by: { sessionId: `${by.ref}-0000-0000-0000-000000000000`, ref: by.ref, name: by.name, agentId: null } }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: `${at}-bbbbbbbb-${n}.json` }))
}

test("a result world.json says needs reproducing becomes a board item for its testers, once, unless the board has one; a tester's own result doesn't", WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: JSON.stringify(POC_TEAM),
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['board/**', 'poc/**', 'notes/**'], reproduce: [{ glob: 'poc/results/**', for: 'tester' }] }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${ROOT}/board/B-3.md`]: '---\nowner: Chief\nstatus: done\n---\n# the plan\n',
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Chief', 'working'), bbbbbbb1: row('bbbbbbb1', 'PoC A', 'idle'), ccccccc1: row('ccccccc1', 'Tester 1', 'idle') } })
  await startSession($, w)
  for (let i = 0; i < 2; i++) {
    await w.clock.advance(30000)
    await w.clock.settle()
  }
  landed(w, 'poc/results/area-a-latency.md', RESULT, { name: 'PoC A', ref: 'bbbbbbb1' }, 1)
  for (let i = 0; i < 3; i++) {
    await w.clock.advance(30000)
    await w.clock.settle()
  }
  const item = w.files.get(`${ROOT}/board/B-4.md`) as string
  expect(item).toContain('owner: open\nstatus: open\nfor: tester\n')
  expect(item).toContain('# Reproduce poc/results/area-a-latency.md')
  expect(item).toContain('PoC A landed poc/results/area-a-latency.md')
  expect(json(w, `${FLEET}/state/reproduce.json`).made['poc/results/area-a-latency.md']).toMatchObject({ item: 'B-4', writer: 'poc-a' })
  // Landed as fleet's own: its event says so, nobody's write is blamed for it
  const events = [...w.files.keys()].filter(k => k.startsWith(`${FLEET}/events/`) && k.endsWith('.json')).map(k => JSON.parse(w.files.get(k) as string))
  expect(events.find(e => e.path === 'board/B-4.md')).toMatchObject({ via: 'fleet', by: null })
  // Offered to the idle tester like any open item
  await w.clock.advance(60000)
  await w.clock.settle()
  expect(json(w, `${FLEET}/state/work.json`).unowned['B-4']).toMatchObject({ for: 'tester', offers: [{ slug: 'tester-1' }] })
  // Once: a later version of the same result opens nothing more
  landed(w, 'poc/results/area-a-latency.md', `${RESULT}\nRun again: 42 ns.\n`, { name: 'PoC A', ref: 'bbbbbbb1' }, 2)
  for (let i = 0; i < 3; i++) {
    await w.clock.advance(30000)
    await w.clock.settle()
  }
  expect(w.files.has(`${ROOT}/board/B-5.md`)).toBe(false)
  // A tester's own result (a reproduction) opens nothing; nor does one the board already names
  landed(w, 'poc/results/area-a-latency-repro.md', RESULT, { name: 'Tester 1', ref: 'ccccccc1' }, 3)
  w.touch(`${ROOT}/board/B-9.md`, '---\nowner: open\nstatus: open\nfor: tester\n---\n# Reproduce poc/results/area-b-rate.md\n')
  landed(w, 'poc/results/area-b-rate.md', RESULT, { name: 'PoC A', ref: 'bbbbbbb1' }, 4)
  for (let i = 0; i < 3; i++) {
    await w.clock.advance(30000)
    await w.clock.settle()
  }
  expect([...w.files.keys()].filter(k => k.startsWith(`${ROOT}/board/`)).sort()).toEqual([`${ROOT}/board/B-3.md`, `${ROOT}/board/B-4.md`, `${ROOT}/board/B-9.md`])
})
