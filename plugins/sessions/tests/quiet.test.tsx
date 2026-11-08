import { expect, test } from 'claude-code/testing'

import { buildNotice, heartbeatText, labelMinute, listHolds, listSignature, LIST_MIN_MS, LIST_QUIET_MS, nextSeenCheck, parseNotice, parseShowing, parseWindows, planSwitch, sameData, sessionTags, showingRuns, showingText, usageSummaryOf, windowTargetText, type Showing } from '../hooks/state'
import { COMMAND, DATA, ROOT, SID, SLOW, startSession, world, type World } from './world'

// What the panel costs while nothing happens: it draws only what changed, reads the session list again only when
// Claude's files moved, runs ps and asks Terminal only for a session that a window could show, takes no lock with
// nothing to change, and the Enter switch closes the viewer before anything else

const PANEL = { plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const BRAVO = 'bbbbbbbb-0000-0000-0000-000000000000'
const REGISTRY = '/Users/x/.claude/sessions'
const MIN = 60000

// $.sessions from another plugin, as contract.test.tsx calls it
const PROBE = {
  name: 'probe',
  register(on: any) {
    on('command.run', { command: 'probe' }, async ($: any, e: any) => ({ text: JSON.stringify(await $.sessions.status(JSON.parse(String(e.args)))) }))
  },
}
async function probe($: any, input: unknown): Promise<any> {
  const r: any = await $.command.run({ command: 'probe', args: JSON.stringify(input), ...COMMAND })
  return JSON.parse(r.text)
}

function list(): any[] {
  return [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'alpha' },
    { id: 'bbbbbbbb', sessionId: BRAVO, cwd: ROOT, kind: 'background', status: 'idle', pid: 4243, name: 'bravo' },
  ]
}

const runsOf = (w: World, program: string, arg?: string) => w.runs.filter(a => a[0] === program && (arg === undefined || a[1] === arg)).length
const listings = (w: World) => runsOf(w, '/bin/claude', 'agents')

// The panel's values as the mod writes them ($.state.set, which draws their readers again on every write): how many
// writes of each, and the last value written
type Writes = { count: Record<string, number>; last: Record<string, any> }
function stateWrites(on: any): Writes {
  const w: Writes = { count: {}, last: {} }
  on('state.set', (_: any, e: any, next: any) => {
    if (e.plugin === 'sessions') {
      w.count[e.key] = (w.count[e.key] ?? 0) + 1
      w.last[e.key] = e.value
    }
    return next(e)
  })
  return w
}
const KEYS = ['rows', 'notice', 'summary', 'shortId', 'paneNote', 'usage', 'limits']
const versions = (w: Writes) => KEYS.map(k => w.count[k] ?? 0)

// Claude's registry of running sessions, as Claude writes it: one <pid>.json per running session, and a .key beside it
function registry(w: World, status = 'idle') {
  w.write(`${REGISTRY}/4242.json`, JSON.stringify({ pid: 4242, sessionId: SID, status }))
  w.write(`${REGISTRY}/4243.json`, JSON.stringify({ pid: 4243, sessionId: BRAVO, status: 'idle' }))
  w.write(`${REGISTRY}/4242.0a1b.key`, 'x')
}

test('equal data is equal whatever the order of its keys; undefined is no key', () => {
  expect(sameData({ a: 1, b: [1, { c: 'x' }] }, { b: [1, { c: 'x' }], a: 1 })).toBe(true)
  expect(sameData({ a: 1, b: undefined }, { a: 1 })).toBe(true)
  expect(sameData({ a: 1 }, { a: 2 })).toBe(false)
  expect(sameData([1, 2], [2, 1])).toBe(false)
  expect(sameData([1], { 0: 1 })).toBe(false)
  expect(sameData(null, {})).toBe(false)
  expect(sameData('', '')).toBe(true)
  expect(sameData({ a: null }, { a: undefined })).toBe(false)
})

test("the rows' times are reckoned at the minute", () => {
  expect(labelMinute(1_000_000_000)).toBe(999_960_000)
  expect(labelMinute(999_960_000)).toBe(999_960_000)
  expect(labelMinute(999_960_000 + 59_999)).toBe(999_960_000)
})

test("the list's signature: Claude's registry files (by name, time and size) and the service's job folders", () => {
  const reg = [
    { name: '4242.json', mtimeMs: 1, size: 100 },
    { name: '4243.json', mtimeMs: 2, size: 120 },
    { name: '4242.0a1b.key', mtimeMs: 3, size: 1 },
  ]
  const jobs = [{ name: 'aaaaaaaa' }, { name: 'pins.json' }]
  const sig = listSignature(reg, jobs, 4242)
  expect(sig).toMatch(/^2\./)
  // The same files in another order, and a .key that moved: the same signature
  expect(listSignature([reg[1]!, { ...reg[2]!, mtimeMs: 9 }, reg[0]!], [...jobs].reverse(), 4242)).toBe(sig)
  // A status change rewrites the file in place (its time moves); a session that starts or ends adds or removes one; a
  // job folder that goes (claude rm): each changes it
  expect(listSignature([{ ...reg[0]!, mtimeMs: 5 }, reg[1]!], jobs, 4242)).not.toBe(sig)
  expect(listSignature([reg[0]!], jobs, 4242)).not.toBe(sig)
  expect(listSignature(reg, [{ name: 'pins.json' }], 4242)).not.toBe(sig)
  // No file for this very session's process, or none at all: it can't tell
  expect(listSignature(reg, jobs, 4250)).toBe(null)
  expect(listSignature([], jobs, 0)).toBe(null)
  expect(listSignature(reg, jobs, 0)).toBe(sig)
})

