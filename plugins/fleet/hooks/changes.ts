// Pure logic of fleet's shared files, "changed since you read it" (tested in tests/changes.test.ts): world.json and
// its globs, where a path lands in the project, file versions, the events of a landing, what each thread read, the
// gate's verdict and words, the digest, and the reads a Bash command makes. No `$` here.
//
// The world is the project's files that agents coordinate through, listed as globs in world.json. Every landing (a
// write to a world file, by any session of the project) is one event file; every thread (a session's main loop, or one
// of its helpers by agentId) keeps the version of each world file it read. A thread's Write or Edit of a world file
// that changed since it read it is refused once with who changed it and when; the thread hears of such changes at its
// next step. Coordination, not security: fleet fails open, and never carries a file's content, only path, who and when.

import type { FleetRead } from '../types'
import { FORMAT, cut } from './decisions'
import { commandsOf, stripPrefixes } from './outbound'
import type { IntakeMeta } from './intake'

/** Project data: world.json. It only gains fields, and a write keeps the fields it doesn't know */
export const WORLD_FORMAT = 1
/** What /fleet init lists when world.json doesn't exist yet */
export const DEFAULT_WORLD_PATHS = ['notes/**', 'docs/**']
/** The digest names at most this many files; the rest go on one line */
export const DIGEST_LINES = 10
/** Events and outside claims older than this are removed by the daily prune, and so are reads files not written since */
export const KEEP_DAYS = 7

export type WorldConfig = { worldFormat: number; paths: string[]; [key: string]: unknown }
/** Who landed a change: a session (and its helper, agentId), or the person (/fleet accept); null for outside fleet */
export type Who = { sessionId: string | null; agentId: string | null; ref: string | null; name: string | null; person?: true }
/** tool: the model's Write, Edit or NotebookEdit, through the gate; bash: found after a Bash command; outside: found by a
 * session's scan (an editor, a script, a session without fleet); accept: the person stamped the current version as his;
 * answer: fleet wrote a command-level record, applying a change the person approved (drafts.ts); intake: fleet wrote an
 * intake record, an item from outside read by the sweeper (intake.ts) */
export type Via = 'tool' | 'bash' | 'outside' | 'accept' | 'answer' | 'intake'
export type ChangeEvent = {
  format: number
  /** When fleet recorded it: the landing, or for an outside change when a scan found it. What orders the events and
   * what a thread's read is compared with */
  at: number
  /** An outside change: the file's modification time, which may be older than the read it changes (rsync -a, cp -p,
   * unzip, a sync client keep the source's). Only the words use it */
  changedAt?: number
  /** Relative to the project folder, as placed (§ placement below) */
  path: string
  /** The versions before and after; null: the file wasn't there, or was removed */
  from: string | null
  to: string | null
  via: Via
  /** The tool, for via tool or bash */
  tool?: string
  /** It landed without going through the gate: via bash and outside */
  blind: boolean
  by: Who | null
  /** The write replaced a version the writer had not validated (another landing came in between) */
  overwrote?: boolean
  /** A record's landing (records.ts): its id, the version fleet gave it, what kind of change it was */
  id?: string
  rev?: number
  kind?: string
  /** The pins the file cites after the landing (ID@n), records or not */
  pins?: string[]
  /** A blind landing citing pins its thread hadn't read as they were: "<pin>:<stale|unread|ahead>" */
  suspect?: string[]
  /** Stale pins the writer kept after reading the record as it was: "<pin>><version read>" (records.ts) */
  confirmed?: string[]
  /** The writer's context had read outside content (authority.ts): provenance for the brief, never a mark on readers */
  outside?: true
  /** An intake record (via intake): its kind, tags, sender, the model's summary and who it's routed to; never the body */
  intake?: IntakeMeta
  /** Found by the scan while a session's background command ran, or just after one of its commands whose run covers
   * the file's time and that doesn't name it (via bash, by that session): probably its doing, maybe the person's, so he
   * can stamp it as his like an outside change. Never counts as that session's landing (its cadence) */
  probably?: true
  /** Found by the scan, outside fleet, while commands of more than one session or thread may have made it (each ran
   * when the file got its time, or ran in the background then): who they were, none of them blamed */
  candidates?: Who[]
  /** A change the person applied (via answer, by the person): the session that drafted it, which hears its flags */
  drafter?: Who
}
/** A thread: 'main' for the main loop, else the helper's agentId */
export type Threads = Record<string, Record<string, FleetRead>>
/** <project>/.claude/fleet/reads/<sessionId>.json: what a session's threads read, for /fleet status and a restart; and
 * the outside content its context read, if any (it stays until /clear, through a restart) */
export type ReadsFile = { format: number; sessionId: string; ref: string | null; name: string | null; at: number; threads: Threads; outside?: { at: number; what: string }; running?: Running[]; finished?: Finished[] }
/** A Bash command a session runs now (shown once it has run a few seconds; task: one in the background), so the sweeper
 * doesn't take what it writes meanwhile for a change outside fleet; command: its first 300 characters, so a peer's
 * command that names a file the command writes too leaves it to the scan */
export type Running = { thread: string; at: number; task?: string; command?: string }
/** A Bash command a session ran lately that may have written (from its look at the world to its end): a change it
 * didn't name, that no event explains, whose time falls in that run, is probably its, when no other command's run
 * covers it too. It counts for FINISHED_MS after its end, or until a scan that waited on another command meanwhile
 * looks (kept FINISHED_KEEP_MS for that: the longest a scan waits) */
