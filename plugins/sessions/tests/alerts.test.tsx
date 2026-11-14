import { expect, test } from 'claude-code/testing'

import { addSpend, clockText, dayOf, dueWaits, inQuietHours, median, parseQuietHours, spendBurst, spendIsHigh, spendLine, spendText, usualHour, waitText, type SpendAlert } from '../hooks/state'
import { COMMAND, DATA, ROOT, SID, startSession, world, type World, SLOW } from './world'

// Telling the person: a push when a session of the project waits too long (once per wait, one session for the
// project, quiet hours and a cap a day; no lock, no command and nothing read while there's nothing to send), the ⧗ on
// rows working or unseen for long, a session whose spend runs far above its own usual hour, and the line about the
// sessions that ended with the background service, whose b brings them back once the person says so. Nothing here
// ever stops a session or reaches the model

const BRAVO = 'bbbbbbbb-0000-0000-0000-000000000000'
const PANEL = { plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const MIN = 60000
const HOUR = 3600000

function list(bravo: string): any[] {
  return [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'one' },
    { id: 'bbbbbbbb', sessionId: BRAVO, cwd: ROOT, kind: 'background', status: bravo, pid: 4243, name: 'bravo' },
  ]
}

async function drawn($: any): Promise<string> {
  const ui = await $.ui.mount(PANEL)
  const text = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return text
}

async function status($: any): Promise<string> {
  const r: any = await $.command.run({ command: 'sessions', args: 'status', ...COMMAND })
  return String(r.text)
}

// This session with Remote Control on, as the background service records it
function remoteControl(w: World) {
  w.files.set('/Users/x/jobs/aaaaaaaa/state.json', JSON.stringify({ bridgeSessionId: 'session_x' }))
}

test('quiet hours: 22-7 runs past midnight, 9:30-12 does not; anything else is none', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 2, h, m)
  const night = parseQuietHours('22-7')
  expect(night).toEqual({ from: 1320, to: 420 })
  expect([at(23), at(3), at(6, 59), at(7), at(12)].map(d => inQuietHours(night, d))).toEqual([true, true, true, false, false])
  const morning = parseQuietHours('9:30 - 12:00')
  expect([at(9, 29), at(9, 30), at(11, 59), at(12)].map(d => inQuietHours(morning, d))).toEqual([false, true, true, false])
  expect(['', 'night', '25-7', '7-7', '9:75-10'].map(parseQuietHours)).toEqual([null, null, null, null, null])
  expect(inQuietHours(null, at(3))).toBe(false)
})

test('waits due a push: past the threshold, once each (pushed holds the wait it was for), a minute later without Remote Control', () => {
  const waits = [
    { sessionId: 'a', title: 'alpha', since: 0 },
    { sessionId: 'b', title: 'bravo', since: 5 * MIN },
  ]
  expect(dueWaits(waits, {}, 10 * MIN, 10 * MIN, true).map(w => w.sessionId)).toEqual(['a'])
  expect(dueWaits(waits, {}, 10 * MIN, 10 * MIN, false)).toEqual([])
  expect(dueWaits(waits, {}, 11 * MIN, 10 * MIN, false).map(w => w.sessionId)).toEqual(['a'])
  expect(dueWaits(waits, { a: 0 }, 20 * MIN, 10 * MIN, true).map(w => w.sessionId)).toEqual(['b'])
  // A new wait of the same session is due again
  expect(dueWaits([{ sessionId: 'a', title: 'alpha', since: 30 * MIN }], { a: 0 }, 40 * MIN, 10 * MIN, true)).toHaveLength(1)
  expect(dueWaits(waits, {}, 99 * MIN, 0, true)).toEqual([])
  expect(waitText([waits[0] as any], 12 * MIN)).toBe('“alpha” has been waiting for you for 12 min')
  expect(waitText(waits, 3 * HOUR)).toBe('“alpha” and 1 other session are waiting for you, the longest for 3 h')
})

test('spend: a running total from the cost at list price, samples thinned to the hour, a reset counted from where it went', () => {
  let l = addSpend(undefined, 1, [], 0).ledger
  expect(l).toEqual({ last: 1, total: 1, kind: '', samples: [[0, 1, -1]] })
  // Every 5 minutes a sample; in between only the total moves
  expect(addSpend(l, 1.5, [], MIN)).toEqual({ ledger: { last: 1.5, total: 1.5, kind: '', samples: [[0, 1, -1]] }, sampled: false })
  l = addSpend(l, 2, [{ kind: 'seven_day', percent: 40 }], 5 * MIN).ledger
  expect(l.samples).toEqual([
    [0, 1, -1],
    [5 * MIN, 2, 40],
  ])
  expect(l.kind).toBe('seven_day')
  // After a /clear or a restart the cost starts over: what it shows now was spent since
  l = addSpend(l, 0.25, [], 10 * MIN).ledger
  expect([l.last, l.total]).toEqual([0.25, 2.25])
  // Hours later, only the first sample of each hour stays from before the last 70 minutes, nothing past 25 hours
  for (let t = 15 * MIN; t <= 30 * HOUR; t += 5 * MIN) l = addSpend(l, 0.25 + t / HOUR, [], t).ledger
  expect(l.samples.length).toBeLessThan(45)
  expect(l.samples[0]?.[0]).toBeGreaterThanOrEqual(30 * HOUR - 25 * HOUR)
})

