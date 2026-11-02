import type { Color, Period, RateLimit, SessionsMark, SessionsMember, SessionsResult, SessionsSection, SessionsTint, UsageSummary } from '../types'

// The format of everything the mod shares outside one session: the files in its data folder (heartbeats, the panel
// order, inbox requests, the launcher's window files, the mirrored settings) and the notices between sessions. Each one
// carries `format=<n>`. A reader that finds another format leaves it alone and says the sessions need a restart (u, or
// claude respawn): sessions running another version of the mod never act on each other's data by mistake.
// The launcher (hooks/launcher.py, hooks/visor.sh) reads and writes the same formats: change them together.
export const FORMAT = 2

// The first version of the mod that writes heartbeats: sessions started after this version was installed are
// expected to have one
export const HEARTBEAT_VERSION = '0.10.0'

// What each session's mod writes to the shared store under `state:<sessionId>`.
// created: when the session's mod first started; turnStarted: when the current turn started; finished: when the last
// turn finished; reason: why it finished; answer: last line of the answer; question: whether that line ends in "?";
// model: short model name; context: % of the context used; version: the Claude version the session runs; agent: the
// agent it runs as (`claude --agent`), null for none; root: the project root its panel uses; usd: what it has cost so
// far at list price (as /cost says); limits: the account's rate-limit windows its last response reported (empty off a
// subscription)
export type SessionState = {
  created?: number
  turnStarted?: number
  finished?: number
  reason?: string
  answer?: string
  question?: boolean
  model?: string
  context?: number
  version?: string
  agent?: string | null
  root?: string
  usd?: number
  limits?: RateLimit[]
}

// What a session spends, read per session and never assumed: on a subscription its responses report rate-limit windows
// (five_hour, seven_day, …; any can be missing); off one (an API key) there are none, and the cost at list price is what
// says how much. Before its first response a session reports no window and costs nothing: nothing is known yet
export type Spend = { mode: 'subscription'; limits: RateLimit[] } | { mode: 'api'; usd: number } | { mode: 'unknown' }
export function spendOf(e: { usd?: unknown; limits?: unknown } | null): Spend {
  const limits = Array.isArray(e?.limits) ? e.limits.filter((l: any) => typeof l?.kind === 'string' && Number.isFinite(l?.percent)) : []
  if (limits.length) return { mode: 'subscription', limits }
  const usd = Number(e?.usd)
  return Number.isFinite(usd) && usd > 0 ? { mode: 'api', usd } : { mode: 'unknown' }
}

// What $.session.usage() says, as a session publishes it: the cost rounded to the cent, and each window once
export function publishedSpend(u: { rateLimits?: unknown; cost?: { usd?: unknown } } | null | undefined): { usd?: number; limits: RateLimit[] } {
  const limits: RateLimit[] = []
  for (const l of Array.isArray(u?.rateLimits) ? u.rateLimits : []) {
    const percent = Number(l?.percentUsed)
    if (typeof l?.kind === 'string' && Number.isFinite(percent) && !limits.some(x => x.kind === l.kind)) limits.push({ kind: l.kind, percent })
  }
  const usd = Number(u?.cost?.usd)
  return { usd: Number.isFinite(usd) ? Math.round(usd * 100) / 100 : undefined, limits }
}

// $0.04, $1.20, $20.04, $123, $1.2k
export function formatUsd(usd: number): string {
  if (usd < 100) return `$${usd.toFixed(2)}`
  if (usd < 1000) return `$${Math.round(usd)}`
  return `$${abbreviate(usd)}`
}

// The account's windows, as the line above the prompt shows them: "5h 12% · 7d 43%"
export function limitsText(limits: readonly RateLimit[]): string {
  const label = (kind: string) => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'limit' : kind.replace(/_/g, ' '))
  return limits.map(l => `${label(l.kind)} ${Math.round(l.percent)}%`).join(' · ')
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
  if (s.status === 'busy') return { color: 'blue', since: state?.turnStarted }
  if (s.status === 'waiting') return { color: 'red', since: waitingSince }
  if (s.status !== 'idle') return { color: 'gray' }
  if (!state?.finished) return { color: 'green', since: state?.created }
  return { color: seen >= state.finished ? 'green' : 'yellow', since: state.finished }
}

// The panel's order when it doesn't have the keyboard: waiting for you, done and unseen, working, idle, stopped; then
// by title. The launcher opens the first row of this order (it reads it from the order file the panels write)
export const COLOR_RANK: Record<Color, number> = { red: 0, yellow: 1, blue: 2, green: 3, gray: 4 }
export function sortRows<T extends { color: Color; title: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => COLOR_RANK[a.color] - COLOR_RANK[b.color] || a.title.localeCompare(b.title))
}

