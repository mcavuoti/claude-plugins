// /sessions debug: the report. Pure: what the sampler read and what the plugins handed in go in; the file that may leave
// the machine, the key that stays on it and the summary as text come out. No engine call, no file, no clock.
//
// Nothing free-text reaches the file or the plain summary. The only strings they hold are this file's own fixed words,
// the NAME words of a hand-in that passed checkHandIn, the report's labels (S1, P1, R1), versions that look like
// versions, and program names on the list. Titles, folders and session ids go to the key, and to the on-screen text's
// parentheses, and nowhere else.
import {
  DEBUG_FORMAT,
  DRIVERS,
  NAME,
  type ActionTotals,
  type Built,
  type Counts,
  type Driver,
  type HandIn,
  type Holding,
  type Label,
  type Pair,
  type Report,
  type ReportInput,
  type ReportKey,
  type ReportSession,
  type SampledProcess,
  type SampledRole,
  type SamplerOutput,
  type Value,
} from './types'

// The programs a report names (a session's helper processes and what the plugins start); any other is `other`
export const PROGRAMS: readonly string[] = [
  'git', 'mv', 'mkdir', 'rmdir', 'ln', 'cp', 'rm', 'cat', 'python3', 'bash', 'sh', 'jq', 'ps', 'ssh', 'p4', 'kill',
  'osascript', 'lsappinfo', 'ioreg', 'lsof', 'sysctl', 'caffeinate', 'security', 'claude', 'node', 'sleep', 'grep',
  'head', 'tr', 'xprop', 'wmctrl', 'xdotool',
]

// The terminal programs that count as "the terminal"
export const TERMINALS: readonly string[] = ['Terminal', 'iTerm2', 'gnome-terminal-server', 'konsole', 'xterm', 'alacritty', 'kitty', 'wezterm-gui', 'ghostty']

// The readings a sampler may say a system doesn't have. Any other word it gives is written as `unknown`
export const READINGS: readonly string[] = ['pressure', 'free', 'swap', 'battery', 'wakeups', 'terminal', 'service', 'other', 'pss', 'peak', 'threads', 'transcript', 'helpers']
// Those each system should have: one of them missing is worth a line in "Looks off". Linux may lack memory pressure (an
// old kernel), a battery (a server) and a terminal (no display); the proportional size is Linux's only
const SHOULD_HAVE: Record<'macos' | 'linux', readonly string[]> = {
  macos: ['pressure', 'free', 'swap', 'battery', 'wakeups', 'other', 'peak', 'threads'],
  linux: ['free', 'swap', 'wakeups', 'other', 'peak', 'threads'],
}
// The kinds of wake-up a sampler counts: macOS's idle and interrupt wake-ups, Linux's context switches
const WAKEUPS: readonly string[] = ['idle', 'interrupt', 'voluntary', 'involuntary']

// What a hand-in may hold at most. A plugin has about 40 actions and as many holdings: past these it isn't a hand-in
export const MAX_ACTIONS = 400
export const MAX_HOLDINGS = 400
const MAX_KEYS = 400
const MAX_WORDS = 16
const MAX_LABEL_KEY = 200

// The facts of a hand-in the generic "Looks off" rules read: how the session hears of changes (`timers` when it's on
// its timers), and whether somebody could be looking at it (false: no window shows it). A draw is an action with `draw`
// as one of its name's parts (draw.panel, band.draw)
export const FACT_LIVE = 'live'
export const LIVE_TIMERS = 'timers'
export const FACT_LOOKING = 'looking'
const DRAW = /(^|[.:-])draw([.:-]|$)/

// The width the text keeps to
const WIDTH = 100
// How many lines one rule gets in "Looks off" before the rest are counted in one
const OFF_LINES = 5
// How many actions a plugin's table shows before the least active ones fold into "the rest", and how many holdings
const TABLE_ROWS = 12
const HOLDING_ITEMS = 8
// How many sessions a trend across them takes
const TREND_SESSIONS = 6

// ---- numbers ----

// The middle value, or the mean of the two in the middle; null with none
export function median(values: readonly number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const half = sorted.length >> 1
  const hi = sorted[half] ?? 0
  return sorted.length % 2 ? hi : ((sorted[half - 1] ?? 0) + hi) / 2
}

// Pearson's r: how closely two readings of the same sessions rise together, from -1 to 1. null with fewer than 3 pairs,
// or when either reading is the same for all (no spread to compare)
export function correlation(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return null
  const a = xs.slice(0, n)
  const b = ys.slice(0, n)
  if (Math.max(...a) === Math.min(...a) || Math.max(...b) === Math.min(...b)) return null
  const meanA = sum(a) / n
  const meanB = sum(b) / n
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < n; i++) {
    const da = (a[i] ?? 0) - meanA
    const db = (b[i] ?? 0) - meanB
    ab += da * db
    aa += da * da
    bb += db * db
  }
  if (!(aa > 0) || !(bb > 0)) return null
  return Math.max(-1, Math.min(1, ab / Math.sqrt(aa * bb)))
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0)
const mid = (values: readonly number[]): number => median(values) ?? 0

// A number as the text prints it: one decimal under 10, none from 100 on (with a comma every three digits), and in
// between one decimal unless it's whole. Nothing is `0`
export function num(v: number): string {
  if (!Number.isFinite(v)) return '-'
  const a = Math.abs(v)
  if (a >= 99.95) return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const t = a.toFixed(1)
  if (t === '0.0') return a === 0 ? '0' : '0.0'
  return (v < 0 ? '-' : '') + (a >= 9.95 && t.endsWith('.0') ? t.slice(0, -2) : t)
}

// A count of whole things: `3`, not `3.0`; a fraction keeps its decimal (0.5 a minute)
export const count = (v: number): string => num(v).replace(/\.0$/, '')
// A time in ms. An action under a millisecond reads as 0 on the meter's clock: when it ran, that's `<1`, not nothing
export const ms = (v: number, ran: boolean): string => (v === 0 && ran ? '<1' : num(v))
const pct = (v: number): string => `${num(v)} %`
const signed = (v: number): string => `${v < 0 ? '-' : '+'}${num(Math.abs(v))}`
const trendText = (r: number): string => `${r < 0 ? '-' : '+'}${Math.abs(r).toFixed(2)}`

// Memory in MB, as MB or GB
export function megabytes(v: number): string {
  return Math.abs(v) >= 1000 ? `${num(v / 1024)} GB` : `${num(v)} MB`
}

// A size in bytes, as B, KB, MB or GB
export function bytes(v: number): string {
  if (v < 1000) return `${count(v)} B`
  if (v < 1024 ** 2) return `${num(v / 1024)} KB`
  if (v < 1024 ** 3) return `${num(v / 1024 ** 2)} MB`
  return `${num(v / 1024 ** 3)} GB`
}

// ---- checking what a plugin handed in ----

// Why a hand-in is refused: fixed words, never an echo of what was wrong
export type Refusal = 'shape' | 'format' | 'name' | 'number' | 'driver' | 'label' | 'too-many-actions' | 'too-many-holdings' | 'too-many-keys'
export const REFUSALS: readonly Refusal[] = ['shape', 'format', 'name', 'number', 'driver', 'label', 'too-many-actions', 'too-many-holdings', 'too-many-keys']

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const own = <T>(of: Record<string, T>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(of, key) ? of[key] : undefined)

// The checks below stop at the first thing wrong by throwing its reason; checkHandIn turns that into its answer
const refuse = (why: Refusal): never => {
  throw { refused: why }
}
const amount = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : refuse('number'))
const word = (x: unknown): string => (typeof x === 'string' && NAME.test(x) ? x : refuse('name'))
const words = (x: unknown): string[] => (Array.isArray(x) && x.length <= MAX_WORDS ? Array.from(x, v => word(v)) : refuse('shape'))

// An object with these keys and no other. A key holding undefined is no key (JSON drops it)
function fields(x: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(x)) return refuse('shape')
  const keys = Object.keys(x).filter(k => x[k] !== undefined)
  if (keys.some(k => !required.includes(k) && !optional.includes(k)) || required.some(k => !keys.includes(k))) return refuse('shape')
  return x
}

// A map whose keys are names, and not too many of them
function named(x: unknown, max = MAX_KEYS, over: Refusal = 'too-many-keys'): [string, unknown][] {
  if (!isRecord(x)) return refuse('shape')
  const pairs = Object.entries(x)
  if (pairs.length > max) return refuse(over)
  for (const [k] of pairs) word(k)
  return pairs
}

const counts = (x: unknown): Counts => Object.fromEntries(named(x).map(([k, v]) => [k, amount(v)]))

// A value: a number, a boolean, a word, or a session or a role for the report to label. A label's key is the one free
// text a hand-in may carry: it goes to the key file and never to the report
function value(x: unknown): Value {
  if (typeof x === 'boolean') return x
  if (typeof x === 'number') return amount(x)
  if (typeof x === 'string') return word(x)
  if (!isRecord(x)) return refuse('shape')
  const { label, key } = x
  if (Object.keys(x).length !== 2 || (label !== 'session' && label !== 'role') || typeof key !== 'string' || !key || key.length > MAX_LABEL_KEY) return refuse('label')
  return { label, key }
}

const values = (x: unknown): Record<string, Value> => Object.fromEntries(named(x).map(([k, v]) => [k, value(v)]))

const WORK = ['work', 'failed', 'sent', 'started', 'bytesRead', 'bytesWritten'] as const

