import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { BAND, DEC, FLEET, REF, ROOT, SID, decide, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'
import { PROJECT } from './up.test'

// fleet 0.14.1, the pace of an idle session: with live updates on (Claude's watch or fleet's own), a session that
// neither sweeps nor takes the lease has no timer every 2 s (the lease every 30 s, the world every minute, delivery and
// the beat every minute); the sweeper keeps its 10 s world and beat; a session that isn't live keeps the old timers. And
// the reads file: a second after what the others act on at once, within 10 s of a plain read.
//
// Measured here, per idle minute (timer callbacks / host calls: reads, stats, lists, commands and $.state calls), 0.14.0
// → 0.14.1: a person's session 37 / 64 → 4 / 30, an instance 70 / 179 → 8 / 111, the sweeper 37 / 169 → 13 / 169, a
// session that isn't live 37 / 268 both

const MIN = 60000
const SECOND = 1000
const STATE = `${FLEET}/state`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }
const NOTE = `${ROOT}/notes/a.md`

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
type Counts = { state: Map<string, number>; reload: { watching: boolean; reads: unknown } }
function session(on: any, kind: Kind, files: Record<string, string> = {}): { w: World; c: Counts } {
  const w =
    kind === 'instance'
      ? world(on, { worldPaths: ['notes/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' }, files: { ...PROJECT, [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n', [NOTE]: 'a\n', ...files } })
      : world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT, [NOTE]: 'a\n', ...files } })
  const c: Counts = { state: new Map(), reload: { watching: false, reads: undefined } }
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.25 } } }))
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  on('tool.call', { tool: 'WebFetch' }, () => ({ result: { bytes: 10, code: 200 }, text: 'a page' }) as any)
  on('state.get' as any, (_: any, e: any, next: any) => {
    c.state.set('get', (c.state.get('get') ?? 0) + 1)
    // A module loaded by a reload finds what the module before it kept in $.state
    const key = e?.ref?.key ?? e?.key
    if (key === 'watching' && c.reload.watching) return { value: { value: 1, version: 1 } }
    // (until the module writes its own)
    if (key === 'reads' && c.reload.reads !== undefined) return { value: { value: c.reload.reads, version: 1 } }
    return next(e)
  })
  on('state.set' as any, (_: any, e: any, next: any) => {
    c.state.set('set', (c.state.get('set') ?? 0) + 1)
    if ((e?.ref?.key ?? e?.key) === 'reads') c.reload.reads = undefined
    return next(e)
  })
  w.exec.value = GIT
  sessionsSay(w, { current: kind === 'instance' ? CURRENT : undefined, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  return { w, c }
}

// SessionStart hands the list; the engine brings the probe bell back a moment later: live from then on
async function goLive($: any, w: World) {
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  await tick(w, 1500)
  await changed($, `${FLEET}/bell/probe`)
}
async function changed($: any, path: string, event = 'change') {
  await $.classic.FileChanged({ file_path: path, event } as any)
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)
function snap(w: World, c: Counts) {
  return { timers: sum(w.timerCount), host: sum(w.readCount) + sum(w.statCount) + w.lists.length + w.runs.length + sum(c.state), by: Object.fromEntries(w.timerCount) as Record<string, number> }
}
/** An idle stretch, the lease renewed by another session (or held by this one): what it cost per minute */
async function idle(w: World, c: Counts, minutes: number, sweeps: 'other' | 'me') {
  const a = snap(w, c)
  for (let i = 0; i < minutes * 3; i++) {
    if (sweeps === 'other') otherSweeps(w)
    await tick(w, 20 * SECOND)
  }
  const b = snap(w, c)
  const by: Record<string, number> = {}
  for (const k of Object.keys(b.by)) {
    const d = ((b.by[k] ?? 0) - (a.by[k] ?? 0)) / minutes
    if (d) by[k] = d
  }
  return { timers: (b.timers - a.timers) / minutes, host: (b.host - a.host) / minutes, by }
}

function landByB(w: World, path: string, text: string, n: number) {
  const before = w.files.get(path) ?? ''
  w.touch(path, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${n}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path: path.slice(ROOT.length + 1), from: hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'Owner B' } }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}

