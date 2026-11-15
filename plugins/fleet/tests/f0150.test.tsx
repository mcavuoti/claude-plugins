import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { ACTIONS, HAND_IN_MAX, NAME, refusals } from '../hooks/meter'
import { DEBUG_PATH, FAKE_LOG, FLEET, REF, ROOT, SID, decide, fleet, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'
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

function landByB(w: World, path: string, text: string, n: number) {
  const before = w.files.get(path) ?? ''
  w.touch(path, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${n}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path: path.slice(ROOT.length + 1), from: hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'Owner B' } }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
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