test('spend running high: four times its usual hour and $3 at list price, until it falls below half of both', () => {
  const ledger = (hours: number[], now: number) => {
    let total = 0
    const samples: [number, number, number][] = [[now - (hours.length + 1) * HOUR, 0, 10]]
    hours.forEach((h, i) => {
      total += h
      samples.push([now - (hours.length - i) * HOUR - 1, total, 10 + i])
    })
    return { last: 0, total, kind: 'five_hour', samples }
  }
  const now = 100 * HOUR
  // Too little history: no judgement
  expect(spendBurst(ledger([0.5, 0.5], now), now)).toBeNull()
  const usual = ledger([0.5, 0.4, 0.6, 0.5], now)
  expect(spendBurst({ ...usual, total: usual.total + 6, samples: [...usual.samples, [now, usual.total + 6, 20]] }, now)).toEqual({ hour: 6, usual: 0.5, rise: 7, basis: 'own' })
  // With a usual hour of its own, the project's doesn't count
  expect(spendBurst({ ...usual, total: usual.total + 6, samples: [...usual.samples, [now, usual.total + 6, 20]] }, now, 5)?.usual).toBe(0.5)
  expect(spendIsHigh({ hour: 6, usual: 0.5, rise: null }, false)).toBe(true)
  expect(spendIsHigh({ hour: 1.9, usual: 0.4, rise: null }, false)).toBe(false)
  expect(spendIsHigh({ hour: 10, usual: 4, rise: null }, false)).toBe(false)
  // Once marked, it stays so above half of both
  expect(spendIsHigh({ hour: 2, usual: 0.5, rise: null }, true)).toBe(true)
  expect(spendIsHigh({ hour: 0.9, usual: 0.5, rise: null }, true)).toBe(false)
  const alert: SpendAlert = { since: 0, hour: 6, usual: 0.5, rise: 7, kind: 'five_hour', notified: false }
  expect(spendLine(alert, 'api')).toBe('$6.00 in the last hour · usually $0.50')
  expect(spendLine(alert, 'subscription')).toBe('spending 12× its usual hour · 5h +7% this hour')
  expect(spendText('one', alert, 'api')).toBe('“one” spent $6.00 in the last hour, usually $0.50: check it isn\'t looping')
  expect(spendText('one', { ...alert, rise: null }, 'subscription')).toBe('“one” is spending 12× its usual hour: check it isn\'t looping')
})

test("spend in a session's first hours: judged by the median of the usual hours its project's other sessions published", () => {
  const now = 100 * HOUR
  // An hour and a quarter old, spending $20 an hour from its first minute
  const young = { last: 25, total: 25, kind: '', samples: [[now - 75 * MIN, 0, -1], [now - HOUR, 5, -1], [now, 25, -1]] as [number, number, number][] }
  expect(spendBurst(young, now)).toBeNull()
  expect(spendBurst(young, now, median([0.5, 2, 3]))).toEqual({ hour: 20, usual: 2, rise: null, basis: 'project' })
  expect(spendIsHigh(spendBurst(young, now, 2), false)).toBe(true)
  // Less than an hour of its own: still nothing to judge
  expect(spendBurst({ ...young, samples: young.samples.slice(1) }, now - 1, 2)).toBeNull()
  expect([median([3, 1, 2]), median([1, 2, 3, 4]), median([])]).toEqual([2, 2.5, null])
  expect(usualHour(young, now)).toBeNull()
  const alert: SpendAlert = { since: 0, hour: 20, usual: 2, rise: null, kind: '', notified: false, basis: 'project' }
  expect(spendLine(alert, 'api')).toBe("$20.00 last hour · project's usual $2.00")
  expect(spendLine(alert, 'subscription')).toBe("spending 10× the project's usual hour")
  expect(spendText('new one', alert, 'api')).toBe("“new one” spent $20.00 in the last hour, the project's sessions usually $2.00: check it isn't looping")
})

