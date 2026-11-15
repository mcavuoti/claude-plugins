// /sessions debug: the window a report is measured over, as the sessions tell each other about it.
//
// The asking session writes <data>/reports/window when the window opens and again when it closes, and rings the `debug`
// bell both times. Every session's mod hears the bell and reads the file: open, it starts counting (debug/meter.ts);
// closed, it hands its totals in, as a file in the report's folder (<data>/reports/<report>/<session>.<plugin>.json),
// and stops. Another plugin watches the file itself ($.sessions.debugPath) and hands in through $.sessions.debugReport.
import type { SessionsDebugWindow } from '../../types'
import { FORMAT, keyLines, parseKeyLines } from '../state'

export type DebugWindow = SessionsDebugWindow

export const REPORT_ID = /^r-[0-9a-f]{6,16}$/
// A plugin's name as a hand-in's file carries it
export const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,30}$/
export const PERF_DEFAULT_S = 60
export const PERF_MIN_S = 5
export const PERF_MAX_S = 600
// The most a hand-in may weigh, as JSON
export const HAND_IN_MAX = 262144

// The window file's text: the wire format, which report, whether it's open, and when the window ends (ms)
export function windowText(w: DebugWindow, at: number, from: string): string {
  return keyLines({ format: FORMAT, report: w.report, profile: w.profile, phase: w.open ? 'open' : 'close', until: w.until, at, from })
}

// null for an empty file, another format, or anything that isn't a window
export function parseWindow(text: string): DebugWindow | null {
  const k = parseKeyLines(text)
  if (Number(k.format) !== FORMAT || !REPORT_ID.test(k.report ?? '') || k.profile !== 'perf') return null
  if (k.phase !== 'open' && k.phase !== 'close') return null
  const until = Number(k.until)
  if (!Number.isFinite(until) || until <= 0) return null
  return { report: k.report!, profile: 'perf', open: k.phase === 'open', until }
}

// The name of a session's hand-in file for a plugin, or null when either isn't a plain name
export function handInFile(sessionId: string, plugin: string): string | null {
  return /^[A-Za-z0-9-]{1,64}$/.test(sessionId) && PLUGIN_NAME.test(plugin) ? `${sessionId}.${plugin}.json` : null
}

export function parseHandInFile(name: string): { sessionId: string; plugin: string } | null {
  const m = name.match(/^([A-Za-z0-9-]{1,64})\.([a-z][a-z0-9-]{0,30})\.json$/)
  return m ? { sessionId: m[1]!, plugin: m[2]! } : null
}

// How long `/sessions debug perf [seconds]` measures: the default with no word, null for one that isn't a whole number
// of seconds within the limits
export function perfSeconds(word: string | undefined): number | null {
  if (word === undefined || word === '') return PERF_DEFAULT_S
  if (!/^\d{1,4}$/.test(word)) return null
  const n = Number(word)
  return n >= PERF_MIN_S && n <= PERF_MAX_S ? n : null
}
