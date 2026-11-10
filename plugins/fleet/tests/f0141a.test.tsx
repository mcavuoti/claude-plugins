import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { DEC, FLEET, REF, ROOT, SID, decide, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// fleet 0.14.1: what a session start waits on, what a tool step costs while nothing it hears of moved, and the files
// an idle session looks for that aren't there. Each count below was the first number before: 3 waits in a row at
// start (444 ms measured), 33 host calls a Read, down.json/lifts.json/restart.json every 30-60 s, work.json in the
// person's session every 10 s

const MIN = 60000
const STATE = `${FLEET}/state`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const B = { ref: 'bbbbbbbb', sessionId: B_SID, name: 'Owner B', root: ROOT }
const GO = [{ question: 'Go ahead with the split?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'w' }]
const DAY = '2026-11-02'
const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, mcp__fleet__*\n---\nYou own a part of the notes.\n'
function roster(usdDay = 1) {
  return JSON.stringify({
    rosterFormat: 1,
    sections: [{ id: 'owners', title: 'Owners' }],
    roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay } } },
    instances: [
      { name: 'Owner A', role: 'owner', section: 'owners' },
      { name: 'Owner B', role: 'owner', section: 'owners' },
    ],
    budget: { usdDay: 50 },
  })
}
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }
const PERSON = { ready: true, ref: null, sessionId: SID, name: 'Person', root: ROOT, background: false, agent: null }

// The clock in steps of a second, the other sweeper renewing its lease every 20 s
async function run(w: World, ms: number) {
  for (let left = ms; left > 0; left -= 1000) {
    await w.clock.advance(Math.min(left, 1000))
    await w.clock.settle()
    if (w.clock.now() % 20000 < 1000) otherSweeps(w)
  }
}
function otherSweeps(w: World) {
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner B', at: w.clock.now(), remote: null }))
}
// Owner B lands a change to a shared file, as its fleet would: the file, its event, events/latest
function land(w: World, path: string, text: string, n: number) {
  const before = w.files.get(`${ROOT}/${path}`) ?? ''
  w.touch(`${ROOT}/${path}`, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${n}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path, from: hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'Owner B' } }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}
// What another session's fleet does after writing a file it rings for: the bell, and this session's watcher brings it
async function ring($: any, w: World, kind: string) {
  w.touch(`${FLEET}/bell/${kind}`, JSON.stringify({ format: 1, by: 'bbbbbbbb', at: w.clock.now() }))
  await $.classic.FileChanged({ file_path: `${FLEET}/bell/${kind}`, event: 'change' } as any)
  await w.clock.settle()
}
async function changed($: any, w: World, path: string) {
  await $.classic.FileChanged({ file_path: path, event: 'change' } as any)
  await w.clock.settle()
}
function closedRecord(id: string, at: number) {
  return JSON.stringify({ registerFormat: 1, id, source: 'decide', fleet: '0.14.0', at, asker: B, questions: GO, answers: [{ label: 'Yes', origin: 'composer', at }], state: 'delivered', delivered: { at, how: 'submit' }, closedAt: at })
}

// Host calls: every file operation and command fleet asked of the engine, and its $.state reads and writes
const STATE_OPS = { n: 0 }
function countState(on: any) {
  for (const ev of ['state.get', 'state.set'])
    on(ev as any, (_: any, e: any, next: any) => {
      STATE_OPS.n++
      return next(e)
    })
}
function hostCalls(w: World): number {
  let n = STATE_OPS.n
  for (const [k, v] of w.ops) if (!k.includes('/fake/')) n += v
  return n
}
function resetCounts(w: World) {
  w.ops.clear()
  STATE_OPS.n = 0
}
const absent = (w: World, path: string) => w.ops.get(`absent ${path}`) ?? 0
const readsOf = (w: World, path: string) => w.ops.get(`read ${path}`) ?? 0

