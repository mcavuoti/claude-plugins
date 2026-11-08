import type { Color, Period, RateLimit, SessionsMark, SessionsMember, SessionsResult, SessionsSection, SessionsTint, UsageSummary } from '../types'

// The format of everything the mod shares outside one session: the files in its data folder (heartbeats, the panel
// order, inbox requests, the launcher's window files, the mirrored settings, usage.py's summary, ccc's plugin lookup,
// the bells and the leader's record) and the notices between sessions. Each one carries `format=<n>`. A reader that
// finds another format leaves it alone and says the sessions need a restart (u, or claude respawn): sessions running
// another version of the mod never act on each other's data by mistake. The launcher (hooks/launcher.py,
// hooks/visor.sh, setup/ccc) reads and writes the same formats: change them together.
export const FORMAT = 3

// Where a session keeps its keys in the shared store: '' for the sessions you use, and @<hash>/ for a test session, one
// started with a location override (SESSIONS_DATA_DIR, SESSIONS_JOBS_DIR, SESSIONS_DAEMON_LOG, SESSIONS_CLAUDE: the
// first four values, in that order), so test sessions never read nor write theirs: the session list they cache from a
// stand-in claude, the pins they record, the notifications they count, their marks and the choices made in their
// panels, nor the prune of keys of sessions missing from their list. SESSIONS_PLUGIN_VERSION and SESSIONS_PLUGIN_SINCE
// (the fifth and sixth) count only beside a location: ccc sets them for its launcher, and a background service a
// launcher before 0.13.6 brought up hands them on to every session it starts, which isn't a test session.
// SESSIONS_REGISTRY_DIR (the seventh, Claude's registry of running sessions) is a location too. The hash is FNV-1a of
// the values, one per line
export function storeNamespace(values: readonly (string | undefined)[]): string {
  if (!values.slice(0, 4).some(v => v) && !values[6]) return ''
  // A seventh value that isn't set leaves the hash as it was with six
  const hashed = values.length > 6 && !values[6] ? values.slice(0, 6) : values
  return `@${fnv1a(hashed.map(v => v ?? '').join('\n')).toString(16).padStart(8, '0')}/`
}

// FNV-1a (32 bits) of a text's UTF-8 bytes, from a starting basis (FNV's own by default)
export function fnv1a(text: string, basis = 0x811c9dc5): number {
  let h = basis >>> 0
  for (const c of new TextEncoder().encode(text)) h = Math.imul(h ^ c, 0x01000193) >>> 0
  return h
}

// Whether two values hold the same data, as JSON would write them: objects by their keys in any order (a key holding
// undefined is no key), arrays in order. The engine redraws every reader of a $.state value on every write, equal or
// not, so the mod writes one only when this says it changed
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const other = b as unknown[]
    return a.length === other.length && a.every((x, i) => sameData(x, other[i]))
  }
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = Object.keys(x).filter(k => x[k] !== undefined)
  return keys.length === Object.keys(y).filter(k => y[k] !== undefined).length && keys.every(k => sameData(x[k], y[k]))
}

// When a row's time (timeSince at labelMinute) or its ⧗ next changes after now: the next minute for a row under an
// hour old, the next whole hour of its age under a day, the next whole day after that; the minute a row turns stale
// (staleFrom). Infinity when nothing will (no row has a time). The panel's one timer while nothing happens is set there
export function nextLabelChange(rows: readonly { since?: number; staleFrom?: number }[], now: number): number {
  const minute = labelMinute(now)
  let next = Infinity
  const atMinute = (t: number) => Math.ceil(t / 60000) * 60000
  for (const r of rows) {
    if (r.since !== undefined && r.since > 0) {
      const age = Math.max(0, minute - r.since)
      const step = age < 3600000 ? 60000 : age < 86400000 ? 3600000 : 86400000
      next = Math.min(next, atMinute(r.since + (Math.floor(age / step) + 1) * step))
    }
    if (r.staleFrom !== undefined && r.staleFrom > minute) next = Math.min(next, atMinute(r.staleFrom))
  }
  return next <= minute ? minute + 60000 : next
}

// The moment the rows' times (3m, 2h) and ⧗ are reckoned at: now, down to the minute. Every row's label then changes
// on the same minute, so the list is rewritten (and the panel redrawn) for them at most once a minute, however many
// rows it has
export function labelMinute(now: number): number {
  return Math.floor(now / 60000) * 60000
}

// The session list (claude agents --json --all) is made of Claude's registry of running sessions
// (~/.claude/sessions/<pid>.json, which Claude rewrites in place when a session's status, name or id changes, and
// removes when it ends), the background service's job folders (one per background session, running or stopped) and
// the service's own list. listSignature sums up the first two as `fs.list` shows them, with no command: a stored list
// read under the same signature still holds, since nothing it's made of moved. A session that crashed keeps its
// registry file until a listing sweeps it, so a list holds that way for LIST_QUIET_MS at most. null when the registry
// isn't what this expects (no <pid>.json at all, or none for this very session's process): the list then goes by its
// age alone
export type ListedFile = { name: string; mtimeMs: number; size: number }
export function listSignature(registry: readonly ListedFile[], jobs: readonly { name: string }[], myPid: number): string | null {
  const files = registry.filter(f => /^\d+\.json$/.test(f.name))
  if (files.length === 0 || (myPid > 0 && !files.some(f => f.name === `${myPid}.json`))) return null
  const text = [...files.map(f => `${f.name}:${f.mtimeMs}:${f.size}`).sort(), '|', ...jobs.map(j => j.name).sort()].join('\n')
  return `${files.length}.${fnv1a(text).toString(16)}.${fnv1a(text, 0x050c5d1f).toString(16)}`
}

// Whether the stored session list (`list` in the store: at, when the listing came back; sig, the signature it was read
// under; until, when a slow listing pushed the next one back) serves a caller, or the list is read again. A caller
// asking for one at most maxAge old below the panel's own pace (LIST_MS) gets exactly that. At that pace or slower:
// none before `until`; the stored one while nothing it's made of moved (the same signature), for LIST_QUIET_MS (or
// maxAge, if longer); once something moved, a new one, but not twice within LIST_MIN_MS; and with no signature to go
// by (a list stored without one, or a registry that can't be read), by age
export const LIST_MS = 3500
export const LIST_QUIET_MS = 30000
export const LIST_MIN_MS = 1000
export function listHolds(c: { at: number; sig?: unknown; until?: unknown } | null, now: number, maxAge: number, sig: string | null): boolean {
  if (!c) return false
  if (maxAge < LIST_MS) return now - c.at < maxAge
  if (typeof c.until === 'number' && now < c.until) return true
  if (sig !== null && typeof c.sig === 'string') return now - c.at < (c.sig === sig ? Math.max(maxAge, LIST_QUIET_MS) : LIST_MIN_MS)
  return now - c.at < maxAge
}

// The seen check's pace in a session whose last answer nobody saw (its row yellow), and only while one of its windows
// (or an agent view) is open: the first check right after the finish, then every 2 s for a minute (the person is
// likely about to look), every 10 s up to 10 minutes, then every 30 s. Typing in the session, a key in its panel or
// arriving there (Enter in another panel, or ccc) marks it seen at once, with no check. When the next check is due,
// after one at lastCheck
export function nextSeenCheck(finished: number, lastCheck: number): number {
  if (lastCheck < finished) return finished
  const age = lastCheck - finished
  return lastCheck + (age < 60000 ? 2000 : age < 600000 ? 10000 : 30000)
}

// The sessions a window's text shows by their tag (⟨short id⟩, as each session's band ends): an agent view's, for the
// seen check, which shares what it read as these and not the whole text
export function sessionTags(text: string): string[] {
  return [...new Set([...text.matchAll(/⟨([0-9A-Za-z_-]{1,64})⟩/g)].map(m => m[1]!))]
}

// How many of the panel's items don't fit: each item's lines in drawing order (a section title doesn't count, a session
// row or a folded section does), the rows the panel has, and the lines drawn above the list
export function rowsBelow(items: readonly { lines: number; counts: boolean }[], room: number, above: number): number {
  let used = above
  let hidden = 0
  for (const it of items) {
    used += it.lines
    if (used > room && it.counts) hidden++
  }
  return hidden
}

