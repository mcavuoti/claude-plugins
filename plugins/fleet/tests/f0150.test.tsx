import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { ACTIONS, HAND_IN_MAX, NAME, refusals } from '../hooks/meter'
import { BAND, DEBUG_PATH, FAKE_LOG, FLEET, REF, ROOT, SID, decide, fleet, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'
import { PROJECT } from './up.test'

// fleet 0.15.0, the meter: fleet's half of `/sessions debug perf`. sessions measures each session's process and writes
// the report; fleet accounts for its share: its actions (runs, time, work, failures, signals sent), what it holds, and,
// from the session that sweeps, the project's part. It counts nothing until a window opens: the opening ring of
// sessions' debug path turns the meter on from zero, the closing ring hands in once and turns it off.
// Placeholders only: /Users/x/proj, ids aaaaaaaa and bbbbbbbb, made-up names.

declare const console: { log: (...a: unknown[]) => void }
// The test runtime has timers; the plugin's type contract has no DOM or Node library
declare function setTimeout(fn: (...args: unknown[]) => void, ms: number): unknown

const MIN = 60000
const SECOND = 1000
const STATE = `${FLEET}/state`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }
const NOTE = `${ROOT}/notes/a.md`
const LONG = { ...WITH_SESSIONS, timeoutMs: 240000 }
const REPORT = 'r-aaaaaa'

async function tick(w: World, ms = 2100) {
  for (let left = ms; left > 0; left -= MIN) {
    await w.clock.advance(Math.min(left, MIN))
    await w.clock.settle()
  }
}
const realMs = (ms: number) => new Promise<void>(resolve => setTimeout(() => resolve(), ms))

// Another session holds the sweeper's lease (renewed as its fleet would)
function otherSweeps(w: World) {
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner B', at: w.clock.now(), remote: null }))
}

const GIT = (argv: string[]) => (argv[0] === 'git' ? { exitCode: 128, stdout: '', stderr: 'not a git repository' } : undefined)

type Kind = 'person' | 'instance'
type Counts = { state: Map<string, number>; debugOpen: string | null }
function session(on: any, kind: Kind, files: Record<string, string> = {}): { w: World; c: Counts } {
  const w =
    kind === 'instance'
      ? world(on, { worldPaths: ['notes/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' }, files: { ...PROJECT, [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n', [NOTE]: 'a\n', ...files } })
      : world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT, [NOTE]: 'a\n', ...files } })
  const c: Counts = { state: new Map(), debugOpen: null }
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.25 } } }))
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  on('state.get' as any, (_: any, e: any, next: any) => {
    c.state.set('get', (c.state.get('get') ?? 0) + 1)
    // A module loaded by a reload finds what the module before it kept in $.state
    if ((e?.ref?.key ?? e?.key) === 'debugOpen' && c.debugOpen !== null) return { value: { value: c.debugOpen, version: 1 } }
    return next(e)
  })
  on('state.set' as any, (_: any, e: any, next: any) => {
    c.state.set('set', (c.state.get('set') ?? 0) + 1)
    // (until the module writes its own)
    if ((e?.ref?.key ?? e?.key) === 'debugOpen') c.debugOpen = null
    return next(e)
  })
  w.exec.value = GIT
  sessionsSay(w, { current: kind === 'instance' ? CURRENT : undefined, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  return { w, c }
}

async function changed($: any, path: string, event = 'change') {
  await $.classic.FileChanged({ file_path: path, event } as any)
}
// SessionStart hands the list; the engine brings the probe bell back a moment later: live from then on
async function goLive($: any, w: World) {
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  await tick(w, 1500)
  await changed($, `${FLEET}/bell/probe`)
}

// sessions rings its debug path: a window opens, or closes
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
const handIns = (w: World): any[] => logged(w).filter(x => x.debugReport).map(x => x.debugReport)
const windowAsks = (w: World): number => logged(w).filter(x => x.debugWindow).length

// Owner B lands a change to a shared file, as a fleet of this version writes it: the file, its event, and
// events/latest with its chain (stamped a hair before the clock: its event comes after the write, as on a real machine)
const LATEST = `${FLEET}/events/latest`
let eventN = 0
let stampN = 0
function land(w: World, path: string, text: string, via = 'tool'): string {
  const before = w.files.get(path) ?? ''
  w.touch(path, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${++eventN}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path: path.slice(ROOT.length + 1), from: hashText(before), to: hashText(text), via, tool: 'Edit', blind: false, by: { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'Owner B' } }))
  let chain: string[] = []
  try {
    const cur = JSON.parse(w.files.get(LATEST) ?? '{}')
    chain = Array.isArray(cur.chain) ? cur.chain : cur.last ? [cur.last] : []
  } catch {}
  w.touch(LATEST, JSON.stringify({ format: 1, last: name, chain: [...chain, name].slice(-32) }), w.clock.now() - 1 + (++stampN % 900) / 1000)
  return name
}

