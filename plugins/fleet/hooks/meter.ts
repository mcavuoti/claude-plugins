// fleet's meter (0.15.0): what `/sessions debug perf` asks of fleet. It counts nothing until a window opens.
//
// sessions measures each session's process from outside (CPU, memory, the processes it starts). A plugin can't measure
// a process; it accounts for its share: which of its actions ran, how often, how long, what work each did (files read,
// commands started, bytes), what failed, what it sent that other sessions react to, and what it holds in memory.
//
// Off, which is always unless the person opened a window: `M.on` is false, every counted helper tests it and goes on,
// and nothing here runs. No timer, no file, no call. A window opens and closes by a ring of sessions' debug path
// (register.tsx: debugRing): open → counters from zero; close → one hand-in (snapshot) and off. A window whose close
// never came (the asking session died) ends by itself: the first count past its end stops the counting (what was
// counted, a few numbers, stays until the next ring).
//
// What the numbers are, and aren't:
// - Time is how long an action took by the clock (`Date.now()`, in milliseconds), its waits on files and commands
//   included, the plugins beneath a hook excluded (the hook's `next`). It isn't CPU. An action under a millisecond
//   reads as 0, and is judged by its runs and its work.
// - A hook stops its own run's clock before it calls `next` (`below(r)`, with the run its `act` gave it), whatever
//   else started meanwhile: the plugins beneath and the tool are never a hook's time.
// - Work is exact in the totals. Which action it belongs to is "the one running now": the newest run still going that
//   isn't waiting beneath. Two that overlap (a timer's pass during a tool hook) can take each other's work.
// - An action that starts while another is going is taken as running inside it, and gives its time back to that one,
//   except a part (`within`), whose time stays in the whole it names: the report prints a part under its whole and
//   leaves it out of the plugin's total (so what runs inside a part comes off the part and off its whole). A mod has
//   no way to tell "inside" from "beside": two actions that merely overlap read a little low between them, never high.
// - A run belongs to the window it began in: one still going when its window closes adds nothing to the next.

export type Driver = 'clock' | 'self' | 'person' | 'peer'
export type Declared = { readonly drivers: readonly Driver[]; readonly grows: readonly string[]; readonly within?: string }

const C: readonly Driver[] = ['clock']
const S: readonly Driver[] = ['self']
const P: readonly Driver[] = ['peer']
const PC: readonly Driver[] = ['peer', 'clock']
const H: readonly Driver[] = ['person']
const NONE: readonly string[] = []

function table<T extends Record<string, Declared>>(t: T): T {
  return t
}

/** fleet's units of work: what makes each run (drivers) and what makes one run cost more (grows). One table, so the
 * report can say which actions grow with the fleet without anyone remembering */