// A timer tick of a session's list-reading jobs: a gap since the last tick longer than gapMs is a sleep (every session's
// timers fire at once after one), and the jobs keep quiet until this session's stagger has passed
export function afterTick(t: { last: number; quietUntil: number }, now: number, stagger: number, gapMs = 30000): { last: number; quietUntil: number; quiet: boolean } {
  const quietUntil = t.last > 0 && now - t.last > gapMs ? now + stagger : t.quietUntil
  return { last: now, quietUntil, quiet: now < quietUntil }
}

// How long a session waits after a sleep before reading the session list again (0 to span-1 ms): its own share of the
// span, from its id (FNV-1a), so the sessions that wake together list one after another
export function wakeStagger(id: string, span = 10000): number {
  return span > 0 ? fnv1a(id) % span : 0
}

// The first version of the mod that writes heartbeats: sessions started after this version was installed are
// expected to have one
export const HEARTBEAT_VERSION = '0.10.0'

// What each session's mod writes to the shared store under `state:<sessionId>`.
// created: when the session's mod first started; turnStarted: when the current turn started; finished: when the last
// turn finished; reason: why it finished; answer: last line of the answer; question: whether that line ends in "?";
// model: short model name; context: % of the context used; version: the Claude version the session runs; agent: the
// agent it runs as (`claude --agent`), null for none; root: the project root its panel uses; usd: what it has cost so
// far at list price (as /cost says); limits: the account's rate-limit windows its last response reported (empty off a
// subscription); spendAlert: it's spending far above its own usual hour (SpendAlert), while it lasts; usualHour: its
// own usual hour at list price once it has one (usualHour), which the project's newer sessions are judged by
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
  spendAlert?: SpendAlert
  usualHour?: number
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
export function windowLabel(kind: string): string {
  return kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'limit' : kind.replace(/_/g, ' ')
}
export function limitsText(limits: readonly RateLimit[]): string {
  return limits.map(l => `${windowLabel(l.kind)} ${Math.round(l.percent)}%`).join(' · ')
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

// Why $.ui.ask rejected: the person dismissed the dialog (Esc, "Chat about this": "$.ui.ask: no answer (…)"), or it was
// never shown, as in a session whose agent leaves AskUserQuestion out of its tools ("$.tool.call: no tool named
// "AskUserQuestion" in this session") or a run with nobody to ask. Anything that isn't the dismissal counts as unshown
export function askRejection(err: unknown): 'dismissed' | 'unshown' {
  const text = err instanceof Error ? err.message : String(err ?? '')
  return /\bno answer\b/.test(text) ? 'dismissed' : 'unshown'
}

// The answer notice's action when the asked session couldn't show the question: the session that asked asks in its
// own window instead
export const UNSHOWN = 'unshown'

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
// focus: you arrived here from the panel with its keyboard (Enter); seen: you arrived here from the panel without it
// (a click on the row), so what this session answered is seen and the keyboard stays where it is; ask: ask here
// whether to stop or restart this session (from: who asks, topic, detail, and the asker's id, title and background, to
// go back to it when the panel there doesn't show it); answer: the answer to that (sessionId: who answers, action:
// stop, stop-rm, restart, cancel, or unshown when the question couldn't be shown there and the asker asks in its own
// window; cameBack: whether the window came back; a session that can't send notices leaves the same in the store,
// answer:<asker's id>); rename: rename yourself (name). The receiver consumes every notice with the marker (none
// reaches the model) and acts only on its own format. Senders only send to sessions whose heartbeat says they run the
// same format. A new kind needs no new format: a receiver consumes a kind it doesn't know and does nothing with it
// (every version on format 3 does), so a session on an older version only misses what the new kind does (seen: its row
// stays yellow until it's seen another way)
export const NOTICE_MARKER = 'sessions-notice:7f3a'
export type NoticeKind = 'focus' | 'seen' | 'ask' | 'answer' | 'rename'
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

// usage.py's answer (what it prints, or the summary it leaves in <data>/usage/summary.json for the other sessions) as
// the panel keeps it: the totals, in this format, without `generated` (the moment it ran, which differs on every run
// and would redraw the panel every minute with nothing new). null for anything else
export function usageSummaryOf(d: any): UsageSummary | null {
  if (!d || typeof d !== 'object' || d.format !== FORMAT || typeof d.today !== 'string' || typeof d.hour !== 'string') return null
  if (!d.days || typeof d.days !== 'object' || !d.hours || typeof d.hours !== 'object') return null
  return { today: d.today, hour: d.hour, days: d.days, hours: d.hours }
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

// A folder inside a worktree under <x>/.claude/worktrees/<name> (at any depth, the outermost such folder) belongs to
// <x>'s project: the walk starts from <x>, so a worktree's own copy of AGENTS.md or CLAUDE.md doesn't make it a
// project of its own. Any other folder starts from itself
export function worktreeBase(start: string): string {
  const i = start.indexOf('/.claude/worktrees/')
  return i > 0 ? start.slice(0, i) : start
}

// The project root: the nearest folder upwards with AGENTS.md or CLAUDE.md (the folders that have one, outermost
// first), skipping the top two levels (/, /Users); if there's none, where the session started. A worktree under
// <x>/.claude/worktrees/ walks from <x> (worktreeBase). The launcher walks up from its folder the same way
export function rootFrom(start: string, markerDirs: readonly string[]): string {
  const base = worktreeBase(start)
  const dirs = markerDirs.filter(d => d.split('/').filter(Boolean).length > 2 && (base === d || base.startsWith(`${d}/`)))
  return dirs[dirs.length - 1] ?? base
}

// The folders rootFrom can pick for a start folder, outermost first: each one above it below the top two levels, and
// the folder itself
export function rootCandidates(start: string): string[] {
  const parts = start.split('/').filter(Boolean)
  const out: string[] = []
  for (let n = 3; n <= parts.length; n++) out.push(`/${parts.slice(0, n).join('/')}`)
  return out
}

// The project a session belongs to is the one it started in, wherever it goes afterwards: a worktree inside or outside
// the project, of its repository or of another one, a folder /cd took it to. Claude lists it where it is now (its
// registry file and `claude agents` follow a worktree move and /cd), so that folder alone would take it out of its
// project's list. The folder that says which project, from the best source there is:
// - recorded: the project root its own mod recorded at its first start, from the folder it started in, and kept across
//   restarts, /clear and /resume (the store's project:<sessionId>), published as its heartbeat's root (Heartbeat);
// - first: the cwd of the first row of its transcript that has one (where it started: the rows after a move carry the
//   new folder, and the file itself moves, but the first row stays), for a session whose mod doesn't run (stopped, or
//   an older mod);
// - cwd: the folder Claude lists it in now, the last resort.
// inProject takes any of them, a project root or a folder in it. hooks/launcher.py (session_home) and hooks/usage.py
// (home_of) go by the same rule
export type Whereabouts = { recorded?: string | null; first?: string | null; cwd?: unknown }
export function sessionHome(w: Whereabouts): string {
  for (const f of [w.recorded, w.first, w.cwd]) if (typeof f === 'string' && f.startsWith('/')) return f
  return ''
}

export function belongsTo(w: Whereabouts, root: string, home: string): boolean {
  const folder = sessionHome(w)
  return folder !== '' && inProject(folder, root, home)
}

// The first cwd of each session's transcript, from the command that looks for them (`<sessionId>\t<its first row with
// a "cwd">` per line, the row cut at 64 KiB): the row read as JSON, or its cwd field alone when it was cut
export function parseTranscriptStarts(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const id = line.slice(0, tab)
    const row = line.slice(tab + 1)
    let cwd: unknown
    try {
      cwd = JSON.parse(row)?.cwd
    } catch {
      const m = row.match(/"cwd":"((?:[^"\\]|\\.)*)"/)
      try {
        cwd = m ? JSON.parse(`"${m[1]}"`) : undefined
      } catch {}
    }
    if (typeof cwd === 'string' && cwd.startsWith('/')) out[id] = cwd
  }
  return out
}

