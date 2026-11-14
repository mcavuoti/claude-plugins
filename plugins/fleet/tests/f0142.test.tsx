import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { DEC, FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// fleet 0.14.2: what another session's landing costs an idle one. Every landing rewrites events/latest, which every
// session watches. Before, each idle session listed two hour folders whole, read the event and ran its nudge pass within
// 5 s, whether or not the file concerned it (about 30 host calls a landing for an idle instance). Now:
//   1. a landing kicks the nudge pass only when it concerns this instance (a file its main thread read, a path it
//      watches, an intake pointer to it, a file it wrote or a record such a file cites);
//   2. events/latest carries the chain of the last landings' names, so a session that holds the one before reads just
//      the new events, and lists the hour folder only on a gap (and once a minute after it read that way, as the net);
//   3. an idle session that doesn't sweep takes landings in once they've been quiet 1.5 s, 5 s at most.
// Placeholders only: /Users/x/proj, ids aaaaaaaa and bbbbbbbb, made-up names.
//
// Measured here (host calls: file reads, stats, lists, writes, commands, $.state gets and sets, $.sessions calls), an
// idle instance that doesn't sweep, per minute, 0.14.1 → 0.14.2, by the peers' landings a minute: see the stream tests

declare const console: { log: (...a: unknown[]) => void }

const SECOND = 1000
const MIN = 60000
const STATE = `${FLEET}/state`
const HB = `${FLEET}/instances/owner-a`
const LATEST = `${FLEET}/events/latest`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const B = { ref: 'bbbbbbbb', sessionId: B_SID, name: 'Owner B', root: ROOT }
const GO = [{ question: 'Go ahead with the split?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'w' }]
const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, mcp__fleet__*\n---\nYou own a part of the notes.\n'
const LONG = { ...WITH_SESSIONS, timeoutMs: 900000 }
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }
const PERSON = { ready: true, ref: null, sessionId: SID, name: 'Person', root: ROOT, background: false, agent: null }

function roster(n: number, extra: Record<string, unknown> = {}, role: Record<string, unknown> = {}) {
  const instances = [
    { name: 'Owner A', role: 'owner', section: 'owners' },
    { name: 'Owner B', role: 'owner', section: 'owners' },
  ]
  for (let i = 3; i <= n; i++) instances.push({ name: `Owner ${String(i).padStart(2, '0')}`, role: 'owner', section: 'owners' })
  return JSON.stringify({ rosterFormat: 1, sections: [{ id: 'owners', title: 'Owners' }], roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 5 }, ...role } }, instances, budget: { usdDay: 200 }, ...extra })
}

type Kind = 'instance' | 'person' | 'sweeper'
type S = { w: World; state: { get: number; set: number }; sweeps: 'other' | 'me' }

function otherSweeps(w: World) {
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner B', at: w.clock.now(), remote: null }))
}
/** What the other session's sweeper keeps current without a bell: the spends summary, every 4 minutes */
function refreshSpends(w: World) {
  const p = `${STATE}/spends.json`
  const t = w.files.get(p)
  if (!t) return
  try {
    w.touch(p, JSON.stringify({ ...JSON.parse(t), at: w.clock.now() }))
  } catch {}
}
async function step(s: S, ms: number) {
  for (let left = ms; left > 0; left -= SECOND) {
    await s.w.clock.advance(Math.min(left, SECOND))
    await s.w.clock.settle()
    if (s.sweeps === 'other') {
      const now = s.w.clock.now()
      if (now % 20000 < SECOND) otherSweeps(s.w)
      if (now % (4 * MIN) < SECOND) refreshSpends(s.w)
    }
  }
}
/** Whether this session read that event's file (it took the landing in) */
const taken = (w: World, name: string) => (w.readCount.get(`${FLEET}/events/${hourFolder(Number(name.split('-')[0]))}/${name}`) ?? 0) > 0
async function changed($: any, s: S, path: string, event = 'change') {
  await $.classic.FileChanged({ file_path: path, event } as any)
  await s.w.clock.settle()
}

// ---- Another session's landing, as a fleet of this version writes it ----

let eventN = 0
let stampN = 0
/** events/latest's time: a hair before the clock (its event comes after the write, as on a real machine), and never
 * the same twice */
