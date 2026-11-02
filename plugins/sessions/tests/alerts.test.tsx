import { expect, test } from 'claude-code/testing'

import { dueWaits, inQuietHours, parseQuietHours, waitText } from '../hooks/state'
import { COMMAND, ROOT, SID, startSession, world, type World } from './world'

// Telling the person: a push when a session of the project waits too long (once per wait, one session for the
// project, quiet hours and a cap a day), and the ⧗ on rows working or unseen for long. Nothing here ever stops a
// session or reaches the model

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

test('a session waiting past waitPushMinutes: one push for that wait, its name only, and the notification channel when the phone is not reached', async ($, on) => {
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
  expect(await status($)).toContain('1 of 5 today · last, 5 min ago from aaaaaaaa: ““bravo” has been waiting for you for 11 min” (phone: not sent (user_present); notification: not sent (no-channel))')
  // Answered, then waiting again: a new wait, a new push
  sessions[1].status = 'idle'
  w.store.set('list', {})
  await w.clock.advance(6000)
  sessions[1].status = 'waiting'
  w.store.set('list', {})
  await w.clock.advance(12 * MIN)
  expect(w.pushes).toHaveLength(2)
})

test('with Remote Control the push goes at the threshold and reaches the phone; the notification channel is not needed', async ($, on) => {
  const w = world(on, { list: list('waiting') })
  remoteControl(w)
  w.pushAnswer.value = { pushSent: true, localSent: false }
  await startSession($, w)
  await w.clock.advance(10 * MIN + 6000)
  expect(w.pushes).toEqual(['“bravo” has been waiting for you for 10 min'])
  expect(w.notifies).toEqual([])
})

test('a wait another session already pushed is not pushed again', async ($, on) => {
  const w = world(on, { list: list('waiting'), store: { [`waiting:${BRAVO}`]: 1, [`pushed:${BRAVO}`]: 1 } })
  remoteControl(w)
  await startSession($, w)
  await w.clock.advance(3 * MIN)
  expect(w.pushes).toEqual([])
})

test('quiet hours hold pushes back, and the cap a day counts every notification', { options: { quietHours: '0-24' } }, async ($, on) => {
  const w = world(on, { list: list('waiting') })
  remoteControl(w)
  await startSession($, w)
  await w.clock.advance(15 * MIN)
  expect(w.pushes).toEqual([])
  expect(await status($)).toContain(', none 0-24, 0 of 5 today')
})

test('the cap a day: once reached, no more notifications that day', { options: { notificationsPerDay: 1 } }, async ($, on) => {
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

test('a session another plugin marks as needing the person waits from when a panel first saw it so', { options: { waitPushMinutes: 2 } }, async ($, on) => {
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

test('waitPushMinutes 0: no pushes', { options: { waitPushMinutes: 0 } }, async ($, on) => {
  const w = world(on, { list: list('waiting') })
  remoteControl(w)
  await startSession($, w)
  await w.clock.advance(30 * MIN)
  expect(w.pushes).toEqual([])
})

test('⧗ on a row working, or done and unseen in the background, for staleMinutes; nothing moves', async ($, on) => {
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
  const text = await drawn($)
  expect(text).toContain('⧗2h')
  expect(text).toContain('⧗3h')
  // A regular session's unseen answer is in its own window: no ⧗
  expect(text.match(/⧗3h/g)).toHaveLength(1)
  expect(text).toContain('⧗ Working, or done and unseen, for 60 min or more')
})
