// /sessions debug: what the mod counts about its own work, and only while a window is open.
//
// Off (always, until someone runs /sessions debug perf) it holds nothing and times nothing: each counted place reads one
// boolean (`on`) and goes on. A window turns it on from zero; the close hands the totals in once and turns it off. A
// window whose close never comes (the asking session died) ends by itself: the first count past its end turns it off.
//
// An action is a unit of the mod's work, declared once (ACTIONS in register.tsx) with what makes it run and what makes
// one run cost more. Work done while an action runs is counted under it: "the action running now", which is wrong
// when two overlap (a timer's job during a hook), so the totals are kept apart and are exact whichever action a call
// fell in. Time is the clock's, waits on files and commands included, in whole milliseconds: it isn't CPU. An action
// that runs inside another (a refresh a file event asked for) has its time taken off the outer one's, so the actions'
// times add up.
import { DEBUG_FORMAT, type ActionTotals, type Counts, type Driver, type HandIn, type Holding, type Value } from './types'

export type ActionSpec = { drivers: Driver[]; grows?: string[]; within?: string }
// What a holding has now: how many, and about how many bytes (null when it can't say)
export type Held = Record<string, { grows: string[]; now: [number, number | null] }>

// How long past its end a window still counts, for a close that comes a little late (the asking session's own wait)
export const WINDOW_GRACE_MS = 30000

// An action in flight: the work counted under it, when it began, the time of the actions that ran inside it, and whether
// it has ended
type Running = { name: string; work: number; from: number; inner: number; done: boolean }

const add = (to: Counts, kind: string, n: number) => {
  to[kind] = (to[kind] ?? 0) + n
}

const emptyTotals = (spec: ActionSpec): ActionTotals => ({
  drivers: [...spec.drivers],
  grows: [...(spec.grows ?? [])],
  ...(spec.within ? { within: spec.within } : {}),
  runs: 0,
  ms: 0,
  slowest: 0,
  mostWork: 0,
  work: {},
  failed: {},
  sent: {},
  started: {},
  bytesRead: 0,
  bytesWritten: 0,
})

export type Meter = {
  // Whether a window is open: the one test a counted place makes while nobody asked
  readonly on: boolean
  // The open window's report, or null
  report(): string | null
  // A window opens: counting starts from zero, with what the mod holds now. `until` is on the meter's own clock
  open(report: string, until: number, held: Held): void
  // The window closes: the totals, once, and off. null when no window was open (or another report's)
  close(report: string, held: Held, facts: Record<string, Value>): HandIn | null
  // Off, with nothing handed in
  drop(): void
  // An action runs: counted and timed while a window is open, just run otherwise
  run<T>(name: string, work: () => T): T
  // A run that did nothing worth timing (a timer that fired and found nothing to do): counted, not timed
  tick(name: string): void
  // A run timed by hand, where the work can't be wrapped (a drawing with several ways out): `since` is the meter's
  // clock when it began. The work inside it isn't counted under it
  timed(name: string, since: number): void
  // Work inside the action running now: a call of a kind (read, stat, list, write, exists, store, command…), one that
  // failed, a signal sent for other sessions to react to, a process started, bytes moved
  work(kind: string, n?: number): void
  failed(kind: string, n?: number): void
  sent(kind: string, n?: number): void
  started(program: string): void
  bytes(read: number, written: number): void
}

