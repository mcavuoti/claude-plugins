import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { settingsText } from '../hooks/roster'
import { FLEET, JOB, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// fleet 0.10's activity part after the proposal template's TEST run: a reproduction is the tester's to close; a
// background MCP task keeps an instance busy and is marked when it runs long; fleet's own deny rules restart nobody; a
// fresh period waits for a pending restart; the front door's idle line skips an item just opened

const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, AskUserQuestion, SendMessage, mcp__fleet__*\n---\nYou own a part of the notes.\n'
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const HOUR = 3600000

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

function landed(w: any, path: string, text: string, by: { name: string; ref: string }, n: number) {
  const at = w.clock.now()
  w.touch(`${ROOT}/${path}`, text)
  w.touch(`${FLEET}/events/${hourFolder(at)}/${at}-bbbbbbbb-${n}.json`, JSON.stringify({ format: 1, at, path, from: null, to: hashText(text), via: 'tool', tool: 'Write', blind: false, by: { sessionId: `${by.ref}-0000-0000-0000-000000000000`, ref: by.ref, name: by.name, agentId: null } }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: `${at}-bbbbbbbb-${n}.json` }))
}

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

// An instance of POC_TEAM in its own session
function member(on: any, name: string, files: Record<string, string> = {}, env: Record<string, string> = {}) {
  const slug = name.toLowerCase().replace(/\s+/g, '-')
  const w = world(on, {
    worldPaths: ['notes/**', 'board/**', 'poc/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: name, FLEET_ROLE: 'x', ...env },
    files: { [`${FLEET}/roster.json`]: JSON.stringify(POC_TEAM), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/${slug}.json`]: '{"env":{}}\n', [`${ROOT}/notes/plan.md`]: '# plan\n', ...files },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name, root: ROOT, background: true, agent: 'owner' }, rows: { [REF]: row(REF, name, 'working') } })
  return w
}

// ---- 1. the reproduction is the tester's to close ----

test("a reproduction item says the one who takes it judges whether it's needed; its result's writer only hears it was opened", WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: { [`${FLEET}/roster.json`]: JSON.stringify(POC_TEAM), [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['board/**', 'poc/**'], reproduce: [{ glob: 'poc/results/**', for: 'tester' }] }), [`${ROOT}/.claude/agents/owner.md`]: OWNER },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Chief', 'working'), bbbbbbb1: row('bbbbbbb1', 'PoC A', 'idle'), ccccccc1: row('ccccccc1', 'Tester 1', 'idle') } })
  await startSession($, w)
  await tick(w, 30000)
  landed(w, 'poc/results/area-a-latency.md', RESULT, { name: 'PoC A', ref: 'bbbbbbb1' }, 1)
  for (let i = 0; i < 3; i++) await tick(w, 30000)
  const item = w.files.get(`${ROOT}/board/B-1.md`) as string
  expect(item).toContain('If you find it needs no reproduction, set it done saying why: that call is yours')
  expect(item).not.toContain('PoC A or the front door sets it done')
})

test('the writer of a result fleet opened a reproduction for is told only that, never to close it', WITH_SESSIONS, async ($, on) => {
  const w = member(on, 'PoC A', {
    [`${FLEET}/state/reproduce.json`]: JSON.stringify({ format: 1, since: NOW - HOUR, made: { 'poc/results/area-a-latency.md': { item: 'B-4', at: NOW, writer: 'poc-a', v: 'h1', opened: true } } }),
  })
  // Its world with the reproduce rule (the member's world.json is written from its paths: this one replaces it)
  w.touch(`${FLEET}/world.json`, JSON.stringify({ worldFormat: 1, paths: ['notes/**', 'board/**', 'poc/**'], reproduce: [{ glob: 'poc/results/**', for: 'tester' }] }))
  await startSession($, w)
  await tick(w)
  const told = [...w.submits, ...(((await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/plan.md` } as any)).context ?? []) as string[])].join('\n')
  expect(told).toContain('fleet opened B-4 for its reproduction by tester')
  expect(told).not.toContain('set B-4 done')
})

