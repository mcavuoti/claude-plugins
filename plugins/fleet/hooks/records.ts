// Pure logic of records, versions and pins (tested in tests/records.test.ts): which shared files are records, the pins
// a text cites, the kind of a landing, whether a pin is still current, the gate's and the post-scan's verdict on the
// pins of a write, suspects, check scripts, the sweeper's lease, world commits and worktree copies. No `$` here.
//
// A record is a shared file whose name starts with an id (R-12.md, R-12-title.md). fleet gives it a version at every
// landing (state/revs/<id>/<n>.json, allocated no-clobber), and a text cites what it relied on as R-12@4 (a pin). A pin
// goes stale when a revision or retraction of its record lands after the cited version: the citing file becomes
// suspect (a flag, never a block), its owner (the session that wrote it last) hears it, and the gate refuses once a
// write that cites a stale version, or a new pin of a record the writing thread never read. A current pin needs no
// re-read. Coordination, not security, as the rest of the world (changes.ts).

import { checkGlob, clock, globRegex, hashText, type Me, type Via, type Who, type WorldConfig } from './changes'
import { FORMAT } from './decisions'
import type { DerivedStale } from './derived'

/** An id: capitals (and digits after the first), a dash, digits. world.json's idPattern replaces it */
export const DEFAULT_ID = '[A-Z][A-Z0-9]*-[0-9]+'
/** The kinds a landing's change line can name (`change: "revision: …"`); only the last two make pins stale */
export const CHANGE_KINDS = ['editorial', 'addition', 'revision', 'retraction'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]
const STALE_KINDS: ReadonlySet<string> = new Set(['revision', 'retraction'])
/** A sweeper's lease older than this is free to take */
export const LEASE_MS = 90000
/** The most problems a refusal or a digest names; the rest on one line */
export const MAX_LINES = 10

export type Pin = { id: string; rev: number }
export type Check = {
  name: string
  glob: string
  re: RegExp
  argv: string[]
  /** land: after each landing of a matching file (and caught up by the sweeper); sweep: every everyMin minutes */
  when: 'land' | 'sweep'
  everyMin: number
  timeoutMs: number
  /** What its results are stamped with: a result of another definition is out of date */
  key: string
}
/** What world.json says about records, beyond the globs. Absent keys mean off */
export type Records = {
  id: RegExp
  pin: RegExp
  changeKey: string
  strict: 'all' | RegExp[] | null
  checks: Check[]
  commitEveryMin: number | null
}

/** One version of a record: <project>/.claude/fleet/state/revs/<id>/<rev>.json, written once */
export type Rev = {
  format: number
  id: string
  path: string
  rev: number
  /** The file's version (changes.ts hashText); null: the file was removed */
  hash: string | null
  kind: ChangeKind
  /** A hash of the change line, to tell a new one from one left as it was (never the line itself) */
  changeHash: string | null
  at: number
  by: Who | null
  /** base: the version fleet found a record at, before any landing it saw */
  via: Via | 'base'
  pins: string[]
  /** It landed without the gate (a Bash command) citing pins its thread hadn't read as they are: what and why */
  suspect?: string[]
  /** Stale pins it kept on purpose: the writing thread had read the cited record as it was then ("R-1@1>3": R-1@1,
   * kept with R-1 read at v3). They don't make the file suspect until the record moves again */
  confirmed?: string[]
}

// ---- world.json: idPattern, keys.change, strict, checks, commit ----

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