// The session's own panel says so when it works outside its project (a worktree outside it, a folder /cd took it to):
// "Working in ~/x/wt, outside this project", the folder cut from its start to fit width. Nothing inside the project
// (a subfolder, a worktree under <project>/.claude/worktrees/)
export function outsideNote(here: string, root: string, home: string, width = Infinity): string {
  if (!here || !root || inProject(here, root, home)) return ''
  const before = 'Working in '
  const after = ', outside this project'
  const folder = Array.from(tildePath(here, home))
  const room = Math.max(8, width - before.length - after.length)
  const shown = folder.length <= room ? folder.join('') : `…${folder.slice(folder.length - room + 1).join('')}`
  return `${before}${shown}${after}`
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

// The sessions other plugins asked to keep pinned ($.sessions.pin), stored under `pluginPins`: ids, the ones wanted
// pinned; added, the ones whose pin a plugin's call (or Remote Control's automatic pin it kept) put in pins.json, the
// only ones a plugin's unpin takes out. A pin that was already there (the person's own) is wanted but never added
export type PluginPins = { ids: string[]; added: string[] }

export function emptyPluginPins(): PluginPins {
  return { ids: [], added: [] }
}

// A stored record as it is, or an empty one for a missing or broken value
export function pluginPinsOf(value: unknown): PluginPins {
  const v = value as Partial<PluginPins> | null | undefined
  const ids = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
  return { ids: ids(v?.ids), added: ids(v?.added) }
}

// A plugin's pin or unpin of one session, on pins.json as it is: what to write and the record after it. auto: the ids
// Remote Control's automatic pin put there (its own to take out). Pin: a session not pinned is pinned and counts as
// added; one already pinned stays as it is (the person's, or Remote Control's, which stays theirs). Unpin: only a pin a
// plugin added goes, and not while Remote Control's automatic pin holds it; one the person pinned is refused
export function pluginPinChange(
  pins: readonly string[],
  plugin: PluginPins,
  auto: readonly string[],
  id: string,
  pinned: boolean,
): { pins: string[]; plugin: PluginPins; changed: boolean; refused?: string } {
  const ids = new Set(plugin.ids)
  const added = new Set(plugin.added)
  const now = new Set(pins)
  if (pinned) {
    ids.add(id)
    if (now.has(id)) return { pins: [...pins], plugin: { ids: [...ids], added: [...added] }, changed: false }
    added.add(id)
    return { pins: [...pins, id], plugin: { ids: [...ids], added: [...added] }, changed: true }
  }
  const wanted = ids.delete(id)
  const ours = added.delete(id)
  const record = { ids: [...ids], added: [...added] }
  if (!now.has(id)) return { pins: [...pins], plugin: record, changed: false }
  if (auto.includes(id)) return { pins: [...pins], plugin: record, changed: false }
  if (!ours) return { pins: [...pins], plugin: record, changed: false, refused: wanted ? 'it was pinned before a plugin asked: it stays pinned' : 'it was pinned by the person, not by a plugin: it stays pinned' }
  return { pins: pins.filter(p => p !== id), plugin: record, changed: true }
}

// After reconcilePins (Remote Control's automatic pins): a session a plugin keeps pinned isn't unpinned when its Remote
// Control goes off, and the pin becomes the plugin's to take out (added). A session gone from the list leaves the
// record, and its pin goes too when a plugin added it. listed: the background sessions the list has
export function keepPluginPins(
  r: { pins: string[]; toUnpin: string[] },
  plugin: PluginPins,
  listed: ReadonlySet<string>,
): { pins: string[]; toUnpin: string[]; plugin: PluginPins } {
  const ids = new Set(plugin.ids)
  const added = new Set(plugin.added)
  const toUnpin = r.toUnpin.filter(id => !ids.has(id) || !listed.has(id))
  const kept = r.toUnpin.filter(id => ids.has(id) && listed.has(id))
  for (const id of kept) added.add(id)
  const pins = [...r.pins, ...kept.filter(id => !r.pins.includes(id))]
  for (const id of [...ids, ...added]) {
    if (listed.has(id)) continue
    if (added.has(id) && pins.includes(id) && !toUnpin.includes(id)) toUnpin.push(id)
    ids.delete(id)
    added.delete(id)
  }
  return { pins: pins.filter(id => !toUnpin.includes(id)), toUnpin, plugin: { ids: [...ids], added: [...added] } }
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
// ending ("settled <id> (done)"). A process that ends with no retire before it: `settled <id> (killed)` was killed by
// a claude stop (the person's: the panel's s, or typed; a respawn's kill is followed by its claimed-spare, which clears
// it); any other end, `(done)` or `(crashed)`, ended by itself. Starting again ("claimed-spare" or "spawned") clears the
// record and is kept as the session's last start. A machine that restarted, or a service that went down with its
// workers, leaves no line for each session: the service's next start says how many it found dead ("adopt: … dead=3"),
// and those times are kept as deaths
export type StopReason = { at: number; why: 'idle' | 'low-memory' | 'stopped' | 'ended' }
export type StopLog = { reasons: Record<string, StopReason>; started: Record<string, number>; deaths: number[] }
export function stopLog(log: string): StopLog {
  const reasons: Record<string, StopReason> = {}
  const started: Record<string, number> = {}
  const deaths: number[] = []
  for (const line of log.split('\n')) {
    const adopt = line.match(/^\[([^\]]+)\] \[bg\] bg adopt: .*\bdead=(\d+)/)
    if (adopt) {
      if (Number(adopt[2]) > 0) deaths.push(Date.parse(adopt[1] ?? '') || 0)
      continue
    }
    const m = line.match(/^\[([^\]]+)\] \[bg\] bg (retire|settled|claimed-spare|spawned) ([0-9a-f]{8})\b(.*)$/)
    if (!m) continue
    const [, when = '', event, id = '', rest = ''] = m
    const at = Date.parse(when) || 0
    if (event === 'retire') reasons[id] = { at, why: /\[low memory/.test(rest) ? 'low-memory' : 'idle' }
    else if (event === 'settled') reasons[id] ??= { at, why: /^\s*\(killed\)/.test(rest) ? 'stopped' : 'ended' }
    else {
      delete reasons[id]
      started[id] = at
    }
  }
  return { reasons, started, deaths }
}
export function stopReasons(log: string): Record<string, StopReason> {
  return stopLog(log).reasons
}

// Why a background session with no process is stopped ($.sessions' SessionsStopped): the service retired it for being
// idle, or closed it for lack of memory; the person stopped it (a claude stop the log shows, or one this mod remembers,
// personAt, unless the session ran again after it: lastRun, its last start in the log or its mod's last heartbeat); it
// ended by itself, on positive evidence only: the log says its process ended (a crash), or the service found workers
// dead (a machine or service restart) after the session last ran. With no evidence either way, unknown: a plugin's
// wake leaves it stopped, as one the person stopped (fail closed: the log's lines roll out, or it can't be read)
export function stoppedKind(reason: StopReason | undefined, personAt: unknown, lastRun: number | undefined, deaths: readonly number[]): 'person' | 'idle' | 'memory' | 'ended' | 'unknown' {
  if (reason?.why === 'idle') return 'idle'
  if (reason?.why === 'low-memory') return 'memory'
  if (reason?.why === 'stopped') return 'person'
  if (typeof personAt === 'number' && !(typeof lastRun === 'number' && lastRun > personAt)) return 'person'
  if (reason?.why === 'ended') return 'ended'
  if (typeof lastRun === 'number' && lastRun > 0 && deaths.some(t => t >= lastRun)) return 'ended'
  return 'unknown'
}

// When the background service goes down with its sessions (a machine that restarted, a service killed or crashed),
// each session it ran stops with it, and nothing starts them again until the person opens each one. A stopped
// background session ended with the service when it reads as ended by itself (stoppedKind) on the service's death
// alone: no line of its own after it last ran (a crash's `settled <id> (done)` is a stop of its own), the person didn't
// stop it, and the service's log found workers dead at or after it last ran. When: the first such death (the service's
// next start, which is when the log says so). undefined: not one of those
export function diedWithService(reason: StopReason | undefined, personAt: unknown, lastRun: number | undefined, deaths: readonly number[]): number | undefined {
  if (reason || typeof lastRun !== 'number' || stoppedKind(reason, personAt, lastRun, deaths) !== 'ended') return undefined
  const after = deaths.filter(t => t >= lastRun)
  return after.length ? Math.min(...after) : undefined
}

// A session that ended with the background service, for the panel's line and its question (at: diedWithService)
export type EndedSession = { sessionId: string; id: string; name: string; cwd: string; at: number }

// The ones the panel's line counts: those that ended after the death the person dismissed the line for (dismissed: that
// death's time, the store's endedDismissed), so a dismissal holds for that death only and the next one shows again
export function endedShown(ended: readonly EndedSession[], dismissed: unknown): EndedSession[] {
  const before = typeof dismissed === 'number' && Number.isFinite(dismissed) ? dismissed : 0
  return ended.filter(s => s.at > before)
}

// A time of day, local: "14:05", with its day when it isn't today's ("14:05 on Oct 30")
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function clockText(at: Date, now: Date): string {
  const two = (x: number) => String(x).padStart(2, '0')
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`
  return dayOf(at) === dayOf(now) ? time : `${time} on ${MONTHS[at.getMonth()]} ${at.getDate()}`
}

// The panel's line about them: "3 sessions ended with the background service at 14:05", at the latest death's time
// (several deaths are rare: the latest is the one the person would remember); action: what the key does, said after it
export function endedText(ended: readonly EndedSession[], now: number): { text: string; action: string; at: number } | null {
  if (ended.length === 0) return null
  const at = Math.max(...ended.map(s => s.at))
  const count = ended.length === 1 ? '1 session' : `${ended.length} sessions`
  return { text: `${count} ended with the background service at ${clockText(new Date(at), new Date(now))}`, action: ended.length === 1 ? 'brings it back' : 'brings them back', at }
}

// A folder as the person writes it, with the home folder as ~
export function tildePath(path: string, home: string): string {
  if (home && home !== '/' && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`
  return path
}

// Where they were, for the question: "2 in ~/x/app, 1 in ~/x/site", the folder with the most first, three folders at
// most and then how many in how many others
export function endedFolders(ended: readonly EndedSession[], home: string): string {
  const by = new Map<string, number>()
  for (const s of ended) by.set(s.cwd, (by.get(s.cwd) ?? 0) + 1)
  const folders = [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const shown = folders.slice(0, folders.length > 4 ? 3 : 4).map(([cwd, n]) => `${n} in ${tildePath(cwd, home)}`)
  const rest = folders.slice(shown.length)
  if (rest.length) shown.push(`${rest.reduce((sum, [, n]) => sum + n, 0)} in ${rest.length} other folders`)
  return shown.join(', ')
}

// The question the key asks, and its answers: bring them back, leave them stopped (the line goes until the service ends
// sessions again: the dismissal), or nothing (Cancel, Esc or typed text)
export function bringBackOptions(count: number): { bring: string; leave: string; options: string[] } {
  const them = count === 1 ? 'it' : 'them'
  const bring = `Bring ${them} back`
  const leave = `Leave ${them} stopped`
  return { bring, leave, options: [bring, leave, 'Cancel'] }
}
export function bringBackQuestion(ended: readonly EndedSession[], now: number, home: string): string {
  if (ended.length === 0) return ''
  const when = clockText(new Date(Math.max(...ended.map(s => s.at))), new Date(now))
  const { leave } = bringBackOptions(ended.length)
  if (ended.length === 1) {
    return `Bring back the session that ended with the background service at ${when} (in ${tildePath(ended[0]?.cwd ?? '', home)})? It restarts with its conversation. ${leave} hides this line until the service ends sessions again.`
  }
  return `Bring back the ${ended.length} sessions that ended with the background service at ${when} (${endedFolders(ended, home)})? Each one restarts with its conversation, one at a time. ${leave} hides this line until the service ends sessions again.`
}

// What the key did, as its toast says
export function bringBackResult(done: number, skipped: number, failed: number): string {
  return `Brought back ${done === 1 ? '1 session' : `${done} sessions`}, skipped ${skipped}, failed ${failed}`
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

// Which terminal windows show each session, from `ps -A -o pid= -o tty= -o command=` (same columns on macOS and Linux; a
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
export function parseWindows(ps: string, clientCommand: (command: string) => string = c => c): Windows {
  const v: Windows = { byId: {}, byPid: {}, agentsViews: [], clients: {}, launchers: {} }
  for (const line of ps.split('\n')) {
    const [pid, tty, ...rest] = line.trim().split(/\s+/)
    if (!pid || !tty || tty === '??' || tty === '?' || tty === '-') continue
    const command = clientCommand(rest.join(' '))
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

// One word for a POSIX shell (bash, zsh; fish reads it the same way): in single quotes, where nothing expands ($, `,
// !), with each ' written as '\''
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`
}

// A path as one file name: the order file of a project, the window file of a terminal
export function fileKey(path: string): string {
  return path.replace(/\//g, '_')
}

// The heartbeat: <data>/alive/<sessionId>, rewritten by the session's own mod every 15 s while it runs. It's how the
// launcher and the other panels tell a session whose mod is running from one whose mod never started (a pre-started
// process that was claimed with stale state, for one). pid: the session's process as the official list shows it;
// via: what started the mod (session.start, or the first draw, turn or prompt when that didn't come); root: the project
// the session belongs to (sessionHome's recorded: where it started, whatever folder it's in now; 0.15.0, absent from
// older mods, whose readers ignore it)
export type Heartbeat = { format: number; pid: number; at: number; version: string; via: string; root: string }
export function heartbeatText(h: Omit<Heartbeat, 'format' | 'root'> & { root?: string }): string {
  return keyLines({ format: FORMAT, pid: h.pid || '', at: h.at, version: h.version, via: h.via, root: h.root || undefined })
}

export function parseHeartbeat(text: string): Heartbeat | null {
  const k = parseKeyLines(text)
  const at = Number(k.at)
  if (!k.format || !Number.isFinite(at) || at <= 0) return null
  return { format: Number(k.format) || 0, pid: Number(k.pid) || 0, at, version: k.version ?? '', via: k.via ?? '', root: k.root ?? '' }
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

// The leader's prune removes the order file of a project whose folder is gone (a test folder or a worktree deleted).
// Only one no panel rewrote for ORDER_ORPHAN_MS (a project's panels rewrite theirs at least once a pass, so a folder
// being made isn't raced), and only for the root the file names inside, which the file's name has to match (the name is
// the root as a file name, which two folders can share): the folder to look for, or null to leave the file alone
export const ORDER_ORPHAN_MS = 5 * 60000
export function orderOrphanRoot(name: string, mtimeMs: number, text: string, now: number): string | null {
  if (!(now - mtimeMs >= ORDER_ORPHAN_MS)) return null
  const root = parseKeyLines(text).root ?? ''
  return root.startsWith('/') && fileKey(root) === name ? root : null
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
// by renaming <id>.req to <id>.taken (<id>.held while it's held), and renames a taken one whose turn never came (the
// session restarted first) back to <id>.req
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
// agent view in a folder; the title is shown while it opens (and is the window's title outside macOS). end: the
// window's watcher (launcher.py watch) ends the viewer it shows now, at once, so the launcher opens this one; written
// last, so a file read before it's whole doesn't ask it. Only for a window whose launcher publishes what it shows
// (Showing): any other file is opened once the viewer ends by itself, or once the panel or ccc closed it
export type WindowTarget = { command: 'attach'; id: string; title: string; end?: true } | { command: 'agents'; title: string; folder: string }
export function windowTargetText(t: WindowTarget): string {
  return t.command === 'attach'
    ? keyLines({ format: FORMAT, command: 'attach', id: t.id, title: t.title, end: t.end ? 1 : undefined })
    : keyLines({ format: FORMAT, command: 'agents', title: t.title, folder: t.folder })
}

// What a window opened with ccc shows: <data>/windows/<tty as a file name>.showing, written by its launcher
// (hooks/visor.sh) as each viewer starts there and removed when the launcher ends. Its terminal, what it shows (a
// session by its short id, or the agent view: id empty), and three processes: the viewer, the launcher (bash
// visor.sh) and its watcher (launcher.py watch), which ends the viewer when the window's file asks for it (end=1). A
// window with none (not opened with ccc) is found with ps, and the panel closes its viewer itself. Whole only once it
// ends with a line break
export const SHOWING = '.showing'
export type Showing = { tty: string; command: 'attach' | 'agents'; id: string; viewer: string; launcher: string; watcher: string }
export function showingText(s: Showing): string {
  return keyLines({ format: FORMAT, tty: s.tty, command: s.command, id: s.id, viewer: s.viewer, launcher: s.launcher, watcher: s.watcher })
}
export function parseShowing(text: string): Showing | null {
  if (!text.endsWith('\n')) return null
  const k = parseKeyLines(text)
  const pid = (v: string | undefined) => (v && /^\d+$/.test(v) ? v : '')
  const [viewer, launcher, watcher] = [pid(k.viewer), pid(k.launcher), pid(k.watcher)]
  if (k.format !== String(FORMAT) || !k.tty?.startsWith('/dev/') || !viewer || !launcher || !watcher) return null
  if (k.command === 'attach' && /^[0-9a-f]{8}$/.test(k.id ?? '')) return { tty: k.tty, command: 'attach', id: k.id ?? '', viewer, launcher, watcher }
  return k.command === 'agents' ? { tty: k.tty, command: 'agents', id: '', viewer, launcher, watcher } : null
}

// Whether a window's launcher and its watcher still run as its .showing says, from `ps -p <launcher>,<watcher> -o pid=
// -o tty= -o command=`: both there, on that terminal, running those programs. A file a launcher left behind (killed, the
// window gone with it, the computer restarted) names processes that are gone, or other processes that took those
// numbers since, and doesn't pass
export function showingRuns(s: Showing, ps: string): boolean {
  let launcher = false
  let watcher = false
  for (const line of ps.split('\n')) {
    const [pid, tty, ...rest] = line.trim().split(/\s+/)
    if (!pid || `/dev/${tty}` !== s.tty) continue
    const command = rest.join(' ')
    if (pid === s.launcher && /^(\S*\/)?bash \S*\/visor\.sh( |$)/.test(command)) launcher = true
    if (pid === s.watcher && /\S*\/launcher\.py watch( |$)/.test(command)) watcher = true
  }
  return launcher && watcher
}

// A switch from this session's panel by what the launcher windows publish, with no ps and no question to the terminal
// (jump in register.tsx): 'switch' the one launcher window showing this session (its watcher ends the viewer there),
// or 'bring' forward one that shows the target. null, the usual way (ps, and on macOS the window in front), whenever
// that isn't certain: no launcher window shows this session, or several do; an agent view is open, in a launcher
// window or in any window the last listing saw (it may show the target, which only the usual way reads); or the last
// windows listing any session took (listed: the store's windowsList, of any age) has a viewer of this session or of
// the target in a window that publishes nothing (one not opened with ccc, or opened with an older launcher)
export type SwitchPlan = { kind: 'switch'; from: Showing } | { kind: 'bring'; from: Showing; to: Showing }
export function planSwitch(shown: Showing[], me: string, target: string, listed: Windows | null): SwitchPlan | null {
  if (shown.some(s => s.command === 'agents')) return null
  const mine = shown.filter(s => s.id === me)
  const from = mine[0]
  if (!from || mine.length > 1) return null
  const published = new Set(shown.map(s => s.tty))
  const elsewhere = (ttys: string[] | undefined) => (ttys ?? []).some(t => !published.has(t))
  if (listed && (elsewhere(listed.agentsViews.map(a => a.tty)) || elsewhere(listed.byId[me]) || elsewhere(listed.byId[target]))) return null
  const to = shown.find(s => s.id === target && s.tty !== from.tty)
  return to ? { kind: 'bring', from, to } : { kind: 'switch', from }
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
// you, no background task), and no New or Rename field open in its panel (what you typed would go). A panel that has
// the keyboard doesn't hold it back: the new copy gives the keyboard back, on the same row. 'wait' means try again
// later; 'no', not for this version
export type ReloadCheck = {
  running: string
  runningDir: string
  installed: InstalledPlugin | null
  triedFor: string
  status: string | null | undefined
  tasks: number | null
  fieldOpen: boolean
  // The set of paths this copy watches (WATCH_SET in watch.ts) and the installed copy's (0: one from before the set had
  // a number). Left out, not compared
  watchSet?: number
  installedWatchSet?: number
}
export function reloadDecision(c: ReloadCheck): 'reload' | 'wait' | 'no' {
  const v = c.installed
  if (!v || !parseVersion(v.version) || !parseVersion(c.running) || compareVersions(v.version, c.running) <= 0) return 'no'
  // A reload raises no SessionStart, so the engine keeps watching what this copy asked for: never into a copy that
  // watches another set of paths (its new ones would go unwatched until the session restarts)
  if (c.watchSet !== undefined && c.installedWatchSet !== undefined && c.watchSet !== c.installedWatchSet) return 'no'
  const parent = (dir: string) => dir.replace(/\/+$/, '').replace(/\/[^/]+$/, '')
  if (!v.path || parent(v.path) !== parent(c.runningDir) || v.path === c.runningDir) return 'no'
  if (c.triedFor === v.version) return 'no'
  if (c.status !== 'idle' || c.tasks !== 0 || c.fieldOpen) return 'wait'
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

// The agent a background session runs as, from its job record's respawnFlags (the flags its restarts replay:
// `--agent <name>` or `--agent=<name>`, checked on 2.1.319): null when they name none. The text after a flag that takes
// any text (a name, settings, a prompt) is never read as a flag
const FLAGS_WITH_TEXT = new Set(['-n', '--name', '--settings', '--agents', '--system-prompt', '--append-system-prompt'])
export function agentFromFlags(flags: readonly unknown[]): string | null {
  for (let i = 0; i < flags.length; i++) {
    const f = String(flags[i])
    if (f === '--agent') {
      const v = flags[i + 1]
      return typeof v === 'string' && v ? v : null
    }
    if (f.startsWith('--agent=')) return f.slice('--agent='.length) || null
    if (FLAGS_WITH_TEXT.has(f)) i++
  }
  return null
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

// The person's sections with nobody in them go: they exist only while the person keeps sessions there. A plugin's go
// once they stay empty (emptyPluginSections, dropSections: the cleanup drops one that two of its passes found empty, so
// a section just defined, waiting for its first member, stays)
export function dropEmptyPersonSections(file: SectionsFile): SectionsFile {
  const used = new Set(Object.values(file.members).map((m: any) => m?.section))
  const sections = file.sections.filter(s => !(typeof s?.id === 'string' && s.id.startsWith('me:') && !used.has(s.id)))
  return sections.length === file.sections.length ? file : { ...file, sections }
}

export function emptyPluginSections(file: SectionsFile): string[] {
  const used = new Set(Object.values(file.members).map((m: any) => m?.section))
  return file.sections.filter(s => typeof s?.id === 'string' && !s.id.startsWith('me:') && !used.has(s.id)).map(s => String(s.id))
}

export function dropSections(file: SectionsFile, ids: readonly string[]): SectionsFile {
  if (ids.length === 0) return file
  const sections = file.sections.filter(s => !ids.includes(s?.id))
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
// itself makes no children (they're drawn as any other row). A parent that waits for the person (red, or marked as
// needing them) and sits in another section than the child's own (one a plugin moved it to while it asks, say) doesn't
// take the child along: the child isn't the one waiting, so it's drawn as any row of its own section. Each row learns
// its section ('' for none), that section's title and its depth
export function groupRows<T extends { ref: string; color: Color; title: string; needsPerson?: boolean }>(rows: readonly T[], view: SectionsView): (T & { section: string; sectionTitle: string; depth: number })[] {
  const byId = new Map(view.sections.map(s => [s.id, s]))
  const byRef = new Map(rows.map(r => [r.ref, r]))
  const sectionOf = (ref: string): string => {
    const m = view.members[ref]
    return m && byId.has(m.section) ? m.section : ''
  }
  const parentOf = (ref: string): string => {
    const p = view.members[ref]?.parent
    const parent = p && p !== ref ? byRef.get(p) : undefined
    if (!p || !parent) return ''
    const grand = view.members[p]?.parent
    if (grand && grand !== p && byRef.has(grand)) return ''
    const waits = parent.color === 'red' || parent.needsPerson === true
    return waits && sectionOf(p) !== sectionOf(ref) ? '' : p
  }
  const groups = new Map<string, T[]>()
  const children = new Map<string, T[]>()
  for (const r of rows) {
    const p = parentOf(r.ref)
    if (p) {
      children.set(p, [...(children.get(p) ?? []), r])
      continue
    }
    const id = sectionOf(r.ref)
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

// A row that breaks a limit is left out alone, with why (rejected, by ref): the call's other rows are set. What the
// whole call gets wrong (its source, ttlMs, rows that aren't an object or more than 200) refuses it
export function checkMarks(input: any): { ok: true; source: string; rows: Record<string, SessionsMark>; ttlMs: number; rejected: Record<string, string> } | (SessionsResult & { ok: false }) {
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
  const rejected: Record<string, string> = {}
  const problem = (ref: string, m: any): string => {
    if (!isRef(ref)) return "it isn't a ref (a short id or sid:<sessionId>)"
    if (!m || typeof m !== 'object') return 'a mark is an object'
    const badge = typeof m.badge === 'string' ? m.badge.trim() : m.badge
    if (badge !== undefined && (typeof badge !== 'string' || displayWidth(badge) > 3 || /\p{Cc}/u.test(badge))) return 'a badge is up to 3 columns'
    if (m.tint !== undefined && !TINTS.includes(m.tint)) return `a tint is one of ${TINTS.join(', ')}`
    const line = typeof m.line === 'string' ? m.line.trim().replace(/\s+/g, ' ') : m.line
    if (line !== undefined && (typeof line !== 'string' || Array.from(line).length > 60 || /\p{Cc}/u.test(line))) return 'a status line is up to 60 characters on one line'
    if (m.needsPerson !== undefined && typeof m.needsPerson !== 'boolean') return 'needsPerson is true or false'
    rows[ref] = { ...(badge ? { badge } : {}), ...(m.tint ? { tint: m.tint } : {}), ...(line ? { line } : {}), ...(m.needsPerson ? { needsPerson: true } : {}) }
    return ''
  }
  for (const [ref, m] of entries as [string, any][]) {
    const why = problem(ref, m)
    if (why) rejected[Array.from(ref).slice(0, 80).join('')] = why
  }
  return { ok: true, source: input.source, rows, ttlMs, rejected }
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

// Where the focus goes back to after what the arrows go through changed under it (ringKeys before and after): Claude
// keeps the focus's position, so when the focused row or fold line moved (one above it left) it's focused again, and
// when it left, the one next to it. undefined: nothing to do (it's where it was, or it isn't one of them)
export function refocusTarget(before: readonly string[], after: readonly string[], current: string | undefined): string | undefined {
  if (!current) return undefined
  const at = before.indexOf(current)
  if (at < 0 || after.indexOf(current) === at) return undefined
  return after.includes(current) ? current : remainingNeighbor([...before], current, [...after])
}

// What the arrows go through, in order: the rows (s:<sessionId>) and the folded sections' lines (h:<section>)
export function ringKeys(rows: readonly { sessionId: string; section: string; sectionTitle: string; color: Color; folded?: boolean }[]): string[] {
  return drawPlan(rows).flatMap(it => (it.kind === 'row' ? [`s:${it.row.sessionId}`] : it.kind === 'fold' ? [`h:${it.section}`] : []))
}

// ---- Telling the person ----
// The mod never stops anything for what follows: it marks rows, and notifies the person at most once for each thing
// (PushNotification, which reaches the phone with Remote Control, else $.ui.notify, their own channel), keeping to the
// plugin's options: quiet hours, and a cap a day for all of its notifications together

// Quiet hours, as written in the plugin's options: "22-7" or "22:30-07:00", local time, the end excluded; a span that
// ends before it starts runs past midnight. null: none ('' or not understood)
export type QuietHours = { from: number; to: number }
export function parseQuietHours(text: unknown): QuietHours | null {
  const m = String(text ?? '')
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/)
  if (!m) return null
  const minutes = (h: string | undefined, mm: string | undefined) => (Number(mm ?? 0) < 60 ? Number(h) * 60 + Number(mm ?? 0) : NaN)
  const from = minutes(m[1], m[2])
  const to = minutes(m[3], m[4])
  if (!(from < 1440) || !(to <= 1440) || from === to) return null
  return { from, to }
}

export function inQuietHours(q: QuietHours | null, at: Date): boolean {
  if (!q) return false
  const t = at.getHours() * 60 + at.getMinutes()
  return q.from < q.to ? t >= q.from && t < q.to : t >= q.from || t < q.to
}

// The local day, for the cap a day ("2026-11-02")
export function dayOf(at: Date): string {
  const two = (x: number) => String(x).padStart(2, '0')
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`
}

// How many notifications the mod sent today, from the store's pushCount ({ day, count }): another day's count is 0
export function sentToday(stored: unknown, day: string): number {
  const s = stored as { day?: unknown; count?: unknown } | null | undefined
  return s && s.day === day && Number.isFinite(Number(s.count)) ? Number(s.count) : 0
}

// A session of the project waiting for the person: red (its question or permission), or marked by another plugin as
// needing them. since: when a panel first saw it so (the store's waiting:<sessionId>, or needsSince:<sessionId>)
export type Wait = { sessionId: string; title: string; since: number }
// A session that can reach the phone (it has Remote Control) pushes as soon as a wait is due; the others give it this
// long more, so the push comes from one that can
export const PUSH_GRACE_MS = 60000
// The waits due a push: waiting at least the threshold (0: never), and not pushed for this wait yet (pushed: by
// sessionId, the since of the wait already pushed, by any session). first: this session goes first (see PUSH_GRACE_MS)
export function dueWaits(waits: readonly Wait[], pushed: Readonly<Record<string, number>>, now: number, threshold: number, first: boolean): Wait[] {
  if (!(threshold > 0)) return []
  return waits.filter(w => pushed[w.sessionId] !== w.since && now - w.since >= threshold + (first ? 0 : PUSH_GRACE_MS))
}

// 12 min, 3 h
export function howLong(ms: number): string {
  const min = Math.max(1, Math.floor(ms / 60000))
  return min < 120 ? `${min} min` : `${Math.floor(min / 60)} h`
}

// What the push says: the sessions' names only, never what they're doing (it can land on a locked phone)
export function waitText(waits: readonly Wait[], now: number): string {
  const sorted = [...waits].sort((a, b) => a.since - b.since)
  const oldest = sorted[0]
  if (!oldest) return ''
  const name = `“${Array.from(oldest.title).slice(0, 60).join('')}”`
  const others = sorted.length - 1
  if (others === 0) return `${name} has been waiting for you for ${howLong(now - oldest.since)}`
  return `${name} and ${others === 1 ? '1 other session' : `${others} other sessions`} are waiting for you, the longest for ${howLong(now - oldest.since)}`
}

// A session working (blue) for the threshold or longer, or a background one done and unseen (yellow) that long: the
// time on its row gets a dim ⧗. Nothing moves for it
export function isStale(r: { color: Color; background: boolean }, since: number | undefined, now: number, threshold: number): boolean {
  if (!(threshold > 0) || !since) return false
  if (r.color !== 'blue' && !(r.color === 'yellow' && r.background)) return false
  return now - since >= threshold
}

// What a session spends an hour, measured against its own usual hour (hours vary a lot between sessions, so a global
// threshold would be noise). Each session keeps its own ledger in the store, spend:<sessionId>: its cost at list price
// as /cost says (on a subscription too, where it's what its tokens would cost: a measure, not a bill) added up into a
// running total (a cost that went down, after a /clear or a restart, counts again from there), and samples of
// [when, total, the account's window %]: every 5 minutes for the last 70 minutes, and the first of each hour for the
// 25 hours before. kind: which window the % is (five_hour when there is one, else seven_day, else the first)
export type SpendLedger = { last: number; total: number; kind: string; samples: [number, number, number][] }
const SAMPLE_EVERY = 300000
export function addSpend(previous: unknown, usd: number | undefined, limits: readonly RateLimit[], now: number): { ledger: SpendLedger; sampled: boolean } {
  const p = previous as Partial<SpendLedger> | null | undefined
  const samples = Array.isArray(p?.samples) ? p.samples.filter(s => Array.isArray(s) && s.length === 3 && s.every(Number.isFinite)) : []
  const last = Number.isFinite(p?.last) ? Number(p?.last) : 0
  const total = Number.isFinite(p?.total) ? Number(p?.total) : 0
  const cost = Number.isFinite(usd) ? Number(usd) : last
  const window = limits.find(l => l.kind === 'five_hour') ?? limits.find(l => l.kind === 'seven_day') ?? limits[0]
  const kind = window?.kind ?? (typeof p?.kind === 'string' ? p.kind : '')
  const next = total + (cost >= last ? cost - last : cost)
  const newest = samples[samples.length - 1]
  const sampled = !newest || now - newest[0] >= SAMPLE_EVERY
  const all = sampled ? [...samples, [now, next, window?.percent ?? -1] as [number, number, number]] : samples
  // Thinned: everything from the last 70 minutes, the first sample of each hour before that, nothing past 25 hours
  const hours = new Set<number>()
  const kept = all.filter(([at]) => {
    if (now - at <= 4200000) return true
    if (now - at > 90000000) return false
    const hour = Math.floor(at / 3600000)
    if (hours.has(hour)) return false
    hours.add(hour)
    return true
  })
  return { ledger: { last: cost, total: next, kind, samples: kept }, sampled }
}

// The middle value (the mean of the two middle ones for an even count); null for none
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function sampleAt(l: SpendLedger, t: number): [number, number, number] | undefined {
  let found: [number, number, number] | undefined
  for (const s of l.samples) if (s[0] <= t) found = s
  return found
}

// A session's own usual hour: the median of its past active hours (it spent something) over the last day, before the
// last hour; null with fewer than three of them. Each session publishes it (SessionState.usualHour), for the others of
// its project
export function usualHour(l: SpendLedger, now: number): number | null {
  const active: number[] = []
  for (let k = 1; k <= 24; k++) {
    const a = sampleAt(l, now - k * 3600000)
    const b = sampleAt(l, now - (k + 1) * 3600000)
    if (!a || !b || a === b) continue
    if (a[1] - b[1] > 0.005) active.push(a[1] - b[1])
  }
  return active.length < 3 ? null : median(active)
}

// The last hour against the usual one: hour, what it spent in the last hour; usual, its own usual hour (usualHour), or
// until it has one, projectUsual, the median of the usual hours of its project's other sessions (basis says which), so
// a session that loops from its first hour is judged too; rise, how much the account's window rose in the last hour
// (null off a subscription, or when the window reset). null: not enough history to judge (an hour of its own, and a
// usual hour, its own or its project's)
export type SpendBurst = { hour: number; usual: number; rise: number | null; basis: 'own' | 'project' }
export function spendBurst(l: SpendLedger, now: number, projectUsual: number | null = null): SpendBurst | null {
  const hourAgo = sampleAt(l, now - 3600000)
  if (!hourAgo) return null
  const own = usualHour(l, now)
  const usual = own ?? (projectUsual !== null && projectUsual > 0 ? projectUsual : null)
  if (usual === null) return null
  const newest = l.samples[l.samples.length - 1]
  const rise = newest && newest[2] >= 0 && hourAgo[2] >= 0 && newest[2] >= hourAgo[2] ? newest[2] - hourAgo[2] : null
  return { hour: l.total - hourAgo[1], usual, rise, basis: own === null ? 'project' : 'own' }
}

// Far above its usual hour: at least SPEND_FACTOR times it, and at least SPEND_FLOOR_USD at list price (small sums
// aren't worth a word). Once marked, it stays so until it falls below half of both
export const SPEND_FACTOR = 4
export const SPEND_FLOOR_USD = 3
export function spendIsHigh(b: (Pick<SpendBurst, 'hour' | 'usual'> & Partial<SpendBurst>) | null, marked: boolean): boolean {
  if (!b) return false
  const k = marked ? 0.5 : 1
  return b.hour >= SPEND_FLOOR_USD * k && b.hour >= SPEND_FACTOR * b.usual * k
}

// What a session publishes while its spend runs high (SessionState.spendAlert): since when, the last hour and the usual
// one at list price, the window's rise (null off a subscription), its kind, whether the person was notified, and
// whether the usual hour is its own or its project's (basis, SpendBurst; absent: its own)
export type SpendAlert = { since: number; hour: number; usual: number; rise: number | null; kind: string; notified: boolean; basis?: 'own' | 'project' }
// The line under its row and the notification: dollars on an API account; on a subscription (where dollars aren't
// billed) how many times its usual hour, and how much the account's window rose meanwhile
function spendParts(a: SpendAlert): { times: string; window: string; usual: string } {
  return {
    times: a.usual > 0 ? `${Math.round(a.hour / a.usual)}×` : 'far above',
    window: a.rise !== null && a.kind ? `${windowLabel(a.kind)} +${Math.round(a.rise)}% this hour` : '',
    usual: a.basis === 'project' ? "the project's usual hour" : 'its usual hour',
  }
}
export function spendLine(a: SpendAlert, mode: 'subscription' | 'api' | 'unknown'): string {
  const p = spendParts(a)
  if (mode === 'subscription') return `spending ${p.times} ${p.usual}${p.window ? ` · ${p.window}` : ''}`
  // The project's, shorter: it fits under the row in the narrowest panel
  if (a.basis === 'project') return `${formatUsd(a.hour)} last hour · project's usual ${formatUsd(a.usual)}`
  return `${formatUsd(a.hour)} in the last hour · usually ${formatUsd(a.usual)}`
}
export function spendText(name: string, a: SpendAlert, mode: 'subscription' | 'api' | 'unknown'): string {
  const who = `“${Array.from(name).slice(0, 60).join('')}”`
  const p = spendParts(a)
  if (mode === 'subscription') return `${who} is spending ${p.times} ${p.usual}${p.window ? ` (${p.window})` : ''}: check it isn't looping`
  const usual = a.basis === 'project' ? `the project's sessions usually ${formatUsd(a.usual)}` : `usually ${formatUsd(a.usual)}`
  return `${who} spent ${formatUsd(a.hour)} in the last hour, ${usual}: check it isn't looping`
}

// ---- Tools for Claude: mcp__sessions__list and mcp__sessions__wake ----
// Two tools the mod registers for the model of each interactive session (the sessionTools option, on by default): the
// project's other sessions, and waking a stopped one so SendMessage can reach it. Their input stays as it is: other
// plugins code against it (docs/plugin-contract.md)

export type SessionTool = 'list' | 'wake'
export const SESSION_TOOLS: readonly SessionTool[] = ['list', 'wake']

// How long the start waits for their registration: an agent's file read and seen to allow them, or no agent; and an
// agent whose file wasn't found (a plugin's agent, --agents JSON), where a registration the agent can't see would hold
// it 8 s (Claude waits for the tool to show)
export const TOOLS_WAIT_MS = 1000
export const TOOLS_UNKNOWN_ROLE_WAIT_MS = 300

// A list in an agent file's front matter (`tools: Read, Bash`, `tools: [Read, Bash]` or a `- Read` per line under it),
// or null when the key isn't there
function frontMatterList(front: string, key: string): string[] | null {
  const lines = front.split(/\r?\n/)
  const head = new RegExp(`^${key}\\s*:(.*)$`)
  const i = lines.findIndex(l => head.test(l))
  if (i < 0) return null
  const rest = (lines[i]?.match(head)?.[1] ?? '').trim()
  const items: string[] = []
  if (rest) items.push(...rest.replace(/^\[/, '').replace(/\]$/, '').split(','))
  else {
    for (const l of lines.slice(i + 1)) {
      const m = l.match(/^\s*-\s*(.*)$/)
      if (m) items.push(m[1] ?? '')
      else if (l.trim()) break
    }
  }
  return items.map(s => s.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean)
}

// The tools of the two a list names: all of them for `*`, `mcp__sessions` or `mcp__sessions__*`
function namedTools(items: readonly string[]): Set<SessionTool> {
  const out = new Set<SessionTool>()
  for (const t of items) {
    if (t === '*' || t === 'mcp__sessions' || t === 'mcp__sessions__*') for (const x of SESSION_TOOLS) out.add(x)
    else for (const x of SESSION_TOOLS) if (t === `mcp__sessions__${x}`) out.add(x)
  }
  return out
}

// Which of the tools to register in a session that runs as an agent (claude --agent <name>), from that agent's file
// (null: none found), and how long the start waits for them. An agent whose `tools:` line doesn't name a tool can't see
// it, and registering it anyway holds every start and restart of the session 8 s (Claude 2.1.319): those aren't
// registered. No `tools:` line (the agent has every tool), or one that names them (`mcp__sessions__*`): registered.
// `disallowedTools:` takes out the ones it names
export function roleTools(file: string | null): { tools: SessionTool[]; waitMs: number; why: string } {
  if (file === null) return { tools: [...SESSION_TOOLS], waitMs: TOOLS_UNKNOWN_ROLE_WAIT_MS, why: 'its agent file was not found (a plugin agent, or --agents)' }
  const front = file.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? ''
  const tools = frontMatterList(front, 'tools')
  const allowed = tools === null ? new Set(SESSION_TOOLS) : namedTools(tools)
  for (const t of namedTools(frontMatterList(front, 'disallowedTools') ?? [])) allowed.delete(t)
  const out = SESSION_TOOLS.filter(t => allowed.has(t))
  const why =
    tools === null
      ? 'its agent file has no tools: line'
      : out.length
        ? `its agent file's tools: line names ${out.map(t => `mcp__sessions__${t}`).join(' and ')}`
        : "its agent file's tools: line doesn't name mcp__sessions__*"
  return { tools: out, waitMs: TOOLS_WAIT_MS, why }
}

// The wakes Claude asked for through mcp__sessions__wake, shared by every session (the store's modelWakes, under the
// <data>/bringback.lock folder): when, by which session and of which (session ids), kept for an hour. Limits: a caller
// wakes at most 6 sessions in 10 minutes and 20 in an hour, and a session is woken at most 3 times in an hour (a
// session that fails to start isn't woken in a loop)
export type ModelWake = { at: number; by: string; target: string }
export const WAKE_LIMITS = [
  { who: 'caller', count: 6, ms: 600000 },
  { who: 'caller', count: 20, ms: 3600000 },
  { who: 'target', count: 3, ms: 3600000 },
] as const
export const WAKE_LOG_MS = 3600000
export function modelWakesOf(value: unknown, now: number): ModelWake[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((w: any) => w && typeof w.at === 'number' && typeof w.by === 'string' && typeof w.target === 'string' && now - w.at < WAKE_LOG_MS && w.at <= now)
    .map((w: any) => ({ at: w.at, by: w.by, target: w.target }))
}

// The limit a new wake would break, with when it can be asked again (the oldest wake that counts leaves its window),
// or null
export function wakeLimit(log: readonly ModelWake[], by: string, target: string, now: number): { who: 'caller' | 'target'; count: number; ms: number; until: number } | null {
  for (const l of WAKE_LIMITS) {
    const ats = log
      .filter(w => (l.who === 'caller' ? w.by === by : w.target === target) && now - w.at < l.ms)
      .map(w => w.at)
      .sort((a, b) => a - b)
    if (ats.length >= l.count) return { who: l.who, count: l.count, ms: l.ms, until: (ats[ats.length - l.count] ?? now) + l.ms }
  }
  return null
}

// A session as the tools name it: its short id (null for a regular session), Claude's name for it (what ListAgents and
// SendMessage use; '' when it has none) and its title in the panel
export type Pickable = { sessionId: string; id: string | null; name: string; title: string }

// The sessions `asked` names, among a project's: by short id, session id, Claude's name or the panel's title, exactly,
// else ignoring case; a name as ListAgents writes it ("W [ab12cd]") and quotes around it are taken too
export function pickSession<T extends Pickable>(all: readonly T[], asked: string): { found: T } | { many: T[] } | { none: true } {
  const text = asked
    .trim()
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .replace(/\s+\[[0-9a-z]{4,12}\]$/i, '')
    .trim()
  if (!text) return { none: true }
  const sid = text.startsWith('sid:') ? text.slice(4) : text
  const pick = (match: (s: T) => boolean) => all.filter(match)
  const tries = [
    pick(s => s.id === text || s.sessionId === sid),
    pick(s => s.name === text || s.title === text),
    pick(s => s.name.toLowerCase() === text.toLowerCase() || s.title.toLowerCase() === text.toLowerCase()),
  ]
  for (const found of tries) {
    if (found.length === 1 && found[0]) return { found: found[0] }
    if (found.length > 1) return { many: found }
  }
  return { none: true }
}

// Why a stopped background session stopped, in the tools' words (SessionsStopped)
export function stoppedWords(kind: 'person' | 'idle' | 'memory' | 'ended' | 'unknown'): string {
  if (kind === 'idle') return 'retired for being idle'
  if (kind === 'memory') return 'closed for lack of memory'
  if (kind === 'person') return 'stopped by the person'
  if (kind === 'ended') return 'ended by itself (a crash, or a restart of the machine or the background service)'
  return 'stopped, and nothing says why'
}

// One line of mcp__sessions__list. wake: '' when mcp__sessions__wake would bring it back, else why not
export type ToolRow = Pickable & { state: 'working' | 'idle' | 'waiting' | 'stopped'; stopped?: 'person' | 'idle' | 'memory' | 'ended' | 'unknown'; stoppedAt?: number; wake: string; agent: string | null }
export function toolRowLine(r: ToolRow, now: number): string {
  const name = r.name || r.title
  const shown = r.name && r.title && r.title !== r.name ? ` (“${r.title}” in the panel)` : ''
  const id = r.id ?? 'regular session'
  const when = r.stoppedAt && r.stoppedAt <= now ? ` ${howLong(now - r.stoppedAt)} ago` : ''
  const words = stoppedWords(r.stopped ?? 'unknown')
  const state = r.state === 'stopped' ? `${words.startsWith('stopped') ? words : `stopped: ${words}`}${when}` : r.state === 'waiting' ? 'waiting for the person' : r.state
  const wake = r.wake ? `wake: no (${r.wake})` : 'wake: yes'
  return `- “${name}”${shown} · ${id} · ${state} · ${wake}${r.agent ? ` · runs as agent ${r.agent}` : ''}`
}

export function toolListText(rows: readonly ToolRow[], root: string, now: number): string {
  if (rows.length === 0) return `This project (${root}) has no other sessions.`
  return [
    `This project's other sessions (${root}), by the name ListAgents and SendMessage know them:`,
    ...rows.map(r => toolRowLine(r, now)),
    'Running ones take SendMessage. SendMessage to a stopped one fails at once: one with "wake: yes" takes mcp__sessions__wake first (session: its name or short id), which says the name to SendMessage to.',
  ].join('\n')
}

// Where SendMessage reaches a session, from ListAgents' rows (name, ref; every running session of the account, the
// caller's own left out): "<name> [<ref>]" when one row has that name, its name alone when none or several do (the ref
// is per process and changes at each restart)
export function agentAddress(rows: readonly unknown[], name: string): string {
  const same = rows.filter((r: any) => r && typeof r === 'object' && r.name === name) as { ref?: unknown }[]
  const ref = same.length === 1 && typeof same[0]?.ref === 'string' && /^[0-9A-Za-z]{1,16}$/.test(same[0].ref) ? same[0].ref : ''
  return ref ? `${name} [${ref}]` : name
}

// The line a woken session's row shows in every panel for WOKEN_MARK_MS: who woke it, a mark of the panel's own
// (MarkSlot, under the store's marks:sessions:<its sessionId>)
export const WOKEN_MARK_MS = 900000
export function wokenLine(by: string): string {
  return `woken by “${Array.from(by.trim() || 'another session').slice(0, 40).join('')}”`
}
