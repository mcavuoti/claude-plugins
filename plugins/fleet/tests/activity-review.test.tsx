import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { instancesOf, lintRoster, settingsFor, settingsText, type Roster } from '../hooks/roster'
import { FLEET, REF, ROOT, SID, decide, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// fleet 0.10's activity part after its review: a roster change taking effect never starts bypassPermissions; an
// effort outside the levels; a model refused only after failing in a row, asked again later; what counts as a
// reproduction already; the front door's idle line; an item with no for: in a roster with no front door; a
// non-result read once; a session that's no instance binds once

const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, AskUserQuestion, SendMessage, mcp__fleet__*\n---\nYou own a part of the notes.\n'
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }
const HB = `${FLEET}/instances/owner-a`
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const HOUR = 3600000

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

async function step($: any, model: string, extra: Record<string, unknown> = {}) {
  const s = $.turn.step({ turnId: 't-1', index: 0, model, messageCount: 1, ...extra })
  for await (const _ of s) {
  }
  return s.result
}

function roster(role: Record<string, unknown>) {
  return JSON.stringify({ rosterFormat: 1, sections: [{ id: 'owners', title: 'Owners' }], roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 }, ...role } }, instances: [{ name: 'Owner A', role: 'owner', section: 'owners' }], budget: { usdDay: 5 } })
}

function beat(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'aaaaaaa1', sessionId: 'aaaaaaa1-0000-0000-0000-000000000000', at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: NOW - 3 * HOUR, lastLanding: NOW - 600000, ...extra })
}

function coreHash(text: string): string {
  const { model: _m, effortLevel: _e, ...rest } = JSON.parse(text)
  return hashText(settingsText(rest))
}

// ---- 1. a roster change taking effect lints first ----

test('an accepted roster.json that would start an instance with bypassPermissions: its settings stay as they were, nothing restarts, and the reply says so', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${HB}/state.json`]: beat() } })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  await fleet($, 'accept roster.json')
  const first = w.files.get(`${FLEET}/instances/owner-a.json`) as string
  w.touch(`${HB}/state.json`, beat({ settingsHash: coreHash(first) }))
  w.touch(`${FLEET}/roster.json`, roster({ permissions: { defaultMode: 'bypassPermissions' } }))
  const accepted = await fleet($, 'accept roster.json')
  expect(accepted).toContain("not applied to Owner A: fleet doesn't start an instance with bypassPermissions")
  expect(w.files.get(`${FLEET}/instances/owner-a.json`)).toBe(first)
  expect(w.files.has(`${HB}/restart.json`)).toBe(false)
})

test('an applied change to roster.json with bypassPermissions: the same, and the reply reads as one sentence before the list', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${HB}/state.json`]: beat() } })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  await fleet($, 'accept roster.json')
  const first = w.files.get(`${FLEET}/instances/owner-a.json`) as string
  w.touch(`${HB}/state.json`, beat({ settingsHash: coreHash(first) }))
  expect((await decide($, { kind: 'change', path: '.claude/fleet/roster.json', summary: 'owners stop asking', content: roster({ permissions: { defaultMode: 'bypassPermissions' } }) })).result).toContain('Queued as D-1')
  const applied = await fleet($, '1 apply')
  expect(applied).toContain("not applied to Owner A: fleet doesn't start an instance with bypassPermissions")
  expect(applied).not.toMatch(/\n\. /)
  expect(w.files.get(`${FLEET}/instances/owner-a.json`)).toBe(first)
  expect(w.files.has(`${HB}/restart.json`)).toBe(false)
})

test('settingsFor never writes bypassPermissions, whatever the roster says', () => {
  const [i] = instancesOf(JSON.parse(roster({ permissions: { defaultMode: 'bypassPermissions' }, settings: { permissions: { defaultMode: 'bypassPermissions' } } })) as Roster)
  const s: any = settingsFor(i as any, ROOT, [])
  expect(s.permissions?.defaultMode).not.toBe('bypassPermissions')
})