const mvTo = (w: World, path: string) => w.runs.filter(a => a[0] === 'mv' && a[a.length - 1] === path).length
const READS = `${FLEET}/reads/${SID}.json`

// ---- What an idle session costs ----

test('live, a session that neither sweeps nor takes the lease: no timer every 2 s or 10 s, a few callbacks a minute', WITH_SESSIONS, async ($, on) => {
  const { w, c } = session(on, 'person')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, c, 3, 'other')
  const m = await idle(w, c, 10, 'other')
  // (0.14.0: 37 callbacks and 64 host calls a minute)
  expect(m.by['every:2000']).toBe(undefined)
  expect(m.by['every:10000']).toBe(undefined)
  // The lease every 30 s (the world's pass at every other), the beat and what fleet needs each minute
  expect(m.by['every:30000']).toBe(2)
  expect(m.timers).toBeLessThanOrEqual(5)
  expect(m.host).toBeLessThanOrEqual(36)
})

test('live, an instance that doesn’t sweep: delivery, the world and the beat once a minute, nothing every 2 s', WITH_SESSIONS, async ($, on) => {
  const { w, c } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, c, 3, 'other')
  const m = await idle(w, c, 10, 'other')
  // (0.14.0: 70 callbacks and 179 host calls a minute)
  expect(m.by['every:2000']).toBe(undefined)
  expect(m.by['every:10000']).toBe(undefined)
  expect(m.timers).toBeLessThanOrEqual(10)
  expect(m.host).toBeLessThanOrEqual(125)
})

test('live, the sweeper: the world and the beat every 10 s (its outside scan), with no 2 s timer', WITH_SESSIONS, async ($, on) => {
  const { w, c } = session(on, 'person')
  await startSession($, w)
  await goLive($, w)
  await idle(w, c, 3, 'me')
  expect(await fleet($, 'status')).toContain('sweeper: this session')
  const m = await idle(w, c, 10, 'me')
  expect(m.by['every:2000']).toBe(undefined)
  expect(m.by['every:10000']).toBe(12)
  expect(m.timers).toBeLessThanOrEqual(15)
})

test('not live (no SessionStart, no own watch): the old timers, delivery and the world every 2 s, the beat every 10 s', WITH_SESSIONS, async ($, on) => {
  const { w, c } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  await idle(w, c, 3, 'other')
  const m = await idle(w, c, 10, 'other')
  expect(m.by['every:2000']).toBe(60)
  expect(m.by['every:10000']).toBe(6)
})

// ---- Switching between the sets ----

test('the sets switch with live updates: on, off after two missed landings, on again after a new SessionStart; never two sets at once', WITH_SESSIONS, async ($, on) => {
  const { w, c } = session(on, 'person')
  otherSweeps(w)
  await startSession($, w)
  await idle(w, c, 1, 'other')
  expect((await idle(w, c, 2, 'other')).by['every:2000']).toBe(30)
  await goLive($, w)
  await idle(w, c, 1, 'other')
  let m = await idle(w, c, 2, 'other')
  expect(m.by['every:2000']).toBe(undefined)
  expect(m.by['every:30000']).toBe(2)
  // Two landings of another session whose events the engine never brings: live off, the old timers back
  for (let i = 0; i < 2; i++) {
    otherSweeps(w)
    w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: `x-${i}` }))
    await tick(w, 30 * SECOND)
    otherSweeps(w)
    await tick(w, 35 * SECOND)
  }
  otherSweeps(w)
  await tick(w, 60 * SECOND)
  expect(w.logs.join('\n')).toContain("the engine's watcher didn't bring two landings")
  await idle(w, c, 1, 'other')
  m = await idle(w, c, 2, 'other')
  expect(m.by['every:2000']).toBe(30)
  expect(m.by['every:30000']).toBe(undefined)
  // A new SessionStart and its probe: the quiet set again, once
  await goLive($, w)
  await idle(w, c, 1, 'other')
  m = await idle(w, c, 3, 'other')
  expect(m.by['every:2000']).toBe(undefined)
  expect(m.by['every:30000']).toBe(2)
  expect(m.by['every:60000']).toBe(2)
})