function action(x: unknown): ActionTotals {
  const a = fields(x, ['drivers', 'grows', 'runs', 'ms', 'slowest', 'mostWork', ...WORK], ['within'])
  if (!Array.isArray(a.drivers) || a.drivers.length > DRIVERS.length) return refuse('shape')
  const drivers = Array.from(a.drivers, d => (DRIVERS.includes(d as Driver) ? (d as Driver) : refuse('driver')))
  return {
    drivers,
    grows: words(a.grows),
    ...(a.within === undefined ? {} : { within: word(a.within) }),
    runs: amount(a.runs),
    ms: amount(a.ms),
    slowest: amount(a.slowest),
    mostWork: amount(a.mostWork),
    work: counts(a.work),
    failed: counts(a.failed),
    sent: counts(a.sent),
    started: counts(a.started),
    bytesRead: amount(a.bytesRead),
    bytesWritten: amount(a.bytesWritten),
  }
}

// How many and about how many bytes (null when the plugin can't say)
function held(x: unknown): [number, number | null] {
  if (!Array.isArray(x) || x.length !== 2) return refuse('shape')
  return [amount(x[0]), x[1] === null ? null : amount(x[1])]
}

function holding(x: unknown): Holding {
  const h = fields(x, ['grows', 'open', 'close'])
  return { grows: words(h.grows), open: held(h.open), close: held(h.close) }
}

// Checks what a plugin handed in before any of it reaches a report: the format, every key and word against NAME, every
// number finite and not negative, drivers from DRIVERS, labels well formed, at most 400 actions and 400 holdings, and
// no key the format doesn't have. Anything else is refused whole, with a short reason made of fixed words. What it
// gives back is a copy: nothing of the plugin's own object goes on
export function checkHandIn(data: unknown): { ok: true; handIn: HandIn } | { ok: false; why: Refusal } {
  try {
    if (!isRecord(data)) return { ok: false, why: 'shape' }
    if (data.format !== DEBUG_FORMAT) return { ok: false, why: 'format' }
    const d = fields(data, ['format', 'loadedAt', 'from', 'to', 'facts', 'actions', 'totals', 'holdings'], ['partial', 'project'])
    if (d.partial !== undefined && d.partial !== 'reloaded') return { ok: false, why: 'shape' }
    const totals = fields(d.totals, WORK)
    const handIn: HandIn = {
      format: DEBUG_FORMAT,
      loadedAt: amount(d.loadedAt),
      from: amount(d.from),
      to: amount(d.to),
      ...(d.partial === undefined ? {} : { partial: 'reloaded' as const }),
      facts: values(d.facts),
      actions: Object.fromEntries(named(d.actions, MAX_ACTIONS, 'too-many-actions').map(([k, v]) => [k, action(v)])),
      totals: {
        work: counts(totals.work),
        failed: counts(totals.failed),
        sent: counts(totals.sent),
        started: counts(totals.started),
        bytesRead: amount(totals.bytesRead),
        bytesWritten: amount(totals.bytesWritten),
      },
      holdings: Object.fromEntries(named(d.holdings, MAX_HOLDINGS, 'too-many-holdings').map(([k, v]) => [k, holding(v)])),
      ...(d.project === undefined ? {} : { project: Object.fromEntries(named(d.project).map(([k, v]) => [k, values(v)])) }),
    }
    return { ok: true, handIn }
  } catch (err) {
    const why = isRecord(err) ? err.refused : undefined
    return { ok: false, why: REFUSALS.find(r => r === why) ?? 'shape' }
  }
}

// ---- what may be written ----

const VERSION = /^[0-9][0-9A-Za-z.+-]{0,23}$/
const REPORT_ID = /^r-[0-9a-f]{1,32}$/

// A version as a report writes it: one that looks like a version, or `unknown`
export const cleanVersion = (v: unknown): string => (typeof v === 'string' && VERSION.test(v) ? v : 'unknown')
// A plugin's name as a report writes it: one that looks like a plugin's name (lower case, digits and dashes), or `other`
const PLUGIN = /^[a-z][a-z0-9-]{0,30}$/
export const cleanPlugin = (name: unknown): string => (typeof name === 'string' && PLUGIN.test(name) ? name : 'other')

// A program a plugin says it started, `program` or `program:purpose`, as a report writes it: the program when it's on
// the list, `other` when it isn't (a tool's name can say whose machine it is); the purpose stays
export function foldProgram(name: string, programs: readonly string[]): string {
  const at = name.indexOf(':')
  const program = at < 0 ? name : name.slice(0, at)
  const purpose = at < 0 ? '' : name.slice(at + 1)
  return (programs.includes(program) ? program : 'other') + (/^[A-Za-z0-9.:-]+$/.test(purpose) ? `:${purpose}` : '')
}

const programOf = (name: string): string => name.split(':')[0] ?? name

// Counts by program with every program off the list counted under `other`
function foldCounts(of: Counts, fold: (name: string) => string): Counts {
  const out: Counts = {}
  for (const [name, n] of Object.entries(of)) {
    const to = fold(name)
    out[to] = (own(out, to) ?? 0) + n
  }
  return out
}

// A hand-in as the report writes it: its sessions and roles under the report's labels, its programs folded
function relabel(h: HandIn, labelOf: (l: Label) => string, programs: readonly string[]): HandIn {
  const fold = (c: Counts) => foldCounts(c, name => foldProgram(name, programs))
  const told = (of: Record<string, Value>): Record<string, Value> =>
    Object.fromEntries(Object.keys(of).sort().map(k => [k, isRecord(of[k]) ? labelOf(of[k] as Label) : (of[k] as Value)]))
  return {
    ...h,
    facts: told(h.facts),
    actions: Object.fromEntries(Object.entries(h.actions).map(([k, a]) => [k, { ...a, started: fold(a.started) }])),
    totals: { ...h.totals, started: fold(h.totals.started) },
    ...(h.project ? { project: Object.fromEntries(Object.keys(h.project).sort().map(k => [k, told(h.project?.[k] ?? {})])) } : {}),
  }
}

const amountOr = <T>(x: unknown, or: T): number | T => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : or)
const pairOr = (x: unknown): Pair | null => (Array.isArray(x) && x.length === 2 && x.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0) ? [x[0], x[1]] : null)

// A process as the sampler read it, rebuilt field by field: numbers, the two memory measures, the wake-up kinds and the
// programs on the list. Whatever else the sampler's output held stays behind
function cleanProcess(p: unknown, programs: readonly string[]): SampledProcess | null {
  if (!isRecord(p)) return null
  const fold = (name: string) => (programs.includes(name) ? name : 'other')
  const numbers = (x: unknown, to: (name: string) => string): Counts => {
    const out: Counts = {}
    for (const [k, v] of Object.entries(isRecord(x) ? x : {})) out[to(k)] = (own(out, to(k)) ?? 0) + amountOr(v, 0)
    return out
  }
  const helpers: SampledProcess['helpers'] = {}
  for (const [k, v] of Object.entries(isRecord(p.helpers) ? p.helpers : {})) {
    const to = fold(k)
    const had = own(helpers, to) ?? { count: 0, memoryMB: 0 }
    helpers[to] = { count: had.count + amountOr(isRecord(v) ? v.count : 0, 0), memoryMB: had.memoryMB + amountOr(isRecord(v) ? v.memoryMB : 0, 0) }
  }
  return {
    cpuMs: amountOr(p.cpuMs, 0),
    childCpuMs: amountOr(p.childCpuMs, 0),
    memoryMB: pairOr(p.memoryMB) ?? [0, 0],
    memoryKind: p.memoryKind === 'rss' ? 'rss' : 'footprint',
    peakMB: amountOr(p.peakMB, null),
    pssMB: amountOr(p.pssMB, null),
    wakeups: isRecord(p.wakeups) ? numbers(p.wakeups, k => (WAKEUPS.includes(k) ? k : 'other')) : null,
    threads: amountOr(p.threads, null),
    gone: p.gone === true,
    started: numbers(p.started, fold),
    helpers,
    transcriptMB: amountOr(p.transcriptMB, null),
  }
}

function cleanRole(r: unknown): SampledRole | null {
  if (!isRecord(r)) return null
  return { count: amountOr(r.count, 0), cpuMs: amountOr(r.cpuMs, 0), memoryMB: amountOr(r.memoryMB, 0), threads: amountOr(r.threads, null) }
}

// ---- what the report reckons from its input ----

// One plugin's hand-in in one session, with what every rate is over: the minutes it counted for, the ms a minute inside
// its actions and the runs a minute of those another session's activity drives. An action that is part of another
// (`within`) is in neither: its time and its runs are inside its parent's
type Meter = { handIn: HandIn; minutes: number; ms: number; peerRuns: number }

type Row = {
  id: string
  // Its project's label (P1)
  project: string
  status: ReportSession['status']
  ageHours: number | null
  plugins: string[]
  process: SampledProcess | null
  // It has a process that was still there when the window closed: only these count in the medians
  alive: boolean
  // % of one core, and ms of CPU a minute; its helpers' % of one core
  cpu: number
  cpuMs: number
  child: number
  // MB when the window closed, its helpers' MB, and the change over the window
  memory: number
  helpers: number
  grew: number
  // Wake-ups a second (all kinds) and processes started a minute
  wakes: number | null
  starts: number
  meters: Record<string, Meter>
  // The plugins it runs that handed nothing in, and those whose hand-in was refused
  silent: string[]
  refused: string[]
}

type Trend = { n: number; r: number | null }

export type Digest = {
  report: string
  asked: number
  os: 'macos' | 'linux'
  minutes: number
  sampled: boolean
  host: Report['host']
  rows: Row[]
  // Every plugin a session runs or that handed in, in the order the text names them; and those with a hand-in taken
  plugins: string[]
  metered: string[]
  unavailable: string[]
  other: Report['other']
  roles: Report['roles']
  programs: { name: string; seen: number; said: number }[]
  // A session began inside the window: what grows with the sessions had a reason to
  newSessions: boolean
  cpuPeer: Trend
  memoryAge: Trend
  memoryTranscript: Trend
}

