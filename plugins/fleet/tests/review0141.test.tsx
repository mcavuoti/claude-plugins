import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// The test runtime has timers; the plugin's type contract has no DOM or Node library
declare function setTimeout(fn: (...args: unknown[]) => void, ms: number): unknown

// Proofs for the review of fleet 0.14.1: each failed on the branch before its fix.
// Placeholders only: /Users/x/proj, ids aaaaaaaa and bbbbbbbb, made-up names.

const MIN = 60000
const SECOND = 1000
const STATE = `${FLEET}/state`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, mcp__fleet__*\n---\nYou own a part of the notes.\n'
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }
const HB = `${FLEET}/instances/owner-a`
const READS = `${FLEET}/reads/${SID}.json`

function roster(role: Record<string, unknown> = {}) {
  return JSON.stringify({
    rosterFormat: 1,
    sections: [{ id: 'owners', title: 'Owners' }],
    roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 }, ...role } },
    instances: [
      { name: 'Owner A', role: 'owner', section: 'owners' },
      { name: 'Owner B', role: 'owner', section: 'owners' },
    ],
    wakes: { everyMin: 5, perDay: 8 },
    budget: { usdDay: 50 },
  })
}
function otherSweeps(w: World) {
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner B', at: w.clock.now(), remote: null }))
}
async function run(w: World, ms: number) {
  for (let left = ms; left > 0; left -= SECOND) {
    await w.clock.advance(Math.min(left, SECOND))
    await w.clock.settle()
    if (w.clock.now() % 20000 < SECOND) otherSweeps(w)
  }
}