// ---- 2. an effort outside the levels ----

test('an effort outside low..max is a lint error; its requests still get the roster model, and the effort only when it is a level', WITH_SESSIONS, async ($, on) => {
  const lint = lintRoster(JSON.parse(roster({ model: 'claude-opus-5-5', effort: 'hihg' })) as Roster, new Map([['owner', OWNER]]))
  expect(lint.errors).toContain('"Owner A": effort "hihg" isn\'t a level (low, medium, high, xhigh or max)')
  expect(lintRoster(JSON.parse(roster({ effort: 'High' })) as Roster, new Map([['owner', OWNER]])).errors.filter(e => e.includes('effort'))).toEqual([])
  const received: { model: string; effort?: unknown }[] = []
  const w = world(on, {
    worldPaths: ['notes/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: { [`${FLEET}/roster.json`]: roster({ model: 'claude-opus-5-5', effort: 'hihg' }), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/owner-a.json`]: '{}\n' },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  on('turn.step', async function* (_$: any, e: any) {
    received.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: e.model } }
  } as any)
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  await startSession($, w)
  await step($, 'claude-haiku-5-5', { effort: 'medium' })
  expect(received).toEqual([{ model: 'claude-opus-5-5', effort: 'medium' }])
  await tick(w, 31000)
  expect(json(w, `${HB}/state.json`).model).toBe('claude-opus-5-5')
})

// ---- 3. a model that doesn't answer: refused only after 3 in a row, asked again after a while ----

test('one request of the roster model with no response is no refusal; three in a row are, asked again 30 min later, and status says it got no response', WITH_SESSIONS, async ($, on) => {
  const received: string[] = []
  let failing = 1
  const w = world(on, {
    worldPaths: ['notes/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: { [`${FLEET}/roster.json`]: roster({ model: 'claude-opus-5-5' }), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/owner-a.json`]: '{}\n' },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  on('turn.step', async function* (_$: any, e: any) {
    received.push(e.model)
    if (e.model === 'claude-opus-5-5' && failing > 0) {
      failing--
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: e.model } }
  } as any)
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  await startSession($, w)
  await step($, 'claude-haiku-5-5')
  await step($, 'claude-haiku-5-5')
  // Once: sent again on the session's model, then asked for at the next step
  expect(received).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'])
  await tick(w, 31000)
  expect(json(w, `${HB}/state.json`).modelRefused).toBe(undefined)
  // Three in a row: not asked for again for 30 min
  failing = 3
  received.length = 0
  for (let k = 0; k < 4; k++) await step($, 'claude-haiku-5-5')
  expect(received).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5'])
  await tick(w, 31000)
  expect(json(w, `${HB}/state.json`).modelRefused).toBe('claude-opus-5-5')
  expect(await fleet($, 'status')).toMatch(/runs claude-haiku-5-5, roster says claude-opus-5-5 \(claude-opus-5-5 got no response 3 times in a row: its requests run the session's own model; fleet asks for it again at \d\d:\d\d\)/)
  await tick(w, 30 * 60000)
  received.length = 0
  await step($, 'claude-haiku-5-5')
  expect(received).toEqual(['claude-opus-5-5'])
})

// ---- 4, 5, 8. reproduce ----

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

function landed(w: any, path: string, text: string, by: { name: string; ref: string }, n: number) {
  const at = w.clock.now()
  w.touch(`${ROOT}/${path}`, text)
  w.touch(`${FLEET}/events/${hourFolder(at)}/${at}-bbbbbbbb-${n}.json`, JSON.stringify({ format: 1, at, path, from: null, to: hashText(text), via: 'tool', tool: 'Write', blind: false, by: { sessionId: `${by.ref}-0000-0000-0000-000000000000`, ref: by.ref, name: by.name, agentId: null } }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: `${at}-bbbbbbbb-${n}.json` }))
}

function pocWorld(on: any, rule: Record<string, unknown>, board: Record<string, string> = {}) {
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: JSON.stringify(POC_TEAM),
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['board/**', 'poc/**', 'notes/**'], reproduce: [rule] }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      ...Object.fromEntries(Object.entries(board).map(([k, v]) => [`${ROOT}/board/${k}`, v])),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Chief', 'working'), bbbbbbb1: row('bbbbbbb1', 'PoC A', 'idle'), ccccccc1: row('ccccccc1', 'Tester 1', 'idle') } })
  return w
}