export const ACTIONS = table({
  // ---- every session: what another session did ----
  'latest.changed': { drivers: P, grows: NONE },
  'queue.changed': { drivers: P, grows: NONE },
  'answers.changed': { drivers: P, grows: NONE },
  'overrules.changed': { drivers: P, grows: NONE },
  'inbox.changed': { drivers: P, grows: NONE },
  'bell:work': { drivers: P, grows: NONE },
  'bell:runs': { drivers: P, grows: NONE },
  'bell:restart': { drivers: P, grows: NONE },
  'bell:budget': { drivers: P, grows: NONE },
  'bell:probe': { drivers: P, grows: NONE },
  'bell:other': { drivers: P, grows: NONE },
  'landing.chain': { drivers: P, grows: ['landings'] },
  'landing.pull': { drivers: PC, grows: ['events'] },
  'landing.net-found': { drivers: P, grows: NONE },
  deliver: { drivers: PC, grows: ['questions'] },
  beat: { drivers: PC, grows: ['questions', 'files'] },
  'outside.scan': { drivers: C, grows: ['files'] },
  'world.tick': { drivers: C, grows: ['files'] },
  lease: { drivers: C, grows: NONE },
  needs: { drivers: C, grows: NONE },
  watch: { drivers: C, grows: NONE },
  'band.draw': { drivers: ['person', 'peer'], grows: NONE },
  // ---- every session: its own turns and tools ----
  gate: { drivers: S, grows: NONE },
  'read.note': { drivers: S, grows: ['files'] },
  'write.land': { drivers: S, grows: ['pins'] },
  'bash.scan': { drivers: S, grows: ['files'] },
  // (every tool call noted while it's in flight, for an instance's heartbeat)
  'call.flight': { drivers: S, grows: NONE },
  // (every tool call that isn't one of the above: an MCP send held or let through, a permission prompt settled)
  'outbound.check': { drivers: S, grows: NONE },
  'outside.mark': { drivers: S, grows: NONE },
  'wake.guard': { drivers: S, grows: NONE },
  'send.guard': { drivers: S, grows: NONE },
  'push.guard': { drivers: S, grows: NONE },
  'ask.guard': { drivers: S, grows: NONE },
  'helper.spawn': { drivers: S, grows: NONE },
  'tool.fleet': { drivers: S, grows: NONE },
  'tool.decide': { drivers: S, grows: ['questions'] },
  'tool.send': { drivers: S, grows: NONE },
  'tool.slot': { drivers: S, grows: ['line'] },
  'tool.run': { drivers: S, grows: NONE },
  'tool.taste': { drivers: S, grows: NONE },
  'tool.confirm': { drivers: S, grows: NONE },
  'turn.step': { drivers: S, grows: NONE },
  'turn.start': { drivers: S, grows: NONE },
  'turn.end': { drivers: S, grows: NONE },
  'prompt.typed': { drivers: H, grows: NONE },
  'prompt.submit': { drivers: ['person', 'self'], grows: NONE },
  'compact.hook': { drivers: S, grows: NONE },
  'classic.start': { drivers: S, grows: NONE },
  'classic.hook': { drivers: S, grows: NONE },
  'session.end': { drivers: S, grows: NONE },
  'reads.save': { drivers: S, grows: ['files'] },
  judge: { drivers: S, grows: ['records'] },
  // Declared, not counted in this step: a start is over before a window can turn the meter on
  start: { drivers: S, grows: ['events', 'files'] },
  // ---- the person ----
  'command:list': { drivers: H, grows: ['questions'] },
  'command:answer': { drivers: H, grows: ['questions'] },
  'command:status': { drivers: H, grows: ['instances', 'files'] },
  'command:brief': { drivers: H, grows: ['instances', 'records'] },
  'command:up': { drivers: H, grows: ['instances'] },
  'command:other': { drivers: H, grows: NONE },
  // ---- an instance of the roster ----
  'instance.tick': { drivers: C, grows: NONE },
  heartbeat: { drivers: ['clock', 'self'], grows: NONE },
  'nudge.pass:minute': { drivers: C, grows: ['files'] },
  'nudge.pass:landing': { drivers: P, grows: ['files'] },
  'nudge.pass:bell': { drivers: P, grows: ['files'] },
  'nudge.pass:window': { drivers: C, grows: ['files'] },
  'nudge.pass:own': { drivers: ['clock', 'self'], grows: ['files'] },
  'slot.watch': { drivers: C, grows: ['line'] },
  // ---- the sweeping session: the project's work ----
  sweep: { drivers: PC, grows: ['instances', 'files'] },
  'sweep.asks': { drivers: PC, grows: ['questions'], within: 'sweep' },
  'sweep.suspects': { drivers: PC, grows: ['records', 'files'], within: 'sweep' },
  'sweep.slots': { drivers: PC, grows: ['line'], within: 'sweep' },
  'sweep.roster': { drivers: PC, grows: ['instances'], within: 'sweep' },
  'sweep.alerts': { drivers: C, grows: ['instances'], within: 'sweep' },
  'sweep.spends': { drivers: C, grows: ['instances'], within: 'sweep' },
  'sweep.index': { drivers: C, grows: ['events'], within: 'sweep' },
  'sweep.checks': { drivers: C, grows: ['files'], within: 'sweep' },
  'sweep.commit': { drivers: C, grows: ['files'], within: 'sweep' },
  'sweep.code': { drivers: C, grows: ['repositories'], within: 'sweep' },
  'sweep.intake': { drivers: PC, grows: ['items'], within: 'sweep' },
})
export type ActionName = keyof typeof ACTIONS

