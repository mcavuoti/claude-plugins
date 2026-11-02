// Pure logic of derived documents (tested in tests/derived.test.ts): world.json's "derived" kinds (a business plan, the
// proposal, a gap matrix…), documents that rest on records and cite each of them by version (R-12@4). When one of
// those records is revised, the document is stale: its owner hears it once its inputs have been quiet a while (the
// debounce), and is woken for it within its wakes and budget. And no circular authority: a change to a record whose
// only cited authority is a derived document resting on that record is flagged for the person, never applied as
// filed. No `$` here: fleet's code knows paths, ids and versions, never what a business plan says.

import { clock, globRegex, type Me, type WorldConfig } from './changes'
import { parsePin, type Pin, type Rev, type Suspect } from './records'

/** A derived kind: its files (globs), its owner (a role or an instance of the roster), and how long its inputs must be
 * quiet before the owner is told (minutes) */
export type DerivedKind = { kind: string; globs: string[]; res: RegExp[]; owner: string; debounceMin: number }

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export const DEBOUNCE_MIN = 30

/** world.json's "derived": kind → { paths, owner, debounceMin } */
export function derivedOf(w: WorldConfig | null, insensitive: boolean): { kinds: DerivedKind[] } | { problem: string } {
  const d = w?.derived
  if (d === undefined) return { kinds: [] }
  if (!isObject(d)) return { problem: 'world.json: derived is an object, kind → { "paths": [...], "owner": "<role or instance>" }' }
  const kinds: DerivedKind[] = []
  for (const [kind, raw] of Object.entries(d)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(kind)) return { problem: `world.json: derived "${kind}": a kind is letters, digits, - and _` }
    if (!isObject(raw)) return { problem: `world.json: derived ${kind} isn't an object` }
    const globs = (Array.isArray(raw.paths) ? raw.paths : typeof raw.paths === 'string' ? [raw.paths] : []).filter((g): g is string => typeof g === 'string' && !!g.trim())
    if (!globs.length) return { problem: `world.json: derived ${kind} needs paths (its files, as globs)` }
    const owner = typeof raw.owner === 'string' ? raw.owner.trim() : ''
    if (!owner) return { problem: `world.json: derived ${kind} needs an owner (a role or an instance of the roster)` }
    const debounce = typeof raw.debounceMin === 'number' && Number.isFinite(raw.debounceMin) && raw.debounceMin >= 0 ? Math.min(raw.debounceMin, 24 * 60) : DEBOUNCE_MIN
    kinds.push({ kind, globs, res: globs.map(g => globRegex(g, insensitive)), owner, debounceMin: debounce })
  }
  return { kinds }
}

export function derivedKindOf(rel: string, kinds: readonly DerivedKind[]): DerivedKind | null {
  return kinds.find(k => k.res.some(r => r.test(rel))) ?? null
}

/** Whether an instance owns a kind: the owner names it, or its role */
export function ownsKind(k: Pick<DerivedKind, 'owner'>, inst: { name: string; role: string }): boolean {
  const o = k.owner.toLowerCase()
  return inst.name.toLowerCase() === o || inst.role.toLowerCase() === o
}

/** A stale derived document: the pins whose records were revised or retracted since, when the newest of those landed
 * (the debounce counts from there: inputs still moving keep it waiting) and when the oldest did (firstAt: the longest
 * wait counts from there) */
export type DerivedStale = { path: string; kind: string; owner: string; debounceMin: number; pins: { pin: string; now: number }[]; movedAt: number; firstAt?: number; key: string }

/** The derived documents among the suspects that are stale (a cited record moved by a revision or a retraction) */
export function staleDerived(suspects: readonly Suspect[], kinds: readonly DerivedKind[]): DerivedStale[] {
  const out: DerivedStale[] = []
  for (const s of suspects) {
    const k = derivedKindOf(s.path, kinds)
    if (!k) continue
    const moved = s.reasons.filter(r => r.why === 'stale' && r.moved)
    if (!moved.length) continue
    const pins = moved.map(r => ({ pin: r.pin, now: r.now ?? 0 }))
    out.push({ path: s.path, kind: k.kind, owner: k.owner, debounceMin: k.debounceMin, pins, movedAt: Math.max(...moved.map(r => (r.moved as Pick<Rev, 'at'>).at)), firstAt: Math.min(...moved.map(r => r.first ?? (r.moved as Pick<Rev, 'at'>).at)), key: `${s.path}|${pins.map(p => `${p.pin}>${p.now}`).join(',')}` })
  }
  return out
}