const stamp = (w: World) => w.clock.now() - 1 + (++stampN % 900) / 1000
function eventFile(w: World, path: string, to: string | null, at: number, by = 'bbbbbbbb', more: Record<string, unknown> = {}): string {
  const name = `${at}-${by}-${++eventN}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path, from: null, to, via: 'tool', tool: 'Edit', blind: false, by: { sessionId: B_SID, agentId: null, ref: by, name: 'Owner B' }, ...more }))
  return name
}
/** What a writer of 0.14.2 leaves in events/latest: the name, and the chain latest held with it at its end */
function latestAfter(w: World, names: string[], chain: 'chain' | 'bare' = 'chain') {
  let before: string[] = []
  try {
    const cur = JSON.parse(w.files.get(LATEST) ?? '{}')
    before = Array.isArray(cur.chain) ? cur.chain : cur.last ? [cur.last] : []
  } catch {}
  const last = names[names.length - 1] as string
  w.touch(LATEST, JSON.stringify(chain === 'bare' ? { format: 1, last } : { format: 1, last, chain: [...before, ...names].slice(-32) }), stamp(w))
}
/** Owner B lands a change to a shared file: the file, its event, events/latest */
function land(w: World, path: string, text: string, opts: { chain?: 'chain' | 'bare'; more?: Record<string, unknown> } = {}): string {
  const before = w.files.get(`${ROOT}/${path}`) ?? ''
  w.touch(`${ROOT}/${path}`, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${++eventN}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path, from: hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'Owner B' }, ...opts.more }))
  latestAfter(w, [name], opts.chain)
  return name
}

// ---- Counting ----

type Snap = { ops: Map<string, number>; runs: number; lists: number; get: number; set: number; timers: Map<string, number>; submits: number }
const snap = (s: S): Snap => ({ ops: new Map(s.w.ops), runs: s.w.runs.length, lists: s.w.lists.length, get: s.state.get, set: s.state.set, timers: new Map(s.w.timerCount), submits: s.w.submits.length })
function entriesOf(w: World, dir: string): number {
  const prefix = `${dir}/`
  let n = 0
  for (const p of w.files.keys()) if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) n++
  return n
}
type Cost = { read: number; absent: number; stat: number; list: number; hourLists: number; listEntries: number; write: number; spawn: number; state: number; sessions: number; submits: number; total: number; nudgePasses: number; latestReads: number; farTimers: number }
function diff(s: S, a: Snap, b: Snap): Cost {
  const c: Cost = { read: 0, absent: 0, stat: 0, list: 0, hourLists: 0, listEntries: 0, write: 0, spawn: b.runs - a.runs, state: b.get - a.get + (b.set - a.set), sessions: 0, submits: b.submits - a.submits, total: 0, nudgePasses: 0, latestReads: 0, farTimers: 0 }
  let exists = 0
  for (const [k, v] of b.ops) {
    const d = v - (a.ops.get(k) ?? 0)
    if (!d) continue
    const sp = k.indexOf(' ')
    const kind = k.slice(0, sp)
    const path = k.slice(sp + 1)
    if (path.startsWith('/fake/')) {
      if (kind === 'read' && path === '/fake/sessions.json') c.sessions += d
      continue
    }
    if (kind === 'read') c.read += d
    else if (kind === 'absent') c.absent += d
    else if (kind === 'stat') c.stat += d
    else if (kind === 'exists') exists += d
    else if (kind === 'list') c.list += d
    else if (kind === 'write') c.write += d
    // Each nudge pass reads the instance's own count of nudges once
    if (kind === 'read' && path === `${HB}/nudges.json`) c.nudgePasses += d
    if (kind === 'read' && path === LATEST) c.latestReads += d
  }
  // A read of a missing file is counted under read and under absent
  c.read -= c.absent
  for (const dir of s.w.lists.slice(a.lists, b.lists)) {
    if (/\/events\/\d{4}-\d{2}-\d{2}\/\d{2}$/.test(dir)) c.hourLists++
    c.listEntries += entriesOf(s.w, dir)
  }
  for (const [k, v] of b.timers) {
    const d = v - (a.timers.get(k) ?? 0)
    // One-off timers set further off than the minute's pass (the wakes' window opening)
    if (d && k.startsWith('after:') && Number(k.slice(6)) > 2 * MIN) c.farTimers += d
  }
  c.total = c.read + c.absent + c.stat + exists + c.list + c.write + c.spawn + c.state + c.sessions
  return c
}
function scale(c: Cost, by: number): Cost {
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * by * 10) / 10])) as Cost
}
const say = (label: string, c: unknown) => console.log(`F0142 ${label} ${JSON.stringify(c)}`)

// ---- The session ----

async function session($: any, on: any, kind: Kind, opts: { n?: number; hourEvents?: number; window?: 'shut' | 'open'; files?: Record<string, string>; rosterExtra?: Record<string, unknown>; role?: Record<string, unknown>; worldJson?: Record<string, unknown>; live?: boolean } = {}): Promise<S> {
  const isInstance = kind === 'instance'
  const notes: Record<string, string> = {}
  for (let i = 1; i <= 40; i++) notes[`${ROOT}/notes/n${i}.md`] = `note ${i}\n`
  const w = world(on, {
    background: isInstance,
    worldPaths: ['notes/**', 'board/**'],
    ...(isInstance ? { env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' } } : {}),
    files: {
      [`${FLEET}/roster.json`]: roster(opts.n ?? 24, opts.rosterExtra, opts.role),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/seeds/owner.md`]: 'Plan your part.',
      ...(isInstance ? { [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n', [`${HB}/seed-${REF}.json`]: JSON.stringify({ format: 1, ref: REF, at: 1 }) } : {}),
      ...notes,
      ...opts.files,
    },
  })
  if (opts.worldJson) w.touch(`${FLEET}/world.json`, JSON.stringify({ worldFormat: 1, paths: ['notes/**', 'board/**'], ...opts.worldJson }))
  const s: S = { w, state: { get: 0, set: 0 }, sweeps: 'me' }
  // This hour's and the last hour's events already there (a busy project; the world's clock starts on the hour)
  if (opts.hourEvents) {
    const now = w.clock.now()
    for (let i = 0; i < opts.hourEvents; i++) {
      eventFile(w, `notes/x${i % 200}.md`, hashText(`x${i}`), now + i, 'cccccccc')
      eventFile(w, `notes/x${i % 200}.md`, hashText(`y${i}`), now - 30 * MIN + i, 'cccccccc')
    }
  }
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.25 } } }))
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a9' }))
  on('state.get' as any, (_: any, e: any, next: any) => {
    s.state.get++
    return next(e)
  })
  on('state.set' as any, (_: any, e: any, next: any) => {
    s.state.set++
    return next(e)
  })
  w.exec.value = argv => {
    if (argv[0] !== 'git') return undefined
    if (argv.includes('rev-parse')) return { exitCode: 0, stdout: `${ROOT}\n${ROOT}/.git\n${ROOT}/.git\n` }
    if (argv.includes('worktree')) return { exitCode: 0, stdout: `worktree ${ROOT}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n\n` }
    return { exitCode: 0, stdout: '' }
  }
  sessionsSay(w, { current: isInstance ? CURRENT : PERSON, rows: { [REF]: row(REF, isInstance ? 'Owner A' : 'Person', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'working') } })
  await startSession($, w)
  if (opts.live !== false) {
    await $.classic.SessionStart({ source: 'startup', ...(isInstance ? { agent_type: 'owner' } : {}) } as any)
    await w.clock.settle()
    // Claude brings the probe back: live updates on
    await step(s, 1100)
    await changed($, s, `${FLEET}/bell/probe`)
  }
  // First it sweeps, so the sweeper's files are there as a real one writes them
  await step(s, 4 * MIN)
  if (isInstance) {
    // It read two shared files in an earlier turn; its wakes' window is shut (nudged ten minutes ago) unless open
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/n1.md` } as any)
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/n2.md` } as any)
    w.touch(`${HB}/nudges.json`, JSON.stringify({ format: 1, day: '2026-11-02', count: 1, last: w.clock.now() - (opts.window === 'open' ? 3 * 60 : 10) * MIN }))
  }
  if (kind !== 'sweeper') {
    s.sweeps = 'other'
    otherSweeps(w)
  }
  await step(s, 3 * MIN)
  const off = w.clock.now() % MIN
  if (off) await step(s, MIN - off)
  return s
}

