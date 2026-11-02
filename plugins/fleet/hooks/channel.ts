// Pure logic of the person channel (tested in tests/channel.test.ts): who the person is in roster.json (his addresses,
// the principals, the front door), how what waits for him and a closed list of alerts reach him (push, an MCP send
// tool to his own address only, a command he names, or the terminal alone), and their caps: so many a day, quiet hours,
// one per key a day. No `$` here.
//
// Only fleet's code sends to the person, from the sweeper's timer: the models never do (a PushNotification the model
// calls in a background session of the project is refused). What it sends names ids, kinds, who and how long, never
// a file's content or a question's words: those stay in the project, and /fleet shows them.

import { hashText } from './changes'
import type { Roster } from './roster'

export type Channel =
  | { kind: 'terminal' }
  | { kind: 'push' }
  | { kind: 'mcp'; server: string; tool: string; to: string; toField: string; textField: string; subjectField: string | null; args: Record<string, unknown> }
  | { kind: 'command'; argv: string[] }
export type Person = {
  addresses: string[]
  principals: string[]
  channel: Channel
  /** No alerts in these local hours (minutes of the day, from → to, across midnight when from > to), but a budget's */
  quiet: { from: number; to: number } | null
  perDay: number
  /** A decision waiting this long, and a check failing this long, is an alert */
  waitingMin: number
  checkMin: number
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function strings(v: unknown): string[] {
  return (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim().toLowerCase())
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

/** "22-7", "22:30-07:00": the quiet hours; null for none or a spelling fleet can't read */
export function parseQuiet(v: unknown): { from: number; to: number } | null {
  if (typeof v !== 'string') return null
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(v)
  if (!m) return null
  const a = Number(m[1]) * 60 + Number(m[2] ?? 0)
  const b = Number(m[3]) * 60 + Number(m[4] ?? 0)
  if (a >= 1440 || b > 1440 || a === b) return null
  return { from: a, to: b }
}

export function inQuiet(q: { from: number; to: number } | null, minuteOfDay: number): boolean {
  if (!q) return false
  return q.from < q.to ? minuteOfDay >= q.from && minuteOfDay < q.to : minuteOfDay >= q.from || minuteOfDay < q.to
}

/** The keys of a send tool's arguments that name who gets it: only the one fleet fills with the person's address may */
const RECIPIENT_KEYS = /^(to|cc|bcc|recipients?|channels?|users?|emails?|address(es)?|chat(_id)?|chatid|conversation(_id)?|thread(_id)?|target|destination|phone|number)$/i

/** roster.json's person, and what's wrong with its channel (then the channel is the terminal: alerts wait in the brief) */
export function personOf(r: Roster | null): { person: Person; problem: string | null } {
  const p = isObject(r?.person) ? (r?.person as Record<string, unknown>) : {}
  const addresses = strings(p.addresses ?? p.address)
  const principals = strings(p.principals)
  const base = { addresses, principals, quiet: parseQuiet(p.quietHours), perDay: Math.floor(num(p.perDay, 0, 100, 5)), waitingMin: num(p.waitingMin, 1, 7 * 24 * 60, 30), checkMin: num(p.checkMin, 1, 7 * 24 * 60, 60) }
  const terminal = (problem: string | null) => ({ person: { ...base, channel: { kind: 'terminal' as const } }, problem })
  const c = isObject(p.channel) ? p.channel : null
  if (p.quietHours !== undefined && !base.quiet) return terminal(`roster.json: person.quietHours "${String(p.quietHours)}" isn't a range of hours (22-7, or 22:30-07:00)`)
  if (!c || c.kind === undefined || c.kind === 'terminal') return terminal(null)
  if (c.kind === 'push') return { person: { ...base, channel: { kind: 'push' } }, problem: null }
  if (c.kind === 'mcp') {
    const server = typeof c.server === 'string' ? c.server.trim() : ''
    const tool = typeof c.tool === 'string' ? c.tool.trim() : ''
    const to = typeof c.to === 'string' ? c.to.trim().toLowerCase() : ''
    if (!server || !tool) return terminal('roster.json: person.channel "mcp" needs server and tool (a tool that sends a message)')
    if (!to) return terminal('roster.json: person.channel "mcp" needs to: your own address')
    if (!addresses.includes(to)) return terminal(`roster.json: person.channel.to (${to}) isn't one of person.addresses: fleet sends only to the person`)
    const toField = typeof c.toField === 'string' && c.toField ? c.toField : 'to'
    const textField = typeof c.textField === 'string' && c.textField ? c.textField : 'body'
    const args = isObject(c.args) ? c.args : {}
    const others = Object.keys(args).filter(k => RECIPIENT_KEYS.test(k) || k === toField)
    if (others.length) return terminal(`roster.json: person.channel.args names a recipient (${others.join(', ')}): fleet fills only ${toField}, with person.channel.to`)
    return { person: { ...base, channel: { kind: 'mcp', server, tool, to, toField, textField, subjectField: typeof c.subjectField === 'string' && c.subjectField ? c.subjectField : null, args } }, problem: null }
  }
  if (c.kind === 'command') {
    const argv = Array.isArray(c.argv) ? c.argv : []
    if (!argv.length || argv.some(a => typeof a !== 'string' || !a)) return terminal('roster.json: person.channel "command" needs argv, the command first (it gets the text on its standard input)')
    return { person: { ...base, channel: { kind: 'command', argv: argv as string[] } }, problem: null }
  }
  return terminal(`roster.json: person.channel.kind "${String(c.kind)}" isn't push, mcp, command or terminal`)
}

/** The script a command channel runs (the last argument that looks like a path): stamped, and command-level */
export function channelScript(c: Channel): string | null {
  if (c.kind !== 'command') return null
  const s = [...c.argv].reverse().find(a => /[/.]/.test(a) && !a.startsWith('-'))
  return s && !s.startsWith('/') && !s.includes('..') ? s.replace(/^\.\//, '') : null
}

/** What the person's stamp of a command channel covers: the command, and its script's version */
export function channelKey(c: Channel, scriptVersion: string | null): string {
  return c.kind === 'command' ? hashText(JSON.stringify({ argv: c.argv, script: scriptVersion })) : ''
}

/** The arguments of the MCP send: the roster's args, the person's address in toField, the text (and a subject) */
export function mcpSendArgs(c: Extract<Channel, { kind: 'mcp' }>, text: string, subject: string): Record<string, unknown> {
  return { ...c.args, [c.toField]: c.to, [c.textField]: text, ...(c.subjectField ? { [c.subjectField]: subject } : {}) }
}

export function channelWords(c: Channel): string {
  if (c.kind === 'push') return 'push (PushNotification from the sweeper session: your phone when that session has Remote Control)'
  if (c.kind === 'mcp') return `mcp (${c.tool} on ${c.server}, to ${c.to} only)`
  if (c.kind === 'command') return `command (${c.argv.join(' ')}, the text on its standard input)`
  return 'terminal (the band, /fleet and /fleet brief only)'
}

// ---- Alerts: a closed list ----

/** waiting: a decision held longer than waitingMin; budget: an instance or the project used up its budget (also in
 * quiet hours); nofleet: an instance running without fleet; check: a file failing a check longer than checkMin;
 * intake: a request for a change from the person's or a principal's address, or an urgent item nobody subscribes to;
 * outside: a command-level file changed outside fleet */
export type AlertKind = 'waiting' | 'budget' | 'nofleet' | 'check' | 'intake' | 'outside'
export type Alert = { key: string; kind: AlertKind; text: string }

/** <project>/.claude/fleet/state/alerts.json, the sweeper's: today's count, each key's last send, the last message */
export type AlertsFile = { format: number; day: string; count: number; sent: Record<string, number>; held?: number; last?: { at: number; text: string; answer: string } }

/** Which alerts go now: those not sent in the last day, outside quiet hours (a budget's goes anyway), while today's
 * count is under perDay (one message carries every alert due at once, and counts once). The rest wait */
export function alertsDue(due: readonly Alert[], file: AlertsFile | null, p: { format: number; now: number; day: string; perDay: number; quiet: boolean }): { send: Alert[]; waiting: Alert[]; file: AlertsFile } {
  const sent = Object.fromEntries(Object.entries(file?.sent ?? {}).filter(([, at]) => p.now - at < 24 * 3600000))
  const count = file && file.day === p.day ? file.count : 0
  const fresh = due.filter(a => sent[a.key] === undefined)
  const allowed = fresh.filter(a => !p.quiet || a.kind === 'budget')
  const send = count < p.perDay ? allowed : []
  const waiting = fresh.filter(a => !send.includes(a))
  for (const a of send) sent[a.key] = p.now
  const next: AlertsFile = { format: p.format, day: p.day, count: count + (send.length ? 1 : 0), sent, ...(waiting.length ? { held: waiting.length } : {}), ...(file?.last ? { last: file.last } : {}) }
  return { send, waiting, file: next }
}

/** One message for the alerts due at once: the project's name, the alerts (at most about 600 characters), and where to
 * look */
export function alertMessage(project: string, alerts: readonly Alert[]): string {
  const head = `fleet · ${project}: `
  const tail = ' · /fleet or /fleet brief in any session of the project'
  const parts: string[] = []
  let size = head.length + tail.length
  for (const [k, a] of alerts.entries()) {
    const more = alerts.length - k
    if (size + a.text.length + 2 > 600 && parts.length) {
      parts.push(`and ${more} more`)
      break
    }
    parts.push(a.text)
    size += a.text.length + 2
  }
  return `${head}${parts.join('; ')}${tail}`
}