/** The longest a stale derived document waits for its inputs to be quiet: 8 × debounceMin from the first move, a day
 * at most (inputs revised more often than the debounce would keep it waiting for good) */
export function maxWaitMs(d: Pick<DerivedStale, 'debounceMin'>): number {
  return Math.min(8 * d.debounceMin, 24 * 60) * 60000
}

/** Its owner is told now (and, retired, woken): its inputs have been quiet debounceMin, or they have kept moving for the
 * longest wait since the first move (or since the owner was last told of it: since) */
export function quietEnough(d: Pick<DerivedStale, 'movedAt' | 'firstAt' | 'debounceMin'>, now: number, since = 0): boolean {
  return now - d.movedAt >= d.debounceMin * 60000 || now - Math.max(d.firstAt ?? d.movedAt, since) >= maxWaitMs(d)
}

/** When its owner is told at the latest, inputs still moving or not */
export function toldBy(d: Pick<DerivedStale, 'movedAt' | 'firstAt' | 'debounceMin'>, since = 0): number {
  return Math.min(d.movedAt + d.debounceMin * 60000, Math.max(d.firstAt ?? d.movedAt, since) + maxWaitMs(d))
}

/** What the owner reads: each stale document, what moved, and that "inputs unchanged" is a landing. now: one whose
 * inputs are still moving (told at the longest wait) says so */
export function derivedText(items: readonly DerivedStale[], me: Me, now = 0): string {
  const lines = [
    'fleet: documents you own are derived from records that moved since they cited them (nothing is held; refresh them when you can):',
    ...items.map(d => `- ${d.path} (${d.kind}): ${d.pins.map(p => `${p.pin} → v${p.now}`).join(', ')}; the last moved at ${clock(d.movedAt, me.offsetMin)}${now && now - d.movedAt < d.debounceMin * 60000 ? ': its inputs are still moving, so refresh what has settled' : ''}`),
    'Read what moved, update what rests on it and cite the new versions; when nothing in it changes, land it citing the versions as they are now ("inputs unchanged since" its last version is a valid landing). A contradiction between inputs goes to their owners (a note, or mcp__fleet__decide), never smoothed over here.',
  ]
  return lines.join('\n')
}

// ---- No circular authority ----

/** A change to a record (targetId, at targetPath) whose cited authority is only derived documents that rest on it: the
 * documents it leans on, or null. Cited: the pins its draft adds and its summary names, and the derived documents its
 * summary or new text names by path */
export function circularOf(p: {
  targetId: string | null
  summary: string
  newPins: readonly Pin[]
  addedText: string
  derivedPaths: readonly string[]
  derivedIds: ReadonlyMap<string, string>
  inputsOf: (path: string) => readonly string[]
}): { via: string[] } | null {
  if (!p.targetId) return null
  const pins = [...p.newPins, ...[...p.summary.matchAll(/([A-Za-z][A-Za-z0-9]*-\d+)@(\d+)/g)].map(m => parsePin(`${m[1]}@${m[2]}`) as Pin)]
  const lean = new Set<string>()
  let other = false
  for (const pin of pins) {
    if (pin.id === p.targetId) continue
    const path = p.derivedIds.get(pin.id)
    if (path) lean.add(path)
    else other = true
  }
  for (const path of p.derivedPaths) if (p.summary.includes(path) || p.addedText.includes(path)) lean.add(path)
  if (other || !lean.size) return null
  const via = [...lean].filter(path => p.inputsOf(path).includes(p.targetId as string)).sort()
  return via.length ? { via } : null
}

export function circularWords(via: readonly string[]): string {
  return `its only cited authority is ${via.length === 1 ? 'a derived document' : 'derived documents'} (${via.join(', ')}) that rest${via.length === 1 ? 's' : ''} on this very record: a derived document can't be the sole authority for changing its own inputs. Check that the change stands on its own`
}