/** A steady stream for ten minutes: the peers' landings a minute, evenly spaced, one in ten on a file this session
 * read; per minute */
async function stream($: any, s: S, perMin: number, minutes = 10): Promise<Cost> {
  const w = s.w
  const a = snap(s)
  const gap = perMin ? MIN / perMin : 0
  let next = gap ? gap / 2 : Infinity
  let k = 0
  for (let t = 0; t < minutes * MIN; t += SECOND) {
    while (next <= t) {
      land(w, k % 10 === 9 ? 'notes/n1.md' : `notes/n${10 + (k % 25)}.md`, `stream ${k}\n`)
      k++
      await changed($, s, LATEST)
      next += gap
    }
    await step(s, SECOND)
  }
  return scale(diff(s, a, snap(s)), 1 / minutes)
}

// ---- 1. One landing ----

test('a landing on a file an idle instance never read costs it no nudge pass and no folder listing: a few host calls (30 before)', LONG, async ($, on) => {
  const s = await session($, on, 'instance')
  // (the first landing after its start is a whole pull: from then on it holds the chain)
  land(s.w, 'notes/n19.md', 'by B, first\n')
  await changed($, s, LATEST)
  await step(s, 2 * MIN)
  const b = snap(s)
  await step(s, MIN)
  const without = diff(s, b, snap(s))
  const a = snap(s)
  const name = land(s.w, 'notes/n20.md', 'by B\n')
  await changed($, s, LATEST)
  await step(s, MIN)
  const withLanding = diff(s, a, snap(s))
  say('one unrelated landing, an idle instance, a minute with it and one without', { withLanding, without })
  expect(withLanding.nudgePasses - without.nudgePasses).toBe(0)
  // (the minute after reads by chain has its one whole pull, the net: the hour folder, once)
  expect(withLanding.hourLists).toBeLessThanOrEqual(1)
  expect(withLanding.total - without.total).toBeLessThanOrEqual(7)
  // It took the landing in all the same
  expect(taken(s.w, name)).toBe(true)
})

