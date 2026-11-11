import { expect, test } from 'claude-code/testing'

import { recordBehind } from '../hooks/state'
import { PASS_MS } from '../hooks/leader'
import { COMMAND, ROOT, SID, SLOW, startSession, world, type World } from './world'

// Claude's store rejects a write while its lock is held (another session writing, or a lock a killed session left):
// the write is tried again, waits to land late when it may, and is counted; a session's own record that went backwards
// is put back at the pass (world.tsx's storeLock stands for the lock)

const BRAVO = 'bbbbbbbb-0000-0000-0000-000000000000'
const REGISTRY = '/Users/x/.claude/sessions'
const JOBS = '/Users/x/jobs'
const PANEL = { plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const STATE = `state:${SID}`
const SEEN = `seen:${SID}`

// What the engine does with a prompt and a turn's end beneath the mod
function turns(on: any) {
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('turn.complete', (_: any, e: any) => ({ text: String(e.answer ?? '') }) as any)
}

async function status($: any): Promise<string> {
  const r: any = await $.command.run({ command: 'sessions', args: 'status', ...COMMAND })
  return String(r.text)
}

// A call that the mod may hold on the store: started, and whether it settled without the clock moving
async function unheld(w: World, call: Promise<unknown>): Promise<boolean> {
  let settled = false
  void call.then(
    () => (settled = true),
    () => (settled = true),
  )
  await w.clock.settle()
  return settled
}

const state = (w: World) => w.store.get(STATE) as any

test('recordBehind: a stored record that lost a finish or a turn start, or is gone, is behind the session’s own', () => {
  const own = { created: 1, turnStarted: 50, finished: 80 }
  expect(recordBehind(null, own)).toBe(true)
  expect(recordBehind({ created: 1 }, own)).toBe(true)
  expect(recordBehind({ created: 1, turnStarted: 50, finished: 60 }, own)).toBe(true)
  expect(recordBehind({ created: 1, turnStarted: 40, finished: 80 }, own)).toBe(true)
  expect(recordBehind({ created: 1, turnStarted: 50, finished: 80 }, own)).toBe(false)
  // What another session may add to it (the version, on a restart) isn't behind
  expect(recordBehind({ created: 1, turnStarted: 50, finished: 80, version: '2.1.400' }, own)).toBe(false)
  expect(recordBehind({ created: 1 }, { created: 1 })).toBe(false)
})

test('a write the store rejects once is tried again 50 ms later and lands; the rejection is counted and shown', SLOW, async ($, on) => {
  const w = world(on)
  turns(on)
  await startSession($, w)
  await w.clock.advance(1000)
  expect(await status($)).not.toContain('Store:')
  w.storeLock.refused.length = 0
  w.storeLock.next = 1
  const at = w.clock.now()
  await $.turn.start({ turnId: 't1', text: 'go' } as any)
  // The rejection comes two thirds of a second after the write was asked, as the engine's does
  await w.clock.advance(700)
  expect(w.storeLock.refused).toEqual([STATE])
  expect(state(w)?.turnStarted).not.toBe(at)
  await w.clock.advance(60)
  expect(state(w)?.turnStarted).toBe(at)
  const said = await status($)
  expect(said).toContain("Store: 1 write try rejected since this session started (the store's lock was held) · 1 landed on a later try · 0 given up · last: state:")
  // A test session's keys, under its own namespace all along
  expect(w.namespace).not.toBe('')
  expect([...w.storeKeys].every(k => k.startsWith(w.namespace))).toBe(true)
})

test('a lock left behind for 10 s: nothing holds a prompt or a turn’s end meanwhile, and the latest of each key lands once it’s gone', SLOW, async ($, on) => {
  const w = world(on)
  turns(on)
  await startSession($, w)
  await w.clock.advance(1000)
  const before = state(w)
  const t0 = w.clock.now()
  w.storeLock.until = t0 + 10000
  await $.turn.start({ turnId: 't1', text: 'go' } as any)
  // The first turn's end waits for its one try, as a write always did
  const first = $.turn.complete({ turnId: 't1', answer: 'first', reason: 'answer' } as any)
  await w.clock.advance(700)
  await first
  // From here on the store is known to be refusing: the person's prompt goes in with the clock where it is
  const typed = w.clock.now()
  expect(await unheld(w, $.prompt.submit({ text: 'again', origin: { kind: 'composer' } } as any))).toBe(true)
  await w.clock.advance(3000)
  await $.turn.start({ turnId: 't2', text: 'again' } as any)
  await w.clock.advance(100)
  const second = w.clock.now()
  expect(await unheld(w, $.turn.complete({ turnId: 't2', answer: 'second', reason: 'answer' } as any))).toBe(true)
  // Nothing landed yet
  expect(state(w)).toEqual(before)
  expect(w.store.has(SEEN)).toBe(false)
  expect(await status($)).toContain('still trying')
  // The lock is 10 s old: the next try takes it over, and what waited lands, the newest of each key
  await w.clock.set(t0 + 12000)
  expect(state(w)).toMatchObject({ finished: second, answer: 'second' })
  expect(state(w).turnStarted).toBeGreaterThan(typed)
  expect(w.store.get(SEEN)).toBe(typed)
  const said = await status($)
  expect(said).not.toContain('still trying')
  expect(said).toMatch(/[1-9]\d* landed on a later try/)
})

test('a write still rejected 12 s after it was asked is given up, counted and shown; nothing kept in memory says it landed', SLOW, async ($, on) => {
  const w = world(on)
  turns(on)
  await startSession($, w)
  await $.turn.start({ turnId: 't1', text: 'go' } as any)
  await $.turn.complete({ turnId: 't1', answer: 'done', reason: 'answer' } as any)
  await w.clock.advance(1000)
  expect(state(w).finished).toBeGreaterThan(0)
  const t0 = w.clock.now()
  w.storeLock.until = t0 + 20000
  const typed = $.prompt.submit({ text: 'again', origin: { kind: 'composer' } } as any)
  await w.clock.advance(700)
  await typed
  expect(await status($)).toContain('1 still trying')
  await w.clock.set(t0 + 14000)
  const said = await status($)
  expect(said).not.toContain('still trying')
  expect(said).toMatch(/Store: \d+ write tries rejected since this session started/)
  expect(said).toMatch(/· [1-9]\d* given up/)
  expect(w.store.has(SEEN)).toBe(false)
  // The lock gone, a key in the panel marks it seen: the mod knows its answer was never recorded as seen
  await w.clock.set(t0 + 21000)
  await $.ui.focus({ component: 'Pane', requestId: 'sessions', plugin: 'sessions', element: `s:${SID}`, origin: { kind: 'person' } } as any)
  await w.clock.advance(100)
  expect(Number(w.store.get(SEEN))).toBeGreaterThanOrEqual(t0)
})

test('a later write of a key takes the place of one still waiting: a delete over a set, a set over a delete', SLOW, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  await w.clock.advance(1000)
  const pane = () => w.panes.find(p => p.id === 'sessions')
  const toggle = () => $.command.run({ command: 'sessions', args: '', ...COMMAND } as any)
  expect(pane()?.isFocused).toBe(false)
  w.storeLock.landed.length = 0
  let t0 = w.clock.now()
  w.storeLock.until = t0 + 10000
  // /sessions opens the panel with the keyboard (panelClosed deleted): its one try is rejected, and it waits
  const opened = toggle()
  await w.clock.advance(700)
  await opened
  expect(pane()?.isFocused).toBe(true)
  // /sessions again closes it (set), then opens it (delete), then closes it (set): none held, each in the last one's place
  expect(await unheld(w, toggle())).toBe(true)
  expect(pane()).toBeUndefined()
  expect(await unheld(w, toggle())).toBe(true)
  expect(await unheld(w, toggle())).toBe(true)
  expect(pane()).toBeUndefined()
  expect(w.store.has('panelClosed')).toBe(false)
  await w.clock.set(t0 + 12000)
  expect(w.store.get('panelClosed')).toBe(true)
  expect(w.storeLock.landed.filter(k => k === 'panelClosed')).toEqual(['panelClosed'])
  // The other way round: set, then delete
  await w.clock.advance(1000)
  t0 = w.clock.now()
  w.storeLock.until = t0 + 10000
  const again = toggle()
  await w.clock.advance(700)
  await again
  expect(await unheld(w, toggle())).toBe(true)
  expect(await unheld(w, toggle())).toBe(true)
  expect(pane()?.isFocused).toBe(true)
  expect(w.store.get('panelClosed')).toBe(true)
  await w.clock.set(t0 + 12000)
  expect(w.store.has('panelClosed')).toBe(false)
})

