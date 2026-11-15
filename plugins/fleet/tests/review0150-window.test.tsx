import { expect, test } from 'claude-code/testing'

import { refusals } from '../hooks/meter'
import { DEBUG_PATH, FAKE_LOG, FLEET, REF, ROOT, SID, fleet, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// The review of fleet 0.15.0's debug window (hooks/register.tsx), in the test world f0150.test.tsx uses (its helpers
// are copied here; world.tsx's noWindow is a sessions that doesn't answer debugWindow in time). Each finding's
// control, and the case that failed before its fix. Placeholders only: /Users/x/proj, ids aaaaaaaa and bbbbbbbb,
// made-up names.

declare const console: { log: (...a: unknown[]) => void }
declare function setTimeout(fn: (...args: unknown[]) => void, ms: number): unknown

const MIN = 60000
const SECOND = 1000
const STATE = `${FLEET}/state`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }
const NOTE = `${ROOT}/notes/a.md`
const LONG = { ...WITH_SESSIONS, timeoutMs: 240000 }
const REPORT = 'r-aaaaaa'
const ROSTER = {
  rosterFormat: 1,
  sections: [{ id: 'owners', title: 'Owners' }],
  roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 } } },
  instances: [
    { name: 'Owner A', role: 'owner', section: 'owners', brief: 'You own notes/a.' },
    { name: 'Owner B', role: 'owner', section: 'owners', parent: 'Owner A' },
  ],
  budget: { usdDay: 5 },
}
const PROJECT = {
  [`${FLEET}/roster.json`]: JSON.stringify(ROSTER),
  [`${ROOT}/.claude/agents/owner.md`]: '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, mcp__fleet__*\n---\nYou own a part of the notes.\n',
  [`${FLEET}/seeds/owner.md`]: 'Read the charter, then plan your part ({name}).',
}

async function tick(w: World, ms = 2100) {
  for (let left = ms; left > 0; left -= MIN) {
    await w.clock.advance(Math.min(left, MIN))
    await w.clock.settle()
  }
}
const realMs = (ms: number) => new Promise<void>(resolve => setTimeout(() => resolve(), ms))
function otherSweeps(w: World) {
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner B', at: w.clock.now(), remote: null }))
}
const GIT = (argv: string[]) => (argv[0] === 'git' ? { exitCode: 128, stdout: '', stderr: 'not a git repository' } : undefined)