test('the item that asked for a result names it, and still a reproduction item opens: only one for the rule role that its writer does not own counts', WITH_SESSIONS, async ($, on) => {
  const w = pocWorld(on, { glob: 'poc/results/**', for: 'tester' }, { 'B-3.md': '---\nowner: PoC A\nstatus: started\nfor: poc\n---\n# Measure latency at 64 B\n' })
  await startSession($, w)
  for (let i = 0; i < 2; i++) await tick(w, 30000)
  landed(w, 'poc/results/area-a-latency.md', RESULT, { name: 'PoC A', ref: 'bbbbbbb1' }, 1)
  w.touch(`${ROOT}/board/B-3.md`, '---\nowner: PoC A\nstatus: done\nfor: poc\n---\n# Measure latency at 64 B\n\nDone: poc/results/area-a-latency.md\n')
  for (let i = 0; i < 4; i++) await tick(w, 30000)
  expect(json(w, `${FLEET}/state/reproduce.json`).made['poc/results/area-a-latency.md']).toMatchObject({ item: 'B-4', opened: true })
  expect(w.files.get(`${ROOT}/board/B-4.md`)).toContain('# Reproduce poc/results/area-a-latency.md')
})

test("a rule for the testers (a plural, a list) doesn't open the reproduction of a tester's own result", WITH_SESSIONS, async ($, on) => {
  const w = pocWorld(on, { glob: 'poc/results/**', for: 'testers' })
  await startSession($, w)
  for (let i = 0; i < 2; i++) await tick(w, 30000)
  landed(w, 'poc/results/area-a-latency-repro.md', RESULT, { name: 'Tester 1', ref: 'ccccccc1' }, 1)
  for (let i = 0; i < 3; i++) await tick(w, 30000)
  expect([...w.files.keys()].filter(k => k.startsWith(`${ROOT}/board/`))).toEqual([])
})

test('a file under the glob that is no result is read once per version, not at every sweep', WITH_SESSIONS, async ($, on) => {
  const w = pocWorld(on, { glob: 'poc/results/**', for: 'tester' })
  await startSession($, w)
  for (let i = 0; i < 2; i++) await tick(w, 30000)
  landed(w, 'poc/results/area-a-latency.csv', 'size,ns\n64,42\n'.repeat(1000), { name: 'PoC A', ref: 'bbbbbbb1' }, 1)
  await tick(w, 30000)
  const before = w.readCount.get(`${ROOT}/poc/results/area-a-latency.csv`) ?? 0
  for (let i = 0; i < 20; i++) await tick(w, 30000)
  expect((w.readCount.get(`${ROOT}/poc/results/area-a-latency.csv`) ?? 0) - before).toBeLessThanOrEqual(1)
})

// ---- 6. the front door's idle line ----

