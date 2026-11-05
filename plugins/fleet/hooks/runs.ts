// The run register (B16, G2): a long run (a simulation, a build) an instance launches detached and declares with
// mcp__fleet__run, so a restart, a sleep or a compaction of its session doesn't lose it. The sweeper watches each
// declared run's done-file (here, or on its host over ssh, only where outbound.json allows) and, once it appears, tells
// the run's owner it finished; the owner records the result. One file per run and per step, each written once
// (<project>/.claude/fleet/runs/: run-<n>.json by its owner, run-<n>.done.json by the sweeper, run-<n>.recorded.json
// by its owner), so nobody overwrites anybody. A run's id is run-<n>, never a record's (R-<n> is a requirement's in the
// templates). Pure logic, tested in tests/runs.test.ts. No `$` here.

import { clock } from './changes'
import { ago } from './decisions'

export type RunOwner = { name: string; slug: string; ref: string | null; sessionId: string }
/** A declared run: what it is, the board item it's for, where it runs (host null: this machine), its folder, the file it
 * writes when it ends (its exit code in it), its log */
export type RunFile = { format: number; id: string; at: number; owner: RunOwner; what: string; item: string | null; host: string | null; dir: string | null; done: string; log: string | null }
/** The sweeper saw its done-file: when, and the exit code it holds (null: not a number) */
export type RunDone = { format: number; id: string; at: number; exit: number | null }
/** Its owner recorded the result (where it landed, or what it showed) */
export type RunRecorded = { format: number; id: string; at: number; result: string }

export type RunView = { run: RunFile; done: RunDone | null; recorded: RunRecorded | null }

export const RUN_ID = /^run-(\d+)$/

/** A run's id as typed (run-3, Run-3, RUN-3): its own spelling, or null */
export function runIdOf(s: string): string | null {
  const m = /^run-(\d+)$/i.exec(s.trim())
  return m ? `run-${Number(m[1])}` : null
}

/** The detached launch every role is given: portable (macOS has no setsid), its exit code in the done-file */
export const DETACHED_RECIPE = "nohup sh -c '<command>; echo $? > <dir>/done' > <dir>/log 2>&1 &"

/** A path fleet hands to a remote shell or reads here: plain characters only (no spaces, quotes or expansions) */
const PLAIN_PATH = /^[A-Za-z0-9_./~+@%:,=-]+$/

export function runNumber(id: string): number {
  return Number(RUN_ID.exec(id)?.[1] ?? 0)
}

export function parseRun(text: string | null, format: number): RunFile | null {
  if (!text) return null
  try {
    const r = JSON.parse(text)
    if (!r || r.format !== format || typeof r.id !== 'string' || !RUN_ID.test(r.id) || typeof r.done !== 'string' || typeof r.what !== 'string' || !r.owner || typeof r.owner.slug !== 'string') return null
    return r as RunFile
  } catch {
    return null
  }
}

export function parseStep<T extends { id: string; format: number }>(text: string | null, format: number): T | null {
  if (!text) return null
  try {
    const r = JSON.parse(text)
    return r && r.format === format && typeof r.id === 'string' ? (r as T) : null
  } catch {
    return null
  }
}

/** What declare takes, checked: the done-file is required (absolute, or relative to the project for one here), the
 * host a plain ssh target, every path plain */
