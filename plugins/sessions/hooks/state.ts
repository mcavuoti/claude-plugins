import type { Color, Period, UsageSummary } from '../types'

// What each session's mod writes to the shared store under `estado:<sessionId>`. Stored key/field names are a wire
// format shared with other sessions (old and new versions of this mod read each other's entries); they stay in Spanish.
// creado: when the session was created; empezado: when the current turn started; terminado: when the last turn
// finished; motivo: why it finished; respuesta: last line of the answer; pregunta: whether that line ends in "?";
// modelo: short model name; contexto: % of the context used
export type SessionState = {
  creado?: number
  empezado?: number
  terminado?: number
  motivo?: string
  respuesta?: string
  pregunta?: boolean
  modelo?: string
  contexto?: number
  // Version of what that session's mod understands (1: the panel focus notice; 2: the Stop question; 3: the Update one)
  protocolo?: number
  // The Claude version the session runs (written by its own mod)
  version?: string
}

// Short time for the right-hand column: now, 3m, 2h, 1d
export function timeSince(ms: number, now: number): string {
  const min = Math.floor(Math.max(0, now - ms) / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

// The color comes from the official status (busy/idle/waiting, reported by the session itself) and from what the mod
// records in each session. "since" is the moment the time counts from: working since, waiting for you since, finished ago.
export function colorOf(s: any, state: SessionState | null, seen: number, waitingSince?: number): { color: Color; since?: number } {
  if (s.status === undefined || s.status === null) return { color: 'gray' }
  if (s.status === 'busy') return { color: 'blue', since: state?.empezado }
  if (s.status === 'waiting') return { color: 'red', since: waitingSince }
  if (s.status !== 'idle') return { color: 'gray' }
  if (!state?.terminado) return { color: 'green', since: state?.creado }
  return { color: seen >= state.terminado ? 'green' : 'yellow', since: state.terminado }
}

// "claude-opus-5-5[1m]", "Opus 5.5 (1M context)" or "claude-haiku-4-5-20251001" → "Opus 5.5" / "Haiku 4.5"
export function shortModelName(m: string): string {
  const x = m.match(/(opus|sonnet|haiku|fable)[^0-9]*(\d+)(?:[.-](\d+))?/i)
  if (!x) return m.split(/[\s([]/)[0].slice(0, 10)
  const name = x[1][0].toUpperCase() + x[1].slice(1).toLowerCase()
  return x[3] && x[3].length <= 2 ? `${name} ${x[2]}.${x[3]}` : `${name} ${x[2]}`
}

// Columns a text takes in the terminal: emoji take two
export function displayWidth(text: string): number {
  return Array.from(text).reduce((n, c) => n + (/\p{Extended_Pictographic}/u.test(c) ? 2 : 1), 0)
}

// Panel width (body columns): what the widest row needs ([▌● ] + name + [↑◆] + model, % and time), never less than the
// legend (50). The cap is the width Claude gives the panel on its own (measured); if it hasn't been measured yet, 89
// (the one for a 229-column window). Never less than 20.
export function paneWidth(names: string[], cap: number): number {
  const longestName = Math.max(8, ...names.map(displayWidth))
  const needed = Math.max(50, longestName + 25)
  return Math.max(20, Math.min(cap > 0 ? cap : 89, needed))
}

// The panel's questions: their options and what each one does. A session that's already stopped can only be removed
// from the list. Restart (u) restarts the session: a new process with the same conversation, which re-reads the MCP
// servers, plugins and settings, and moves to the installed Claude version. Internally it's called 'update' (that's how
// the other sessions' mods understand it); "Update now" is the previous mod's answer.
// Any other answer (Cancel, Esc or hand-typed text) does nothing.
export type Action = 'stop' | 'stop-rm' | 'rm' | 'update'
export const STOP_OPTIONS = ['Stop', 'Stop & Remove', 'Cancel']
export const REMOVE_OPTIONS = ['Remove from list', 'Cancel']
export const RESTART_OPTIONS = ['Restart', 'Cancel']
export function actionFromAnswer(answer: string): Action | null {
  if (answer === 'Stop') return 'stop'
  if (answer === 'Stop & Remove') return 'stop-rm'
  if (answer === 'Remove from list') return 'rm'
  if (answer === 'Restart' || answer === 'Update now') return 'update'
  return null
}

// Claude versions ("2.1.291"). parseVersion extracts the version from what `claude --version` prints ("2.1.291 (Claude Code)")
export function parseVersion(text: string): string | null {
  const m = text.trim().match(/^(\d+)\.(\d+)\.(\d+)(?=$|[\s(])/)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

// The version of the program a process runs, from what `lsof -Fn` says about its executable
// ("n/Users/x/.local/share/claude/versions/2.1.289"). If Claude is installed some other way, null: nothing gets marked
export function versionFromExecutable(text: string): string | null {
  const m = text.match(/^n.*\/claude\/versions\/(\d+\.\d+\.\d+)$/m)
  return m ? m[1] : null
}

// The background tasks that count as work, with the same rule Claude's background service uses: artifact watches
// (artifact_watch, waiting for comments or new versions) are "drainable": they aren't work and move on their own to the
// new process when the session restarts. null if the format isn't understood
export function realTasks(inFlight: any): { count: number; kinds: string[] } | null {
  const total = Number(inFlight?.tasks)
  if (!Number.isFinite(total)) return null
  const drainable = Number(inFlight?.drainableMonitors) || 0
  const kinds = Array.isArray(inFlight?.kinds) ? [...new Set(inFlight.kinds.map(String))] as string[] : []
  return {
    count: Math.max(0, total - drainable),
    kinds: kinds.filter(t => t !== 'artifact_watch' || drainable === 0),
  }
}

// -1 if a is older than b, 1 if it's newer, 0 if they're equal or either isn't understood (when in doubt, nothing gets marked)
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  const pa = x.split('.').map(Number)
  const pb = y.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}

// Notices between the mod's sessions: a fixed marker, a space and the data as JSON. The markers and the payload field
// names/values are a wire format shared with other sessions (old and new versions of this mod); they stay as they are
export function buildMessage(marker: string, data: Record<string, unknown>): string {
  return `${marker} ${JSON.stringify(data)}`
}

export function parseMessage(text: string, marker: string): Record<string, unknown> | null {
  const i = text.indexOf(`${marker} `)
  if (i < 0) return null
  const rest = text.slice(i + marker.length)
  const start = rest.indexOf('{')
  const end = rest.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const data = JSON.parse(rest.slice(start, end + 1))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

// The row that stays selected when the chosen one leaves the list: the next one, or the previous one if it was the last
export function neighbor(ids: string[], id: string): string | undefined {
  const i = ids.indexOf(id)
  if (i < 0) return ids[0]
  return ids[i + 1] ?? ids[i - 1]
}

// The same when the row is already gone: using the previous order, the first one after it that's still there; otherwise
// the last one before it
export function remainingNeighbor(before: string[], id: string, remaining: string[]): string | undefined {
  const i = before.indexOf(id)
  const next = before.slice(i + 1).find(x => remaining.includes(x))
  const previous = before.slice(0, Math.max(0, i)).reverse().find(x => remaining.includes(x))
  return (i < 0 ? undefined : (next ?? previous)) ?? remaining[0]
}

// Usage block: tokens per period (the Period and UsageSummary types live in ../types)
export type { Period, UsageSummary }

// 850, 1.2k, 412k, 1.2M, 41M, 5.1B
export function abbreviate(n: number): string {
  const v = Math.max(0, Math.round(n))
  const withSuffix = (x: number, suffix: string) => `${x < 10 ? (Math.round(x * 10) / 10).toString() : Math.round(x).toString()}${suffix}`
  if (v < 1000) return String(v)
  if (v < 999500) return withSuffix(v / 1e3, 'k')
  if (v < 999500000) return withSuffix(v / 1e6, 'M')
  return withSuffix(v / 1e9, 'B')
}

// One-line bars (▁ to █) relative to the highest value; a zero stays blank. Each value takes 1 to 3 columns, whatever
// fits in the width; if they don't all fit, the last ones are shown
const LEVELS = '▁▂▃▄▅▆▇█'
export function sparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) return ''
  const each = Math.max(1, Math.min(3, Math.floor(width / values.length)))
  const visible = values.slice(-Math.max(1, Math.floor(width / each)))
  const max = Math.max(...visible)
  return visible
    .map(v => (v <= 0 || max <= 0 ? ' ' : LEVELS[Math.min(7, Math.max(0, Math.ceil((v / max) * 8) - 1))]).repeat(each))
    .join('')
}

// The days in the window, from the oldest to today ("2026-10-06" and the n-1 before it), in local time
export function daysUpTo(today: string, n: number): string[] {
  const [y, m, d] = today.split('-').map(Number)
  const two = (x: number) => String(x).padStart(2, '0')
  const list: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(y, m - 1, d - i)
    list.push(`${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}`)
  }
  return list
}

// The chosen period, for the folders that are included: one total per bar (today: per hour, up to the current one;
// week: 7 days; month: 30 days) and the sum of each token type
export function usageWindow(r: UsageSummary, period: Period, includes: (cwd: string) => boolean): { bars: number[]; totals: number[] } {
  const keys =
    period === 'day'
      ? Array.from({ length: Number(r.hora.slice(11, 13)) + 1 }, (_, h) => `${r.hoy}T${String(h).padStart(2, '0')}`)
      : daysUpTo(r.hoy, period === 'week' ? 7 : 30)
  const source = period === 'day' ? r.horas : r.dias
  const totals = [0, 0, 0, 0, 0]
  const perKey = keys.map(() => 0)
  for (const [cwd, values] of Object.entries(source ?? {})) {
    if (!includes(cwd)) continue
    keys.forEach((k, i) => {
      const v = values[k]
      if (!Array.isArray(v)) return
      for (let j = 0; j < 5; j++) totals[j] += Number(v[j]) || 0
      perKey[i] += (Number(v[0]) || 0) + (Number(v[1]) || 0) + (Number(v[2]) || 0) + (Number(v[3]) || 0)
    })
  }
  return { bars: perKey, totals }
}

// Whether a folder (a session's) belongs to the project: the root and its subfolders. If the root is the home folder
// (a session opened in ~, with no project), only that folder: its subfolders are everything on the computer
export function inProject(cwd: string, root: string, home: string): boolean {
  if (cwd === root) return true
  if (!root || root === '/' || (home && root === home)) return false
  return cwd.startsWith(`${root}/`)
}

// The pinned sessions (Ctrl+T in `claude agents`): ~/.claude/jobs/pins.json, a list of ids the background service
// doesn't close for being idle. If the file changes shape, null: it isn't touched
export function parsePins(text: string): string[] | null {
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(list) || !list.every(x => typeof x === 'string')) return null
  return list
}

// Automatically pin a background session that has Remote Control on, and unpin it when it's turned off. remote: by id,
// whether it has Remote Control (null if it couldn't be read: no change); a session that's missing was deleted. Only
// what the mod pinned (ids) gets unpinned: what you pinned yourself stays. If you manually unpin one the mod pinned,
// it isn't pinned again until its Remote Control is turned off and back on (released).
// Stored under `fijadoAuto`: the field names (ids, soltadas = released) are a wire format and stay as they are
export type AutoPins = { ids: string[]; soltadas: string[] }
export function reconcilePins(
  pins: string[],
  remote: Record<string, boolean | null>,
  auto: AutoPins,
): { pins: string[]; auto: AutoPins; toPin: string[]; toUnpin: string[] } {
  const pinned = new Set(pins)
  const ids = new Set(auto.ids)
  const released = new Set(auto.soltadas)
  const toPin: string[] = []
  const toUnpin: string[] = []
  const unpinModOwned = (id: string) => {
    ids.delete(id)
    if (pinned.delete(id)) toUnpin.push(id)
  }
  for (const [id, isRemote] of Object.entries(remote)) {
    if (isRemote === null) continue
    if (!isRemote) {
      released.delete(id)
      if (ids.has(id)) unpinModOwned(id)
    } else if (pinned.has(id) || released.has(id)) {
      continue
    } else if (ids.has(id)) {
      ids.delete(id)
      released.add(id)
    } else {
      pinned.add(id)
      ids.add(id)
      toPin.push(id)
    }
  }
  for (const id of [...ids]) if (!(id in remote)) unpinModOwned(id)
  for (const id of [...released]) if (!(id in remote)) released.delete(id)
  return {
    pins: [...pins.filter(id => !toUnpin.includes(id)), ...toPin],
    auto: { ids: [...ids], soltadas: [...released] },
    toPin,
    toUnpin,
  }
}

// The sessions the background service closed for lack of memory and that are still closed, with when (ms). Comes from
// its log (~/.claude/daemon.log): the last thing that happened to the session is a "retire <id>: … [low memory…]" and
// it didn't start again afterwards ("claimed-spare" or "spawned"). If it was later closed for another reason (another
// retire), it doesn't count
export function closedForLowMemory(log: string): Record<string, number> {
  const closed: Record<string, number> = {}
  for (const line of log.split('\n')) {
    const m = line.match(/^\[([^\]]+)\] \[bg\] bg (retire|claimed-spare|spawned) ([0-9a-f]{8})\b(.*)$/)
    if (!m) continue
    const [, when, event, id, rest] = m
    if (event === 'retire' && /\[low memory/.test(rest)) closed[id] = Date.parse(when) || 0
    else delete closed[id]
  }
  return closed
}

// The times the mod reopened a session in the last 2 h (so it doesn't insist if memory fills up again)
export function recentReopens(previous: unknown, now: number): number[] {
  return Array.isArray(previous) ? previous.filter((t): t is number => typeof t === 'number' && now - t < 7200000) : []
}

// The output of `claude agents --json`: a list of sessions with sessionId (text) and cwd. If an update changes the
// format, the panel shows a notice instead of wrong data.
export function validateList(text: string): any[] | string {
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    return 'The session list changed format (not JSON)'
  }
  if (!Array.isArray(list)) return 'The session list changed format (not a list)'
  const bad = list.filter(s => typeof s?.sessionId !== 'string' || typeof s?.cwd !== 'string')
  if (bad.length) return 'The session list changed format (missing sessionId or cwd)'
  return list
}

// Which terminal windows show each session, from `ps -A -o pid=,tty=,command=` (same columns on macOS and Linux; a
// process without a terminal shows `??` on macOS and `?` on Linux). Only clients count as showing a session: the viewer
// (`claude attach <id>`) and the agent view (`claude agents`), never a session's own process (except byPid, which maps
// every process to its terminal). launchers: the windows running the mod's launcher (`bash …/visor.sh`)
export type Windows = {
  byId: Record<string, string[]>
  byPid: Record<string, string>
  agentsViews: { pid: string; tty: string }[]
  clients: Record<string, string>
  launchers: Record<string, string>
}
export function parseWindows(ps: string): Windows {
  const v: Windows = { byId: {}, byPid: {}, agentsViews: [], clients: {}, launchers: {} }
  for (const line of ps.split('\n')) {
    const [pid, tty, ...rest] = line.trim().split(/\s+/)
    if (!pid || !tty || tty === '??' || tty === '?' || tty === '-') continue
    const command = rest.join(' ')
    const dev = `/dev/${tty}`
    v.byPid[pid] = dev
    const m = command.match(/^(\S*\/)?claude attach ([0-9a-f]{8})$/)
    if (m) {
      ;(v.byId[m[2]] ??= []).push(dev)
      v.clients[dev] = pid
    }
    if (/^(\S*\/)?claude agents( |$)/.test(command)) {
      v.agentsViews.push({ pid, tty: dev })
      v.clients[dev] = pid
    }
    if (/^(\S*\/)?bash \S*\/visor\.sh( |$)/.test(command)) v.launchers[dev] = pid
  }
  return v
}
