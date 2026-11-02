// Pure logic of the roster (tested in tests/roster.test.ts): roster.json, its instances as /fleet up starts them, the
// lints of /fleet up --dry-run, the settings file fleet generates for each instance, the command-level files those
// settings deny, the cost forecast, the budgets and the coalesced wakes. No `$` here.
//
// A role is a native agent file, <project>/.claude/agents/<agent>.md (its body the charter, its tools); an instance is
// one background session of a role, started as claude --bg --agent <agent> --settings
// <project>/.claude/fleet/instances/<slug>.json -n <name>. Lightness (the owner's rule): only what would expose the
// project to third parties blocks; budgets, wakes and the rest mark and flag. The settings deny one thing: the agent's
// own tools writing a command-level file (decision 1a: those change through an applied `change`).

import { checkGlob, globRegex, type WorldConfig } from './changes'

/** Project data: roster.json. It only gains fields, and a write keeps the fields it doesn't know */
export const ROSTER_FORMAT = 1
/** Roster sections are drawn after fleet's "Asking you" (order 200) */
export const SECTION_ORDER = 201
/** The context a wake reopens, for the forecast: about what a role's charter, protocol and recent work fill */
export const WAKE_CONTEXT = 40000
export const DEFAULT_WAKES = { everyMin: 60, perDay: 8 }
/** A heartbeat older than this, of a running instance, means its fleet stopped */
export const HEARTBEAT_STALE_MS = 3 * 60000
/** The share of the day's budget at which an instance is told to land what it has */
export const WARN_SHARE = 0.8

/** List prices in US dollars per million tokens: input, output, a 5-minute cache write, a cache read */
export const PRICES = {
  fable: { input: 10, output: 50, write: 12.5, read: 0.25 },
  opus: { input: 4, output: 20, write: 5, read: 0.2 },
  sonnet: { input: 2, output: 10, write: 2.5, read: 0.2 },
  haiku: { input: 0.1, output: 0.5, write: 0.125, read: 0.01 },
} as const
export type Family = keyof typeof PRICES

export type Permissions = { defaultMode?: string; allow?: string[]; ask?: string[]; deny?: string[] }
/** What a zone, a role and an instance can each say; the instance's wins, then the role's, then the zone's */
type Overrides = {
  agent?: string
  model?: string
  effort?: string
  budget?: { usdDay?: number }
  cadenceH?: number
  seed?: string
  zone?: string
  permissions?: Permissions
  /** Any other settings for the instance's --settings file (env, enabledPlugins, worktree…), merged */
  settings?: Record<string, unknown>
}
export type RoleSpec = Overrides
export type InstanceSpec = Overrides & { name: string; role: string; section?: string; parent?: string; wave?: number; brief?: string }
export type Zone = { permissions?: Permissions; settings?: Record<string, unknown> }
export type Roster = {
  rosterFormat: number
  sections?: { id: string; title: string }[]
  zones?: Record<string, Zone>
  roles: Record<string, RoleSpec>
  instances: InstanceSpec[]
  budget?: { usdDay?: number }
  wakes?: { everyMin?: number; perDay?: number }
  settings?: Record<string, unknown>
  [key: string]: unknown
}
/** An instance as /fleet up starts it: the roster's fields resolved */
export type Instance = {
  name: string
  slug: string
  role: string
  agent: string
  section: { id: string; title: string; order: number } | null
  parent: string | null
  wave: number
  model: string | null
  effort: string | null
  usdDay: number | null
  cadenceH: number | null
  /** The seed's file, relative to <project>/.claude/fleet/ */
  seed: string
  brief: string
  permissions: Permissions
  settings: Record<string, unknown>
}

// ---- roster.json ----

export function rosterText(r: Roster): string {
  return `${JSON.stringify(r, null, 2)}\n`
}