test('a session waiting past waitPushMinutes: one push for that wait, its name only, and the notification channel when the phone is not reached', SLOW, async ($, on) => {
  const sessions = list('waiting')
  const w = world(on, { list: sessions })
  await startSession($, w)
  await w.clock.advance(3000)
  // Without Remote Control, a minute more than the threshold: a session that has it goes first
  await w.clock.advance(10 * MIN)
  expect(w.pushes).toEqual([])
  await w.clock.advance(MIN + 3000)
  expect(w.pushes).toEqual(['“bravo” has been waiting for you for 11 min'])
  // Claude answered that the person is at the computer: their own notification channel is tried
  expect(w.notifies).toEqual(['“bravo” has been waiting for you for 11 min'])
  await w.clock.advance(5 * MIN)
  expect(w.pushes).toHaveLength(1)
  expect(await status($)).toContain('1 of 5 today · last, 5 min ago from aaaaaaaa: “bravo” has been waiting for you for 11 min (phone: not sent (user_present); notification: not sent (no-channel))')
  // Answered, then waiting again: a new wait, a new push
  sessions[1].status = 'idle'
  w.store.set('list', {})
  await w.clock.advance(6000)
  sessions[1].status = 'waiting'
  w.store.set('list', {})
  await w.clock.advance(12 * MIN)
  expect(w.pushes).toHaveLength(2)
})

test('with Remote Control the push goes at the threshold and reaches the phone; the notification channel is not needed', SLOW, async ($, on) => {
  const w = world(on, { list: list('waiting') })
  remoteControl(w)
  w.pushAnswer.value = { pushSent: true, localSent: false }
  await startSession($, w)
  await w.clock.advance(10 * MIN + 6000)
  expect(w.pushes).toEqual(['“bravo” has been waiting for you for 10 min'])
  expect(w.notifies).toEqual([])
})

test('a wait another session already pushed is not pushed again', SLOW, async ($, on) => {
  const w = world(on, { list: list('waiting'), store: { [`waiting:${BRAVO}`]: 1, [`pushed:${BRAVO}`]: 1 } })
  remoteControl(w)
  await startSession($, w)
  await w.clock.advance(3 * MIN)
  expect(w.pushes).toEqual([])
})

test('quiet hours hold pushes back, and the cap a day counts every notification', { ...SLOW, options: { quietHours: '0-24' } }, async ($, on) => {
  const w = world(on, { list: list('waiting') })
  remoteControl(w)
  await startSession($, w)
  await w.clock.advance(15 * MIN)
  expect(w.pushes).toEqual([])
  expect(await status($)).toContain(', none 0-24, 0 of 5 today')
})

test('the cap a day: once reached, no more notifications that day', { ...SLOW, options: { notificationsPerDay: 1 } }, async ($, on) => {
  const sessions = list('waiting')
  const w = world(on, { list: sessions })
  remoteControl(w)
  await startSession($, w)
  await w.clock.advance(10 * MIN + 6000)
  expect(w.pushes).toHaveLength(1)
  sessions[1].status = 'idle'
  w.store.set('list', {})
  await w.clock.advance(6000)
  sessions[1].status = 'waiting'
  w.store.set('list', {})
  await w.clock.advance(15 * MIN)
  expect(w.pushes).toHaveLength(1)
})

test('a session another plugin marks as needing the person waits from when a panel first saw it so', { ...SLOW, options: { waitPushMinutes: 2 } }, async ($, on) => {
  const w = world(on, { list: list('idle') })
  remoteControl(w)
  const until = w.clock.now() + 10 * HOUR
  w.store.set(`marks:probe:${SID}`, { at: w.clock.now(), until, rows: { bbbbbbbb: { badge: '?1', needsPerson: true } } })
  await startSession($, w)
  await w.clock.advance(MIN)
  expect(w.pushes).toEqual([])
  await w.clock.advance(MIN + 6000)
  expect(w.pushes).toEqual(['“bravo” has been waiting for you for 2 min'])
  expect((w.store.get(`needsSince:${BRAVO}`) as any)?.since).toBeGreaterThan(0)
})

test('waitPushMinutes 0: no pushes', { ...SLOW, options: { waitPushMinutes: 0 } }, async ($, on) => {
  const w = world(on, { list: list('waiting') })
  remoteControl(w)
  await startSession($, w)
  await w.clock.advance(30 * MIN)
  expect(w.pushes).toEqual([])
})

test('⧗ on a row working, or done and unseen in the background, for staleMinutes; nothing moves', SLOW, async ($, on) => {
  const now = 1_000_000_000
  const sessions = [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'one' },
    { id: 'bbbbbbbb', sessionId: BRAVO, cwd: ROOT, kind: 'background', status: 'busy', pid: 4243, name: 'bravo' },
    { id: 'cccccccc', sessionId: 'cccccccc-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'idle', pid: 4244, name: 'charlie' },
    { sessionId: 'dddddddd-0000-0000-0000-000000000000', cwd: ROOT, kind: 'interactive', status: 'idle', pid: 4245, name: 'delta' },
  ]
  const w = world(on, {
    list: sessions,
    store: {
      [`state:${BRAVO}`]: { turnStarted: now - 2 * HOUR },
      'state:cccccccc-0000-0000-0000-000000000000': { finished: now - 3 * HOUR },
      'state:dddddddd-0000-0000-0000-000000000000': { finished: now - 3 * HOUR },
    },
  })
  await startSession($, w)
  // The rows' times are reckoned at the minute: from the next one (and its refresh) they read the full hours
  await w.clock.advance(23000)
  const text = await drawn($)
  expect(text).toContain('⧗2h')
  expect(text).toContain('⧗3h')
  // A regular session's unseen answer is in its own window: no ⧗
  expect(text.match(/⧗3h/g)).toHaveLength(1)
  expect(text).toContain('⧗ Working, or done and unseen, for 60 min or more')
})