// What the test world itself saw fleet ask of the engine (the stand-in for sessions keeps its own files under /fake)
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)
type Seen = { read: number; absent: number; stat: number; exists: number; list: number; write: number; run: Record<string, number>; state: number; timers: number }
function seen(w: World, c: Counts): Seen {
  const out: Seen = { read: 0, absent: 0, stat: 0, exists: 0, list: 0, write: 0, run: {}, state: sum(c.state), timers: sum(w.timerCount) }
  for (const [k, n] of w.ops) {
    if (k.includes(' /fake/')) continue
    const kind = k.slice(0, k.indexOf(' '))
    if (kind === 'run') out.run[k.slice(4)] = (out.run[k.slice(4)] ?? 0) + n
    else if (kind === 'read' || kind === 'absent' || kind === 'stat' || kind === 'exists' || kind === 'list' || kind === 'write') out[kind] += n
  }
  return out
}
function between(a: Seen, b: Seen) {
  const run: Record<string, number> = {}
  for (const k of Object.keys(b.run)) if ((b.run[k] ?? 0) - (a.run[k] ?? 0)) run[k] = (b.run[k] ?? 0) - (a.run[k] ?? 0)
  return { read: b.read - a.read, absent: b.absent - a.absent, stat: b.stat - a.stat, exists: b.exists - a.exists, list: b.list - a.list, write: b.write - a.write, run, state: b.state - a.state, timers: b.timers - a.timers }
}
const host = (d: ReturnType<typeof between>) => d.read + d.stat + d.exists + d.list + d.write + Object.values(d.run).reduce((x, y) => x + y, 0) + d.state
/** An idle stretch: the lease renewed by another session, or held by this one */
async function idle(w: World, minutes: number, sweeps: 'other' | 'me') {
  for (let i = 0; i < minutes * 3; i++) {
    if (sweeps === 'other') otherSweeps(w)
    await tick(w, 20 * SECOND)
  }
}
const started = (d: any) => Object.entries(d as Record<string, number>).reduce((m, [k, n]) => ({ ...m, [k.split(':')[0] as string]: (m[k.split(':')[0] as string] ?? 0) + n }), {} as Record<string, number>)

// ---- The guard: nothing unless a window is open ----

// The same idle hour on main's code (e7f6058, sessions 0.20.2 / fleet 0.14.3), by this harness: host calls and timer
// callbacks. With no window fleet does exactly that, and no call more
const MAIN_IDLE_HOUR = { person: { host: 1627, timers: 240 }, instance: { host: 6451, timers: 480 }, sweeper: { host: 9721, timers: 780 } }