/** roster.json: its fields, or why it can't be used (a newer fleet wrote it, or it isn't a roster) */
export function parseRoster(text: string): { roster: Roster } | { problem: string } {
  let r: any
  try {
    r = JSON.parse(text)
  } catch {
    return { problem: "roster.json isn't valid JSON" }
  }
  if (!r || typeof r !== 'object' || typeof r.rosterFormat !== 'number') return { problem: 'roster.json has no rosterFormat' }
  if (r.rosterFormat > ROSTER_FORMAT) return { problem: `roster.json is from a newer fleet (rosterFormat ${r.rosterFormat}): restart this session (u) to load it` }
  if (!r.roles || typeof r.roles !== 'object' || Array.isArray(r.roles)) return { problem: 'roster.json: roles is an object, role name → { agent, model, … }' }
  if (!Array.isArray(r.instances)) return { problem: 'roster.json: instances is a list of { name, role, … }' }
  return { roster: r as Roster }
}

/** The name an instance's files go under: instances/<slug>.json, instances/<slug>/ */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Settings merged the way fleet layers them: objects key by key, lists joined (once each), the rest replaced */
export function mergeSettings(...layers: (Record<string, unknown> | undefined)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    if (!isObject(layer)) continue
    for (const [k, v] of Object.entries(layer)) {
      const had = out[k]
      if (isObject(had) && isObject(v)) out[k] = mergeSettings(had, v)
      else if (Array.isArray(had) && Array.isArray(v)) out[k] = [...new Set([...had, ...v])]
      else out[k] = v
    }
  }
  return out
}

