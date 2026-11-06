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
import { FORMAT, cut } from './decisions'
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
  /** world.json's proofs: the records that must carry a proof, by path or by their kind: line */
  proofs: Proofs | null
  /** world.json's defaultKind: what a landing with no change line counts as under a glob (board items: editorial, so
   * a status or an owner moving flags nobody who cites them); first match wins, revision elsewhere */
  defaultKinds: { glob: string; re: RegExp; kind: ChangeKind }[]
  /** world.json's history: shared registers many write a row of (a list of runs, a log), read like journals: their pins
   * are what a row cited when, never stale, never refused, never a proof's business */
  history: { glob: string; re: RegExp }[]
}
/** Which records must carry a proof: those under these globs, and those whose kind: line names one of these kinds */
export type Proofs = { globs: string[]; res: RegExp[]; kinds: string[] }

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
  /** A hash of the text with its change line taken out and its pins' version numbers blanked (bodyHashOf): a landing
   * whose body is the previous version's is editorial, whatever its change line says (a re-pin never cascades) */
  bodyHash?: string
  /** A change the person applied: by is the person, drafter the session that drafted it (its flags go to the drafter) */
  drafter?: Who
}

/** <project>/.claude/fleet/state/revs/<id>/<n>.by.json: who really landed version n, written once (no-clobber) by the
 * tool landing whose write a peer's post-scan took first as its own blind one (same text). revsOf applies it over the
 * version: its by, its via, and the tool's pin marks in place of the blind claim's suspect ones */
export type RevFix = { format: number; at: number; by: Who | null; via: Via; suspect?: string[]; confirmed?: string[] }

export function parseRevFix(text: string): RevFix | null {
  try {
    const v = JSON.parse(text)
    return v && v.format === FORMAT && typeof v.via === 'string' && 'by' in v ? (v as RevFix) : null
  } catch {
    return null
  }
}

export function withFix(r: Rev, f: RevFix): Rev {
  const { suspect: _s, confirmed: _c, ...rest } = r
  return { ...rest, by: f.by, via: f.via, ...(f.suspect?.length ? { suspect: f.suspect } : {}), ...(f.confirmed?.length ? { confirmed: f.confirmed } : {}) }
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
  const p = proofsOf(w, insensitive)
  if ('problem' in p) return p
  const defaultKinds: Records['defaultKinds'] = []
  if (w.defaultKind !== undefined && w.defaultKind !== null) {
    if (typeof w.defaultKind !== 'object' || Array.isArray(w.defaultKind)) return { problem: 'world.json: defaultKind is an object: { "board/**": "editorial" }' }
    for (const [glob, kind] of Object.entries(w.defaultKind as Record<string, unknown>)) {
      const bad = checkGlob(glob)
      if (bad) return { problem: `world.json: defaultKind "${glob}" ${bad}` }
      if (kind !== 'editorial' && kind !== 'revision') return { problem: `world.json: defaultKind "${glob}" is "editorial" or "revision"` }
      defaultKinds.push({ glob, re: globRegex(glob, insensitive), kind })
    }
  }
  const history: Records['history'] = []
  if (w.history !== undefined && w.history !== null) {
    if (!Array.isArray(w.history)) return { problem: 'world.json: history is a list of globs: ["notes/runs.md"]' }
    for (const glob of w.history) {
      if (typeof glob !== 'string') return { problem: 'world.json: history is a list of globs: ["notes/runs.md"]' }
      const bad = checkGlob(glob)
      if (bad) return { problem: `world.json: history "${glob}" ${bad}` }
      history.push({ glob, re: globRegex(glob, insensitive) })
    }
  }
  return { records: { id, pin, changeKey, strict, checks, commitEveryMin, proofs: p.proofs, defaultKinds, history } }
}

/** Whether a path is one of world.json's history registers */
export function isHistoryPath(rel: string, records: Records | null): boolean {
  return !!records && (records.history ?? []).some(h => h.re.test(rel))
}

/** What a landing with no change line counts as at this path (world.json's defaultKind), or null: a revision */
export function defaultKindOf(rel: string, records: Records): ChangeKind | null {
  return records.defaultKinds.find(d => d.re.test(rel))?.kind ?? null
}

