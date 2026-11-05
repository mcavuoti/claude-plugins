import { expect, test } from 'claude-code/testing'

import { heartbeatText, labelMinute, nextLabelChange, reloadDecision, storeNamespace, timeSince } from '../hooks/state'
import { bellOfKey, classify, directList, jobIds, listDrift, parseRegistry, SessionFiles, WATCH_SET, watchPaths, watchSetOf } from '../hooks/watch'
import { electLeader, LEADER_STALE_MS, leaderText, leads, parseLeader, PASS_MS } from '../hooks/leader'
import { DATA, ROOT, SID, SLOW, startSession, world, type World } from './world'

// What the panel learns by watching files (watch.ts): the paths it hands the engine at SessionStart, a row that changes
// within a file event with no command run, the bells other sessions ring, its own row from its own turns, the one
// session that leads the machine-wide work (leader.ts), and a session that came in by a reload reading on its short
// timer and saying so

const PANEL = { plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const BRAVO = 'bbbbbbbb-0000-0000-0000-000000000000'
const CHARLIE = 'cccccccc-0000-0000-0000-000000000000'
const REGISTRY = '/Users/x/.claude/sessions'
const JOBS = '/Users/x/jobs'
const MIN = 60000

type Session = { pid: number; sessionId: string; id?: string; status?: string; name: string; cwd?: string; kind?: string }
const SESSIONS: Session[] = [
  { pid: 4242, sessionId: SID, id: 'aaaaaaaa', status: 'idle', name: 'alpha' },
  { pid: 4243, sessionId: BRAVO, id: 'bbbbbbbb', status: 'idle', name: 'bravo' },
]

// Claude's registry file of a running session, as Claude writes it (plus the .key beside it), at the mocked time
function registryFile(w: World, s: Session) {
  const text = JSON.stringify({
    pid: s.pid,
    sessionId: s.sessionId,
    cwd: s.cwd ?? ROOT,
    kind: s.kind ?? 'bg',
    status: s.status ?? 'idle',
    statusUpdatedAt: w.clock.now(),
    name: s.name,
    ...(s.id ? { jobId: `${s.id}-0000-0000-0000-000000000000` } : {}),
    startedAt: 999_000_000,
    procStart: 'x',
  })
  w.write(`${REGISTRY}/${s.pid}.json`, text)
  w.write(`${REGISTRY}/${s.pid}.0a1b.key`, 'x')
}

// The same sessions as claude agents lists them (what the leader's listing answers)
function listed(sessions: Session[]): any[] {
  return sessions.map(s => ({ ...(s.id ? { id: s.id } : {}), sessionId: s.sessionId, cwd: s.cwd ?? ROOT, kind: (s.kind ?? 'bg') === 'bg' ? 'background' : 'interactive', status: s.status === 'shell' ? 'busy' : (s.status ?? 'idle'), pid: s.pid, name: s.name, startedAt: 999_000_000 }))
}

// A heartbeat in the data folder (alive/<sessionId>), written now
function heartbeat(w: World, sessionId: string, pid: number, version = '0.14.0') {
  w.write(`${DATA}/alive/${sessionId}`, heartbeatText({ pid, at: w.clock.now(), version, via: 'session.start' }))
}

// A file Claude or another session wrote, and the engine's event for it
async function changed($: any, w: World, path: string, text: string | null, event: 'change' | 'add' | 'unlink' = 'change') {
  if (text === null) w.files.delete(path)
  else w.write(path, text)
  await $.classic.FileChanged({ file_path: path, event })
  await w.clock.advance(50)
}

const runsOf = (w: World, program: string, arg?: string) => w.runs.filter(a => a[0] === program && (arg === undefined || a[1] === arg)).length
const listings = (w: World) => runsOf(w, '/bin/claude', 'agents')

// The panel's values as the mod writes them: how many writes of each, and the last value. seeds: what a module before
// this one left in the session's $.state (a reload keeps it), answered until the mod writes it
type Writes = { count: Record<string, number>; last: Record<string, any> }
function stateWrites(on: any, seeds: Record<string, unknown> = {}): Writes {
  const w: Writes = { count: {}, last: {} }
  const left = new Map(Object.entries(seeds))
  on('state.set', (_: any, e: any, next: any) => {
    if (e.plugin === 'sessions') {
      w.count[e.key] = (w.count[e.key] ?? 0) + 1
      w.last[e.key] = e.value
      left.delete(e.key)
    }
    return next(e)
  })
  on('state.get', (_: any, e: any, next: any) => (e.plugin === 'sessions' && left.has(e.key) ? { value: { value: left.get(e.key), version: 1 } } : next(e)))
  return w
}
const rowOf = (writes: Writes, sessionId: string) => (writes.last.rows ?? []).find((r: any) => r.sessionId === sessionId)
const colorOf = (writes: Writes, sessionId: string) => rowOf(writes, sessionId)?.color

// A session whose SessionStart came: the engine watches its paths
async function liveSession($: any, on: any, sessions: Session[] = SESSIONS, env: Record<string, string> = {}, sessionStart?: Record<string, unknown>) {
  const list = listed(sessions)
  const w = world(on, { list, env, sessionStart })
  for (const s of sessions) registryFile(w, s)
  const writes = stateWrites(on)
  const start: any = await $.classic.SessionStart({ source: 'startup', session_id: SID } as any)
  await startSession($, w)
  await w.clock.advance(100)
  return { w, writes, list, start }
}

// ---- The pure parts ----

test('watch paths: the registry, the bells, the inbox, the tell requests, pins.json and a background job of its own', () => {
  const l = { registry: '/Users/x/.claude/sessions', data: DATA, jobs: JOBS }
  expect(watchPaths(l, null)).toEqual(['/Users/x/.claude/sessions', `${DATA}/bell`, `${DATA}/inbox`, `${DATA}/tell`, `${JOBS}/pins.json`])
  expect(watchPaths(l, 'aaaaaaaa').at(-1)).toBe(`${JOBS}/aaaaaaaa/state.json`)
  // Never the service's whole folder (hundreds of folders, watched to every depth), nor an id that isn't one
  expect(watchPaths(l, '../x')).not.toContain(JOBS)
  expect(classify(`${REGISTRY}/4242.json`, l)).toEqual({ kind: 'registry', file: '4242.json' })
  expect(classify(`${REGISTRY}/4242.0a1b.key`, l)).toBeNull()
  expect(classify(`${DATA}/bell/${SID}`, l)).toEqual({ kind: 'bell', name: SID })
  expect(classify(`${DATA}/inbox/${SID}`, l)).toEqual({ kind: 'inbox', id: SID })
  expect(classify(`${DATA}/tell/aaaaaaaa/1-1.req`, l)).toEqual({ kind: 'tell', ref: 'aaaaaaaa', file: '1-1.req' })
  expect(classify(`${JOBS}/pins.json`, l)).toEqual({ kind: 'pins' })
  expect(classify(`${JOBS}/aaaaaaaa/state.json`, l)).toEqual({ kind: 'job', id: 'aaaaaaaa' })
  expect(classify('/Users/x/elsewhere/file', l)).toBeNull()
  // The set's number is read from a copy's own watch.ts; a copy from before has none
  expect(watchSetOf(`// x\nexport const WATCH_SET = ${WATCH_SET}\n`)).toBe(WATCH_SET)
  expect(watchSetOf(null)).toBe(0)
  expect(watchSetOf('const WATCH_SET = 7')).toBe(0)
})

test("Claude's registry read as claude agents lists it: shell is busy, spares and parked jobs left out, stopped jobs from their state", () => {
  const ok = parseRegistry(JSON.stringify({ pid: 4242, sessionId: SID, cwd: ROOT, kind: 'bg', status: 'shell', jobId: 'aaaaaaaa-1111', name: 'alpha', statusUpdatedAt: 5 }))
  expect('entry' in ok).toBe(true)
  expect(parseRegistry(JSON.stringify({ pid: 1, sessionId: SID, cwd: ROOT, spare: true }))).toEqual({ skip: 'spare' })
  expect(parseRegistry(JSON.stringify({ pid: 1, sessionId: SID, cwd: ROOT, parkedJobId: 'x' }))).toEqual({ skip: 'parked' })
  expect('problem' in parseRegistry('{"pid": 1, "sessionId": "s"')).toBe(true)
  expect('problem' in parseRegistry(JSON.stringify({ pid: 1, sessionId: SID }))).toBe(true)
  expect('problem' in parseRegistry(JSON.stringify({ pid: 1, sessionId: SID, cwd: ROOT, status: 'thinking' }))).toBe(true)
  const entry = 'entry' in ok ? ok.entry : null
  const stopped = new Map<string, any>([
    ['dddddddd', { sessionId: 'dddddddd-0000', cwd: ROOT, name: 'stopped one', state: 'done' }],
    ['aaaaaaaa', { sessionId: SID, cwd: ROOT, name: 'alpha' }],
    ['eeeeeeee', { name: 'no session id' }],
  ])
  const list = directList(entry ? [entry] : [], stopped)
  expect(list).toEqual([
    { sessionId: SID, cwd: ROOT, kind: 'background', pid: 4242, id: 'aaaaaaaa', status: 'busy', name: 'alpha', statusUpdatedAt: 5 },
    { id: 'dddddddd', sessionId: 'dddddddd-0000', cwd: ROOT, kind: 'background', name: 'stopped one', state: 'done' },
  ])
  expect(jobIds([{ name: 'aaaaaaaa' }, { name: 'pins.json' }, { name: '.draft-x' }, { name: 'bbbbbbbb/state.json' }])).toEqual(['aaaaaaaa', 'bbbbbbbb'])
})

test('the files in memory: only what moved is read, a file cut short twice is a problem, a session that left is said', () => {
  const files = new SessionFiles({ registry: REGISTRY, data: DATA, jobs: JOBS })
  const a = JSON.stringify({ pid: 4242, sessionId: SID, cwd: ROOT, kind: 'bg', status: 'idle', jobId: 'aaaaaaaa-1' })
  const listing = [
    { name: '4242.json', mtimeMs: 1, size: a.length },
    { name: '4242.0a1b.key', mtimeMs: 1, size: 1 },
  ]
  expect(files.toRead(listing)).toEqual(['4242.json'])
  let news = files.applyRegistry(listing, new Map([['4242.json', a]]), 10)
  expect([...news.changed]).toEqual([SID])
  expect(files.usable(SID, 0)).toBe(true)
  expect(files.toRead(listing)).toEqual([])
  // Busy, then cut short while Claude rewrites it: the session as read before stands, and it's read again
  const busy = a.replace('"idle"', '"busy"')
  news = files.applyRegistry([{ name: '4242.json', mtimeMs: 2, size: busy.length }], new Map([['4242.json', busy]]), 20)
  expect([...news.changed]).toEqual([SID])
  news = files.applyRegistry([{ name: '4242.json', mtimeMs: 3, size: 5 }], new Map([['4242.json', '{"pid']]), 30)
  expect(files.retry).toBe(true)
  expect(files.usable(SID, 0)).toBe(true)
  expect(files.list()[0].status).toBe('busy')
  news = files.applyRegistry([{ name: '4242.json', mtimeMs: 3, size: 5 }], new Map([['4242.json', '{"pid']]), 40)
  expect(files.usable(SID, 0)).toBe(false)
  expect(files.problem).toContain('4242.json')
  // Idle again: a turn ended; then gone: it left, with its job
  news = files.applyRegistry([{ name: '4242.json', mtimeMs: 4, size: a.length }], new Map([['4242.json', a]]), 50)
  expect(news.ended).toBe(true)
  expect(files.usable(SID, 0)).toBe(true)
  news = files.applyRegistry([], new Map(), 60)
  expect([...news.left]).toEqual(['aaaaaaaa'])
  expect(files.usable(SID, 0)).toBe(false)
  // A stopped job is looked at when new, when its session just left, and on a full pass
  expect(files.jobsToCheck(['aaaaaaaa'], false)).toEqual(['aaaaaaaa'])
  expect(files.jobMoved('aaaaaaaa', { mtimeMs: 1, size: 2 })).toBe(true)
  files.setJob('aaaaaaaa', { mtimeMs: 1, size: 2 }, { sessionId: SID, cwd: ROOT })
  expect(files.jobsToCheck(['aaaaaaaa'], false)).toEqual([])
  expect(files.jobsToCheck(['aaaaaaaa'], true)).toEqual(['aaaaaaaa'])
  expect(files.jobMoved('aaaaaaaa', { mtimeMs: 1, size: 2 })).toBe(false)
  expect(files.list()).toEqual([{ id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background' }])
})

test('bells: which a write of the store rings', () => {
  expect(bellOfKey(`state:${SID}`)).toBe(SID)
  expect(bellOfKey(`seen:${SID}`)).toBe(SID)
  expect(bellOfKey(`title:${SID}`)).toBe(SID)
  expect(bellOfKey(`answer:${SID}`)).toBe(`answer-${SID}`)
  expect(bellOfKey('waitingOnly')).toBe('prefs')
  expect(bellOfKey('collapsed')).toBe('prefs')
  expect(bellOfKey('marks:probe:x')).toBe('marks')
  expect(bellOfKey(`waiting:${SID}`)).toBeNull()
  expect(bellOfKey('list')).toBeNull()
})

test('the leader: the record while it runs, else the lowest pid; a crashed or stuck one is taken over', () => {
  const me = { pid: 4243, sessionId: BRAVO }
  const alpha = { pid: 4242, sessionId: SID }
  const now = 10_000_000
  // No record: the lowest pid among those that can lead
  expect(electLeader(me, [alpha, me], null, now)).toEqual({ lead: false, takeover: false, leader: 4242 })
  expect(electLeader(me, [me], null, now)).toEqual({ lead: true, takeover: false, leader: 4243 })
  // The record names a running one: it stays, whatever the pids
  const rec = (pid: number, at: number) => parseLeader(leaderText({ pid, sessionId: '', at }))
  expect(electLeader(alpha, [alpha, me], rec(4243, now - 1000), now).lead).toBe(false)
  // The recorded leader ended (gone from the registry, or its heartbeat stale): the next one takes over and lists
  expect(electLeader(me, [me], rec(4242, now - 1000), now)).toEqual({ lead: true, takeover: true, leader: 4243 })
  // Its record two passes old though it seems to run (stuck): the lowest of the others takes over
  expect(electLeader(me, [alpha, me], rec(4242, now - LEADER_STALE_MS), now)).toEqual({ lead: true, takeover: true, leader: 4243 })
  // This session's own record late (a pass after a sleep): it keeps leading
  expect(electLeader(alpha, [alpha, me], rec(4242, now - LEADER_STALE_MS - PASS_MS), now).lead).toBe(true)
  expect(parseLeader('nothing')).toBeNull()
  expect(leads('0.14.0')).toBe(true)
  expect(leads('0.13.7')).toBe(false)
  expect(leads('')).toBe(false)
})

test("the rows' next time change: the next minute under an hour, the next hour under a day, the minute ⧗ comes", () => {
  const now = 1000 * MIN + 30000
  expect(nextLabelChange([], now)).toBe(Infinity)
  expect(nextLabelChange([{ since: now - 5 * MIN }], now)).toBe(1001 * MIN)
  // 2 h 10 m old: at 3 h
  const since = now - (2 * 60 + 10) * MIN
  expect(nextLabelChange([{ since }], now)).toBe(Math.ceil((since + 3 * 60 * MIN) / MIN) * MIN)
  expect(nextLabelChange([{ since, staleFrom: now + 7 * MIN }], now)).toBe(1008 * MIN)
})

test('updating in place never crosses into a copy that watches another set of paths', () => {
  const base = { running: '0.14.0', runningDir: '/Users/x/.claude/plugins/cache/m/sessions/0.14.0', installed: { path: '/Users/x/.claude/plugins/cache/m/sessions/0.14.1', version: '0.14.1', since: 1 }, triedFor: '', status: 'idle', tasks: 0, paneFocused: false, fieldOpen: false }
  expect(reloadDecision({ ...base, watchSet: 1, installedWatchSet: 1 })).toBe('reload')
  expect(reloadDecision({ ...base, watchSet: 1, installedWatchSet: 2 })).toBe('no')
  // The copy before the set had a number
  expect(reloadDecision({ ...base, watchSet: 1, installedWatchSet: 0 })).toBe('no')
  expect(reloadDecision(base)).toBe('reload')
})

test("a test session's registry override keeps its data apart, and leaves the others' namespaces as they were", () => {
  const six = [undefined, '/Users/x/jobs', '/Users/x/daemon.log', '/bin/claude', undefined, undefined]
  expect(storeNamespace([...six, undefined])).toBe(storeNamespace(six))
  expect(storeNamespace([undefined, undefined, undefined, undefined, undefined, undefined, '/tmp/reg'])).toMatch(/^@[0-9a-f]{8}\/$/)
  expect(storeNamespace([undefined, undefined, undefined, undefined, undefined, undefined, undefined])).toBe('')
})

test("the leader's check: what the direct read and claude agents disagree on, counted", () => {
  const mine = [{ sessionId: 'a', pid: 1, status: 'idle' }, { sessionId: 'b', pid: 2, status: 'busy' }, { sessionId: 'c' }]
  expect(listDrift(mine, mine)).toBe('')
  expect(listDrift(mine, [mine[0], { sessionId: 'c' }, { sessionId: 'd' }])).toBe("1 only in Claude's files (crashed: swept now), 1 only in claude agents")
  expect(listDrift(mine, [{ ...mine[0], status: 'busy' }, mine[1], mine[2]])).toBe('1 with another process or status')
})

// ---- In a session ----

test('SessionStart hands the engine its paths, after those of the plugins beneath, and the session is live', async ($, on) => {
  const { start, w, writes } = await liveSession($, on, SESSIONS, { CLAUDE_JOB_DIR: '/Users/x/.claude/jobs/aaaaaaaa' }, { watchPaths: ['/Users/x/beneath'] })
  expect(start.watchPaths).toEqual(['/Users/x/beneath', REGISTRY, `${DATA}/bell`, `${DATA}/inbox`, `${DATA}/tell`, `${JOBS}/pins.json`, `${JOBS}/aaaaaaaa/state.json`])
  expect(writes.last.watching).toMatchObject({ set: WATCH_SET, sessionId: SID })
  const r: any = await $.command.run({ command: 'sessions', args: 'status', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as any)
  expect(r.text).toContain('Live: the engine watches')
  expect(r.text).toContain("the list from Claude's files")
  expect(w.toasts).toEqual([])
})

test('live: another session turning busy is drawn on its file event, with no command run and no short timer', SLOW, async ($, on) => {
  const { w, writes } = await liveSession($, on)
  await w.clock.advance(MIN + 10000)
  const agents = listings(w)
  const rows = writes.count.rows ?? 0
  expect(colorOf(writes, BRAVO)).toBe('green')
  // Claude rewrites bravo's file: the event comes, the row is blue 30 ms later
  registryFile(w, { ...SESSIONS[1]!, status: 'busy' })
  await $.classic.FileChanged({ file_path: `${REGISTRY}/4243.json`, event: 'change' })
  await w.clock.advance(50)
  expect(colorOf(writes, BRAVO)).toBe('blue')
  expect(writes.count.rows).toBe(rows + 1)
  expect(listings(w)).toBe(agents)
  // A .key file, or a session of another project, draws nothing
  await changed($, w, `${REGISTRY}/4243.0a1b.key`, 'y')
  registryFile(w, { pid: 5000, sessionId: CHARLIE, id: 'cccccccc', status: 'busy', name: 'elsewhere', cwd: '/Users/x/other' })
  await $.classic.FileChanged({ file_path: `${REGISTRY}/5000.json`, event: 'add' })
  await w.clock.advance(50)
  expect(writes.count.rows).toBe(rows + 1)
  // Idle, nothing happening: no ps, no store write of a listing, the leader's one listing a pass
  const ps = runsOf(w, 'ps')
  const before = listings(w)
  await w.clock.advance(5 * MIN)
  expect(listings(w) - before).toBeLessThanOrEqual(5)
  expect(listings(w) - before).toBeGreaterThanOrEqual(4)
  expect(runsOf(w, 'ps')).toBe(ps)
  expect(w.store.has('list')).toBe(false)
  expect(runsOf(w, 'mkdir') - runsOf(w, 'mkdir', '-p')).toBe(runsOf(w, 'rmdir'))
})

test("live: a session's bell reads its record again, and what changed in the store without one waits for the pass", SLOW, async ($, on) => {
  const { w, writes } = await liveSession($, on)
  await w.clock.advance(5000)
  expect(colorOf(writes, BRAVO)).toBe('green')
  // Bravo finished a turn: its record says so; with no bell nothing is read (the store is never watched)
  w.store.set(`state:${BRAVO}`, { finished: w.clock.now() })
  await w.clock.advance(5000)
  expect(colorOf(writes, BRAVO)).toBe('green')
  // Its bell: read again, done and unseen
  await changed($, w, `${DATA}/bell/${BRAVO}`, `format=3\nfrom=${BRAVO}\nat=1\n`)
  expect(colorOf(writes, BRAVO)).toBe('yellow')
  // Seen there, without a bell: the pass reads it
  w.store.set(`seen:${BRAVO}`, w.clock.now())
  await w.clock.advance(PASS_MS + 10000)
  expect(colorOf(writes, BRAVO)).toBe('green')
})

test("live: this session's own row from its own turn, before the registry says so", async ($, on) => {
  const { w, writes } = await liveSession($, on)
  await w.clock.advance(1000)
  expect(colorOf(writes, SID)).toBe('green')
  await $.turn.start({ turnId: 't1', text: 'go' } as any)
  await w.clock.advance(20)
  expect(colorOf(writes, SID)).toBe('blue')
  // The registry catches up (busy, then idle at the end)
  registryFile(w, { ...SESSIONS[0]!, status: 'busy' })
  await $.classic.FileChanged({ file_path: `${REGISTRY}/4242.json`, event: 'change' })
  await w.clock.advance(50)
  expect(colorOf(writes, SID)).toBe('blue')
})

test('live: a ccc request in the inbox is taken on its file event, not on a 0.5 s timer', async ($, on) => {
  const { w } = await liveSession($, on)
  await w.clock.advance(1000)
  const reply = `${DATA}/replies/r1`
  const opens = w.opens.length
  w.write(`${DATA}/inbox/${SID}`, `format=3\naction=focus\nat=${w.clock.now()}\ntty=/dev/ttys001\ntitle=alpha\nreply=${reply}\n`)
  await w.clock.advance(2000)
  // Not read: nothing tells it but the event
  expect(w.files.has(`${DATA}/inbox/${SID}`)).toBe(true)
  await $.classic.FileChanged({ file_path: `${DATA}/inbox/${SID}`, event: 'add' })
  await w.clock.advance(100)
  expect(w.files.has(`${DATA}/inbox/${SID}`)).toBe(false)
  expect(w.opens.slice(opens).some((o: any) => o.focus === true)).toBe(true)
})

test('live: the lowest pid leads, writes the record and lists once a pass; the next takes over when it ends', SLOW, async ($, on) => {
  const sessions: Session[] = [{ pid: 4200, sessionId: CHARLIE, id: 'cccccccc', status: 'idle', name: 'charlie' }, ...SESSIONS]
  const list = listed(sessions)
  const w = world(on, { list })
  for (const s of sessions) registryFile(w, s)
  heartbeat(w, CHARLIE, 4200)
  w.write(`${DATA}/leader.json`, leaderText({ pid: 4200, sessionId: CHARLIE, at: w.clock.now() }))
  await $.classic.SessionStart({ source: 'startup', session_id: SID } as any)
  await startSession($, w)
  await w.clock.advance(1000)
  // Charlie leads: this session doesn't list
  expect(listings(w)).toBe(0)
  heartbeat(w, CHARLIE, 4200)
  w.write(`${DATA}/leader.json`, leaderText({ pid: 4200, sessionId: CHARLIE, at: w.clock.now() }))
  await w.clock.advance(30000)
  expect(listings(w)).toBe(0)
  // Charlie ends: its file goes, and this session takes over at once, with a listing
  list.splice(0, 1)
  await changed($, w, `${REGISTRY}/4200.json`, null, 'unlink')
  await w.clock.advance(100)
  expect(listings(w)).toBe(1)
  expect(parseLeader(w.files.get(`${DATA}/leader.json`) ?? '')?.pid).toBe(4242)
})

test('live: a leader that crashed (its file stays, its heartbeat stops) is replaced and its row cleared within 3 minutes', SLOW, async ($, on) => {
  const sessions: Session[] = [{ pid: 4200, sessionId: CHARLIE, id: 'cccccccc', status: 'idle', name: 'charlie' }, ...SESSIONS]
  const list = listed(sessions)
  const w = world(on, { list })
  for (const s of sessions) registryFile(w, s)
  heartbeat(w, CHARLIE, 4200)
  w.write(`${DATA}/leader.json`, leaderText({ pid: 4200, sessionId: CHARLIE, at: w.clock.now() }))
  const writes = stateWrites(on)
  await $.classic.SessionStart({ source: 'startup', session_id: SID } as any)
  await startSession($, w)
  await w.clock.advance(1000)
  expect(colorOf(writes, CHARLIE)).toBe('green')
  expect(listings(w)).toBe(0)
  // Charlie is killed: nothing more from it (no heartbeat, no record), and its registry file stays until a listing
  list.splice(0, 1)
  const killed = w.clock.now()
  let cleared = 0
  for (let t = 0, seen = listings(w); t < 200 && !cleared; t++) {
    await w.clock.advance(1000)
    // A listing removes the registry file of a process that's gone, as Claude does: then its unlink's event
    if (listings(w) > seen && w.files.has(`${REGISTRY}/4200.json`)) {
      w.files.delete(`${REGISTRY}/4200.json`)
      await $.classic.FileChanged({ file_path: `${REGISTRY}/4200.json`, event: 'unlink' })
      await w.clock.advance(50)
    }
    seen = listings(w)
    if (colorOf(writes, CHARLIE) === undefined) cleared = w.clock.now()
  }
  expect(cleared).toBeGreaterThan(0)
  expect(cleared - killed).toBeLessThanOrEqual(3 * MIN)
  expect(parseLeader(w.files.get(`${DATA}/leader.json`) ?? '')?.pid).toBe(4242)
})

test('updated in place from an older version: the short timer, and the panel says live updates need a restart; /clear brings them', SLOW, async ($, on) => {
  const list = listed(SESSIONS)
  const w = world(on, { list })
  for (const s of SESSIONS) registryFile(w, s)
  // An older module drew in this session (its short id is there), and no SessionStart of this set came
  const writes = stateWrites(on, { shortId: 'aaaaaaaa' })
  await startSession($, w)
  await w.clock.advance(4000)
  expect(String(writes.last.notice)).toContain('Live updates off')
  // No silent staleness: the short timer reads the registry (no command), every 3 s
  registryFile(w, { ...SESSIONS[1]!, status: 'busy' })
  await w.clock.advance(3500)
  expect(colorOf(writes, BRAVO)).toBe('blue')
  const ui = await $.ui.mount(PANEL)
  expect(JSON.stringify(await ui.drawn())).toContain('Live updates off')
  await ui.unmount()
  // /clear: SessionStart with the new paths, live; the notice goes and the short timer stops
  await $.classic.SessionStart({ source: 'clear', session_id: SID } as any)
  await w.clock.advance(100)
  expect(String(writes.last.notice ?? '')).toBe('')
  registryFile(w, { ...SESSIONS[1]!, status: 'idle' })
  await w.clock.advance(10000)
  expect(colorOf(writes, BRAVO)).toBe('blue')
  await $.classic.FileChanged({ file_path: `${REGISTRY}/4243.json`, event: 'change' })
  await w.clock.advance(50)
  expect(colorOf(writes, BRAVO)).not.toBe('blue')
})

test('a reload of the same set keeps the panel live: the watching state stays with the session', async ($, on) => {
  const list = listed(SESSIONS)
  const w = world(on, { list })
  for (const s of SESSIONS) registryFile(w, s)
  const writes = stateWrites(on, { shortId: 'aaaaaaaa', watching: { set: WATCH_SET, sessionId: SID, at: 1 } })
  await startSession($, w)
  await w.clock.advance(4000)
  expect(String(writes.last.notice ?? '')).toBe('')
  // Live: a change waits for its event
  registryFile(w, { ...SESSIONS[1]!, status: 'busy' })
  await w.clock.advance(5000)
  expect(colorOf(writes, BRAVO)).toBe('green')
})

test("a registry file that isn't what the panel reads: the list the slow way, said in the panel", SLOW, async ($, on) => {
  const { w, writes } = await liveSession($, on)
  await w.clock.advance(1000)
  const agents = listings(w)
  w.write(`${REGISTRY}/4243.json`, JSON.stringify({ pid: 4243, sessionId: BRAVO, cwd: ROOT, status: 'pondering' }))
  await $.classic.FileChanged({ file_path: `${REGISTRY}/4243.json`, event: 'change' })
  await w.clock.advance(1000)
  expect(String(writes.last.notice)).toContain('slow way')
  await w.clock.advance(7000)
  expect(listings(w)).toBeGreaterThan(agents)
})

test("live: the rows' times move with one timer at the next minute, and nothing else is drawn", SLOW, async ($, on) => {
  const { w, writes } = await liveSession($, on)
  w.store.set(`state:${BRAVO}`, { finished: w.clock.now(), created: w.clock.now() })
  w.store.set(`seen:${BRAVO}`, w.clock.now() + 1)
  await changed($, w, `${DATA}/bell/${BRAVO}`, `format=3\nfrom=${BRAVO}\nat=1\n`)
  const rows = writes.count.rows ?? 0
  const time = () => rowOf(writes, BRAVO)?.time
  expect(rowOf(writes, BRAVO)).toMatchObject({ color: 'green', time: 'now' })
  // Three minutes with nothing happening: the time moves at each minute, by the clock alone
  const finished = Number((w.store.get(`state:${BRAVO}`) as any).finished)
  await w.clock.advance(3 * MIN)
  expect(time()).toBe(timeSince(finished, labelMinute(w.clock.now())))
  expect(time()).not.toBe('now')
  expect((writes.count.rows ?? 0) - rows).toBeGreaterThanOrEqual(2)
  expect((writes.count.rows ?? 0) - rows).toBeLessThanOrEqual(4)
})

const STARTER = {
  name: 'probe',
  register(on: any) {
    on('command.run', { command: 'probe' }, async ($: any, e: any) => {
      try {
        return { text: JSON.stringify(await $.sessions.start(JSON.parse(String(e.args)))) }
      } catch (err) {
        return { text: JSON.stringify({ threw: String(err) }) }
      }
    })
  },
}
test('live: a start another plugin queues runs at once, with no 0.5 s timer', { plugins: [STARTER] }, async ($, on) => {
  const { w } = await liveSession($, on)
  await w.clock.advance(1000)
  const r: any = await $.command.run({ command: 'probe', args: JSON.stringify({ name: 'helper', cwd: ROOT }), origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as any)
  expect(JSON.parse(r.text)).toEqual({ ok: true, queued: true })
  await w.clock.advance(10)
  expect(w.runs.some(a => a[0] === '/bin/claude' && a[1] === '--bg' && a.includes('helper'))).toBe(true)
})