export type Finished = { thread: string; at: number; end: number }
export const FINISHED_MS = 60000
export const FINISHED_KEEP_MS = 12 * 60000

// ---- world.json ----

export function worldText(w: WorldConfig): string {
  return `${JSON.stringify(w, null, 2)}\n`
}

export function newWorld(): WorldConfig {
  return { worldFormat: WORLD_FORMAT, paths: [...DEFAULT_WORLD_PATHS] }
}

/** world.json: its globs, or why it can't be used (a newer fleet wrote it, it isn't JSON, a glob is bad) */
export function parseWorld(text: string): { world: WorldConfig } | { problem: string } {
  let w: any
  try {
    w = JSON.parse(text)
  } catch {
    return { problem: "world.json isn't valid JSON: fix it (or delete it and run /fleet init again)" }
  }
  if (!w || typeof w !== 'object' || typeof w.worldFormat !== 'number') return { problem: 'world.json has no worldFormat: fix it (or delete it and run /fleet init again)' }
  if (w.worldFormat > WORLD_FORMAT) return { problem: `world.json is from a newer fleet (worldFormat ${w.worldFormat}): restart this session (u) to load it` }
  const paths = Array.isArray(w.paths) ? w.paths.filter((p: unknown) => typeof p === 'string') : []
  for (const p of paths) {
    const bad = checkGlob(p)
    if (bad) return { problem: `world.json: "${p}" ${bad}` }
  }
  return { world: { ...w, paths } }
}

/** Why a glob can't be a world path, or null. Globs are relative to the project folder, with / between folders */
export function checkGlob(glob: string): string | null {
  if (!glob.trim()) return 'is empty'
  if (glob.startsWith('/') || /^[A-Za-z]:/.test(glob) || glob.startsWith('~')) return 'must be relative to the project folder'
  if (glob.includes('\\')) return 'must use / between folders'
  if (glob.split('/').some(s => s === '..' || s === '.')) return "can't have . or .. in it"
  if (/^\.claude\/fleet(\/|$)/.test(glob)) return "is fleet's own folder"
  return null
}

/** world.json with a glob added (a folder written as notes/ means notes/**) */
export function addGlob(w: WorldConfig, glob: string): { world: WorldConfig; added: string } | { problem: string } {
  const g = glob.trim().replace(/\/+$/, (m: string) => (m ? '/**' : ''))
  const bad = checkGlob(g)
  if (bad) return { problem: `"${g}" ${bad}` }
  if (w.paths.includes(g)) return { problem: `"${g}" is in the world already` }
  return { world: { ...w, paths: [...w.paths, g] }, added: g }
}

export function removeGlob(w: WorldConfig, glob: string): { world: WorldConfig } | { problem: string } {
  const g = glob.trim()
  if (!w.paths.includes(g)) return { problem: `"${g}" isn't in the world (it has ${w.paths.length ? w.paths.join(', ') : 'nothing'})` }
  return { world: { ...w, paths: w.paths.filter(p => p !== g) } }
}

// ---- Globs: ** any folders (none too), * and ? within one name, {a,b} alternatives ----

export function globRegex(glob: string, insensitive: boolean): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      re += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end < 0) re += '\\{'
      else {
        re += `(?:${glob.slice(i + 1, end).split(',').map(escape).join('|')})`
        i = end
      }
    } else re += escape(c)
  }
  return new RegExp(`^${re}$`, insensitive ? 'i' : '')
}

/** Globs as the person reads them: in backticks, since a command's answer is drawn as markdown (** would be bold) */
export function globList(globs: readonly string[]): string {
  return globs.map(g => `\`${g}\``).join(', ')
}

function escape(s: string): string {
  return s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
}

/** Whether a path of the project (relative, placed) is a world path. fleet's own folder never is */
export function inWorld(rel: string, globs: readonly RegExp[]): boolean {
  if (!rel || rel === '.claude/fleet' || rel.startsWith('.claude/fleet/') || /^\.claude\/fleet(\/|$)/i.test(rel)) return false
  return globs.some(g => g.test(rel))
}