function proofsOf(w: WorldConfig, insensitive: boolean): { proofs: Proofs | null } | { problem: string } {
  if (w.proofs === undefined || w.proofs === null) return { proofs: null }
  if (typeof w.proofs !== 'object' || Array.isArray(w.proofs)) return { problem: 'world.json: proofs is an object: { "paths": [globs], "kinds": ["finding", "result"] }' }
  const raw = w.proofs as Record<string, unknown>
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim()) : [])
  const globs = list(raw.paths)
  for (const g of globs) {
    const bad = checkGlob(g)
    if (bad) return { problem: `world.json: proofs path "${g}" ${bad}` }
  }
  const kinds = [...new Set(list(raw.kinds).map(k => k.toLowerCase()))]
  if (kinds.some(k => !/^[a-z][a-z0-9-]{0,39}$/.test(k))) return { problem: "world.json: proofs kinds are words (finding, result), as a record's kind: line names them" }
  return { proofs: globs.length || kinds.length ? { globs, res: globs.map(g => globRegex(g, insensitive)), kinds } : null }
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
  const name = typeof raw.name === 'string' && raw.name.trim() ? cut(raw.name.trim(), 40) : String(script).split('/').pop() || `check ${i + 1}`
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

/** The pins a text cites: every ID@n outside its change line (the line names the move it made, "F-7@2 to F-7@3":
 * history, not what the text rests on), and of each id only the highest version (an older one beside it is history
 * too: "was R-1@2, now R-1@4"). In order of id */