test('a landing on a file the idle instance read nudges it within 7 s of its event (the quiet wait, then the nudge pass)', LONG, async ($, on) => {
  const s = await session($, on, 'instance', { window: 'open' })
  const before = s.w.submits.length
  land(s.w, 'notes/n2.md', 'n2 by B\n')
  await changed($, s, LATEST)
  let waited = 0
  while (s.w.submits.length === before && waited < 20 * SECOND) {
    await step(s, 500)
    waited += 500
  }
  say('a landing on a file it read: nudged after (ms)', waited)
  expect(s.w.submits.length).toBe(before + 1)
  expect(s.w.submits[before]).toContain('- notes/n2.md: changed at')
  expect(waited).toBeLessThanOrEqual(7 * SECOND)
})

test('a landing under a path the instance watches nudges it, one beside it under no such path does not', LONG, async ($, on) => {
  const s = await session($, on, 'instance', { window: 'open', role: { watch: ['board/**'] } })
  const before = s.w.submits.length
  const a = snap(s)
  land(s.w, 'notes/n30.md', 'elsewhere\n')
  await changed($, s, LATEST)
  await step(s, 15 * SECOND)
  expect(s.w.submits.length).toBe(before)
  expect(diff(s, a, snap(s)).nudgePasses).toBe(0)
  land(s.w, 'board/B-1.md', 'an item\n')
  await changed($, s, LATEST)
  await step(s, 8 * SECOND)
  expect(s.w.submits.length).toBe(before + 1)
  expect(s.w.submits[before]).toContain('fleet: files you watch (board/**) changed:')
  expect(s.w.submits[before]).toContain('- board/B-1.md')
})

test('a landing on a record a file the instance wrote cites looks at its nudges again once the sweeper had time to flag it (10 s)', LONG, async ($, on) => {
  const s = await session($, on, 'instance', {
    worldJson: { records: { ids: ['R-<n>'], revKey: 'rev', changeKey: 'change' } },
    files: { [`${ROOT}/notes/R-1.md`]: '---\nid: R-1\nrev: 1\n---\nA result.\n' },
  })
  const w = s.w
  // It wrote a file that cites the record (its own landing, by its own tool)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/R-1.md` } as any)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes/mine.md`, content: 'Rests on R-1@1.\n' } as any)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: 'done', reason: 'answer' } as any)
  await step(s, 2 * MIN)
  // A /clear: the new conversation read nothing, so the record's landing is no file it read
  await $.session.end({ reason: 'clear', sessionId: SID } as any)
  await step(s, 2 * MIN)
  const a = snap(s)
  land(w, 'notes/R-1.md', '---\nid: R-1\nrev: 2\nchange: revised\n---\nA result, revised.\n', { more: { id: 'R-1', rev: 2 } })
  await changed($, s, LATEST)
  await step(s, 8 * SECOND)
  expect(diff(s, a, snap(s)).nudgePasses).toBe(0)
  await step(s, 6 * SECOND)
  expect(diff(s, a, snap(s)).nudgePasses).toBe(1)
})