for (const who of ['person', 'instance', 'sweeper'] as const) {
  test(`no window, an idle hour of ${who === 'sweeper' ? 'the sweeping session' : who === 'person' ? "a person's session" : 'an instance'}: the host calls and timers main makes, and nothing of the meter`, LONG, async ($, on) => {
    const { w, c } = session(on, who === 'instance' ? 'instance' : 'person')
    if (who !== 'sweeper') otherSweeps(w)
    await startSession($, w)
    await goLive($, w)
    await idle(w, 3, who === 'sweeper' ? 'me' : 'other')
    const a = seen(w, c)
    await idle(w, 60, who === 'sweeper' ? 'me' : 'other')
    const d = between(a, seen(w, c))
    console.log(`F0150 idle hour ${who} ${JSON.stringify({ host: host(d), timers: d.timers })}`)
    expect({ host: host(d), timers: d.timers }).toEqual(MAIN_IDLE_HOUR[who])
    // Nobody asked what the window is, and nothing was handed in
    expect(windowAsks(w)).toBe(0)
    expect(handIns(w)).toEqual([])
  })
}

// ---- A window: open, counted, closed, handed in once ----

test('a window opens and closes: one hand-in, in the shape sessions takes; a second close hands in nothing more', LONG, async ($, on) => {
  const { w } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 2, 'other')
  expect(windowAsks(w)).toBe(0)
  await ring($, w, true)
  expect(windowAsks(w)).toBe(1)
  expect(handIns(w)).toEqual([])
  land(w, NOTE, 'b\n')
  await changed($, LATEST)
  await idle(w, 3, 'other')
  // Nothing is handed in while the window is open: one call, at the close
  expect(handIns(w)).toEqual([])
  await ring($, w, false)
  const h = handIns(w)
  expect(h.length).toBe(1)
  expect(h[0].source).toBe('fleet')
  expect(h[0].report).toBe(REPORT)
  const d = h[0].data
  expect(d.format).toBe(1)
  expect(d.partial).toBe(undefined)
  expect(d.to - d.from).toBe(3 * MIN)
  expect(refusals(d)).toEqual([])
  expect(d.facts).toMatchObject({ kind: 'instance', sweeps: false, live: 'claude', pace: 'quiet', wakes: 'open', world: 'on', turn: false, role: { label: 'role', key: 'owner' } })
  // The actions of an idle instance, each under its declared name, with what makes it run and what it grows with
  for (const name of ['latest.changed', 'landing.chain', 'instance.tick', 'heartbeat', 'world.tick', 'lease', 'deliver', 'beat', 'needs', 'nudge.pass:minute']) expect(Object.keys(d.actions)).toContain(name)
  for (const [name, a] of Object.entries(d.actions as Record<string, any>)) {
    expect(Object.keys(ACTIONS)).toContain(name)
    expect(a.drivers).toEqual((ACTIONS as any)[name].drivers)
    expect(a.grows).toEqual((ACTIONS as any)[name].grows)
    expect(a.runs).toBeGreaterThan(0)
  }
  expect(d.actions['instance.tick'].runs).toBe(6)
  expect(d.actions['nudge.pass:minute'].runs).toBe(3)
  expect(d.actions.heartbeat.started).toEqual({ 'mv:heartbeat': 3 })
  expect(d.actions.heartbeat.bytesWritten).toBeGreaterThan(0)
  expect(d.actions['landing.chain'].work.read).toBeGreaterThan(0)
  // The same ring again (the file rewritten as it was), and a close with no window: nothing more
  await ring($, w, false)
  await idle(w, 1, 'other')
  expect(handIns(w).length).toBe(1)
})

test('no window was opened: a close hands in nothing, and nothing is counted afterwards', LONG, async ($, on) => {
  const { w } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await ring($, w, false)
  await idle(w, 2, 'other')
  expect(handIns(w)).toEqual([])
  // An empty file, or one sessions doesn't call a window: asked once each, nothing done
  w.touch(DEBUG_PATH, '')
  await changed($, DEBUG_PATH)
  await w.clock.settle()
  w.touch(DEBUG_PATH, JSON.stringify({ report: 'r-bbbbbb', profile: 'hang', open: true, until: w.clock.now() + MIN }))
  await changed($, DEBUG_PATH)
  await w.clock.settle()
  await idle(w, 1, 'other')
  await ring($, w, false, 'r-bbbbbb')
  expect(handIns(w)).toEqual([])
})