/** The pattern every key and every word of a hand-in matches (sessions' writer refuses anything else) */
export const NAME = /^[a-z][A-Za-z0-9.:-]{0,47}$/
/** A hand-in's top size, as sessions refuses a larger one (characters as JSON) */
export const HAND_IN_MAX = 262144
/** How long past its end a window still counts, for a close that comes a little late (as sessions' own meter does) */
export const WINDOW_GRACE_MS = 30000

/** Programs fleet starts that are printed by name; any other is a project's own (`other`, with its purpose) */
const PROGRAMS = new Set(['mv', 'ln', 'rm', 'mkdir', 'git', 'sh', 'python3', 'kill', 'ssh', 'claude'])
/** Kinds of work that aren't calls to the engine: they don't count towards the most work of one run */
const NOT_CALLS = new Set(['listed', 'tokens'])

type Counts = Record<string, number>
type Totals = { runs: number; ms: number; slowest: number; mostWork: number; work: Counts; failed: Counts; sent: Counts; started: Counts; bytesRead: number; bytesWritten: number }
/** One run of an action, while it's going */
export type Run = { name: ActionName; t0: number; out: number; paused: number; calls: number; gives: Run | null; whole: Run | null; gen: number; done: boolean }
export type Value = number | boolean | string | { label: 'role' | 'session'; key: string }
export type Holding = { grows: readonly string[]; count: number; bytes: number | null }
export type HandIn = {
  format: 1
  loadedAt: number
  from: number
  to: number
  partial?: 'reloaded'
  facts: Record<string, Value>
  actions: Record<string, { drivers: readonly Driver[]; grows: readonly string[]; within?: string } & Totals>
  totals: { work: Counts; failed: Counts; sent: Counts; started: Counts; bytesRead: number; bytesWritten: number }
  holdings: Record<string, { grows: readonly string[]; open: [number, number | null]; close: [number, number | null] }>
  project?: Record<string, Record<string, Value>>
}

function fresh(): Totals {
  return { runs: 0, ms: 0, slowest: 0, mostWork: 0, work: {}, failed: {}, sent: {}, started: {}, bytesRead: 0, bytesWritten: 0 }
}

/** The meter's state. `on` is the one thing a counted helper reads while no window is open */
export const M = {
  on: false,
  /** The window ran past its end with no close: counting stopped by itself, and what was counted waits for a close that
   * may still come (a few numbers; the next window, or that close, lets them go) */
  expired: false,
  /** The report this window is for, when it opened (the caller's clock) and when it ends by itself (`Date.now()`) */
  report: '',
  from: 0,
  deadline: 0,
  /** When the counting ends by itself, by the caller's clock (as `from` is): what a window that ran out hands in as its end */
  endsAt: 0,
  /** Which window this is, counted up at every opening: a run keeps the one it began in */
  gen: 0,
  actions: new Map<string, Totals>(),
  totals: fresh(),
  stack: [] as Run[],
  /** Counts kept for the project's part (landings by how they came, wakes by reason), by section and name */
  notes: new Map<string, Counts>(),
  holdingsAtOpen: null as Record<string, Holding> | null,
}

/** When this module loaded, by the system's clock: a hand-in says so, and a window that opened before it is partial */
export const LOADED_AT = Date.now()