function meterOf(handIn: HandIn, seconds: number): Meter {
  const span = handIn.to - handIn.from
  const minutes = (span > 0 ? span / 1000 : seconds) / 60
  let inside = 0
  let peerRuns = 0
  for (const a of Object.values(handIn.actions)) {
    if (a.within) continue
    inside += a.ms
    if (a.drivers.includes('peer')) peerRuns += a.runs
  }
  return { handIn, minutes, ms: inside / minutes, peerRuns: peerRuns / minutes }
}

const idle = (r: Row): boolean => r.alive && r.status === 'idle'
const trend = (pairs: readonly [number, number][]): Trend => ({
  n: pairs.length,
  r: pairs.length >= TREND_SESSIONS ? correlation(pairs.map(p => p[0]), pairs.map(p => p[1])) : null,
})

// Labels the sessions, projects and roles, checks every hand-in and rebuilds the sampler's output: the file, the key,
// and the numbers the text and "Looks off" are made from
function gather(input: ReportInput): { report: Report; key: ReportKey; digest: Digest } {
  const programs = input.programs
  const asked = amountOr(input.seconds, 0)
  const raw: unknown = input.sampler
  const sampler = isRecord(raw) && raw.format === DEBUG_FORMAT && isRecord(raw.machine) && isRecord(raw.processes) ? (raw as SamplerOutput) : null
  const seconds = Math.max(1, sampler ? amountOr(sampler.seconds, 0) || asked : asked)
  const minutes = seconds / 60
  const id = typeof input.report === 'string' && REPORT_ID.test(input.report) ? input.report : 'unknown'

  const missing = new Map<string, Report['missing'][number]>()
  const miss = (what: 'session' | 'hand-in' | 'sampler', why: string, plugin?: string) => {
    const at = `${what} ${plugin ?? ''} ${why}`
    const had = missing.get(at)
    if (had) had.count++
    else missing.set(at, { what, ...(plugin === undefined ? {} : { plugin }), count: 1, why })
  }
  if (!sampler) miss('sampler', raw === null || raw === undefined ? 'missing' : isRecord(raw) && raw.format !== DEBUG_FORMAT ? 'format' : 'shape')

  // Sessions by pid, so the same fleet gets the same labels whatever order the list came in
  const pidOf = (s: ReportSession) => (typeof s.pid === 'number' && Number.isFinite(s.pid) ? s.pid : Infinity)
  const sessions = [...input.sessions].sort((a, b) => (pidOf(a) === pidOf(b) ? 0 : pidOf(a) < pidOf(b) ? -1 : 1))
  const key: ReportKey = { report: id, sessions: {}, projects: {}, roles: {} }
  const sessionLabels = new Map<string, string>()
  const projectLabels = new Map<string, string>()
  const roleLabels = new Map<string, string>()
  sessions.forEach((s, i) => {
    if (!sessionLabels.has(s.sessionId)) sessionLabels.set(s.sessionId, `S${i + 1}`)
  })
  const labelOf = (l: Label): string => {
    if (l.label === 'session') return sessionLabels.get(l.key) ?? 'unknown'
    const had = roleLabels.get(l.key)
    if (had) return had
    const made = `R${roleLabels.size + 1}`
    roleLabels.set(l.key, made)
    key.roles[made] = l.key
    return made
  }

  const hostPlugins: Record<string, string> = {}
  for (const [name, version] of Object.entries(isRecord(input.host.plugins) ? input.host.plugins : {})) {
    const to = cleanPlugin(name)
    hostPlugins[to] = own(hostPlugins, to) === undefined ? cleanVersion(version) : 'unknown'
  }

  // A plugin's project part may say which sessions run it: a section named `running`, each value a session label. One
  // of those that handed nothing in is a session that didn't answer, not a session without the plugin
  const runs = new Map<string, Set<string>>()
  for (const perSession of Object.values(isRecord(input.handIns) ? input.handIns : {})) {
    for (const [name, data] of Object.entries(isRecord(perSession) ? perSession : {})) {
      const checked = checkHandIn(data)
      if (!checked.ok) continue
      for (const v of Object.values(checked.handIn.project?.running ?? {})) {
        if (!isRecord(v) || v.label !== 'session') continue
        const id = String(v.key)
        runs.set(id, (runs.get(id) ?? new Set<string>()).add(name))
      }
    }
  }

  const rows: Row[] = []
  const out: Report['sessions'] = []
  sessions.forEach((s, i) => {
    const label = `S${i + 1}`
    const root = String(s.root)
    let project = projectLabels.get(root)
    if (!project) {
      project = `P${projectLabels.size + 1}`
      projectLabels.set(root, project)
      key.projects[project] = root
    }
    key.sessions[label] = { title: String(s.title), sessionId: String(s.sessionId), root }

    // Its plugins: those its heartbeat shows and those that handed in, by name
    const handed = isRecord(input.handIns) ? own(input.handIns, s.sessionId) : undefined
    const handedIn = isRecord(handed) ? handed : {}
    const plugins = [...new Set([...(Array.isArray(s.plugins) ? s.plugins : []), ...Object.keys(handedIn), ...(runs.get(String(s.sessionId)) ?? [])].map(cleanPlugin))].sort()
    const meters: Record<string, HandIn | null> = {}
    const taken: Record<string, Meter> = {}
    const refused: string[] = []
    for (const plugin of plugins) meters[plugin] = null
    for (const name of Object.keys(handedIn).sort()) {
      const plugin = cleanPlugin(name)
      const checked = plugin === name ? checkHandIn(handedIn[name]) : ({ ok: false, why: 'name' } as const)
      if (!checked.ok) {
        miss('hand-in', checked.why, plugin)
        if (!refused.includes(plugin)) refused.push(plugin)
        continue
      }
      const handIn = relabel(checked.handIn, labelOf, programs)
      meters[plugin] = handIn
      taken[plugin] = meterOf(handIn, seconds)
    }
    const status = (['idle', 'busy', 'waiting'] as const).find(x => x === s.status) ?? 'stopped'
    const sampled = sampler ? cleanProcess(own(sampler.processes, String(s.pid)), programs) : null
    const alive = !!sampled && !sampled.gone
    // A session that was running and didn't answer: a stopped one, or one that ended inside the window, couldn't
    const silent = status === 'stopped' || sampled?.gone ? [] : plugins.filter(p => !own(taken, p) && !refused.includes(p))
    for (const plugin of silent) miss('session', 'no-answer', plugin)
    if (sampler && !sampled && status !== 'stopped') miss('session', 'no-process')

    const ageHours = amountOr(s.ageHours, null)
    const wakeups = sampled?.wakeups
    rows.push({
      id: label,
      project,
      status,
      ageHours,
      plugins,
      process: sampled,
      alive,
      cpu: ((sampled?.cpuMs ?? 0) / (seconds * 1000)) * 100,
      cpuMs: (sampled?.cpuMs ?? 0) / minutes,
      child: ((sampled?.childCpuMs ?? 0) / (seconds * 1000)) * 100,
      memory: sampled?.memoryMB[1] ?? 0,
      helpers: sum(Object.values(sampled?.helpers ?? {}).map(h => h.memoryMB)),
      grew: sampled ? sampled.memoryMB[1] - sampled.memoryMB[0] : 0,
      wakes: wakeups ? sum(Object.values(wakeups)) / seconds : null,
      starts: sum(Object.values(sampled?.started ?? {})) / minutes,
      meters: taken,
      silent,
      refused,
    })
    out.push({ id: label, project, kind: s.kind === 'background' ? 'background' : 'regular', status, ageHours, plugins, process: sampled, meters })
  })

  // A hand-in filed under a session the list doesn't have (it ended, or it was never this report's): counted, not read
  const listedIds = new Set(sessions.map(x => x.sessionId))
  for (const [sessionId, handed] of Object.entries(isRecord(input.handIns) ? input.handIns : {})) {
    if (listedIds.has(sessionId) || !isRecord(handed)) continue
    for (const name of Object.keys(handed)) miss('hand-in', 'no-session', cleanPlugin(name))
  }

  // The plugins in the order the text names them: the host's own order first, then by name
  const named = new Set(rows.flatMap(r => r.plugins))
  const plugins = [...Object.keys(hostPlugins).filter(p => named.has(p)), ...[...named].filter(p => own(hostPlugins, p) === undefined).sort()]
  const metered = plugins.filter(p => rows.some(r => own(r.meters, p)))

  // Processes started a minute, all sessions: what the sampler saw, and what the plugins say they started
  const seen = new Map<string, number>()
  const said = new Map<string, number>()
  for (const r of rows) {
    for (const [name, n] of Object.entries(r.process?.started ?? {})) seen.set(name, (seen.get(name) ?? 0) + n / minutes)
    for (const m of Object.values(r.meters)) {
      for (const [name, n] of Object.entries(m.handIn.totals.started)) said.set(programOf(name), (said.get(programOf(name)) ?? 0) + n / m.minutes)
    }
  }
  const started = [...new Set([...seen.keys(), ...said.keys()])]
    .map(name => ({ name, seen: seen.get(name) ?? 0, said: said.get(name) ?? 0 }))
    .sort((a, b) => Number(a.name === 'other') - Number(b.name === 'other') || b.seen - a.seen || b.said - a.said || a.name.localeCompare(b.name))

  const machine = sampler?.machine
  const pressureKind = machine?.pressureKind === 'level' || machine?.pressureKind === 'psi' ? machine.pressureKind : null
  const os = input.host.os === 'linux' ? 'linux' : 'macos'
  const host: Report['host'] = {
    os,
    osMajor: amountOr(input.host.osMajor, null),
    claude: cleanVersion(input.host.claude),
    plugins: hostPlugins,
    cores: amountOr(machine?.cores, null),
    memoryMB: amountOr(machine?.memoryMB, null),
    battery: typeof machine?.battery === 'boolean' ? machine.battery : null,
    freeMB: pairOr(machine?.freeMB),
    swapUsedMB: pairOr(machine?.swapUsedMB),
    pressure: pressureKind ? pairOr(machine?.pressure) : null,
    pressureKind,
  }
  const other = isRecord(sampler?.other) ? { cpuMs: amountOr(sampler?.other?.cpuMs, 0), largestMs: amountOr(sampler?.other?.largestMs, 0), over20: amountOr(sampler?.other?.over20, 0) } : null
  const roles = { terminal: cleanRole(sampler?.roles?.terminal), service: cleanRole(sampler?.roles?.service) }
  const readings: unknown = sampler?.unavailable
  const unavailable = [...new Set((Array.isArray(readings) ? readings : []).map(u => (READINGS.includes(u) ? String(u) : 'unknown')))]

  const alive = rows.filter(r => r.alive)
  const digest: Digest = {
    report: id,
    asked,
    os,
    minutes,
    sampled: !!sampler,
    host,
    rows,
    plugins,
    metered,
    unavailable,
    other,
    roles,
    programs: started,
    newSessions: rows.some(r => r.ageHours !== null && r.ageHours * 3600 < seconds),
    // Idle sessions only: a busy one's CPU is the model's work, and it runs more of every action its own turns drive
    cpuPeer: trend(rows.filter(r => idle(r) && Object.keys(r.meters).length > 0).map(r => [sum(Object.values(r.meters).map(m => m.peerRuns)), r.cpuMs] as [number, number])),
    memoryAge: trend(alive.flatMap(r => (r.ageHours === null ? [] : [[r.ageHours, r.memory] as [number, number]]))),
    memoryTranscript: trend(alive.flatMap(r => (r.process?.transcriptMB == null ? [] : [[r.process.transcriptMB, r.memory] as [number, number]]))),
  }
  const report: Report = {
    format: DEBUG_FORMAT,
    report: id,
    profile: 'perf',
    at: typeof input.at === 'number' && Number.isFinite(input.at) && Math.abs(input.at) < 8.64e15 ? new Date(input.at).toISOString() : 'unknown',
    seconds: asked,
    host,
    sessions: out,
    other,
    roles,
    unavailable,
    missing: [...missing.values()],
    off: [],
  }
  return { report, key, digest }
}

