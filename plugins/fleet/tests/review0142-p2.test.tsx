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
// Measured here (host calls: file reads, stats, lists, writes, commands, $.state gets and sets, $.sessions calls), per
// minute, 0.14.1 → 0.14.2, by the peers' landings a minute (0, 7.5, 20, 60), one in ten on a file the session read, its
// wakes' window shut:
//   an idle instance that doesn't sweep   82, 306, 472, 632 → 82, 108, 145, 170   (nudge passes 1, 8.5, 13, 13 →
//                                         1, 1, 1, 1; hour folders listed 0, 15, 40, 120 → 0, 1, 1, 1)
//   a person's session that doesn't sweep 24,  54, 104, 264 → 24,  50,  87, 111
//   the sweeper (a person's session)     202, 289, 413, 812 → 202, 290, 402, 760  (hour folders listed 0, 27, 52, 132 →
//                                         0, 6, 6, 6: its own passes after a landing are as they were)
// and with 1,200 events already in this hour's folder and the last one's, 20 landings a minute: 50,000 entries listed a
// minute → about 1,500 (this hour once a minute, the last one never)

declare const console: { log: (...a: unknown[]) => void }

const SECOND = 1000
const MIN = 60000
const STATE = `${FLEET}/state`
const HB = `${FLEET}/instances/owner-a`
const LATEST = `${FLEET}/events/latest`
// When the world's clock starts
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0)
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

async function session($: any, on: any, kind: Kind, opts: { n?: number; hourEvents?: number; window?: 'shut' | 'open'; files?: Record<string, string>; rosterExtra?: Record<string, unknown>; role?: Record<string, unknown>; worldJson?: Record<string, unknown>; live?: boolean; setup?: (w: World) => void } = {}): Promise<S> {
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
      // Its wakes' window: shut (nudged as the test begins, the default hour not over) unless open. There from the start:
      // one its fleet found missing isn't looked for again for ten minutes
      ...(isInstance ? { [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n', [`${HB}/seed-${REF}.json`]: JSON.stringify({ format: 1, ref: REF, at: 1 }), [`${HB}/nudges.json`]: JSON.stringify({ format: 1, day: '2026-11-02', count: 1, last: T0 - (opts.window === 'open' ? 3 * 60 * MIN : 0) }) } : {}),
      ...notes,
      ...opts.files,
    },
  })
  if (opts.worldJson) w.touch(`${FLEET}/world.json`, JSON.stringify({ worldFormat: 1, paths: ['notes/**', 'board/**'], ...opts.worldJson }))
  const s: S = { w, state: { get: 0, set: 0 }, sweeps: 'me' }
  opts.setup?.(w)
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
    // It read two shared files in an earlier turn
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/n1.md` } as any)
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/n2.md` } as any)
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

// ---- P2: an hour folder is recorded as "listed whole" before its events are taken. An event whose read failed during
// that listing (too many open files: the world's `unreadable`) is then skipped with its folder until the folder's time
// moves again or ten minutes pass, where 0.14.1 read it at the next landing ----

const HOUR_MS = 60 * MIN
const eventPath = (name: string) => `${FLEET}/events/${hourFolder(Number(name.split('-')[0]))}/${name}`

/** To three minutes before the next hour: a landing whose event can't be read for 90 s (a spell of EMFILE), another
 * that can, the spell over before the hour ends. Then the first landing of the next hour. The first event's name, and
 * when the next hour's landing came */
async function failedRead($: any, s: S): Promise<{ lost: string; from: number }> {
  const w = s.w
  land(w, 'notes/n19.md', 'first\n')
  await changed($, s, LATEST)
  await step(s, 5 * SECOND)
  const toHour = HOUR_MS - (w.clock.now() % HOUR_MS)
  await step(s, toHour - 3 * MIN)
  const at = w.clock.now()
  const lost = eventFile(w, 'notes/n24.md', hashText('unreadable for a while'), at)
  w.unreadable.add(eventPath(lost))
  latestAfter(w, [lost])
  await changed($, s, LATEST)
  await step(s, 2 * SECOND)
  land(w, 'notes/n25.md', 'readable\n')
  await changed($, s, LATEST)
  // Past the whole pull that follows the reads by chain (the minute's)
  await step(s, 90 * SECOND)
  w.unreadable.clear()
  expect(taken(w, lost)).toBe(true)
  const reads = w.readCount.get(eventPath(lost)) ?? 0
  // Into the next hour: its first landing
  await step(s, HOUR_MS - (w.clock.now() % HOUR_MS) + 30 * SECOND)
  land(w, 'notes/n26.md', 'the next hour\n')
  const from = w.clock.now()
  await changed($, s, LATEST)
  // (`taken` counts reads, failed ones too: from here, a read past those is the one that takes it in)
  ;(s as any).failedReads = reads
  return { lost, from }
}
const readAgain = (s: S, lost: string) => (s.w.readCount.get(eventPath(lost)) ?? 0) > ((s as any).failedReads as number)

test("P2: an event whose read failed once is read again within the minute of the next landing", LONG, async ($, on) => {
  const s = await session($, on, 'person')
  const { lost, from } = await failedRead($, s)
  while (!readAgain(s, lost) && s.w.clock.now() - from < 3 * MIN) await step(s, 5 * SECOND)
  say('P2: read again after (s) of the next landing', { after: (s.w.clock.now() - from) / SECOND, readAgain: readAgain(s, lost) })
  expect(readAgain(s, lost)).toBe(true)
  expect(s.w.clock.now() - from).toBeLessThanOrEqual(65 * SECOND)
})
