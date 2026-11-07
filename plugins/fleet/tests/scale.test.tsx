import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { FLEET, REF, ROOT, SID, fleet, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// What grows with the roster and the world (0.12.2): each count below was what main did, several times over (the budgets
// read every instance's spend in every instance, a Bash command that writes nothing walked the world twice, the
// sweeper looked at every record's versions at each pass, a start read 25 hours of events, the register stayed parsed)

const MIN = 60000
const HOUR = 3600000
const STATE = `${FLEET}/state`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const B = { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'TEST B' }
const CURRENT = { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null } }
const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, Bash, mcp__fleet__*\n---\nYou own a part of the notes.\n'

// In steps of a minute at most: one long advance fires thousands of timers at once
async function tick(w: World, ms = 2100) {
  for (let left = ms; left > 0; left -= MIN) {
    await w.clock.advance(Math.min(left, MIN))
    await w.clock.settle()
  }
}

async function call($: any, input: Record<string, unknown>): Promise<any> {
  return $.tool.call(input as any)
}

const reads = (w: World, test: (p: string) => boolean) => [...w.readCount].filter(([p]) => test(p)).reduce((a, [, n]) => a + n, 0)
const stats = (w: World, test: (p: string) => boolean) => [...w.statCount].filter(([p]) => test(p)).reduce((a, [, n]) => a + n, 0)

let n = 0
function eventOf(at: number, path: string, before: string | undefined, text: string) {
  return { format: 1, at, path, from: before === undefined ? null : hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: B }
}
function landByB(w: World, path: string, text: string) {
  const before = w.files.get(path)
  w.touch(path, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${++n}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify(eventOf(at, path.slice(ROOT.length + 1), before, text)))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}

// ---- Budgets: one summary, not every instance's spend in every instance ----

const N = 20
const slug = (i: number) => `owner-${i}`
function rosterOf(n: number, projectUsd = 200) {
  return JSON.stringify({
    rosterFormat: 1,
    sections: [{ id: 'owners', title: 'Owners' }],
    roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 5 } } },
    instances: Array.from({ length: n }, (_, i) => ({ name: `Owner ${i + 1}`, role: 'owner', section: 'owners' })),
    budget: { usdDay: projectUsd },
  })
}
const day = (at: number) => new Date(at).toISOString().slice(0, 10)