/** What world.json says about records, or what's wrong with it */
export function recordsOf(w: WorldConfig, insensitive: boolean): { records: Records } | { problem: string } {
  const source = typeof w.idPattern === 'string' && w.idPattern.trim() ? w.idPattern.trim() : DEFAULT_ID
  let id: RegExp
  let pin: RegExp
  try {
    if (/[()^$@]/.test(source)) return { problem: 'world.json: idPattern takes no groups, anchors or @ (fleet adds them)' }
    id = new RegExp(`^(${source})(?![A-Za-z0-9])`)
    pin = new RegExp(`(?<![A-Za-z0-9_-])(${source})@(\\d+)(?![0-9])`, 'g')
    if (id.test('') || id.test('-')) return { problem: 'world.json: idPattern matches an empty name' }
  } catch {
    return { problem: `world.json: idPattern "${source}" isn't a valid pattern` }
  }
  const keys = (w.keys && typeof w.keys === 'object' ? w.keys : {}) as Record<string, unknown>
  const changeKey = typeof keys.change === 'string' && /^[A-Za-z_][\w-]*$/.test(keys.change) ? keys.change : 'change'
  let strict: Records['strict'] = null
  if (w.strict === true) strict = 'all'
  else if (Array.isArray(w.strict)) {
    const globs = w.strict.filter((g): g is string => typeof g === 'string')
    for (const g of globs) {
      const bad = checkGlob(g)
      if (bad) return { problem: `world.json: strict "${g}" ${bad}` }
    }
    strict = globs.map(g => globRegex(g, insensitive))
  }
  const checks: Check[] = []
  for (const [i, raw] of (Array.isArray(w.checks) ? w.checks : []).entries()) {
    const c = parseCheck(raw, i, insensitive)
    if ('problem' in c) return c
    if (checks.some(x => x.name === c.check.name)) return { problem: `world.json: two checks are named ${c.check.name} (give one a "name")` }
    checks.push(c.check)
  }
  const every = (w.commit && typeof w.commit === 'object' ? (w.commit as Record<string, unknown>).everyMin : undefined) as unknown
  const commitEveryMin = typeof every === 'number' && every > 0 ? num(every, 1, 24 * 60, 60) : null
  return { records: { id, pin, changeKey, strict, checks, commitEveryMin } }
}

function parseCheck(raw: any, i: number, insensitive: boolean): { check: Check } | { problem: string } {
  const where = `world.json: check ${i + 1}`
  if (!raw || typeof raw !== 'object') return { problem: `${where} isn't an object` }
  const glob = typeof raw.glob === 'string' ? raw.glob : ''
  const bad = checkGlob(glob)
  if (bad) return { problem: `${where}: glob "${glob}" ${bad}` }
  const argv = Array.isArray(raw.argv) ? raw.argv : []
  if (!argv.length || argv.some((a: unknown) => typeof a !== 'string' || !a)) return { problem: `${where}: argv is a list of words, the command first` }
  const when = raw.when === 'sweep' ? 'sweep' : raw.when === undefined || raw.when === 'land' ? 'land' : null
  if (!when) return { problem: `${where}: when is "land" or "sweep"` }
  const script = [...argv].reverse().find((a: string) => /[/.]/.test(a)) ?? argv[0]
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : String(script).split('/').pop() || `check ${i + 1}`
  return {
    check: {
      name,
      glob,
      re: globRegex(glob, insensitive),
      argv,
      when,
      everyMin: num(raw.everyMin, 1, 24 * 60, 10),
      timeoutMs: num(raw.timeoutMs, 1000, 120000, 20000),
      key: hashText(JSON.stringify({ glob, argv })),
    },
  }
}

/** Under strict, the gate refuses until the write is right: no second try passes */
export function isStrict(records: Records | null, rel: string): boolean {
  if (!records || !records.strict) return false
  return records.strict === 'all' || records.strict.some(r => r.test(rel))
}

// ---- Ids, pins, change lines ----

/** The id a shared file's name starts with, or null: R-12.md and R-12-title.md are R-12 */
export function idOf(rel: string, records: Records): string | null {
  const m = records.id.exec(rel.slice(rel.lastIndexOf('/') + 1))
  return m ? (m[1] as string) : null
}

export function pinKey(p: Pin): string {
  return `${p.id}@${p.rev}`
}

export function parsePin(s: string): Pin | null {
  const m = /^(.+)@(\d+)$/.exec(s)
  return m ? { id: m[1] as string, rev: Number(m[2]) } : null
}