test('a stored list holds while nothing moved, for 30 s; a change is listed, not twice within a second', () => {
  const c = { at: 1000, sig: 'a' }
  // Nothing moved
  expect(listHolds(c, 1000 + LIST_QUIET_MS - 1, 3500, 'a')).toBe(true)
  expect(listHolds(c, 1000 + LIST_QUIET_MS, 3500, 'a')).toBe(false)
  // Something moved
  expect(listHolds(c, 1000 + LIST_MIN_MS - 1, 3500, 'b')).toBe(true)
  expect(listHolds(c, 1000 + LIST_MIN_MS, 3500, 'b')).toBe(false)
  // Nothing to tell by (a list stored without a signature, or a registry that can't be read): by age
  expect(listHolds({ at: 1000 }, 4499, 3500, 'a')).toBe(true)
  expect(listHolds({ at: 1000 }, 4500, 3500, 'a')).toBe(false)
  expect(listHolds(c, 4499, 3500, null)).toBe(true)
  expect(listHolds(c, 4500, 3500, null)).toBe(false)
  // A caller that wants it fresher than the panel's pace gets exactly that; a slow listing's push back holds otherwise
  expect(listHolds(c, 1500, 0, 'a')).toBe(false)
  expect(listHolds(c, 2500, 2000, 'a')).toBe(true)
  expect(listHolds({ ...c, until: 90000 }, 60000, 3500, 'b')).toBe(true)
  expect(listHolds({ ...c, until: 90000 }, 60000, 2000, 'b')).toBe(false)
  // A caller fine with an older one (the cleanup's 10 s) keeps it while nothing moved, for 30 s at least
  expect(listHolds(c, 25000, 10000, 'a')).toBe(true)
  expect(listHolds(null, 0, 3500, 'a')).toBe(false)
})

test("the seen check's pace: at once after a finish, every 2 s for a minute, every 10 s to 10 minutes, then every 30 s", () => {
  const f = 1_000_000
  expect(nextSeenCheck(f, 0)).toBe(f)
  expect(nextSeenCheck(f, f - 1)).toBe(f)
  expect(nextSeenCheck(f, f + 5000)).toBe(f + 7000)
  expect(nextSeenCheck(f, f + 2 * MIN)).toBe(f + 2 * MIN + 10000)
  expect(nextSeenCheck(f, f + 11 * MIN)).toBe(f + 11 * MIN + 30000)
})

test("usage.py's answer as the panel keeps it: without the moment it ran, only in this format", () => {
  const d = { format: 3, generated: 123, today: '2026-01-02', hour: '2026-01-02T10', days: { '/Users/x/myapp': { '2026-01-02': [1, 2, 3, 4, 0] } }, hours: {} }
  expect(usageSummaryOf(d)).toEqual({ today: '2026-01-02', hour: '2026-01-02T10', days: d.days, hours: {} })
  expect(sameData(usageSummaryOf(d), usageSummaryOf({ ...d, generated: 456 }))).toBe(true)
  expect(usageSummaryOf({ ...d, format: 2 })).toBe(null)
  expect(usageSummaryOf({ ...d, days: null })).toBe(null)
  expect(usageSummaryOf('x')).toBe(null)
})

test('an idle panel writes nothing between minutes, and its rows at most once a minute', SLOW, async ($, on) => {
  const w = world(on, { list: list() })
  const writes = stateWrites(on)
  await startSession($, w)
  // Into a new minute, past the start's own writes (the width, the first rows)
  await w.clock.advance(labelMinute(w.clock.now()) + MIN + 1000 - w.clock.now())
  const before = versions(writes)
  // 50 s of refreshes every 3 s within the same minute: nothing written, so nothing drawn
  await w.clock.advance(50000)
  expect(versions(writes)).toEqual(before)
  // Ten minutes: the rows' times move once a minute at most
  await w.clock.advance(10 * MIN)
  const after = versions(writes)
  expect(after[0]! - before[0]!).toBeLessThanOrEqual(10)
  expect(after.slice(1)).toEqual(before.slice(1))
})

test('a row that changes is drawn at the next refresh', async ($, on) => {
  const sessions = list()
  const w = world(on, { list: sessions })
  const writes = stateWrites(on)
  await startSession($, w)
  await w.clock.advance(4000)
  const rows = writes.count.rows ?? 0
  sessions[1].status = 'waiting'
  await w.clock.advance(4000)
  expect(writes.count.rows).toBe(rows + 1)
  const ui = await $.ui.mount(PANEL)
  expect(JSON.stringify(await ui.drawn())).toContain('"error"')
  await ui.unmount()
})

test("the session list is read again only once Claude's registry moved, else every 30 s", SLOW, async ($, on) => {
  const w = world(on, { list: list() })
  registry(w)
  await startSession($, w)
  await w.clock.advance(4000)
  const first = listings(w)
  // Nothing moved: 20 s of refreshes read no new list (with no registry to go by it was every 3.5 s), and a .key file
  // beside it doesn't count
  await w.clock.advance(17000)
  w.write(`${REGISTRY}/4243.0a1b.key`, 'y')
  await w.clock.advance(3000)
  expect(listings(w)).toBe(first)
  // A session turns busy: Claude rewrites its file, and the next refresh lists
  w.write(`${REGISTRY}/4242.json`, JSON.stringify({ pid: 4242, sessionId: SID, status: 'busy' }))
  await w.clock.advance(3000)
  expect(listings(w)).toBe(first + 1)
  // Quiet again: one more within 30 s, for a session that may have crashed (only a listing sweeps its file)
  const second = listings(w)
  await w.clock.advance(27000)
  expect(listings(w)).toBe(second)
  await w.clock.advance(6000)
  expect(listings(w)).toBe(second + 1)
})