test('an item from outside routed to the instance (an intake landing that names it) looks at its nudges within 7 s; one routed to another does not', LONG, async ($, on) => {
  const s = await session($, on, 'instance')
  const w = s.w
  land(w, 'notes/n19.md', 'by B, first\n')
  await changed($, s, LATEST)
  await step(s, 2 * MIN)
  const meta = (to: string) => ({ kind: 'information', tags: [], from: 'someone@example.invalid', standing: 'other', auth: 'unverified', summary: 'a note', to: [to], drafter: null, front: false, targets: [], source: 'mail' })
  let a = snap(s)
  land(w, 'intake/I-1.md', 'for another\n', { more: { via: 'intake', id: 'I-1', by: null, intake: meta('Owner B') } })
  await changed($, s, LATEST)
  await step(s, 10 * SECOND)
  expect(diff(s, a, snap(s)).nudgePasses).toBe(0)
  a = snap(s)
  land(w, 'intake/I-2.md', 'for it\n', { more: { via: 'intake', id: 'I-2', by: null, intake: meta('Owner A') } })
  await changed($, s, LATEST)
  await step(s, 7 * SECOND)
  expect(diff(s, a, snap(s)).nudgePasses).toBe(1)
})

// ---- 2. The chain in events/latest ----

test("this session's own landing leaves events/latest with the chain: what it held before, then its own event", LONG, async ($, on) => {
  const s = await session($, on, 'person')
  const w = s.w
  const first = land(w, 'notes/n20.md', 'by B\n')
  await changed($, s, LATEST)
  await step(s, 3 * SECOND)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/n3.md` } as any)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes/n3.md`, content: 'mine\n' } as any)
  await w.clock.settle()
  const l = json(w, LATEST)
  expect(l.format).toBe(1)
  expect(l.chain.length).toBe(2)
  expect(l.chain[0]).toBe(first)
  expect(l.chain[1]).toBe(l.last)
  expect(l.last).toMatch(/-aaaaaaaa-\d+\.json$/)
  // Capped: forty more of its own keep the last 32
  for (let i = 0; i < 40; i++) {
    await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes/n3.md`, content: `mine ${i}\n` } as any)
    await step(s, SECOND)
  }
  const after = json(w, LATEST)
  expect(after.chain.length).toBe(32)
  expect(after.chain[31]).toBe(after.last)
})

test('a landing whose chain reaches the one this session held is read alone: one read of latest, one of the event, no listing, with 1,200 events in the hour', LONG, async ($, on) => {
  const s = await session($, on, 'person', { hourEvents: 1200 })
  const w = s.w
  // The first one after its start: it holds everything, by the whole pull of its start
  land(w, 'notes/n20.md', 'one\n')
  await changed($, s, LATEST)
  await step(s, 5 * SECOND)
  const a = snap(s)
  const names: string[] = []
  for (let i = 0; i < 5; i++) {
    names.push(land(w, `notes/n2${i}.md`, `more ${i}\n`))
    await changed($, s, LATEST)
    await step(s, 4 * SECOND)
  }
  const c = diff(s, a, snap(s))
  say('five landings read by the chain, 1,200 events in the hour', c)
  expect(c.hourLists).toBe(0)
  expect(c.listEntries).toBeLessThan(50)
  expect(c.latestReads).toBe(5)
  for (const n of names) expect(taken(w, n)).toBe(true)
})

test("after its own landing a session still holds the chain: the peer's next one is read alone", LONG, async ($, on) => {
  const s = await session($, on, 'person')
  const w = s.w
  land(w, 'notes/n20.md', 'one\n')
  await changed($, s, LATEST)
  await step(s, 5 * SECOND)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/n3.md` } as any)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes/n3.md`, content: 'mine\n' } as any)
  await changed($, s, LATEST)
  await step(s, 5 * SECOND)
  const a = snap(s)
  const name = land(w, 'notes/n21.md', 'two\n')
  await changed($, s, LATEST)
  await step(s, 5 * SECOND)
  const c = diff(s, a, snap(s))
  expect(c.hourLists).toBe(0)
  expect(taken(w, name)).toBe(true)
  expect(json(w, LATEST).chain.length).toBe(3)
})

test('with live updates off (the timers), landings are read by the chain too, and the whole pull that follows is one listing', LONG, async ($, on) => {
  const s = await session($, on, 'person', { live: false })
  const w = s.w
  expect(await fleet($, 'status')).toContain('live updates off')
  land(w, 'notes/n20.md', 'one\n')
  await step(s, 2 * MIN)
  const a = snap(s)
  const names: string[] = []
  for (let i = 0; i < 5; i++) {
    names.push(land(w, `notes/n2${i}.md`, `more ${i}\n`))
    await step(s, 3 * SECOND)
    // The 2 s look found it
    expect(taken(w, names[i] as string)).toBe(true)
  }
  await step(s, MIN)
  const c = diff(s, a, snap(s))
  say('five landings, live updates off', c)
  expect(c.hourLists).toBeLessThanOrEqual(2)
})

test("a latest with no chain (another writer's making), or one whose chain doesn't reach back, costs a listing and loses nothing", LONG, async ($, on) => {
  const s = await session($, on, 'person')
  const w = s.w
  land(w, 'notes/n20.md', 'one\n')
  await changed($, s, LATEST)
  await step(s, 5 * SECOND)
  // No chain
  let a = snap(s)
  const bare = land(w, 'notes/n21.md', 'bare\n', { chain: 'bare' })
  await changed($, s, LATEST)
  await step(s, 5 * SECOND)
  expect(diff(s, a, snap(s)).hourLists).toBeGreaterThanOrEqual(1)
  expect(taken(w, bare)).toBe(true)
  // Two events land, and latest names only the second with a chain that starts there (the first one's writer lost the
  // race for latest): the reader doesn't hold the chain's start, so it lists
  a = snap(s)
  const at = w.clock.now()
  const first = eventFile(w, 'notes/n22.md', hashText('lost'), at)
  const second = eventFile(w, 'notes/n23.md', hashText('kept'), at)
  w.touch(LATEST, JSON.stringify({ format: 1, last: second, chain: ['0-cccccccc-1.json', second] }), stamp(w))
  await changed($, s, LATEST)
  await step(s, 5 * SECOND)
  expect(diff(s, a, snap(s)).hourLists).toBeGreaterThanOrEqual(1)
  expect(taken(w, first)).toBe(true)
  expect(taken(w, second)).toBe(true)
})

test('an event the chain never named (two writers at once, one overwrote the other) is taken in within the minute, by the whole pull that follows the reads by chain', LONG, async ($, on) => {
  const s = await session($, on, 'person')
  const w = s.w
  land(w, 'notes/n20.md', 'one\n')
  await changed($, s, LATEST)
  await step(s, 5 * SECOND)
  // B and C land at once; C's latest is the one that stays, continuing the chain from before B's
  const at = w.clock.now()
  const unnamed = eventFile(w, 'notes/n24.md', hashText('B, unnamed'), at)
  const kept = eventFile(w, 'notes/n25.md', hashText('C'), at, 'cccccccc')
  latestAfter(w, [kept])
  const from = w.clock.now()
  await changed($, s, LATEST)
  await step(s, 5 * SECOND)
  expect(taken(w, kept)).toBe(true)
  while (!taken(w, unnamed) && w.clock.now() - from < 2 * MIN) await step(s, 5 * SECOND)
  say('an unnamed event: taken in after (s)', (w.clock.now() - from) / SECOND)
  expect(taken(w, unnamed)).toBe(true)
  expect(w.clock.now() - from).toBeLessThanOrEqual(65 * SECOND)
})

test('the same under a stream that never stops (a landing a second): an unnamed event is still taken in within the minute, whenever it comes', LONG, async ($, on) => {
  const s = await session($, on, 'instance')
  const w = s.w
  land(w, 'notes/n19.md', 'first\n')
  await changed($, s, LATEST)
  await step(s, 2 * MIN)
  let k = 0
  const stream = async (ms: number) => {
    for (let t = 0; t < ms; t += SECOND) {
      land(w, `notes/n${25 + (k % 10)}.md`, `stream ${k++}\n`)
      await changed($, s, LATEST)
      await step(s, SECOND)
    }
  }
  const waits: number[] = []
  // Dropped at six moments of the minute's pass
  for (let i = 0; i < 6; i++) {
    await stream(70 * SECOND)
    const unnamed = eventFile(w, 'notes/n24.md', hashText(`unnamed ${i}`), w.clock.now())
    const from = w.clock.now()
    while (!taken(w, unnamed) && w.clock.now() - from < 2 * MIN) await stream(SECOND)
    expect(taken(w, unnamed)).toBe(true)
    waits.push((w.clock.now() - from) / SECOND)
  }
  say('unnamed events under a landing a second: taken in after (s)', waits)
  expect(Math.max(...waits)).toBeLessThanOrEqual(65)
})

test('a whole pull lists an hour folder only when something came or went in it since it was last listed', LONG, async ($, on) => {
  const s = await session($, on, 'person', { hourEvents: 300 })
  const w = s.w
  // Bare landings: each one is a gap, so each is a whole pull. The hour before never moves: never listed again
  land(w, 'notes/n20.md', 'one\n', { chain: 'bare' })
  await changed($, s, LATEST)
  await step(s, 5 * SECOND)
  const a = snap(s)
  for (let i = 0; i < 4; i++) {
    land(w, `notes/n2${i}.md`, `bare ${i}\n`, { chain: 'bare' })
    await changed($, s, LATEST)
    await step(s, 5 * SECOND)
  }
  const c = diff(s, a, snap(s))
  say('four whole pulls, 300 events in each hour folder', c)
  expect(c.hourLists).toBe(4)
})

// ---- 3. Idle: landings taken in once quiet ----

test('idle, ten landings a second apart are taken in by three looks at most (ten before); one alone within 2 s; a stream within 5 s', LONG, async ($, on) => {
  const s = await session($, on, 'instance')
  const w = s.w
  land(w, 'notes/n19.md', 'by B, first\n')
  await changed($, s, LATEST)
  await step(s, 2 * MIN)
  const a = snap(s)
  const names: string[] = []
  for (let i = 0; i < 10; i++) {
    names.push(land(w, `notes/n${20 + i}.md`, `burst ${i}\n`))
    await changed($, s, LATEST)
    await step(s, SECOND)
    // 5 s after the first (and a second for the clock's step), the first ones are taken in
    if (i === 5) expect(taken(w, names[0] as string)).toBe(true)
  }
  await step(s, 3 * SECOND)
  const c = diff(s, a, snap(s))
  say('ten landings a second apart, idle', c)
  expect(c.latestReads).toBeLessThanOrEqual(3)
  // (the minute's whole pull may fall in these seconds: one listing at most)
  expect(c.hourLists).toBeLessThanOrEqual(1)
  for (const n of names) expect(taken(w, n)).toBe(true)
  // One alone: not yet a second later (it waits for quiet), taken in 2 s later
  await step(s, 10 * SECOND)
  const alone = land(w, 'notes/n35.md', 'alone\n')
  await changed($, s, LATEST)
  await step(s, SECOND)
  expect(taken(w, alone)).toBe(false)
  await step(s, SECOND)
  expect(taken(w, alone)).toBe(true)
})

test("a session whose turn is running takes each landing at once, as before (its tool steps read what's new)", LONG, async ($, on) => {
  const s = await session($, on, 'instance')
  const w = s.w
  await $.turn.start({ text: 'work', turnId: 't1' })
  const a = snap(s)
  land(w, 'notes/n1.md', 'n1 by B\n')
  await changed($, s, LATEST)
  expect(diff(s, a, snap(s)).latestReads).toBe(1)
  const r: any = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/n3.md` } as any)
  expect((r.context ?? []).join('\n')).toContain('notes/n1.md')
})