type Watcher = { argv: string[]; say: (line: string) => void; end: (code: number | null) => void }
function watchers(on: any) {
  const all: Watcher[] = []
  on('process.spawn', async function* (_: any, e: any) {
    const queue: { stream: 'stdout' | 'stderr'; text: string }[] = []
    let result = null as { code: number | null; signal: string | null } | null
    let wake = () => {}
    all.push({
      argv: [...e.argv],
      say: line => {
        queue.push({ stream: 'stdout', text: `${line}\n` })
        wake()
      },
      end: code => {
        result = { code, signal: null }
        wake()
      },
    })
    for (;;) {
      while (queue.length) yield queue.shift()!
      if (result) break
      await new Promise<void>(resolve => (wake = resolve))
    }
    return { value: result! }
  })
  return all
}

test("fleet's own watch: its ready brings the quiet set, its end the old timers, and its next ready the quiet set again", WITH_SESSIONS, async ($, on) => {
  const all = watchers(on)
  const { w, c } = session(on, 'person')
  sessionsSay(w, { watch: 'kqueue', rows: {} } as any)
  otherSweeps(w)
  await startSession($, w)
  await tick(w, 11 * SECOND)
  expect(all.length).toBe(1)
  all[0]!.say('ready\tkqueue\t4242\t5')
  await tick(w, SECOND)
  await idle(w, c, 1, 'other')
  expect((await idle(w, c, 2, 'other')).by['every:2000']).toBe(undefined)
  all[0]!.end(1)
  await tick(w, SECOND)
  // Back on the timers until it starts again, a minute later
  const off = await idle(w, c, 1, 'other')
  expect(off.by['every:2000']).toBeGreaterThanOrEqual(29)
  expect(all.length).toBe(2)
  all[1]!.say('ready\tkqueue\t4243\t5')
  await tick(w, SECOND)
  await idle(w, c, 1, 'other')
  const m = await idle(w, c, 2, 'other')
  expect(m.by['every:2000']).toBe(undefined)
  expect(m.by['every:30000']).toBe(2)
})

test('a module loaded by a reload of a live session (its set in $.state): the quiet set, with no SessionStart of its own', WITH_SESSIONS, async ($, on) => {
  const { w, c } = session(on, 'person')
  c.reload.watching = true
  otherSweeps(w)
  await startSession($, w)
  await idle(w, c, 1, 'other')
  const m = await idle(w, c, 2, 'other')
  expect(m.by['every:2000']).toBe(undefined)
  expect(m.by['every:30000']).toBe(2)
})

// ---- What it acts on still comes as fast ----

test('quiet: a question another session asks reaches the band on its event, within a second', WITH_SESSIONS, async ($, on) => {
  const { w } = session(on, 'person')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, { state: new Map(), reload: { watching: false, reads: undefined } }, 2, 'other')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('for you')
  w.touch(`${DEC}/queue/D-5.json`, JSON.stringify({ format: 1, fleet: '0.14.1', id: 'D-5', at: w.clock.now(), asker: { ref: 'ccccccc1', sessionId: 'cccccccc-0000-0000-0000-000000000000', name: 'Owner C', root: ROOT }, questions: [{ question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }] }] }))
  await changed($, `${DEC}/queue/D-5.json`, 'add')
  await tick(w, SECOND)
  expect(JSON.stringify(await ui.drawn())).toContain('? 1 for you · /fleet')
  await ui.unmount()
})

const answer = (id: string, q: number, label: string, at: number) => JSON.stringify({ format: 1, id, q, label, origin: 'composer', session: 'TEST P', at })