test("with no file for this session's process in Claude's registry, the list goes by its age, as before", SLOW, async ($, on) => {
  const w = world(on, { list: list() })
  w.write(`${REGISTRY}/9999.json`, '{}')
  await startSession($, w)
  await w.clock.advance(4000)
  const first = listings(w)
  await w.clock.advance(21000)
  expect(listings(w) - first).toBeGreaterThanOrEqual(4)
})

test('seen: a session whose answer was seen runs no check at all', SLOW, async ($, on) => {
  const w = world(on, { list: list(), store: { [`state:${SID}`]: { finished: 999_000_000 }, [`seen:${SID}`]: 999_500_000 } })
  w.ps.value = '  101 ttys001  claude attach aaaaaaaa'
  await startSession($, w)
  await w.clock.advance(2 * MIN)
  expect(runsOf(w, 'ps')).toBe(0)
  expect(runsOf(w, 'osascript')).toBe(0)
})

test('seen: an answer nobody saw for a while is checked every 30 s, with one ps shared for 30 s and no question to Terminal without a window', SLOW, async ($, on) => {
  const w = world(on, { list: list(), store: { [`state:${SID}`]: { finished: 1_000_000_000 - 20 * MIN } } })
  await startSession($, w)
  await w.clock.advance(2 * MIN)
  // Every 2 s before: 60 ps a minute
  expect(runsOf(w, 'ps')).toBeLessThanOrEqual(5)
  expect(runsOf(w, 'osascript')).toBe(0)
  // Another session's listing a moment ago serves this one
  const ps = runsOf(w, 'ps')
  w.store.set('windowsList', { at: w.clock.now() + 40000, windows: { byId: {}, byPid: {}, agentsViews: [], clients: {}, launchers: {} } })
  await w.clock.advance(35000)
  expect(runsOf(w, 'ps')).toBe(ps)
})

test('seen: arriving (ccc) or a key in the panel marks it seen at once, with no ps and no question to Terminal', async ($, on) => {
  const w = world(on, { list: list(), store: { [`state:${SID}`]: { finished: 1_000_000_000 - 20 * MIN } } })
  await startSession($, w)
  await w.clock.advance(1000)
  const ps = runsOf(w, 'ps')
  w.files.set(`${DATA}/inbox/${SID}`, `format=3\naction=focus\nat=${w.clock.now()}\n`)
  await w.clock.advance(600)
  expect(Number(w.store.get(`seen:${SID}`))).toBeGreaterThan(0)
  expect(runsOf(w, 'ps')).toBe(ps)
  expect(runsOf(w, 'osascript')).toBe(0)
  // A new answer, then the arrows in this session's panel
  w.store.set(`state:${SID}`, { finished: w.clock.now() + 1 })
  await w.clock.advance(4000)
  const seen = Number(w.store.get(`seen:${SID}`))
  await $.ui.focus({ component: 'Pane', requestId: 'sessions', plugin: 'sessions', element: `s:${BRAVO}`, origin: { kind: 'person' } } as any)
  await w.clock.settle()
  expect(Number(w.store.get(`seen:${SID}`))).toBeGreaterThan(seen)
})

const asked = (w: World) => w.runs.filter(a => a[0] === 'osascript').map(a => a[2])
const VIEW_TEXT = '● bravo  idle  ⟨bbbbbbbb⟩\n● alpha  done  ⟨aaaaaaaa⟩ ⟨bbbbbbbb⟩'

test('the sessions a window shows, by their ⟨id⟩ tags', () => {
  expect(sessionTags(VIEW_TEXT)).toEqual(['bbbbbbbb', 'aaaaaaaa'])
  expect(sessionTags('no tags ⟨⟩ ⟨two words⟩')).toEqual([])
})

test("seen with an agent view in front: one question to Terminal and one read of the view's text, shared as the tags it shows", async ($, on) => {
  const w = world(on, { list: list(), store: { [`state:${SID}`]: { finished: 999_999_000 } } })
  w.ps.value = '  101 ttys001  claude agents'
  w.terminal.value = args => (args[0] === 'frente' ? 'true /dev/ttys001' : args[0] === 'leer' ? VIEW_TEXT : '')
  await startSession($, w)
  await w.clock.advance(3000)
  expect(Number(w.store.get(`seen:${SID}`))).toBeGreaterThan(0)
  expect(asked(w)).toEqual(['frente', 'leer'])
  expect(w.store.get('frontWindow')).toEqual({ at: expect.any(Number), tty: '/dev/ttys001', tags: ['bbbbbbbb', 'aaaaaaaa'] })
})

test("seen: another session's answer about an agent view in front serves this one with no question, unless it lacks the view's tags", async ($, on) => {
  const w = world(on, { list: list(), store: { [`state:${SID}`]: { finished: 999_999_000 } } })
  w.ps.value = '  101 ttys001  claude agents'
  w.terminal.value = args => (args[0] === 'frente' ? 'true /dev/ttys002' : '')
  await startSession($, w)
  await w.clock.advance(6000)
  expect(w.store.get(`seen:${SID}`)).toBe(undefined)
  const before = asked(w).length
  // An answer a moment ago, the view showing this session: seen, nothing asked
  w.store.set('frontWindow', { at: w.clock.now() + 1000, tty: '/dev/ttys001', tags: ['aaaaaaaa'] })
  await w.clock.advance(2000)
  expect(Number(w.store.get(`seen:${SID}`))).toBeGreaterThan(0)
  expect(asked(w).length).toBe(before)
  // A new answer of its own, and one with no tags: this session asks, and reads the view itself
  w.store.set(`state:${SID}`, { finished: w.clock.now() + 1 })
  w.terminal.value = args => (args[0] === 'frente' ? 'true /dev/ttys001' : args[0] === 'leer' ? 'nothing here' : '')
  await w.clock.advance(100)
  w.store.set('frontWindow', { at: w.clock.now(), tty: '/dev/ttys001' })
  await w.clock.advance(2000)
  expect(asked(w).slice(before)).toEqual(['frente', 'leer'])
  expect((w.store.get('frontWindow') as any).tags).toEqual([])
})