/** A window opens: every counter from zero. `msLeft`: how long until it ends by itself (its end, and the grace) */
export function meterOpen(report: string, from: number, msLeft: number) {
  M.actions = new Map()
  M.totals = fresh()
  M.stack = []
  M.notes = new Map()
  M.holdingsAtOpen = null
  M.report = report
  M.from = from
  M.deadline = Date.now() + Math.max(0, msLeft)
  M.endsAt = from + Math.max(0, msLeft)
  M.expired = false
  M.gen++
  M.on = true
}

/** The meter off, and what it held let go */
export function meterOff() {
  M.on = false
  M.expired = false
  M.report = ''
  M.actions = new Map()
  M.totals = fresh()
  M.stack = []
  M.notes = new Map()
  M.holdingsAtOpen = null
}

/** Whether the meter still counts: a window past its end turns itself off here, at the first count that comes */
function counting(): boolean {
  if (!M.on) return false
  if (Date.now() > M.deadline) {
    M.on = false
    M.expired = true
    M.stack = []
    return false
  }
  return true
}

function of(name: string): Totals {
  let t = M.actions.get(name)
  if (!t) M.actions.set(name, (t = fresh()))
  return t
}

/** The run work belongs to now: the newest one still going that isn't waiting on the plugins beneath it */
function current(): Run | null {
  for (let i = M.stack.length - 1; i >= 0; i--) {
    const r = M.stack[i] as Run
    if (r.paused === 0) return r
  }
  return null
}

function add(c: Counts, k: string, n: number) {
  c[k] = (c[k] ?? 0) + n
}

function enter(name: ActionName): Run {
  // The action it runs inside: the newest one going that isn't waiting beneath (never another run of itself: two tool
  // calls of one batch are beside each other). Its time goes back to that one, unless it's a part of it (within)
  const top = current()
  const outer = top && top.name !== name ? top : null
  const part = !!outer && (ACTIONS[name] as Declared).within === outer.name
  const r: Run = { name, t0: Date.now(), out: 0, paused: 0, calls: 0, gives: part ? null : outer, whole: part ? outer : null, gen: M.gen, done: false }
  of(name).runs++
  M.stack.push(r)
  return r
}

function leave(r: Run) {
  if (r.done) return
  r.done = true
  const i = M.stack.lastIndexOf(r)
  if (i !== -1) M.stack.splice(i, 1)
  // A window that closed (or ran out) while it ran, or a run that began in the window before: nothing to add to
  const t = M.actions.get(r.name)
  if (!M.on || !t || r.gen !== M.gen) return
  const whole = Date.now() - r.t0
  const ms = Math.max(0, whole - r.out)
  t.ms += ms
  if (ms > t.slowest) t.slowest = ms
  if (r.calls > t.mostWork) t.mostWork = r.calls
  // Its time comes off the action it ran inside; and when that one is a part, off the part's whole too (a whole keeps
  // its parts' time, so what ran inside a part would be counted in the whole and in itself). Not while that action
  // waits beneath: the wait already comes off it whole
  const g = r.gives
  if (g && !g.done && g.paused === 0) {
    g.out += whole
    for (let w = g.whole; w && !w.done; w = w.whole) w.out += whole
  }
}

/** One run of an action: counted as it's entered, whatever it then finds to do; timed until what it returns settles */
export function run<T>(name: ActionName, fn: (r: Run) => T): T {
  if (!counting()) return fn({ name, t0: 0, out: 0, paused: 0, calls: 0, gives: null, whole: null, gen: -1, done: true })
  const r = enter(name)
  let out: T
  try {
    out = fn(r)
  } catch (err) {
    leave(r)
    throw err
  }
  if (out && typeof (out as any).then === 'function') {
    return (out as any).then(
      (v: unknown) => {
        leave(r)
        return v
      },
      (err: unknown) => {
        leave(r)
        throw err
      },
    ) as T
  }
  leave(r)
  return out
}