function mergePermissions(...layers: (Permissions | undefined)[]): Permissions {
  const out: Permissions = {}
  for (const p of layers) {
    if (!isObject(p)) continue
    if (typeof p.defaultMode === 'string') out.defaultMode = p.defaultMode
    for (const k of ['allow', 'ask', 'deny'] as const) {
      const v = strings(p[k])
      if (v.length) out[k] = [...new Set([...(out[k] ?? []), ...v])]
    }
  }
  return out
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** The roster's instances as /fleet up starts them (an instance whose role is missing is left out: the lints say so) */
export function instancesOf(r: Roster): Instance[] {
  const sections = new Map((Array.isArray(r.sections) ? r.sections : []).map((s, i) => [String(s?.id), { id: String(s?.id), title: String(s?.title || s?.id), order: SECTION_ORDER + i }]))
  const out: Instance[] = []
  for (const spec of r.instances) {
    if (!isObject(spec) || typeof spec.name !== 'string' || typeof spec.role !== 'string') continue
    const role = r.roles[spec.role]
    if (!isObject(role)) continue
    const zoneName = typeof spec.zone === 'string' ? spec.zone : typeof role.zone === 'string' ? role.zone : null
    const zone = zoneName && isObject(r.zones) ? r.zones[zoneName] : undefined
    const pick = <T>(f: (o: Overrides) => T | undefined): T | undefined => f(spec) ?? f(role)
    const name = spec.name.trim()
    const sectionId = typeof spec.section === 'string' ? spec.section : null
    out.push({
      name,
      slug: slugOf(name),
      role: spec.role,
      agent: pick(o => (typeof o.agent === 'string' ? o.agent : undefined)) ?? spec.role,
      section: sectionId ? (sections.get(sectionId) ?? { id: sectionId, title: sectionId, order: SECTION_ORDER + sections.size }) : null,
      parent: typeof spec.parent === 'string' && spec.parent.trim() ? spec.parent.trim() : null,
      wave: typeof spec.wave === 'number' ? spec.wave : 1,
      model: pick(o => (typeof o.model === 'string' && o.model ? o.model : undefined)) ?? null,
      effort: pick(o => (typeof o.effort === 'string' && o.effort ? o.effort : undefined)) ?? null,
      usdDay: pick(o => num(o.budget?.usdDay) ?? undefined) ?? null,
      cadenceH: pick(o => num(o.cadenceH) ?? undefined) ?? null,
      seed: pick(o => (typeof o.seed === 'string' && o.seed ? o.seed : undefined)) ?? `seeds/${spec.role}.md`,
      brief: typeof spec.brief === 'string' ? spec.brief.trim() : '',
      permissions: mergePermissions(zone?.permissions, role.permissions, spec.permissions),
      settings: mergeSettings(isObject(r.settings) ? r.settings : undefined, zone?.settings, role.settings, spec.settings),
    })
  }
  return out
}

export function wakesOf(r: Roster | null): { everyMin: number; perDay: number } {
  const w = isObject(r?.wakes) ? (r?.wakes as Record<string, unknown>) : {}
  const everyMin = num(w.everyMin)
  const perDay = num(w.perDay)
  return { everyMin: everyMin !== null ? Math.max(1, everyMin) : DEFAULT_WAKES.everyMin, perDay: perDay !== null ? Math.floor(perDay) : DEFAULT_WAKES.perDay }
}

export function projectCap(r: Roster | null): number | null {
  return num(r?.budget?.usdDay)
}

// ---- Role files: .claude/agents/<agent>.md ----

/** A role file's front matter: its name and tools (null: no tools line, so every tool) */
export function parseRoleFile(text: string): { name: string | null; tools: string[] | null } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { name: null, tools: null }
  const end = lines.slice(1).findIndex(l => l.trim() === '---')
  const head = end >= 0 ? lines.slice(1, end + 1) : []
  let name: string | null = null
  let tools: string[] | null = null
  const unq = (s: string) => s.trim().replace(/^["']|["']$/g, '').trim()
  for (let i = 0; i < head.length; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(head[i] as string)
    if (!m) continue
    const [, key, raw = ''] = m
    if (key === 'name') name = unq(raw) || null
    if (key !== 'tools') continue
    const v = raw.trim()
    if (v.startsWith('[')) tools = v.replace(/^\[|\]$/g, '').split(',').map(unq).filter(Boolean)
    else if (v) tools = v.split(',').map(unq).filter(Boolean)
    else {
      tools = []
      for (let j = i + 1; j < head.length && /^\s*-\s+/.test(head[j] as string); j++) tools.push(unq((head[j] as string).replace(/^\s*-\s+/, '')))
    }
  }
  return { name, tools }
}

/** Whether a role's tools let it see fleet's own (mcp__fleet__decide): without them they're hidden, and the start holds */
export function seesFleet(tools: string[] | null): boolean {
  return tools === null || tools.some(t => t === 'mcp__fleet' || t === 'mcp__fleet__*' || t === '*')
}

// ---- Lints (/fleet up --dry-run; an error stops /fleet up) ----

export type Lint = { errors: string[]; warnings: string[] }

const AGENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const SECTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/

/** roleFiles: each agent's file text (null: missing) */
export function lintRoster(r: Roster, roleFiles: ReadonlyMap<string, string | null>): Lint {
  const errors: string[] = []
  const warnings: string[] = []
  const sectionIds = new Set<string>()
  for (const s of Array.isArray(r.sections) ? r.sections : []) {
    const id = String(s?.id ?? '')
    if (!SECTION.test(id) || id === 'asking') errors.push(`section "${id}": an id is letters, digits, . _ or -, up to 48 (and not "asking", fleet's own)`)
    if (!s?.title || String(s.title).length > 60) errors.push(`section "${id}": give it a title of 1 to 60 characters`)
    sectionIds.add(id)
  }
  const names = new Map<string, string>()
  const slugs = new Map<string, string>()
  const byName = new Map<string, InstanceSpec>()
  for (const [i, spec] of r.instances.entries()) {
    if (!isObject(spec) || typeof spec.name !== 'string') {
      errors.push(`instance ${i + 1}: give it a name`)
      continue
    }
    const name = spec.name.trim()
    if (!name || Array.from(name).length > 80 || /[\p{Cc}"]/u.test(name)) errors.push(`instance "${name}": a name is 1 to 80 characters on one line, without quotes`)
    const key = name.toLowerCase()
    if (names.has(key)) errors.push(`two instances are named "${name}"`)
    names.set(key, name)
    const slug = slugOf(name)
    if (!slug) errors.push(`instance "${name}": its name needs a letter or a digit`)
    else if (slugs.has(slug) && slugs.get(slug) !== key) errors.push(`"${name}" and "${slugs.get(slug)}" share the file name ${slug}: rename one`)
    slugs.set(slug, key)
    byName.set(key, spec)
    const role = typeof spec.role === 'string' ? r.roles[spec.role] : undefined
    if (!isObject(role)) errors.push(`"${name}": its role "${String(spec.role)}" isn't in roles`)
    if (spec.section !== undefined && !sectionIds.has(String(spec.section))) errors.push(`"${name}": its section "${String(spec.section)}" isn't in sections`)
    const wave = spec.wave ?? 1
    if (typeof wave !== 'number' || !Number.isInteger(wave) || wave < 1) errors.push(`"${name}": wave is a whole number from 1`)
    const zone = spec.zone ?? role?.zone
    if (zone !== undefined && !(isObject(r.zones) && isObject(r.zones[String(zone)]))) errors.push(`"${name}": its zone "${String(zone)}" isn't in zones`)
  }
  for (const spec of r.instances) {
    if (!isObject(spec) || typeof spec.name !== 'string' || spec.parent === undefined) continue
    const parent = String(spec.parent).trim().toLowerCase()
    const p = byName.get(parent)
    if (parent === spec.name.trim().toLowerCase()) errors.push(`"${spec.name}" is its own parent`)
    else if (!p) errors.push(`"${spec.name}": its parent "${spec.parent}" isn't an instance`)
    else if (p.parent !== undefined) warnings.push(`"${spec.name}": its parent "${p.name}" has a parent itself, so it's drawn as any other row (one level)`)
    else if ((p.wave ?? 1) > (spec.wave ?? 1)) warnings.push(`"${spec.name}" starts in wave ${spec.wave ?? 1}, before its parent "${p.name}" (wave ${p.wave ?? 1})`)
  }
  for (const [roleName, role] of Object.entries(r.roles)) {
    if (!isObject(role)) {
      errors.push(`role "${roleName}" isn't an object`)
      continue
    }
    const agent = typeof role.agent === 'string' ? role.agent : roleName
    if (!AGENT.test(agent)) errors.push(`role "${roleName}": "${agent}" can't be an agent name (letters, digits, . _ : -)`)
  }
  const instances = instancesOf(r)
  for (const agent of new Set(instances.map(i => i.agent))) {
    const text = roleFiles.get(agent)
    if (text === undefined || text === null) {
      errors.push(`no role file .claude/agents/${agent}.md (the role of ${instances.filter(i => i.agent === agent).map(i => i.name).join(', ')})`)
      continue
    }
    const f = parseRoleFile(text)
    if (f.name !== null && f.name !== agent) errors.push(`.claude/agents/${agent}.md is named "${f.name}" in its front matter: --agent ${agent} finds a role by that name`)
    if (!seesFleet(f.tools)) errors.push(`.claude/agents/${agent}.md: its tools don't list mcp__fleet__*, so fleet's tools would be hidden from it (and its start would hold 8 s)`)
  }
  for (const i of instances) {
    if (i.model !== null && !familyOf(i.model)) warnings.push(`"${i.name}": no price known for the model "${i.model}": the forecast leaves it out`)
    for (const mode of [i.permissions.defaultMode, (i.settings.permissions as Permissions | undefined)?.defaultMode]) {
      if (mode === 'bypassPermissions') errors.push(`"${i.name}": fleet doesn't start an instance with bypassPermissions (it would send things out with nobody asked)`)
    }
    const env = isObject(i.settings.env) ? Object.keys(i.settings.env) : []
    if (env.some(k => k.startsWith('FLEET_'))) warnings.push(`"${i.name}": its settings set ${env.filter(k => k.startsWith('FLEET_')).join(', ')}, which fleet sets itself`)
  }
  const cap = projectCap(r)
  const sum = instances.reduce((s, i) => s + (i.usdDay ?? 0), 0)
  if (cap !== null && sum > cap) warnings.push(`the instances' budgets add up to $${sum.toFixed(2)} a day, over the project's $${cap.toFixed(2)}: the project's cap stops them first`)
  const f = forecastOf(instances, wakesOf(r))
  if (cap !== null && f.wakesUsd > cap / 2) warnings.push(`the wake forecast ($${f.wakesUsd.toFixed(2)} a day) is over half the project's budget`)
  if (!r.instances.length) warnings.push('the roster has no instances yet: nothing to start')
  return { errors, warnings }
}

// ---- The instance's settings file: <project>/.claude/fleet/instances/<slug>.json ----

/** The command-level files: what no agent's own tools may write, and what a `change` may change (relative to the
 * project). instances/ is denied too (its settings and state are fleet's), but it isn't changed through a change */
export function commandLevel(world: WorldConfig | null, checkScripts: readonly string[]): { files: string[]; globs: string[] } {
  const files = ['.claude/fleet/charter.md', '.claude/fleet/roster.json', '.claude/fleet/world.json', ...checkScripts]
  const globs = ['.claude/agents/**', ...commandGlobs(world)]
  return { files: [...new Set(files)], globs: [...new Set(globs)] }
}

/** world.json's "command": the records only an applied change writes (requirements and the like), as globs */
export function commandGlobs(world: WorldConfig | null): string[] {
  return strings(world?.command).filter(g => !checkGlob(g))
}

/** Whether a path of the project (relative) is command-level, so a `change` is how it changes */
export function isCommandLevel(rel: string, level: { files: readonly string[]; globs: readonly string[] }, insensitive: boolean): boolean {
  const fold = (s: string) => (insensitive ? s.toLowerCase() : s)
  if (level.files.some(f => fold(f) === fold(rel))) return true
  return level.globs.some(g => globRegex(g, insensitive).test(rel))
}

/** {a,b} written out, since a permission rule takes no braces */
export function expandBraces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob)
  if (!m) return [glob]
  return m[1]!.split(',').flatMap(alt => expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)))
}

