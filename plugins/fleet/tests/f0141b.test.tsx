import { expect, test } from 'claude-code/testing'

import { FLEET, REF, ROOT, SID, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'
import { PROJECT } from './up.test'

const MIN = 60000
const STATE = `${FLEET}/state`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }

async function tick(w: World, ms = 2100) {
  for (let left = ms; left > 0; left -= MIN) {
    await w.clock.advance(Math.min(left, MIN))
    await w.clock.settle()
  }
}

// Another session holds the sweeper's lease (renewed as its fleet would)
function otherSweeps(w: World) {
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner B', at: w.clock.now(), remote: null }))
}

const GIT = (argv: string[]) => (argv[0] === 'git' ? { exitCode: 128, stdout: '', stderr: 'not a git repository' } : undefined)

type Kind = 'person' | 'instance'
async function session($: any, on: any, kind: Kind, state: Map<string, number>) {
  const w =
    kind === 'instance'
      ? world(on, { worldPaths: ['notes/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' }, files: { ...PROJECT, [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n', [`${ROOT}/notes/a.md`]: 'a\n' } })
      : world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT, [`${ROOT}/notes/a.md`]: 'a\n' } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.25 } } }))
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  for (const ev of ['state.get', 'state.set']) {
    on(ev as any, (_: any, e: any, next: any) => {
      state.set(ev, (state.get(ev) ?? 0) + 1)
      return next(e)
    })
  }
  w.exec.value = GIT
  sessionsSay(w, { current: kind === 'instance' ? CURRENT : undefined, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  return w
}

async function goLive($: any, w: World) {
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  await tick(w, 1500)
  await $.classic.FileChanged({ file_path: `${FLEET}/bell/probe`, event: 'change' } as any)
  await w.clock.settle()
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)
type Snap = { timers: number; host: number; by: Record<string, number> }
function snap(w: World, state: Map<string, number>): Snap {
  return { timers: sum(w.timerCount), host: sum(w.readCount) + sum(w.statCount) + w.lists.length + w.runs.length + sum(state), by: Object.fromEntries(w.timerCount) }
}
/** An idle stretch of `minutes`, the lease renewed by another session (or held by this one): per minute */
async function idle(w: World, state: Map<string, number>, minutes: number, sweeps: 'other' | 'me') {
  const a = snap(w, state)
  for (let i = 0; i < minutes * 3; i++) {
    if (sweeps === 'other') otherSweeps(w)
    await tick(w, 20000)
  }
  const b = snap(w, state)
  const by: Record<string, number> = {}
  for (const k of Object.keys(b.by)) by[k] = Math.round(((b.by[k] ?? 0) - (a.by[k] ?? 0)) / minutes)
  return { timers: (b.timers - a.timers) / minutes, host: (b.host - a.host) / minutes, by }
}

for (const kind of ['person', 'instance'] as const) {
  test(`baseline numbers: ${kind}`, WITH_SESSIONS, async ($, on) => {
    const state = new Map<string, number>()
    const w = await session($, on, kind, state)
    otherSweeps(w)
    await startSession($, w)
    await goLive($, w)
    await idle(w, state, 3, 'other')
    const live = await idle(w, state, 10, 'other')
    console.log(kind, 'live, not sweeping', JSON.stringify(live))
    expect(live.timers).toBeGreaterThan(0)
  })
}

test('baseline numbers: not live', WITH_SESSIONS, async ($, on) => {
  const state = new Map<string, number>()
  const w = await session($, on, 'person', state)
  otherSweeps(w)
  await startSession($, w)
  await idle(w, state, 3, 'other')
  const off = await idle(w, state, 10, 'other')
  console.log('person not live', JSON.stringify(off))
  expect(off.timers).toBeGreaterThan(0)
})

test('baseline numbers: sweeper', WITH_SESSIONS, async ($, on) => {
  const state = new Map<string, number>()
  const w = await session($, on, 'person', state)
  await startSession($, w)
  await goLive($, w)
  await idle(w, state, 3, 'me')
  const sw = await idle(w, state, 10, 'me')
  console.log('person sweeping live', JSON.stringify(sw))
  expect(sw.timers).toBeGreaterThan(0)
})