// ---- The counters are what the engine was asked ----

test('in a window, the totals are what the test world itself saw fleet ask of the engine: reads, failed reads, stats, listings, writes, commands by program, $.state', LONG, async ($, on) => {
  const { w, c } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 2, 'other')
  await ring($, w, true)
  const a = seen(w, c)
  const gets = c.state.get('get') ?? 0
  for (let i = 0; i < 6; i++) {
    land(w, NOTE, `b${i}\n`)
    await changed($, LATEST)
    await idle(w, 1, 'other')
  }
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: NOTE } as any)
  await $.tool.call({ tool: 'Write', file_path: NOTE, content: 'mine\n' } as any)
  await $.turn.complete({ turnId: 't1', answer: 'done', reason: 'answer' } as any)
  await idle(w, 2, 'other')
  const b = seen(w, c)
  const getsAfter = c.state.get('get') ?? 0
  await ring($, w, false)
  const d = handIns(w)[0].data
  const saw = between(a, b)
  const t = d.totals
  expect(refusals(d)).toEqual([])
  expect({ read: t.work.read, stat: t.work.stat, exists: t.work.exists ?? 0, list: t.work.list, write: t.work.write, command: t.work.command }).toEqual({ read: saw.read, stat: saw.stat, exists: saw.exists, list: saw.list, write: saw.write, command: Object.values(saw.run).reduce((x, y) => x + y, 0) })
  // A file that isn't there is a failed read
  expect(t.failed.read ?? 0).toBe(saw.absent)
  // Processes by program (what each is for is beside it: mv:heartbeat, mv:events…)
  expect(started(t.started)).toEqual(saw.run)
  // $.state: every read and every write is one get at the engine (a write that changes the value is a set too)
  expect(t.work.state).toBe(getsAfter - gets)
  // Bytes, where the text was in hand
  expect(t.bytesRead).toBeGreaterThan(0)
  expect(t.bytesWritten).toBeGreaterThan(0)
  // Its own landing is a signal sent, as the write that others watch
  expect(t.sent.landing).toBeGreaterThan(0)
  // The work of the actions is within the totals (what ran outside any action is in the totals alone)
  const inActions = (kind: string) => Object.values(d.actions as Record<string, any>).reduce((n, x) => n + (x.work[kind] ?? 0), 0)
  for (const kind of ['read', 'stat', 'list', 'write', 'command', 'state']) expect(inActions(kind)).toBeLessThanOrEqual(t.work[kind])
  expect(inActions('read')).toBeGreaterThan(t.work.read * 0.9)
})

test('one action run alone: /fleet status is one run of command:status, and its work is what the engine was asked meanwhile', LONG, async ($, on) => {
  const { w, c } = session(on, 'person')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 2, 'other')
  await ring($, w, true)
  const a = seen(w, c)
  await fleet($, 'status')
  const b = seen(w, c)
  await ring($, w, false)
  const d = handIns(w)[0].data
  const saw = between(a, b)
  const x = d.actions['command:status']
  expect(x.runs).toBe(1)
  // (with what it runs inside itself: its look at the landings is an action of its own)
  const all = (kind: string) => Object.values(d.actions as Record<string, any>).reduce((n, y) => n + (y.work[kind] ?? 0), 0)
  expect(Object.keys(d.actions)).toContain('command:status')
  expect({ read: all('read'), stat: all('stat'), list: all('list'), exists: all('exists') }).toEqual({ read: saw.read, stat: saw.stat, list: saw.list, exists: saw.exists })
  expect(Object.values(d.actions as Record<string, any>).reduce((n, y) => n + (y.failed.read ?? 0), 0)).toBe(saw.absent)
  expect(x.work.read).toBeGreaterThan(20)
  // The most work of one run: its counted calls (entries listed and tokens aren't calls)
  expect(x.mostWork).toBe(Object.entries(x.work as Record<string, number>).reduce((n, [k, v]) => n + (k === 'listed' || k === 'tokens' ? 0 : v), 0))
})

