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
  if (rest.permissions?.deny) rest.permissions = { ...rest.permissions, deny: rest.permissions.deny.filter((d: string) => !d.startsWith('Edit(//')) }
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

test('the front door hears, once an hour, the instances idle with no item to take for half an hour, not one that just started', WITH_SESSIONS, async ($, on) => {
  const TEAM = { rosterFormat: 1, sections: [{ id: 'work', title: 'Work' }], roles: { chief: { agent: 'owner', model: 'haiku' }, tester: { agent: 'owner', model: 'haiku' } }, instances: [{ name: 'Chief', role: 'chief', section: 'work' }, { name: 'Tester 1', role: 'tester', section: 'work' }, { name: 'Tester 2', role: 'tester', section: 'work' }], wakes: { everyMin: 5, perDay: 8 } }
  const work = { format: 1, at: NOW, unowned: {}, capacity: { idle: ['Tester 1', 'Tester 2'], unowned: 0, oldest: null, slotsFree: null, slotsTotal: null, runs: 0, unrecorded: 0, flags: [] } }
  const w = world(on, {
    worldPaths: ['notes/**', 'board/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Chief', FLEET_ROLE: 'chief' },
    files: { [`${FLEET}/roster.json`]: JSON.stringify(TEAM), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/chief.json`]: '{"env":{}}\n', [`${FLEET}/state/work.json`]: JSON.stringify(work), [`${ROOT}/notes/plan.md`]: '# plan\n',
      // Tester 1 idle 40 minutes since its start; Tester 2 seeded half a minute ago (perf round 2: a told line costs a turn)
      [`${FLEET}/instances/tester-1/state.json`]: JSON.stringify({ format: 1, instance: 'Tester 1', slug: 'tester-1', ref: 'ttttttt1', sessionId: 'ttttttt1-0000-0000-0000-000000000000', at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: NOW - 40 * 60000, idleSince: NOW - 39 * 60000 }),
      [`${FLEET}/instances/tester-2/state.json`]: JSON.stringify({ format: 1, instance: 'Tester 2', slug: 'tester-2', ref: 'ttttttt2', sessionId: 'ttttttt2-0000-0000-0000-000000000000', at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: NOW - 30000, idleSince: NOW - 20000 }),
    },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: 'aaaaaaaa', sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Chief', root: ROOT, background: true, agent: 'owner' }, rows: { aaaaaaaa: row('aaaaaaaa', 'Chief', 'working'), ttttttt1: row('ttttttt1', 'Tester 1', 'idle'), ttttttt2: row('ttttttt2', 'Tester 2', 'idle') } })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  await w.clock.advance(2100)
  await w.clock.settle()
  const told = ((await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/plan.md` } as any)).context ?? []).join('\n')
  expect(told).toContain('fleet: idle with no item to take: Tester 1. Turn what the charter and the plan still need into board items (for:, what done looks like), or say in your journal why they wait.')
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

// ---- One call that never returns (a call that never returned for well over an hour, and nothing said so) ----

test("an instance's heartbeat carries its main thread's tool call in flight, and drops it once the call returns", WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    worldPaths: ['notes/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/owner-a.json`]: '{}\n' },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  // Beneath fleet: a search that doesn't return until the test lets it
  let release: (v: unknown) => void = () => {}
  on('tool.call', { tool: 'Grep' as any }, () => new Promise(r => (release = r)) as any)
  sessionsSay(w, { current: { ready: true, ref: 'aaaaaaaa', sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Owner A', root: ROOT, background: true, agent: 'owner' }, rows: { aaaaaaaa: row('aaaaaaaa', 'Owner A', 'working') } })
  await startSession($, w)
  const t0 = w.clock.now()
  const pending = $.tool.call({ tool: 'Grep', pattern: 'x', path: ROOT } as any)
  await w.clock.advance(31000)
  await w.clock.settle()
  expect(json(w, `${HB}/state.json`).call).toEqual({ tool: 'Grep', since: t0 })
  release({ result: 'ok', text: 'nothing found' })
  await pending
  // (its next heartbeat: one a minute)
  await w.clock.advance(61000)
  await w.clock.settle()
  expect(json(w, `${HB}/state.json`).call).toBe(undefined)
})

test('one call in flight past half an hour: its row is marked, status and the brief name it, the front door hears it once, and the person gets an alert past waitingMin', WITH_SESSIONS, async ($, on) => {
  const TEAM = { rosterFormat: 1, sections: [{ id: 'work', title: 'Work' }], roles: { chief: { agent: 'owner', model: 'haiku' }, liaison: { agent: 'owner', model: 'haiku' } }, instances: [{ name: 'Chief', role: 'chief', section: 'work' }, { name: 'Liaison', role: 'liaison', section: 'work' }], person: { addresses: ['me@example.invalid'], channel: { kind: 'command', argv: ['bash', '.claude/fleet/alert.sh'] }, perDay: 4 } }
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: JSON.stringify(TEAM),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/alert.sh`]: '#!/bin/bash\ncat > /dev/null\n',
      [`${FLEET}/instances/liaison/state.json`]: JSON.stringify({ format: 1, instance: 'Liaison', slug: 'liaison', ref: 'bbbbbbb1', sessionId: 'bbbbbbb1-0000-0000-0000-000000000000', at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, call: { tool: 'mcp__x__poll', since: NOW - 40 * 60000 } }),
    },
  })
  const sent: string[] = []
  w.exec.value = (argv, _cwd, stdin) => {
    if (argv[1] !== '.claude/fleet/alert.sh') return undefined
    sent.push(stdin ?? '')
    return { exitCode: 0 }
  }
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Chief', 'working'), bbbbbbb1: row('bbbbbbb1', 'Liaison', 'working') } })
  await startSession($, w)
  expect(await fleet($, 'accept channel')).toContain('Stamped')
  // Its heartbeat stays fresh: the call goes on
  for (let i = 0; i < 4; i++) {
    w.touch(`${FLEET}/instances/liaison/state.json`, JSON.stringify({ ...JSON.parse(w.files.get(`${FLEET}/instances/liaison/state.json`) as string), at: w.clock.now() }))
    await w.clock.advance(30000)
    await w.clock.settle()
  }
  const status = await fleet($, 'status')
  expect(status).toMatch(/one call to mcp__x__poll for 4\dm: it may be hung/)
  expect(await fleet($, 'brief')).toMatch(/Liaison: one call to mcp__x__poll for 4\dm/)
  expect(json(w, `${FLEET}/state/work.json`).capacity.stuck).toEqual([{ inst: 'Liaison', tool: 'mcp__x__poll', since: NOW - 40 * 60000 }])
  expect(sent.join('\n')).toMatch(/Liaison has been in one call to mcp__x__poll for 4\dm/)
})

// ---- B27: after the background service died and its sessions came back ----

test('after a restart an instance hears the slots it still holds, beside its runs and commands', WITH_SESSIONS, async ($, on) => {
  const SID = 'aaaaaaaa-0000-0000-0000-000000000000'
  const t0 = Date.UTC(2026, 10, 2, 12, 0, 0)
  const w = world(on, {
    worldPaths: ['notes/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: {
      [`${FLEET}/roster.json`]: roster({}),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/instances/owner-a.json`]: '{}\n',
      [`${FLEET}/slots.json`]: JSON.stringify({ slotsFormat: 1, slots: { lab: { count: 2, leaseMin: 30, what: 'the test machine' } } }),
      [`${FLEET}/state/slots/lab/1.json`]: JSON.stringify({ format: 1, slot: 'lab', n: 0, holder: { sessionId: SID, ref: 'aaaaaaaa', name: 'Owner A' }, at: t0 - 600000, until: t0 + 20 * 60000 }),
      [`${HB}/state.json`]: JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'aaaaaaaa', sessionId: SID, at: t0 - 60000, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: t0 - HOUR }),
      [`${HB}/seed-aaaaaaaa.json`]: JSON.stringify({ format: 1, ref: 'aaaaaaaa', at: t0 - HOUR }),
    },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: 'aaaaaaaa', sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }, rows: { aaaaaaaa: row('aaaaaaaa', 'Owner A', 'idle') } })
  await startSession($, w)
  for (let i = 0; i < 3; i++) {
    await w.clock.advance(30000)
    await w.clock.settle()
  }
  const told = w.submits.filter(s => s.includes('in flight'))
  expect(told.length).toBe(1)
  expect(told[0]).toMatch(/fleet: your conversation was restarted while these were in flight: the slots you hold: lab \(unit 1 of 2, until \d\d:\d\d\)/)
  expect(told[0]).toContain('release a slot you no longer need (mcp__fleet__slot release)')
})