test('seen: while another session asks Terminal (pendingAt), this one asks nothing; a marker older than 20 s is ignored', SLOW, async ($, on) => {
  const now = 1_000_000_000
  const w = world(on, { list: list(), store: { [`state:${SID}`]: { finished: now - 1000 }, frontWindow: { at: now - 5000, tty: '/dev/ttys002', pendingAt: now } } })
  w.ps.value = '  101 ttys001  claude attach aaaaaaaa'
  w.terminal.value = args => (args[0] === 'frente' ? 'true /dev/ttys001' : '')
  await startSession($, w)
  await w.clock.advance(15000)
  expect(asked(w)).toEqual([])
  expect(w.store.get(`seen:${SID}`)).toBe(undefined)
  // Its answer never came (cut off): past 20 s this session asks, and its viewer is in front
  await w.clock.advance(8000)
  expect(asked(w)).toEqual(['frente'])
  expect(Number(w.store.get(`seen:${SID}`))).toBeGreaterThan(0)
})

test('seen: a slow Terminal\'s answer is stamped when it came back, and says meanwhile that a session is asking', async ($, on) => {
  const w = world(on, { list: list(), store: { [`state:${SID}`]: { finished: 999_999_000 } } })
  w.ps.value = '  101 ttys001  claude attach aaaaaaaa'
  w.terminal.value = args => (args[0] === 'frente' ? 'true /dev/ttys002' : '')
  w.terminalLate.value = 3000
  await startSession($, w)
  // The first check, on the 2 s timer
  await w.clock.advance(2100)
  const asking = w.store.get('frontWindow') as any
  expect(typeof asking?.pendingAt).toBe('number')
  expect(asking.at).toBe(undefined)
  await w.clock.advance(3000)
  expect(w.store.get('frontWindow')).toEqual({ at: asking.pendingAt + 3000, tty: '/dev/ttys002' })
})

test('a failing claude --version or plugin list is tried again 5 minutes later, not at every refresh, keeping what it had', SLOW, async ($, on) => {
  const now = 1_000_000_000
  const plugin = { path: '/Users/x/plugins/sessions', version: '0.14.0', since: 1 }
  const w = world(on, { list: list(), store: { installed: { at: now - 6 * MIN, version: '2.1.300' }, plugin: { at: now - 6 * MIN, plugin } } })
  w.installedFail.value = true
  await startSession($, w)
  await w.clock.advance(2 * MIN)
  // Every 3 s before: about 40 of each in these two minutes
  expect(runsOf(w, '/bin/claude', '--version')).toBe(1)
  expect(runsOf(w, '/bin/claude', 'plugin')).toBe(1)
  expect(w.store.get('installed')).toEqual({ at: expect.any(Number), version: '2.1.300' })
  expect(w.store.get('plugin')).toEqual({ at: expect.any(Number), plugin })
  expect((w.store.get('installed') as any).at).toBeGreaterThanOrEqual(now)
  await w.clock.advance(4 * MIN)
  expect(runsOf(w, '/bin/claude', '--version')).toBe(2)
  expect(runsOf(w, '/bin/claude', 'plugin')).toBe(2)
  // Working again: the next one stores what it says
  w.installedFail.value = false
  await w.clock.advance(5 * MIN)
  expect((w.store.get('installed') as any).version).toBe('2.1.316')
})

test('while another session runs claude --version or plugin list (pendingAt), this one runs neither and uses what is stored', SLOW, async ($, on) => {
  const now = 1_000_000_000
  const w = world(on, { list: list(), store: { installed: { at: now - 6 * MIN, version: '2.1.300', pendingAt: now - 1000 }, plugin: { pendingAt: now - 1000 } } })
  await startSession($, w)
  await w.clock.advance(20000)
  expect(runsOf(w, '/bin/claude', '--version')).toBe(0)
  expect(runsOf(w, '/bin/claude', 'plugin')).toBe(0)
  // That session's version lands; its plugin list never does (it was cut off): past 30 s this one lists
  w.store.set('installed', { at: w.clock.now(), version: '2.1.320' })
  await w.clock.advance(15000)
  expect(runsOf(w, '/bin/claude', '--version')).toBe(0)
  expect(runsOf(w, '/bin/claude', 'plugin')).toBe(1)
})

test("claude plugin list's answer is stamped when it came back, and says meanwhile that a session runs it", async ($, on) => {
  const w = world(on, { list: list() })
  w.installedLate.value = 4000
  await startSession($, w)
  await w.clock.advance(100)
  const running = w.store.get('plugin') as any
  expect(typeof running?.pendingAt).toBe('number')
  await w.clock.advance(4000)
  expect(w.store.get('plugin')).toEqual({ at: running.pendingAt + 4000, plugin: null })
})

test('the pins pass takes no lock when nothing is to pin, unpin or record', SLOW, async ($, on) => {
  const w = world(on, { list: list() })
  w.files.set('/Users/x/jobs/pins.json', '[]')
  await startSession($, w)
  await w.clock.advance(100)
  // The first pass records what the mod pinned (nothing), under the lock; the next ones have nothing to do
  const locks = () => w.runs.filter(a => a[0] === 'mkdir' && a[1] === '/Users/x/jobs/pins.json.lock').length
  const first = locks()
  await w.clock.advance(2 * MIN)
  expect(locks()).toBe(first)
  // Remote Control turned on in bravo: pinned, under the lock
  w.write('/Users/x/jobs/bbbbbbbb/state.json', '{"bridgeSessionId": "x"}')
  await w.clock.advance(25000)
  expect(locks()).toBeGreaterThan(first)
  expect(JSON.parse(w.files.get('/Users/x/jobs/pins.json') ?? '[]')).toEqual(['bbbbbbbb'])
})