/** The folder a glob's files live under, where a scan starts: notes/** → notes, docs/*.md → docs, *.md → '' */
export function globBase(glob: string): string {
  const parts = glob.split('/')
  const fixed: string[] = []
  for (const p of parts.slice(0, -1)) {
    if (/[*?{]/.test(p)) break
    fixed.push(p)
  }
  return fixed.join('/')
}

// ---- Where a path lands ----

/** A spelling that can't be placed without guessing: empty, ., .., or a drive-relative or network path */
export function placeable(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return !!path && path.startsWith('/') && !/^\/\//.test(path) && name !== '' && name !== '.' && name !== '..'
}

/** A placed absolute path relative to the project's real folder, or null when it's outside. On a volume that ignores
 * case the prefix is compared ignoring it (the real path of an existing file has the disk's case already) */
export function relOf(abs: string, realRoot: string, insensitive: boolean): string | null {
  const root = realRoot.replace(/\/+$/, '')
  const a = insensitive ? abs.toLowerCase() : abs
  const r = insensitive ? root.toLowerCase() : root
  if (!a.startsWith(`${r}/`)) return null
  return abs.slice(root.length + 1)
}

/** For a path that isn't there yet: its folders upwards, nearest first, each with the rest of the path below it
 * (/p/notes/new/x.md → [/p/notes/new, new/x.md... ]). A rest with .. in it can't be placed */
export function ancestorsOf(path: string): { dir: string; rest: string }[] {
  const out: { dir: string; rest: string }[] = []
  let cut = path.lastIndexOf('/')
  while (cut > 0) {
    const rest = path.slice(cut + 1)
    if (rest.split('/').some(s => s === '..' || s === '.')) return out
    out.push({ dir: path.slice(0, cut), rest })
    cut = path.lastIndexOf('/', cut - 1)
  }
  return out
}

// ---- Versions: a hash of the text (line endings and a leading BOM ignored), or size and time past 4 MiB ----

/** cyrb53: a small, fast, well-mixed 53-bit hash. Change detection, not security */
export function hashText(text: string): string {
  const s = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return `h${n.toString(16).padStart(14, '0')}`
}

export function statVersion(size: number, mtimeMs: number): string {
  return `s${size}-m${Math.floor(mtimeMs)}`
}

// ---- Events: <project>/.claude/fleet/events/YYYY-MM-DD/HH/<ms>-<sid8>-<n>.json (UTC hours) ----

export function eventName(at: number, sid8: string, n: number): string {
  return `${at}-${sid8}-${n}.json`
}

export function hourFolder(ms: number): string {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)}/${iso.slice(11, 13)}`
}

/** The hour folders of the trailing window, newest first: the current hour and the ones before it */
export function windowFolders(now: number, hours: number): string[] {
  const out: string[] = []
  for (let i = 0; i < hours; i++) out.push(hourFolder(now - i * 3600000))
  return [...new Set(out)]
}

/** The day folders to remove: those older than KEEP_DAYS days */
export function oldDays(days: readonly string[], now: number): string[] {
  const cut = new Date(now - KEEP_DAYS * 86400000).toISOString().slice(0, 10)
  return days.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < cut)
}

export function isEvent(v: any): v is ChangeEvent {
  return !!v && v.format === FORMAT && typeof v.at === 'number' && typeof v.path === 'string' && typeof v.via === 'string'
}

/** Of two events for one path, whether b is the one that's current */
export function newer(a: ChangeEvent | undefined, b: ChangeEvent): boolean {
  if (!a) return true
  // A tool's landing of a version stays its, whichever came first: a blind one of the same version (a peer's
  // post-scan that saw it land, its event written later or earlier) is the same write seen late
  if (a.to === b.to) {
    if (a.via === 'tool' && b.via === 'bash' && b.blind) return false
    if (b.via === 'tool' && a.via === 'bash' && a.blind) return true
  }
  return b.at >= a.at
}

// ---- Words: who, when ----

/** HH:MM in the person's time zone (offset in minutes east of UTC) */
export function clock(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A time as the person reads it, in his own time: its clock, and its day when that isn't today ("18:57 on 3 Nov"), so
 * a time two days old doesn't read as one still to come */
export function clockOn(ms: number, offsetMin: number, now: number): string {
  const d = new Date(ms + offsetMin * 60000)
  const today = new Date(now + offsetMin * 60000)
  const same = d.getUTCFullYear() === today.getUTCFullYear() && d.getUTCMonth() === today.getUTCMonth() && d.getUTCDate() === today.getUTCDate()
  return same ? clock(ms, offsetMin) : `${clock(ms, offsetMin)} on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

export type Me = { sessionId: string; offsetMin: number }

function sessionWords(by: Who, me: Me): string {
  if (by.person) return 'the person'
  if (by.sessionId && by.sessionId === me.sessionId) return by.agentId ? 'a helper of this session' : "this session's main thread"
  return by.name || by.ref || (by.sessionId ? `the session ${by.sessionId.slice(0, 8)}` : 'a session')
}

/** Who made a change, after "by": "TEST B (Edit)", "TEST B (a Bash command, landed blind)", "the person"; for an
 * outside change, "nobody fleet knows" (changeLine words it as outside fleet) */
export function whoText(e: ChangeEvent, me: Me): string {
  if (e.via === 'intake') return `fleet's intake (an item from ${e.intake?.from || 'outside'})`
  if (e.via === 'outside' || !e.by) return 'nobody fleet knows'
  const who = sessionWords(e.by, me)
  if (e.via === 'accept') return 'the person'
  if (e.via === 'answer') return 'the person (a change applied by fleet)'
  if (e.via === 'bash') return e.probably ? `${who} (probably a command of its, landed blind)` : `${who} (a Bash command, landed blind)`
  return e.tool ? `${who} (${e.tool})` : who
}

const OUTSIDE = 'outside fleet (an editor, a script, or a session without fleet)'

/** Who may have made an outside change, in words: "TEST A or TEST B" */
export function candidatesText(e: ChangeEvent, me: Me): string {
  const names = (e.candidates ?? []).map(w => sessionWords(w, me))
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : (names[0] ?? '')
}

/** "changed at 14:02 by TEST B (Edit)", "was removed at 14:05 outside fleet (…)"; a record's adds its new version,
 * ", now R-12@5", with the kind when it's not a revision */
export function changeLine(e: ChangeEvent, me: Me): string {
  const what = `${e.to === null ? 'was removed' : 'changed'} at ${clock(e.changedAt ?? e.at, me.offsetMin)}`
  const rev = e.id && e.rev && e.to !== null ? `, now ${e.id}@${e.rev}${e.kind && e.kind !== 'revision' ? ` (${e.kind})` : ''}` : ''
  const outside = e.candidates?.length ? `outside fleet as far as it can tell (commands of ${candidatesText(e, me)} ran then; or an editor, a script)` : OUTSIDE
  return `${e.via === 'intake' ? `${what} by ${whoText(e, me)}` : e.via === 'outside' || !e.by ? `${what} ${outside}` : `${what} by ${whoText(e, me)}`}${rev}`
}