// ---- B25, B26: /fleet down and up say what they do; a stopped instance is priced at the context it will reload ----

test('/fleet down says the session keeps running; /fleet up on a running one says it restarts nothing, and what reaches it without a restart', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${HB}/state.json`]: beat() } })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  const down = await fleet($, 'down "Owner A"')
  expect(down).toContain('Still running: Owner A: it keeps working; fleet only stops waking and nudging it until /fleet up names it (s in the panel stops the session).')
  const up = await fleet($, 'up "Owner A"')
  expect(up).toContain("placed, not started again (fleet doesn't restart a running session: a model or effort change reaches it at its next request)")
})

test('a stopped instance is priced at the context it had when it stopped (a wake reloads all of it), and said so', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${HB}/state.json`]: beat({ at: NOW - 5 * HOUR, contextTokens: 300000 }) } })
  sessionsSay(w, { rows: { aaaaaaa1: { ...row('aaaaaaa1', 'Owner A', 'stopped'), stopped: 'idle' } } })
  await startSession($, w)
  expect(await fleet($, 'up --dry-run')).toContain('(its context when it stopped: 300k)')
})

// ---- The board's ids, the clock of a role with no Bash, a slot's count ----

test('a write to a board item a peer just created, unread: the refusal names the next free id', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['board/**'], files: { [`${FLEET}/roster.json`]: JSON.stringify(POC_TEAM), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${ROOT}/board/B-6.md`]: '# six\n' } })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  await w.clock.advance(3000)
  await w.clock.settle()
  landed(w, 'board/B-7.md', '---\nowner: open\nstatus: open\n---\n# seven\n', { name: 'PoC A', ref: 'bbbbbbb1' }, 1)
  await w.clock.advance(3000)
  await w.clock.settle()
  const r: any = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/board/B-7.md`, content: '# my new item\n' } as any)
  expect(String(r.deny ?? '')).toContain('B-7 is a new item PoC A just created: if yours is another item, the next free id is B-8')
})