export function pinsOf(text: string, records: Records): Pin[] {
  const best = new Map<string, Pin>()
  for (const m of withoutChangeLine(text, records.changeKey).matchAll(new RegExp(`${records.pin.source}(?:${RANGE_END})?`, 'g'))) {
    // A range in prose (F-7@3–@5, F-7@3..5, F-7@3 to @5) cites where it ends
    const p = { id: m[1] as string, rev: Number(m[3] ?? m[2]) }
    const had = best.get(p.id)
    if (p.rev > 0 && (!had || p.rev > had.rev)) best.set(p.id, p)
  }
  return [...best.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** A text with its change line taken out, and every pin's version number blanked (R-1@4 → R-1@), hashed: two
 * versions with the same body hash differ only in which versions they cite and in their change line, so the second is
 * editorial (a re-pin after a revision elsewhere doesn't cascade to whoever cites this one) */
export function bodyHashOf(text: string, records: Records): string {
  return hashText(withoutChangeLine(text, records.changeKey).replace(new RegExp(`${records.pin.source}(?:${RANGE_END})?`, 'g'), (_m, id: string) => `${id}@`))
}

/** The end of a range of versions after a pin, its number captured: –@5 or — @5 (a dash and an optional @), -@5,
 * ..5 or ..@5, " to @5" */
const RANGE_END = '(?:\\s*[\u2013\u2014]\\s*@?|-@|\\.\\.@?|\\s+to\\s+@)(\\d+)(?![0-9])'

/** Where a text's change line is: the index of its line among the text's lines (the front matter when there is one,
 * else the first 30 lines), or -1 */
function changeLineAt(lines: readonly string[], key: string): number {
  let from = 0
  let to = Math.min(lines.length, 30)
  if (lines[0]?.trim() === '---') {
    const end = lines.slice(1).findIndex(l => l.trim() === '---')
    if (end >= 0) {
      from = 1
      to = end + 1
    }
  }
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`)
  for (let i = from; i < to; i++) if (re.test(lines[i] as string)) return i
  return -1
}

/** A text without its change line (the rest as it is) */
export function withoutChangeLine(text: string, key: string): string {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const i = changeLineAt(lines, key)
  return i < 0 ? text : [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n')
}

/** The change line (`change: "revision: max rate revised down"`), from the front matter when there is one, else the
 * first lines: the kind it names, and a hash of it */
export function changeOf(text: string, key: string): { kind: ChangeKind | null; hash: string } | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const i = changeLineAt(lines, key)
  if (i < 0) return null
  const m = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`).exec(lines[i] as string) as RegExpExecArray
  const value = (m[1] as string).trim().replace(/^["']|["']$/g, '').trim()
  if (!value) return null
  const word = /^([a-z]+)\s*:/i.exec(value)?.[1]?.toLowerCase() ?? ''
  return { kind: (CHANGE_KINDS as readonly string[]).includes(word) ? (word as ChangeKind) : null, hash: hashText(value) }
}

// ---- Proofs: a finding carries source: and quote:, a result run: and sha: ----

/** A proof's sha: the sha256 of the run's output, or its first 12 hex digits at least (sha256: before it is fine) */
const SHA = /^(?:sha256:)?[0-9a-f]{12,64}$/i
/** A quote shorter than this proves nothing */
export const MIN_QUOTE = 10
const PROOF_KEYS = new Set(['kind', 'run', 'sha', 'source', 'quote'])

/** A record's kind: and proof lines, in order, from its front matter when it has one, else its first 30 lines (a value
 * in matching quotes without them) */
export function proofLines(text: string): [string, string][] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  let scope = lines.slice(0, 30)
  if (lines[0]?.trim() === '---') {
    const end = lines.slice(1).findIndex(l => l.trim() === '---')
    scope = end >= 0 ? lines.slice(1, end + 1) : scope
  }
  const out: [string, string][] = []
  for (const line of scope) {
    const m = /^\s*([a-z]+)\s*:\s*(.*)$/.exec(line)
    if (!m || !PROOF_KEYS.has(m[1] as string)) continue
    const v = (m[2] as string).trim()
    out.push([m[1] as string, v.length > 1 && /^(["']).*\1$/s.test(v) ? v.slice(1, -1) : v])
  }
  return out
}

/** Why a world file that must carry a proof doesn't seem to (null: it does, or it needn't). It must when world.json's
 * proofs name its path, or its kind: line names one of their kinds; a proof is a run: then a sha: (12 to 64 hex
 * digits), or a source: then a quote: (MIN_QUOTE characters at least). Valid-looking only: the proofs check script
 * re-runs what the person lets it and compares */
export function proofProblem(text: string | null, rel: string, records: Records): string | null {
  const p = records.proofs
  if (!p || text === null) return null
  const keys = proofLines(text)
  const kind = keys.find(k => k[0] === 'kind')?.[1].trim().toLowerCase() || null
  const byKind = !!kind && p.kinds.includes(kind)
  if (!byKind && !p.res.some(r => r.test(rel))) return null
  let run: string | null = null
  let source: string | null = null
  let bad: string | null = null
  for (const [k, v] of keys) {
    if (k === 'run') run = v.trim() || null
    else if (k === 'source') source = v.trim() || null
    else if (k === 'sha' && run !== null) {
      if (SHA.test(v.trim())) return null
      bad = "its sha: isn't the sha256 of the run's output (12 to 64 hex digits)"
      run = null
    } else if (k === 'quote' && source !== null) {
      if (Array.from(v.trim()).length >= MIN_QUOTE) return null
      bad = `its quote: is too short to prove anything (${MIN_QUOTE} characters at least)`
      source = null
    }
  }
  const what = byKind ? `a ${kind}` : 'a record that must carry a proof'
  if (bad) return `${what}, but ${bad}`
  if (run !== null) return `${what}, with run: but no sha: after it (the sha256 of its output)`
  if (source !== null) return `${what}, with source: but no quote: after it (the exact text it rests on)`
  return `${what} with no proof: run: and sha: (the command, and the sha256 of its output), or source: and quote: (where, and the exact text)`
}

/** How to prove one, in a few words (the gate's line, the digest's) */
export const PROOF_HOW =
  'a finding carries kind: finding, source: and quote: (where, and the exact text it rests on); a result carries kind: result, run: and sha: (the command, and the sha256 of its output); .claude/fleet/verify.md says what counts as proof here'

/** A world file the sweeper finds unproven: why, the version it found so, who wrote it last */
export type Unproven = { path: string; id: string | null; owner: Who | null; why: string; v: string | null }

/** What a landing counts as. A new file is an addition, a removed one a retraction; otherwise the change line's kind,
 * and a revision when it names no kind or was left as it was (the convention: rewrite it each time). With no change
 * line at all, the path's default kind (world.json's defaultKind: board items editorial), else a revision. A body
 * that is the previous version's (bodyHashOf: only pins' numbers or the change line moved) is editorial */
export function landingKind(change: { kind: ChangeKind | null; hash: string } | null, prev: Rev | null, removed: boolean, more: { defaultKind?: ChangeKind | null; bodyHash?: string } = {}): ChangeKind {
  if (removed) return 'retraction'
  if (!prev || prev.hash === null) return change?.kind && change.kind !== 'retraction' ? change.kind : 'addition'
  const kind = !change ? (more.defaultKind ?? 'revision') : !change.kind || change.hash === prev.changeHash ? 'revision' : change.kind
  if (kind === 'revision' && more.bodyHash && prev.bodyHash && more.bodyHash === prev.bodyHash) return 'editorial'
  return kind
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
  /** When the oldest of them landed: since when the pin has been stale */
  firstAt?: number
}

export function pinState(pin: Pin, revs: readonly Rev[] | undefined): PinState {
  if (!revs || !revs.length) return { pin, state: 'unknown', now: 0 }
  const now = Math.max(...revs.map(r => r.rev))
  if (pin.rev > now) return { pin, state: 'ahead', now }
  const movers = revs.filter(r => r.rev > pin.rev && STALE_KINDS.has(r.kind)).sort((a, b) => b.rev - a.rev)
  const moved = movers[0]
  return moved ? { pin, state: 'stale', now, moved, firstAt: Math.min(...movers.map(r => r.at)) } : { pin, state: 'current', now }
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
 * isn't suspect for them until a revision or a retraction of the record lands past that version (an editorial one
 * doesn't count: keptAt) */
export function confirmedPins(states: readonly PinState[], readOf: (id: string) => ReadState): string[] {
  return states.filter(s => s.state === 'stale' && readOf(s.pin.id) === 'current').map(s => `${pinKey(s.pin)}>${s.now}`)
}

/** Whether a stale pin is kept: a confirmation of it ("<pin>><version>", by its writer's landing or mcp__fleet__confirm)
 * at a version at or past the record's newest revision or retraction. An editorial version since spends nothing */
export function keptAt(confirmed: readonly string[] | undefined, pin: string, st: PinState): boolean {
  if (st.state !== 'stale' || !confirmed?.length) return false
  const moved = st.moved?.rev ?? Infinity
  return confirmed.some(c => {
    const at = c.lastIndexOf('>')
    return at > 0 && c.slice(0, at) === pin && Number(c.slice(at + 1)) >= moved
  })
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
  return `- ${cite}: ${p.pin.id} is at v${p.state.now} now (${revWords(moved, me)}). Read ${where}, decide whether your work still holds, then cite ${p.pin.id}@${p.state.now}, or say in your record why v${p.pin.rev} still holds (files of yours you aren't rewriting: once checked, mcp__fleet__confirm with of ${p.pin.id} clears their flags with no new version).`
}

/** The gate's words for the pins of a write it refuses */
export function pinsText(problems: readonly PinProblem[], me: Me, canDecide: boolean): string {
  const shown = problems.slice(0, MAX_LINES)
  const lines = [`fleet: this write cites records you need to read first (this write was not made):`, ...shown.map(p => problemLine(p, me))]
  if (problems.length > shown.length) lines.push(`- and ${problems.length - shown.length} more: ${problems.slice(MAX_LINES).map(p => pinKey(p.pin)).join(', ')}`)
  lines.push(`A read is the Read tool, or one file shown by cat, head, tail, nl or sed -n N,Mp alone (a grep or a pipe doesn't count). Then write again.${canDecide ? ' If what changed contradicts your task, ask the person with mcp__fleet__decide.' : ''}`)
  return lines.join('\n')
}

/** After an Edit that left pins elsewhere in the file needing a read (the gate refuses an Edit only for the pins it
 * writes): the file stays flagged to its writer until they're checked */
export function elsewhereText(rel: string, problems: readonly PinProblem[]): string {
  const what = problems
    .slice(0, MAX_LINES)
    .map(p => (p.why === 'unread' ? `${pinKey(p.pin)} (you haven't read ${p.pin.id})` : `${pinKey(p.pin)} (${p.pin.id} is at v${p.state.now})`))
    .join(', ')
  return `fleet: ${rel} still cites ${what}, outside what you edited. It stays flagged to you until that's checked: read what it cites, then re-pin it, or say it holds with mcp__fleet__confirm.`
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

/** ... and with one that has no change line: every edit of it is a revision, so citing it by version flags whatever
 * cites it at each edit (a journal never is: it's history) */
export function uncitedText(id: string, rev: number, key: string): string {
  return `fleet: this is ${id}@${rev}. It has no ${key}: line, so every edit of it counts as a revision: cite it by version only where what you write rests on what it says now (a status or an owner isn't that).`
}

/** ... and with one whose path is editorial by default (world.json defaultKind): an edit tells whoever cites it only
 * when its change line says it's a revision */
export function editorialText(id: string, rev: number, key: string): string {
  return `fleet: this is ${id}@${rev} (cite it so). An edit of it is editorial unless its ${key}: line says "revision: …" (what it says changed): only then does fleet tell whoever cites it.`
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
  /** stale: when the oldest move since the cited version landed (a derived document's longest wait counts from it) */
  first?: number
}
export type Suspect = { path: string; id: string | null; owner: Who | null; reasons: Reason[]; via?: string[] }
/** derived: the derived documents among the suspects a revised record made stale (derived.ts), for their owners */
export type SuspectsFile = { format: number; at: number; by: string; suspects: Suspect[]; derived?: DerivedStale[]; unproven?: Unproven[] }
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
      if (st.state === 'current' || keptAt(f.confirmed, s, st)) continue
      const m = st.moved
      reasons.push({ why: st.state, pin: s, of: pin.id, ...(st.now ? { now: st.now } : {}), ...(m ? { moved: { rev: m.rev, kind: m.kind, at: m.at, by: m.by, hash: m.hash } } : {}), ...(st.firstAt !== undefined ? { first: st.firstAt } : {}) })
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

/** An owner's lines for its suspects (the digest): a real flag one line each, and the files only behind one move one line
 * a move ("- 12 file(s) behind R-1@4 (a revision at 12:00 by TEST R): notes/a.md, …. Read R-1, then re-pin them, or
 * once checked say they hold with mcp__fleet__confirm (of: R-1), with no new version"). keys: the suspects each line
 * covers (suspectKey), told once */
export function ownSuspectLines(suspects: readonly Suspect[], me: Me): { line: string; keys: string[] }[] {
  const out: { line: string; keys: string[] }[] = []
  const groups = new Map<string, Suspect[]>()
  for (const s of suspects) {
    const m = movesOf(s)
    if (m && m.length === 1) groups.set(m[0]?.move as string, [...(groups.get(m[0]?.move as string) ?? []), s])
    else out.push({ line: `- ${suspectLine(s, me)}`, keys: [suspectKey(s)] })
  }
  for (const [move, list] of groups) {
    if (list.length === 1) {
      out.push({ line: `- ${suspectLine(list[0] as Suspect, me)}`, keys: [suspectKey(list[0] as Suspect)] })
      continue
    }
    const r = (list[0] as Suspect).reasons[0] as Reason
    const shown = list.slice(0, 6).map(s => s.path)
    const more = list.length > shown.length ? `, and ${list.length - shown.length} more` : ''
    out.push({
      line: `- ${list.length} file(s) behind ${move}${r.moved ? ` (${revWords(r.moved, me)})` : ''}: ${shown.join(', ')}${more}. Read ${r.of}, then re-pin them, or once checked say they still hold with mcp__fleet__confirm (of: ${r.of}), with no new version`,
      keys: list.map(suspectKey),
    })
  }
  return out
}

/** A suspect that is only behind moves (every reason a stale pin): the moves, as "<id>@<version now>" with when the
 * newest of them landed. null: a real flag (a pin ahead of its record, of no record, a blind landing) or indirect */
export function movesOf(s: Suspect): { move: string; at: number }[] | null {
  if (!s.reasons.length || s.reasons.some(r => r.why !== 'stale')) return null
  return s.reasons.map(r => ({ move: `${r.of}@${r.now ?? 0}`, at: r.moved?.at ?? 0 }))
}

/** The suspects only behind moves, grouped by the move that caused them (one file behind two moves counts in each),
 * biggest first: what a revision of R-1 made stale reads as one line, "20 behind R-1@4", so the real flags stand
 * apart. owners: how many of each group's files each writer owns; nobody: the files no session is told of (ownerName
 * null: written outside fleet, or by the person) */
export type Behind = { move: string; at: number; files: number; owners: Record<string, number>; nobody: string[] }
export function behindGroups(suspects: readonly Suspect[], ownerName: (s: Suspect) => string | null): Behind[] {
  const groups = new Map<string, Behind>()
  for (const s of suspects) {
    for (const m of movesOf(s) ?? []) {
      const g = groups.get(m.move) ?? { move: m.move, at: m.at, files: 0, owners: {}, nobody: [] }
      g.files++
      g.at = Math.max(g.at, m.at)
      const o = ownerName(s)
      if (o === null) g.nobody.push(s.path)
      else g.owners[o] = (g.owners[o] ?? 0) + 1
      groups.set(m.move, g)
    }
  }
  return [...groups.values()].sort((a, b) => b.files - a.files || b.at - a.at || a.move.localeCompare(b.move))
}

/** A group of files behind one move, as status and the brief say it: "20 file(s) behind R-1@4 (12:00), owners told:
 * TEST A 12, TEST B 5; nobody to tell: 3 (notes/x.md, …)". janitor: who hears the files nobody else is told of */
export function behindLine(g: Behind, me: Me, janitor: string | null = null): string {
  const owners = Object.entries(g.owners)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([o, n]) => `${o} ${n}`)
  const told = owners.length ? `owners told: ${owners.slice(0, 6).join(', ')}${owners.length > 6 ? ', …' : ''}` : ''
  const shown = g.nobody.slice(0, 3)
  const nobody = g.nobody.length
    ? `${janitor ? `no writer to tell, so ${janitor} is told` : 'nobody to tell'}: ${g.nobody.length} (${shown.join(', ')}${g.nobody.length > shown.length ? ', …' : ''})`
    : ''
  return `${g.files} file(s) behind ${g.move}${g.at ? ` (${clock(g.at, me.offsetMin)})` : ''}, ${[told, nobody].filter(Boolean).join('; ')}`
}

export const CONFIRM_SCHEMA = {
  type: 'object',
  required: ['of'],
  properties: {
    of: { type: 'string', maxLength: 80, description: 'The record, as it is now: its id (R-1) or its current version (R-1@4). Read it first' },
    paths: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 500 }, description: "Optional: the shared files you checked against it (each one you didn't write last, read as it is now first); by default every shared file you wrote last that cites it" },
    why: { type: 'string', maxLength: 300, description: 'Optional: why they still hold, in one line' },
  },
} as const

export const CONFIRM_DESCRIPTION =
  "Say that shared files you checked still hold against a record as it is now, after it was revised. Call it when fleet flags files of yours for citing an older version of a record (\"cites R-1@2, and R-1 is at v4\") and you read the record and found they still hold: their flags for it clear with no new version of them (no re-pin edit, so nothing cascades to whoever cites them). Name the files, or leave paths out for every shared file you wrote last that cites it. If the record is revised again, or a file is edited since, it's flagged again. When a file doesn't hold, fix it instead."

/** The local sources a record's proofs quote (source: lines, a :12 or #part after a path also taken without it): when
 * one lands, the record's quote is checked again */
export function quoteSources(text: string): string[] {
  const out = new Set<string>()
  for (const [k, v] of proofLines(text)) {
    const src = v.trim().replace(/^\.\//, '')
    if (k !== 'source' || !src || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(src)) continue
    out.add(src)
    const m = /^(.+?)(?::\d+(?:-\d+)?|#.*)$/.exec(src)
    if (m) out.add(m[1] as string)
  }
  return [...out]
}

/** One session's word that files it checked still hold against a record as it is now (mcp__fleet__confirm):
 * <project>/.claude/fleet/state/confirms/<name>.json, written once. It clears their stale pins of that record without
 * a new version, while each file is at the version it checked (versions: path → its version then) and until a
 * revision or a retraction of the record lands past rev */
export type Confirmation = { format: number; at: number; by: Who; of: string; rev: number; paths: string[]; versions?: Record<string, string>; why?: string }

export function parseConfirmation(text: string): Confirmation | null {
  try {
    const v = JSON.parse(text)
    if (!v || v.format !== FORMAT || typeof v.of !== 'string' || typeof v.rev !== 'number' || !Array.isArray(v.paths) || !v.by) return null
    const versions: Record<string, string> = {}
    if (v.versions && typeof v.versions === 'object') for (const [p, x] of Object.entries(v.versions)) if (typeof x === 'string') versions[p] = x
    return { ...v, paths: v.paths.filter((p: unknown): p is string => typeof p === 'string'), versions } as Confirmation
  } catch {
    return null
  }
}

/** What confirmations make of a file's pins, as Facts.confirmed reads them: "<pin>><version>" for each pin of a
 * confirmed record, while the file is at the version that was checked (v: its version now; an edit since needs its
 * own check). suspectsOf passes it until the record is revised past that version */
export function confirmedBy(path: string, v: string | null | undefined, pins: readonly string[], confs: readonly Confirmation[]): string[] {
  const out: string[] = []
  for (const c of confs) {
    if (!c.paths.includes(path) || !v || c.versions?.[path] !== v) continue
    for (const s of pins) if (parsePin(s)?.id === c.of) out.push(`${s}>${c.rev}`)
  }
  return out
}

/** A key per suspect state: an owner hears each one once (a stale pin by the move that made it stale: an editorial
 * version since isn't news) */
export function suspectKey(s: Suspect): string {
  return `${s.path}|${s.reasons.map(r => `${r.why}:${r.pin}:${r.why === 'stale' ? (r.moved?.rev ?? r.now ?? '') : (r.now ?? '')}`).join(',')}|${(s.via ?? []).join(',')}`
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
  // A script's output goes to the model as the failure's message: never ending on half a character
  const short = (s: string) => (s.length > 300 ? `${cut(s, 300)}…` : s)
  let named = false
  for (const p of paths) {
    const mine = lines.filter(l => l === p || l.startsWith(`${p}:`) || l.startsWith(`${p} `) || l.startsWith(`./${p}:`) || l.startsWith(`./${p} `))
    if (!mine.length) continue
    named = true
    out.set(p, short(mine.map(l => l.replace(/^\.\//, '').slice(p.length).replace(/^[:\s]+/, '') || 'failed').slice(0, 2).join('; ')))
  }
  if (!named) {
    const msg = short(lines.slice(0, 2).join('; ') || `exit ${r.exitCode}`)
    for (const p of paths) out.set(p, msg)
  }
  return out
}

/** What a check's command line may name of the project, relative to it: every word that isn't an option, the command
 * included (check.py, ./tools/lint.sh, an absolute path inside one of the project's roots), and the file an
 * indirection reads (make: the Makefile; npm, yarn or pnpm run: package.json). The ones that exist are stamped with
 * the checks and command-level (fleet runs them as the person, with no prompt) */
export function scriptsOf(checks: readonly Pick<Check, 'argv'>[], roots: readonly string[] = []): string[] {
  const out = new Set<string>()
  for (const c of checks) {
    const words = c.argv.filter(a => !a.startsWith('-'))
    const cmd = (c.argv[0] as string).slice((c.argv[0] as string).lastIndexOf('/') + 1)
    if (cmd === 'make' || cmd === 'gmake') for (const m of ['Makefile', 'makefile', 'GNUmakefile']) out.add(m)
    if (['npm', 'yarn', 'pnpm'].includes(cmd)) out.add('package.json')
    for (const w of words) {
      let rel = w
      if (w.startsWith('/')) {
        const r = roots.find(x => x && (w === x || w.startsWith(`${x.replace(/\/+$/, '')}/`)))
        if (!r) continue
        rel = w.slice(r.replace(/\/+$/, '').length + 1)
      }
      rel = rel.replace(/^(\.\/)+/, '')
      if (!rel || rel.split('/').some(s => s === '..' || s === '.' || s === '') || /[*?$`|;&<>]/.test(rel)) continue
      out.add(rel)
    }
  }
  return [...out].sort()
}

/** The stamp of a set of checks: their definitions and their scripts' versions; and the code watch's commands, which the
 * same stamp lets run (code.ts) */
export function checksKey(checks: readonly Check[], scripts: ReadonlyMap<string, string | null>, commands: readonly string[][] = []): string {
  return hashText(JSON.stringify({ checks: checks.map(c => [c.name, c.glob, c.argv, c.when]), scripts: [...scripts].sort(), ...(commands.length ? { commands } : {}) }))
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