test('with no pinned session lacking a process, the reopen pass reads no memory and takes no lock', SLOW, async ($, on) => {
  const w = world(on, { list: list() })
  w.files.set('/Users/x/daemon.log', '')
  await startSession($, w)
  await w.clock.advance(2 * MIN)
  expect(runsOf(w, 'sysctl')).toBe(0)
  expect(w.runs.some(a => a[0] === 'mkdir' && a[1] === `${DATA}/reopen.lock`)).toBe(false)
})

test("the service's log is read again only when it changed", { plugins: [PROBE] }, async ($, on) => {
  const sessions = [...list(), { id: 'dddddddd', sessionId: 'dddddddd-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', name: 'stopped one' }]
  const w = world(on, { list: sessions })
  w.write('/Users/x/daemon.log', '[1970-01-12T13:00:00.000Z] [bg] bg retire dddddddd: idle-prompt\n')
  await startSession($, w)
  await w.clock.advance(4000)
  const status = async () => (await probe($, { refs: ['dddddddd'] })).rows[0]?.stopped
  expect(await status()).toBe('idle')
  const tails = runsOf(w, 'tail')
  expect(await status()).toBe('idle')
  expect(runsOf(w, 'tail')).toBe(tails)
  w.write('/Users/x/daemon.log', '[1970-01-12T13:00:00.000Z] [bg] bg retire dddddddd: idle-prompt\n[1970-01-12T13:01:00.000Z] [bg] something else\n')
  expect(await status()).toBe('idle')
  expect(runsOf(w, 'tail')).toBe(tails + 1)
})

test('usage: a summary another session left a moment ago is used as it is, and an equal one changes nothing', SLOW, async ($, on) => {
  const w = world(on, { list: list() })
  const writes = stateWrites(on)
  const summary = { format: 3, today: '1970-01-12', hour: '1970-01-12T13', days: { [ROOT]: { '1970-01-12': [1000, 2000, 0, 0, 0] } }, hours: {} }
  w.write(`${DATA}/usage/summary.json`, JSON.stringify(summary))
  await startSession($, w)
  await w.clock.advance(1000)
  // No python looked for, nothing run: the summary is the panel's
  expect(w.runs.some(a => a[0] === '/bin/sh' && String(a[2]).includes('python3'))).toBe(false)
  expect(writes.last.usage.summary).toEqual({ today: '1970-01-12', hour: '1970-01-12T13', days: summary.days, hours: {} })
  const used = writes.count.usage
  // The next minute's reading finds the same totals (the file touched by another session's run of usage.py a moment
  // before): not written again
  await w.clock.advance(55000)
  w.write(`${DATA}/usage/summary.json`, JSON.stringify(summary))
  await w.clock.advance(5000)
  expect(writes.count.usage).toBe(used)
  // New totals are
  await w.clock.advance(55000)
  w.write(`${DATA}/usage/summary.json`, JSON.stringify({ ...summary, days: { [ROOT]: { '1970-01-12': [1500, 2000, 0, 0, 0] } } }))
  await w.clock.advance(5000)
  expect(writes.count.usage).toBe(used! + 1)
})

test('Enter: one ps for the whole switch, and the viewer closed before the arrival notice goes', async ($, on) => {
  const w = world(on, { list: list() })
  w.files.set(`${DATA}/alive/${BRAVO}`, heartbeatText({ pid: 4243, at: w.clock.now() + 600000, version: '0.13.2', via: 'session.start' }))
  w.ps.value = '  100 ttys001  bash /Users/x/p/hooks/visor.sh start\n  101 ttys001  claude attach aaaaaaaa'
  w.terminal.value = (args: string[]) => (args[0] === 'frente' ? 'true /dev/ttys001' : '')
  const notices: { kind: string; at: number }[] = []
  on('session.send', (_: any, e: any) => {
    const n = parseNotice(String(e.text))
    if (n) notices.push({ kind: n.kind, at: w.runs.length })
    return { isDelivered: true }
  })
  await startSession($, w)
  await w.clock.advance(4000)
  const pane = w.panes.find((p: any) => p.id === 'sessions')
  pane.isFocused = true
  const ui = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, isFocused: true } })
  const from = w.runs.length
  await ui.press({ key: `s:${BRAVO}` })
  await w.clock.settle()
  await ui.unmount()
  const kill = w.runs.findIndex((a, i) => i >= from && a[0] === 'kill')
  expect(w.runs[kill]).toEqual(['kill', '-HUP', '101'])
  expect(w.runs.slice(from, kill).filter(a => a[0] === 'ps')).toHaveLength(1)
  expect(w.files.get(`${DATA}/windows/_dev_ttys001`)).toContain('id=bbbbbbbb\n')
  const focus = notices.find(n => n.kind === 'focus')
  expect(focus).toBeDefined()
  expect(focus!.at).toBeGreaterThan(kill)
})

// A window opened with ccc whose launcher says what it shows (<data>/windows/<tty>.showing): its launcher, viewer and
// watcher as ps lists them, and that file
const shows = (tty: string, id: string, launcher: number): Showing => ({ tty, command: 'attach', id, viewer: String(launcher + 1), launcher: String(launcher), watcher: String(launcher + 2) })
const psOf = (s: Showing) =>
  [
    `  ${s.launcher} ${s.tty.slice(5)}  bash /Users/x/p/hooks/visor.sh start`,
    `  ${s.viewer} ${s.tty.slice(5)}  claude attach ${s.id}`,
    `  ${s.watcher} ${s.tty.slice(5)}  /usr/bin/python3 /Users/x/p/hooks/launcher.py watch --file /x --launcher ${s.launcher}`,
  ].join('\n')