test('a timer counts as a run when it fires, even when it then finds nothing to do', LONG, async ($, on) => {
  // Live and quiet: the world's timer fires every 30 s and looks at the world every other time
  const { w } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 2, 'other')
  await ring($, w, true)
  await idle(w, 5, 'other')
  await ring($, w, false)
  const d = handIns(w)[0].data
  expect(d.actions['world.tick'].runs).toBe(10)
  expect(d.actions.lease.runs).toBe(10)
})

test('not live: the 2 s timers are counted at every tick', LONG, async ($, on) => {
  const { w } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  // (no proof of Claude's watch: on its timers; the ring is given by hand, as fleet's own watch would bring it)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  await idle(w, 2, 'other')
  await ring($, w, true)
  await idle(w, 2, 'other')
  await ring($, w, false)
  const d = handIns(w)[0].data
  expect(d.facts.live).toBe('timers')
  expect(d.actions['world.tick'].runs).toBeGreaterThanOrEqual(58)
  expect(d.actions.deliver.runs).toBeGreaterThanOrEqual(58)
})

// ---- The window's life ----

test('a window whose close never came ends by itself: the first count past its end stops the counting, with no call; a late close hands in what was counted', LONG, async ($, on) => {
  const { w } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 2, 'other')
  // 40 ms of window (the meter's own clock is the system's)
  await ring($, w, true, REPORT, 40)
  await idle(w, 1, 'other')
  await realMs(80)
  const asks = windowAsks(w)
  await idle(w, 5, 'other')
  // Nothing was asked of sessions and nothing handed in: it just stopped
  expect(windowAsks(w)).toBe(asks)
  expect(handIns(w)).toEqual([])
  await ring($, w, false)
  const h = handIns(w)
  expect(h.length).toBe(1)
  // One minute's worth, not six: the five idle minutes after its end weren't counted
  expect(h[0].data.actions['instance.tick'].runs).toBeLessThanOrEqual(3)
})

test('a module that came in by a reload inside a window hands in as partial', LONG, async ($, on) => {
  const { w, c } = session(on, 'instance')
  otherSweeps(w)
  // The window is open before this module starts: it never looks at the path
  w.touch(DEBUG_PATH, JSON.stringify({ report: REPORT, profile: 'perf', open: true, until: w.clock.now() + 10 * MIN }))
  await startSession($, w)
  await goLive($, w)
  await idle(w, 2, 'other')
  expect(windowAsks(w)).toBe(0)
  // (a reload: the module before it had opened for this report, as $.state says)
  c.debugOpen = REPORT
  await ring($, w, false)
  const h = handIns(w)
  expect(h.length).toBe(1)
  expect(h[0].data.partial).toBe('reloaded')
  expect(h[0].data.actions).toEqual({})
  expect(refusals(h[0].data)).toEqual([])
})

test('a session that starts while a window is open stays off: nothing asked at its start, nothing handed in at the close', LONG, async ($, on) => {
  const { w } = session(on, 'instance')
  otherSweeps(w)
  w.touch(DEBUG_PATH, JSON.stringify({ report: REPORT, profile: 'perf', open: true, until: w.clock.now() + 10 * MIN }))
  await startSession($, w)
  await goLive($, w)
  await idle(w, 3, 'other')
  expect(windowAsks(w)).toBe(0)
  await ring($, w, false)
  expect(windowAsks(w)).toBe(1)
  expect(handIns(w)).toEqual([])
})