/** The deny rules: Edit (which covers Write and NotebookEdit too) of each command-level file and of instances/, by
 * absolute path (//<path>) */
export function denyRules(root: string, level: { files: readonly string[]; globs: readonly string[] }): string[] {
  const abs = (rel: string) => `Edit(/${root.replace(/\/+$/, '')}/${rel})`
  return [...new Set([...level.files.map(abs), ...[...level.globs, '.claude/fleet/instances/**'].flatMap(expandBraces).map(abs)])]
}

/** What /fleet up writes for an instance: the roster's settings for it, then fleet's own (they can't be taken out) */
export function settingsFor(i: Instance, root: string, deny: readonly string[]): Record<string, unknown> {
  const base = mergeSettings(i.settings)
  const env = { ...(isObject(base.env) ? base.env : {}), FLEET_ROOT: root, FLEET_INSTANCE: i.name, FLEET_ROLE: i.role }
  const perms = mergePermissions(isObject(base.permissions) ? (base.permissions as Permissions) : undefined, i.permissions)
  const out: Record<string, unknown> = { ...base, env }
  if (i.model) out.model = i.model
  if (i.effort) out.effortLevel = i.effort
  out.permissions = { ...(isObject(base.permissions) ? base.permissions : {}), ...perms, deny: [...new Set([...(perms.deny ?? []), ...deny])] }
  return out
}