// ---- 2. a background MCP task ----

test("an instance's heartbeat carries the job's background tasks (an MCP task the engine moved to the background)", WITH_SESSIONS, async ($, on) => {
  const w = member(on, 'Tester 1')
  // Claude's job state: an MCP call it moved to the background
  w.touch(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, state: 'idle', inFlight: { tasks: 1, kinds: ['mcp_task'] } }))
  await startSession($, w)
  const t0 = w.clock.now()
  await tick(w, 31000)
  const tasks = json(w, `${FLEET}/instances/tester-1/state.json`).tasks
  expect(tasks).toMatchObject({ count: 1, kinds: ['mcp_task'] })
  expect(tasks.since).toBeGreaterThanOrEqual(t0)
})

test('the sweeper counts an instance with a background MCP task busy (no offer, not idle), and marks it once the task runs 20 min', WITH_SESSIONS, async ($, on) => {
  // A running, idle-looking instance whose heartbeat says so
  const v = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: JSON.stringify(POC_TEAM),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['board/**'] }),
      [`${ROOT}/board/B-5.md`]: '---\nowner: open\nstatus: open\nfor: tester\n---\n# Measure it\n',
      [`${FLEET}/instances/tester-1/state.json`]: JSON.stringify({ format: 1, instance: 'Tester 1', slug: 'tester-1', ref: 'ccccccc1', sessionId: 'ccccccc1-0000-0000-0000-000000000000', at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, tasks: { count: 1, kinds: ['mcp_task'], since: NOW - 25 * 60000 } }),
    },
  })
  sessionsSay(v, { rows: { aaaaaaa1: row('aaaaaaa1', 'Chief', 'working'), ccccccc1: row('ccccccc1', 'Tester 1', 'idle') } })
  await startSession($, v)
  for (let i = 0; i < 2; i++) {
    v.touch(`${FLEET}/instances/tester-1/state.json`, JSON.stringify({ ...JSON.parse(v.files.get(`${FLEET}/instances/tester-1/state.json`) as string), at: v.clock.now() }))
    await tick(v, 30000)
  }
  const work = json(v, `${FLEET}/state/work.json`)
  expect(work.capacity.idle).not.toContain('Tester 1')
  expect(work.unowned['B-5'].offers).toEqual([])
  const status = await fleet($, 'status')
  expect(status).toMatch(/a background MCP task for 2\dm: it may be hung/)
  // Its row doesn't say a bare "idle": the task keeps it at work
  expect(status).toContain('idle, with a background MCP task running (busy for offers and capacity)')
})

// ---- 3. fleet's own deny rules restart nobody ----