test("sessions didn't give its debug path in time: the session takes no part until its next start, and /fleet status says so", LONG, async ($, on) => {
  const { w } = session(on, 'instance')
  otherSweeps(w)
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') }, noDebug: true })
  await startSession($, w)
  const r: any = await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  expect((r.watchPaths ?? []).includes(DEBUG_PATH)).toBe(false)
  await tick(w, 1500)
  await changed($, `${FLEET}/bell/probe`)
  expect(await fleet($, 'status')).toContain('debug: this session takes no part in a /sessions debug report until its next start')
  // Its next start, with sessions answering: watched again, and the line is gone
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  const again: any = await $.classic.SessionStart({ source: 'clear', agent_type: 'owner' } as any)
  expect(again.watchPaths).toContain(DEBUG_PATH)
  expect(await fleet($, 'status')).not.toContain('takes no part')
})

// ---- What leaves: numbers and declared words only ----

test('a hand-in carries no name, path or text: every key and word is of the pattern, whatever the instances, roles, files and questions are called', LONG, async ($, on) => {
  const SECRET = `${ROOT}/notes/merger-with-initech.md`
  const { w } = session(on, 'instance', { [SECRET]: 'the plan\n' })
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 2, 'other')
  await ring($, w, true)
  await $.turn.start({ text: 'please read the merger plan', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: SECRET } as any)
  await $.tool.call({ tool: 'Write', file_path: SECRET, content: 'the new plan\n' } as any)
  await decide($, { questions: [{ question: 'Do we tell Initech on Monday?', header: 'Initech', options: [{ label: 'Yes', description: 'tell them' }, { label: 'No', description: 'wait' }], multiSelect: false }] } as any).catch(() => {})
  await $.turn.complete({ turnId: 't1', answer: 'done', reason: 'answer' } as any)
  land(w, SECRET, 'theirs\n')
  await changed($, LATEST)
  await idle(w, 2, 'other')
  await ring($, w, false)
  const d = handIns(w)[0].data
  expect(refusals(d)).toEqual([])
  const text = JSON.stringify(d)
  for (const word of ['Owner A', 'Owner B', 'merger', 'initech', 'Initech', 'Monday', ROOT, '/Users/', 'notes/', SID, REF, 'bbbbbbbb', 'the plan']) expect(text.includes(word)).toBe(false)
  // The one thing that names anything is a label, which sessions maps to R1… and keeps out of the file
  expect(d.facts.role).toEqual({ label: 'role', key: 'owner' })
  expect(text.split('"owner"').length).toBe(2)
})

test('the declared table itself: every action, word and part is of the pattern, and a part names an action', async () => {
  for (const [name, a] of Object.entries(ACTIONS as Record<string, any>)) {
    expect(NAME.test(name)).toBe(true)
    for (const g of a.grows) expect(NAME.test(g)).toBe(true)
    for (const dr of a.drivers) expect(['clock', 'self', 'person', 'peer']).toContain(dr)
    if (a.within) expect(Object.keys(ACTIONS)).toContain(a.within)
  }
  expect(refusals({ a: 'Not A Word' })).toEqual(['data.a: the word "Not A Word"'])
  expect(refusals({ 'a key': 1 })).toEqual(['data: the key "a key"'])
  expect(refusals({ a: { label: 'person', key: 'x' } })).toEqual(['data.a: the label "person"'])
})

// ---- Holdings, and the project's part ----

test('holdings are noted at the open and read again at the close: a count and a rough size each, what grew in the window shows', LONG, async ($, on) => {
  const { w } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 2, 'other')
  await ring($, w, true)
  for (let i = 0; i < 5; i++) {
    land(w, `${ROOT}/notes/n${i}.md`, `n${i}\n`)
    await changed($, LATEST)
    await idle(w, 1, 'other')
  }
  await ring($, w, false)
  const d = handIns(w)[0].data
  for (const name of ['latest', 'seen', 'known', 'revs', 'queue', 'register', 'intake', 'board', 'proofs', 'folders', 'told', 'calls', 'reads', 'timers']) {
    expect(Object.keys(d.holdings)).toContain(name)
    expect(d.holdings[name].open.length).toBe(2)
    expect(d.holdings[name].close.length).toBe(2)
  }
  expect(d.holdings.seen.close[0] - d.holdings.seen.open[0]).toBe(5)
  expect(d.holdings.latest.close[0] - d.holdings.latest.open[0]).toBe(5)
  expect(d.holdings.seen.close[1]).toBeGreaterThan(d.holdings.seen.open[1])
  expect(d.holdings.seen.grows).toEqual(['landings'])
  // An instance that doesn't sweep hands in no project part
  expect(d.project).toBe(undefined)
})