/** Every ID@n a text cites, once each, in order of id and version */
export function pinsOf(text: string, records: Records): Pin[] {
  const seen = new Map<string, Pin>()
  for (const m of text.matchAll(new RegExp(records.pin.source, 'g'))) {
    const p = { id: m[1] as string, rev: Number(m[2]) }
    if (p.rev > 0) seen.set(pinKey(p), p)
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id) || a.rev - b.rev)
}

/** The change line (`change: "revision: max rate revised down"`), from the front matter when there is one, else the
 * first lines: the kind it names, and a hash of it */
export function changeOf(text: string, key: string): { kind: ChangeKind | null; hash: string } | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  let scope = lines.slice(0, 30)
  if (lines[0]?.trim() === '---') {
    const end = lines.slice(1).findIndex(l => l.trim() === '---')
    scope = end >= 0 ? lines.slice(1, end + 1) : scope
  }
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`)
  for (const line of scope) {
    const m = re.exec(line)
    if (!m) continue
    const value = (m[1] as string).trim().replace(/^["']|["']$/g, '').trim()
    if (!value) return null
    const word = /^([a-z]+)\s*:/i.exec(value)?.[1]?.toLowerCase() ?? ''
    return { kind: (CHANGE_KINDS as readonly string[]).includes(word) ? (word as ChangeKind) : null, hash: hashText(value) }
  }
  return null
}

/** What a landing counts as. A new file is an addition, a removed one a retraction; otherwise the change line's kind,
 * and a revision when there is none, it names no kind, or it was left as it was (the convention: rewrite it each time) */
export function landingKind(change: { kind: ChangeKind | null; hash: string } | null, prev: Rev | null, removed: boolean): ChangeKind {
  if (removed) return 'retraction'
  if (!prev || prev.hash === null) return change?.kind && change.kind !== 'retraction' ? change.kind : 'addition'
  if (!change || !change.kind || change.hash === prev.changeHash) return 'revision'
  return change.kind
}

export function parseRev(text: string): Rev | null {
  try {
    const v = JSON.parse(text)
    if (!v || v.format !== FORMAT || typeof v.id !== 'string' || typeof v.rev !== 'number') return null
    return v as Rev
  } catch {
    return null
  }
}

// ---- Is a pin current ----

export type PinState = {
  pin: Pin
  /** current: nothing that matters landed since; stale: a revision or retraction did; ahead: no such version yet;
   * unknown: no record has that id */
  state: 'current' | 'stale' | 'ahead' | 'unknown'
  /** The record's newest version */
  now: number
  /** The newest revision or retraction after the cited version */
  moved?: Rev
}

export function pinState(pin: Pin, revs: readonly Rev[] | undefined): PinState {
  if (!revs || !revs.length) return { pin, state: 'unknown', now: 0 }
  const now = Math.max(...revs.map(r => r.rev))
  if (pin.rev > now) return { pin, state: 'ahead', now }
  const moved = revs.filter(r => r.rev > pin.rev && STALE_KINDS.has(r.kind)).sort((a, b) => b.rev - a.rev)[0]
  return moved ? { pin, state: 'stale', now, moved } : { pin, state: 'current', now }
}

/** How the writing thread read a record: the version there now, an older one, or never in this conversation */
export type ReadState = 'current' | 'older' | 'never'
export type PinProblem = { pin: Pin; why: 'stale' | 'ahead' | 'unread'; state: PinState; path: string | null }

/** The pins of a write that need a read first: a stale or impossible version this thread hasn't read as it is now, or a
 * pin the write adds for a record this thread never read. A pin the file had already, still current, needs nothing:
 * a big document citing many records doesn't re-read them all at each landing. Unknown ids are never held */
export function pinProblems(
  pins: readonly Pin[],
  before: ReadonlySet<string>,
  stateOf: (p: Pin) => PinState,
  readOf: (id: string) => ReadState,
  pathOf: (id: string) => string | null,
): PinProblem[] {
  const out: PinProblem[] = []
  for (const pin of pins) {
    const state = stateOf(pin)
    if (state.state === 'unknown') continue
    const read = readOf(pin.id)
    if ((state.state === 'stale' || state.state === 'ahead') && read !== 'current') out.push({ pin, why: state.state, state, path: pathOf(pin.id) })
    else if (!before.has(pinKey(pin)) && read === 'never') out.push({ pin, why: 'unread', state, path: pathOf(pin.id) })
  }
  return out
}

/** What the gate remembers it told: one key per problem (a second try with nothing new passes) */
/** The stale pins a write keeps although its thread read the record as it is now: it confirmed them, and the file
 * isn't suspect for them until the record moves again */
export function confirmedPins(states: readonly PinState[], readOf: (id: string) => ReadState): string[] {
  return states.filter(s => s.state === 'stale' && readOf(s.pin.id) === 'current').map(s => `${pinKey(s.pin)}>${s.now}`)
}

export function problemKeys(problems: readonly PinProblem[]): string[] {
  return problems.map(p => `${pinKey(p.pin)}:${p.why}:${p.state.now}`).sort()
}

function revWords(r: Pick<Rev, 'kind' | 'hash' | 'at' | 'by'>, me: Me): string {
  const who = !r.by ? 'outside fleet' : r.by.person ? 'by the person' : `by ${r.by.name || r.by.ref || (r.by.sessionId ? `the session ${r.by.sessionId.slice(0, 8)}` : 'a session')}`
  const self = r.by?.sessionId && r.by.sessionId === me.sessionId && !r.by.person ? ' (this session)' : ''
  return `${r.kind === 'retraction' ? (r.hash === null ? 'removed' : 'a retraction') : 'a revision'} at ${clock(r.at, me.offsetMin)} ${who}${self}`
}

function problemLine(p: PinProblem, me: Me): string {
  const where = p.path ?? `the file whose name starts with ${p.pin.id}`
  const cite = pinKey(p.pin)
  if (p.why === 'unread') return `- ${cite}: you haven't read ${p.pin.id} in this conversation. Read ${where} first.`
  if (p.why === 'ahead') return `- ${cite}: ${p.pin.id} is at v${p.state.now}; there's no v${p.pin.rev}. Read ${where} and cite the version you read.`
  const moved = p.state.moved as Rev
  return `- ${cite}: ${p.pin.id} is at v${p.state.now} now (${revWords(moved, me)}). Read ${where}, decide whether your work still holds, then cite ${p.pin.id}@${p.state.now}, or say in your record why v${p.pin.rev} still holds.`
}

