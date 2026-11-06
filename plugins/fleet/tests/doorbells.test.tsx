import { expect, test } from 'claude-code/testing'

import { BAND, DEC, FAKE_LOG, FLEET, REF, ROOT, SID, decide, fleet, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'
import { PROJECT } from './up.test'

// Live updates (0.11.0): fleet's own folders watched (questions, answers, overrules, bells), the engine's FileChanged
// running what the timers ran, and the timers a safety pass. The test world raises no FileChanged by itself: each test
// raises the one the engine would, about 0.6 s after the write

const MIN = 60000
const STATE = `${FLEET}/state`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'

// In steps of a minute at most: one long advance fires thousands of timers at once
async function tick(w: World, ms = 2100) {
  for (let left = ms; left > 0; left -= MIN) {
    await w.clock.advance(Math.min(left, MIN))
    await w.clock.settle()
  }
}

function calls(w: World, kind: string): any[] {
  return (w.files.get(FAKE_LOG) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(c => c[kind])
    .map(c => c[kind])
}

async function changed($: any, path: string, event = 'change') {
  await $.classic.FileChanged({ file_path: path, event } as any)
}

// SessionStart hands the list; the engine brings the probe bell back a moment later: live from then on
async function goLive($: any, w: World) {
  const r: any = await $.classic.SessionStart({ source: 'startup' } as any)
  await tick(w, 1500)
  await changed($, `${FLEET}/bell/probe`)
  await w.clock.settle()
  return r
}

// Another session holds the sweeper's lease (renewed as its fleet would)
function otherSweeps(w: World) {
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner B', at: w.clock.now(), remote: null }))
}

const answer = (id: string, q: number, label: string, at: number) => JSON.stringify({ format: 1, id, q, label, origin: 'composer', session: 'TEST P', at })

function asker($: any, on: any) {
  const w = world(on)
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  return w
}

test("SessionStart hands fleet's folders to watch, made before the list goes; live updates come once the engine brings fleet's own ring back", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT } })
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  await tick(w)
  // Before any SessionStart: it hasn't reached fleet here (a managed plugin may skip it), so neither u nor /clear is named
  expect(await fleet($, 'status')).toContain("live updates off: SessionStart hasn't reached fleet in this session")
  const r: any = await $.classic.SessionStart({ source: 'startup' } as any)
  for (const p of [`${FLEET}/events/latest`, `${DEC}/queue`, `${DEC}/answers`, `${DEC}/overrules`, `${FLEET}/bell`]) expect(r.watchPaths).toContain(p)
  // Made before the list goes (several missing names under one folder: only one would be watched)
  for (const d of [`${DEC}/queue`, `${DEC}/answers`, `${DEC}/overrules`, `${FLEET}/bell`]) expect(w.dirs.has(d)).toBe(true)
  // Not live until the engine proves it watches: its probe bell, rung a second later
  expect(await fleet($, 'status')).toContain('live updates off: u or /clear turns them on')
  await tick(w, 1500)
  expect(w.files.has(`${FLEET}/bell/probe`)).toBe(true)
  await changed($, `${FLEET}/bell/probe`)
  await w.clock.settle()
  expect(await fleet($, 'status')).toContain('live updates: on')
})

test('live: an answer reaches its asker on its file’s event, within a second; with no event, the minute’s safety pass still brings it', WITH_SESSIONS, async ($, on) => {
  const w = asker($, on)
  await startSession($, w)
  await goLive($, w)
  await decide($)
  await tick(w, 3000)
  // Answered from another session: the answer files as fleet writes them, and the engine's event for the last one
  w.touch(`${DEC}/answers/D-1.1.json`, answer('D-1', 1, 'SQLite', w.clock.now()))
  w.touch(`${DEC}/answers/D-1.2.json`, answer('D-1', 2, 'Never', w.clock.now()))
  await tick(w, 6000)
  // No event yet: the 2 s delivery no longer polls
  expect(w.submits.length).toBe(0)
  await changed($, `${DEC}/answers/D-1.2.json`, 'add')
  await tick(w, 1000)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain('[D-1] The person answered:')
  await $.turn.start({ text: `The fleet plugin sent a message:\n${w.submits[0]}`, turnId: 't-1' })
  await w.clock.settle()
  await $.turn.complete({ turnId: 't-1', reason: 'answer', answer: 'ok' } as any)
  await w.clock.settle()
  // A second question, answered with no event at all (a lost one): the safety pass delivers it within the minute
  await decide($)
  await tick(w, 3000)
  w.touch(`${DEC}/answers/D-2.1.json`, answer('D-2', 1, 'SQLite', w.clock.now()))
  w.touch(`${DEC}/answers/D-2.2.json`, answer('D-2', 2, 'Never', w.clock.now()))
  await tick(w, 62000)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toContain('[D-2] The person answered:')
})

test('live: answers that came while the asker worked go as soon as its turn ends, not at the next pass', WITH_SESSIONS, async ($, on) => {
  const w = asker($, on)
  await startSession($, w)
  await goLive($, w)
  await decide($)
  await tick(w, 3000)
  await $.turn.start({ text: 'something else', turnId: 't-2' })
  await w.clock.settle()
  w.touch(`${DEC}/answers/D-1.1.json`, answer('D-1', 1, 'SQLite', w.clock.now()))
  w.touch(`${DEC}/answers/D-1.2.json`, answer('D-1', 2, 'Never', w.clock.now()))
  await changed($, `${DEC}/answers/D-1.2.json`, 'add')
  await tick(w, 3000)
  // Busy: held
  expect(w.submits.length).toBe(0)
  await $.turn.complete({ turnId: 't-2', reason: 'answer', answer: 'done' } as any)
  await tick(w, 1000)
  expect(w.submits.length).toBe(1)
})