test("a subagent's run inside a long turn doesn't restart the working time (nor hide the ⧗)", SLOW, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  const started = w.clock.now()
  await $.turn.start({ turnId: 't1', text: 'refactor the module' } as any)
  await w.clock.advance(20 * MIN)
  await $.turn.start({ turnId: 't2', agentId: 'helper-1', text: 'look for the callers' } as any)
  await w.clock.settle()
  expect((w.store.get(`state:${SID}`) as any)?.turnStarted).toBe(started)
  // The next turn of the main loop does start the time again
  await $.turn.start({ turnId: 't3', text: 'and now the tests' } as any)
  await w.clock.settle()
  expect((w.store.get(`state:${SID}`) as any)?.turnStarted).toBe(w.clock.now())
})

test("spend far above a session's usual hour: a line under its row, one notification, nothing stopped", async ($, on) => {
  const now = 1_000_000_000
  const samples = [
    [now - 6 * HOUR, 0, -1],
    [now - 5 * HOUR, 0.5, -1],
    [now - 4 * HOUR, 1, -1],
    [now - 3 * HOUR, 1.5, -1],
    [now - 2 * HOUR, 2, -1],
    [now - HOUR - 1, 2.5, -1],
  ]
  const w = world(on, { store: { [`spend:${SID}`]: { last: 2.5, total: 2.5, kind: '', samples } } })
  remoteControl(w)
  w.pushAnswer.value = { pushSent: true }
  await startSession($, w)
  w.usage.value = { context: { percent: 10 }, rateLimits: [], cost: { usd: 8.5 } }
  await w.clock.advance(15000)
  expect((w.store.get(`state:${SID}`) as any)?.spendAlert).toMatchObject({ hour: 6, usual: 0.5, notified: true })
  expect(w.pushes).toEqual(["“one” spent $6.00 in the last hour, usually $0.50: check it isn't looping"])
  await w.clock.advance(3000)
  expect(await drawn($)).toContain('$6.00 in the last hour · usually $0.50')
  await w.clock.advance(60000)
  expect(w.pushes).toHaveLength(1)
  expect(w.runs.some(a => a.includes('stop') || a.includes('respawn'))).toBe(false)
  expect(await status($)).toContain('this session spent $6.00 in the last hour at list price, usually $0.50')
})

test('a session that spends far from its first hour is told by the usual hour its project\'s other sessions published', async ($, on) => {
  const now = 1_000_000_000
  // An hour of its own and nothing spent then; the other session of the project usually spends $0.50 an hour
  const w = world(on, { list: list('idle'), store: { [`spend:${SID}`]: { last: 0, total: 0, kind: '', samples: [[now - HOUR - 1, 0, -1]] }, [`state:${BRAVO}`]: { usualHour: 0.5 } } })
  remoteControl(w)
  w.pushAnswer.value = { pushSent: true }
  await startSession($, w)
  w.usage.value = { context: { percent: 10 }, rateLimits: [], cost: { usd: 8.5 } }
  await w.clock.advance(15000)
  expect((w.store.get(`state:${SID}`) as any)?.spendAlert).toMatchObject({ hour: 8.5, usual: 0.5, basis: 'project', notified: true })
  expect(w.pushes).toEqual(["“one” spent $8.50 in the last hour, the project's sessions usually $0.50: check it isn't looping"])
  await w.clock.advance(3000)
  expect(await drawn($)).toContain("$8.50 last hour · project's usual $0.50")
  expect(await status($)).toContain("the project's sessions usually $0.50 (it has too few active hours of its own yet)")
})

// ---- Nothing to send: no lock, no command, nothing read ----

const REGISTRY = '/Users/x/.claude/sessions'
const LOCK = `${DATA}/push.lock`
const SEC = 1000

// The test's on, with every store read noted by its key on the way to the world's own hook (a test hooks an event once)
function notingReads(on: any, reads: string[]) {
  return ((name: string, ...rest: any[]) => {
    if (name === 'store.get') {
      const hook = rest[rest.length - 1]
      rest[rest.length - 1] = ($: any, e: any, next: any) => {
        reads.push(String(e.key))
        return hook($, e, next)
      }
    }
    return on(name, ...rest)
  }) as any
}