/** The gate's words for the pins of a write it refuses */
export function pinsText(problems: readonly PinProblem[], me: Me, canDecide: boolean): string {
  const shown = problems.slice(0, MAX_LINES)
  const lines = [`fleet: this write cites records you need to read first (this write was not made):`, ...shown.map(p => problemLine(p, me))]
  if (problems.length > shown.length) lines.push(`- and ${problems.length - shown.length} more: ${problems.slice(MAX_LINES).map(p => pinKey(p.pin)).join(', ')}`)
  lines.push(`Then write again.${canDecide ? ' If what changed contradicts your task, ask the person with mcp__fleet__decide.' : ''}`)
  return lines.join('\n')
}

/** The post-scan's words when a command wrote a file whose pins its thread hadn't read as they are */
export function blindText(rel: string, problems: readonly PinProblem[], me: Me): string {
  const what = problems
    .slice(0, MAX_LINES)
    .map(p => (p.why === 'unread' ? `${pinKey(p.pin)} (you haven't read ${p.pin.id})` : p.why === 'ahead' ? `${pinKey(p.pin)} (${p.pin.id} is at v${p.state.now})` : `${pinKey(p.pin)} (${p.pin.id} is at v${p.state.now}, ${revWords(p.state.moved as Rev, me)})`))
    .join(', ')
  return `fleet: your command wrote ${rel}, which cites ${what}. It is marked suspect until it lands again: read what it cites, then write ${rel} with Write or Edit.`
}