test("the project's part comes from the session that sweeps: the roster by state, the landings by how they came, who waits, the disk", LONG, async ($, on) => {
  const { w } = session(on, 'person')
  await startSession($, w)
  await goLive($, w)
  await idle(w, 3, 'me')
  await ring($, w, true)
  land(w, NOTE, 'b\n')
  await changed($, LATEST)
  await idle(w, 1, 'me')
  land(w, NOTE, 'c\n', 'bash')
  await changed($, LATEST)
  await idle(w, 2, 'me')
  await ring($, w, false)
  const d = handIns(w)[0].data
  expect(d.facts).toMatchObject({ kind: 'person', sweeps: true, pace: 'sweeper' })
  expect(refusals(d)).toEqual([])
  expect(Object.keys(d.project).sort()).toEqual(['disk', 'health', 'landings', 'roster', 'waiting', 'wakes'])
  expect(d.project.landings).toEqual({ tool: 1, command: 1 })
  expect(d.project.roster.instances).toBe(3)
  expect(d.project.waiting.questions).toBe(0)
  expect(d.project.health.sweeper).toBe('here')
  expect(d.project.disk['events.hour']).toBeGreaterThan(0)
  expect(d.project.disk['world.files']).toBeGreaterThan(0)
  // The sweep and its parts: the parts name the whole they're within
  expect(d.actions.sweep.runs).toBeGreaterThan(0)
  expect(d.actions.sweep.within).toBe(undefined)
  for (const [name, a] of Object.entries(d.actions as Record<string, any>)) if (name.startsWith('sweep.')) expect(a.within).toBe('sweep')
  expect(Object.keys(d.actions)).toContain('sweep.roster')
  expect(Object.keys(d.actions)).toContain('outside.scan')
})

test('with nobody sweeping, a session that finds no lease hands in the project part; with another sweeping, it does not', LONG, async ($, on) => {
  const { w } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 2, 'other')
  await ring($, w, true)
  await idle(w, 1, 'other')
  await ring($, w, false)
  expect(handIns(w)[0].data.project).toBe(undefined)
  // The other's lease 10 minutes old, and this session hasn't looked at it yet
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner B', at: w.clock.now() - 10 * MIN, remote: null }))
  await ring($, w, true, 'r-cccccc')
  await ring($, w, false, 'r-cccccc')
  const d = handIns(w)[1].data
  expect(d.project.health.sweeper).toBe('none')
  expect(refusals(d)).toEqual([])
})

test('a hand-in for a roster of 40 instances is far under what sessions takes', LONG, async ($, on) => {
  const roster = JSON.parse(PROJECT[`${FLEET}/roster.json`] as string)
  const one = roster.instances[0]
  roster.instances = Array.from({ length: 40 }, (_, i) => ({ ...one, name: `Owner ${i + 1}` }))
  const { w } = session(on, 'person', { [`${FLEET}/roster.json`]: JSON.stringify(roster) })
  await startSession($, w)
  await goLive($, w)
  await idle(w, 3, 'me')
  await ring($, w, true)
  await fleet($, 'status')
  await idle(w, 3, 'me')
  await ring($, w, false)
  const d = handIns(w)[0].data
  expect(d.project.roster.instances).toBe(40)
  expect(JSON.stringify(d).length).toBeLessThan(HAND_IN_MAX / 4)
})

