import { expect, test } from 'claude-code/testing'

import { BAND, FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, under, world, type World, WITH_SESSIONS } from './world'

// Slots from the mod's side: mcp__fleet__slot takes a lease of a pool of one, a second taker waits in line, the
// sweeper takes back a lease that ran out and gives it to the first in line, who hears it at its next step

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const SLOTS = `${FLEET}/state/slots/lab`
const OTHER = { sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', ref: 'bbbbbbbb', name: 'Tester 2' }

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

const slot = ($: any, input: Record<string, unknown>): Promise<any> => $.tool.call({ tool: 'mcp__fleet__slot', ...input } as any)

function project(on: any, files: Record<string, string> = {}) {
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${FLEET}/slots.json`]: JSON.stringify({ slotsFormat: 1, slots: { lab: { count: 1, leaseMin: 30, what: 'the test machine' } } }), ...files } })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Tester 1', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'Tester 1', 'idle') } })
  return w
}

// The sweeper sweeps whatever the world is: with no paths (R1), or one too big to scan (R2), a lease that ran out is
// still taken back
const RAN_OUT = { [`${SLOTS}/0.json`]: JSON.stringify({ format: 1, slot: 'lab', n: 0, holder: OTHER, at: NOW - 40 * 60000, until: NOW - 60000, why: 'a long run' }) }

test('R1: a world.json with no paths still has a sweeper: a lease that ran out is taken back', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: [], files: { [`${FLEET}/slots.json`]: JSON.stringify({ slotsFormat: 1, slots: { lab: { count: 1, leaseMin: 30, what: 'the test machine' } } }), ...RAN_OUT } })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  for (let i = 0; i < 40; i++) await tick(w)
  expect(under(w, SLOTS)).toEqual([])
  expect(w.logs.some(l => l.includes("slot lab: Tester 2's lease ran out: taken back"))).toBe(true)
  expect(await fleet($, 'status')).toContain('sweeper: this session')
})

test('R2: a world too big to scan still has a sweeper, stops walking, and says so in status and the band', WITH_SESSIONS, async ($, on) => {
  const many = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`${ROOT}/notes/n${i}.md`, 'x\n']))
  const w = project(on, { ...many, ...RAN_OUT })
  await startSession($, w)
  for (let i = 0; i < 40; i++) await tick(w)
  expect(under(w, SLOTS)).toEqual([])
  expect(await fleet($, 'status')).toContain("world too big (more than 5000 files): no scan, so outside changes and suspects aren't seen")
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).toContain('! world too big: no scan · /fleet status')
  await ui.unmount()
  // Narrowed, it's walked again at once
  w.touch(`${FLEET}/world.json`, JSON.stringify({ worldFormat: 1, paths: ['notes/n1*.md'] }))
  for (let i = 0; i < 10; i++) await tick(w)
  expect(await fleet($, 'status')).not.toContain('world too big')
})

test('a slot: take, take again to extend, release; list; an unknown one is said', WITH_SESSIONS, async ($, on) => {
  const w = project(on)
  await startSession($, w)
  await tick(w)
  expect((await slot($, { action: 'take', slot: 'nope' })).deny).toBe('There is no slot "nope": this project has lab. Nothing was done.')
  const r = await slot($, { action: 'take', slot: 'lab', why: 'run the regression', minutes: 20 })
  expect(r.result).toMatch(/^Yours: lab \(unit 1 of 1; 1 of 1 taken\) until \d\d:\d\d \(20 min\)\. Release it with mcp__fleet__slot release as soon as you're done/)
  expect(json(w, `${SLOTS}/0.json`)).toMatchObject({ format: 1, slot: 'lab', n: 0, holder: { sessionId: SID, ref: REF, name: 'Tester 1' }, why: 'run the regression', until: NOW + 2100 + 20 * 60000 })
  expect((await slot($, { action: 'take', slot: 'lab', minutes: 30 })).result).toMatch(/^You hold lab \(unit 1 of 1; 1 of 1 taken\) until \d\d:\d\d now\./)
  expect((await slot($, { action: 'list' })).result).toContain('- lab (the test machine): 1 of 1 taken (Tester 1 until ')
  expect(await fleet($, 'status')).toContain('slot lab (the test machine): 1 of 1 taken (Tester 1 until ')
  expect((await slot($, { action: 'release', slot: 'lab' })).result).toBe('Released lab. Take it again with mcp__fleet__slot take if you need it later.')
  expect(under(w, SLOTS)).toEqual([])
  expect((await slot($, { action: 'release', slot: 'lab' })).result).toBe('You held no lab: nothing to release.')
  expect((await $.tool.call({ tool: 'mcp__fleet__slot', action: 'take', slot: 'lab', agentId: 'helper-1' } as any)).deny).toContain('only for the main thread')
})

test('after a /clear the new conversation hears the lease it holds, once; one that ran out meanwhile is dropped unsaid', WITH_SESSIONS, async ($, on) => {
  const w = project(on)
  await startSession($, w)
  await tick(w)
  expect((await slot($, { action: 'take', slot: 'lab', minutes: 20 })).result).toMatch(/^Yours: lab/)
  expect((await $.tool.call({ tool: 'Bash', command: 'true' } as any)).context ?? []).toEqual([])
  await $.session.end({ reason: 'clear', sessionId: SID } as any)
  await w.clock.settle()
  const step: any = await $.tool.call({ tool: 'Bash', command: 'true' } as any)
  expect((step.context ?? []).join('\n')).toMatch(/^fleet: you hold lab \(1 of 1, until \d\d:\d\d\), taken before this conversation started\. Release it with mcp__fleet__slot release/)
  expect((await $.tool.call({ tool: 'Bash', command: 'true' } as any)).context ?? []).toEqual([])
  // Cleared again, and the lease runs out before the next step: nothing to tell about a lease it never heard of
  await $.session.end({ reason: 'clear', sessionId: SID } as any)
  await w.clock.settle()
  for (let i = 0; i < 600; i++) await tick(w)
  expect(under(w, SLOTS)).toEqual([])
  expect((await $.tool.call({ tool: 'Bash', command: 'true' } as any)).context ?? []).toEqual([])
})

test('a pool of one: a second taker waits; the sweeper takes back the lease that ran out and gives it to the first in line', WITH_SESSIONS, async ($, on) => {
  const w = project(on, { [`${SLOTS}/0.json`]: JSON.stringify({ format: 1, slot: 'lab', n: 0, holder: OTHER, at: NOW - 20 * 60000, until: NOW + 5 * 60000, why: 'a long run' }) })
  await startSession($, w)
  await tick(w)
  const r = await slot($, { action: 'take', slot: 'lab', why: 'my run' })
  expect(r.result).toMatch(/^None of lab is free \(1 of 1 taken \(Tester 2 until \d\d:\d\d \("a long run"\)\)\)\. You're number 1 in line: fleet gives you one as soon as it's free, and tells you then/)
  expect(json(w, `${SLOTS}/waiting/${REF}.json`)).toMatchObject({ format: 1, slot: 'lab', holder: { ref: REF }, why: 'my run' })
  expect(await fleet($, 'status')).toMatch(/slot lab \(the test machine\): 1 of 1 taken \(Tester 2 until \d\d:\d\d \("a long run"\)\); waiting: Tester 1 since \d\d:\d\d/)
  expect(await fleet($, 'brief')).toContain('   - Tester 1 waits for the slot lab (')
  // Five minutes later Tester 2's lease runs out: the sweeper takes it back and gives it to the first in line
  for (let i = 0; i < 180; i++) await tick(w)
  expect(json(w, `${SLOTS}/0.json`)).toMatchObject({ holder: { ref: REF }, granted: true, why: 'my run' })
  expect(under(w, `${SLOTS}/waiting`)).toEqual([])
  expect(w.logs.some(l => l.includes("slot lab: Tester 2's lease ran out: taken back"))).toBe(true)
  expect(w.logs.some(l => l.includes('slot lab: given to Tester 1 (1 of 1), first in line'))).toBe(true)
  // It hears it at its next step, once
  const read: any = await $.tool.call({ tool: 'Bash', command: 'true' } as any)
  expect((read.context ?? []).join('\n')).toMatch(/fleet: lab is yours now \(1 of 1, until \d\d:\d\d\): you were first in line\./)
  const again: any = await $.tool.call({ tool: 'Bash', command: 'true' } as any)
  expect(again.context ?? []).toEqual([])
  // Its own lease runs out too: it hears that it was taken back
  for (let i = 0; i < 900; i++) await tick(w)
  const after: any = await $.tool.call({ tool: 'Bash', command: 'true' } as any)
  expect((after.context ?? []).join('\n')).toContain('fleet: your lease on lab ran out and fleet took it back.')
})

test('while another waits a renewal doesn’t jump the line; a waiter whose session is gone leaves it', WITH_SESSIONS, async ($, on) => {
  const me = { sessionId: SID, ref: REF, name: 'Tester 1' }
  const w = project(on, {
    [`${SLOTS}/0.json`]: JSON.stringify({ format: 1, slot: 'lab', n: 0, holder: me, at: NOW - 25 * 60000, until: NOW + 5 * 60000, why: 'my run' }),
    [`${SLOTS}/waiting/bbbbbbbb.json`]: JSON.stringify({ format: 1, slot: 'lab', holder: OTHER, at: NOW - 60000, why: 'its run' }),
  })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Tester 1', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'Tester 1', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Tester 2', 'idle') } })
  await startSession($, w)
  await tick(w)
  // Held 25 of its 30 minutes, and Tester 2 waits: not extended past the lease's length
  const r = await slot($, { action: 'take', slot: 'lab', minutes: 30 })
  expect(r.result).toMatch(/^1 waits for lab, and you've held it since \d\d:\d\d, as long as a lease lasts \(30 min\): it isn't extended, and goes to the first in line at \d\d:\d\d\./)
  expect(json(w, `${SLOTS}/0.json`).until).toBe(NOW + 5 * 60000)
  // Tester 2's session is gone: the sweeper drops it from the line, and the lease extends again
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Tester 1', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'Tester 1', 'idle') } })
  for (let i = 0; i < 31; i++) await tick(w)
  expect(under(w, `${SLOTS}/waiting`)).toEqual([])
  expect(w.logs.some(l => l.includes('slot lab: Tester 2 out of line (its session is gone)'))).toBe(true)
  expect((await slot($, { action: 'take', slot: 'lab', minutes: 30 })).result).toMatch(/^You hold lab \(unit 1 of 1; 1 of 1 taken\) until \d\d:\d\d now\. Release it/)
  expect(json(w, `${SLOTS}/0.json`).until).toBeGreaterThan(NOW + 25 * 60000)
})