// A live session (its SessionStart came: it reads on file events and on the pass) with bravo waiting for the person
// since `ago` before the start. event: bravo's bell rings, and this session refreshes; reads: how many times it read
// the store's keys that start so; locks: how many times it ran that program on the push lock
async function waitingSession($: any, on: any, o: { ago: number; now?: number; store?: (w: World) => Record<string, unknown>; lockTaken?: boolean }) {
  const all: string[] = []
  const w = world(notingReads(on, all), { list: list('waiting'), now: o.now })
  w.store.set(`waiting:${BRAVO}`, w.clock.now() - o.ago)
  for (const [k, v] of Object.entries(o.store?.(w) ?? {})) w.store.set(k, v)
  for (const s of list('waiting')) {
    w.write(`${REGISTRY}/${s.pid}.json`, JSON.stringify({ pid: s.pid, sessionId: s.sessionId, cwd: ROOT, kind: 'bg', status: s.status, statusUpdatedAt: w.clock.now(), name: s.name, jobId: `${s.id}-0000-0000-0000-000000000000`, startedAt: 999_000_000, procStart: 'x' }))
  }
  // Another session holds the push lock, and goes on holding it (a lock older than 5 s would be taken over)
  if (o.lockTaken) {
    w.dirs.add(LOCK)
    w.made.set(LOCK, w.clock.now() + HOUR)
  }
  await $.classic.SessionStart({ source: 'startup', session_id: SID } as any)
  await startSession($, w)
  const event = async (after = 2 * SEC) => {
    w.write(`${DATA}/bell/${BRAVO}`, `format=3\nfrom=${BRAVO}\nat=${w.clock.now()}\n`)
    await $.classic.FileChanged({ file_path: `${DATA}/bell/${BRAVO}`, event: 'change' } as any)
    await w.clock.advance(after)
  }
  const reads = (prefix: string) => all.filter(k => (k.startsWith(w.namespace) ? k.slice(w.namespace.length) : k).startsWith(prefix)).length
  const locks = (program: 'mkdir' | 'rmdir') => w.runs.filter(a => a[0] === program && a[1] === LOCK).length
  return { w, event, reads, locks }
}

test("the day's cap reached: one read of the count, then no lock, no command and nothing read, refresh after refresh; the next day it notifies again", { ...SLOW, options: { notificationsPerDay: 1 } }, async ($, on) => {
  // 23:40, local time: the day changes 20 minutes in
  const { w, event, reads, locks } = await waitingSession($, on, { ago: 20 * MIN, now: new Date(1970, 0, 12, 23, 40).getTime(), store: w => ({ pushCount: { day: dayOf(new Date(w.clock.now())), count: 1 } }) })
  const refreshes = () => reads('waiting:')
  const before = refreshes()
  // Five minutes of another session's events, and the passes: bravo waits past its time at every one of them
  for (let i = 0; i < 150; i++) await event()
  expect(refreshes() - before).toBeGreaterThan(150)
  expect(w.pushes).toEqual([])
  expect(w.notifies).toEqual([])
  expect([locks('mkdir'), locks('rmdir')]).toEqual([0, 0])
  expect(reads('pushCount')).toBe(1)
  expect(reads('pushed:')).toBe(0)
  // Past midnight the count starts over: the wait is pushed, under the lock, and counted
  await w.clock.advance(20 * MIN)
  expect(w.pushes).toHaveLength(1)
  expect(w.pushes[0]).toContain('“bravo” has been waiting for you')
  expect([locks('mkdir'), locks('rmdir')]).toEqual([1, 1])
  expect(w.store.get('pushCount')).toEqual({ day: dayOf(new Date(w.clock.now())), count: 1 })
  expect(w.store.get(`pushed:${BRAVO}`)).toBe(w.store.get(`waiting:${BRAVO}`))
  // And that was the day's one: nothing more is taken or read
  const [count, pushed] = [reads('pushCount'), reads('pushed:')]
  for (let i = 0; i < 30; i++) await event()
  expect(w.pushes).toHaveLength(1)
  expect([locks('mkdir'), locks('rmdir')]).toEqual([1, 1])
  expect([reads('pushCount'), reads('pushed:')]).toEqual([count, pushed])
})

test('a wait under waitPushMinutes reads nothing; once due it is pushed once, with one lock taken; then nothing is read for it again', SLOW, async ($, on) => {
  const { w, event, reads, locks } = await waitingSession($, on, { ago: 0 })
  // Nine minutes in: not due yet (10 minutes, and a minute more without Remote Control)
  for (let i = 0; i < 54; i++) await event(10 * SEC)
  expect(w.pushes).toEqual([])
  expect([reads('pushed:'), reads('pushCount'), locks('mkdir')]).toEqual([0, 0, 0])
  // Due at 11 minutes: one push, one lock, the count read before it and under it, the wait's record too
  for (let i = 0; i < 15; i++) await event(10 * SEC)
  expect(w.pushes).toEqual(['“bravo” has been waiting for you for 11 min'])
  expect([locks('mkdir'), locks('rmdir')]).toEqual([1, 1])
  expect([reads('pushed:'), reads('pushCount')]).toEqual([2, 2])
  expect(w.store.get('pushCount')).toMatchObject({ count: 1 })
  // Pushed: it waits on, and no refresh reads its record or takes the lock again
  for (let i = 0; i < 60; i++) await event()
  expect(w.pushes).toHaveLength(1)
  expect([locks('mkdir'), locks('rmdir')]).toEqual([1, 1])
  expect([reads('pushed:'), reads('pushCount')]).toEqual([2, 2])
})

