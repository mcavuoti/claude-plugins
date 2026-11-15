// /sessions debug: the shapes its parts hand each other. Nothing here runs.
//
//   meter.ts     what a plugin counts while a window is open, handed in when it closes (HandIn)
//   sampler.py   what the processes did over the window, read from the system (SamplerOutput)
//   report.ts    both, checked and put together: the file that may leave the machine (Report), the key that stays
//                (ReportKey) and the text on screen
//
// A report holds no free text. Every key and every word in a hand-in matches NAME; a value is a number, a boolean, such
// a word, or a label the report replaces with one of its own (S1, R1) and writes down only in the key file.

import type { SessionsDebugAction, SessionsDebugCounts, SessionsDebugDriver, SessionsDebugHandIn, SessionsDebugHolding, SessionsDebugLabel, SessionsDebugValue } from '../../types'

export const DEBUG_FORMAT = 1

// The names a hand-in may use for its keys and its words: `refresh`, `landing.chain`, `mv:heartbeat`, `own-watch`
export const NAME = /^[a-z][A-Za-z0-9.:-]{0,47}$/

// The hand-in is part of $.sessions' contract (another plugin makes one too), so its shape is written once, in
// types/index.d.ts; these are its names here
export type Driver = SessionsDebugDriver
export const DRIVERS: readonly Driver[] = ['clock', 'self', 'person', 'peer']
export type Label = SessionsDebugLabel
export type Value = SessionsDebugValue
export type Counts = SessionsDebugCounts
export type ActionTotals = SessionsDebugAction
export type Holding = SessionsDebugHolding
export type HandIn = SessionsDebugHandIn

// ---- sampler.py's output (format 1) ----

// A reading taken when the window opened and when it closed
export type Pair = [number, number]

export type SampledProcess = {
  // CPU time over the window, in ms: the process itself, and its children (alive or ended inside the window)
  cpuMs: number
  childCpuMs: number
  // Memory in MB at both ends, and which measure it is (they aren't comparable): macOS's physical footprint, Linux's
  // resident size
  memoryMB: Pair
  memoryKind: 'footprint' | 'rss'
  // Its highest so far, and Linux's proportional size, where the system has them
  peakMB: number | null
  pssMB: number | null
  // How often it woke over the window, by the system's own kinds: macOS idle and interrupt wake-ups, Linux voluntary
  // and involuntary context switches
  wakeups: Counts | null
  threads: number | null
  // It ended inside the window
  gone: boolean
  // Processes that appeared under it during the window, by program (a program off the list counts as `other`)
  started: Counts
  // Its children alive at the close, by program
  helpers: Record<string, { count: number; memoryMB: number }>
  // Its conversation's file, in MB, when asked for
  transcriptMB: number | null
}

export type SampledRole = { count: number; cpuMs: number; memoryMB: number; threads: number | null }

export type SamplerOutput = {
  format: typeof DEBUG_FORMAT
  how: 'libproc' | 'procfs'
  // The window as it was, and how many times the process list was read
  seconds: number
  samples: number
  machine: {
    cores: number
    memoryMB: number
    // Memory free to use and swap in use, in MB, at both ends
    freeMB: Pair | null
    swapUsedMB: Pair | null
    // Memory pressure at both ends: macOS's level (1 normal, 2 warning, 4 critical), Linux's PSI (`some avg10`, percent)
    pressure: Pair | null
    pressureKind: 'level' | 'psi' | null
    battery: boolean | null
  }
  // By pid, the sessions asked for
  processes: Record<string, SampledProcess>
  // Every process outside the sessions' own (and the sampler's): CPU in all, the largest one's, how many used over 20 %
  // of a core
  other: { cpuMs: number; largestMs: number; over20: number } | null
  // What the plugins' commands talk to
  roles: { terminal: SampledRole | null; service: SampledRole | null }
  // The readings this system doesn't have: `pressure`, `pss`, `battery`, `terminal`, `wakeups`…
  unavailable: string[]
}

// ---- the report ----

// A session as the asking session knows it when the window closes
export type ReportSession = {
  sessionId: string
  pid: number
  // Its project's folder: only the report's own label for it (P1) is written
  root: string
  title: string
  kind: 'background' | 'regular'
  status: 'idle' | 'busy' | 'waiting' | 'stopped'
  ageHours: number | null
  // The plugins running in it, by name, as their heartbeat or hand-in shows: none is a session with no plugin
  plugins: string[]
}

export type ReportInput = {
  report: string
  profile: 'perf'
  at: number
  seconds: number
  host: { os: 'macos' | 'linux'; osMajor: number | null; claude: string; plugins: Record<string, string> }
  sessions: ReportSession[]
  sampler: SamplerOutput | null
  // By session id, then by plugin
  handIns: Record<string, Record<string, unknown>>
  // The programs a report names; any other is `other`
  programs: readonly string[]
}

// The file that may leave the machine: numbers, booleans, versions, NAME words and the report's own labels only
export type Report = {
  format: typeof DEBUG_FORMAT
  report: string
  profile: 'perf'
  at: string
  seconds: number
  host: ReportInput['host'] & {
    cores: number | null
    memoryMB: number | null
    battery: boolean | null
    freeMB: Pair | null
    swapUsedMB: Pair | null
    pressure: Pair | null
    pressureKind: 'level' | 'psi' | null
  }
  sessions: {
    id: string
    project: string
    kind: ReportSession['kind']
    status: ReportSession['status']
    ageHours: number | null
    plugins: string[]
    process: SampledProcess | null
    // By plugin: its hand-in, with labels in place of what it named; null when it didn't hand in
    meters: Record<string, HandIn | null>
  }[]
  other: SamplerOutput['other']
  roles: SamplerOutput['roles']
  unavailable: string[]
  // What was refused or missing: a hand-in with something that isn't a name or a number, a session that didn't answer
  missing: { what: 'session' | 'hand-in' | 'sampler'; plugin?: string; count: number; why: string }[]
  // The lines of "Looks off", as words and numbers: the rule's name, the label it's about, the value and the limit
  off: { rule: string; about: string; value: number; limit: number }[]
}

// Stays on the machine: which session, project and role each label is
export type ReportKey = { report: string; sessions: Record<string, { title: string; sessionId: string; root: string }>; projects: Record<string, string>; roles: Record<string, string> }

// The report, its key, and the same summary as text twice: `plain` with the report's labels only (it may leave the
// machine beside the report), `text` for the screen, where a label is followed by the session's name
export type Built = { report: Report; key: ReportKey; plain: string; text: string }