test('the sweeping session takes each landing at once too: its suspects follow it', LONG, async ($, on) => {
  const s = await session($, on, 'sweeper')
  const a = snap(s)
  land(s.w, 'notes/n20.md', 'by B\n')
  await changed($, s, LATEST)
  expect(diff(s, a, snap(s)).latestReads).toBe(1)
})

// ---- What doesn't come from a landing keeps its own trigger ----

test('an item offered (work.json, the work bell) still nudges the idle instance within 6 s, whatever lands meanwhile', LONG, async ($, on) => {
  const s = await session($, on, 'instance', { window: 'open' })
  const w = s.w
  const before = w.submits.length
  const now = w.clock.now()
  w.touch(`${STATE}/work.json`, JSON.stringify({ format: 1, at: now, unowned: { 'B-4': { for: 'owner', since: now - MIN, offers: [{ slug: 'owner-a', at: now }], round: 1 } }, capacity: { idle: ['Owner A'], unowned: 1, oldest: now - MIN, slotsFree: null, slotsTotal: null, runs: 0, unrecorded: 0, flags: [] } }))
  w.touch(`${ROOT}/board/B-4.md`, '---\nid: B-4\nstatus: open\nowner:\nfor: owner\n---\nAn item.\n')
  w.touch(`${FLEET}/bell/work`, JSON.stringify({ format: 1, by: 'bbbbbbbb', at: now }))
  await changed($, s, `${FLEET}/bell/work`)
  let waited = 0
  while (w.submits.length === before && waited < 20 * SECOND) {
    await step(s, 500)
    waited += 500
  }
  say('an item offered: nudged after (ms)', waited)
  expect(w.submits.length).toBe(before + 1)
  expect(w.submits[before]).toContain('B-4')
  expect(waited).toBeLessThanOrEqual(6 * SECOND)
})