// ---- "Looks off" ----

// What a rule found: what it's about (a label or a word) and the value to set against the rule's limit. A finding about
// one action of one plugin says which, so that plugin's table can point at the row
type Hit = { about: string; value: number; plugin?: string; action?: string; session?: string }

// A rule of "Looks off": a fixed name, a limit, what it reads from the report's numbers, and how its line reads. A
// finding is a value over the limit. A later rule is one more entry here
export type Rule = { name: string; limit: number; values: (d: Digest) => Hit[]; line: (about: string, value: number, limit: number, hit?: Hit) => string }

// The largest value per action (of a plugin) across the sessions given
function worstByAction(rows: readonly Row[], of: (a: ActionTotals, m: Meter, name: string) => number | null): Hit[] {
  const worst = new Map<string, Hit>()
  for (const r of rows) {
    for (const [plugin, m] of Object.entries(r.meters)) {
      for (const [name, a] of Object.entries(m.handIn.actions)) {
        const v = of(a, m, name)
        const at = `${plugin} ${name}`
        if (v !== null && v > (worst.get(at)?.value ?? -1)) worst.set(at, { about: name, value: v, plugin, action: name })
      }
    }
  }
  return [...worst.values()]
}

const failures = (m: Meter, kind: string): number => own(m.handIn.totals.failed, kind) ?? 0

// The thresholds are a first guess, to tune on real reports
export const RULES: readonly Rule[] = [
  {
    name: 'idle-cpu',
    limit: 5,
    values: d => d.rows.filter(idle).map(r => ({ about: r.id, value: r.cpu })),
    line: (about, v, limit) => `${about}: ${pct(v)} of a core while idle (over ${pct(limit)})`,
  },
  {
    name: 'cpu-with-peer',
    limit: 0.6,
    values: d => (d.cpuPeer.r === null ? [] : [{ about: 'sessions', value: d.cpuPeer.r }]),
    line: (_, v, limit) => `an idle session's CPU rises with the peer actions it ran (${trendText(v)}, over ${trendText(limit)})`,
  },
  {
    name: 'idle-starts',
    limit: 2,
    values: d => d.rows.filter(idle).map(r => ({ about: r.id, value: r.starts })),
    line: (about, v, limit) => `${about}: starts ${num(v)} processes a minute while idle (over ${count(limit)})`,
  },
  {
    // Only where a plugin handed in: with none, nobody says anything about any program
    name: 'unclaimed-program',
    limit: 10,
    values: d => (d.metered.length ? d.programs.filter(p => p.said === 0).map(p => ({ about: p.name, value: p.seen })) : []),
    line: (about, v, limit) => `${about}: started ${num(v)} times a minute, and no plugin says it started it (over ${count(limit)})`,
  },
  {
    // A session's worst kind of failure, in any one plugin; a timeout has a rule of its own
    name: 'failures',
    limit: 5,
    values: d =>
      d.rows.map(r => ({
        about: r.id,
        value: Math.max(0, ...Object.values(r.meters).flatMap(m => Object.entries(m.handIn.totals.failed).map(([kind, n]) => (kind === 'timeout' ? 0 : n / m.minutes)))),
      })),
    line: (about, v, limit) => `${about}: ${num(v)} failures of one kind a minute (over ${count(limit)})`,
  },
  {
    name: 'timeout',
    limit: 0,
    values: d => d.rows.map(r => ({ about: r.id, value: sum(Object.values(r.meters).map(m => failures(m, 'timeout'))) })),
    line: (about, v) => `${about}: ${count(v)} of its commands timed out in the window`,
  },
  {
    // The median idle session with plugins against the median one with none, where there is one
    name: 'wakes-with-plugins',
    limit: 2,
    values: d => {
      const wakes = (of: readonly Row[]) => median(of.flatMap(r => r.wakes ?? []))
      const bare = wakes(d.rows.filter(r => idle(r) && !r.plugins.length))
      const loaded = wakes(d.rows.filter(r => idle(r) && r.plugins.length > 0))
      return bare && loaded !== null ? [{ about: 'sessions', value: loaded / bare }] : []
    },
    line: (_, v, limit) => `an idle session with plugins wakes ${num(v)} times as often as one with none (over ${count(limit)} times)`,
  },
  {
    name: 'action-reads',
    limit: 1,
    values: d => worstByAction(d.rows.filter(r => r.status === 'idle'), (a, m) => a.bytesRead / m.minutes / 1024 ** 2),
    line: (about, v, limit) => `${about}: reads ${num(v)} MB a minute in an idle session (over ${count(limit)} MB)`,
  },
  {
    // The value is how many sessions of the same plugin are live
    name: 'on-timers',
    limit: 0,
    values: d =>
      d.metered.flatMap(plugin => {
        const facts = d.rows.flatMap(r => {
          const live = own(r.meters, plugin)?.handIn.facts[FACT_LIVE]
          return typeof live === 'string' ? [{ id: r.id, live }] : []
        })
        const others = facts.filter(f => f.live !== LIVE_TIMERS).length
        return facts.filter(f => f.live === LIVE_TIMERS).map(f => ({ about: f.id, value: others }))
      }),
    line: (about, v) => `${about}: on its timers where ${count(v)} ${v === 1 ? 'other is' : 'others are'} live`,
  },
  {
    name: 'slow-action',
    limit: 50,
    values: d => worstByAction(d.rows, a => (a.runs > 0 ? a.ms / a.runs : null)),
    line: (about, v, limit) => `${about}: ${num(v)} ms a run (over ${count(limit)} ms)`,
  },
  {
    // An action's time is the clock's, waits included: "about"
    name: 'action-cpu',
    limit: 1,
    values: d => worstByAction(d.rows, (a, m) => a.ms / m.minutes / 600),
    line: (about, v, limit) => `${about}: about ${pct(v)} of a core on its own (over ${pct(limit)})`,
  },
  {
    name: 'peer-action-rate',
    limit: 60,
    values: d => worstByAction(d.rows.filter(r => r.status === 'idle'), (a, m) => (a.drivers.includes('peer') ? a.runs / m.minutes : null)),
    line: (about, v, limit) => `${about}: another session's activity runs it ${num(v)} times a minute in an idle session (over ${count(limit)})`,
  },
  {
    name: 'draw-unseen',
    limit: 0,
    values: d =>
      d.rows.map(r => ({
        about: r.id,
        value: sum(
          Object.values(r.meters)
            .filter(m => m.handIn.facts[FACT_LOOKING] === false)
            .flatMap(m => Object.entries(m.handIn.actions).map(([name, a]) => (DRAW.test(name) ? a.runs / m.minutes : 0))),
        ),
      })),
    line: (about, v) => `${about}: ${num(v)} draws a minute where nobody could be looking`,
  },
  {
    // A holding that grows with nothing, or with the sessions when none is new, and grew: by how many, at most
    name: 'holding-grew',
    limit: 0,
    values: d => {
      const worst = new Map<string, Hit>()
      for (const r of d.rows) {
        for (const [plugin, m] of Object.entries(r.meters)) {
          for (const [name, h] of Object.entries(m.handIn.holdings)) {
            if (h.grows.some(g => g !== 'sessions') || (h.grows.includes('sessions') && d.newSessions)) continue
            const by = h.close[0] - h.open[0]
            if (by > (worst.get(`${plugin} ${name}`)?.value ?? 0)) worst.set(`${plugin} ${name}`, { about: `${plugin}:${name}`, value: by, plugin, session: r.id })
          }
        }
      }
      return [...worst.values()]
    },
    line: (about, v, _limit, hit) => `${about}: a holding that grew by ${count(v)} in the window with nothing new to hold${hit?.session ? ` (the most in ${hit.session})` : ''}`,
  },
  {
    name: 'unavailable',
    limit: 0,
    values: d => d.unavailable.filter(u => SHOULD_HAVE[d.os].includes(u)).map(u => ({ about: u, value: 1 })),
    line: about => `${about}: a reading this system should have, and it's not available here`,
  },
  {
    name: 'memory-with-age',
    limit: 0.6,
    values: d => (d.memoryAge.r === null ? [] : [{ about: 'sessions', value: d.memoryAge.r }]),
    line: (_, v, limit) => `memory rises with a session's age (${trendText(v)}, over ${trendText(limit)})`,
  },
  {
    // macOS's level: 1 is normal
    name: 'memory-pressure',
    limit: 1,
    values: d => (d.host.pressureKind === 'level' && d.host.pressure ? [{ about: 'machine', value: Math.max(...d.host.pressure) }] : []),
    line: (_, v) => `memory pressure above normal (${pressureWord(v)})`,
  },
  {
    // Linux's: the share of the last 10 s some task waited for memory
    name: 'memory-stall',
    limit: 10,
    values: d => (d.host.pressureKind === 'psi' && d.host.pressure ? [{ about: 'machine', value: Math.max(...d.host.pressure) }] : []),
    line: (_, v, limit) => `tasks waited for memory ${pct(v)} of the time (over ${pct(limit)})`,
  },
  {
    name: 'swap-growing',
    limit: 1,
    values: d => (d.host.swapUsedMB ? [{ about: 'machine', value: d.host.swapUsedMB[1] - d.host.swapUsedMB[0] }] : []),
    line: (_, v, limit) => `swap grew by ${megabytes(v)} in the window (over ${megabytes(limit)})`,
  },
  {
    // A session that didn't hand in a plugin's counts where others did; the value is how many of its plugins
    name: 'no-answer',
    limit: 0,
    values: d => d.rows.map(r => ({ about: r.id, value: r.silent.filter(p => d.metered.includes(p)).length })),
    line: (about, v) => `${about}: ${count(v)} of its plugins handed nothing in, where other sessions' did`,
  },
  {
    name: 'nobody-answered',
    limit: 0,
    values: d => d.plugins.filter(p => !d.metered.includes(p)).map(p => ({ about: p, value: d.rows.filter(r => r.silent.includes(p)).length })),
    line: (about, v) => `${about}: no session handed in its counts (${count(v)} run it)`,
  },
  {
    name: 'hand-in-refused',
    limit: 0,
    values: d => d.plugins.map(p => ({ about: p, value: d.rows.filter(r => r.refused.includes(p)).length })),
    line: (about, v) => `${about}: ${count(v)} of its hand-ins refused (the report says why)`,
  },
]