const showingFile = (tty: string) => `${DATA}/windows/${tty.replace(/\//g, '_')}.showing`
const launched = (w: World, s: Showing) => w.files.set(showingFile(s.tty), showingText(s))
const ME = shows('/dev/ttys001', 'aaaaaaaa', 100)

// Enter on bravo's row with the keyboard in the panel (keyboard false: a click on it, the panel without the keyboard);
// where the press's commands start, and the notices sent (with the number of commands that had run by then)
async function enterOnBravo($: any, w: World, on: any, keyboard = true) {
  w.files.set(`${DATA}/alive/${BRAVO}`, heartbeatText({ pid: 4243, at: w.clock.now() + 600000, version: '0.13.2', via: 'session.start' }))
  const notices: { kind: string; at: number }[] = []
  on('session.send', (_: any, e: any) => {
    const n = parseNotice(String(e.text))
    if (n) notices.push({ kind: n.kind, at: w.runs.length })
    return { isDelivered: true }
  })
  await startSession($, w)
  await w.clock.advance(4000)
  w.panes.find((p: any) => p.id === 'sessions').isFocused = keyboard
  const ui = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, isFocused: keyboard } })
  const from = w.runs.length
  await ui.press({ key: `s:${BRAVO}` })
  await w.clock.settle()
  await ui.unmount()
  return { from, notices }
}

// Arriving by a click marks the target seen, with the keyboard left where it is: the switch sends 'seen' where Enter
// sends 'focus', whichever way the window goes there (a launcher window's file, the usual ps and kill, a regular
// session's own window brought forward)
for (const way of ['launcher', 'usual', 'regular'] as const) {
  for (const keyboard of [true, false]) {
    test(`${keyboard ? 'Enter' : 'a click'} on a row (${way === 'launcher' ? 'a window whose launcher says what it shows' : way === 'usual' ? 'the usual way' : "a regular session's own window"}): the target is told ${keyboard ? "you came with the keyboard (focus), and nothing else" : 'you arrived (seen), and not to take the keyboard'}`, async ($, on) => {
      const regular = way === 'regular'
      const w = world(on, { list: list().map(s => (regular && s.sessionId === BRAVO ? { ...s, kind: 'interactive' } : s)) })
      if (way === 'launcher') {
        w.ps.value = psOf(ME)
        launched(w, ME)
      } else w.ps.value = `  100 ttys001  bash /Users/x/p/hooks/visor.sh start\n  101 ttys001  claude attach aaaaaaaa${regular ? '\n  4243 ttys005  claude' : ''}`
      w.terminal.value = (args: string[]) => (args[0] === 'traer' ? 'ok' : args[0] === 'frente' ? 'true /dev/ttys001' : '')
      const { from, notices } = await enterOnBravo($, w, on, keyboard)
      const after = w.runs.slice(from)
      // The window went there, the way this test names
      if (way === 'launcher') expect(after.some(a => a[0] === 'ps' && a[1] === '-A')).toBe(false)
      if (way === 'usual') expect(after.filter(a => a[0] === 'kill')).toEqual([['kill', '-HUP', '101']])
      if (regular) expect(after.filter(a => a[0] === 'osascript').map(a => a.slice(2))).toEqual([['traer', '/dev/ttys005']])
      else expect(w.files.get(`${DATA}/windows/_dev_ttys001`)).toContain('id=bbbbbbbb\n')
      expect(notices.map(n => n.kind)).toEqual([keyboard ? 'focus' : 'seen'])
    })
  }
}

// The target's side: 'seen' marks what it answered seen and leaves the keyboard alone (no panel opened with it);
// 'focus' still does both; a kind it doesn't know is consumed and does nothing, as in every version on this format
// (which is what a session on an older version does with 'seen')
for (const kind of ['seen', 'focus'] as const) {
  test(`arriving ${kind === 'seen' ? 'by a click (seen): what this session answered is seen at once, and its panel does not take the keyboard' : 'with Enter (focus): seen at once, and its panel takes the keyboard, as before'}`, async ($, on) => {
    const w = world(on, { list: list(), store: { [`state:${SID}`]: { finished: 1_000_000_000 - 20 * MIN } } })
    const PEER = { kind: 'peer', plugin: 'sessions' }
    await startSession($, w)
    await w.clock.advance(1000)
    const opens = w.opens.length
    const toasts = w.toasts.length
    const r: any = await $.session.receive({ text: buildNotice(kind), origin: PEER } as any)
    await w.clock.settle()
    expect(r.consumed).toBeDefined()
    expect(Number(w.store.get(`seen:${SID}`))).toBeGreaterThan(0)
    expect(w.opens.slice(opens).filter(o => o.focus)).toHaveLength(kind === 'focus' ? 1 : 0)
    expect(w.panes.find((p: any) => p.id === 'sessions')?.isFocused).toBe(kind === 'focus')
    expect(w.toasts.slice(toasts)).toEqual([])
    // A kind this version doesn't know: consumed, never handed on, nothing done
    const before = w.opens.length
    const u: any = await $.session.receive({ text: buildNotice('later' as any), origin: PEER } as any)
    await w.clock.settle()
    expect(u.consumed).toBeDefined()
    expect(w.opens.length).toBe(before)
  })
}