test('a decision its work waits on, once closed (the queue folder moved), still reaches the idle instance within 6 s', LONG, async ($, on) => {
  const s = await session($, on, 'instance', { window: 'open' })
  const w = s.w
  const at = w.clock.now()
  w.touch(`${DEC}/queue/D-7.json`, JSON.stringify({ format: 1, fleet: '0.14.0', id: 'D-7', at, asker: B, questions: GO }))
  await changed($, s, `${DEC}/queue/D-7.json`, 'add')
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__fleet__decide', kind: 'wait', id: 'D-7' } as any).catch(() => {})
  await $.turn.complete({ turnId: 't1', answer: 'waiting', reason: 'answer' } as any)
  await step(s, 45 * SECOND)
  const before = w.submits.length
  w.files.delete(`${DEC}/queue/D-7.json`)
  w.touch(`${DEC}/register/2026-11/D-7.json`, JSON.stringify({ registerFormat: 1, id: 'D-7', source: 'decide', fleet: '0.14.0', at, asker: B, questions: GO, answers: [{ label: 'Yes', origin: 'composer', at }], state: 'delivered', delivered: { at, how: 'submit' }, closedAt: at }))
  await changed($, s, `${DEC}/queue/D-7.json`, 'unlink')
  let waited = 0
  while (w.submits.length === before && waited < 20 * SECOND) {
    await step(s, 500)
    waited += 500
  }
  say('a decision it waits on closed: nudged after (ms)', waited)
  if (w.submits.length > before) expect(w.submits[before]).toContain('D-7')
  expect(waited).toBeLessThanOrEqual(6 * SECOND)
})