export function settingsText(s: Record<string, unknown>): string {
  return `${JSON.stringify(s, null, 2)}\n`
}

// ---- The forecast (list prices) ----

export function familyOf(model: string | null): Family | null {
  if (!model) return null
  const m = model.toLowerCase()
  for (const f of Object.keys(PRICES) as Family[]) if (m.includes(f)) return f
  return m.includes('mythos') ? 'fable' : null
}

/** What a day of wakes costs an instance: each reopens about WAKE_CONTEXT tokens at the cache-write price */
export function wakeUsd(model: string | null, perDay: number): number | null {
  const f = familyOf(model)
  return f ? (perDay * WAKE_CONTEXT * PRICES[f].write) / 1e6 : null
}

export function forecastOf(instances: readonly Instance[], wakes: { perDay: number }): { caps: number; wakesUsd: number; unpriced: string[] } {
  let caps = 0
  let wakesUsd = 0
  const unpriced: string[] = []
  for (const i of instances) {
    caps += i.usdDay ?? 0
    const w = wakeUsd(i.model, wakes.perDay)
    if (w === null) unpriced.push(i.name)
    else wakesUsd += w
  }
  return { caps, wakesUsd, unpriced }
}

export function usd(n: number): string {
  return `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`
}

// ---- Budgets: each instance's spend per day (its own fleet turns the session's cost deltas into it) ----

/** <project>/.claude/fleet/instances/<slug>/spend.json, written only by that instance's fleet */
export type SpendFile = { format: number; slug: string; day: string; usd: number; sessionId: string; last: number; at: number }