// The meter of one module: its actions, and when it loaded. `clock` is the language's own (Date.now): a call to the
// engine for every count would cost more than what it measures. Every time the meter keeps or hands in is that clock's
export function createMeter(actions: Record<string, ActionSpec>, loadedAt: number, clock: () => number = Date.now): Meter {
  let on = false
  let report: string | null = null
  let until = 0
  let from = 0
  let byAction: Record<string, ActionTotals> = {}
  let totals: HandIn['totals'] = { work: {}, failed: {}, sent: {}, started: {}, bytesRead: 0, bytesWritten: 0 }
  let opened: Held = {}
  let current: Running | null = null

  const off = () => {
    on = false
    report = null
    byAction = {}
    totals = { work: {}, failed: {}, sent: {}, started: {}, bytesRead: 0, bytesWritten: 0 }
    opened = {}
    current = null
  }
  // A window whose close never came: off at the first count past its end
  const live = () => {
    if (!on) return false
    if (clock() > until + WINDOW_GRACE_MS) {
      off()
      return false
    }
    return true
  }
  // An action nobody declared is counted under its name with no driver: the report shows it rather than losing it
  const totalsOf = (name: string) => (byAction[name] ??= emptyTotals(actions[name] ?? { drivers: [] }))
  const finish = (r: Running, prev: Running | null) => {
    r.done = true
    if (current === r) current = prev && !prev.done ? prev : null
    if (!on) return
    const t = totalsOf(r.name)
    const elapsed = Math.max(0, clock() - r.from)
    if (prev && !prev.done) prev.inner += elapsed
    const ms = Math.max(0, elapsed - r.inner)
    t.runs++
    t.ms += ms
    if (ms > t.slowest) t.slowest = ms
    if (r.work > t.mostWork) t.mostWork = r.work
  }

  return {
    get on() {
      return on
    },
    report: () => report,
    open(id, end, held) {
      off()
      on = true
      report = id
      until = end
      from = clock()
      opened = held
    },
    close(id, held, facts) {
      if (!on || report !== id) return null
      const now = clock()
      const holdings: Record<string, Holding> = {}
      for (const [name, h] of Object.entries(held)) holdings[name] = { grows: h.grows, open: opened[name]?.now ?? h.now, close: h.now }
      const handIn: HandIn = { format: DEBUG_FORMAT, loadedAt, from, to: now, ...(loadedAt > from ? { partial: 'reloaded' as const } : {}), facts, actions: byAction, totals, holdings }
      off()
      return handIn
    },
    drop: off,
    run<T>(name: string, work: () => T): T {
      if (!live()) return work()
      const prev = current
      const r: Running = { name, work: 0, from: clock(), inner: 0, done: false }
      current = r
      let out: T
      try {
        out = work()
      } catch (err) {
        finish(r, prev)
        throw err
      }
      // A promise: the action lasts until it settles. Another action that starts meanwhile takes over as "the one
      // running now" and gives it back when it ends
      if (out && typeof (out as any).then === 'function') {
        return (out as any).then(
          (v: unknown) => {
            finish(r, prev)
            return v
          },
          (err: unknown) => {
            finish(r, prev)
            throw err
          },
        ) as T
      }
      finish(r, prev)
      return out
    },
    tick(name) {
      if (!live()) return
      totalsOf(name).runs++
    },
    timed(name, since) {
      if (!live()) return
      const t = totalsOf(name)
      const ms = Math.max(0, clock() - since)
      t.runs++
      t.ms += ms
      if (ms > t.slowest) t.slowest = ms
    },
    work(kind, n = 1) {
      if (!live()) return
      add(totals.work, kind, n)
      if (current) {
        current.work += n
        add(totalsOf(current.name).work, kind, n)
      }
    },
    failed(kind, n = 1) {
      if (!live()) return
      add(totals.failed, kind, n)
      if (current) add(totalsOf(current.name).failed, kind, n)
    },
    sent(kind, n = 1) {
      if (!live()) return
      add(totals.sent, kind, n)
      if (current) add(totalsOf(current.name).sent, kind, n)
    },
    started(program) {
      if (!live()) return
      add(totals.started, program, 1)
      if (current) add(totalsOf(current.name).started, program, 1)
    },
    bytes(read, written) {
      if (!live()) return
      totals.bytesRead += read
      totals.bytesWritten += written
      if (current) {
        const t = totalsOf(current.name)
        t.bytesRead += read
        t.bytesWritten += written
      }
    },
  }
}