type Finding = Hit & { rule: string; limit: number }

// Every finding, in the rules' order and the largest first
export function lookOff(d: Digest, rules: readonly Rule[] = RULES): Finding[] {
  return rules.flatMap(rule =>
    rule
      .values(d)
      .filter(h => Number.isFinite(h.value) && h.value > rule.limit)
      .sort((a, b) => b.value - a.value)
      .map(h => ({ ...h, rule: rule.name, limit: rule.limit })),
  )
}

// The lines of "Looks off": one per finding, a rule's lines past the first few counted in one. `name` is what a line
// begins with in place of a session's label (on screen, the label and its title)
function offLines(found: readonly Finding[], rules: readonly Rule[], name: (line: string) => string): string[] {
  const lines: string[] = []
  for (const rule of rules) {
    const mine = found.filter(f => f.rule === rule.name)
    for (const f of mine.slice(0, OFF_LINES)) lines.push(...wrap(`- ${name(rule.line(f.about, f.value, f.limit, f))}`, '  ', '    '))
    if (mine.length > OFF_LINES) lines.push(`  - and ${count(mine.length - OFF_LINES)} more like it (${rule.name}, in the report)`)
  }
  return ['Looks off:', ...(lines.length ? lines : ['  - none'])]
}

// ---- the text ----

// A line no wider than the text, the lines after the first indented. It breaks after a comma, a colon or a `·` where it
// can, so a phrase stays whole (`swap 3.1 GB`), and between any two words where a phrase alone is too long
export function wrap(text: string, first = '', rest = first): string[] {
  const lines: string[] = []
  let line = first
  let empty = true
  const add = (piece: string) => {
    line += (empty ? '' : ' ') + piece
    empty = false
  }
  const fits = (piece: string) => empty || line.length + 1 + piece.length <= WIDTH
  const next = () => {
    lines.push(line)
    line = rest
    empty = true
  }
  for (const phrase of text.split(/(?<=[,:·]) /)) {
    if (fits(phrase)) add(phrase)
    else if (rest.length + phrase.length <= WIDTH) {
      next()
      add(phrase)
    } else {
      for (const w of phrase.split(' ')) {
        if (!fits(w)) next()
        add(w)
      }
    }
  }
  lines.push(line)
  return lines
}

// Rows as lines, each column as wide as its widest cell and two spaces apart. A row's last cell, when its column reads
// from the left, takes no part in the width: a note at a row's end doesn't push the other rows' columns away
function table(rows: readonly string[][], right: readonly boolean[] = [], indent = ''): string[] {
  const last = (row: readonly string[]) => row.reduce((at, cell, i) => (cell ? i : at), -1)
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      if (i === last(row) && !right[i]) widths[i] = widths[i] ?? 0
      else widths[i] = Math.max(widths[i] ?? 0, cell.length)
    })
  }
  return rows.map(row => {
    const end = last(row)
    const cells = row.slice(0, end + 1).map((cell, i) => (right[i] ? cell.padStart(widths[i] ?? 0) : i === end ? cell : cell.padEnd(widths[i] ?? 0)))
    return (indent + cells.join('  ')).trimEnd()
  })
}

// A section's title line, ruled to the text's width
const ruled = (title: string): string => `── ${title} `.padEnd(WIDTH, '─')

const possessive = (name: string): string => (name.endsWith('s') ? `${name}'` : `${name}'s`)
const listed = (names: readonly string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
const NOT_HERE = 'not available here'

const PRESSURE: Record<number, string> = { 1: 'normal', 2: 'warning', 4: 'critical' }
const pressureWord = (level: number): string => PRESSURE[level] ?? `level ${count(level)}`

// The sessions a set of plugins runs in, as a row's name: `no plugin`, `sessions only`, `sessions and fleet`
export function pluginSetName(plugins: readonly string[]): string {
  if (!plugins.length) return 'no plugin'
  return plugins.length === 1 ? `${plugins[0]} only` : listed(plugins)
}

// A count with its kind in words: `3 reads`, `1 listing`, `0.5 mv`. A kind with no words of its own is its name
const KINDS = new Map<string, [string, string]>([
  ['read', ['read', 'reads']],
  ['stat', ['stat', 'stats']],
  ['list', ['listing', 'listings']],
  ['listed', ['entry listed', 'entries listed']],
  ['write', ['write', 'writes']],
  ['exists', ['check', 'checks']],
  ['store', ['store call', 'store calls']],
  ['state', ['state call', 'state calls']],
  ['call', ['call', 'calls']],
  ['model', ['model call', 'model calls']],
  ['command', ['command', 'commands']],
  ['timeout', ['timeout', 'timeouts']],
  ['lock', ['lock try lost', 'lock tries lost']],
  ['bell', ['bell', 'bells']],
  ['heartbeat', ['heartbeat', 'heartbeats']],
  ['landing', ['landing', 'landings']],
])
const SENT = new Map<string, [string, string]>([['store', ['store write', 'store writes']]])
function counted(kind: string, v: number, also?: Map<string, [string, string]>): string {
  const names = also?.get(kind) ?? KINDS.get(kind)
  const n = count(v)
  return `${n} ${names ? (n === '1' ? names[0] : names[1]) : kind}`
}

// What makes an action run, in words. With more than one, those after the first are short, to keep the table narrow:
// `another session + turns`
const DRIVER_WORDS: Record<Driver, [string, string]> = { clock: ['its own timer', 'timer'], self: ['its own turns', 'turns'], person: ['the person', 'person'], peer: ['another session', 'peers'] }
export const driversText = (drivers: readonly Driver[]): string => drivers.map((d, i) => DRIVER_WORDS[d][i ? 1 : 0]).join(' + ') || '-'

// Kinds of work in words, each with its kind, the largest first. The entries listed go with the listings they came
// from (`1 listing (12)`), or nowhere when `entries` is null
function workWords(kinds: readonly [string, number][], most: number, entries: string | null): [string, string][] {
  const entriesListed = kinds.find(([k]) => k === 'listed')?.[1]
  const listings = kinds.some(([k]) => k === 'list')
  return kinds
    .filter(([k]) => !(k === 'listed' && listings))
    .slice(0, most)
    .map(([k, n]) => [k, counted(k, n) + (k === 'list' && entriesListed && entries !== null ? ` (${count(entriesListed)}${entries})` : '')])
}

const said = (v: Value): string => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : typeof v === 'number' ? count(v) : String(v))
const factsText = (facts: Record<string, Value>): string =>
  Object.keys(facts)
    .sort()
    .map(k => `${k}=${said(facts[k] as Value)}`)
    .join(' · ')