// ---- The gate ----

export type Verdict = 'pass' | 'stale' | 'unread'

/** A Write or Edit of a world file by one thread: it passes when the file isn't there, when this thread read the version
 * that's there now, or when this thread was already refused once for that version (the gate is soft: it tells once) */
export function verdict(read: FleetRead | undefined, current: string | null, warned: string | undefined): Verdict {
  if (current === null) return 'pass'
  if (read && read.v === current) return 'pass'
  if (warned === current) return 'pass'
  return read ? 'stale' : 'unread'
}

/** What the model reads when its write is refused. last: the event that made the version there now, if known */
export function gateText(v: Exclude<Verdict, 'pass'>, rel: string, last: ChangeEvent | null, mtimeMs: number, me: Me): string {
  if (v === 'stale') {
    const change = last ? changeLine(last, me) : `changed at ${clock(mtimeMs, me.offsetMin)} ${OUTSIDE}`
    return `fleet: ${rel} ${change}, after you read it. Read it again, then redo this write so it agrees with that change (this write was not made).`
  }
  const when = last ? ` (it last ${changeLine(last, me)})` : ''
  return `fleet: ${rel} is a shared file of this project and you haven't read it in this conversation${when}. Read it first, then redo this write so it keeps what's there (this write was not made).`
}

/** What the model reads after its own landing replaced a version someone else made after it read it: a Write or a
 * command over it, or an Edit on top of it (another landing came in while the write waited, or the command didn't
 * go through the gate) */
export function overwroteText(rel: string, last: ChangeEvent, me: Me, how: 'write' | 'edit' | 'command' | 'probably'): string {
  if (how === 'probably') return `fleet: ${rel} changed while a command of yours ran that doesn't name it (probably your command: a script, a checkout, a stash), over a change: it ${changeLine(last, me)} after you read it. Read ${rel} and check that change is still there.`
  if (how === 'edit') {
    return `fleet: your edit of ${rel} landed on top of a change that ${changeLine(last, me).replace(/^changed /, 'came in ')} while your edit waited. Read ${rel} and check that both changes are right.`
  }
  if (how === 'command') return `fleet: your command changed ${rel}, which ${changeLine(last, me)} after you read it. Read ${rel} and check that change is still there.`
  return `fleet: your write replaced ${rel}, which ${changeLine(last, me)} after you read it: that change may be lost. Read ${rel} and check it's still there.`
}

/** What the model reads after a command with no write syntax ran while another session's write landed on a world file:
 * the command didn't change it (it isn't its landing), but what it read may be older than what's there now. last: the
 * event of the version there now, when fleet has it; else nobody is named */
export function duringText(rel: string, last: ChangeEvent | null, me: Me): string {
  return `fleet: ${rel} changed while your command ran (${last ? `it ${changeLine(last, me)}` : "by someone fleet hasn't seen yet: an editor, a script, or a session whose event is still coming"}); your command didn't change it. If your command read it, read it again.`
}

// ---- Bash: whether a command writes (its syntax only; a program not known to only read counts as a writer) ----