/** Owner A, an instance of the roster, its watch proven (live updates on) unless live is false; Owner B sweeps */
async function instance($: any, on: any, opts: { live?: boolean; files?: Record<string, string>; cost?: { value: number }; usdDay?: number } = {}) {
  const notes: Record<string, string> = {}
  for (let i = 1; i <= 12; i++) notes[`${ROOT}/notes/n${i}.md`] = `note ${i}\n`
  const cost = opts.cost ?? { value: 0.25 }
  const w = world(on, {
    worldPaths: ['notes/**', 'board/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: {
      [`${FLEET}/roster.json`]: roster(opts.usdDay),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/seeds/owner.md`]: 'Plan your part.',
      [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n',
      [`${FLEET}/instances/owner-a/seed-${REF}.json`]: JSON.stringify({ format: 1, ref: REF, at: 1 }),
      ...notes,
      ...opts.files,
    },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: cost.value } } }))
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a9' }))
  countState(on)
  w.exec.value = argv => {
    if (argv[0] !== 'git') return undefined
    if (argv.includes('rev-parse')) return { exitCode: 0, stdout: `${ROOT}\n${ROOT}/.git\n${ROOT}/.git\n` }
    if (argv.includes('worktree')) return { exitCode: 0, stdout: `worktree ${ROOT}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n\n` }
    return { exitCode: 0, stdout: '' }
  }
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  otherSweeps(w)
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  await w.clock.settle()
  if (opts.live !== false) {
    // Claude brings the probe back: its watch is proven
    await run(w, 1100)
    await changed($, w, `${FLEET}/bell/probe`)
  }
  await run(w, MIN)
  return w
}

async function read($: any, i: number): Promise<string> {
  const r: any = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/n${i}.md` } as any)
  return (r.context ?? []).join('\n')
}

// ---- 1a: the tools in one wait ----

test("an instance's session start registers its six tools at once (one wait, not three in a row)", WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  expect(w.tools.map(t => t.name).sort()).toEqual(['confirm', 'decide', 'run', 'send', 'slot', 'taste'])
  expect(w.registering.peak).toBe(6)
  expect(w.tools.find(t => t.name === 'confirm')?.isDeferred).toBe(true)
})

test("the person's session registers taste and confirm together, and nothing an instance has", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'] })
  sessionsSay(w, { current: PERSON, rows: {} })
  await startSession($, w)
  expect(w.tools.map(t => t.name).sort()).toEqual(['confirm', 'taste'])
  expect(w.registering.peak).toBe(2)
})

// ---- 1b: a tool step's digest only when what it reads moved ----

test('live, a Read costs a third of its host calls once nothing it hears of moved (33 before), the first and one 10 s on reckoning the digest', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await w.clock.settle()
  const per: number[] = []
  for (let i = 1; i <= 6; i++) {
    resetCounts(w)
    await read($, i)
    await w.clock.settle()
    per.push(hostCalls(w))
  }
  // The first reckons it (the module's first step); the next ones skip it
  expect(per[0]).toBeGreaterThanOrEqual(25)
  for (const n of per.slice(1)) expect(n).toBeLessThanOrEqual(12)
  // DIGEST_FRESH_MS on, it's reckoned again
  await run(w, 10000)
  resetCounts(w)
  await read($, 7)
  expect(hostCalls(w)).toBeGreaterThanOrEqual(25)
})

test("live, a peer's landing on a file the thread read is told at its next step, with the watcher's event or before it; and once", WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await read($, 1)
  await read($, 2)
  expect(await read($, 3)).toBe('')
  // Its event: the watcher brings events/latest
  land(w, 'notes/n1.md', 'n1, by B\n', 1)
  await changed($, w, `${FLEET}/events/latest`)
  expect(await read($, 4)).toContain('notes/n1.md')
  expect(await read($, 5)).not.toContain('notes/n1.md')
  // Before its event comes: events/latest's time says a landing came that this session hasn't taken in
  await run(w, 1000)
  land(w, 'notes/n2.md', 'n2, by B\n', 2)
  expect(await read($, 6)).toContain('notes/n2.md')
  expect(await read($, 7)).toBe('')
})