function header(d: Digest, missing: Report['missing']): string[] {
  const lines = [`sessions debug · perf · ${count(d.asked)} s · report ${d.report}`]
  const h = d.host
  const gone = (reading: string) => d.unavailable.includes(reading)
  const machine = [[`${h.os === 'linux' ? 'Linux' : 'macOS'}${h.osMajor === null ? '' : ` ${count(h.osMajor)}`}`, h.cores === null ? '' : `${count(h.cores)} cores`, h.memoryMB === null ? '' : megabytes(h.memoryMB)].filter(Boolean).join(', ')]
  if (!d.sampled) machine.push('no process numbers: the sampler gave nothing')
  else {
    const memory: string[] = []
    if (gone('pressure')) memory.push(`memory pressure ${NOT_HERE}`)
    else if (h.pressure && h.pressureKind === 'level') memory.push(`memory pressure ${pressureWord(h.pressure[0])}${h.pressure[1] === h.pressure[0] ? '' : `, then ${pressureWord(h.pressure[1])}`}`)
    else if (h.pressure) memory.push(`tasks waiting for memory ${pct(h.pressure[1])} of the time`)
    if (gone('free')) memory.push(`free memory ${NOT_HERE}`)
    else if (h.freeMB) memory.push(`${megabytes(h.freeMB[1])} free`)
    if (gone('swap')) memory.push(`swap ${NOT_HERE}`)
    else if (h.swapUsedMB) memory.push(`swap ${megabytes(h.swapUsedMB[1])}${Math.abs(h.swapUsedMB[1] - h.swapUsedMB[0]) >= 1 ? ` (${signed(h.swapUsedMB[1] - h.swapUsedMB[0])} MB in the window)` : ''}`)
    if (memory.length) machine.push(memory.join(', '))
    if (gone('battery')) machine.push(`battery ${NOT_HERE}`)
    else if (h.battery !== null) machine.push(h.battery ? 'on battery' : 'plugged in')
  }
  lines.push(...wrap(`Machine: ${machine.join(' · ')}`, '', '  '))

  const versions = [`Claude ${h.claude}`, ...Object.entries(h.plugins).map(([name, version]) => `${name} ${version}`)]
  const by = (['busy', 'idle', 'waiting', 'stopped'] as const).map(s => [s, d.rows.filter(r => r.status === s).length] as const).filter(([, n]) => n > 0)
  const sessions = `${count(d.rows.length)} ${d.rows.length === 1 ? 'session' : 'sessions'}${by.length ? ` (${by.map(([s, n]) => `${count(n)} ${s}`).join(', ')})` : ''}`
  // Who answered: of the sessions that run a plugin, those with a hand-in from one, taken or refused
  const asked = d.rows.filter(r => r.plugins.length > 0 && (r.silent.length > 0 || r.refused.length > 0 || Object.keys(r.meters).length > 0))
  const answered = asked.filter(r => r.refused.length > 0 || Object.keys(r.meters).length > 0)
  const refused = sum(missing.filter(m => m.what === 'hand-in').map(m => m.count))
  const tail = [sessions]
  if (asked.length) tail.push(answered.length ? `${count(answered.length)} of ${count(asked.length)} answered` : 'no plugin handed in its counts')
  if (refused) tail.push(`${count(refused)} ${refused === 1 ? 'hand-in' : 'hand-ins'} refused`)
  const ended = d.rows.filter(r => r.process?.gone).length
  if (ended) tail.push(`${count(ended)} ended inside the window`)
  lines.push(...wrap([...versions, ...tail].join(' · '), '', '  '))

  // The readings with no line of their own to say it on
  const elsewhere = ['pressure', 'free', 'swap', 'battery', 'wakeups', 'terminal', 'service', 'other']
  const rest = d.unavailable.filter(u => !elsewhere.includes(u))
  if (rest.length) lines.push(...wrap(`Not available here: ${rest.join(', ')}`, '', '  '))
  return lines
}

const STATUSES = ['idle', 'busy', 'waiting'] as const

// One row of the CPU and memory tables: the median with the range, and all together
function spread(name: string, of: readonly number[], each: (v: number) => string, all: (v: number) => string): string[] {
  return [name, of.length > 1 ? `${each(mid(of))} (${num(Math.min(...of))} to ${num(Math.max(...of))})` : each(mid(of)), all(sum(of))]
}

function trendLine(d: Digest): string {
  const { n, r } = d.cpuPeer
  if (n < TREND_SESSIONS) return `too few idle sessions with counts to compare (${count(n)}; it takes ${count(TREND_SESSIONS)})`
  if (r === null) return 'no spread between them to compare'
  return `CPU ${r > 0.6 ? 'rises' : "doesn't rise"} with the peer actions a session ran (${trendText(r)})`
}

function cpuSection(d: Digest): string[] {
  const alive = d.rows.filter(r => r.alive)
  if (!alive.length) return []
  const rows: string[][] = [['CPU, of one core', 'each (median)', 'all together']]
  for (const status of STATUSES) {
    const of = alive.filter(r => r.status === status)
    if (of.length) rows.push(spread(`  ${status} sessions (${count(of.length)})`, of.map(r => r.cpu), pct, pct))
  }
  rows.push(['  their helper processes', pct(mid(alive.map(r => r.child))), pct(sum(alive.map(r => r.child)))])
  if (d.metered.length) rows.push(['  across idle sessions', trendLine(d)])
  const lines = table(rows)
  const across = d.metered.length ? lines.splice(-1) : []

  // Of an idle session's CPU, how much falls inside each plugin's actions: time by the clock, waits included, so "about"
  const idleRows = alive.filter(r => r.status === 'idle')
  const inside = d.metered.flatMap(p => {
    const of = idleRows.flatMap(r => own(r.meters, p)?.ms ?? [])
    return of.length ? [{ plugin: p, ms: mid(of), ran: idleRows.some(r => Object.values(own(r.meters, p)?.handIn.actions ?? {}).some(a => a.runs > 0)) }] : []
  })
  if (inside.length) {
    const parts = inside.map((x, i) => `about ${ms(x.ms, x.ran)} ms inside ${possessive(x.plugin)}${i === 0 ? ' actions' : ''}`)
    const outside = inside.length === 1 ? 'it' : inside.length === 2 ? 'both' : 'them'
    const cpu = mid(idleRows.map(r => r.cpuMs))
    // An action's time is the clock's, with what it waits for: it can pass the CPU the process used
    const over = sum(inside.map(x => x.ms)) > cpu
    lines.push(...wrap(`of an idle session's ${num(cpu)} ms of CPU a minute: ${parts.join(', ')}${over ? ". That's more than its CPU: an action's time includes what it waits for (a command, a file), which isn't CPU" : `, the rest outside ${outside}`}`, '  '))
  }
  return [...lines, ...across]
}

// Which wake-ups the sampler counted, for the column's title: the two systems count different things
function wakeKinds(rows: readonly Row[]): string {
  const kinds = WAKEUPS.filter(k => rows.some(r => own(r.process?.wakeups ?? {}, k) !== undefined))
  const switches = kinds.some(k => k === 'voluntary' || k === 'involuntary')
  return `${switches ? 'context switches' : 'wake-ups'} a second${kinds.length ? ` (${listed(kinds)})` : ''}`
}

function groupSection(d: Digest): string[] {
  const idleRows = d.rows.filter(idle)
  if (!idleRows.length) return []
  const order = (r: Row) => d.plugins.filter(p => r.plugins.includes(p))
  const groups = new Map<string, Row[]>()
  for (const r of idleRows) groups.set(order(r).join(' '), [...(groups.get(order(r).join(' ')) ?? []), r])
  const sets = [...groups.values()].sort((a, b) => (a[0]?.plugins.length ?? 0) - (b[0]?.plugins.length ?? 0) || pluginSetName(order(a[0] as Row)).localeCompare(pluginSetName(order(b[0] as Row))))
  const rows: string[][] = [['By what runs in the process (idle only)', 'CPU', 'memory', d.unavailable.includes('wakeups') ? 'wake-ups a second' : wakeKinds(idleRows)]]
  for (const of of sets) {
    const wakes = of.flatMap(r => r.wakes ?? [])
    rows.push([
      `  ${pluginSetName(order(of[0] as Row))} (${count(of.length)})`,
      pct(mid(of.map(r => r.cpu))),
      megabytes(mid(of.map(r => r.memory))),
      d.unavailable.includes('wakeups') ? NOT_HERE : wakes.length ? num(mid(wakes)) : '-',
    ])
  }
  const lines = table(rows)
  if (!groups.has('')) lines.push('  no idle session without plugins here to compare with')
  return lines
}

function memorySection(d: Digest): string[] {
  const alive = d.rows.filter(r => r.alive)
  if (!alive.length) return []
  const kind = alive.some(r => r.process?.memoryKind === 'rss') ? 'resident size' : 'footprint'
  const rows: string[][] = [[`Memory (${kind})`, 'each (median)', 'all together']]
  for (const status of STATUSES) {
    const of = alive.filter(r => r.status === status)
    if (of.length) rows.push(spread(`  ${status} sessions (${count(of.length)})`, of.map(r => r.memory), v => `${num(v)} MB`, megabytes))
  }
  rows.push(['  their helper processes', megabytes(mid(alive.map(r => r.helpers))), megabytes(sum(alive.map(r => r.helpers)))])
  rows.push(['  change in this window', `${signed(mid(alive.map(r => r.grew)))} MB each`])

  const trends = [
    { name: 'age', ...d.memoryAge },
    { name: 'transcript size', ...d.memoryTranscript },
  ].flatMap(t => (t.r === null ? [] : [{ name: t.name, r: t.r }]))
  const rising = trends.filter(t => t.r > 0.6).map(t => `${t.name} (${trendText(t.r)})`)
  const flat = trends.filter(t => t.r <= 0.6).map(t => `${t.name} (${trendText(t.r)})`)
  const parts = [rising.length ? `rises with ${rising.join(' and ')}` : '', flat.length ? `no trend with ${flat.join(' or ')}` : ''].filter(Boolean)
  if (parts.length) rows.push(['  across sessions', parts.join(', ')])
  else if (alive.length < TREND_SESSIONS) rows.push(['  across sessions', `too few sessions to compare (${count(alive.length)}; it takes ${count(TREND_SESSIONS)})`])
  return table(rows)
}