test('quiet: an answer reaches its asker on its event within a second; one with no event, at the minute’s safety pass', WITH_SESSIONS, async ($, on) => {
  const { w, c } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, c, 1, 'other')
  await decide($)
  otherSweeps(w)
  await tick(w, 3 * SECOND)
  w.touch(`${DEC}/answers/D-1.1.json`, answer('D-1', 1, 'SQLite', w.clock.now()))
  w.touch(`${DEC}/answers/D-1.2.json`, answer('D-1', 2, 'Never', w.clock.now()))
  await changed($, `${DEC}/answers/D-1.2.json`, 'add')
  await tick(w, SECOND)
  const first = w.submits.filter(s => s.includes('[D-1] The person answered:')).length
  expect(first).toBe(1)
  await $.turn.start({ text: `The fleet plugin sent a message:\n${w.submits.at(-1)}`, turnId: 't-1' })
  await w.clock.settle()
  await $.turn.complete({ turnId: 't-1', reason: 'answer', answer: 'ok' } as any)
  await w.clock.settle()
  await decide($)
  otherSweeps(w)
  await tick(w, 3 * SECOND)
  w.touch(`${DEC}/answers/D-2.1.json`, answer('D-2', 1, 'SQLite', w.clock.now()))
  w.touch(`${DEC}/answers/D-2.2.json`, answer('D-2', 2, 'Never', w.clock.now()))
  for (let i = 0; i < 3; i++) {
    otherSweeps(w)
    await tick(w, 20500)
  }
  expect(w.submits.filter(s => s.includes('[D-2] The person answered:')).length).toBe(1)
})

test('quiet: a landing reaches an idle instance that read the file within seconds; one taken down hears nothing', WITH_SESSIONS, async ($, on) => {
  const { w, c } = session(on, 'instance')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await $.tool.call({ tool: 'Read', file_path: NOTE } as any)
  await idle(w, c, 3, 'other')
  let before = w.submits.length
  landByB(w, NOTE, 'a, by B\n', 1)
  await changed($, `${FLEET}/events/latest`)
  await tick(w, 6 * SECOND)
  expect(w.submits.slice(before).filter(s => s.includes('- notes/a.md: changed at')).length).toBe(1)
  // The person takes it down from his session: down.json and the budget bell
  await idle(w, c, 2, 'other')
  w.touch(`${STATE}/down.json`, JSON.stringify({ format: 1, instances: { 'owner-a': w.clock.now() } }))
  w.touch(`${FLEET}/bell/budget`, JSON.stringify({ format: 1, by: 'bbbbbbbb', at: w.clock.now() }))
  await changed($, `${FLEET}/bell/budget`)
  await tick(w, 2 * SECOND)
  before = w.submits.length
  landByB(w, NOTE, 'a, by B again\n', 2)
  await changed($, `${FLEET}/events/latest`)
  await idle(w, c, 1, 'other')
  expect(w.submits.slice(before).filter(s => s.includes('notes/a.md'))).toEqual([])
})

test('quiet: a sweeper that stops renewing its lease is replaced within its 90 s and the 30 s look (and the 2 s check)', WITH_SESSIONS, async ($, on) => {
  const { w, c } = session(on, 'person')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await idle(w, c, 3, 'other')
  // Its last renewal
  otherSweeps(w)
  const last = w.clock.now()
  let took = 0
  for (let s = 0; s < 200 && !took; s++) {
    await tick(w, SECOND)
    if (json(w, `${STATE}/sweeper.json`)?.sessionId === SID && w.logs.some(l => l.includes('sweeper: this session'))) took = w.clock.now()
  }
  expect(took).toBeGreaterThan(0)
  // (0.14.0: within 90 s + 10 s + 2 s)
  expect(took - last).toBeGreaterThan(90 * SECOND)
  expect(took - last).toBeLessThanOrEqual(90 * SECOND + 30 * SECOND + 2 * SECOND + 500)
})

// ---- The reads file ----