/** The day in the person's time zone (offset in minutes east of UTC) */
export function localDay(ms: number, offsetMin: number): string {
  return new Date(ms + offsetMin * 60000).toISOString().slice(0, 10)
}

/** The spend after one more reading of the session's cost (in US dollars, at list price): the growth since the last
 * reading counts; a total that went down (a /clear) or another session's starts over from its own total */
export function addSpend(prev: SpendFile | null, now: { format: number; slug: string; day: string; sessionId: string; cost: number; at: number }): SpendFile {
  const same = !!prev && prev.sessionId === now.sessionId
  const delta = same && now.cost >= (prev as SpendFile).last ? now.cost - (prev as SpendFile).last : now.cost
  const usd = prev && prev.day === now.day ? prev.usd + delta : delta
  return { format: now.format, slug: now.slug, day: now.day, usd: Math.round(usd * 1e6) / 1e6, sessionId: now.sessionId, last: now.cost, at: now.at }
}

/** <project>/.claude/fleet/state/lifts.json: today's caps the person set with /fleet budget (the last write wins) */
export type LiftsFile = { format: number; day: string; instances: Record<string, number>; project?: number }

export function capFor(base: number | null, lifts: LiftsFile | null, day: string, key: string | null): number | null {
  if (lifts && lifts.day === day) {
    const v = key === null ? lifts.project : lifts.instances[key]
    if (typeof v === 'number') return v
  }
  return base
}

export type BudgetState = 'ok' | 'warn' | 'over'

export function budgetState(spent: number, cap: number | null): BudgetState {
  if (cap === null) return 'ok'
  if (spent >= cap) return 'over'
  return spent >= cap * WARN_SHARE ? 'warn' : 'ok'
}

/** A lift: a new cap for today, or more on top of today's (+n) */
export function parseAmount(s: string): { set: number } | { add: number } | null {
  const m = /^(\+)?\$?(\d+(?:\.\d+)?)$/.exec(s.trim())
  if (!m) return null
  const v = Number(m[2])
  return m[1] ? { add: v } : { set: v }
}

// ---- Wakes: an instance asked to act (a nudge from its own fleet, or the sweeper waking it), coalesced ----

/** One instance's wakes today: a count and the last one, per kind of writer (its own fleet's nudges, the sweeper's) */
export type WakeCount = { day: string; count: number; last: number }

/** An urgent wake (a decision's answer) waits this long at most after the last one */
export const URGENT_GAP_MIN = 10

/** Whether a wake may go now: at most one per everyMin (an urgent one, a decision's answer, waits URGENT_GAP_MIN at
 * most), and at most perDay a day in all */
export function wakeVerdict(mine: WakeCount | null, others: number, now: number, day: string, wakes: { everyMin: number; perDay: number }, urgent: boolean): 'ok' | 'window' | 'cap' {
  const today = mine && mine.day === day ? mine : null
  if ((today?.count ?? 0) + others >= wakes.perDay) return 'cap'
  const gap = urgent ? Math.min(URGENT_GAP_MIN, wakes.everyMin) : wakes.everyMin
  if (today && now - today.last < gap * 60000) return 'window'
  return 'ok'
}

export function countWake(mine: WakeCount | null, now: number, day: string): WakeCount {
  return { day, count: (mine && mine.day === day ? mine.count : 0) + 1, last: now }
}

// ---- Picking instances by what the person typed ----

/** The instances the words name (a name, any case, or its slug); quoted words keep their spaces. The whole line as
 * one name when the words don't each name one ("Area A" unquoted) */
export function pickInstances(words: readonly string[], instances: readonly Instance[]): { picked: Instance[]; unknown: string[] } {
  const find = (w: string) => instances.find(i => i.name.toLowerCase() === w.toLowerCase() || i.slug === w.toLowerCase())
  const each = words.map(w => ({ w, i: find(w) }))
  if (each.every(x => x.i)) return { picked: [...new Set(each.map(x => x.i as Instance))], unknown: [] }
  const whole = find(words.join(' '))
  if (whole) return { picked: [whole], unknown: [] }
  return { picked: [...new Set(each.filter(x => x.i).map(x => x.i as Instance))], unknown: each.filter(x => !x.i).map(x => x.w) }
}