test('live, a decision its work waits on is told at the next step once it closes (the queue folder moved)', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  const at = w.clock.now()
  w.touch(`${DEC}/queue/D-7.json`, JSON.stringify({ format: 1, fleet: '0.14.0', id: 'D-7', at, asker: B, questions: GO }))
  await changed($, w, `${DEC}/queue/D-7.json`)
  expect((await decide($, { kind: 'wait', id: 'D-7' })).result).toContain('is still open')
  expect(await read($, 1)).not.toContain('D-7')
  expect(await read($, 2)).not.toContain('D-7')
  // The person answers it in his session: the queue file goes, the register keeps it
  w.files.delete(`${DEC}/queue/D-7.json`)
  w.touch(`${DEC}/register/2026-11/D-7.json`, closedRecord('D-7', at))
  await changed($, w, `${DEC}/queue/D-7.json`)
  expect(await read($, 3)).toContain('D-7, which your work waits on, is settled')
  expect(await read($, 4)).not.toContain('D-7')
})

test('live, what no event tells of is told within 10 s: a decision closed with no event for it reaches a step 10 s on', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  const at = w.clock.now()
  w.touch(`${DEC}/queue/D-7.json`, JSON.stringify({ format: 1, fleet: '0.14.0', id: 'D-7', at, asker: B, questions: GO }))
  await changed($, w, `${DEC}/queue/D-7.json`)
  await decide($, { kind: 'wait', id: 'D-7' })
  expect(await read($, 1)).not.toContain('D-7')
  w.files.delete(`${DEC}/queue/D-7.json`)
  w.touch(`${DEC}/register/2026-11/D-7.json`, closedRecord('D-7', at))
  // No event (a watcher that missed it): the steps within DIGEST_FRESH_MS skip the digest
  expect(await read($, 2)).not.toContain('D-7')
  await run(w, 10000)
  expect(await read($, 3)).toContain('D-7, which your work waits on, is settled')
})

test('live, an item offered to it (work.json, and the work bell) is told at its next step', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  expect(await read($, 1)).toBe('')
  expect(await read($, 2)).toBe('')
  const now = w.clock.now()
  w.touch(`${ROOT}/board/B-4.md`, '# B-4\nfor: owner\nstatus: open\n')
  w.touch(`${STATE}/work.json`, JSON.stringify({ format: 1, at: now, unowned: { 'B-4': { for: 'owner', since: now - MIN, offers: [{ slug: 'owner-a', at: now }], round: 1 } }, capacity: { idle: ['Owner A'], unowned: 1, oldest: now - MIN, slotsFree: null, slotsTotal: null, runs: 0, unrecorded: 0, flags: [] } }))
  await ring($, w, 'work')
  expect(await read($, 3)).toContain('B-4 is open, nobody owns it')
  expect(await read($, 4)).not.toContain('B-4')
})

test('live, its budget used up (the person lowered it: lifts.json, the budget bell) is told at its next step', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  expect(await read($, 1)).toBe('')
  expect(await read($, 2)).toBe('')
  w.touch(`${STATE}/lifts.json`, JSON.stringify({ format: 1, day: DAY, instances: { 'owner-a': 0.1 } }))
  await ring($, w, 'budget')
  expect(await read($, 3)).toContain('is used up')
})

test('not live, every step reckons the digest: a decision closed with no event is told at the very next step', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, { live: false })
  await $.turn.start({ text: 'work', turnId: 't1' })
  const at = w.clock.now()
  w.touch(`${DEC}/queue/D-7.json`, JSON.stringify({ format: 1, fleet: '0.14.0', id: 'D-7', at, asker: B, questions: GO }))
  await decide($, { kind: 'wait', id: 'D-7' })
  expect(await read($, 1)).not.toContain('D-7')
  w.files.delete(`${DEC}/queue/D-7.json`)
  w.touch(`${DEC}/register/2026-11/D-7.json`, closedRecord('D-7', at))
  expect(await read($, 2)).toContain('D-7, which your work waits on, is settled')
})