/** Before a hook calls `next`: its own run's clock stops (what the plugins beneath and the tool take isn't its own).
 * The run is the one `run` gave the hook's function, whatever else started since. Null with no run (no window is
 * open), or one that is over or of a window before */
export function below(r?: Run | null): { r: Run; t: number } | null {
  if (!r || r.done || r.gen !== M.gen || !counting()) return null
  r.paused++
  return { r, t: Date.now() }
}

/** What `next` returned, passed through: the clock `below()` stopped starts again once it settles */
export function under<T>(stopped: { r: Run; t: number } | null, p: T): T {
  if (!stopped) return p
  const back = () => {
    stopped.r.paused--
    if (stopped.r.gen === M.gen) stopped.r.out += Date.now() - stopped.t
  }
  if (p && typeof (p as any).then === 'function') {
    return (p as any).then(
      (v: unknown) => {
        back()
        return v
      },
      (err: unknown) => {
        back()
        throw err
      },
    ) as T
  }
  back()
  return p
}

/** An action that is only a count (an event that came, a thing found): a run with no time */
export function mark(name: ActionName) {
  if (!counting()) return
  of(name).runs++
}

/** Work done: one call to the engine of that kind (or n entries listed, n tokens) */
export function work(kind: string, n = 1) {
  if (!counting()) return
  add(M.totals.work, kind, n)
  const r = current()
  if (!r) return
  add(of(r.name).work, kind, n)
  if (!NOT_CALLS.has(kind)) r.calls += n
}

/** Work that failed: a file that isn't there, a command that failed or ran out of time, a call refused */
export function failed(kind: string) {
  if (!counting()) return
  add(M.totals.failed, kind, 1)
  const r = current()
  if (r) add(of(r.name).failed, kind, 1)
}

/** Something written that other sessions react to: a landing, a bell, a question, an answer */
export function sent(kind: string) {
  if (!counting()) return
  add(M.totals.sent, kind, 1)
  const r = current()
  if (r) add(of(r.name).sent, kind, 1)
}

/** A process started: its program when it's one of fleet's own, `other` when it's the project's, and what for */
export function started(program: string, purpose = '') {
  if (!counting()) return
  const base = program.slice(program.lastIndexOf('/') + 1)
  const name = PROGRAMS.has(base) ? base : 'other'
  const key = purpose && NAME.test(`${name}:${purpose}`) ? `${name}:${purpose}` : name
  add(M.totals.started, key, 1)
  const r = current()
  if (r) add(of(r.name).started, key, 1)
}

export function bytesRead(n: number) {
  if (!counting()) return
  M.totals.bytesRead += n
  const r = current()
  if (r) of(r.name).bytesRead += n
}

export function bytesWritten(n: number) {
  if (!counting()) return
  M.totals.bytesWritten += n
  const r = current()
  if (r) of(r.name).bytesWritten += n
}

/** A count for the project's part (a landing by how it came, a wake by its reason) */
export function note(section: string, name: string, n = 1) {
  if (!counting()) return
  let c = M.notes.get(section)
  if (!c) M.notes.set(section, (c = {}))
  add(c, name, n)
}

/** A number for the project's part that isn't a count over the window but what was last seen (rows that need the person) */
export function noteSet(section: string, name: string, value: number) {
  if (!counting()) return
  let c = M.notes.get(section)
  if (!c) M.notes.set(section, (c = {}))
  c[name] = value
}

/** Counting stops and what was counted stays, for the hand-in: what the hand-in itself reads isn't the window's work */
export function meterHold() {
  M.on = false
}