test("the sweeper's flag on a file it wrote, with no event of any kind, reaches the idle instance at its minute's pass", LONG, async ($, on) => {
  const s = await session($, on, 'instance', { window: 'open' })
  const w = s.w
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes/mine.md`, content: 'mine\n' } as any)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: 'done', reason: 'answer' } as any)
  await step(s, 2 * MIN)
  const before = w.submits.length
  w.touch(`${STATE}/checks/${hashText('notes/mine.md').slice(1, 17)}.json`, JSON.stringify({ format: 1, path: 'notes/mine.md', hash: hashText('mine\n'), at: w.clock.now(), owner: { sessionId: SID, agentId: null, ref: REF, name: 'Owner A' }, results: { lint: { ok: false, message: 'a line is too long', at: w.clock.now() } } }))
  let waited = 0
  while (w.submits.length === before && waited < 3 * MIN) {
    await step(s, 5 * SECOND)
    waited += 5 * SECOND
  }
  say("a failed check on its file, no event: nudged after (ms)", waited)
  expect(waited).toBeLessThanOrEqual(65 * SECOND)
})

// ---- The numbers: host calls a minute by the peers' landings a minute ----

const TARGET: Record<Kind, Record<string, number>> = {
  // 0.14.1: 87, 334, 488, 641
  instance: { '0': 95, '7.5': 150, '20': 230, '60': 380 },
  // 0.14.1: 24, 54, 104, 264
  person: { '0': 27, '7.5': 55, '20': 95, '60': 165 },
  // 0.14.1: 202, 289, 413, 812 (its own passes after each landing are as they were; its listings aren't)
  sweeper: { '0': 210, '7.5': 300, '20': 420, '60': 790 },
}
for (const kind of ['instance', 'person', 'sweeper'] as const)
  for (const perMin of [0, 7.5, 20, 60])
    test(`a stream of ${perMin} landings a minute, ${kind}: its host calls a minute stay under ${TARGET[kind][String(perMin)]}`, LONG, async ($, on) => {
      const s = await session($, on, kind)
      const c = await stream($, s, perMin)
      say(`stream | ${kind} | ${perMin} landings a minute`, c)
      expect(c.total).toBeLessThanOrEqual(TARGET[kind][String(perMin)] as number)
      expect((await fleet($, 'status')).match(/live updates[^\n]*/)?.[0] ?? '').toContain('live updates: on')
      // The wakes' window opening is one timer on its way, not one a pass
      if (kind === 'instance' && perMin) expect(c.farTimers).toBeLessThanOrEqual(0.3)
    })

test('20 landings a minute with 1,200 events in this hour and the last: an idle instance lists this hour once a minute, the last one never (50,000 entries a minute before)', LONG, async ($, on) => {
  const s = await session($, on, 'instance', { hourEvents: 1200 })
  const c = await stream($, s, 20, 5)
  say('stream | instance | 20 landings a minute, 1,200 events in each hour folder', c)
  expect(c.hourLists).toBeLessThanOrEqual(1.5)
  expect(c.listEntries).toBeLessThanOrEqual(1700)
})

test('under the stream every landing is known, and one on a file it read still nudges once the window opens', LONG, async ($, on) => {
  const s = await session($, on, 'instance', { window: 'open' })
  const before = s.w.submits.length
  await stream($, s, 20, 2)
  expect(s.w.submits.length).toBe(before + 1)
  expect(s.w.submits[before]).toContain('- notes/n1.md: changed at')
})