// ---- 1c: the files an idle session looks for that aren't there ----

test('live and idle, an instance looks for down.json, lifts.json, its restart.json and its nudges.json at most once in two minutes', { ...WITH_SESSIONS, timeoutMs: 60000 }, async ($, on) => {
  const w = await instance($, on)
  await run(w, 3 * MIN)
  resetCounts(w)
  await run(w, 10 * MIN)
  for (const p of [`${STATE}/down.json`, `${STATE}/lifts.json`, `${FLEET}/instances/owner-a/restart.json`, `${FLEET}/instances/owner-a/nudges.json`]) expect(absent(w, p)).toBeLessThanOrEqual(5)
})

test("live and idle, the person's session in a project with no instances looks for work.json at most once in two minutes (every 10 s before)", { ...WITH_SESSIONS, timeoutMs: 60000 }, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { [`${FLEET}/roster.json`]: JSON.stringify({ rosterFormat: 1, sections: [], roles: {}, instances: [] }) } })
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  sessionsSay(w, { current: PERSON, rows: {} })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup' } as any)
  await run(w, 1100)
  await changed($, w, `${FLEET}/bell/probe`)
  await run(w, 3 * MIN)
  resetCounts(w)
  await run(w, 10 * MIN)
  expect(absent(w, `${STATE}/work.json`)).toBeLessThanOrEqual(5)
  expect(absent(w, `${STATE}/lifts.json`)).toBeLessThanOrEqual(5)
})

async function downFlow($: any, on: any, down: boolean): Promise<string[]> {
  const w = await instance($, on)
  await read($, 1)
  await run(w, 3 * MIN)
  // Its fleet found no down.json a while ago and remembers it
  expect(absent(w, `${STATE}/down.json`)).toBeGreaterThan(0)
  // The person, in his own session: /fleet down "Owner A" (down.json, then the budget bell)
  if (down) w.touch(`${STATE}/down.json`, JSON.stringify({ format: 1, instances: { 'owner-a': w.clock.now() } }))
  await ring($, w, 'budget')
  await run(w, 3000)
  const before = w.submits.length
  land(w, 'notes/n1.md', 'n1, by B\n', 1)
  await changed($, w, `${FLEET}/events/latest`)
  await run(w, 20000)
  return w.submits.slice(before).filter(s => s.includes('notes/n1.md'))
}
test('live, the control: not taken down, a landing on a file it read nudges the idle instance', WITH_SESSIONS, async ($, on) => {
  expect((await downFlow($, on, false)).length).toBe(1)
})
test('live, the first /fleet down of the project (down.json and its bell) holds that nudge 3 s later', WITH_SESSIONS, async ($, on) => {
  expect(await downFlow($, on, true)).toEqual([])
})

test('live, over its budget, the first lift of the day (lifts.json and its bell) lets a helper start at once', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, { cost: { value: 1.1 } })
  await run(w, 2 * MIN)
  const refused: any = await $.agent.spawn({ prompt: 'help me' } as any)
  expect(String(refused.deny ?? '')).toContain('no new helper starts')
  expect(absent(w, `${STATE}/lifts.json`)).toBeGreaterThan(0)
  w.touch(`${STATE}/lifts.json`, JSON.stringify({ format: 1, day: DAY, instances: { 'owner-a': 2.1 } }))
  await ring($, w, 'budget')
  const spawn: any = await $.agent.spawn({ prompt: 'help me' } as any)
  expect(spawn).toMatchObject({ agentId: 'a9' })
})

test('live, a file remembered missing whose bell never rang (a ring lost to a failed write) is looked for again within two minutes', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await run(w, 3 * MIN)
  const n = readsOf(w, `${STATE}/down.json`)
  w.touch(`${STATE}/down.json`, JSON.stringify({ format: 1, instances: { 'owner-b': w.clock.now() } }))
  await run(w, 2 * MIN + 5000)
  expect(readsOf(w, `${STATE}/down.json`)).toBeGreaterThan(n)
})