test('the front door is not told "idle with no item to take" of instances an open item fits, offered or not yet', WITH_SESSIONS, async ($, on) => {
  const TEAM = { rosterFormat: 1, sections: [{ id: 'work', title: 'Work' }], roles: { chief: { agent: 'owner', model: 'haiku' }, tester: { agent: 'owner', model: 'haiku' } }, instances: [{ name: 'Chief', role: 'chief', section: 'work' }, { name: 'Tester 1', role: 'tester', section: 'work' }, { name: 'Tester 2', role: 'tester', section: 'work' }], wakes: { everyMin: 5, perDay: 8 } }
  const w = world(on, {
    worldPaths: ['notes/**', 'board/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Chief', FLEET_ROLE: 'chief' },
    files: { [`${FLEET}/roster.json`]: JSON.stringify(TEAM), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/chief.json`]: '{"env":{}}\n', [`${ROOT}/notes/plan.md`]: '# plan\n', [`${ROOT}/board/B-5.md`]: '---\nowner: open\nstatus: open\nfor: tester\n---\n# Reproduce the latency result\n' },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: 'aaaaaaaa', sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Chief', root: ROOT, background: true, agent: 'owner' }, rows: { aaaaaaaa: row('aaaaaaaa', 'Chief', 'working'), ttttttt1: row('ttttttt1', 'Tester 1', 'idle'), ttttttt2: row('ttttttt2', 'Tester 2', 'idle') } })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  for (let i = 0; i < 6; i++) await tick(w, 30000)
  const told = [...w.submits, ...(((await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/plan.md` } as any)).context ?? []) as string[])].join('\n')
  expect(told).not.toContain('idle with no item to take')
})

// ---- 7. an item with no for: in a roster with no front door ----

test('in a roster with no front door, an item with no for: is offered to an idle instance other than its writer, and is no "for nobody"', WITH_SESSIONS, async ($, on) => {
  const SOLO = { rosterFormat: 1, sections: [{ id: 'owners', title: 'Owners' }], roles: { owner: { agent: 'owner', model: 'sonnet', cadenceH: 24 } }, instances: [{ name: 'Owner A', role: 'owner', section: 'owners' }, { name: 'Owner B', role: 'owner', section: 'owners' }] }
  const w = world(on, { background: false, files: { [`${FLEET}/roster.json`]: JSON.stringify(SOLO), [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**', 'board/**'] }), [`${ROOT}/.claude/agents/owner.md`]: OWNER } })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle'), bbbbbbb1: row('bbbbbbb1', 'Owner B', 'idle') } })
  await startSession($, w)
  await tick(w, 30000)
  landed(w, 'board/B-1.md', '---\nowner: open\nstatus: open\n---\n# Cross-check the part B notes against part A\n', { name: 'Owner A', ref: 'aaaaaaa1' }, 1)
  for (let i = 0; i < 46; i++) await tick(w, 30000)
  const work = json(w, `${FLEET}/state/work.json`)
  expect(work.unowned['B-1'].offers.map((o: any) => o.slug)).toEqual(['owner-b'])
  expect(work.capacity.nobody).toBe(undefined)
  expect(await fleet($, 'brief')).not.toContain('for nobody')
})

// ---- 9. a session that's no instance binds once ----

test("a background session that's no instance asks who it is once, not before every request", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${FLEET}/roster.json`]: JSON.stringify({ rosterFormat: 1, sections: [], roles: { owner: { agent: 'owner', model: 'haiku' } }, instances: [{ name: 'Owner A', role: 'owner' }] }), [`${ROOT}/.claude/agents/owner.md`]: OWNER } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: e.model } }
  } as any)
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Helper', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'Helper', 'working') } })
  await startSession($, w)
  await tick(w, 3000)
  const before = w.readCount.get('/fake/sessions.json') ?? 0
  for (let i = 0; i < 10; i++) await step($, 'claude-sonnet-5-5', { index: i })
  expect((w.readCount.get('/fake/sessions.json') ?? 0) - before).toBeLessThanOrEqual(1)
})

// ---- reproduce.json is read only where world.json has a reproduce rule ----

test("an instance's ticks don't read state/reproduce.json when world.json has no reproduce rule", WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    worldPaths: ['notes/**', 'board/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/owner-a.json`]: '{}\n' },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  await startSession($, w)
  for (let i = 0; i < 10; i++) await tick(w, 30000)
  expect(w.readCount.get(`${FLEET}/state/reproduce.json`) ?? 0).toBe(0)
})