/** What a path is for, when a process is started over it: so `mv` reads as the heartbeat's, the lease's, a landing's */
export function purposeOf(path: string): string {
  const at = path.lastIndexOf('/.claude/fleet/')
  if (at === -1) return 'world'
  const rest = path.slice(at + '/.claude/fleet/'.length)
  if (/^instances\/[^/]+\/state\.json$/.test(rest)) return 'heartbeat'
  if (/^instances\/[^/]+\/spend\.json$/.test(rest)) return 'spend'
  if (/^instances\/[^/]+\/(nudges|poll)\.json$/.test(rest)) return 'nudges'
  if (rest.startsWith('instances/')) return 'instance'
  if (rest === 'state/sweeper.json') return 'lease'
  if (rest.startsWith('state/writing/')) return 'writing'
  if (rest.startsWith('state/revs/')) return 'versions'
  if (rest.startsWith('state/')) return 'state'
  if (rest.startsWith('reads/')) return 'reads'
  if (rest.startsWith('events/')) return 'events'
  if (rest.startsWith('decisions/tmp/')) return 'tmp'
  if (rest.startsWith('decisions/')) return 'decisions'
  if (rest.startsWith('runs/')) return 'runs'
  if (rest.startsWith('bell/')) return 'bell'
  if (rest.startsWith('inbox/') || rest.startsWith('intake/')) return 'intake'
  return 'fleet'
}

/** What a write is, to the other sessions: the kind of signal, or '' when nobody watches it */
export function signalOf(path: string): string {
  const at = path.lastIndexOf('/.claude/fleet/')
  if (at === -1) return ''
  const rest = path.slice(at + '/.claude/fleet/'.length)
  if (rest.startsWith('decisions/queue/')) return 'question'
  if (rest.startsWith('decisions/answers/')) return 'answer'
  if (rest.startsWith('decisions/overrules/')) return 'overrule'
  if (rest === 'events/latest') return 'landing'
  if (rest === 'inbox/latest') return 'inbox'
  if (rest.startsWith('bell/')) {
    const kind = rest.slice('bell/'.length)
    return NAME.test(`bell:${kind}`) ? `bell:${kind}` : 'bell:other'
  }
  return ''
}

/** About how many characters a value holds, to a few levels down: strings by their length, a Map, a Set, an array or
 * an object by a few of its entries times how many it has (never all of a large one). What can't be seen into (a
 * promise, a function) counts for nothing */
function weigh(v: unknown, depth: number, sample: number): number {
  if (v === null || v === undefined) return 4
  if (typeof v === 'string') return v.length + 2
  if (typeof v === 'number' || typeof v === 'boolean') return 8
  if (typeof v !== 'object' || depth <= 0) return 0
  if (typeof (v as { then?: unknown }).then === 'function') return 0
  // (a few entries measured, taken as what the others are like)
  const scaled = (n: number, chars: number, size: number) => 2 + (n ? Math.round((chars / n) * size) : 0)
  let n = 0
  let chars = 0
  if (v instanceof Map) {
    for (const [k, x] of v) {
      chars += weigh(k, depth - 1, sample) + weigh(x, depth - 1, sample)
      if (++n >= sample) break
    }
    return scaled(n, chars, v.size)
  }
  if (v instanceof Set || Array.isArray(v)) {
    for (const x of v) {
      chars += weigh(x, depth - 1, sample)
      if (++n >= sample) break
    }
    return scaled(n, chars, v instanceof Set ? v.size : v.length)
  }
  const keys = Object.keys(v as object)
  for (const k of keys) {
    chars += k.length + 2 + weigh((v as Record<string, unknown>)[k], depth - 1, sample)
    if (++n >= sample) break
  }
  return scaled(n, chars, keys.length)
}

/** A count and a rough size of a map or a set: the entries, and a few of them measured (never all of a large one), a
 * Map or a Set inside an entry included */