for (const system of ['Darwin', 'Linux']) {
  test(`Enter in a window whose launcher says what it shows (${system}): one file that asks its watcher to end the viewer, one ps of that launcher and watcher; no ps of every process, no question to Terminal, no kill`, async ($, on) => {
    const w = world(on, { list: list(), system })
    w.ps.value = psOf(ME)
    launched(w, ME)
    w.terminal.value = (args: string[]) => (args[0] === 'frente' ? 'true /dev/ttys001' : '')
    const { from, notices } = await enterOnBravo($, w, on)
    const after = w.runs.slice(from)
    expect(after.filter(a => a[0] === 'ps')).toEqual([['ps', '-p', '100,102', '-o', 'pid=', '-o', 'tty=', '-o', 'command=']])
    expect(after.filter(a => ['osascript', 'kill', 'xprop', 'wmctrl', 'xdotool'].includes(a[0] ?? ''))).toEqual([])
    expect(w.files.get(`${DATA}/windows/_dev_ttys001`)).toBe(windowTargetText({ command: 'attach', id: 'bbbbbbbb', title: 'bravo', end: true }))
    expect(w.files.get(`${DATA}/windows/_dev_ttys001`)).toMatch(/\nend=1\n$/)
    // The target takes the keyboard once the launcher is known to run
    const check = from + after.findIndex(a => a[0] === 'ps')
    expect(notices.find(n => n.kind === 'focus')?.at).toBeGreaterThan(check)
  })
}

test('a .showing its launcher left behind (its processes gone): checked, both files go, and the usual way switches the window (ps, the window in front, kill)', async ($, on) => {
  const w = world(on, { list: list() })
  launched(w, shows('/dev/ttys001', 'aaaaaaaa', 300))
  // That terminal's launcher now publishes nothing
  w.ps.value = '  100 ttys001  bash /Users/x/old/hooks/visor.sh start\n  201 ttys001  claude attach aaaaaaaa'
  w.terminal.value = (args: string[]) => (args[0] === 'frente' ? 'true /dev/ttys001' : '')
  const { from } = await enterOnBravo($, w, on)
  const after = w.runs.slice(from)
  const at = (p: (a: string[]) => boolean) => after.findIndex(p)
  const checked = at(a => a[0] === 'ps' && a[1] === '-p' && a[2] === '300,302')
  const dropped = at(a => a[0] === 'rm' && a.includes(showingFile('/dev/ttys001')))
  const listed = at(a => a[0] === 'ps' && a[1] === '-A')
  const front = at(a => a[0] === 'osascript' && a[2] === 'frente')
  const kill = at(a => a[0] === 'kill')
  expect([checked >= 0, checked < dropped, dropped < listed, listed < front, front < kill]).toEqual([true, true, true, true, true])
  expect(after[kill]).toEqual(['kill', '-HUP', '201'])
  expect(w.files.has(showingFile('/dev/ttys001'))).toBe(false)
  expect(w.files.get(`${DATA}/windows/_dev_ttys001`)).toBe(windowTargetText({ command: 'attach', id: 'bbbbbbbb', title: 'bravo' }))
})

test("a .showing under another terminal's name than the one it names is left out: the usual way", async ($, on) => {
  const w = world(on, { list: list() })
  w.files.set(showingFile('/dev/ttys009'), showingText(ME))
  w.ps.value = psOf(ME)
  w.terminal.value = (args: string[]) => (args[0] === 'frente' ? 'true /dev/ttys001' : '')
  const { from } = await enterOnBravo($, w, on)
  const after = w.runs.slice(from)
  expect(after.some(a => a[0] === 'ps' && a[1] === '-p')).toBe(false)
  expect(after.filter(a => a[0] === 'kill')).toEqual([['kill', '-HUP', '101']])
  expect(w.files.has(showingFile('/dev/ttys009'))).toBe(true)
})

test("a ps that can't run says nothing against the launcher: the window's file stays, and the switch is done", async ($, on) => {
  const w = world(on, {
    list: list(),
    onRun: argv => {
      if (argv[0] === 'ps' && argv[1] === '-p') throw new Error('no ps here')
    },
  })
  w.ps.value = psOf(ME)
  launched(w, ME)
  const { from } = await enterOnBravo($, w, on)
  const after = w.runs.slice(from)
  expect(after.some(a => (a[0] === 'ps' && a[1] === '-A') || a[0] === 'kill' || a[0] === 'rm')).toBe(false)
  expect(w.files.get(`${DATA}/windows/_dev_ttys001`)).toMatch(/\nend=1\n$/)
  expect(w.files.has(showingFile('/dev/ttys001'))).toBe(true)
})

test("the target in another window that says what it shows: that window is checked, then brought forward (Terminal's traer of it); no ps of every process, no window in front asked, nothing written", async ($, on) => {
  const w = world(on, { list: list() })
  const there = shows('/dev/ttys002', 'bbbbbbbb', 110)
  w.ps.value = `${psOf(ME)}\n${psOf(there)}`
  launched(w, ME)
  launched(w, there)
  w.terminal.value = (args: string[]) => (args[0] === 'traer' ? 'ok' : args[0] === 'frente' ? 'true /dev/ttys001' : '')
  const { from, notices } = await enterOnBravo($, w, on)
  const after = w.runs.slice(from)
  expect(after.filter(a => a[0] === 'osascript').map(a => a.slice(2))).toEqual([['traer', '/dev/ttys002']])
  expect(after.filter(a => a[0] === 'ps')).toEqual([['ps', '-p', '110,112', '-o', 'pid=', '-o', 'tty=', '-o', 'command=']])
  expect([...w.files.keys()].filter(p => p.startsWith(`${DATA}/windows/`) && !p.endsWith('.showing'))).toEqual([])
  expect(notices.some(n => n.kind === 'focus')).toBe(true)
})

test('the target in another window that says what it shows but whose launcher is gone: that .showing goes, and the usual way switches this window', async ($, on) => {
  const w = world(on, { list: list() })
  launched(w, ME)
  launched(w, shows('/dev/ttys002', 'bbbbbbbb', 110))
  w.ps.value = psOf(ME)
  w.terminal.value = (args: string[]) => (args[0] === 'frente' ? 'true /dev/ttys001' : '')
  const { from } = await enterOnBravo($, w, on)
  const after = w.runs.slice(from)
  expect(after.some(a => a[0] === 'osascript' && a[2] === 'traer')).toBe(false)
  expect(w.files.has(showingFile('/dev/ttys002'))).toBe(false)
  expect(after.filter(a => a[0] === 'kill')).toEqual([['kill', '-HUP', '101']])
})