test('a turn’s end the store rejects: its finish lands half a second later, with what the session published meanwhile', SLOW, async ($, on) => {
  const w = world(on)
  turns(on)
  await startSession($, w)
  await w.clock.advance(1000)
  await $.turn.start({ turnId: 't1', text: 'go' } as any)
  await w.clock.advance(200)
  w.usage.value = { context: { percent: 55 }, rateLimits: [] }
  w.storeLock.refused.length = 0
  w.storeLock.next = 1
  const at = w.clock.now()
  const end = $.turn.complete({ turnId: 't1', answer: 'all done', reason: 'answer' } as any)
  await w.clock.advance(700)
  await end
  expect(w.storeLock.refused).toEqual([STATE])
  expect(state(w).finished).toBeUndefined()
  await w.clock.advance(600)
  // The finish, and the context the session published while it waited (a record built from the one that waited)
  expect(state(w)).toMatchObject({ finished: at, answer: 'all done', context: 55 })
})

test('the pass puts back this session’s own record and seen time when the store has older ones', SLOW, async ($, on) => {
  const w = world(on)
  turns(on)
  await startSession($, w)
  await w.clock.advance(1000)
  await $.turn.start({ turnId: 't1', text: 'go' } as any)
  await w.clock.advance(500)
  await $.turn.complete({ turnId: 't1', answer: 'done', reason: 'answer' } as any)
  await w.clock.advance(500)
  await $.prompt.submit({ text: 'thanks', origin: { kind: 'composer' } } as any)
  await w.clock.advance(500)
  const wrote = { ...state(w) }
  const seen = w.store.get(SEEN)
  expect(wrote.finished).toBeGreaterThan(0)
  expect(seen).toBeGreaterThan(wrote.finished)
  // A session that froze while it held the store's lock writes the file back as it read it before this turn
  w.store.set(STATE, { created: wrote.created })
  w.store.delete(SEEN)
  await w.clock.advance(PASS_MS + 11000)
  expect(state(w)).toMatchObject({ created: wrote.created, turnStarted: wrote.turnStarted, finished: wrote.finished, answer: 'done' })
  expect(w.store.get(SEEN)).toBe(seen)
  expect(await status($)).toContain('its own record put back 2 times')
})