test('the push lock taken by another session: one try, not ten, and the next one 15 s later; once that session pushed the wait, no more', SLOW, async ($, on) => {
  const { w, event, reads, locks } = await waitingSession($, on, { ago: 20 * MIN, lockTaken: true })
  // The wait is due from the start: this session's turn comes within 3 s, and finds the lock taken
  await w.clock.advance(4 * SEC)
  expect(locks('mkdir')).toBe(1)
  // Refresh after refresh, no other try for 15 s
  for (let i = 0; i < 5; i++) await event()
  expect(locks('mkdir')).toBe(1)
  for (let i = 0; i < 4; i++) await event()
  expect(locks('mkdir')).toBe(2)
  expect(w.pushes).toEqual([])
  // The session that held it pushed the wait and let go: this one reads that at its next try, and takes nothing
  w.store.set(`pushed:${BRAVO}`, w.store.get(`waiting:${BRAVO}`))
  w.store.set('pushCount', { day: dayOf(new Date(w.clock.now())), count: 1 })
  w.dirs.delete(LOCK)
  for (let i = 0; i < 10; i++) await event()
  const pushed = reads('pushed:')
  for (let i = 0; i < 30; i++) await event()
  expect(locks('mkdir')).toBe(2)
  expect(locks('rmdir')).toBe(0)
  expect(reads('pushed:')).toBe(pushed)
  expect(w.pushes).toEqual([])
  expect(w.store.get('pushCount')).toMatchObject({ count: 1 })
})

const NOTHING_GOES: [string, Record<string, string | number>][] = [
  ['the quiet hours', { quietHours: '0-24' }],
  ['notifications off (notificationsPerDay 0)', { notificationsPerDay: 0 }],
]
for (const [why, options] of NOTHING_GOES) {
  test(`${why}: a wait past its time takes no lock and reads nothing`, { ...SLOW, options }, async ($, on) => {
    const { w, event, reads, locks } = await waitingSession($, on, { ago: 20 * MIN })
    for (let i = 0; i < 60; i++) await event()
    expect(w.pushes).toEqual([])
    expect([locks('mkdir'), locks('rmdir')]).toEqual([0, 0])
    expect([reads('pushed:'), reads('pushCount')]).toEqual([0, 0])
  })
}

test("a spend alert with the day's cap reached: the count is read once, and no lock is taken at any pass", { ...SLOW, options: { notificationsPerDay: 1 } }, async ($, on) => {
  const now = 1_000_000_000
  const samples = [
    [now - 6 * HOUR, 0, -1],
    [now - 5 * HOUR, 0.5, -1],
    [now - 4 * HOUR, 1, -1],
    [now - 3 * HOUR, 1.5, -1],
    [now - 2 * HOUR, 2, -1],
    [now - HOUR - 1, 2.5, -1],
  ]
  const all: string[] = []
  const w = world(notingReads(on, all), { store: { [`spend:${SID}`]: { last: 2.5, total: 2.5, kind: '', samples }, pushCount: { day: dayOf(new Date(now)), count: 1 } } })
  remoteControl(w)
  await startSession($, w)
  w.usage.value = { context: { percent: 10 }, rateLimits: [], cost: { usd: 8.5 } }
  // Five minutes: the spend is looked at every 15 s on the short timer
  await w.clock.advance(5 * MIN)
  expect((w.store.get(`state:${SID}`) as any)?.spendAlert).toMatchObject({ hour: 6, usual: 0.5, notified: false })
  expect(await drawn($)).toContain('$6.00 in the last hour · usually $0.50')
  expect(w.pushes).toEqual([])
  expect(w.runs.filter(a => a[1] === LOCK)).toEqual([])
  expect(all.filter(k => k.endsWith('pushCount'))).toHaveLength(1)
})

// ---- The sessions that ended with the background service ----