test('sessions refuses a hand-in: said in the log, and the meter is off all the same', LONG, async ($, on) => {
  const { w } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') }, refuseDebug: 'closed' })
  await ring($, w, true)
  await idle(w, 1, 'other')
  await ring($, w, false)
  expect(handIns(w)).toEqual([])
  expect(w.logs.join('\n')).toContain("debug: the hand-in for report r-aaaaaa wasn't taken (refused: closed)")
  // A new window counts from zero
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  await ring($, w, true, 'r-dddddd')
  await idle(w, 1, 'other')
  await ring($, w, false, 'r-dddddd')
  expect(handIns(w)[0].data.actions['instance.tick'].runs).toBe(2)
})

// ---- Every kind of action is reachable under its declared name ----

test('a working instance in a window: each thing it does is counted under its declared action', LONG, async ($, on) => {
  const names = new Set<string>()
  const { w } = session(on, 'instance')
  otherSweeps(w)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', exitCode: 0 } }) as any)
  await startSession($, w)
  await goLive($, w)
  await idle(w, 2, 'other')
  await ring($, w, true)
  await $.prompt.submit({ text: 'work on it', origin: { kind: 'composer' } } as any).catch(() => {})
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.tool.check({ tool: 'Read', input: { file_path: NOTE }, tool_use_id: 'u1' } as any).catch(() => {})
  await $.tool.call({ tool: 'Read', file_path: NOTE } as any)
  await $.tool.call({ tool: 'Write', file_path: NOTE, content: 'mine\n' } as any)
  await $.tool.call({ tool: 'Bash', command: 'ls notes' } as any).catch(() => {})
  await decide($, { questions: [{ question: 'Go?', header: 'Go', options: [{ label: 'Yes', description: 'go' }, { label: 'No', description: 'wait' }], multiSelect: false }] } as any).catch(() => {})
  await $.turn.complete({ turnId: 't1', answer: 'done', reason: 'answer' } as any)
  land(w, NOTE, 'theirs\n')
  await changed($, LATEST)
  w.touch(`${FLEET}/bell/work`, '{}')
  await changed($, `${FLEET}/bell/work`)
  await changed($, `${FLEET}/decisions/queue/D-9.json`)
  await changed($, `${FLEET}/decisions/answers/D-9.1.json`)
  for (const kind of ['runs', 'restart', 'budget', 'probe']) await changed($, `${FLEET}/bell/${kind}`)
  await changed($, `${FLEET}/decisions/overrules/D-9.overrule.json`)
  await changed($, `${FLEET}/inbox/latest`)
  await $.classic.PostToolUse({ tool_name: 'Read' } as any).catch(() => {})
  await $.ui.render(BAND as any).catch(() => {})
  await fleet($, 'status')
  await fleet($, '')
  await fleet($, 'help')
  await idle(w, 3, 'other')
  await ring($, w, false)
  for (const n of Object.keys(handIns(w)[0].data.actions)) names.add(n)
  const want = [
    // what another session did
    'latest.changed', 'landing.chain', 'landing.pull', 'queue.changed', 'answers.changed', 'overrules.changed', 'inbox.changed', 'bell:work', 'bell:runs', 'bell:restart', 'bell:budget', 'bell:probe',
    // its timers
    'deliver', 'beat', 'world.tick', 'lease', 'needs', 'instance.tick', 'heartbeat', 'nudge.pass:minute',
    // its own turn and tools
    'prompt.typed', 'prompt.submit', 'turn.start', 'turn.end', 'gate', 'read.note', 'write.land', 'bash.scan', 'outbound.check', 'tool.settle', 'tool.fleet', 'tool.decide', 'reads.save', 'classic.hook', 'nudge.pass:landing',
    // the person
    'command:list', 'command:status', 'command:other', 'band.draw', 'debug.changed',
  ]
  for (const name of want) expect([...names]).toContain(name)
  // And nothing it reports is outside the declared table
  for (const name of names) expect(Object.keys(ACTIONS)).toContain(name)
})
