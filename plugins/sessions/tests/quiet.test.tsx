import { expect, test } from 'claude-code/testing'

import { heartbeatText, labelMinute, listHolds, listSignature, LIST_MIN_MS, LIST_QUIET_MS, nextSeenCheck, parseNotice, sameData, usageSummaryOf } from '../hooks/state'
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
  // A caller that wants it fresher than the panel's pace gets exactly that; a slow listing's push back holds for the rest
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