test("the window in front is still asked when this session is also shown in a window that says nothing (the last listing has its viewer there): the usual way, whose listing is then every session's", async ($, on) => {
  const w = world(on, { list: list() })
  launched(w, ME)
  // A plain claude attach of this session in ttys003, where Enter was pressed
  w.ps.value = `${psOf(ME)}\n  301 ttys003  claude attach aaaaaaaa`
  w.store.set('windowsList', { at: 1, windows: parseWindows(w.ps.value) })
  w.terminal.value = (args: string[]) => (args[0] === 'frente' ? 'true /dev/ttys003' : args[0] === 'abrir' ? '/dev/ttys004' : '')
  const { from } = await enterOnBravo($, w, on)
  const after = w.runs.slice(from)
  expect(after.some(a => a[0] === 'ps' && a[1] === '-p')).toBe(false)
  expect(after.some(a => a[0] === 'ps' && a[1] === '-A')).toBe(true)
  expect(after.filter(a => a[0] === 'osascript').map(a => a[2])).toEqual(['frente', 'abrir'])
  expect(w.files.has(`${DATA}/windows/_dev_ttys001`)).toBe(false)
  expect((w.store.get('windowsList') as any).at).toBeGreaterThan(1)
  expect((w.store.get('windowsList') as any).windows.byId.aaaaaaaa).toEqual(['/dev/ttys001', '/dev/ttys003'])
})

test('planSwitch: the one launcher window showing this session switches, one showing the target is brought; anything unclear goes the usual way', () => {
  const me = shows('/dev/ttys001', 'aaaaaaaa', 100)
  const there = shows('/dev/ttys002', 'bbbbbbbb', 110)
  const other = shows('/dev/ttys005', 'cccccccc', 150)
  expect(planSwitch([me, other], 'aaaaaaaa', 'bbbbbbbb', null)).toEqual({ kind: 'switch', from: me })
  expect(planSwitch([me, there], 'aaaaaaaa', 'bbbbbbbb', null)).toEqual({ kind: 'bring', from: me, to: there })
  // No launcher window shows this session, or two do
  expect(planSwitch([there], 'aaaaaaaa', 'bbbbbbbb', null)).toBe(null)
  expect(planSwitch([me, shows('/dev/ttys006', 'aaaaaaaa', 160)], 'aaaaaaaa', 'bbbbbbbb', null)).toBe(null)
  // An agent view: in a launcher window, or in a window the last listing saw that says nothing
  expect(planSwitch([me, { ...other, command: 'agents', id: '' }], 'aaaaaaaa', 'bbbbbbbb', null)).toBe(null)
  expect(planSwitch([me], 'aaaaaaaa', 'bbbbbbbb', parseWindows('  401 ttys009  claude agents --cwd .'))).toBe(null)
  // A viewer of this session or of the target where nothing is said
  expect(planSwitch([me], 'aaaaaaaa', 'bbbbbbbb', parseWindows('  402 ttys009  claude attach aaaaaaaa'))).toBe(null)
  expect(planSwitch([me], 'aaaaaaaa', 'bbbbbbbb', parseWindows('  402 ttys009  claude attach bbbbbbbb'))).toBe(null)
  // The listing's windows that do say count by what they say now; other sessions' viewers don't matter
  expect(planSwitch([me, other], 'aaaaaaaa', 'bbbbbbbb', parseWindows(`${psOf(me)}\n  402 ttys005  claude agents\n  403 ttys009  claude attach cccccccc`))).toEqual({ kind: 'switch', from: me })
})

test('parseShowing and showingRuns: a whole file in this format, and processes that are its launcher and watcher on its terminal', () => {
  const s = shows('/dev/ttys001', 'aaaaaaaa', 100)
  const text = showingText(s)
  expect(parseShowing(text)).toEqual(s)
  expect(parseShowing(showingText({ ...s, command: 'agents', id: '' }))).toEqual({ ...s, command: 'agents', id: '' })
  // Cut off while it's written, another format, a pid that isn't one, an id that isn't one
  expect(parseShowing(text.slice(0, -1))).toBe(null)
  expect(parseShowing(text.slice(0, text.indexOf('watcher=')))).toBe(null)
  expect(parseShowing(text.replace('format=3', 'format=2'))).toBe(null)
  expect(parseShowing(text.replace('viewer=101', 'viewer=x'))).toBe(null)
  expect(parseShowing(text.replace('id=aaaaaaaa', 'id=zz'))).toBe(null)
  expect(showingRuns(s, psOf(s))).toBe(true)
  // Gone, or those numbers taken by other programs or on another terminal since
  expect(showingRuns(s, '')).toBe(false)
  expect(showingRuns(s, '  100 ttys001  bash /Users/x/p/hooks/visor.sh start')).toBe(false)
  expect(showingRuns(s, '  100 ttys001  vim notes\n  102 ttys001  python3 serve.py')).toBe(false)
  expect(showingRuns(s, '  100 ttys001  bash /Users/x/p/hooks/visor.sh start\n  102 ttys001  python3 serve.py')).toBe(false)
  expect(showingRuns(s, '  100 ttys001  vim notes\n  102 ttys001  python3 /Users/x/p/hooks/launcher.py watch --file /x --launcher 100')).toBe(false)
  expect(showingRuns(s, psOf(s).replace(/ttys001/g, 'ttys007'))).toBe(false)
  expect(showingRuns({ ...s, tty: '/dev/pts/3' }, psOf({ ...s, tty: '/dev/pts/3' }))).toBe(true)
})