export function checkDeclare(e: Record<string, unknown>): { ok: true; what: string; item: string | null; host: string | null; dir: string | null; done: string; log: string | null } | { ok: false; reason: string } {
  const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string).trim() : '')
  const what = str('what')
  const done = str('done')
  const host = str('host') || null
  const dir = str('dir') || null
  const log = str('log') || null
  const item = str('item') || null
  if (!what) return { ok: false, reason: 'say what the run is (what: "the timing sim of B-12, corner ss")' }
  if (what.length > 300) return { ok: false, reason: `what is ${what.length} characters: say it in 300 at most` }
  if (!done) return { ok: false, reason: 'name its done-file (done: the file the run writes its exit code to when it ends, e.g. "<dir>/done" from `echo $? > <dir>/done`)' }
  for (const [k, v] of [['done', done], ['dir', dir], ['log', log]] as const) if (v && !PLAIN_PATH.test(v)) return { ok: false, reason: `${k} has characters fleet doesn't pass to a shell (spaces, quotes, $ or the like): use a plain path` }
  if (host && !/^[A-Za-z0-9_.@-]+$/.test(host)) return { ok: false, reason: 'host is an ssh target as you reach it (dev, me@dev.example.com), nothing else' }
  if (host && !done.startsWith('/') && !done.startsWith('~/')) return { ok: false, reason: 'on a host, the done-file is an absolute path (or ~/…)' }
  if (item && !/^[A-Za-z]+-\d+$/.test(item)) return { ok: false, reason: 'item is a board item id (B-12), or leave it out' }
  return { ok: true, what, item, host, dir, done, log }
}

/** The exit code a done-file holds: its first number (null when there's none) */
export function doneExit(text: string): number | null {
  const m = /-?\d+/.exec(text)
  return m ? Number(m[0]) : null
}

/** A run as a line of a list (status, the brief, mcp__fleet__run list) */
export function runLine(v: RunView, now: number, offsetMin: number): string {
  const r = v.run
  const where = r.host ? ` on ${r.host}` : ''
  const head = `${r.id} (${r.owner.name}${r.item ? `, ${r.item}` : ''}): ${r.what}${where}`
  if (v.recorded) return `${head}: recorded ${ago(now - v.recorded.at)} ago`
  if (v.done) return `${head}: finished at ${clock(v.done.at, offsetMin)}${v.done.exit !== null ? ` (exit ${v.done.exit})` : ''}, not recorded yet`
  return `${head}: running since ${clock(r.at, offsetMin)} (done-file ${r.done})`
}

/** What its owner hears once its run finished (at its next step, or as a wake) */
export function finishedText(v: RunView, offsetMin: number): string {
  const r = v.run
  const exit = v.done?.exit
  return `fleet: your run ${r.id}${r.item ? ` for ${r.item}` : ''} (${r.what}${r.host ? `, on ${r.host}` : ''}) finished at ${clock(v.done?.at ?? r.at, offsetMin)}${exit !== null && exit !== undefined ? ` (exit ${exit})` : ''}. Read its output${r.log ? ` (${r.log})` : r.dir ? ` (in ${r.dir})` : ''}, land the result where it goes, and record it: mcp__fleet__run record with its id and where the result is.`
}

export const RUN_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['declare', 'list', 'record'], description: 'declare a run you launched, list yours, or record a finished one' },
    what: { type: 'string', description: 'declare: what the run is, in a few words' },
    item: { type: 'string', description: 'declare: the board item it is for (B-12)' },
    host: { type: 'string', description: "declare: the ssh target it runs on (as outbound.json's hosts allow); none for this machine" },
    dir: { type: 'string', description: 'declare: its folder' },
    done: { type: 'string', description: 'declare: the file it writes its exit code to when it ends (echo $? > <dir>/done)' },
    log: { type: 'string', description: 'declare: its log' },
    id: { type: 'string', description: 'record: the run (run-3)' },
    result: { type: 'string', description: 'record: where its result landed, or what it showed' },
  },
  required: ['action'],
} as const

export const RUN_DESCRIPTION =
  `Keep a long run from being lost. Launch a run that takes more than a few minutes (a simulation, a long build) detached on its host, so a restart, a sleep or a compaction of your session doesn't lose it: ${DETACHED_RECIPE} (it works on macOS and Linux alike; or the host's batch system). Then declare it here (action declare: what, item, host, dir, done, log): fleet watches its done-file (on its host over ssh, where outbound.json allows) and tells you when it finished, even after your session restarted. A run in flight isn't a reason to end your turn: take your next item meanwhile. When it finished, read its output, land the result, and record it (action record: id, result). action list shows your runs.`