// The service's log as it reads after a death: each session's last start, then the service's next start finding its
// workers dead (at DIED). The world's clock is at 13:46:40 that day
const STARTED = '1970-01-12T13:00:00.000Z'
const DIED = '1970-01-12T13:30:00.000Z'
const OTHER = '/Users/x/other'
const sid = (id: string) => `${id}-0000-0000-0000-000000000000`
const stoppedRow = (id: string, cwd: string, name: string) => ({ id, sessionId: sid(id), cwd, kind: 'background', name })
function serviceLog(extra: string[] = []): string {
  return [
    ...['dddddddd', 'eeeeeeee', 'ffffffff', '11111111', '22222222', '33333333', 'cdcdcdcd'].map(id => `[${STARTED}] [bg] bg claimed-spare ${id} (spare)`),
    // The person's claude stop; the service retiring an idle one; a crash: stops of their own, before the death
    '[1970-01-12T13:10:00.000Z] [bg] bg settled ffffffff (killed)',
    '[1970-01-12T13:12:00.000Z] [bg] bg retire 22222222: idle-prompt, idle 1h',
    '[1970-01-12T13:12:01.000Z] [bg] bg settled 22222222 (done)',
    '[1970-01-12T13:15:00.000Z] [bg] bg settled 33333333 (crashed): SIGKILL (137) before init',
    `[${DIED}] [supervisor] ─── daemon start ─── version=2.1.300 pid=100 origin=transient`,
    `[${DIED}] [bg] bg adopt: adopted=0 respawned=0 dead=5`,
    ...extra,
  ].join('\n')
}
// This session and bravo run; delta (here) and echo (another folder) ended with the service; foxtrot was stopped by
// the person (the log), 11111111 from a panel (personStop), 22222222 retired, 33333333 crashed
function endedList(): any[] {
  return [
    ...list('idle'),
    stoppedRow('dddddddd', ROOT, 'delta'),
    stoppedRow('eeeeeeee', OTHER, 'echo'),
    stoppedRow('ffffffff', OTHER, 'foxtrot'),
    stoppedRow('11111111', ROOT, 'stopped from a panel'),
    stoppedRow('22222222', ROOT, 'retired'),
    stoppedRow('33333333', ROOT, 'crashed'),
  ]
}
const PERSON_STOP = { [`personStop:${sid('11111111')}`]: Date.parse('1970-01-12T13:20:00.000Z') }
// The line as the panel draws it: the row that holds its key (a plain Button on b: "b: …"), its words (a Text each)
// and then the key; '' when there's none
async function endedLineOf($: any): Promise<string> {
  const ui = await $.ui.mount(PANEL)
  const tree = await ui.drawn()
  await ui.unmount()
  let line = ''
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    const kids: any[] = Array.isArray(n.children) ? n.children : []
    if (kids.some(c => c?.props?.key === 'bring-back')) {
      line = kids.map(c => (c?.type === 'Button' ? `${c.props.hotkey}: ${c.props.label}` : (c?.children ?? []).join(''))).join('')
    }
    for (const c of kids) walk(c)
  }
  walk(tree)
  return line.trim()
}
const respawned = (w: World) => w.runs.filter(a => a[0] === '/bin/claude' && a[1] === 'respawn').map(a => a[2])

test("the line: every folder's sessions that ended with the background service, never one stopped, retired or crashed", SLOW, async ($, on) => {
  const sessions = endedList()
  const w = world(on, { list: sessions, store: PERSON_STOP })
  w.files.set('/Users/x/daemon.log', serviceLog())
  await startSession($, w)
  await w.clock.advance(4000)
  const when = clockText(new Date(Date.parse(DIED)), new Date(w.clock.now()))
  expect(await endedLineOf($)).toBe(`2 sessions ended with the background service at ${when} · b: brings them back`)
  // Echo, in the other folder, came back: one left
  ;(sessions.find(s => s.id === 'eeeeeeee') as any).pid = 4300
  await w.clock.advance(65000)
  expect(await endedLineOf($)).toBe(`1 session ended with the background service at ${when} · b: brings it back`)
  // Delta came back too: the line goes
  ;(sessions.find(s => s.id === 'dddddddd') as any).pid = 4301
  await w.clock.advance(65000)
  expect(await endedLineOf($)).toBe('')
  expect(await drawn($)).not.toContain('"bring-back"')
  // Nothing was brought back without the key
  expect(respawned(w)).toEqual([])
})

test('the line: none with no death in the log, and none once the person removed them', SLOW, async ($, on) => {
  const sessions = endedList()
  const w = world(on, { list: sessions, store: PERSON_STOP })
  w.files.set('/Users/x/daemon.log', serviceLog().split('\n').filter(l => !l.includes('adopt')).join('\n'))
  await startSession($, w)
  await w.clock.advance(4000)
  expect(await endedLineOf($)).toBe('')
  w.write('/Users/x/daemon.log', serviceLog())
  await w.clock.advance(65000)
  expect(await endedLineOf($)).toMatch(/^2 sessions ended with the background service at /)
  // Removed from the list (claude rm): gone from the line
  sessions.splice(sessions.findIndex(s => s.id === 'dddddddd'), 1)
  sessions.splice(sessions.findIndex(s => s.id === 'eeeeeeee'), 1)
  await w.clock.advance(65000)
  expect(await endedLineOf($)).toBe('')
})

// The respawns, with when each ran by the world's clock
const respawnTimes = (w: World): { id: string; at: number }[] =>
  w.runs.flatMap((a, i) => (a[0] === '/bin/claude' && a[1] === 'respawn' ? [{ id: String(a[2]), at: w.runAt[i] ?? 0 }] : []))