test("live: a question another session asks reaches the person's band on the queue's event, within a second", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT } })
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  sessionsSay(w, { rows: { ccccccc1: row('ccccccc1', 'Owner C', 'idle') } })
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await tick(w, 15000)
  otherSweeps(w)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('for you')
  const at = w.clock.now()
  w.touch(`${DEC}/queue/D-5.json`, JSON.stringify({ format: 1, fleet: '0.11.0', id: 'D-5', at, asker: { ref: 'ccccccc1', sessionId: 'cccccccc-0000-0000-0000-000000000000', name: 'Owner C', root: ROOT }, questions: [{ question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'w' }] }))
  await changed($, `${DEC}/queue/D-5.json`, 'add')
  await tick(w, 1000)
  expect(JSON.stringify(await ui.drawn())).toContain('? 1 for you · /fleet')
  await ui.unmount()
})

test('live: a session that doesn’t sweep lists the queue about once a minute, not every 10 s', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT } })
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  sessionsSay(w, { rows: {} })
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await tick(w, MIN)
  const at = w.lists.length
  for (let i = 0; i < 10; i++) {
    otherSweeps(w)
    await tick(w, MIN)
  }
  // (every 10 s before: about 60 in ten minutes)
  expect(w.lists.slice(at).filter(p => p === `${DEC}/queue`).length).toBeLessThanOrEqual(14)
})

// The sweeper (the person's session here) and a retired instance whose question is answered from another session
async function sweeperWithRetired($: any, on: any) {
  const at = Date.UTC(2026, 10, 2, 11, 0, 0)
  const w = world(on, {
    background: false,
    worldPaths: ['notes/**'],
    files: {
      ...PROJECT,
      [`${FLEET}/instances/owner-c/state.json`]: JSON.stringify({ format: 1, instance: 'Owner C', slug: 'owner-c', ref: 'ccccccc1', sessionId: 'cccccccc-0000-0000-0000-000000000000', at, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0 }),
      [`${DEC}/queue/D-3.json`]: JSON.stringify({ format: 1, fleet: '0.3.0', id: 'D-3', at, asker: { ref: 'ccccccc1', sessionId: 'cccccccc-0000-0000-0000-000000000000', name: 'Owner C', root: ROOT }, questions: [{ question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'w' }] }),
    },
  })
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  sessionsSay(w, { rows: { ccccccc1: row('ccccccc1', 'Owner C', 'stopped') } })
  await startSession($, w)
  await goLive($, w)
  // It takes the lease and sweeps; then, past a full sweep, the answer comes
  for (let i = 0; i < 6; i++) await tick(w, 30000)
  await tick(w, 5000)
  expect(calls(w, 'wake')).toEqual([])
  w.touch(`${DEC}/answers/D-3.1.json`, JSON.stringify({ format: 1, id: 'D-3', q: 1, label: 'Yes', origin: 'composer', session: 'TEST', at: w.clock.now() }))
  return w
}

test('live: the sweeper wakes a retired asker on its answer’s event, within seconds, not at its next full sweep', WITH_SESSIONS, async ($, on) => {
  const w = await sweeperWithRetired($, on)
  await changed($, `${DEC}/answers/D-3.1.json`, 'add')
  await tick(w, 1200)
  expect(calls(w, 'wake')).toEqual([{ ref: 'ccccccc1', reason: 'fleet: the person answered it' }])
})

test('(control) with no event, the same answer waits for the sweeper’s next full sweep', WITH_SESSIONS, async ($, on) => {
  const w = await sweeperWithRetired($, on)
  await tick(w, 1200)
  expect(calls(w, 'wake')).toEqual([])
  await tick(w, MIN)
  expect(calls(w, 'wake')).toEqual([{ ref: 'ccccccc1', reason: 'fleet: the person answered it' }])
})

test('bells: a budget raised and an instance taken down ring bell/budget; a restart asked rings bell/restart', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT } })
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  await goLive($, w)
  expect(w.files.has(`${FLEET}/bell/budget`)).toBe(false)
  expect(await fleet($, 'budget "Owner A" +1')).toContain('Owner A:')
  expect(JSON.parse(w.files.get(`${FLEET}/bell/budget`) as string)).toMatchObject({ format: 1 })
  w.files.delete(`${FLEET}/bell/budget`)
  await fleet($, 'down "Owner A"')
  expect(w.files.has(`${FLEET}/bell/budget`)).toBe(true)
  await fleet($, 'up')
  await fleet($, 'up --restart-when-idle "Owner A"')
  expect(w.files.has(`${FLEET}/bell/restart`)).toBe(true)
})

test('no SessionStart (a reload, a managed plugin that sends it on past fleet): no live updates, the timers at their own pace', WITH_SESSIONS, async ($, on) => {
  const w = asker($, on)
  await startSession($, w)
  await tick(w)
  await decide($)
  await tick(w, 3000)
  w.touch(`${DEC}/answers/D-1.1.json`, answer('D-1', 1, 'SQLite', w.clock.now()))
  w.touch(`${DEC}/answers/D-1.2.json`, answer('D-1', 2, 'Never', w.clock.now()))
  // Delivered by the 2 s timer, as before
  await tick(w, 2500)
  expect(w.submits.length).toBe(1)
  expect(await fleet($, 'status')).toContain('live updates off')
})