// What the module before a reload kept in $.state: the set of paths its SessionStart handed Claude (watching), sessions'
// debug path as that list had it (debugPath: kept with the watch's proof; '' when the list went without it), and the
// report its meter opened for (debugOpen)
type Kept = { watching: number | null; debugOpen: string | null; debugPath?: string | null; sets?: Record<string, unknown> }
function session(on: any, kept: Kept = { watching: null, debugOpen: null }): { w: World; kept: Kept } {
  const w = world(on, { worldPaths: ['notes/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' }, files: { ...PROJECT, [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n', [NOTE]: 'a\n' } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.25 } } }))
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  on('state.get' as any, (_: any, e: any, next: any) => {
    const key = e?.ref?.key ?? e?.key
    if (key === 'watching' && kept.watching !== null) return { value: { value: kept.watching, version: 1 } }
    if (key === 'debugOpen' && kept.debugOpen !== null) return { value: { value: kept.debugOpen, version: 1 } }
    if (key === 'debugPath' && kept.watching !== null && kept.debugPath !== null) return { value: { value: kept.debugPath ?? DEBUG_PATH, version: 1 } }
    return next(e)
  })
  on('state.set' as any, (_: any, e: any, next: any) => {
    // (until the module writes its own)
    const key = e?.ref?.key ?? e?.key
    if (key === 'debugOpen') kept.debugOpen = null
    if (key === 'watching') kept.watching = null
    if (kept.sets && (key === 'debugPath' || key === 'watching')) kept.sets[key] = e.value
    return next(e)
  })
  w.exec.value = GIT
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  return { w, kept }
}
async function changed($: any, path: string, event = 'change') {
  await $.classic.FileChanged({ file_path: path, event } as any)
}
async function goLive($: any, w: World) {
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  await tick(w, 1500)
  await changed($, `${FLEET}/bell/probe`)
}
async function ring($: any, w: World, open: boolean, report = REPORT, ms = 10 * MIN) {
  w.touch(DEBUG_PATH, JSON.stringify({ report, profile: 'perf', open, until: w.clock.now() + ms }))
  await changed($, DEBUG_PATH)
  await w.clock.settle()
}
const logged = (w: World): any[] =>
  (w.files.get(FAKE_LOG) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
const handIns = (w: World): any[] => {
  const all = logged(w).filter(x => x.debugReport).map(x => x.debugReport)
  for (const h of all) expect(refusals(h.data)).toEqual([])
  return all
}
const windowAsks = (w: World): number => logged(w).filter(x => x.debugWindow).length
async function idle(w: World, minutes: number) {
  for (let i = 0; i < minutes * 3; i++) {
    otherSweeps(w)
    await tick(w, 20 * SECOND)
  }
}

// ---- E: a module that came in by a reload knows sessions' debug path from $.state ----
// A reload brings no SessionStart, and the module's own variables start over; Claude still brings the path's changes
// (the watch set is Claude's). The module before it kept the path in $.state with its proof of the watch (debugPath),
// and the new one reads it where it reads `watching`: no call of its own, and no look at the path.

test('E control: with a SessionStart of its own (as f0150.test.tsx has it), a module that finds debugOpen hands in as partial', LONG, async ($, on) => {
  const { w, kept } = session(on)
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 2)
  kept.debugOpen = REPORT
  await ring($, w, false)
  const h = handIns(w)
  expect(h.length).toBe(1)
  expect(h[0].data.partial).toBe('reloaded')
})

test('E1: a module loaded by a reload inside a window (live by $.state, no SessionStart of its own): the close hands in as partial', LONG, async ($, on) => {
  const { w } = session(on, { watching: 2, debugOpen: REPORT })
  otherSweeps(w)
  await startSession($, w)
  await idle(w, 2)
  // (it is live, by the set its predecessor's SessionStart handed: Claude brings it the watched paths' changes)
  await ring($, w, false)
  console.log(`PROOF E1 ${JSON.stringify({ windowAsks: windowAsks(w), handIns: handIns(w).length })}`)
  expect(windowAsks(w)).toBe(1)
  expect(handIns(w).length).toBe(1)
})

test('E2: after a reload, the next window is not counted either: an open and a close, and nothing handed in', LONG, async ($, on) => {
  const { w } = session(on, { watching: 2, debugOpen: null })
  otherSweeps(w)
  await startSession($, w)
  await idle(w, 2)
  await ring($, w, true, 'r-bbbbbb')
  await idle(w, 2)
  await ring($, w, false, 'r-bbbbbb')
  console.log(`PROOF E2 ${JSON.stringify({ windowAsks: windowAsks(w), handIns: handIns(w).length })}`)
  expect(handIns(w).length).toBe(1)
})

// ---- F: the closing ring whose debugWindow() isn't answered in 500 ms: no hand-in, no word in the log ----

test('F control: the close answered: one hand-in', LONG, async ($, on) => {
  const { w } = session(on)
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 1)
  await ring($, w, true)
  await idle(w, 1)
  await ring($, w, false)
  expect(handIns(w).length).toBe(1)
})

test("F: sessions doesn't answer debugWindow at the close: the hand-in is lost and nothing says so", LONG, async ($, on) => {
  const { w } = session(on)
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 1)
  await ring($, w, true)
  await idle(w, 1)
  const said = w.logs.length
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') }, noWindow: true } as any)
  await ring($, w, false)
  // sessions answers again a moment later; no other ring comes (sessions rings once at the close)
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  await idle(w, 1)
  const after = w.logs.slice(said).filter(l => l.includes('debug:'))
  console.log(`PROOF F ${JSON.stringify({ handIns: handIns(w).length, debugLogLines: after.length })}`)
  // Either it is asked again and handed in, or at least the log says the close wasn't taken
  expect(handIns(w).length + after.length).toBeGreaterThan(0)
})

// ---- A, in the test world: two tool calls of one batch in an instance ----

test('A3 control: one tool call (100 ms beneath fleet): no hook of fleet is charged the tool', LONG, async ($, on) => {
  const { w } = session(on)
  otherSweeps(w)
  on('tool.call', { tool: 'Grep' as any }, async () => {
    await realMs(100)
    return { result: 'none' } as any
  })
  await startSession($, w)
  await goLive($, w)
  await idle(w, 1)
  await ring($, w, true)
  await $.tool.call({ tool: 'Grep', pattern: 'x' } as any)
  await ring($, w, false)
  const d = handIns(w)[0].data
  const slow = Object.fromEntries(Object.entries(d.actions as Record<string, any>).filter(([, a]) => a.slowest >= 50).map(([k, a]) => [k, a.slowest]))
  console.log(`PROOF A3 control ${JSON.stringify(slow)}`)
  expect(slow).toEqual({})
})

test('A3: two tool calls at once (100 ms each beneath fleet): a hook of fleet is charged a tool', LONG, async ($, on) => {
  const { w } = session(on)
  otherSweeps(w)
  on('tool.call', { tool: 'Grep' as any }, async () => {
    await realMs(100)
    return { result: 'none' } as any
  })
  await startSession($, w)
  await goLive($, w)
  await idle(w, 1)
  await ring($, w, true)
  await Promise.all([$.tool.call({ tool: 'Grep', pattern: 'x' } as any), $.tool.call({ tool: 'Grep', pattern: 'y' } as any)])
  await ring($, w, false)
  const d = handIns(w)[0].data
  const slow = Object.fromEntries(Object.entries(d.actions as Record<string, any>).filter(([, a]) => a.slowest >= 50).map(([k, a]) => [k, a.slowest]))
  console.log(`PROOF A3 ${JSON.stringify(slow)}`)
  expect(slow).toEqual({})
})

// ---- A, a place where it happens every time: a hook that starts an action and then calls next ----
// classic.PermissionRequest in an instance: bg(heartbeat($)) enters the heartbeat's run, then under(below(), next(e))
// stops that run's clock (the newest), not the hook's: what the heartbeat does while the plugins beneath answer is in
// the totals and under no action

test("A4: an instance's permission prompt: the heartbeat it starts loses its work while the hook waits beneath", LONG, async ($, on) => {
  const { w } = session(on)
  otherSweeps(w)
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  on('classic.PermissionRequest', async () => {
    await held
    return {} as any
  })
  await startSession($, w)
  await goLive($, w)
  await idle(w, 2)
  await ring($, w, true)
  const asked = $.classic.PermissionRequest({ tool_name: 'Bash' } as any)
  await w.clock.settle()
  await realMs(50)
  await w.clock.settle()
  release()
  await asked
  await w.clock.settle()
  await ring($, w, false)
  const d = handIns(w)[0].data
  const beat = d.actions.heartbeat ?? { runs: 0, work: {}, started: {} }
  console.log(`PROOF A4 ${JSON.stringify({ heartbeatRuns: beat.runs, heartbeatWork: beat.work, heartbeatStarted: beat.started, totalStarted: d.totals.started, classicHook: d.actions['classic.hook'] && { ms: d.actions['classic.hook'].ms, work: d.actions['classic.hook'].work } })}`)
  expect(beat.runs).toBeGreaterThan(0)
  // The beat's one mv is the heartbeat's
  expect(beat.started['mv:heartbeat'] ?? 0).toBe(d.totals.started['mv:heartbeat'] ?? 0)
  expect(d.totals.started['mv:heartbeat'] ?? 0).toBeGreaterThan(0)
})

test('E3: a reload asks sessions nothing: the path comes from $.state, and the window file is never looked at until it changes', LONG, async ($, on) => {
  const { w } = session(on, { watching: 2, debugOpen: null })
  otherSweeps(w)
  // (a window is open as the module loads: it doesn't look)
  w.touch(DEBUG_PATH, JSON.stringify({ report: REPORT, profile: 'perf', open: true, until: w.clock.now() + 10 * MIN }))
  await startSession($, w)
  await idle(w, 3)
  expect(windowAsks(w)).toBe(0)
  expect(logged(w).filter(x => x.debugPath).length).toBe(0)
  expect(await fleet($, 'status')).not.toContain('takes no part')
})

test("E4: a reload in a session whose list went to Claude without the path: /fleet status says it takes no part until its next start", LONG, async ($, on) => {
  const { w } = session(on, { watching: 2, debugOpen: null, debugPath: '' })
  otherSweeps(w)
  await startSession($, w)
  await idle(w, 2)
  expect(await fleet($, 'status')).toContain('debug: this session takes no part in a /sessions debug report until its next start')
  await ring($, w, true)
  expect(windowAsks(w)).toBe(0)
})

// ---- The proof of the watch keeps the path: what a later reload finds ----

test('with the watch proved, the path is kept in $.state beside the watch set; a list that went without it keeps none', LONG, async ($, on) => {
  const sets: Record<string, unknown> = {}
  const { w } = session(on, { watching: null, debugOpen: null, sets })
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 1)
  expect(sets).toEqual({ watching: 2, debugPath: DEBUG_PATH })
})

// ---- A session nothing brings a file's change to: said, not counted ----

test('on its timers with no list handed to Claude and no watch of its own: /fleet status says it takes no part while live updates are off', LONG, async ($, on) => {
  const { w } = session(on)
  otherSweeps(w)
  // (no SessionStart reaches fleet, and sessions builds no watcher in this world: timers, for good)
  await startSession($, w)
  await idle(w, 2)
  const status = await fleet($, 'status')
  expect(status).toContain('live updates off')
  expect(status).toContain('debug: this session takes no part in a /sessions debug report while live updates are off')
})

// ---- The window's end ----

test("a window file that says it ends an hour from now isn't believed: the meter counts to sessions' longest window and its grace at most", LONG, async ($, on) => {
  const { w } = session(on)
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 1)
  await ring($, w, true, REPORT, 60 * MIN)
  expect(w.logs.filter(l => l.includes('debug: counting')).at(-1)).toContain(', 630 s at most')
})

test('a window that ran out before its close hands in its own end, not the time of the late close', LONG, async ($, on) => {
  const { w } = session(on)
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 1)
  // It ends 40 ms from now, its grace included (the meter's own clock is the system's)
  await ring($, w, true, REPORT, 40 - 30000)
  const from = w.clock.now()
  await realMs(80)
  await idle(w, 5)
  await ring($, w, false)
  const d = handIns(w)[0].data
  expect(d.from).toBe(from)
  // (40 ms after it opened, by the window's own word; the close came five minutes later)
  expect(d.to - d.from).toBeLessThan(1000)
})

// ---- The ring is the report's own: it isn't the session's work ----

test("a ring of the window isn't a watched path's change like the others: no digest is reckoned again for it, and its own question to sessions isn't counted", LONG, async ($, on) => {
  const { w } = session(on)
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 1)
  await ring($, w, true)
  await ring($, w, false)
  const d = handIns(w)[0].data
  // Nothing happened in this window but its two rings
  expect(d.totals.work.call ?? 0).toBe(0)
  expect(Object.keys(d.actions).filter(k => k.endsWith('.changed') || k.startsWith('bell:'))).toEqual([])
})