export function sized(m: Map<unknown, unknown> | Set<unknown> | null | undefined, grows: readonly string[], sample = 8): Holding {
  if (!m) return { grows, count: 0, bytes: 0 }
  const count = m.size
  if (!count) return { grows, count: 0, bytes: 0 }
  let n = 0
  let chars = 0
  try {
    if (m instanceof Map) {
      for (const [k, x] of m) {
        chars += weigh(k, 6, sample) + weigh(x, 6, sample)
        if (++n >= sample) break
      }
    } else {
      for (const x of m) {
        chars += weigh(x, 6, sample)
        if (++n >= sample) break
      }
    }
  } catch {
    return { grows, count, bytes: null }
  }
  return { grows, count, bytes: n ? Math.round((chars / n) * count) : 0 }
}

function clean(c: Counts): Counts {
  const out: Counts = {}
  for (const [k, v] of Object.entries(c)) if (NAME.test(k) && Number.isFinite(v)) out[k] = v
  return out
}

/** The hand-in: everything counted since the window opened, with what's held now beside what was held then */
export function snapshot(to: number, facts: Record<string, Value>, holdings: Record<string, Holding> | null, project?: Record<string, Record<string, Value>>, partial?: 'reloaded'): HandIn {
  const actions: HandIn['actions'] = {}
  for (const [name, t] of M.actions) {
    const d = (ACTIONS as Record<string, Declared>)[name]
    if (!d || !NAME.test(name)) continue
    actions[name] = { drivers: d.drivers, grows: d.grows, ...(d.within ? { within: d.within } : {}), runs: t.runs, ms: t.ms, slowest: t.slowest, mostWork: t.mostWork, work: clean(t.work), failed: clean(t.failed), sent: clean(t.sent), started: clean(t.started), bytesRead: t.bytesRead, bytesWritten: t.bytesWritten }
  }
  const held: HandIn['holdings'] = {}
  const names = new Set([...Object.keys(M.holdingsAtOpen ?? {}), ...Object.keys(holdings ?? {})])
  for (const name of names) {
    if (!NAME.test(name)) continue
    const a = M.holdingsAtOpen?.[name]
    const b = holdings?.[name]
    // (a holding seen at one end only is none at the other: sessions takes a count and a size for both)
    held[name] = { grows: (b ?? a)?.grows ?? [], open: a ? [a.count, a.bytes] : [0, null], close: b ? [b.count, b.bytes] : [0, null] }
  }
  return {
    format: 1,
    loadedAt: LOADED_AT,
    from: M.from,
    to,
    ...(partial ? { partial } : {}),
    facts,
    actions,
    totals: { work: clean(M.totals.work), failed: clean(M.totals.failed), sent: clean(M.totals.sent), started: clean(M.totals.started), bytesRead: M.totals.bytesRead, bytesWritten: M.totals.bytesWritten },
    holdings: held,
    ...(project ? { project } : {}),
  }
}

/** What sessions' checker would refuse in a hand-in, each with where: the same rules as its checkHandIn (a plugin's
 * tests can't import another plugin's file, so fleet's tests hold fleet to them here). The fields its format has and
 * no other; every key and word of the pattern; every number finite and not negative; drivers and labels it knows;
 * a holding with a count and a size at both ends. Empty when it would pass */