// "claude-opus-5-5[1m]", "Opus 5.5 (1M context)" or "claude-haiku-4-5-20251001" → "Opus 5.5" / "Haiku 4.5"
export function shortModelName(m: string): string {
  const x = m.match(/(opus|sonnet|haiku|fable)[^0-9]*(\d+)(?:[.-](\d+))?/i)
  if (!x || !x[1] || !x[2]) return m.split(/[\s([]/)[0]?.slice(0, 10) ?? ''
  const name = x[1].charAt(0).toUpperCase() + x[1].slice(1).toLowerCase()
  return x[3] && x[3].length <= 2 ? `${name} ${x[2]}.${x[3]}` : `${name} ${x[2]}`
}

// Columns a text takes in the terminal: emoji take two
export function displayWidth(text: string): number {
  return Array.from(text).reduce((n, c) => n + (/\p{Extended_Pictographic}/u.test(c) ? 2 : 1), 0)
}

// Panel width (body columns): what the widest row needs ([▌● ] + name + [↑◆] + model, % and time), never less than the
// legend (50). The cap is the width Claude gives the panel on its own (measured); if it hasn't been measured yet, 89
// (the one for a 229-column window). Never less than 20. extra: the columns another column takes (the spend, on an API
// account)
export function paneWidth(names: string[], cap: number, extra = 0): number {
  const longestName = Math.max(8, ...names.map(displayWidth))
  const needed = Math.max(50, longestName + 25 + extra)
  return Math.max(20, Math.min(cap > 0 ? cap : 89, needed))
}

// The panel's questions: their options and what each one does. A session that's already stopped can only be removed
// from the list. Restart (u) restarts the session: a new process with the same conversation, which re-reads the MCP
// servers, plugins and settings, and moves to the installed Claude version.
// Any other answer (Cancel, Esc or hand-typed text) does nothing.
export type Action = 'stop' | 'stop-rm' | 'rm' | 'restart'
export const STOP_OPTIONS = ['Stop', 'Stop & Remove', 'Cancel']
export const REMOVE_OPTIONS = ['Remove from list', 'Cancel']
export const RESTART_OPTIONS = ['Restart', 'Cancel']
export function actionFromAnswer(answer: string): Action | null {
  if (answer === 'Stop') return 'stop'
  if (answer === 'Stop & Remove') return 'stop-rm'
  if (answer === 'Remove from list') return 'rm'
  if (answer === 'Restart') return 'restart'
  return null
}

// Claude versions ("2.1.291"). parseVersion extracts the version from what `claude --version` prints ("2.1.291 (Claude Code)")
export function parseVersion(text: string): string | null {
  const m = text.trim().match(/^(\d+)\.(\d+)\.(\d+)(?=$|[\s(-])/)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

// The version of the program a process runs, from what `lsof -Fn` says about its executable
// ("n/Users/x/.local/share/claude/versions/2.1.289"). If Claude is installed some other way, null: nothing gets marked
export function versionFromExecutable(text: string): string | null {
  const m = text.match(/^n.*\/claude\/versions\/(\d+\.\d+\.\d+)$/m)
  return m?.[1] ?? null
}

// The background tasks that count as work, with the same rule Claude's background service uses: artifact watches
// (artifact_watch, waiting for comments or new versions) are "drainable": they aren't work and move on their own to the
// new process when the session restarts. null if the format isn't understood
export function realTasks(inFlight: any): { count: number; kinds: string[] } | null {
  const total = Number(inFlight?.tasks)
  if (!Number.isFinite(total)) return null
  const drainable = Number(inFlight?.drainableMonitors) || 0
  const kinds = Array.isArray(inFlight?.kinds) ? ([...new Set(inFlight.kinds.map(String))] as string[]) : []
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
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  return 0
}

// Notices between the mod's sessions: a fixed marker, a space and the data as JSON, with the format and the kind.
// focus: you arrived here from the panel; ask: ask here whether to stop or restart this session (from: who asks,
// topic, detail); answer: the answer to that (sessionId: who answers, action, cameBack: whether the window came back);
// rename: rename yourself (name). The receiver consumes every notice with the marker (none reaches the model) and acts
// only on its own format. Senders only send to sessions whose heartbeat says they run the same format
export const NOTICE_MARKER = 'sessions-notice:7f3a'
export type NoticeKind = 'focus' | 'ask' | 'answer' | 'rename'
export function buildNotice(kind: NoticeKind, data: Record<string, unknown> = {}): string {
  return `${NOTICE_MARKER} ${JSON.stringify({ format: FORMAT, kind, ...data })}`
}

export function parseNotice(text: string): { format: number; kind: string; data: Record<string, unknown> } | null {
  const i = text.indexOf(`${NOTICE_MARKER} `)
  if (i < 0) return null
  const rest = text.slice(i + NOTICE_MARKER.length)
  const start = rest.indexOf('{')
  const end = rest.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const data = JSON.parse(rest.slice(start, end + 1))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    return { format: Number(data.format) || 0, kind: String(data.kind ?? ''), data }
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
  const previous = before
    .slice(0, Math.max(0, i))
    .reverse()
    .find(x => remaining.includes(x))
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
  return visible.map(v => (v <= 0 || max <= 0 ? ' ' : LEVELS.charAt(Math.min(7, Math.max(0, Math.ceil((v / max) * 8) - 1)))).repeat(each)).join('')
}

// The days in the window, from the oldest to today ("2026-10-06" and the n-1 before it), in local time
export function daysUpTo(today: string, n: number): string[] {
  const [y = 0, m = 1, d = 1] = today.split('-').map(Number)
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
      ? Array.from({ length: Number(r.hour.slice(11, 13)) + 1 }, (_, h) => `${r.today}T${String(h).padStart(2, '0')}`)
      : daysUpTo(r.today, period === 'week' ? 7 : 30)
  const source = period === 'day' ? r.hours : r.days
  const totals = [0, 0, 0, 0, 0]
  const perKey = keys.map(() => 0)
  for (const [cwd, values] of Object.entries(source ?? {})) {
    if (!includes(cwd)) continue
    keys.forEach((k, i) => {
      const v = values[k]
      if (!Array.isArray(v)) return
      for (let j = 0; j < 5; j++) totals[j] = (totals[j] ?? 0) + (Number(v[j]) || 0)
      perKey[i] = (perKey[i] ?? 0) + (Number(v[0]) || 0) + (Number(v[1]) || 0) + (Number(v[2]) || 0) + (Number(v[3]) || 0)
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

// The project root: the nearest folder upwards with AGENTS.md or CLAUDE.md (the folders that have one, outermost
// first), skipping the top two levels (/, /Users); if there's none, where the session started. The launcher walks up
// from its folder the same way
export function rootFrom(start: string, markerDirs: readonly string[]): string {
  const dirs = markerDirs.filter(d => d.split('/').filter(Boolean).length > 2 && (start === d || start.startsWith(`${d}/`)))
  return dirs[dirs.length - 1] ?? start
}

// The folders rootFrom can pick for a start folder, outermost first: each one above it below the top two levels, and
// the folder itself
export function rootCandidates(start: string): string[] {
  const parts = start.split('/').filter(Boolean)
  const out: string[] = []
  for (let n = 3; n <= parts.length; n++) out.push(`/${parts.slice(0, n).join('/')}`)
  return out
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
// it isn't pinned again until its Remote Control is turned off and back on (released). Stored under `autoPins`
export type AutoPins = { ids: string[]; released: string[] }
export function reconcilePins(
  pins: string[],
  remote: Record<string, boolean | null>,
  auto: AutoPins,
): { pins: string[]; auto: AutoPins; toPin: string[]; toUnpin: string[] } {
  const pinned = new Set(pins)
  const ids = new Set(auto.ids)
  const released = new Set(auto.released)
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
    auto: { ids: [...ids], released: [...released] },
    toPin,
    toUnpin,
  }
}

// When the store has no auto-pin record (a new store, or it was lost), the mod rebuilds one: every pinned session that
// has Remote Control on counts as pinned by the mod, so it gets unpinned when its Remote Control goes off. A session
// you pinned by hand with Remote Control on counts as the mod's too: the record can't tell them apart
export function adoptAutoPins(pins: readonly string[], remote: Readonly<Record<string, boolean | null>>): AutoPins {
  return { ids: pins.filter(id => remote[id] === true), released: [] }
}

// Why the background service's sessions that are still stopped stopped, and when (ms), from its log
// (~/.claude/daemon.log). The service retires an idle session ("retire <id>: settled, idle 61m", or "idle-prompt"),
// and closes idle ones when memory runs out ("retire <id>: … [low memory…]"); each retire is followed by the process
// ending ("settled <id> (done)"). A process that ends with no retire before it was stopped some other way: by the
// person (claude stop, the panel's s), or a crash. Starting again ("claimed-spare" or "spawned") clears the record
export type StopReason = { at: number; why: 'idle' | 'low-memory' | 'stopped' }
export function stopReasons(log: string): Record<string, StopReason> {
  const out: Record<string, StopReason> = {}
  for (const line of log.split('\n')) {
    const m = line.match(/^\[([^\]]+)\] \[bg\] bg (retire|settled|claimed-spare|spawned) ([0-9a-f]{8})\b(.*)$/)
    if (!m) continue
    const [, when = '', event, id = '', rest = ''] = m
    const at = Date.parse(when) || 0
    if (event === 'retire') out[id] = { at, why: /\[low memory/.test(rest) ? 'low-memory' : 'idle' }
    else if (event === 'settled') out[id] ??= { at, why: 'stopped' }
    else delete out[id]
  }
  return out
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
    if (m?.[2]) {
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

// The shared files are `key=value` lines (the launcher reads them with bash and Python): one value per key, the first
// `=` splits. A value can't hold a line break (they're replaced with a space when written)
export function keyLines(entries: Record<string, string | number | undefined>): string {
  return Object.entries(entries)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}\n`)
    .join('')
}

export function parseKeyLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0 && !(line.slice(0, i) in out)) out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

// A path as one file name: the order file of a project, the window file of a terminal
export function fileKey(path: string): string {
  return path.replace(/\//g, '_')
}

// The heartbeat: <data>/alive/<sessionId>, rewritten by the session's own mod every 15 s while it runs. It's how the
// launcher and the other panels tell a session whose mod is running from one whose mod never started (a pre-started
// process that was claimed with stale state, for one). pid: the session's process as the official list shows it;
// via: what started the mod (session.start, or the first draw, turn or prompt when that didn't come)
export type Heartbeat = { format: number; pid: number; at: number; version: string; via: string }
export function heartbeatText(h: Omit<Heartbeat, 'format'>): string {
  return keyLines({ format: FORMAT, pid: h.pid || '', at: h.at, version: h.version, via: h.via })
}

export function parseHeartbeat(text: string): Heartbeat | null {
  const k = parseKeyLines(text)
  const at = Number(k.at)
  if (!k.format || !Number.isFinite(at) || at <= 0) return null
  return { format: Number(k.format) || 0, pid: Number(k.pid) || 0, at, version: k.version ?? '', via: k.via ?? '' }
}

// A heartbeat is fresh for 45 s (three beats). ok: fresh, same format, same process; other-format: a session on
// another version of the mod (it needs a restart to talk to this one); missing: none, an old one, or another process's
export const HEARTBEAT_FRESH_MS = 45000
export type HeartbeatStatus = 'ok' | 'other-format' | 'missing'
export function heartbeatStatus(h: Heartbeat | null, pid: number | undefined, now: number): HeartbeatStatus {
  if (!h || now - h.at > HEARTBEAT_FRESH_MS) return 'missing'
  if (h.format !== FORMAT) return 'other-format'
  if (pid && h.pid && pid !== h.pid) return 'missing'
  return 'ok'
}

// The installed plugin as `claude plugin list --json` reports it: the enabled `sessions@<marketplace>` entry, its
// folder, version and since when (its last update). null if it isn't installed (a folder copy, for one)
export type InstalledPlugin = { path: string; version: string; since: number }
export function parsePluginList(text: string): InstalledPlugin | null {
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  const p = list.find(x => typeof x?.id === 'string' && x.id.startsWith('sessions@') && x.enabled === true)
  if (!p || typeof p.installPath !== 'string') return null
  const since = Date.parse(String(p.lastUpdated ?? p.installedAt ?? '')) || 0
  return { path: p.installPath, version: String(p.version ?? ''), since }
}

// Whether a session should have a heartbeat: it runs (it has a process), it started more than 30 s ago (time for its
// mod to start), and it started after a version of the mod that writes heartbeats was installed. A session started
// before that runs an older mod, which a restart would fix but which isn't broken: it isn't flagged
export function expectsHeartbeat(s: { pid?: number; status?: string; startedAt?: number }, plugin: { version: string; since: number } | null, now: number): boolean {
  if (!s.pid || !s.status || !plugin) return false
  if (compareVersions(plugin.version, HEARTBEAT_VERSION) < 0 || !parseVersion(plugin.version)) return false
  const started = Number(s.startedAt) || 0
  return started > plugin.since + 2000 && now - started > 30000
}

// The order file: <data>/order/<project root as a file name>, the panel's rows in the unfocused order, written by the
// panels of the project's sessions (when it changes, and every 20 s) and read by the launcher, which opens the first
// one. Rows: sessionId, color, id (or -) and title, separated by tabs
export type OrderRow = { sessionId: string; color: Color; id: string | null; title: string }
export function orderFileText(root: string, rows: readonly OrderRow[], now: number): string {
  const clean = (t: string) => t.replace(/[\t\r\n]+/g, ' ')
  return (
    keyLines({ format: FORMAT, at: now, root }) +
    rows.map(r => `row=${r.sessionId}\t${r.color}\t${r.id ?? '-'}\t${clean(r.title)}\n`).join('')
  )
}

export function parseOrderFile(text: string): { format: number; at: number; root: string; rows: OrderRow[] } | null {
  const k = parseKeyLines(text)
  if (!k.format) return null
  const rows: OrderRow[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('row=')) continue
    const [sessionId = '', color = '', id = '-', title = ''] = line.slice(4).split('\t')
    if (sessionId && color in COLOR_RANK) rows.push({ sessionId, color: color as Color, id: id === '-' ? null : id, title })
  }
  return { format: Number(k.format) || 0, at: Number(k.at) || 0, root: k.root ?? '', rows }
}

// A request for a session's mod: <data>/inbox/<sessionId>, written by the launcher. focus: you're arriving with ccc,
// the panel takes the keyboard; bring: bring the window `tty` forward (ccc found the project already open there) and
// answer in `reply`; wake: wake the stopped session `ref` for ccc tell, under the rules of $.sessions.wake, and answer
// in `reply` with result, state (running, queued, refused) and reason. Old requests (more than 30 s) are dropped
export type InboxRequest = { format: number; action: string; at: number; tty: string; title: string; reply: string; ref: string }
export function parseInbox(text: string): InboxRequest | null {
  const k = parseKeyLines(text)
  if (!k.format || !k.action) return null
  return { format: Number(k.format) || 0, action: k.action, at: Number(k.at) || 0, tty: k.tty ?? '', title: k.title ?? '', reply: k.reply ?? '', ref: k.ref ?? '' }
}

// ccc tell: a script hands a background session some text, which that session's mod submits as a turn of its own once
// the session is idle (the model reads it as sent by the sessions plugin, never as the person's). Its files, in
// <data>/tell/<ref>/:
//   allow           the person's /sessions tell on in that session (format, at); without it every request is refused
//   <id>.txt        the text, up to 4 KB (TELL_MAX_BYTES); <id> is <at>-<pid>, when and which ccc wrote it
//   <id>.req        format, from (who ran ccc tell), at: written last, so a request is whole once it's there
//   <id>.status     format, state, reason, at: what ccc tell prints, and what a script reads later
// state: queued (waiting for its turn), delivered (its turn started), held (refused because the person stopped the
// session with Esc: it goes once they type in it again), refused (never delivered, with why). The mod takes a request
// by renaming <id>.req to <id>.taken (<id>.held while it's held)
export const TELL_MAX_BYTES = 4096
export type TellState = 'queued' | 'delivered' | 'held' | 'refused'
export function tellStatusText(state: TellState, reason: string, at: number): string {
  return keyLines({ format: FORMAT, state, reason, at })
}

export function parseTellRequest(text: string): { format: number; from: string; at: number } | null {
  const k = parseKeyLines(text)
  if (!k.format) return null
  return { format: Number(k.format) || 0, from: (k.from ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'a script', at: Number(k.at) || 0 }
}

// The turn a request becomes, and the request it came from, as turn.start sees it
export function tellPrompt(id: string, from: string, text: string): string {
  return `[ccc tell ${id} from ${from}: sent by a script, not typed by the person]\n${text}`
}
export function tellIdIn(text: string): string | null {
  return text.match(/\[ccc tell (\d+-\d+) from /)?.[1] ?? null
}

// What the launcher opens next in a window: <data>/windows/<tty as a file name>. attach a session by its id, or the
// agent view in a folder; the title is shown while it opens (and is the window's title outside macOS)
export type WindowTarget = { command: 'attach'; id: string; title: string } | { command: 'agents'; title: string; folder: string }
export function windowTargetText(t: WindowTarget): string {
  return t.command === 'attach'
    ? keyLines({ format: FORMAT, command: 'attach', id: t.id, title: t.title })
    : keyLines({ format: FORMAT, command: 'agents', title: t.title, folder: t.folder })
}

// The name the panel's New field gives a session when you press Enter without typing one: the project folder's name
// and two random characters, like the names Claude gives regular sessions ("myapp-1f"), not used by another session of
// the project. random gives one hex digit per call
export function autoName(folder: string, taken: Iterable<string>, random: () => string): string {
  const used = new Set(taken)
  const base = folder.split('/').filter(Boolean).pop() || 'session'
  for (let i = 0; i < 64; i++) {
    const name = `${base}-${random()}${random()}${i >= 32 ? random() : ''}`
    if (!used.has(name)) return name
  }
  return `${base}-${Date.now().toString(16).slice(-4)}`
}

// A file name for a session's debug log: its name with anything unusual replaced
export function debugLogName(name: string): string {
  return `${name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'session'}.log`
}

// Why `claude --bg` didn't start a session, from what it printed, in the words ccc uses: a folder Claude doesn't trust
// yet, the home folder, or its own first line
export function bgRefusal(output: string, folder: string): string {
  if (output.includes('not trusted')) return `Claude doesn't trust ${folder} yet, so it can't start a session there in the background: run claude there once and accept its question`
  if (output.includes('trusted one session at a time')) return "Claude doesn't start background sessions in your home folder"
  return output.trim().split('\n')[0] || 'claude --bg failed'
}

// A session another plugin asks to start ($.sessions.start): its name (one line, up to 80 characters), the absolute
// folder it starts in, the agent it runs as (claude --agent) and a settings file (claude --settings) inside that
// folder's .claude/. What can be checked without the disk; the folder, the file and the name's uniqueness are checked
// by the caller
export type StartRequest = { name: string; cwd: string; agent?: string; settings?: string }
export function checkStart(input: any): { ok: true; request: StartRequest } | (SessionsResult & { ok: false }) {
  const invalid = (detail: string) => ({ ok: false as const, reason: 'invalid' as const, detail })
  const name = typeof input?.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : ''
  if (!name || Array.from(name).length > 80 || /\p{Cc}/u.test(name)) return invalid('name is 1 to 80 characters on one line')
  const raw = typeof input?.cwd === 'string' ? input.cwd : ''
  const cwd = raw.length > 1 ? raw.replace(/\/+$/, '') : raw
  if (!cwd.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(cwd)) return invalid('cwd is an absolute folder')
  const agent = input?.agent
  if (agent !== undefined && (typeof agent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(agent))) return invalid('agent is an agent name')
  const settings = input?.settings
  if (settings !== undefined) {
    if (typeof settings !== 'string' || !settings.startsWith('/') || /(^|\/)\.\.?(\/|$)/.test(settings)) return invalid('settings is an absolute path')
    if (!settings.startsWith(`${cwd === '/' ? '' : cwd}/.claude/`)) return { ok: false, reason: 'refused', detail: `a settings file inside ${cwd === '/' ? '' : cwd}/.claude/` }
  }
  return { ok: true, request: { name, cwd, ...(agent ? { agent } : {}), ...(settings ? { settings } : {}) } }
}

// Whether to update this session's mod in place with /reload-plugins: only when a newer version of the same install
// is installed (the running copy's folder is a sibling of the installed one: <cache>/<marketplace>/sessions/<version>),
// once per version, and only when nothing would be cut or confused: the session idle (no turn, nothing waiting for
// you, no background task), and you not in its panel (it has the keyboard, or a New or Rename field is open). 'wait'
// means try again later; 'no', not for this version
export type ReloadCheck = {
  running: string
  runningDir: string
  installed: InstalledPlugin | null
  triedFor: string
  status: string | null | undefined
  tasks: number | null
  paneFocused: boolean
  fieldOpen: boolean
}
export function reloadDecision(c: ReloadCheck): 'reload' | 'wait' | 'no' {
  const v = c.installed
  if (!v || !parseVersion(v.version) || !parseVersion(c.running) || compareVersions(v.version, c.running) <= 0) return 'no'
  const parent = (dir: string) => dir.replace(/\/+$/, '').replace(/\/[^/]+$/, '')
  if (!v.path || parent(v.path) !== parent(c.runningDir) || v.path === c.runningDir) return 'no'
  if (c.triedFor === v.version) return 'no'
  if (c.status !== 'idle' || c.tasks !== 0 || c.paneFocused || c.fieldOpen) return 'wait'
  return 'reload'
}

// How other plugins name a session (SessionsRef): the official short id of `claude agents`, which stays across /clear,
// or sid:<sessionId> for a regular session, which has none
export function refOf(s: { id?: unknown; sessionId: string }): string {
  return typeof s.id === 'string' && s.id ? s.id : `sid:${s.sessionId}`
}

// The agent a session runs as (`claude --agent <name>`): Claude writes a {"type":"agent-setting","agentSetting":"<name>"}
// row in the session's transcript when it starts (after custom-title and agent-name when it has a name) and again when
// it's resumed or restarted (after the messages). rows: the transcript's lines that start that way (a message that
// quotes one has it escaped, so it never starts a line); the last one says. null when there's none
export const AGENT_ROW = '{"type":"agent-setting"'
export function agentFromTranscript(rows: string): string | null {
  let agent: string | null = null
  for (const line of rows.split('\n')) {
    if (!line.startsWith(AGENT_ROW)) continue
    try {
      const row = JSON.parse(line)
      agent = typeof row?.agentSetting === 'string' && row.agentSetting ? row.agentSetting : null
    } catch {}
  }
  return agent
}

// Sections: <data>/sections.json, the person's data (what they chose, kept for good), so it has its own version,
// sectionsFormat, apart from the wire FORMAT. It changes only by adding fields, and a write keeps the fields it doesn't
// know. A file from a newer sessions (a higher sectionsFormat) is never read as if it were this one, nor rewritten: the
// panel says so and asks for a restart.
//   { "sectionsFormat": 1,
//     "sections": [{ "id": "me:renders", "title": "Renders", "order": 100, "owner": "person" }],
//     "members": { "aaaaaaaa": { "section": "me:renders", "by": "person" } } }
// Section ids: me:<slug> for the person's own (/sessions section <title>), <plugin>:<name> for a plugin's. Members are
// keyed by ref (refOf); one section per session
export const SECTIONS_FORMAT = 1
export type SectionsFile = { sectionsFormat: number; sections: any[]; members: Record<string, any>; [key: string]: unknown }
export type SectionsView = { sections: SessionsSection[]; members: Record<string, SessionsMember> }
export const NO_SECTIONS: SectionsView = { sections: [], members: {} }

export function emptySectionsFile(): SectionsFile {
  return { sectionsFormat: SECTIONS_FORMAT, sections: [], members: {} }
}

export function parseSectionsFile(text: string): { file: SectionsFile } | { problem: string } {
  let d: any
  try {
    d = JSON.parse(text)
  } catch {
    return { problem: "sections.json isn't valid JSON: fix it or remove it" }
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { problem: "sections.json isn't an object: fix it or remove it" }
  const version = Number(d.sectionsFormat)
  if (version > SECTIONS_FORMAT) return { problem: `sections.json is from a newer sessions (sectionsFormat ${version}): restart this session (u)` }
  if (version !== SECTIONS_FORMAT) return { problem: `sections.json has no sectionsFormat ${SECTIONS_FORMAT}: fix it or remove it` }
  return {
    file: {
      ...d,
      sectionsFormat: SECTIONS_FORMAT,
      sections: Array.isArray(d.sections) ? d.sections : [],
      members: d.members && typeof d.members === 'object' && !Array.isArray(d.members) ? d.members : {},
    },
  }
}

export function sectionsFileText(file: SectionsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

// What the file says, with anything malformed left out
export function sectionsView(file: SectionsFile): SectionsView {
  const sections: SessionsSection[] = []
  for (const s of file.sections) {
    if (typeof s?.id !== 'string' || !s.id.includes(':') || typeof s.title !== 'string' || sections.some(x => x.id === s.id)) continue
    const owner = typeof s.owner === 'string' ? s.owner : s.id.startsWith('me:') ? 'person' : s.id.split(':')[0]
    sections.push({ id: s.id, title: s.title, order: Number.isFinite(s.order) ? Number(s.order) : 200, owner })
  }
  const members: Record<string, SessionsMember> = {}
  for (const [ref, m] of Object.entries(file.members)) {
    if (typeof m?.section === 'string' && typeof m.by === 'string') members[ref] = { section: m.section, by: m.by, ...(isRef(m.parent) && m.parent !== ref ? { parent: m.parent } : {}) }
  }
  return { sections, members }
}

export function upsertSection(file: SectionsFile, s: SessionsSection): SectionsFile {
  const i = file.sections.findIndex(x => x?.id === s.id)
  const sections = [...file.sections]
  if (i < 0) sections.push({ ...s })
  else sections[i] = { ...sections[i], ...s }
  return { ...file, sections }
}

// A member's record is replaced but for the fields this version doesn't know, which are kept; its parent goes unless
// the new record has one
export function setMember(file: SectionsFile, ref: string, m: SessionsMember | null): SectionsFile {
  const members = { ...file.members }
  if (m) {
    const { parent: _, ...kept } = members[ref] ?? {}
    members[ref] = { ...kept, ...m }
  } else delete members[ref]
  return { ...file, members }
}

// The person's sections with nobody in them go: they exist only while the person keeps sessions there. A plugin's stay
// until it drops them (they draw nothing while empty)
export function dropEmptyPersonSections(file: SectionsFile): SectionsFile {
  const used = new Set(Object.values(file.members).map((m: any) => m?.section))
  const sections = file.sections.filter(s => !(typeof s?.id === 'string' && s.id.startsWith('me:') && !used.has(s.id)))
  return sections.length === file.sections.length ? file : { ...file, sections }
}

// Members of sessions that are gone (no longer in the official list)
export function pruneMembers(file: SectionsFile, keep: (ref: string) => boolean): SectionsFile {
  const gone = Object.keys(file.members).filter(ref => !keep(ref))
  if (gone.length === 0) return file
  const members = { ...file.members }
  for (const ref of gone) delete members[ref]
  return dropEmptyPersonSections({ ...file, members })
}

// A section id's name part, from a title the person typed: "Big renders!" → "big-renders"
export function slugOf(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

// What another plugin may call itself (its plugin name): not the person's (me) nor this plugin's (sessions)
export function checkSource(source: unknown): SessionsResult {
  if (typeof source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(source)) return { ok: false, reason: 'invalid', detail: 'source must be your plugin name' }
  if (source === 'me' || source === 'sessions') return { ok: false, reason: 'refused', detail: `"${source}" is reserved` }
  return { ok: true }
}

// A plugin's section: its id must be <source>:<name>, so a plugin defines only its own. The title is kept as given (up
// to 60 characters) and cut to fit when drawn
export function checkSectionSpec(source: unknown, spec: any): { ok: true; section: SessionsSection } | (SessionsResult & { ok: false }) {
  const s = checkSource(source)
  if (!s.ok) return s
  const id = typeof spec?.id === 'string' ? spec.id : ''
  const colon = id.indexOf(':')
  if (colon < 0) return { ok: false, reason: 'invalid', detail: `a section id is "${source}:<name>"` }
  if (id.slice(0, colon) !== source) return { ok: false, reason: 'refused', detail: `a plugin defines only its own sections ("${source}:<name>")` }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(id.slice(colon + 1))) return { ok: false, reason: 'invalid', detail: 'a section name is letters, digits, . _ or -, up to 48' }
  const title = typeof spec?.title === 'string' ? spec.title.trim().replace(/\s+/g, ' ') : ''
  if (!title || Array.from(title).length > 60) return { ok: false, reason: 'invalid', detail: 'a title is 1 to 60 characters' }
  if (spec.order !== undefined && !Number.isFinite(spec.order)) return { ok: false, reason: 'invalid', detail: 'order is a number' }
  return { ok: true, section: { id, title, order: spec.order ?? 200, owner: source as string } }
}

// How other plugins name a session (refOf): a short id or sid:<sessionId>
export function isRef(ref: unknown): ref is string {
  return typeof ref === 'string' && /^(sid:)?[A-Za-z0-9_-]{1,80}$/.test(ref)
}

// A plugin putting a session in one of its own sections (or taking it out: null), under a parent session if it gives
// one (drawn indented under it, in the parent's section, while the parent is in the list). Never over the person's
// choice nor another plugin's. The answer is the file to write, or why not (ok: true when there's nothing to change)
export function assignChange(file: SectionsFile, source: unknown, ref: unknown, section: unknown, parent?: unknown): { file: SectionsFile } | { result: SessionsResult } {
  const s = checkSource(source)
  if (!s.ok) return { result: s }
  if (!isRef(ref)) return { result: { ok: false, reason: 'invalid', detail: 'ref is a short id or sid:<sessionId>' } }
  if (parent !== undefined && parent !== null && (!isRef(parent) || parent === ref)) return { result: { ok: false, reason: 'invalid', detail: "parent is another session's ref, or null" } }
  if (parent && section === null) return { result: { ok: false, reason: 'invalid', detail: 'a session with a parent is in one of your sections' } }
  if (section !== null && typeof section !== 'string') return { result: { ok: false, reason: 'invalid', detail: 'section is a section id or null' } }
  if (section !== null && !section.startsWith(`${source}:`)) return { result: { ok: false, reason: 'refused', detail: `a plugin assigns only to its own sections ("${source}:<name>")` } }
  const view = sectionsView(file)
  if (section !== null && !view.sections.some(x => x.id === section)) return { result: { ok: false, reason: 'invalid', detail: `no section ${section}: define it first` } }
  const m = view.members[ref]
  if (m?.by === 'person') {
    const title = view.sections.find(x => x.id === m.section)?.title ?? m.section
    return { result: { ok: false, reason: 'refused', detail: `the person put this session in “${title}”` } }
  }
  if (m && m.by !== source) return { result: { ok: false, reason: 'refused', detail: `${m.by} put this session in its section` } }
  if (section === null) return m ? { file: setMember(file, ref, null) } : { result: { ok: true } }
  const under = typeof parent === 'string' ? parent : undefined
  if (m?.section === section && m.parent === under) return { result: { ok: true } }
  return { file: setMember(file, ref, { section, by: source as string, ...(under ? { parent: under } : {}) }) }
}

// The person putting a session in a section of theirs, by title (/sessions section <title>): the section me:<slug> is
// created if needed (order 100). The person's choice wins over any plugin's. null title: out of any section
export function personAssign(file: SectionsFile, ref: string, title: string | null): { file: SectionsFile; section: SessionsSection | null } | { problem: string } {
  if (title === null) return { file: dropEmptyPersonSections(setMember(file, ref, null)), section: null }
  const clean = title.trim().replace(/\s+/g, ' ')
  const slug = slugOf(clean)
  if (!slug) return { problem: 'A section title needs a letter or a digit' }
  if (Array.from(clean).length > 60) return { problem: 'A section title is up to 60 characters' }
  const id = `me:${slug}`
  const existing = sectionsView(file).sections.find(s => s.id === id)
  const section = existing ?? { id, title: clean, order: 100, owner: 'person' }
  const withSection = existing ? file : upsertSection(file, section)
  return { file: dropEmptyPersonSections(setMember(withSection, ref, { section: id, by: 'person' })), section }
}

// The rows in display order: this project's sessions in no section first, then each section by order and then title;
// inside each, the usual order (sortRows). A session with a parent in the list goes right under it, in the parent's
// section, indented (depth 1), among its siblings in the usual order. One level: a parent that has a parent in the list
// itself makes no children (they're drawn as any other row). Each row learns its section ('' for none), that section's
// title and its depth
export function groupRows<T extends { ref: string; color: Color; title: string }>(rows: readonly T[], view: SectionsView): (T & { section: string; sectionTitle: string; depth: number })[] {
  const byId = new Map(view.sections.map(s => [s.id, s]))
  const listed = new Set(rows.map(r => r.ref))
  const parentOf = (ref: string): string => {
    const p = view.members[ref]?.parent
    if (!p || p === ref || !listed.has(p)) return ''
    const grand = view.members[p]?.parent
    return grand && grand !== p && listed.has(grand) ? '' : p
  }
  const groups = new Map<string, T[]>()
  const children = new Map<string, T[]>()
  for (const r of rows) {
    const p = parentOf(r.ref)
    if (p) {
      children.set(p, [...(children.get(p) ?? []), r])
      continue
    }
    const m = view.members[r.ref]
    const id = m && byId.has(m.section) ? m.section : ''
    groups.set(id, [...(groups.get(id) ?? []), r])
  }
  const ids = [...groups.keys()]
    .filter(id => id !== '')
    .sort((a, b) => {
      const x = byId.get(a) as SessionsSection
      const y = byId.get(b) as SessionsSection
      return x.order - y.order || x.title.localeCompare(y.title) || a.localeCompare(b)
    })
  const title = (id: string) => (id ? (byId.get(id)?.title ?? '') : '')
  return ['', ...ids].flatMap(id =>
    sortRows(groups.get(id) ?? []).flatMap(r => [
      { ...r, section: id, sectionTitle: title(id), depth: 0 },
      ...sortRows(children.get(r.ref) ?? []).map(c => ({ ...c, section: id, sectionTitle: title(id), depth: 1 })),
    ]),
  )
}

// The header to draw above each row: a section's title where a section starts, only when two or more groups have rows
// (so a project that uses no sections looks as it always did). Rows in no section never get one
export function sectionHeaders(rows: readonly { section: string; sectionTitle: string }[]): (string | null)[] {
  const many = new Set(rows.map(r => r.section)).size >= 2
  return rows.map((r, i) => (many && r.section !== '' && (i === 0 || rows[i - 1]?.section !== r.section) ? r.sectionTitle : null))
}

// The f filter shows only the sessions waiting for you: red, or marked by a plugin as needing you (needsPerson). Who's
// in it is a snapshot: taken when it's turned on and whenever the pane doesn't have the keyboard, and kept while it has
// it (a row you answered stays, in its new color, until you leave), so nothing moves under the focus. null: the filter
// is off
export function waitingMembers(rows: readonly { sessionId: string; color: Color; needsPerson?: boolean }[], previous: ReadonlySet<string> | null, on: boolean, frozen: boolean): Set<string> | null {
  if (!on) return null
  if (previous && frozen) return new Set(previous)
  return new Set(rows.filter(r => r.color === 'red' || r.needsPerson).map(r => r.sessionId))
}

// Marks other plugins put on rows ($.sessions.setMarks): a badge of up to 3 columns, its tint, a status line of up to
// 60 characters and whether the session needs the person. Each session of a plugin that sets them keeps its own in
// the store, under marks:<source>:<sessionId>, as { at, until, rows } (rows by ref): a call replaces what that session
// of that plugin set before. They go at `until`, at most 10 minutes later, so a plugin that stops leaves none behind
export const MARK_TTL_MAX = 600000
export type MarkSlot = { at: number; until: number; rows: Record<string, SessionsMark> }
export type RowMark = { badge: string; tint: SessionsTint | ''; line: string; needsPerson: boolean }
export const NO_MARK: RowMark = { badge: '', tint: '', line: '', needsPerson: false }
const TINTS: readonly SessionsTint[] = ['error', 'warning', 'suggestion', 'success', 'inactive']

export function checkMarks(input: any): { ok: true; source: string; rows: Record<string, SessionsMark>; ttlMs: number } | (SessionsResult & { ok: false }) {
  const s = checkSource(input?.source)
  if (!s.ok) return s
  const invalid = (detail: string) => ({ ok: false as const, reason: 'invalid' as const, detail })
  const ttlMs = input?.ttlMs
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > MARK_TTL_MAX) return invalid('ttlMs is 1 to 600000 (10 minutes)')
  const given = input?.rows
  if (!given || typeof given !== 'object' || Array.isArray(given)) return invalid('rows is an object of marks by ref')
  const entries = Object.entries(given)
  if (entries.length > 200) return invalid('at most 200 rows')
  const rows: Record<string, SessionsMark> = {}
  for (const [ref, m] of entries as [string, any][]) {
    if (!isRef(ref)) return invalid(`${ref} isn't a ref (a short id or sid:<sessionId>)`)
    if (!m || typeof m !== 'object') return invalid(`the mark of ${ref} is an object`)
    const badge = typeof m.badge === 'string' ? m.badge.trim() : m.badge
    if (badge !== undefined && (typeof badge !== 'string' || displayWidth(badge) > 3 || /\p{Cc}/u.test(badge))) return invalid('a badge is up to 3 columns')
    if (m.tint !== undefined && !TINTS.includes(m.tint)) return invalid(`a tint is one of ${TINTS.join(', ')}`)
    const line = typeof m.line === 'string' ? m.line.trim().replace(/\s+/g, ' ') : m.line
    if (line !== undefined && (typeof line !== 'string' || Array.from(line).length > 60 || /\p{Cc}/u.test(line))) return invalid('a status line is up to 60 characters on one line')
    if (m.needsPerson !== undefined && typeof m.needsPerson !== 'boolean') return invalid('needsPerson is true or false')
    rows[ref] = { ...(badge ? { badge } : {}), ...(m.tint ? { tint: m.tint } : {}), ...(line ? { line } : {}), ...(m.needsPerson ? { needsPerson: true } : {}) }
  }
  return { ok: true, source: input.source, rows, ttlMs }
}

// What each row shows: the newest mark set on it wins, and it needs the person if any mark says so. Expired ones count
// for nothing
export function mergeMarks(slots: readonly MarkSlot[], now: number): Record<string, RowMark> {
  const out: Record<string, RowMark> = {}
  for (const slot of [...slots].filter(x => x.until > now).sort((a, b) => a.at - b.at)) {
    for (const [ref, m] of Object.entries(slot.rows ?? {})) {
      const needs = !!out[ref]?.needsPerson || m?.needsPerson === true
      out[ref] = { badge: String(m?.badge ?? ''), tint: TINTS.includes(m?.tint as SessionsTint) ? (m.tint as SessionsTint) : '', line: String(m?.line ?? ''), needsPerson: needs }
    }
  }
  return out
}

// While the pane has the keyboard nothing moves (Claude follows the focus by position): the rows that were shown keep
// their places, sections, indents and folds, and new ones go at the end. A status line under a row neither appears nor goes
// (its text changes; one that expired keeps its last text). Otherwise (or on a reflow the person asked for), the
// layout as computed
export function keepPlaces<T extends { sessionId: string; section: string; sectionTitle: string; line?: string; depth?: number; folded?: boolean }>(layout: readonly T[], shown: readonly T[], frozen: boolean): T[] {
  if (!frozen) return [...layout]
  const before = shown.map(f => f.sessionId)
  const previous = new Map(shown.map(f => [f.sessionId, f]))
  const place = (f: T) => {
    const i = before.indexOf(f.sessionId)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return layout
    .map(f => {
      const p = previous.get(f.sessionId)
      // A new row goes at the end, so it isn't drawn under its parent nor folded away
      if (!p) return { ...f, ...(f.depth === undefined ? {} : { depth: 0 }), ...(f.folded === undefined ? {} : { folded: false }) }
      return {
        ...f,
        section: p.section,
        sectionTitle: p.sectionTitle,
        ...(f.depth === undefined ? {} : { depth: p.depth ?? 0 }),
        ...(f.folded === undefined ? {} : { folded: p.folded ?? false }),
        ...(f.line === undefined ? {} : { line: p.line ? f.line || p.line : '' }),
      }
    })
    .sort((a, b) => place(a) - place(b))
}

// Folded sections (c in the panel): the person's choice, kept for every session in the store (collapsed). A folded
// section draws one line, a button that unfolds it, instead of its rows. Only sections that have a header fold (two or
// more groups have rows), and nothing folds with the f filter on (what waits for you would hide)
export function foldRows<T extends { section: string }>(rows: readonly T[], collapsed: ReadonlySet<string>, filterOn: boolean): (T & { folded: boolean })[] {
  const many = new Set(rows.map(r => r.section)).size >= 2
  return rows.map(r => ({ ...r, folded: !filterOn && many && r.section !== '' && collapsed.has(r.section) }))
}

// What the panel draws, top to bottom: a section's header above its first row, a folded section's one line (with how
// many sessions it holds and how many of them wait for you) instead of its rows, and the rows
export type PlanItem<T> = { kind: 'header'; section: string; title: string } | { kind: 'fold'; section: string; title: string; count: number; waiting: number } | { kind: 'row'; row: T }
export function drawPlan<T extends { section: string; sectionTitle: string; color: Color; folded?: boolean; needsPerson?: boolean }>(rows: readonly T[]): PlanItem<T>[] {
  const headers = sectionHeaders(rows)
  const out: PlanItem<T>[] = []
  const folds = new Set<string>()
  rows.forEach((r, i) => {
    if (r.folded) {
      if (folds.has(r.section)) return
      folds.add(r.section)
      const all = rows.filter(x => x.folded && x.section === r.section)
      out.push({ kind: 'fold', section: r.section, title: r.sectionTitle, count: all.length, waiting: all.filter(x => x.color === 'red' || x.needsPerson).length })
      return
    }
    const h = headers[i]
    if (h !== null && h !== undefined) out.push({ kind: 'header', section: r.section, title: h })
    out.push({ kind: 'row', row: r })
  })
  return out
}

// What the arrows go through, in order: the rows (s:<sessionId>) and the folded sections' lines (h:<section>)
export function ringKeys(rows: readonly { sessionId: string; section: string; sectionTitle: string; color: Color; folded?: boolean }[]): string[] {
  return drawPlan(rows).flatMap(it => (it.kind === 'row' ? [`s:${it.row.sessionId}`] : it.kind === 'fold' ? [`h:${it.section}`] : []))
}