test('a roster change that only adds fleet’s own deny rules (a command channel) restarts no instance', WITH_SESSIONS, async ($, on) => {
  const HB = `${FLEET}/instances/owner-a`
  const roster = (extra: Record<string, unknown> = {}) => JSON.stringify({ rosterFormat: 1, sections: [{ id: 'owners', title: 'Owners' }], roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 } } }, instances: [{ name: 'Owner A', role: 'owner', section: 'owners' }], budget: { usdDay: 5 }, ...extra })
  const beat = (extra: Record<string, unknown> = {}) => JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'aaaaaaa1', sessionId: 'aaaaaaa1-0000-0000-0000-000000000000', at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: NOW - 3 * HOUR, ...extra })
  // The hash an instance keeps: without its model, its effort and fleet's own deny rules (Edit(//<project>/…))
  const core = (text: string) => {
    const { model: _m, effortLevel: _e, ...rest } = JSON.parse(text)
    if (rest.permissions?.deny) rest.permissions = { ...rest.permissions, deny: rest.permissions.deny.filter((d: string) => !d.startsWith('Edit(//')) }
    return hashText(settingsText(rest))
  }
  const w = world(on, { background: false, files: { [`${FLEET}/roster.json`]: roster(), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${HB}/state.json`]: beat(), [`${FLEET}/channels/append.sh`]: '#!/bin/bash\ncat >> /tmp/x/alerts.txt\n' } })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  await fleet($, 'accept roster.json')
  const first = w.files.get(`${FLEET}/instances/owner-a.json`) as string
  w.touch(`${HB}/state.json`, beat({ settingsHash: core(first) }))
  w.touch(`${FLEET}/roster.json`, roster({ person: { addresses: ['me@example.invalid'], channel: { kind: 'command', argv: ['bash', '.claude/fleet/channels/append.sh'] } } }))
  const accepted = await fleet($, 'accept roster.json')
  expect(w.files.get(`${FLEET}/instances/owner-a.json`)).not.toBe(first)
  expect(w.files.has(`${HB}/restart.json`)).toBe(false)
  expect(accepted).not.toContain('restarts with its new settings')
})

// ---- 4. a fresh period waits for a pending restart ----

test('a fresh period waits while a restart is pending', WITH_SESSIONS, async ($, on) => {
  const cleared: string[] = []
  on('command.run', { command: 'clear' }, () => (cleared.push('x'), { text: '' }))
  const HB = `${FLEET}/instances/owner-a`
  const w = world(on, {
    worldPaths: ['notes/**', 'journals/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: { [`${FLEET}/roster.json`]: JSON.stringify({ rosterFormat: 1, sections: [{ id: 'owners', title: 'Owners' }], roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 }, cadenceH: 1 } }, instances: [{ name: 'Owner A', role: 'owner', section: 'owners' }] }), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/seeds/owner.md`]: 'Plan your part.', [`${FLEET}/instances/owner-a.json`]: '{}\n' },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }, rows: { [REF]: row(REF, 'Owner A', 'idle') }, refuseRestart: 'it is busy' })
  await startSession($, w)
  await tick(w)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/journals/owner-a.md`, content: '# Owner A\n\n- result: plan in notes/a.md\n' } as any)
  // A restart asked once it's idle (sessions says not now): pending
  w.touch(`${HB}/restart.json`, JSON.stringify({ format: 1, at: w.clock.now() }))
  for (let i = 0; i < 14; i++) await tick(w, 5 * 60000)
  expect(cleared).toEqual([])
})

// ---- 5. the front door's idle line skips an item opened since the last sweep ----

test("the front door's idle line leaves out an instance an item opened since the last sweep fits", WITH_SESSIONS, async ($, on) => {
  const work = { format: 1, at: NOW, unowned: {}, capacity: { idle: ['PoC A', 'Tester 1'], unowned: 0, oldest: null, slotsFree: null, slotsTotal: null, runs: 0, unrecorded: 0, flags: [], idleSince: { 'PoC A': NOW - 2 * 3600000, 'Tester 1': NOW - 2 * 3600000 } } }
  const w = member(on, 'Chief', { [`${FLEET}/state/work.json`]: JSON.stringify(work), [`${FLEET}/instances/poc-a/state.json`]: JSON.stringify({ format: 1, instance: 'PoC A', slug: 'poc-a', ref: 'ppppppp1', sessionId: 'ppppppp1-0000-0000-0000-000000000000', at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: NOW - 2 * 3600000 }), [`${FLEET}/instances/tester-1/state.json`]: JSON.stringify({ format: 1, instance: 'Tester 1', slug: 'tester-1', ref: 'ttttttt1', sessionId: 'ttttttt1-0000-0000-0000-000000000000', at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: NOW - 2 * 3600000 }) })
  await startSession($, w)
  await tick(w)
  // fleet opened B-1 for the testers a moment ago; the sweep that offers it hasn't written work.json yet
  w.touch(`${ROOT}/board/B-1.md`, '---\nowner: open\nstatus: open\nfor: tester\n---\n# Reproduce poc/results/x.md\n')
  w.touch(`${FLEET}/state/work.json`, JSON.stringify({ ...work, at: w.clock.now() - 30000 }))
  const told = ((await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/plan.md` } as any)).context ?? []).join('\n')
  expect(told).toContain('idle with no item to take: PoC A.')
  expect(told).not.toContain('Tester 1')
})