// ---- Another session's record ----

type Session = { pid: number; sessionId: string; id: string; name: string }
const SESSIONS: Session[] = [
  { pid: 4242, sessionId: SID, id: 'aaaaaaaa', name: 'alpha' },
  { pid: 4243, sessionId: BRAVO, id: 'bbbbbbbb', name: 'bravo' },
]

test('u on another session: the version goes on its record as the store has it now, not as this panel last read it', SLOW, async ($, on) => {
  const list = SESSIONS.map(s => ({ id: s.id, sessionId: s.sessionId, cwd: ROOT, kind: 'background', status: 'idle', pid: s.pid, name: s.name, startedAt: 999_000_000 }))
  const w = world(on, { list, store: { [`state:${BRAVO}`]: { created: 1, finished: 100, version: '2.1.300' } } })
  for (const s of SESSIONS) {
    w.write(`${REGISTRY}/${s.pid}.json`, JSON.stringify({ pid: s.pid, sessionId: s.sessionId, cwd: ROOT, kind: 'bg', status: 'idle', statusUpdatedAt: w.clock.now(), name: s.name, jobId: `${s.id}-0000-0000-0000-000000000000`, startedAt: 999_000_000, procStart: 'x' }))
    w.write(`${REGISTRY}/${s.pid}.0a1b.key`, 'x')
  }
  // Bravo runs nothing in the background, so its restart is asked here
  w.write(`${JOBS}/bbbbbbbb/state.json`, JSON.stringify({ inFlight: { tasks: 0 } }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => ({ result: { answers: { [e.questions[0].question]: 'Restart' } } }) as any)
  // Watched (its SessionStart came): what the panel read of bravo's record is kept until bravo's bell rings
  await $.classic.SessionStart({ source: 'startup', session_id: SID } as any)
  await startSession($, w)
  await w.clock.advance(1000)
  // Bravo finished a turn since, and this panel hasn't read it yet
  w.store.set(`state:${BRAVO}`, { created: 1, finished: 200, answer: 'newer', version: '2.1.300' })
  const pane = w.panes.find(p => p.id === 'sessions')
  if (pane) pane.isFocused = true
  const ui = await $.ui.mount(PANEL)
  await $.ui.focus({ requestId: 'sessions', key: `s:${BRAVO}`, element: `s:${BRAVO}`, component: 'Pane', origin: { kind: 'engine' } } as any)
  await ui.press({ key: 'restart' })
  await w.clock.advance(2000)
  expect(w.runs.some(a => a[0] === '/bin/claude' && a[1] === 'respawn' && a[2] === 'bbbbbbbb')).toBe(true)
  expect(w.store.get(`state:${BRAVO}`)).toEqual({ created: 1, finished: 200, answer: 'newer', version: '2.1.316' })
  await ui.unmount()
})