async function instanceOf($: any, on: any, projectUsd = 200) {
  const files: Record<string, string> = { [`${FLEET}/roster.json`]: rosterOf(N, projectUsd), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${ROOT}/notes/a.md`]: 'a\n' }
  for (let i = 1; i <= N; i++) files[`${FLEET}/instances/${slug(i)}.json`] = '{"env":{}}\n'
  const w = world(on, { worldPaths: ['notes/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner 1', FLEET_ROLE: 'owner' }, files })
  for (let i = 1; i <= N; i++) w.files.set(`${FLEET}/instances/${slug(i)}/spend.json`, JSON.stringify({ format: 1, slug: slug(i), day: day(w.clock.now()), usd: 1, at: w.clock.now() }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.25 } } }))
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Owner 1', root: ROOT, background: true, agent: 'owner' }, rows: { [REF]: row(REF, 'Owner 1', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner 2', 'idle') } })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  return w
}

// Another session sweeps: its lease, and its summary of today's spends, renewed as its fleet would
function otherSweeps(w: World, usd = 1) {
  const now = w.clock.now()
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner 2', at: now, remote: null }))
  const all: Record<string, number> = {}
  for (let i = 1; i <= N; i++) all[slug(i)] = usd
  w.touch(`${STATE}/spends.json`, JSON.stringify({ format: 1, day: day(now), at: now, usd: all }))
}

const peerSpends = (p: string) => /\/instances\/owner-(\d+)\/spend\.json$/.test(p) && !p.endsWith('/owner-1/spend.json')

test("an instance reads the sweeper's summary of the spends, not every instance's spend.json twice a minute", WITH_SESSIONS, async ($, on) => {
  const w = await instanceOf($, on)
  for (let i = 0; i < 3; i++) {
    otherSweeps(w)
    await tick(w, MIN)
  }
  w.readCount.clear()
  for (let i = 0; i < 10; i++) {
    otherSweeps(w)
    await tick(w, MIN)
  }
  // (every spend of the other 19, twice a minute: about 380 in ten minutes)
  expect(reads(w, peerSpends)).toBe(0)
  expect(reads(w, p => p === `${STATE}/spends.json`)).toBeGreaterThan(0)
})

test('near the project’s cap the summary is checked against every spend as it is now; with no summary, or a stale one, every spend is read', WITH_SESSIONS, async ($, on) => {
  // 20 × $9 = $180 of $200: past 80%, where the summary may lag a sweep
  const w = await instanceOf($, on)
  for (let i = 0; i < 2; i++) {
    otherSweeps(w, 9)
    await tick(w, MIN)
  }
  w.readCount.clear()
  otherSweeps(w, 9)
  await tick(w, 2 * MIN)
  expect(reads(w, peerSpends)).toBeGreaterThan(0)
  // A summary five minutes old (its sweeper gone): every spend again
  const w2Before = reads(w, peerSpends)
  w.touch(`${STATE}/spends.json`, JSON.stringify({ format: 1, day: day(w.clock.now()), at: w.clock.now() - 6 * MIN, usd: {} }))
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner 2', at: w.clock.now(), remote: null }))
  await tick(w, 2 * MIN)
  expect(reads(w, peerSpends)).toBeGreaterThan(w2Before)
})

test("the sweeper writes the summary of today's spends, by instance", WITH_SESSIONS, async ($, on) => {
  const files: Record<string, string> = { [`${FLEET}/roster.json`]: rosterOf(4), [`${ROOT}/.claude/agents/owner.md`]: OWNER }
  const w = world(on, { worldPaths: ['notes/**'], files })
  for (let i = 1; i <= 4; i++) w.files.set(`${FLEET}/instances/${slug(i)}/spend.json`, JSON.stringify({ format: 1, slug: slug(i), day: day(w.clock.now()), usd: i, at: w.clock.now() }))
  sessionsSay(w, CURRENT)
  await startSession($, w)
  await tick(w, 2 * MIN)
  const s = JSON.parse(w.files.get(`${STATE}/spends.json`) as string)
  expect(s).toMatchObject({ format: 1, day: day(w.clock.now()), usd: { 'owner-1': 1, 'owner-2': 2, 'owner-3': 3, 'owner-4': 4 } })
})

// ---- A Bash command that writes nothing: no walk of the world ----

test('a Bash command that writes nothing lists no folder of the world; a file it names and read that changed meanwhile is still told', WITH_SESSIONS, async ($, on) => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 200; i++) files[`${ROOT}/notes/f${i % 20}/n${i}.md`] = `note ${i}\n`
  const w = world(on, { worldPaths: ['notes/**'], files })
  sessionsSay(w, CURRENT)
  await startSession($, w)
  await tick(w, 1100)
  await call($, { tool: 'Read', file_path: `${ROOT}/notes/f1/n1.md` })
  const from = w.lists.length
  await call($, { tool: 'Bash', command: 'grep note notes/f2/n2.md' })
  // (two walks of 21 folders before)
  expect(w.lists.slice(from).filter(p => p.startsWith(`${ROOT}/notes`)).length).toBe(0)
  // Another session's write of a file the command names, that this thread read, lands while it runs
  w.bash.value = () => {
    w.touch(`${ROOT}/notes/f1/n1.md`, 'changed meanwhile\n')
  }
  const r = await call($, { tool: 'Bash', command: 'cat notes/f1/n1.md' })
  w.bash.value = () => {}
  expect((r.context ?? []).join('\n')).toContain('notes/f1/n1.md changed while your command ran')
})

// ---- The sweeper's record versions: trusted until an event says otherwise ----

test("the sweeper looks at a record's versions once, then again only when an event names it", WITH_SESSIONS, async ($, on) => {
  const files: Record<string, string> = {}
  for (let i = 1; i <= 40; i++) files[`${ROOT}/req/R-${i}.md`] = `R-${i}: a requirement\n`
  const w = world(on, { worldPaths: ['req/**'], files })
  sessionsSay(w, CURRENT)
  await startSession($, w)
  await tick(w, 3 * MIN)
  w.statCount.clear()
  await tick(w, 5 * MIN)
  // (a stat of each record's folder at every suspects pass: about 200 in five minutes)
  expect(stats(w, p => p.startsWith(`${STATE}/revs/R-`))).toBeLessThanOrEqual(5)
  // A landing of one names it: its folder is looked at again, and its new version counts
  const before = stats(w, p => p === `${STATE}/revs/R-7`)
  const text = 'R-7: a requirement, revised\n'
  w.touch(`${ROOT}/req/R-7.md`, text)
  const at = w.clock.now()
  w.touch(`${STATE}/revs/R-7/2.json`, JSON.stringify({ format: 1, id: 'R-7', path: 'req/R-7.md', rev: 2, hash: hashText(text), kind: 'revision', changeHash: null, at, by: B, via: 'tool', pins: [] }))
  const name = `${at}-bbbbbbbb-${++n}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ ...eventOf(at, 'req/R-7.md', 'R-7: a requirement\n', text), id: 'R-7', rev: 2, kind: 'revision' }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
  await tick(w, MIN)
  expect(stats(w, p => p === `${STATE}/revs/R-7`)).toBeGreaterThan(before)
})

// ---- A start: two hours of event files, the older ones from the sweeper's hourly index ----