test('a burst of 20 reads, one a second: the reads file written a couple of times, not 20', WITH_SESSIONS, async ($, on) => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 20; i++) files[`${ROOT}/notes/n${i}.md`] = `n${i}\n`
  const { w } = session(on, 'person', files)
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await tick(w, 15 * SECOND)
  const before = mvTo(w, READS)
  for (let i = 0; i < 20; i++) {
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/n${i}.md` } as any)
    await tick(w, SECOND)
  }
  await tick(w, 11 * SECOND)
  // (0.14.0: one a second after each, 20)
  expect(mvTo(w, READS) - before).toBeLessThanOrEqual(3)
  expect(Object.keys(json(w, READS).threads.main).length).toBe(20)
})

test('what the others act on at once is in the reads file within a second: a command past 3 s, its end, the outside mark', WITH_SESSIONS, async ($, on) => {
  const { w } = session(on, 'person')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await tick(w, 15 * SECOND)
  let done = () => {}
  w.bash.value = () => new Promise<void>(resolve => (done = resolve))
  const running = $.tool.call({ tool: 'Bash', command: 'make all' } as any)
  await tick(w, 3 * SECOND)
  await tick(w, 1100)
  expect(json(w, READS)?.running).toEqual([expect.objectContaining({ thread: 'main', command: 'make all' })])
  done()
  await running
  await tick(w, 1100)
  expect(json(w, READS)?.running).toBe(undefined)
  await $.tool.call({ tool: 'WebFetch', url: 'https://example.invalid/idea', prompt: 'the idea' } as any)
  await tick(w, 1100)
  expect(json(w, READS)?.outside).toMatchObject({ what: 'WebFetch of example.invalid' })
})

test('a session that ends writes the reads it had yet to write', WITH_SESSIONS, async ($, on) => {
  const { w } = session(on, 'person')
  otherSweeps(w)
  await startSession($, w)
  await goLive($, w)
  await tick(w, 15 * SECOND)
  await $.tool.call({ tool: 'Read', file_path: NOTE } as any)
  await tick(w, 2 * SECOND)
  expect(json(w, READS)?.threads?.main?.['notes/a.md']).toBe(undefined)
  await $.session.end({ reason: 'other', sessionId: SID } as any)
  await w.clock.settle()
  expect(json(w, READS).threads.main['notes/a.md']).toMatchObject({ v: hashText('a\n') })
})

test('a reload writes the reads the module before it had yet to write ($.state has them, the file not)', WITH_SESSIONS, async ($, on) => {
  const { w, c } = session(on, 'person', { [READS]: JSON.stringify({ format: 1, sessionId: SID, ref: null, name: null, at: Date.UTC(2026, 10, 2, 11, 59, 0), threads: {} }) })
  c.reload.watching = true
  c.reload.reads = { main: { 'notes/a.md': { v: hashText('a\n'), at: Date.UTC(2026, 10, 2, 11, 59, 55), told: hashText('a\n') } } }
  otherSweeps(w)
  await startSession($, w)
  await tick(w, 1100)
  expect(json(w, READS).threads.main['notes/a.md']).toMatchObject({ v: hashText('a\n') })
})

// Measured live (0.14.0 and 0.14.1): the sweeping session's end let the lease go, and a timer of the ending process took
// it back 0.4 s later, so another session waited out the whole stale bound
test('a sweeping session that ends lets the lease go for good: its timers take nothing back', WITH_SESSIONS, async ($, on) => {
  const { w } = session(on, 'person')
  await startSession($, w)
  await goLive($, w)
  await tick(w, 30 * SECOND)
  expect(json(w, `${STATE}/sweeper.json`)?.sessionId).toBe(SID)
  await $.session.end({ reason: 'other', sessionId: SID } as any)
  await w.clock.settle()
  expect(w.files.has(`${STATE}/sweeper.json`)).toBe(false)
  await tick(w, 3 * MIN)
  expect(w.files.has(`${STATE}/sweeper.json`)).toBe(false)
})

test('a /resume lets the lease go and the session may take it again later (the process goes on)', WITH_SESSIONS, async ($, on) => {
  const { w } = session(on, 'person')
  await startSession($, w)
  await goLive($, w)
  await tick(w, 30 * SECOND)
  expect(json(w, `${STATE}/sweeper.json`)?.sessionId).toBe(SID)
  await $.session.end({ reason: 'resume', sessionId: SID } as any)
  await w.clock.settle()
  await tick(w, 3 * MIN)
  expect(json(w, `${STATE}/sweeper.json`)?.sessionId).toBe(SID)
})

// Measured live: an instance's beat looked at runs/ (3.75 a minute) in a project that never declared a run, a failed
// stat each time. The session's start makes it with the other folders it keeps
test('a session in a project with a world makes runs/ at start, so its beats find the folder', WITH_SESSIONS, async ($, on) => {
  const { w } = session(on, 'person')
  otherSweeps(w)
  await startSession($, w)
  await tick(w, 5 * SECOND)
  expect(w.dirs.has(`${FLEET}/runs`)).toBe(true)
})
