import type { Color, Period, UsageSummary } from '../types'

// The format of everything the mod shares outside one session: the files in its data folder (heartbeats, the panel
// order, inbox requests, the launcher's window files, the mirrored settings) and the notices between sessions. Each one
// carries `format=<n>`. A reader that finds another format leaves it alone and says the sessions need a restart (u, or
// claude respawn): sessions running another version of the mod never act on each other's data by mistake.
// The launcher (hooks/launcher.py, hooks/visor.sh) reads and writes the same formats: change them together.
export const FORMAT = 1

// The first version of the mod that writes heartbeats: sessions started after this version was installed are
// expected to have one
export const HEARTBEAT_VERSION = '0.10.0'

// What each session's mod writes to the shared store under `state:<sessionId>`.
// created: when the session's mod first started; turnStarted: when the current turn started; finished: when the last
// turn finished; reason: why it finished; answer: last line of the answer; question: whether that line ends in "?";
// model: short model name; context: % of the context used; version: the Claude version the session runs
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
// (the one for a 229-column window). Never less than 20.
export function paneWidth(names: string[], cap: number): number {
  const longestName = Math.max(8, ...names.map(displayWidth))
  const needed = Math.max(50, longestName + 25)
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

// The sessions the background service closed for lack of memory and that are still closed, with when (ms). Comes from
// its log (~/.claude/daemon.log): the last thing that happened to the session is a "retire <id>: … [low memory…]" and
// it didn't start again afterwards ("claimed-spare" or "spawned"). If it was later closed for another reason (another
// retire), it doesn't count
export function closedForLowMemory(log: string): Record<string, number> {
  const closed: Record<string, number> = {}
  for (const line of log.split('\n')) {
    const m = line.match(/^\[([^\]]+)\] \[bg\] bg (retire|claimed-spare|spawned) ([0-9a-f]{8})\b(.*)$/)
    if (!m) continue
    const [, when = '', event, id = '', rest = ''] = m
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
// answer in `reply`. Old requests (more than 30 s) are dropped
export type InboxRequest = { format: number; action: string; at: number; tty: string; title: string; reply: string }
export function parseInbox(text: string): InboxRequest | null {
  const k = parseKeyLines(text)
  if (!k.format || !k.action) return null
  return { format: Number(k.format) || 0, action: k.action, at: Number(k.at) || 0, tty: k.tty ?? '', title: k.title ?? '', reply: k.reply ?? '' }
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