function hourEvents(w: World, hourAt: number, count: number, extra: { path: string; before: string; text: string } | null = null) {
  const entries: [string, unknown][] = []
  for (let k = 0; k < count; k++) {
    const at = hourAt + k * 1000
    const name = `${at}-bbbbbbbb-${++n}.json`
    const ev = eventOf(at, `notes/busy${k % 5}.md`, `busy ${k}\n`, `busy ${k + 1}\n`)
    w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify(ev))
    entries.push([name, ev])
  }
  if (extra) {
    const at = hourAt + count * 1000
    const name = `${at}-bbbbbbbb-${++n}.json`
    const ev = eventOf(at, extra.path, extra.before, extra.text)
    w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify(ev))
    entries.push([name, ev])
  }
  return entries
}

test('a start reads two hours of event files; an older hour comes from its index, and a file its index misses is still read', WITH_SESSIONS, async ($, on) => {
  const old = `${ROOT}/notes/old.md`
  const w = world(on, { worldPaths: ['notes/**'], files: { [old]: 'old v1\n' } })
  const now = w.clock.now()
  const top = Math.floor(now / HOUR) * HOUR
  // 25 hours of another session's landings, 20 an hour; ten hours ago it changed a file this session read before
  for (let h = 0; h < 25; h++) {
    const hourAt = top - h * HOUR + 60000
    const entries = hourEvents(w, hourAt, 20, h === 10 ? { path: 'notes/old.md', before: 'old v1\n', text: 'old v2\n' } : null)
    if (h >= 2) w.touch(`${FLEET}/events/${hourFolder(hourAt)}/index`, JSON.stringify({ format: 1, hour: hourFolder(hourAt), entries: h === 5 ? entries.slice(1) : entries }))
  }
  w.files.set(old, 'old v2\n')
  w.files.set(`${FLEET}/reads/${SID}.json`, JSON.stringify({ format: 1, sessionId: SID, ref: REF, name: 'TEST A', at: now - 11 * HOUR, threads: { main: { 'notes/old.md': { v: hashText('old v1\n'), at: now - 11 * HOUR, told: hashText('old v1\n') } } } }))
  sessionsSay(w, CURRENT)
  await startSession($, w)
  await tick(w, 1100)
  // (every event file of 25 hours: about 500)
  const eventReads = reads(w, p => p.startsWith(`${FLEET}/events/`) && p.endsWith('.json'))
  expect(eventReads).toBeLessThanOrEqual(60)
  // The file the index of five hours ago leaves out was read
  const missed = [...w.files.keys()].filter(p => p.includes(`/events/${hourFolder(top - 5 * HOUR + 60000)}/`) && p.endsWith('.json')).sort()[0] as string
  expect(w.readCount.get(missed) ?? 0).toBe(1)
  // What changed ten hours ago under a file this session read is heard at its next step
  const step = await call($, { tool: 'Bash', command: 'ls' })
  expect((step.context ?? []).join('\n')).toContain('- notes/old.md: changed at')
})

test('the sweeper writes the index of each closed hour of the window, once', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${ROOT}/notes/a.md`]: 'a\n' } })
  const now = w.clock.now()
  const top = Math.floor(now / HOUR) * HOUR
  for (let h = 0; h < 6; h++) hourEvents(w, top - h * HOUR + 60000, 3)
  sessionsSay(w, CURRENT)
  await startSession($, w)
  await tick(w, 3 * MIN)
  for (let h = 2; h < 6; h++) {
    const ix = JSON.parse(w.files.get(`${FLEET}/events/${hourFolder(top - h * HOUR + 60000)}/index`) as string)
    expect(ix).toMatchObject({ format: 1, hour: hourFolder(top - h * HOUR + 60000) })
    expect(ix.entries.length).toBe(3)
  }
  // The two newest hours a start reads whole: no index
  expect(w.files.has(`${FLEET}/events/${hourFolder(now)}/index`)).toBe(false)
})

// ---- The register: let go once unused ----

test('the register read for /fleet stats is let go ten minutes after, and read again when asked', WITH_SESSIONS, async ($, on) => {
  const files: Record<string, string> = {}
  const month = new Date(Date.UTC(2026, 10, 2)).toISOString().slice(0, 7)
  for (let i = 1; i <= 30; i++) files[`${FLEET}/decisions/register/${month}/D-${i}.json`] = JSON.stringify({ registerFormat: 1, id: `D-${i}`, at: 1, closedAt: 2, state: 'answered', questions: [], answers: {} })
  const w = world(on, { files })
  sessionsSay(w, CURRENT)
  await startSession($, w)
  await tick(w, 1100)
  const one = `${FLEET}/decisions/register/${month}/D-1.json`
  await fleet($, 'stats')
  const first = w.readCount.get(one) ?? 0
  expect(first).toBeGreaterThan(0)
  await fleet($, 'stats')
  expect(w.readCount.get(one) ?? 0).toBe(first)
  await tick(w, 11 * MIN)
  await fleet($, 'stats')
  // (kept parsed for the life of the process before)
  expect(w.readCount.get(one) ?? 0).toBeGreaterThan(first)
})