/** A line after a landing: the record's new version, and pins of no record */
export function landedText(rel: string, id: string | null, rev: number | null, unknown: readonly Pin[], ahead: readonly PinState[]): string | null {
  const parts: string[] = []
  if (id && rev) parts.push(`${rel} is now ${id}@${rev}`)
  if (unknown.length) parts.push(`it cites ${unknown.map(pinKey).join(', ')}, which no shared file is (a record's file name starts with its id)`)
  if (ahead.length) parts.push(`it cites ${ahead.map(s => `${pinKey(s.pin)} (${s.pin.id} is at v${s.now})`).join(', ')}`)
  return parts.length ? `fleet: ${parts.join('; ')}.` : null
}

/** What the model reads with a record it just read */
export function citeText(id: string, rev: number): string {
  return `fleet: this is ${id}@${rev} (cite it so; fleet tells whoever cites it when it changes).`
}

// ---- Suspects ----

export type Reason = {
  why: 'stale' | 'ahead' | 'unknown' | 'blind'
  pin: string
  of: string
  now?: number
  /** blind: why the command's thread should have read it (stale, unread, ahead) */
  detail?: string
  moved?: Pick<Rev, 'rev' | 'kind' | 'at' | 'by' | 'hash'>
}
export type Suspect = { path: string; id: string | null; owner: Who | null; reasons: Reason[]; via?: string[] }
/** derived: the derived documents among the suspects a revised record made stale (derived.ts), for their owners */
export type SuspectsFile = { format: number; at: number; by: string; suspects: Suspect[]; derived?: DerivedStale[] }
/** One world file as the sweeper sees it: its pins, and its last landing (a record's newest version, or the last event) */
export type Facts = { path: string; id: string | null; pins: readonly string[]; owner: Who | null; blind?: readonly string[]; confirmed?: readonly string[] }

/** Direct suspects: a pin stale (unless its last landing kept it after reading the record as it is now), ahead or of
 * no record, or a blind landing whose pins weren't read as they were. Indirect: a file that cites a suspect record
 * (transitively). Sorted by path */