function aroundSection(d: Digest): string[] {
  const window = d.minutes * 60000
  const share = (cpuMs: number) => pct((cpuMs / window) * 100)
  const role = (r: SampledRole) => [`${share(r.cpuMs)} CPU`, megabytes(r.memoryMB), r.threads === null ? '' : `${count(r.threads)} threads`, r.count > 1 ? `${count(r.count)} processes` : ''].filter(Boolean).join(' · ')
  const rows: string[][] = []
  if (d.unavailable.includes('other')) rows.push(['  other software', NOT_HERE])
  else if (d.other) rows.push(['  other software', `${share(d.other.cpuMs)} CPU in all, the largest ${share(d.other.largestMs)}${d.other.over20 ? `, ${count(d.other.over20)} over 20 % of a core` : ''}`])
  if (d.unavailable.includes('terminal')) rows.push(['  the terminal', NOT_HERE])
  else if (d.roles.terminal) rows.push(['  the terminal', role(d.roles.terminal)])
  if (d.unavailable.includes('service')) rows.push(['  the background service', NOT_HERE])
  else if (d.roles.service) rows.push(['  the background service', role(d.roles.service)])
  const lines = rows.length ? ['Around the sessions', ...table(rows)] : []

  if (!d.programs.length) return lines
  // With no hand-in there's nothing to set what was seen against: the one column
  const both = d.metered.length > 0
  const starts: string[][] = [['Processes started a minute, all sessions', 'seen', ...(both ? ['the plugins say'] : [])]]
  for (const p of d.programs) starts.push([`  ${p.name}`, num(p.seen), ...(both ? [num(p.said), p.seen > p.said ? '<- started around the plugins' : ''] : [])])
  return [...lines, ...table(starts, [false, true, true, false])]
}

// One action of a plugin across a group of sessions: the median session's runs and time a minute, and the work one run
// does (all the group's work over all its runs)
type ActionLine = { name: string; spec: ActionTotals; runs: number; each: number | null; ms: number; ran: boolean; work: [string, number][]; bytes: number }

function actionLines(group: readonly Meter[]): ActionLine[] {
  const names = [...new Set(group.flatMap(m => Object.keys(m.handIn.actions)))]
  return names
    .flatMap(name => {
      const of = group.map(m => ({ m, a: own(m.handIn.actions, name) }))
      const spec = of.find(x => x.a)?.a
      if (!spec) return []
      const runs = sum(of.map(x => x.a?.runs ?? 0))
      const each = of.flatMap(x => (x.a && x.a.runs > 0 ? [x.a.ms / x.a.runs] : []))
      // The work of all its runs, by kind. A command is named by the program it started, where the plugin says which
      const kinds = new Map<string, number>()
      const programs = of.some(x => Object.keys(x.a?.started ?? {}).length > 0)
      for (const x of of) {
        for (const [kind, n] of Object.entries(x.a?.work ?? {})) if (!(programs && kind === 'command')) kinds.set(kind, (kinds.get(kind) ?? 0) + n)
        for (const [program, n] of Object.entries(x.a?.started ?? {})) kinds.set(programOf(program), (kinds.get(programOf(program)) ?? 0) + n)
      }
      return [
        {
          name,
          spec,
          runs: mid(of.map(x => (x.a?.runs ?? 0) / x.m.minutes)),
          each: median(each),
          ms: mid(of.map(x => (x.a?.ms ?? 0) / x.m.minutes)),
          ran: runs > 0,
          work: runs ? [...kinds].map(([k, n]) => [k, n / runs] as [string, number]).filter(([, n]) => n >= 0.05).sort((a, b) => b[1] - a[1]) : [],
          bytes: runs ? sum(of.map(x => (x.a?.bytesRead ?? 0) + (x.a?.bytesWritten ?? 0))) / runs : 0,
        },
      ]
    })
    .sort((a, b) => b.ms - a.ms || b.runs - a.runs || a.name.localeCompare(b.name))
}

// The work of one run in words: its two or three largest kinds, and the bytes it moves when that's over 1 KB. In a
// narrow column it says less: the entries listed go first, then the smaller kinds, then the bytes
function workText(a: ActionLine, width: number): string {
  if (!a.ran) return ''
  const said = (kinds: number, entries: string | null, size = true) => [...workWords(a.work, kinds, entries).map(w => w[1]), ...(size && a.bytes > 1024 ? [bytes(a.bytes)] : [])].join(', ') || 'none'
  const ways = [said(3, ''), said(3, null), said(2, ''), said(2, null), said(1, null), said(1, null, false)]
  return ways.find(w => w.length <= width) ?? ways[ways.length - 1] ?? ''
}

const short = (name: string, width = 26): string => (name.length > width ? `${name.slice(0, width - 1)}…` : name)

// A plugin's table: the median idle session among those with the same facts, action by action
function actionTable(plugin: string, group: readonly Meter[], flagged: ReadonlySet<string>): string[] {
  const all = actionLines(group)
  const names = new Set(all.map(a => a.name))
  const part = (a: ActionLine) => !!a.spec.within && names.has(a.spec.within)
  const top = all.filter(a => !part(a))
  const shown = top.length > TABLE_ROWS ? top.slice(0, TABLE_ROWS) : top
  const folded = top.slice(shown.length).filter(a => !a.spec.within)
  const flag = all.some(a => flagged.has(`${plugin} ${a.name}`))
  // Every cell but the work of one run, which gets the width the others leave
  const row = (a: ActionLine, indent: string): string[] => [
    indent + short(a.name),
    num(a.runs),
    a.each === null ? '-' : ms(a.each, true),
    ms(a.ms, a.ran),
    '',
    driversText(a.spec.drivers),
    a.spec.grows.join(', ') || 'nothing',
    flagged.has(`${plugin} ${a.name}`) ? '<-' : '',
  ]
  const lines: { a: ActionLine | null; cells: string[] }[] = [{ a: null, cells: ['action', 'runs', 'ms each', 'ms/min', 'work each run', 'runs because', 'grows with', flag ? 'off?' : ''] }]
  for (const a of shown) {
    lines.push({ a, cells: row(a, '') })
    for (const child of all.filter(c => part(c) && c.spec.within === a.name)) lines.push({ a: child, cells: row(child, '  ') })
  }
  const others = [0, 1, 2, 3, 5, 6, 7].map(i => Math.max(...lines.map(l => l.cells[i]?.length ?? 0)))
  const room = WIDTH - sum(others) - 2 * others.filter(w => w > 0).length
  const rows = lines.map(l => (l.a ? l.cells.map((cell, i) => (i === 4 && l.a ? workText(l.a, room) : cell)) : l.cells))
  if (folded.length) {
    const of = (pick: (a: ActionTotals) => number) => mid(group.map(m => sum(folded.flatMap(a => own(m.handIn.actions, a.name) ?? []).map(pick)) / m.minutes))
    rows.push([`the rest (${count(folded.length)})`, num(of(a => a.runs)), '', ms(of(a => a.ms), folded.some(a => a.ran))])
  }
  rows.push(['total', '', '', ms(mid(group.map(m => m.ms)), all.some(a => a.ran)), `ms a minute inside ${possessive(plugin)} actions`])
  return table(rows, [false, true, true, true])
}

// The median of a count a minute across a group, kind by kind, the largest first
function perMinute(group: readonly Meter[], pick: (h: HandIn) => Counts): { kind: string; median: number; most: number }[] {
  const kinds = [...new Set(group.flatMap(m => Object.keys(pick(m.handIn))))]
  return kinds
    .map(kind => {
      const of = group.map(m => (own(pick(m.handIn), kind) ?? 0) / m.minutes)
      return { kind, median: mid(of), most: Math.max(...of) }
    })
    .sort((a, b) => b.median - a.median || a.kind.localeCompare(b.kind))
}

// How many groups of a plugin's sessions get their actions' table (the rest get one line each)
const GROUP_TABLES = 4