// Programs that only read, unless a flag or an operand below names a file they write. env and the like aren't here:
// the shell reader takes them off and judges the command they run. ps, kill and the like write no file
const READ_ONLY_PROGRAMS = new Set(['cat', 'nl', 'bat', 'batcat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'wc', 'ls', 'stat', 'file', 'sort', 'uniq', 'cut', 'tr', 'jq', 'diff', 'cmp', 'comm', 'md5', 'md5sum', 'shasum', 'sha256sum', 'cksum', 'date', 'which', 'basename', 'dirname', 'realpath', 'readlink', 'du', 'df', 'pwd', 'cd', 'echo', 'printf', 'true', 'false', 'test', '[', 'sleep', 'column', 'fold', 'fmt', 'rev', 'tac', 'less', 'more', 'od', 'hexdump', 'xxd', 'strings', 'tree', 'printenv', 'id', 'whoami', 'hostname', 'uname', 'ps', 'pgrep', 'uptime', 'kill', 'qstat', 'nproc'])
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk'])

/** A project's check script as a command names it, from the project's folder */
export const CHECK_SCRIPT = /^(\.\/)?\.claude\/fleet\/checks\/[^/]+\.py$/

// The short options that take a value: curl's and ssh's (a value may be attached, -oFILE, or follow)
const CURL_VALUED = 'AbcCdDeEFHKmoPQrtTuUwxXyYz'
const SSH_VALUED = 'BbcDEeFIiJLlmOoPpQRSWw'

/** The value of a short option among want in the cluster at args[i] (-sSo file, -oFILE), or undefined: the first
 * letter of the cluster that takes a value takes the rest of it, or the next word */
function shortValue(args: readonly string[], i: number, valued: string, want: string): string | undefined {
  const a = args[i] as string
  if (!/^-[A-Za-z0-9#]/.test(a) || a.startsWith('--')) return undefined
  for (let k = 1; k < a.length; k++) {
    const c = a[k] as string
    if (!valued.includes(c)) continue
    if (!want.includes(c)) return undefined
    return k + 1 < a.length ? a.slice(k + 1) : (args[i + 1] ?? '')
  }
  return undefined
}

/** Whether a short option among want stands in the cluster a before the letter that takes a value (-sO, not -XPOST) */
function shortFlag(a: string, valued: string, want: string): boolean {
  if (!/^-[A-Za-z0-9#]/.test(a) || a.startsWith('--')) return false
  for (let k = 1; k < a.length; k++) {
    const c = a[k] as string
    if (want.includes(c)) return true
    if (valued.includes(c)) return false
  }
  return false
}

/** A copy's destination on another machine (host:path, user@host:path, rsync://…): it writes nothing here */
function remoteOperand(op: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(op) || (/^[^/\s:]+:/.test(op) && !/^\.\.?\//.test(op))
}

/** The last path segment of a URL, as curl -O and wget name what they fetch (index.html when there is none) */
function urlName(url: string): string {
  const path = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, '').replace(/[?#].*$/, '')
  return path.slice(path.lastIndexOf('/') + 1) || 'index.html'
}
const READ_ONLY_VCS = new Set(['diff', 'log', 'show', 'status', 'grep', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'cat-file', 'describe', 'shortlog', 'merge-base', 'rev-list', 'whatchanged'])

/** The operands of a command's words (no options, nor the values of the options given that take one) */
function operandsOf(args: readonly string[], valued: RegExp): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--') {
      out.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('-') && a !== '-') {
      if (valued.test(a)) i++
      continue
    }
    out.push(a)
  }
  return out
}

/** Whether a Bash command writes nothing in the shared world: no redirection to a file, and only programs that read (sed
 * without -i or a w command, find without -delete or -exec, git's reading subcommands without --output, sort without -o,
 * uniq and xxd with one operand…). inWorld says whether a file a command writes is a world file (a path as the command
 * names it); without it, every file counts. A file it can't name ($var) counts. Unsure counts as writing */
export function bashWritesNothing(command: string, inWorld?: (target: string) => boolean, checkScript: (script: string) => boolean = s => CHECK_SCRIPT.test(s)): boolean {
  const c = command.trim()
  if (!c || c.includes('`')) return false
  const targets: string[] = []
  let cmds: string[][]
  try {
    cmds = commandsOf(c, 0, targets)
  } catch {
    return false
  }
  // A file the command writes into the world: /dev/null and the terminal aren't; a name with $ in it may be anything
  const writes = (t: string | undefined): boolean => {
    if (t === undefined || t === '') return true
    if (/^\/dev\/(null|stdout|stderr|tty|fd\/[0-2])$/.test(t)) return false
    if (/[$`*?]/.test(t)) return true
    return inWorld ? inWorld(t) : true
  }
  if (targets.some(writes)) return false
  for (const words of cmds) {
    const w = stripPrefixes(words)
    if (!w.length) continue
    const prog = (w[0] as string).split('/').pop() as string
    const args = w.slice(1)
    if (prog === 'sed') {
      if (args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place') || /^-[a-zA-Z]*f/.test(a) || a === '--file')) return false
      // A script's w or W command (/x/w file, 1,5w file) or an s command's w flag (s/a/b/gw file) writes a file: a w
      // after a non-letter or after a / and flags (a pattern like /what/ counts too: the safe side)
      if (args.some(a => !a.startsWith('-') && (/(^|[^A-Za-z])[wW]/.test(a) || /\/[gpiImMe0-9]*[wW]/.test(a)))) return false
      continue
    }
    if (prog === 'find') {
      if (args.some(a => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))) return false
      continue
    }
    if (prog === 'git') {
      let sub = ''
      for (let i = 0; i < args.length && !sub; i++) {
        const a = args[i] as string
        if (a === '-C' || a === '-c') i++
        else if (!a.startsWith('-')) sub = a
      }
      if (!READ_ONLY_VCS.has(sub)) return false
      const k = args.findIndex(a => /^--output(=|$)/.test(a))
      if (k >= 0 && writes((args[k] as string).includes('=') ? (args[k] as string).slice('--output='.length) : args[k + 1])) return false
      continue
    }
    if (prog === 'sort') {
      for (let i = 0; i < args.length; i++) {
        const a = args[i] as string
        if (a === '--output' || /^-[a-zA-Z]*o$/.test(a)) {
          if (writes(args[i + 1])) return false
        } else if (a.startsWith('--output=')) {
          if (writes(a.slice('--output='.length))) return false
        } else if (/^-[a-zA-Z]*o./.test(a) && !a.startsWith('--')) {
          if (writes(a.slice(a.indexOf('o') + 1))) return false
        }
      }
      continue
    }
    // A second operand is the file they write
    if (prog === 'uniq') {
      if (writes(operandsOf(args, /^-[fsw]$|^--(skip-fields|skip-chars|check-chars)$/)[1] ?? '/dev/null')) return false
      continue
    }
    if (prog === 'xxd') {
      if (writes(operandsOf(args, /^-[cglson]$|^-(cols|groupsize|len|seek|name)$/)[1] ?? '/dev/null')) return false
      continue
    }
    if (prog === 'tree') {
      const k = args.findIndex(a => a === '-o')
      if (k >= 0 && writes(args[k + 1])) return false
      continue
    }
    // A log file, a compiled magic file, a preprocessor it runs
    if (prog === 'less' && args.some(a => /^-[a-zA-Z]*[oO]/.test(a) || a.startsWith('--log-file') || a.startsWith('--LOG-FILE'))) return false
    if (prog === 'file' && args.some(a => /^-[a-zA-Z]*C/.test(a) || a === '--compile')) return false
    if (prog === 'rg' && args.some(a => a === '--pre' || a.startsWith('--pre='))) return false
    // ssh runs its command on the other machine: here it writes only a log it's told to (-E, its file attached or
    // not); what it prints goes to a redirection the shell reader saw already
    if (prog === 'ssh') {
      for (let i = 0; i < args.length; i++) {
        const f = shortValue(args, i, SSH_VALUED, 'E')
        if (f !== undefined && writes(f)) return false
      }
      continue
    }
    // A copy writes its destination (the last operand, or -t's): a remote one (host:path) or one outside the world
    // writes nothing here. mv takes its sources away too: a source in the world is a write of the world
    if (prog === 'scp' || prog === 'rsync' || prog === 'cp' || prog === 'mv' || prog === 'install' || prog === 'ln') {
      const valued = prog === 'scp' ? /^-[PioFlcSJ]$/ : prog === 'rsync' ? /^-[eBT]$|^--(rsh|rsync-path|exclude|include|filter|files-from|exclude-from|include-from|temp-dir|partial-dir|backup-dir|compare-dest|copy-dest|link-dest|password-file|out-format|chmod|chown|timeout|bwlimit|max-size|min-size|port|sockopts)$/ : /^-[tSmogb]$|^--(target-directory|suffix|mode|owner|group|backup)$/
      if (prog === 'rsync' && args.some(a => (a.startsWith('--log-file=') && writes(a.slice('--log-file='.length))) || a === '--log-file')) return false
      const ops = operandsOf(args, valued)
      const t = args.findIndex(a => a === '-t' || a === '--target-directory')
      const eq = args.find(a => a.startsWith('--target-directory='))
      const dest = t >= 0 ? args[t + 1] : eq ? eq.slice('--target-directory='.length) : ops[ops.length - 1]
      const sources = t >= 0 || eq ? ops : ops.slice(0, -1)
      if (prog === 'install' && args.some(a => a === '-d' || a === '--directory' || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a))) {
        if (ops.some(o => writes(o))) return false
        continue
      }
      if (dest === undefined) return false
      if (!((prog === 'scp' || prog === 'rsync') && remoteOperand(dest)) && writes(dest)) return false
      if (prog === 'mv' && sources.some(s => writes(s))) return false
      if (prog === 'rsync' && args.some(a => a === '--remove-source-files') && sources.some(s => !remoteOperand(s) && writes(s))) return false
      continue
    }
    // tee, touch and mkdir write every file they name
    if (prog === 'tee' || prog === 'touch' || prog === 'mkdir') {
      const ops = operandsOf(args, prog === 'touch' ? /^-[dtr]$|^--(date|reference)$/ : prog === 'mkdir' ? /^-m$|^--mode$/ : /^$/)
      if (!ops.length || ops.some(o => writes(o))) return false
      continue
    }
    // curl writes what -o names, or the URL's last segment with -O (into --output-dir); its other files (headers,
    // cookies, a trace) too. Without them it prints: a read here (the outbound gate judges what it sends)
    if (prog === 'curl') {
      const urls = args.filter(a => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(a))
      const dirAt = args.findIndex(a => a === '--output-dir')
      const dir = dirAt >= 0 ? args[dirAt + 1] : undefined
      for (let i = 0; i < args.length; i++) {
        const a = args[i] as string
        // -o, -D and -c with their file attached (-oboard/x.json, -sSo x) or next
        const short = shortValue(args, i, CURL_VALUED, 'oDc')
        if (a === '--output' || a === '--dump-header' || a === '--cookie-jar' || a === '--trace' || a === '--trace-ascii' || a === '--stderr' || a === '--libcurl' || short !== undefined) {
          const f = short ?? args[i + 1]
          if (f !== '-' && writes(dir && !String(f).startsWith('/') ? `${dir}/${f}` : f)) return false
        } else if (/^--(output|dump-header|cookie-jar|trace|trace-ascii|stderr|libcurl)=/.test(a)) {
          const f = a.slice(a.indexOf('=') + 1)
          if (f !== '-' && writes(f)) return false
        } else if (a === '--remote-name' || a === '--remote-name-all' || a === '--remote-header-name' || shortFlag(a, CURL_VALUED, 'OJ')) {
          for (const u of urls.length ? urls : ['']) if (writes(`${dir ? `${dir}/` : ''}${urlName(u)}`)) return false
        }
      }
      continue
    }
    // wget writes what it fetches: -O's file (- is the output), else the URL's last segment (in -P's folder); and a log
    if (prog === 'wget') {
      const urls = args.filter(a => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(a))
      let out: string | undefined
      let dir: string | undefined
      for (let i = 0; i < args.length; i++) {
        const a = args[i] as string
        if (a === '-O' || a === '--output-document') out = args[i + 1]
        else if (a.startsWith('--output-document=')) out = a.slice(a.indexOf('=') + 1)
        else if (a === '-P' || a === '--directory-prefix') dir = args[i + 1]
        else if (a.startsWith('--directory-prefix=')) dir = a.slice(a.indexOf('=') + 1)
        else if (a === '-o' || a === '-a' || a === '--output-file' || a === '--append-output') {
          if (writes(args[i + 1])) return false
        }
      }
      if (out === '-') continue
      if (out !== undefined) {
        if (writes(out)) return false
        continue
      }
      for (const u of urls.length ? urls : ['']) if (writes(`${dir ? `${dir}/` : ''}${urlName(u)}`)) return false
      continue
    }
    // awk reads, unless its program's print redirects (> or |), it runs something (system, "cmd" | getline), or it
    // edits in place; a > elsewhere compares (NR > 1). A program from a file can't be seen, and counts as writing
    if (AWKS.has(prog)) {
      if (args.some(a => a === '-f' || /^--file(=|$)/.test(a) || a === '--inplace' || (a === '-i' && /^inplace$/.test(String(args[args.indexOf(a) + 1]))) || a === '-iinplace')) return false
      const program = operandsOf(args, /^-[Fvi]$|^--(field-separator|assign|include)$/)[0]
      if (program === undefined || /\bprintf?\b[^;}\n]*[>|]|\|\s*getline|\bsystem\s*\(/.test(program)) return false
      continue
    }
    // sysctl only reads, unless it sets (-w, or a name=value)
    if (prog === 'sysctl') {
      if (args.some(a => /^-[a-zA-Z]*w/.test(a) || /^[^-][^=]*=/.test(a))) return false
      continue
    }
    // A check script of the project's (its .claude/fleet/checks/, which the person stamps: it prints its results) run
    // by python only reads (checkScript says which are: the caller resolves the path, and none while proofs rerun
    // commands); any other script can write anything
    if (/^python[0-9.]*$/.test(prog)) {
      const script = operandsOf(args, /^-[WXc]$/)[0]
      if (args.some(a => a === '-c' || a === '-m') || script === undefined || !checkScript(script)) return false
      continue
    }
    if (!READ_ONLY_PROGRAMS.has(prog)) return false
  }
  return true
}

/** Whether a command names a world file (rel): one of its words resolves to the file or to a folder it's in, or is a
 * glob that matches it (a word with $ in it is one: dir/$x is dir/*). A word after a cd resolves from the cd's folder;
 * after a cd fleet can't follow (cd $X, cd -), a word with no folder names a file of its name anywhere. resolve: a word
 * as a path relative to the project (null: outside it, or not a path). What a command writes and doesn't name lands
 * only if no other session's event explains it (the post-scan's B5 rule) */
export function namesPath(command: string, rel: string, resolve: (word: string) => string | null): boolean {
  let pieces: string[]
  try {
    pieces = topCommands(command.trim())
  } catch {
    return true
  }
  // A cd's folder names nothing it writes (cd <project> && python3 tool.py names no file)
  const isCd = (w: string[]) => ['cd', 'pushd', 'popd'].includes((stripPrefixes(w)[0] ?? '').split('/').pop() ?? '')
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  // Where the words resolve from: '' the session's folder, a path (relative to it, or absolute), null a cd not followed
  let dir: string | null = ''
  const under = (d: string, w: string) => (w.startsWith('/') || w === '~' || w.startsWith('~/') || !d ? w : `${d.replace(/\/+$/, '')}/${w}`)
  const names = (w: string, d: string | null): boolean => {
    if (!w || w.startsWith('-')) return false
    const glob = /\$/.test(w) ? w.replace(/\$\([^)]*\)|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]/g, '*') : w
    if (/[*?[{]/.test(glob)) {
      const r = resolve(d === null ? glob : under(d, glob))
      try {
        if ((r !== null && globRegex(r, false).test(rel)) || (d === null && !glob.includes('/') && globRegex(glob, false).test(base))) return true
      } catch {}
      return false
    }
    const r = resolve(d === null ? w : under(d, w))
    if (r !== null && (r === rel || rel.startsWith(`${r.replace(/\/+$/, '')}/`) || r === '')) return true
    return d === null && !w.includes('/') && w === base
  }
  const strip = (w: string) => w.replace(/^--?[A-Za-z][\w-]*=/, '')
  for (const piece of pieces) {
    const targets: string[] = []
    let cmds: string[][]
    try {
      cmds = commandsOf(piece, 0, targets)
    } catch {
      return true
    }
    const from = dir
    for (const c of cmds) {
      const w = stripPrefixes(c)
      if (isCd(c)) {
        const to = w[1]
        dir = dir === null || w[0]?.endsWith('popd') || to === undefined || to === '-' || to.includes('$') ? null : under(dir, to)
        continue
      }
      if (w.map(strip).some(x => names(x, dir))) return true
    }
    // A redirection's place among the piece's commands isn't kept: it resolves from where the piece started or ended
    if (targets.map(strip).some(t => names(t, from) || names(t, dir))) return true
  }
  return false
}

/** A shell line's commands as written, split where one ends (; & | && || and a new line), quotes, $( … ), ( … ) and
 * backticks kept whole; a line with a here-document keeps its lines together (its body isn't commands) */
function topCommands(line: string): string[] {
  const out: string[] = []
  const heredoc = line.includes('<<')
  let cur = ''
  let depth = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    if (ch === "'" || ch === '`') {
      const end = line.indexOf(ch, i + 1)
      const j = end < 0 ? line.length - 1 : end
      cur += line.slice(i, j + 1)
      i = j
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1
      cur += line.slice(i, j + 1)
      i = j
      continue
    }
    if (ch === '\\') {
      cur += line.slice(i, i + 2)
      i++
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    const split = depth === 0 && (ch === ';' || ch === '|' || (ch === '\n' && !heredoc) || (ch === '&' && !/[<>]$/.test(cur) && line[i + 1] !== '>'))
    if (split) {
      if (cur.trim()) out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** A temporary file another program writes beside a world file and renames over it (an editor's or a tool's
 * <name>.tmp.<pid>.<n>): never a landing of its own */
export function isTempName(rel: string): boolean {
  return /\.tmp\.\d+(\.|$)/.test(rel.slice(rel.lastIndexOf('/') + 1))
}

/** Where a volume's way with case can be seen: the path with its deepest name that has letters in another case (null
 * when no name has any) */
export function caseProbe(path: string): string | null {
  const parts = path.split('/')
  for (let i = parts.length - 1; i > 0; i--) {
    const p = parts[i] as string
    const flipped = [...p].map(c => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('')
    if (flipped !== p) return [...parts.slice(0, i), flipped, ...parts.slice(i + 1)].join('/')
  }
  return null
}

// ---- The digest: what a thread hears at its next step ----

export type DigestItem = { path: string; event: ChangeEvent }

/** The world files this thread read whose newest event is someone else's and that it hasn't read or been told since.
 * thread: 'main' or a helper's agentId; reads and the gate are per thread, so a helper's landing is news to main */
export function digestItems(reads: Readonly<Record<string, FleetRead>> | undefined, latest: ReadonlyMap<string, ChangeEvent>, me: Me, thread = 'main'): DigestItem[] {
  const out: DigestItem[] = []
  for (const [path, r] of Object.entries(reads ?? {})) {
    const e = latest.get(path)
    if (!e || e.to === r.v || e.to === r.told || e.at < r.at) continue
    // This thread's own landings aren't news to it (another thread's of this session are: a helper's to main, and the
    // reverse); the person's stamp typed here is (his change, not the model's)
    if (e.by?.sessionId && e.by.sessionId === me.sessionId && (e.by.agentId ?? 'main') === thread && !e.by.person) continue
    out.push({ path, event: e })
  }
  return out.sort((a, b) => b.event.at - a.event.at || a.path.localeCompare(b.path))
}

/** At most DIGEST_LINES files, then one line for the rest. Never a file's content */
export function digestText(items: readonly DigestItem[], me: Me): string {
  const shown = items.slice(0, DIGEST_LINES)
  const lines = [
    `fleet: ${items.length === 1 ? 'a shared file you read has' : `${items.length} shared files you read have`} changed since you read ${items.length === 1 ? 'it' : 'them'}. Read ${items.length === 1 ? 'it' : 'them'} again before you rely on ${items.length === 1 ? 'it' : 'them'} or write ${items.length === 1 ? 'it' : 'them'}:`,
    ...shown.map(i => `- ${i.path}: ${changeLine(i.event, me)}`),
  ]
  const rest = items.slice(DIGEST_LINES)
  if (rest.length) {
    const names = rest.map(i => i.path).join(', ')
    lines.push(`- and ${rest.length} more: ${names.length > 300 ? `${cut(names, 300)}…` : names}`)
  }
  return lines.join('\n')
}

// ---- Bash: the reads it makes (the engine's own list: one file, no pipes or redirections) ----

const READERS = /^(?:cat|nl|bat|batcat|head|tail)$/

/** The file a simple read command names (cat x, head -n 5 x, sed -n '1,20p' x), or null */
export function bashReadTarget(command: string): string | null {
  const c = command.trim()
  if (!c || /[|;&<>`]|\$\(|\n/.test(c)) return null
  const words = c.match(/'[^']*'|"[^"]*"|\S+/g) ?? []
  const unq = (w: string) => w.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1')
  const [cmd = '', ...rest] = words.map(unq)
  let args = rest
  if (cmd === 'sed') {
    if (args[0] !== '-n' || !/^\d+(,\d+)?p$/.test(args[1] ?? '')) return null
    args = args.slice(2)
  } else if (READERS.test(cmd)) {
    const files: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string
      if (a === '-n' || a === '-c') i++
      else if (!a.startsWith('-')) files.push(a)
    }
    args = files
  } else return null
  return args.length === 1 ? (args[0] as string) : null
}

// ---- The post-scan: what a command, or the world outside, changed ----

export type Snapshot = Map<string, { mtimeMs: number; size: number }>

/** The paths that appeared, went, or whose size or modification time moved */
export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = []
  for (const [p, a] of after) {
    const b = before.get(p)
    if (!b || b.mtimeMs !== a.mtimeMs || b.size !== a.size) out.push(p)
  }
  for (const p of before.keys()) if (!after.has(p)) out.push(p)
  return out.sort()
}

// ---- /fleet accept ----

/** Whether the person can stamp a world file's current version as his: only one nobody's landing explains */
export function acceptable(last: ChangeEvent | null, current: string | null): 'ok' | 'missing' | 'already' | { by: ChangeEvent } {
  if (current === null) return 'missing'
  if (!last || last.to !== current || last.via === 'outside' || last.probably) return 'ok'
  if (last.via === 'accept') return 'already'
  return { by: last }
}

// ---- Reads files ----

export function parseReads(text: string): ReadsFile | { otherFormat: number } | null {
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object') return null
    if (v.format !== FORMAT) return { otherFormat: Number(v.format) || 0 }
    if (typeof v.sessionId !== 'string' || !v.threads || typeof v.threads !== 'object') return null
    return v as ReadsFile
  } catch {
    return null
  }
}

/** The world files of one session that changed since its threads read them: path → the thread(s) */
export function staleOf(threads: Threads, current: (path: string) => string | null | undefined): { path: string; thread: string }[] {
  const out: { path: string; thread: string }[] = []
  for (const [thread, files] of Object.entries(threads)) {
    for (const [path, r] of Object.entries(files)) {
      const c = current(path)
      if (c !== undefined && c !== r.v) out.push({ path, thread })
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.thread.localeCompare(b.thread))
}