export function suspectsOf(files: readonly Facts[], stateOf: (p: Pin) => PinState): Suspect[] {
  const direct = new Map<string, Suspect>()
  for (const f of files) {
    const reasons: Reason[] = []
    for (const s of f.pins) {
      const pin = parsePin(s)
      if (!pin) continue
      const st = stateOf(pin)
      if (st.state === 'current' || (st.state === 'stale' && f.confirmed?.includes(`${s}>${st.now}`))) continue
      const m = st.moved
      reasons.push({ why: st.state, pin: s, of: pin.id, ...(st.now ? { now: st.now } : {}), ...(m ? { moved: { rev: m.rev, kind: m.kind, at: m.at, by: m.by, hash: m.hash } } : {}) })
    }
    for (const b of f.blind ?? []) {
      const [pin = '', detail = ''] = b.split(':')
      if (reasons.some(r => r.pin === pin)) continue
      reasons.push({ why: 'blind', pin, of: parsePin(pin)?.id ?? pin, detail })
    }
    if (reasons.length) direct.set(f.path, { path: f.path, id: f.id, owner: f.owner, reasons })
  }
  const bad = new Set([...direct.values()].map(s => s.id).filter((x): x is string => !!x))
  const indirect = new Map<string, Suspect>()
  for (let changed = true; changed; ) {
    changed = false
    for (const f of files) {
      if (direct.has(f.path)) continue
      const via = [...new Set(f.pins.map(p => parsePin(p)?.id ?? '').filter(id => bad.has(id)))].sort()
      if (!via.length || indirect.get(f.path)?.via?.join() === via.join()) continue
      indirect.set(f.path, { path: f.path, id: f.id, owner: f.owner, reasons: [], via })
      if (f.id && !bad.has(f.id)) bad.add(f.id)
      changed = true
    }
  }
  return [...direct.values(), ...indirect.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export function parseSuspects(text: string): SuspectsFile | null {
  try {
    const v = JSON.parse(text)
    return v && v.format === FORMAT && Array.isArray(v.suspects) ? (v as SuspectsFile) : null
  } catch {
    return null
  }
}

/** Whether a landing is this session's, so its model is the one to hear about it: the same session, or the same
 * background session after a /clear or a restart (its short id). Never the person's own stamp */
export function ownedBy(who: Who | null | undefined, me: { sessionId: string; ref: string | null }): boolean {
  if (!who || who.person) return false
  return (!!who.sessionId && who.sessionId === me.sessionId) || (!!who.ref && !!me.ref && who.ref === me.ref)
}

/** One line about a suspect, for the person (status) or its owner (digest) */
export function suspectLine(s: Suspect, me: Me): string {
  if (!s.reasons.length) return `${s.path} cites ${(s.via ?? []).join(', ')}, which ${(s.via ?? []).length === 1 ? 'is' : 'are'} suspect`
  const parts = s.reasons.map(r => {
    if (r.why === 'unknown') return `cites ${r.pin}, which no shared file is`
    if (r.why === 'ahead') return `cites ${r.pin}, but ${r.of} is at v${r.now}`
    if (r.why === 'blind') return `landed blind citing ${r.pin}${r.detail === 'unread' ? `, ${r.of} unread` : ''}`
    const m = r.moved
    return `cites ${r.pin}, and ${r.of} is at v${r.now}${m ? ` (${revWords(m, me)})` : ''}`
  })
  return `${s.path}${s.id ? ` (${s.id})` : ''} ${parts.join('; ')}`
}

/** A key per suspect state: an owner hears each one once */
export function suspectKey(s: Suspect): string {
  return `${s.path}|${s.reasons.map(r => `${r.why}:${r.pin}:${r.now ?? ''}`).join(',')}|${(s.via ?? []).join(',')}`
}

// ---- Check scripts ----

/** <project>/.claude/fleet/state/checks/<hash>.json: the last results of every check on one file */
export type CheckFile = {
  format: number
  path: string
  /** The file's version they were made on */
  hash: string | null
  owner: Who | null
  results: Record<string, { key: string; ok: boolean; message?: string; at: number }>
}

export function parseCheckFile(text: string): CheckFile | null {
  try {
    const v = JSON.parse(text)
    return v && v.format === FORMAT && typeof v.path === 'string' && v.results && typeof v.results === 'object' ? (v as CheckFile) : null
  } catch {
    return null
  }
}

/** Whether a check's result on a file is out of date: none yet, another version, or another definition */
export function needsCheck(file: CheckFile | undefined, check: Check, hash: string | null): boolean {
  const r = file?.results[check.name]
  return !r || r.key !== check.key || file?.hash !== hash
}

/** What a run says of each file it was given: null passes, a message fails. Exit 0 passes them all; otherwise a line
 * that starts with a file's path (path: message, path:12: message) fails that file, and when no line names one, every
 * file fails with the first lines. Null when the check couldn't run at all (not found: the person's to fix) */
export function checkOutcome(paths: readonly string[], r: { exitCode: number; stdout: string; stderr: string }): Map<string, string | null> | null {
  const out = new Map<string, string | null>(paths.map(p => [p, null]))
  if (r.exitCode === 0) return out
  if (r.exitCode === 126 || r.exitCode === 127) return null
  const lines = `${r.stdout}\n${r.stderr}`
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  const cut = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s)
  let named = false
  for (const p of paths) {
    const mine = lines.filter(l => l === p || l.startsWith(`${p}:`) || l.startsWith(`${p} `) || l.startsWith(`./${p}:`) || l.startsWith(`./${p} `))
    if (!mine.length) continue
    named = true
    out.set(p, cut(mine.map(l => l.replace(/^\.\//, '').slice(p.length).replace(/^[:\s]+/, '') || 'failed').slice(0, 2).join('; ')))
  }
  if (!named) {
    const msg = cut(lines.slice(0, 2).join('; ') || `exit ${r.exitCode}`)
    for (const p of paths) out.set(p, msg)
  }
  return out
}

/** The files a check script names on its command line (relative to the project): stamped with the checks */
export function scriptsOf(checks: readonly Check[]): string[] {
  return [...new Set(checks.flatMap(c => c.argv.slice(1).concat(c.argv[0] as string).filter(a => !a.startsWith('-') && /\//.test(a) && !a.startsWith('/'))))].sort()
}

/** The stamp of a set of checks: their definitions and their scripts' versions */
export function checksKey(checks: readonly Check[], scripts: ReadonlyMap<string, string | null>): string {
  return hashText(JSON.stringify({ checks: checks.map(c => [c.name, c.glob, c.argv, c.when]), scripts: [...scripts].sort() }))
}

// ---- The sweeper's lease: <project>/.claude/fleet/state/sweeper.json, replaced with mv by whoever holds or takes it ----

export type Lease = { format: number; sessionId: string; ref: string | null; name: string | null; at: number }

export function parseLease(text: string | null): Lease | null {
  if (text === null) return null
  try {
    const v = JSON.parse(text)
    return v && v.format === FORMAT && typeof v.sessionId === 'string' && typeof v.at === 'number' ? (v as Lease) : null
  } catch {
    return null
  }
}

/** mine: this session holds it; free: nobody does (none, too old, or another format's); held: another session does */
export function leaseState(lease: Lease | null, sessionId: string, now: number): 'mine' | 'free' | 'held' {
  if (!lease || now - lease.at > LEASE_MS) return 'free'
  return lease.sessionId === sessionId ? 'mine' : 'held'
}

// ---- World commits ----

/** git status --porcelain=v1 -z: the paths (relative to the repository) and their two-letter state; a rename's
 * source too (it changed as well) */
export function porcelainPaths(stdout: string): { xy: string; path: string }[] {
  const out: { xy: string; path: string }[] = []
  const parts = stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    out.push({ xy, path: entry.slice(3) })
    if (xy[0] === 'R' || xy[0] === 'C') {
      const from = parts[++i]
      if (from) out.push({ xy, path: from })
    }
  }
  return out
}

export function commitMessage(now: number, offsetMin: number): string {
  const d = new Date(now + offsetMin * 60000).toISOString()
  return `fleet: world ${d.slice(0, 10)} ${d.slice(11, 16)}`
}

// ---- Worktree copies ----

/** git worktree list --porcelain: every working tree's folder, the main one first */
export function worktreeFolders(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter(l => l.startsWith('worktree '))
    .map(l => l.slice('worktree '.length).replace(/\/+$/, ''))
}

/** Where a path stands among the linked worktrees: in which one, and the world path it's a copy of (relative to the
 * project, which sits at sub in the repository; '' when the project is the repository's folder). Null: in none */
export function copyOf(abs: string, linked: readonly string[], sub: string, insensitive: boolean): { tree: string; rel: string } | null {
  const fold = (s: string) => (insensitive ? s.toLowerCase() : s)
  const a = fold(abs)
  for (const tree of [...linked].sort((x, y) => y.length - x.length)) {
    if (!a.startsWith(`${fold(tree)}/`)) continue
    let rel = abs.slice(tree.length + 1)
    if (sub) {
      if (!fold(rel).startsWith(`${fold(sub)}/`)) return { tree, rel: '' }
      rel = rel.slice(sub.length + 1)
    }
    return { tree, rel }
  }
  return null
}

/** What the model reads when it writes a worktree's copy of a shared file */
export function copyWriteText(given: string, rel: string, main: string): string {
  return `fleet: ${given} is a worktree's copy of the shared file ${rel}. The project's sessions share the main checkout's copy, ${main}: write that one (read it first) so they see your change. If you can't (this session is isolated in its worktree), or the change belongs to your branch only, write again: it stays in the worktree, and nobody is told (this write was not made).`
}

/** What the model reads when it reads a worktree's copy that differs from the shared file */
export function copyReadText(given: string, rel: string, main: string): string {
  return `fleet: ${given} is a worktree's copy of the shared file ${rel}, and it differs from the main checkout's copy, ${main}, which is the one the project's sessions share. Read that one before you rely on it or cite it.`
}