test("every mcp__fleet__ result ends with fleet's clock (a role with no Bash has no other)", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' }, files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/owner-a.json`]: '{}\n' } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: 'aaaaaaaa', sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Owner A', root: ROOT, background: true, agent: 'owner' }, rows: { aaaaaaaa: row('aaaaaaaa', 'Owner A', 'working') } })
  await startSession($, w)
  await w.clock.advance(2100)
  await w.clock.settle()
  const r: any = await $.tool.call({ tool: 'mcp__fleet__run', action: 'list' } as any)
  expect((r.context ?? []).join('\n')).toMatch(/fleet's clock: \d{4}-\d{2}-\d{2} \d{2}:\d{2} here, UTC[+-]\d{2}:\d{2}/)
  const ctx: any = await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  expect(ctx.additionalContext.join('\n')).toContain('A time you write (in your journal, a record) comes from `date` or from fleet\'s clock, never a guess')
})

test('a slot taken says which unit and how many are taken', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${FLEET}/slots.json`]: JSON.stringify({ slotsFormat: 1, slots: { lab: { count: 4, leaseMin: 30, what: 'the test machine' } } }), [`${FLEET}/state/slots/lab/0.json`]: JSON.stringify({ format: 1, slot: 'lab', n: 0, holder: { sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', ref: 'bbbbbbbb', name: 'Tester 2' }, at: NOW, until: NOW + 20 * 60000 }) } })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  const r: any = await $.tool.call({ tool: 'mcp__fleet__slot', action: 'take', slot: 'lab' } as any)
  expect(String(r.result)).toContain('Yours: lab (unit 2 of 4; 2 of 4 taken) until')
  const again: any = await $.tool.call({ tool: 'mcp__fleet__slot', action: 'take', slot: 'lab' } as any)
  expect(String(again.result)).toContain('You hold lab (unit 2 of 4; 2 of 4 taken) until')
})