test('b: asks how many and from where, then brings back only those, one at a time a few seconds apart', SLOW, async ($, on) => {
  const sessions = [...endedList(), stoppedRow('cdcdcdcd', OTHER, 'golf')]
  const w = world(on, { list: sessions, store: PERSON_STOP })
  w.files.set('/Users/x/daemon.log', serviceLog())
  const asked: any[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    asked.push(e.questions[0])
    return { result: { answers: { [e.questions[0].question]: 'Bring them back' } } }
  })
  await startSession($, w)
  await w.clock.advance(4000)
  const ui = await $.ui.mount(PANEL)
  await ui.press({ key: 'bring-back' })
  await w.clock.advance(20000)
  await ui.unmount()
  const when = clockText(new Date(Date.parse(DIED)), new Date(w.clock.now()))
  expect(asked).toHaveLength(1)
  expect(asked[0].question).toBe(
    `Bring back the 3 sessions that ended with the background service at ${when} (2 in ~/other, 1 in ~/myapp)? Each one restarts with its conversation, one at a time. Leave them stopped hides this line until the service ends sessions again.`,
  )
  expect(asked[0].header).toBe('Sessions')
  expect(asked[0].options.map((o: any) => o.label ?? o)).toEqual(['Bring them back', 'Leave them stopped', 'Cancel'])
  // Only the three that ended with the service, never one the person stopped, one retired or one that crashed
  const times = respawnTimes(w)
  expect(times.map(t => t.id).sort()).toEqual(['cdcdcdcd', 'dddddddd', 'eeeeeeee'])
  for (let i = 1; i < times.length; i++) expect(times[i]!.at - times[i - 1]!.at).toBeGreaterThanOrEqual(3000)
  expect(w.toasts).toContain('Brought back 3 sessions, skipped 0, failed 0')
  // Pressed again before the list shows them running: nothing is respawned twice
  const again = await $.ui.mount(PANEL)
  await again.press({ key: 'bring-back' })
  await w.clock.advance(20000)
  await again.unmount()
  expect(respawnTimes(w)).toHaveLength(3)
  expect(w.toasts).toContain('Brought back 0 sessions, skipped 3, failed 0')
})

test('b: each one is checked again just before: one the person opened and stopped, or that runs again, is skipped', SLOW, async ($, on) => {
  const sessions = [...endedList(), stoppedRow('cdcdcdcd', OTHER, 'golf')]
  const w = world(on, { list: sessions, store: PERSON_STOP })
  w.files.set('/Users/x/daemon.log', serviceLog())
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    // While the question was up: the person opened echo and stopped it (the log says so), and golf runs again
    w.write('/Users/x/daemon.log', serviceLog(['[1970-01-12T13:40:00.000Z] [bg] bg claimed-spare eeeeeeee (spare)', '[1970-01-12T13:41:00.000Z] [bg] bg settled eeeeeeee (killed)']))
    ;(sessions.find(s => s.id === 'cdcdcdcd') as any).pid = 4400
    return { result: { answers: { [e.questions[0].question]: 'Bring them back' } } }
  })
  await startSession($, w)
  await w.clock.advance(4000)
  const ui = await $.ui.mount(PANEL)
  await ui.press({ key: 'bring-back' })
  await w.clock.advance(20000)
  await ui.unmount()
  expect(respawned(w)).toEqual(['dddddddd'])
  expect(w.toasts).toContain('Brought back 1 session, skipped 2, failed 0')
})

test('b: Leave them stopped hides the line for that death only; Cancel or Esc changes nothing', SLOW, async ($, on) => {
  const sessions = endedList()
  const w = world(on, { list: sessions, store: PERSON_STOP })
  w.files.set('/Users/x/daemon.log', serviceLog())
  let answer: string | null = 'Cancel'
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) =>
    answer === null ? { result: "Error: The user doesn't want to proceed with this tool use.", isError: true } : { result: { answers: { [e.questions[0].question]: answer } } },
  )
  await startSession($, w)
  await w.clock.advance(4000)
  const press = async () => {
    const ui = await $.ui.mount(PANEL)
    await ui.press({ key: 'bring-back' })
    await w.clock.advance(4000)
    await ui.unmount()
  }
  await press()
  answer = null
  await press()
  expect(await endedLineOf($)).toMatch(/^2 sessions ended with the background service at /)
  answer = 'Leave them stopped'
  await press()
  expect(w.store.get('endedDismissed')).toBe(Date.parse(DIED))
  expect(await endedLineOf($)).toBe('')
  await w.clock.advance(65000)
  expect(await endedLineOf($)).toBe('')
  // The service dies again, with a session started after the first death: the line is back, for that one alone
  sessions.push(stoppedRow('abababab', ROOT, 'hotel'))
  w.write('/Users/x/daemon.log', serviceLog(['[1970-01-12T13:40:00.000Z] [bg] bg claimed-spare abababab (spare)', '[1970-01-12T13:45:00.000Z] [bg] bg adopt: adopted=0 respawned=0 dead=1']))
  await w.clock.advance(65000)
  expect(await endedLineOf($)).toMatch(/^1 session ended with the background service at .* · b: brings it back$/)
  expect(respawned(w)).toEqual([])
})