/** Owner A, an instance of the roster, its watch proven (live) unless live is false; Owner B sweeps */
async function instance($: any, on: any, opts: { live?: boolean; role?: Record<string, unknown>; wrap?: (on: any) => any } = {}) {
  const w = world(opts.wrap ? opts.wrap(on) : on, {
    worldPaths: ['notes/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: {
      [`${FLEET}/roster.json`]: roster(opts.role),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/seeds/owner.md`]: 'Plan your part.',
      [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n',
      [`${HB}/seed-${REF}.json`]: JSON.stringify({ format: 1, ref: REF, at: 1 }),
      [`${ROOT}/notes/a.md`]: 'a\n',
    },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  w.exec.value = argv => (argv[0] === 'git' ? { exitCode: 128, stdout: '', stderr: 'not a git repository' } : undefined)
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  otherSweeps(w)
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  await w.clock.settle()
  if (opts.live !== false) {
    await run(w, 1100)
    await $.classic.FileChanged({ file_path: `${FLEET}/bell/probe`, event: 'change' } as any)
    await w.clock.settle()
  }
  await run(w, MIN)
  return w
}

// ---- F1: a read-modify-write through the remembered-missing memory drops another session's first write ----

async function downAfterPeer($: any, on: any, live: boolean, rung = false): Promise<Record<string, number>> {
  const w = await instance($, on, { live })
  // Idle a while: its nudges' pass looked for down.json (not there yet) and, live, remembers it missing
  await run(w, 3 * MIN)
  // The person takes Owner B down from another session: down.json, then the budget bell, whose ring this session's
  // watcher hasn't brought yet (Claude's ~0.6 s; or never, a ring lost)
  w.touch(`${STATE}/down.json`, JSON.stringify({ format: 1, instances: { 'owner-b': w.clock.now() } }))
  if (rung) {
    w.touch(`${FLEET}/bell/budget`, JSON.stringify({ format: 1, by: 'bbbbbbbb', at: w.clock.now() }))
    await $.classic.FileChanged({ file_path: `${FLEET}/bell/budget`, event: 'change' } as any)
  }
  await run(w, 5 * SECOND)
  // ... and, in this session, Owner A
  await fleet($, 'down "Owner A"')
  return json(w, `${STATE}/down.json`).instances
}

test('F1 control: not live (nothing remembered), /fleet down keeps what another session took down', WITH_SESSIONS, async ($, on) => {
  expect(Object.keys(await downAfterPeer($, on, false)).sort()).toEqual(['owner-a', 'owner-b'])
})

test('F1 control: live, the peer\'s bell brought before the command: both stay down', WITH_SESSIONS, async ($, on) => {
  expect(Object.keys(await downAfterPeer($, on, true, true)).sort()).toEqual(['owner-a', 'owner-b'])
})

test('F1 live: /fleet down within the remembered window writes over the other session\'s first down.json', WITH_SESSIONS, async ($, on) => {
  // Expected ['owner-a', 'owner-b']; the branch writes ['owner-a'] (owner-b is up again)
  expect(Object.keys(await downAfterPeer($, on, true)).sort()).toEqual(['owner-a', 'owner-b'])
})

// ---- F2: wrote() moves the epoch before the write lands, so a read that starts after it remembers the session's own
// file missing (10 min for poll.json): a duplicate routine poll ----

// The world's own handlers, wrapped (as world.tsx wraps the clock's): the mv that puts poll.json in place waits until a
// heartbeat has looked for the file (its read, then its exists), as when the two overlap in a real session
const POLL = `${HB}/poll.json`
const racer = { armed: false, looked: null as null | (() => void), kick: null as null | (() => void), held: 0 }
function wrapRacer(on: any) {
  return (event: string, ...rest: any[]) => {
    const hook = rest[rest.length - 1]
    if (event === 'fs.exists')
      rest[rest.length - 1] = (x: any, e: any, next: any) => {
        const r = hook(x, e, next)
        if (e.path === POLL && racer.looked) {
          const l = racer.looked
          racer.looked = null
          setTimeout(l, 20)
        }
        return r
      }
    if (event === 'process.run')
      rest[rest.length - 1] = async (x: any, e: any, next: any) => {
        const argv: string[] = [...e.argv]
        if (racer.armed && argv[0] === 'mv' && argv[argv.length - 1] === POLL) {
          racer.armed = false
          racer.held++
          const seen = new Promise<void>(resolve => (racer.looked = resolve))
          racer.kick?.()
          await Promise.race([seen, new Promise(resolve => setTimeout(resolve, 3000))])
        }
        return hook(x, e, next)
      }
    return on(event, ...rest)
  }
}
const WITH_RACER = { ...WITH_SESSIONS, timeoutMs: 60000 }

test('F2: a heartbeat that reads poll.json while its own replace is in flight remembers it missing for 10 min, and the poll goes again at once', WITH_RACER, async ($, on) => {
  const w = await instance($, on, { role: { poll: { everyMin: 20, prompt: 'Check the inbox.' } }, wrap: wrapRacer })
  const polls = () => w.submits.filter(s => s.startsWith('fleet: your routine poll')).length
  // A permission prompt puts a heartbeat on its way (as the 30 s heartbeat may be at any moment)
  racer.kick = () => void $.classic.PermissionRequest({ tool_name: 'Bash' } as any)
  racer.armed = true
  // Its first poll, 20 min after its fleet started (in steps of a second, to stop right after it)
  for (let i = 0; i < 22 * 60 && polls() === 0; i++) await run(w, SECOND)
  await run(w, 2 * SECOND)
  expect(polls()).toBe(1)
  expect(racer.held).toBe(1)
  expect(json(w, POLL)).toMatchObject({ format: 1 })
  // The file is there from now on: count fleet's reads of it
  const reads0 = w.ops.get(`read ${POLL}`) ?? 0
  // The next is due 20 min after that one: none in the next 5 min (the branch sends it again at its next pass, without
  // reading the poll.json that's there)
  const from = w.clock.now()
  for (let i = 0; i < 5 * 60 && polls() === 1; i++) await run(w, SECOND)
  const reads1 = w.ops.get(`read ${POLL}`) ?? 0
  expect({ polls: polls(), secondsToTheNext: Math.round((w.clock.now() - from) / SECOND), readsOfPollJsonBeforeIt: reads1 - reads0 }).toEqual({ polls: 1, secondsToTheNext: 300, readsOfPollJsonBeforeIt: expect.any(Number) })
})

test('F2b: a slow mv meets the ordinary 30 s heartbeat by itself (no kick): the same duplicate poll', WITH_RACER, async ($, on) => {
  racer.armed = true
  racer.held = 0
  racer.kick = null
  const w = await instance($, on, { role: { poll: { everyMin: 20, prompt: 'Check the inbox.' } }, wrap: wrapRacer })
  const polls = () => w.submits.filter(s => s.startsWith('fleet: your routine poll')).length
  for (let i = 0; i < 22 && polls() === 0; i++) await run(w, MIN)
  expect(polls()).toBe(1)
  expect(racer.held).toBe(1)
  await run(w, 5 * MIN)
  expect(polls()).toBe(1)
})

test('F2 control: the same poll, nothing held: once in those 5 min', WITH_RACER, async ($, on) => {
  racer.armed = false
  racer.kick = null
  const w = await instance($, on, { role: { poll: { everyMin: 20, prompt: 'Check the inbox.' } }, wrap: wrapRacer })
  const polls = () => w.submits.filter(s => s.startsWith('fleet: your routine poll')).length
  for (let i = 0; i < 22 && polls() === 0; i++) await run(w, MIN)
  expect(polls()).toBe(1)
  await run(w, 5 * MIN)
  expect(polls()).toBe(1)
})

// ---- F3: a reload writes what was due only when the threads differ: a due outside mark isn't written ----

test('F3: a reload within a second of the outside mark leaves the mark out of the reads file (a restart then forgets it)', WITH_SESSIONS, async ($, on) => {
  const at = Date.UTC(2026, 10, 2, 11, 59, 59)
  const threads = { main: { 'notes/a.md': { v: hashText('a\n'), at: Date.UTC(2026, 10, 2, 11, 59, 0), told: hashText('a\n') } } }
  const kept: Record<string, unknown> = { watching: 1, reads: threads, outside: { at, what: 'WebFetch of example.invalid' } }
  on('state.get' as any, (_x: any, e: any, next: any) => {
    const key = e?.ref?.key ?? e?.key
    if (key in kept) return { value: { value: kept[key], version: 1 } }
    return next(e)
  })
  on('state.set' as any, (_x: any, e: any, next: any) => {
    delete kept[e?.ref?.key ?? e?.key]
    return next(e)
  })
  // The reads file as the module before the reload last wrote it: the threads, no mark yet (its write was due 1 s on)
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { [`${ROOT}/notes/a.md`]: 'a\n', [READS]: JSON.stringify({ format: 1, sessionId: SID, ref: null, name: null, at: Date.UTC(2026, 10, 2, 11, 59, 30), threads }) } })
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  w.exec.value = argv => (argv[0] === 'git' ? { exitCode: 128, stdout: '', stderr: 'not a git repository' } : undefined)
  sessionsSay(w, { rows: {} })
  otherSweeps(w)
  await startSession($, w)
  await run(w, 30 * SECOND)
  // Expected the mark (what a restart's restoreMark reads back); the branch never writes it
  const after30s = json(w, READS)?.outside ?? null
  // The control: the mark is in $.state all along, and reaches the file with the next unrelated write (a plain read, 10 s on)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  await run(w, 11 * SECOND)
  expect(json(w, READS)?.outside).toMatchObject({ at, what: 'WebFetch of example.invalid' })
  expect(after30s).toMatchObject({ at, what: 'WebFetch of example.invalid' })
})

// keep the imports used
void hourFolder