export function refusals(data: unknown): string[] {
  const out: string[] = []
  const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
  const amount = (x: unknown, at: string) => {
    if (!(typeof x === 'number' && Number.isFinite(x) && x >= 0)) out.push(`${at}: not a count (${String(x)})`)
  }
  const word = (x: unknown, at: string) => {
    if (!(typeof x === 'string' && NAME.test(x))) out.push(`${at}: the word ${JSON.stringify(x)}`)
  }
  const words = (x: unknown, at: string) => {
    if (!Array.isArray(x)) out.push(`${at}: not a list`)
    else x.forEach((v, i) => word(v, `${at}[${i}]`))
  }
  const fields = (x: unknown, at: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null => {
    if (!isRecord(x)) {
      out.push(`${at}: not an object`)
      return null
    }
    const keys = Object.keys(x).filter(k => x[k] !== undefined)
    for (const k of keys) if (!required.includes(k) && !optional.includes(k)) out.push(`${at}: the key ${JSON.stringify(k)} isn't in the format`)
    for (const k of required) if (!keys.includes(k)) out.push(`${at}: no ${k}`)
    return x
  }
  const named = (x: unknown, at: string, each: (v: unknown, at: string) => void) => {
    if (!isRecord(x)) {
      out.push(`${at}: not an object`)
      return
    }
    for (const [k, v] of Object.entries(x)) {
      if (!NAME.test(k)) out.push(`${at}: the key ${JSON.stringify(k)}`)
      each(v, `${at}.${k}`)
    }
  }
  const counts = (x: unknown, at: string) => named(x, at, amount)
  const value = (x: unknown, at: string) => {
    if (typeof x === 'boolean') return
    if (typeof x === 'number') return amount(x, at)
    if (typeof x === 'string') return word(x, at)
    if (!isRecord(x) || Object.keys(x).length !== 2 || (x.label !== 'session' && x.label !== 'role') || typeof x.key !== 'string' || !x.key) out.push(`${at}: not a label`)
  }
  const values = (x: unknown, at: string) => named(x, at, value)
  const WORK = ['work', 'failed', 'sent', 'started', 'bytesRead', 'bytesWritten']
  const worked = (a: Record<string, unknown>, at: string) => {
    counts(a.work, `${at}.work`)
    counts(a.failed, `${at}.failed`)
    counts(a.sent, `${at}.sent`)
    counts(a.started, `${at}.started`)
    amount(a.bytesRead, `${at}.bytesRead`)
    amount(a.bytesWritten, `${at}.bytesWritten`)
  }
  const tuple = (x: unknown, at: string) => {
    if (!Array.isArray(x) || x.length !== 2) return void out.push(`${at}: not a count and a size`)
    amount(x[0], `${at}[0]`)
    if (x[1] !== null) amount(x[1], `${at}[1]`)
  }
  const d = fields(data, 'data', ['format', 'loadedAt', 'from', 'to', 'facts', 'actions', 'totals', 'holdings'], ['partial', 'project'])
  if (!d) return out
  if (d.format !== 1) out.push(`data.format: ${String(d.format)}`)
  if (d.partial !== undefined && d.partial !== 'reloaded') out.push(`data.partial: ${String(d.partial)}`)
  amount(d.loadedAt, 'data.loadedAt')
  amount(d.from, 'data.from')
  amount(d.to, 'data.to')
  values(d.facts, 'data.facts')
  named(d.actions, 'data.actions', (v, at) => {
    const a = fields(v, at, ['drivers', 'grows', 'runs', 'ms', 'slowest', 'mostWork', ...WORK], ['within'])
    if (!a) return
    if (!Array.isArray(a.drivers) || a.drivers.some(x => x !== 'clock' && x !== 'self' && x !== 'person' && x !== 'peer')) out.push(`${at}.drivers: ${JSON.stringify(a.drivers)}`)
    words(a.grows, `${at}.grows`)
    if (a.within !== undefined) word(a.within, `${at}.within`)
    for (const k of ['runs', 'ms', 'slowest', 'mostWork']) amount(a[k], `${at}.${k}`)
    worked(a, at)
  })
  const totals = fields(d.totals, 'data.totals', WORK)
  if (totals) worked(totals, 'data.totals')
  named(d.holdings, 'data.holdings', (v, at) => {
    const h = fields(v, at, ['grows', 'open', 'close'])
    if (!h) return
    words(h.grows, `${at}.grows`)
    tuple(h.open, `${at}.open`)
    tuple(h.close, `${at}.close`)
  })
  if (d.project !== undefined) named(d.project, 'data.project', values)
  if (isRecord(d.actions) && Object.keys(d.actions).length > 400) out.push('data.actions: more than 400')
  if (isRecord(d.holdings) && Object.keys(d.holdings).length > 400) out.push('data.holdings: more than 400')
  return out
}