function pluginSection(d: Digest, plugin: string, flagged: ReadonlySet<string>): string[] {
  const withMeter = d.rows.flatMap(r => {
    const m = own(r.meters, plugin)
    return m ? [{ r, m }] : []
  })
  if (!withMeter.length) return []
  // Sessions with the same status (idle, or not) and the same facts are one group: the largest idle group's table
  // comes first, then the other groups' (the one session that does a project's shared work is a group of its own, and
  // so are the busy ones), up to GROUP_TABLES in all; past that a group gets its line only
  const idleOnes = withMeter.filter(x => x.r.status === 'idle')
  const busyOnes = withMeter.filter(x => x.r.status !== 'idle')
  const grouped = (of: typeof withMeter) => {
    const groups = new Map<string, typeof withMeter>()
    for (const x of of) groups.set(JSON.stringify(x.m.handIn.facts), [...(groups.get(JSON.stringify(x.m.handIn.facts)) ?? []), x])
    return [...groups.values()].sort((a, b) => b.length - a.length)
  }
  const idleSets = grouped(idleOnes)
  const busySets = grouped(busyOnes)
  const pool = idleOnes.length ? idleOnes : withMeter
  const sets = idleOnes.length ? idleSets : busySets
  const main = sets[0] ?? []
  const group = main.map(x => x.m)
  const facts = main[0]?.m.handIn.facts ?? {}
  const rest: { set: typeof withMeter; who: string }[] = [...sets.slice(1).map(set => ({ set, who: idleOnes.length ? 'idle session' : 'session' })), ...(idleOnes.length ? busySets.map(set => ({ set, who: 'busy session' })) : [])]

  // What goes under a group's table: its exact totals, what failed, what it sent, its heaviest run and what it holds
  const under = (group: Meter[]): string[] => {
    const out: string[] = []
    // The exact totals, whichever action each call fell in
    const work = perMinute(group, h => h.totals.work).filter(k => k.median > 0)
    const read = mid(group.map(m => m.handIn.totals.bytesRead / m.minutes))
    const written = mid(group.map(m => m.handIn.totals.bytesWritten / m.minutes))
    const startedBy = perMinute(group, h => foldCounts(h.totals.started, programOf)).filter(k => k.median > 0)
    const moved = (kind: string) => (kind === 'read' && read > 0 ? ` (${bytes(read)})` : kind === 'write' && written > 0 ? ` (${bytes(written)})` : '')
    const exact = workWords(work.map(k => [k.kind, k.median] as [string, number]), work.length, ' entries').map(([kind, text]) => text + moved(kind))
    if (read > 0 && !work.some(k => k.kind === 'read')) exact.push(`${bytes(read)} read`)
    if (written > 0 && !work.some(k => k.kind === 'write')) exact.push(`${bytes(written)} written`)
    const startedAll = mid(group.map(m => sum(Object.values(m.handIn.totals.started)) / m.minutes))
    out.push(...wrap(`work in all, exact: ${exact.length ? `${exact.join(', ')} a minute` : 'none'} · processes started: ${num(startedAll)}${startedBy.length ? ` (${startedBy.map(k => `${k.kind} ${num(k.median)}`).join(', ')})` : ''}`, '', '  '))

    const failed = perMinute(group, h => h.totals.failed)
    out.push(...wrap(`failed: ${failed.length ? failed.map(k => counted(k.kind, k.median) + (k.most > k.median ? ` (${num(k.most)} at most)` : '')).join(' · ') + ' a minute' : 'nothing'}`, '', '  '))
    const sent = perMinute(group, h => h.totals.sent)
    if (sent.length) out.push(...wrap(`it sent, for others to react to: ${sent.map(k => counted(k.kind, k.median, SENT)).join(' · ')} a minute`, '', '  '))
    const most = group.flatMap(m => Object.entries(m.handIn.actions).map(([name, a]) => ({ name, n: a.mostWork }))).sort((a, b) => b.n - a.n)[0]
    if (most && most.n > 0) out.push(`most work in one run: ${counted('call', most.n)} (${most.name})`)

    // What it holds: how many and about how many bytes at the close, the largest first, and what grew in the window
    const holdings = [...new Set(group.flatMap(m => Object.keys(m.handIn.holdings)))]
      .map(name => {
        const of = group.flatMap(m => own(m.handIn.holdings, name) ?? [])
        const sizes = of.flatMap(h => h.close[1] ?? [])
        return { name, n: mid(of.map(h => h.close[0])), size: median(sizes), grew: Math.max(...of.map(h => h.close[0] - h.open[0])), grewBytes: Math.max(0, ...of.map(h => (h.close[1] ?? 0) - (h.open[1] ?? 0))) }
      })
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0) || b.n - a.n || a.name.localeCompare(b.name))
    if (holdings.length) {
      const size = sum(holdings.map(h => h.size ?? 0))
      const items = holdings.slice(0, HOLDING_ITEMS).map(h => `${h.name} ${count(h.n)}${h.size ? `, about ${bytes(h.size)}` : ''}`)
      if (holdings.length > HOLDING_ITEMS) items.push(`${count(holdings.length - HOLDING_ITEMS)} more`)
      out.push(...wrap(`it holds${size ? `, about ${bytes(size)} in all` : ''}: ${items.join(' · ')}`, '', '  '))
      const grew = holdings.filter(h => h.grew > 0).sort((a, b) => b.grew - a.grew)
      if (grew.length) out.push(...wrap(`grew in this window, at most: ${grew.map(h => `${h.name} +${count(h.grew)}${h.grewBytes > 0 ? ` (about +${bytes(h.grewBytes)})` : ''}`).join(' · ')}`, '', '  '))
    }
    return out
  }

  const lines = [ruled(`${plugin}: ${idleOnes.length ? 'an idle session' : 'a session (none is idle)'}, per minute`)]
  lines.push(...wrap(`the median of ${main.length === pool.length ? (main.length === 1 ? 'the one' : `all ${count(main.length)}`) : `these ${count(main.length)} of ${count(pool.length)}`}: ${factsText(facts) || 'no facts handed in'}`, '', '  '))
  lines.push(...actionTable(plugin, group, flagged))
  lines.push(...under(group))
  let tables = 1
  for (const { set, who } of rest) {
    const theirs = set[0]?.m.handIn.facts ?? {}
    const differ = Object.fromEntries(Object.keys(theirs).filter(k => own(theirs, k) !== own(facts, k)).map(k => [k, own(theirs, k) as Value]))
    const same = who !== 'busy session'
    const told = factsText(same ? differ : theirs)
    lines.push(...wrap(`${count(set.length)} ${same ? 'other ' : ''}${set.length === 1 ? who : `${who}s`}${told ? ` with ${told}` : ''}: ${num(mid(set.map(x => x.m.ms)))} ms a minute inside its actions`, '', '  '))
    if (tables < GROUP_TABLES) {
      lines.push(...actionTable(plugin, set.map(x => x.m), flagged))
      lines.push(...under(set.map(x => x.m)))
      tables++
    }
  }
  const partial = withMeter.filter(x => x.m.handIn.partial).length
  if (partial) lines.push(`counted for part of the window only (reloaded inside it): ${count(partial)} ${partial === 1 ? 'session' : 'sessions'}`)

  // The project's part, from the session that does its shared work: one per project. Where nobody does that work,
  // several sessions may hand one in: the first is printed, and the rest are said (they're in the report)
  const printed = new Set<string>()
  const others = new Map<string, number>()
  for (const { r, m } of withMeter) {
    if (!m.handIn.project) continue
    if (printed.has(r.project)) {
      others.set(r.project, (others.get(r.project) ?? 0) + 1)
      continue
    }
    printed.add(r.project)
    for (const [section, of] of Object.entries(m.handIn.project)) {
      if (!Object.keys(of).length) continue
      lines.push(`${section} (the project's part, from ${r.id}):`)
      for (const name of Object.keys(of)) lines.push(`  ${name}: ${said(of[name] as Value)}`)
    }
  }
  for (const [project, n] of others) lines.push(`${count(n)} other session${n === 1 ? '' : 's'} of ${project} handed the project's part in too (in the report)`)
  return lines
}

// What the machine pays as the fleet grows, from what makes each action run: runs that another session's activity
// drives double twice when the fleet doubles (twice the sessions, each hearing twice as much); a timer's action whose
// run costs more with the sessions runs twice as often in all, each run doing more
function scalingSection(d: Digest): string[] {
  const actions = new Map<string, { name: string; spec: ActionTotals; runs: number }>()
  for (const r of d.rows) {
    for (const [plugin, m] of Object.entries(r.meters)) {
      for (const [name, a] of Object.entries(m.handIn.actions)) {
        if (a.within) continue
        const at = `${plugin} ${name}`
        const had = actions.get(at) ?? { name: d.metered.length > 1 ? `${plugin}/${name}` : name, spec: a, runs: 0 }
        had.runs += a.runs / m.minutes
        actions.set(at, had)
      }
    }
  }
  if (!actions.size) return []
  const all = [...actions.values()].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name))
  const peer = all.filter(a => a.spec.drivers.includes('peer'))
  const clock = all.filter(a => !a.spec.drivers.includes('peer') && a.spec.drivers.includes('clock') && a.spec.grows.includes('sessions'))
  const rest = all.length - peer.length - clock.length
  const some = (of: typeof all) => of.slice(0, 4).map(a => short(a.name, 30)).join(', ') + (of.length > 4 ? ` and ${count(of.length - 4)} more` : '')
  const lines = ['Scaling, from what makes each action run:']
  const row = (name: string, of: typeof all, grows: string) => {
    if (!of.length) return
    lines.push(...wrap(`${name.padEnd(27)}${some(of)} · ${num(sum(of.map(a => a.runs)))} runs a minute across all · ${grows}`, '  ', ' '.repeat(29)))
  }
  row('with sessions x activity', peer, 'x4 if the fleet doubles')
  row('with sessions', clock, 'x2 if the fleet doubles, each run doing more')
  if (rest) lines.push(`  ${'with nothing'.padEnd(27)}the rest (${count(rest)} ${rest === 1 ? 'action' : 'actions'})`)
  return lines
}

// Puts a report together: the file (labels only), the key that stays on the machine, and the summary as text. `plain`
// holds the report's labels only; `text` is the same but for "Looks off", where the first session a line names is
// followed by its title
export function buildReport(input: ReportInput): Built {
  const { report, key, digest } = gather(input)
  const found = lookOff(digest)
  report.off = found.map(f => ({ rule: f.rule, about: f.about, value: f.value, limit: f.limit }))

  const flagged = new Set(found.flatMap(f => (f.plugin && f.action ? [`${f.plugin} ${f.action}`] : [])))
  const sections = [
    header(digest, report.missing),
    cpuSection(digest),
    groupSection(digest),
    memorySection(digest),
    aroundSection(digest),
    ...digest.metered.map(p => pluginSection(digest, p, flagged)),
    scalingSection(digest),
  ].filter(s => s.length)
  const body = sections.map(s => s.join('\n')).join('\n\n')

  const titled = (line: string) =>
    line.replace(/\bS[0-9]+\b/, label => {
      const title = own(key.sessions, label)?.title
      return title ? `${label} (${title})` : label
    })
  const plain = `${body}\n\n${offLines(found, RULES, l => l).join('\n')}`
  const text = `${body}\n\n${offLines(found, RULES, titled).join('\n')}`
  return { report, key, plain, text }
}
