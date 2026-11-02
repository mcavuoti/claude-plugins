// Pure logic of the roster (tested in tests/roster.test.ts): roster.json, its instances as /fleet up starts them, the
// lints of /fleet up --dry-run, the settings file fleet generates for each instance, the command-level files those
// settings deny, the cost forecast, the budgets and the coalesced wakes. No `$` here.
//
// A role is a native agent file, <project>/.claude/agents/<agent>.md (its body the charter, its tools); an instance is
// one background session of a role, started as claude --bg --agent <agent> --settings
// <project>/.claude/fleet/instances/<slug>.json -n <name>. Lightness (the owner's rule): only what would expose the
// project to third parties blocks; budgets, wakes and the rest mark and flag. The settings deny one thing: the agent's
// own tools writing a command-level file (decision 1a: those change through an applied `change`).

import { checkGlob, clock, globRegex, type WorldConfig } from './changes'
import { classifyBash, commandsOf, hostOf, isLocalHost, newOutbound, stripPrefixes } from './outbound'

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

/** List prices in US dollars per million tokens: input, output, a 5-minute cache write, a cache read. Per family, the
 * current generation's (what the aliases haiku, sonnet, opus and fable run) */
export const PRICES = {
  fable: { input: 10, output: 50, write: 12.5, read: 0.25 },
  opus: { input: 4, output: 20, write: 5, read: 0.2 },
  sonnet: { input: 2, output: 10, write: 2.5, read: 0.2 },
  haiku: { input: 0.1, output: 0.5, write: 0.125, read: 0.01 },
} as const
export type Family = keyof typeof PRICES
export type Price = { input: number; output: number; write: number; read: number }

const OPUS_5 = { input: 5, output: 25, write: 6.25, read: 0.5 }
const SONNET_4 = { input: 3, output: 15, write: 3.75, read: 0.3 }
const FABLE_5 = { input: 10, output: 50, write: 12.5, read: 1 }
/** The list prices of exact model ids (the API's table of 2026-10-06), older generations included: an id here is priced
 * as itself, any other by its family */
export const MODEL_PRICES: Record<string, Price> = {
  'claude-fable-5-1': PRICES.fable,
  'claude-mythos-5-1': PRICES.fable,
  'claude-fable-5': FABLE_5,
  'claude-mythos-5': FABLE_5,
  'claude-opus-5-5': PRICES.opus,
  'claude-opus-5': OPUS_5,
  'claude-opus-4-8': OPUS_5,
  'claude-opus-4-7': OPUS_5,
  'claude-opus-4-6': OPUS_5,
  'claude-opus-4-5': OPUS_5,
  'claude-sonnet-5-5': PRICES.sonnet,
  'claude-sonnet-5': PRICES.sonnet,
  'claude-sonnet-4-6': SONNET_4,
  'claude-sonnet-4-5': SONNET_4,
  'claude-haiku-5-5': PRICES.haiku,
  'claude-haiku-4-5': { input: 1, output: 5, write: 1.25, read: 0.1 },
}

export type Permissions = { defaultMode?: string; allow?: string[]; ask?: string[]; deny?: string[] }
/** What a zone, a role and an instance can each say; the instance's wins, then the role's, then the zone's */
type Overrides = {
  agent?: string
  model?: string
  effort?: string
  budget?: { usdDay?: number }
  cadenceH?: number
  /** long: the instance keeps one context (leads, the integrator, the chief); fresh (the default): at each cadence
   * boundary, idle and with its journal landed, fleet clears it and hands it its journal (decision 4a) */
  context?: string
  /** Its journal, relative to the project ({name}, {slug}); journals/{slug}.md by default */
  journal?: string
  seed?: string
  zone?: string
  permissions?: Permissions
  /** Any other settings for the instance's --settings file (env, enabledPlugins, worktree…), merged */
  settings?: Record<string, unknown>
  /** What items from outside reach it (intake.ts): their tags, their kinds, the records they ask to change; a role's
   * and its instance's add up */
  subscribe?: { tags?: string[]; kinds?: string[]; paths?: string[] }
}
export type RoleSpec = Overrides
export type InstanceSpec = Overrides & { name: string; role: string; section?: string; parent?: string; wave?: number; brief?: string }
export type Zone = { permissions?: Permissions; settings?: Record<string, unknown> }
export type Roster = {
  rosterFormat: number
  sections?: { id: string; title: string; order?: number }[]
  zones?: Record<string, Zone>
  roles: Record<string, RoleSpec>
  instances: InstanceSpec[]
  budget?: { usdDay?: number }
  wakes?: { everyMin?: number; perDay?: number }
  settings?: Record<string, unknown>
  /** The person: his addresses, the principals who may ask for changes, the front door, and how alerts reach him
   * (channel.ts) */
  person?: Record<string, unknown>
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
  context: 'long' | 'fresh'
  /** Its journal, relative to the project (it writes it with its own tools: a shared file, when the world has it) */
  journal: string
  /** The seed's file, relative to <project>/.claude/fleet/ */
  seed: string
  brief: string
  permissions: Permissions
  settings: Record<string, unknown>
  /** What items from outside reach it: tags, kinds, the paths of the records they ask to change (globs) */
  subscribe: Subscription
}
export type Subscription = { tags: string[]; kinds: string[]; paths: string[] }

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

/** Where an instance keeps its journal, unless its role or itself says otherwise: a shared file in the templates */
export const DEFAULT_JOURNAL = 'journals/{slug}.md'

/** {name} and {slug} in a roster's text, as one instance's */
export function fillName(text: string, name: string, slug: string): string {
  return text.replace(/\{name\}/g, name).replace(/\{slug\}/g, slug)
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

/** A section's place in the panel: its own order (a whole number from SECTION_ORDER: the templates give theirs orders
 * no other template uses, since sections are the person's across projects), else after fleet's "Asking you" by its
 * place in the roster */
export function sectionOrder(v: unknown, i: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= SECTION_ORDER && v <= 9999 ? v : SECTION_ORDER + i
}

/** The roster's instances as /fleet up starts them (an instance whose role is missing is left out: the lints say so) */
export function instancesOf(r: Roster): Instance[] {
  const sections = new Map((Array.isArray(r.sections) ? r.sections : []).map((s, i) => [String(s?.id), { id: String(s?.id), title: String(s?.title || s?.id), order: sectionOrder(s?.order, i) }]))
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
    const journal = pick(o => (typeof o.journal === 'string' && o.journal.trim() ? o.journal.trim() : undefined)) ?? DEFAULT_JOURNAL
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
      context: pick(o => (o.context === 'long' || o.context === 'fresh' ? (o.context as 'long' | 'fresh') : undefined)) ?? 'fresh',
      journal: fillName(journal, name, slugOf(name)),
      seed: pick(o => (typeof o.seed === 'string' && o.seed ? o.seed : undefined)) ?? `seeds/${spec.role}.md`,
      brief: typeof spec.brief === 'string' ? spec.brief.trim() : '',
      permissions: mergePermissions(zone?.permissions, role.permissions, spec.permissions),
      settings: mergeSettings(isObject(r.settings) ? r.settings : undefined, zone?.settings, role.settings, spec.settings),
      subscribe: mergeSubscriptions(role.subscribe, spec.subscribe),
    })
  }
  return out
}

/** A role's subscription and its instance's, added up (tags and kinds lowercase) */
function mergeSubscriptions(...layers: unknown[]): Subscription {
  const out: Subscription = { tags: [], kinds: [], paths: [] }
  for (const l of layers) {
    if (!isObject(l)) continue
    out.tags.push(...strings(l.tags).map(t => t.trim().toLowerCase()).filter(Boolean))
    out.kinds.push(...strings(l.kinds).map(t => t.trim().toLowerCase()).filter(Boolean))
    out.paths.push(...strings(l.paths).filter(g => !checkGlob(g)))
  }
  return { tags: [...new Set(out.tags)], kinds: [...new Set(out.kinds)], paths: [...new Set(out.paths)] }
}

/** The front door: the instance roster.json's person.front names, else the first whose role is chief; null without
 * one (then what nobody subscribes to waits in the brief) */
export function frontOf(r: Roster | null, instances: readonly Instance[]): Instance | null {
  const named = isObject(r?.person) && typeof r?.person?.front === 'string' ? (r.person.front as string).trim().toLowerCase() : ''
  if (named) {
    const i = instances.find(x => x.name.toLowerCase() === named)
    if (i) return i
  }
  return instances.find(i => i.role === 'chief') ?? null
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
    // A dialog in a session nobody is at waits for nobody: a mark, the role's to fix
    else if (f.tools === null || f.tools.includes('AskUserQuestion') || f.tools.includes('*'))
      warnings.push(`.claude/agents/${agent}.md: ${f.tools === null ? 'with no tools line it has every tool, AskUserQuestion included' : 'its tools include AskUserQuestion'}: a question it asks that way waits for nobody (an instance asks with mcp__fleet__decide); list its tools without it`)
  }
  for (const i of instances) {
    if (i.model !== null && !priceOf(i.model)) warnings.push(`"${i.name}": no price known for the model "${i.model}": the forecast leaves it out`)
    else if (familyPriceNote(i.model)) warnings.push(`"${i.name}": ${familyPriceNote(i.model)}`)
    for (const mode of [i.permissions.defaultMode, (i.settings.permissions as Permissions | undefined)?.defaultMode]) {
      if (mode === 'bypassPermissions') errors.push(`"${i.name}": fleet doesn't start an instance with bypassPermissions (it would send things out with nobody asked)`)
    }
    const env = isObject(i.settings.env) ? Object.keys(i.settings.env) : []
    if (env.some(k => k.startsWith('FLEET_'))) warnings.push(`"${i.name}": its settings set ${env.filter(k => k.startsWith('FLEET_')).join(', ')}, which fleet sets itself`)
    if (i.journal.startsWith('/') || i.journal.split('/').some(s => s === '..' || s === '.' || s === '') || /^\.claude(\/|$)/.test(i.journal)) {
      errors.push(`"${i.name}": its journal "${i.journal}" is a path relative to the project, without . or .., and outside .claude/ (Claude asks before any write there, and nobody would answer)`)
    }
  }
  for (const spec of [...Object.values(r.roles), ...r.instances]) {
    if (isObject(spec) && spec.context !== undefined && spec.context !== 'long' && spec.context !== 'fresh') errors.push(`context is "long" or "fresh" (it's "${String(spec.context)}")`)
  }
  const cap = projectCap(r)
  const sum = instances.reduce((s, i) => s + (i.usdDay ?? 0), 0)
  if (cap !== null && sum > cap) warnings.push(`the instances' budgets add up to ${usd(sum)} a day, over the project's ${usd(cap)}: the project's cap stops them first`)
  const f = forecastOf(instances, wakesOf(r))
  if (cap !== null && f.wakesUsd > cap / 2) warnings.push(`the wake forecast (${usd(f.wakesUsd)} a day) is over half the project's budget`)
  if (!r.instances.length) warnings.push('the roster has no instances yet: nothing to start')
  return { errors, warnings }
}

// ---- The instance's settings file: <project>/.claude/fleet/instances/<slug>.json ----

/** The command-level files: what no agent's own tools may write, and what a `change` may change (relative to the
 * project). checkScripts: the scripts fleet runs as the person (the checks', the command channel's). instances/ is
 * denied too (its settings and state are fleet's), but it isn't changed through a change */
export function commandLevel(world: WorldConfig | null, checkScripts: readonly string[]): { files: string[]; globs: string[] } {
  const files = ['.claude/fleet/charter.md', '.claude/fleet/principles.md', '.claude/fleet/roster.json', '.claude/fleet/world.json', '.claude/fleet/outbound.json', '.claude/fleet/slots.json', ...checkScripts]
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

/** A model's list price: by its exact id (a provider's prefix, a date or a [1m] taken off), an alias (haiku, sonnet,
 * opus, fable: the current generation), or else its family's (the current generation's, which an older model may not
 * cost: by: 'family' says so) */
export function priceOf(model: string | null): { price: Price; by: 'id' | 'family' } | null {
  if (!model) return null
  let m = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
  const at = m.indexOf('claude-')
  if (at > 0) m = m.slice(at)
  m = m.replace(/@.*$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '')
  if (MODEL_PRICES[m]) return { price: MODEL_PRICES[m] as Price, by: 'id' }
  if (m in PRICES) return { price: PRICES[m as Family], by: 'id' }
  const f = familyOf(m)
  return f ? { price: PRICES[f], by: 'family' } : null
}

/** What /fleet up --dry-run and /fleet status say of a model priced by its family only (null for one priced as itself) */
export function familyPriceNote(model: string | null): string | null {
  const p = priceOf(model)
  return p?.by === 'family' ? `the model "${model}" is priced as its family's current generation (${familyOf(model)}), not as itself: its costs may be off` : null
}

/** What a day of wakes costs an instance: each reopens its context (tokens; about WAKE_CONTEXT for one not started)
 * at the cache-write price */
export function wakeUsd(model: string | null, perDay: number, tokens: number = WAKE_CONTEXT): number | null {
  const p = priceOf(model)
  return p ? (perDay * tokens * p.price.write) / 1e6 : null
}

/** sizes: a running instance's own context, by slug, from its heartbeat; WAKE_CONTEXT for the others */
export function forecastOf(instances: readonly Instance[], wakes: { perDay: number }, sizes: Readonly<Record<string, number>> = {}): { caps: number; wakesUsd: number; unpriced: string[] } {
  let caps = 0
  let wakesUsd = 0
  const unpriced: string[] = []
  for (const i of instances) {
    caps += i.usdDay ?? 0
    const w = wakeUsd(i.model, wakes.perDay, sizes[i.slug] ?? WAKE_CONTEXT)
    if (w === null) unpriced.push(i.name)
    else wakesUsd += w
  }
  return { caps, wakesUsd, unpriced }
}

/** Tokens as the person reads them: 41k, 1.2M */
export function tokensText(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** Dollars as the person reads them, one format everywhere: cents, never rounded away (a sum compared with a cap
 * shows what it is: $10.02, not $10), and three significant digits below a dollar, so a small budget doesn't read
 * as used up ($0.016, not $0.02) */
export function usd(n: number): string {
  if (n > 0 && n < 1) {
    const p = Number(n.toPrecision(3))
    const decimals = Math.max(2, Math.min(6, -Math.floor(Math.log10(p)) + 2))
    return `$${p.toFixed(decimals).replace(/(\.\d\d\d*?)0+$/, '$1')}`
  }
  return `$${n.toFixed(2)}`
}

/** What was spent against a cap; below a dollar's cap with the share too: "$0.016 of $0.02 (80%)" */
export function usdOf(spent: number, cap: number | null): string {
  if (cap === null) return usd(spent)
  return `${usd(spent)} of ${usd(cap)}${cap > 0 && cap < 1 ? ` (${Math.floor((spent / cap) * 100)}%)` : ''}`
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

// ---- Cadence: an instance lands something every cadenceH hours (a negative result, in its journal, counts) ----

const HOUR_MS = 3600000

/** From when its period counts (its last landing, or when it started), and whether it's past it */
export function cadenceOf(p: { cadenceH: number | null; lastLanding: number | null; startedAt: number; now: number }): { due: boolean; anchor: number; hours: number } {
  const anchor = Math.max(p.lastLanding ?? 0, p.startedAt)
  const hours = (p.now - anchor) / HOUR_MS
  return { due: p.cadenceH !== null && p.cadenceH > 0 && hours >= p.cadenceH, anchor, hours }
}

/** Hours as the person reads them: 20 min, 1 h, 7 h, 2 d */
export function hoursText(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`
  return h >= 48 ? `${Math.floor(h / 24)} d` : `${Math.floor(h)} h`
}

export function cadenceNudgeText(inst: Pick<Instance, 'cadenceH' | 'journal'>, hours: number): string {
  return `fleet: ${hoursText(hours)} since you last landed anything in the shared world (your cadence is ${hoursText(inst.cadenceH ?? 0)}). Land what you have: a result, a negative result, or where you're blocked and why, in your journal (${inst.journal}) and where your work goes; or ask the person with mcp__fleet__decide. This is fleet's one nudge for this period.`
}

/** Decision 4a: an instance that doesn't keep a long context starts each cadence period afresh. Due when its
 * conversation is a period old, it's idle, nothing of fleet's is on its way to it, and it wrote its journal since the
 * conversation started (that's what the next one is handed) */
export function freshDue(p: { context: 'long' | 'fresh'; cadenceH: number | null; conversationAt: number; journalAt: number | null; now: number; idleMs: number; pending: boolean }): boolean {
  if (p.context !== 'fresh' || p.cadenceH === null || p.cadenceH <= 0 || p.pending || p.idleMs < 60000) return false
  if (p.now - p.conversationAt < p.cadenceH * HOUR_MS) return false
  return p.journalAt !== null && p.journalAt > p.conversationAt
}

/** The last lines of a journal, at most max characters (whole lines) */
export function journalTail(text: string, max = 4000): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const out: string[] = []
  let size = 0
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k] as string
    if (size + l.length + 1 > max && out.length) break
    out.unshift(l)
    size += l.length + 1
  }
  return out.join('\n')
}

/** fleet's own prompt to the cleared conversation: who it is, and its journal's last entries */
export function handoffText(inst: Pick<Instance, 'name' | 'role' | 'cadenceH' | 'journal'>, root: string, tail: string, whole: boolean): string {
  return [
    `You are ${inst.name}, the ${inst.role} of this project's fleet (the project folder is ${root}). This is a fresh period: fleet cleared your context after ${hoursText(inst.cadenceH ?? 0)}, as it does every period, and hands you your journal (${inst.journal}) to go on from.`,
    `${whole ? 'Your journal' : "Your journal's last entries"}:\n\n${tail}`,
    'Read what it points to that you need (the charter, your claimed items, the records you cite) and continue. Keep your journal as you go: the next period starts from it.',
  ].join('\n\n')
}

// ---- Marks on the instances' rows ($.sessions.setMarks, which refuses a whole call when one row is past its limits) ----

export type MarkTint = 'error' | 'warning' | 'suggestion' | 'success' | 'inactive'
export type RowMark = { badge: string; tint: MarkTint; line: string; needsPerson?: boolean }
/** sessions' limits: a badge of up to 3 columns, a status line of up to 60 characters, each on one line */
export const MARK_BADGE_COLUMNS = 3
export const MARK_LINE_CHARS = 60

function oneLine(s: string): string {
  return s.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** A row's mark within sessions' limits: one long instance name never costs the project every mark */
export function markRow(m: RowMark): RowMark {
  let badge = ''
  let cols = 0
  for (const c of Array.from(oneLine(m.badge))) {
    const w = /\p{Extended_Pictographic}/u.test(c) ? 2 : 1
    if (cols + w > MARK_BADGE_COLUMNS) break
    badge += c
    cols += w
  }
  const chars = Array.from(oneLine(m.line))
  const line = chars.length > MARK_LINE_CHARS ? `${chars.slice(0, MARK_LINE_CHARS - 1).join('').trimEnd()}…` : chars.join('')
  return { badge, tint: m.tint, line, ...(m.needsPerson ? { needsPerson: true } : {}) }
}

/** The over-budget row's line: how to lift it, with the instance's name when it fits, else its file name (which
 * /fleet budget takes too), else the name cut */
export function overBudgetLine(name: string, slug: string): string {
  const line = (who: string) => `over budget: /fleet budget ${who} +n`
  for (const who of [`"${name}"`, slug]) if (Array.from(line(who)).length <= MARK_LINE_CHARS) return line(who)
  const room = MARK_LINE_CHARS - Array.from(line('""…')).length
  return line(`"${Array.from(name).slice(0, room).join('').trimEnd()}…"`)
}

/** An asker's badge: ?n, its open decisions (99 at most, in 3 columns) */
export function askBadge(n: number): string {
  return `?${Math.min(99, Math.max(1, n))}`
}

// ---- Permission modes: an instance runs with nobody at it, so a mode that asks waits for nobody ----

/** The mode an instance runs in, and where it comes from: managed policy wins, then its own settings (the roster's,
 * in its --settings file), then the project's local and shared settings, then the person's own. null: none says one
 * (Claude's default, which asks) */
export function modeOf(layers: { policy?: unknown; instance?: unknown; local?: unknown; project?: unknown; user?: unknown }): { mode: string; from: string } {
  const pick = (s: unknown): string | null => {
    const p = isObject(s) && isObject(s.permissions) ? s.permissions : null
    return p && typeof p.defaultMode === 'string' && p.defaultMode ? p.defaultMode : null
  }
  const order: [keyof typeof layers, string][] = [
    ['policy', 'managed settings'],
    ['instance', 'roster.json'],
    ['local', "the project's settings.local.json"],
    ['project', "the project's settings.json"],
    ['user', 'your settings'],
  ]
  for (const [k, from] of order) {
    const m = pick(layers[k])
    if (m) return { mode: m, from }
  }
  return { mode: 'default', from: "Claude's default" }
}

/** worktree.bgIsolation as an instance gets it, in the same order as its mode; null when no layer sets it (then a
 * background session in a git repository moves into a worktree copy before its first edit) */
export function bgIsolationOf(layers: { policy?: unknown; instance?: unknown; local?: unknown; project?: unknown; user?: unknown }): string | null {
  for (const k of ['policy', 'instance', 'local', 'project', 'user'] as const) {
    const s = layers[k]
    const w = isObject(s) && isObject(s.worktree) ? s.worktree : null
    if (w && typeof w.bgIsolation === 'string' && w.bgIsolation) return w.bgIsolation
  }
  return null
}

/** Whether a role's tools write files (no tools line: every tool) */
export function writesFiles(tools: string[] | null): boolean {
  return tools === null || tools.some(t => t === '*' || /^(Write|Edit|MultiEdit|NotebookEdit)(\(|$)/.test(t))
}

/** What a mode means for an instance nobody is at: null when it doesn't ask (auto, dontAsk, bypassPermissions) */
export function modeWaits(mode: string): string | null {
  if (mode === 'default' || mode === 'plan') return 'the first write or command waits for you, with nobody to answer'
  if (mode === 'acceptEdits') return 'the first Bash command waits for you, with nobody to answer'
  return null
}

// ---- Auto mode's blocks: a call its classifier refused isn't run, the model gets the reason, and Claude lists it only
// in that session's /permissions (Recently blocked), where nobody looks. The instance's fleet keeps today's, and the
// brief and /fleet status say them with the line of roster.json that would allow each. A mark at most: never a hold ----

/** One block: its tool, a short cut of what it was called on (a command, a path, an address), the reason auto mode
 * gave (classic.PermissionDenied's reason: a rule's name in brackets, "Blocked by classifier", or a check that gave no
 * verdict), and when */
export type Block = { at: number; tool: string; what: string; reason: string }
/** <project>/.claude/fleet/instances/<slug>/blocks.json, written only by the instance's own fleet: how many blocks
 * today, and the last BLOCKS_KEPT of them */
export type BlocksFile = { format: number; slug: string; day: string; count: number; last: Block[] }
export const BLOCKS_KEPT = 20
/** So many blocks in a day mark the instance's row */
export const BLOCKS_MARK = 3
/** The kinds of block a brief line lists, the rest counted */
const BLOCKS_SHOWN = 5

function shortText(s: string, n: number): string {
  const t = oneLine(s)
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

/** What fleet keeps of a denied call: never its whole input, only a cut of the command, path or address it names */
export function blockOf(tool: unknown, input: unknown, reason: unknown, at: number, root: string): Block {
  const i = isObject(input) ? input : {}
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const path = str('file_path') || str('notebook_path') || str('path')
  const what = str('command') || (path ? (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path) : '') || str('url').split(/[?#]/)[0] || str('description')
  return { at, tool: shortText(String(tool ?? ''), 80) || 'a tool', what: shortText(what, 120), reason: shortText(String(reason ?? ''), 160) }
}

/** Today's file with one more block (a new day starts over) */
export function addBlock(had: BlocksFile | null, b: Block, slug: string, day: string, format: number): BlocksFile {
  const same = had && had.day === day ? had : null
  return { format, slug, day, count: (same?.count ?? 0) + 1, last: [...(same?.last ?? []), b].slice(-BLOCKS_KEPT) }
}

/** The blocks of today, or null */
export function blocksToday(f: BlocksFile | null, day: string): BlocksFile | null {
  return f && f.day === day && f.count > 0 && Array.isArray(f.last) ? f : null
}

/** The row's mark once blocks pile up: never one that needs the person (nothing waits on him), and never a hold */
export function blocksMark(n: number): RowMark | null {
  return n >= BLOCKS_MARK ? { badge: `⊘${Math.min(99, n)}`, tint: 'warning', line: `auto mode blocked ${n} today: /fleet brief says how to allow` } : null
}

/** Blocks of one kind: the same tool on the same pattern (a command's program and the host or first word it names, a
 * path, a tool). hosts: where it goes, when it reaches one (what autoMode.environment trusts); exact: the one command or
 * tool all of them were, when a narrow permissions.allow rule could name it; noVerdict: auto mode's check gave none
 * (nothing to allow) */
export type BlockGroup = { key: string; tool: string; n: number; rule: string | null; hosts: string[]; exact: string | null; noVerdict: boolean; last: number; prose: string }

const SETUP = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'true', ':', 'source', '.'])

function bashShape(cmd: string): { key: string; prose: string; hosts: string[]; simple: boolean } {
  let cmds: string[][] = []
  let hosts: string[] = []
  try {
    cmds = commandsOf(cmd)
      .map(w => stripPrefixes(w))
      .filter(w => w.length)
    const { sends, reads } = classifyBash(cmd, newOutbound())
    hosts = [...new Set([...sends.flatMap(s => s.hosts ?? []), ...reads])].filter(h => !isLocalHost(h))
  } catch {}
  const main = cmds.find(w => !SETUP.has(String(w[0]).split('/').pop() as string)) ?? cmds[0]
  if (!main) return { key: `${shortText(cmd, 30)}…`, prose: `Running ${shortText(cmd, 60)}`, hosts, simple: false }
  const prog = String(main[0]).split('/').pop() as string
  const arg = hosts[0] ?? main.slice(1).find(x => !x.startsWith('-')) ?? ''
  const head = shortText(arg ? `${prog} ${arg}` : prog, 40)
  const more = cmds.length > 1 || main.length > (arg ? 2 : 1)
  const simple = cmds.length === 1 && cmd.trim().length <= 100 && !/[;&|<>$`(){}\n\\]/.test(cmd)
  return { key: more ? `${head}…` : head, prose: `Running ${head}${more ? ' …' : ''}`, hosts, simple }
}

const NO_VERDICT = /could not evaluate|classifier unavailable|no (?:safety )?verdict/i

/** The blocks of today by kind, the most frequent first */
export function blockGroups(blocks: readonly Block[]): BlockGroup[] {
  const by = new Map<string, BlockGroup & { exacts: Set<string | null> }>()
  for (const b of blocks) {
    const noVerdict = NO_VERDICT.test(b.reason)
    const bash = b.tool === 'Bash' || b.tool === 'PowerShell'
    const shape = bash && b.what ? bashShape(b.what) : null
    const host = b.tool === 'WebFetch' && b.what ? hostOf(b.what) : null
    const key = shape ? shape.key : `${b.tool}${b.what ? ` ${shortText(b.what, 40)}` : ''}`
    const id = `${b.tool}\u0000${key}\u0000${noVerdict}`
    const rule = /\[([^\]]{1,60})\]/.exec(b.reason)?.[1] ?? null
    const g = by.get(id) ?? {
      key,
      tool: b.tool,
      n: 0,
      rule: null,
      hosts: [],
      exact: null,
      noVerdict,
      last: 0,
      prose: shape ? shape.prose : `${b.tool}${b.what ? ` on ${shortText(b.what, 60)}` : ''}`,
      exacts: new Set<string | null>(),
    }
    g.n++
    if (b.at >= g.last) {
      g.last = b.at
      g.rule = rule ?? g.rule
    }
    for (const h of shape?.hosts ?? (host && !isLocalHost(host) ? [host] : [])) if (!g.hosts.includes(h)) g.hosts.push(h)
    // What a narrow permissions.allow rule could name: one simple command, or an MCP tool (null: nothing narrow)
    g.exacts.add(shape ? (shape.simple ? b.what.trim() : null) : b.tool.startsWith('mcp__') ? b.tool : null)
    by.set(id, g)
  }
  return [...by.values()]
    .map(({ exacts, ...g }) => ({ ...g, exact: exacts.size === 1 ? ([...exacts][0] ?? null) : null }))
    .sort((a, b) => b.n - a.n || b.last - a.last || a.key.localeCompare(b.key))
}

/** The line of roster.json that would allow one kind of block, and which setting it is: a host it needs throughout is
 * trusted infrastructure (autoMode.environment), a routine pattern an autoMode.allow rule, and exactly one command or
 * tool may instead get a narrow permissions.allow rule, which skips auto mode's check. Each list keeps "$defaults" */
export function blockFix(g: BlockGroup): string {
  if (g.noVerdict) return "auto mode's check gave no verdict: no rule allows it, and it runs once the check answers"
  if (g.hosts.length) return `a host it needs throughout, trusted infrastructure: "settings": { "autoMode": { "environment": ["$defaults", ${JSON.stringify(`Trusted internal domains: ${g.hosts.join(', ')}`)}] } }`
  const allow = `a routine pattern: "settings": { "autoMode": { "allow": ["$defaults", ${JSON.stringify(`${g.prose} is allowed: routine work in this project`)}] } }`
  if (!g.exact) return allow
  const rule = g.tool.startsWith('mcp__') ? g.exact : `${g.tool}(${g.exact})`
  return `${allow}; or, for exactly ${g.tool.startsWith('mcp__') ? 'this tool' : 'this command'} and nothing else, "permissions": { "allow": [${JSON.stringify(rule)}] } (it skips auto mode's check)`
}

/** An instance's blocks today, for the brief and /fleet status: a line of what was blocked, then one per kind with
 * what would allow it, then where that goes (unindented: the caller indents) */
export function blocksLines(name: string, f: BlocksFile, offsetMin: number): string[] {
  const groups = blockGroups(f.last)
  const shown = groups.slice(0, BLOCKS_SHOWN)
  const lastAt = Math.max(0, ...f.last.map(b => b.at))
  const kinds = `${shown.map(g => `${g.key}${g.n > 1 ? ` ×${g.n}` : ''}`).join(', ')}${groups.length > shown.length ? `, ${groups.length - shown.length} more kind${groups.length - shown.length === 1 ? '' : 's'}` : ''}`
  const head = `${name}: ${f.count} blocked by auto mode today${lastAt ? `, the last at ${clock(lastAt, offsetMin)}` : ''}: ${f.count > f.last.length ? `of the last ${f.last.length}, ` : ''}${kinds}`
  const fixes = shown.map(g => `${g.key}${g.rule ? ` [${g.rule}]` : ''}: ${blockFix(g)}`)
  const where = shown.some(g => !g.noVerdict)
    ? [`it goes in ${name}'s entry in roster.json (yours: edit it, then /fleet accept roster.json; /fleet up "${name}" rewrites its settings and u restarts it with them). A list without "$defaults" replaces auto mode's own rules`]
    : []
  return [head, ...fixes, ...where]
}

// ---- Versions: an instance still running an older fleet ----

/** "0.6.0" before "0.7.0": -1, 0 or 1 (numbers compared part by part; what isn't a number counts as 0) */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map(x => Number(x) || 0)
  const pb = b.split(/[.+-]/).map(x => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

// ---- Plan B: sessions from the person's user settings, never a copy pinned to the project ----
// `claude plugin enable fleet@<m> --scope local` also writes `sessions@<m>: true` into the project's
// settings.local.json; the first session there then makes a local install record of sessions at that version, which
// `claude plugin update sessions@<m>` (user scope) never reaches. With the key gone, fleet's dependency is met by the
// user's sessions.

/** The sessions keys the project's settings.local.json enables that the person's user settings enable too */
export function redundantSessionsKeys(local: unknown, user: unknown): string[] {
  const on = (s: unknown) => (isObject(s) && isObject(s.enabledPlugins) ? s.enabledPlugins : {})
  const mine = on(user)
  return Object.entries(on(local))
    .filter(([id, v]) => /^sessions@/.test(id) && !id.endsWith('@inline') && v === true && mine[id] === true)
    .map(([id]) => id)
}

/** settings.local.json without those keys, everything else as it was (null: not an object fleet can rewrite) */
export function withoutPlugins(text: string, ids: readonly string[]): string | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(v) || !isObject(v.enabledPlugins)) return null
  const enabled = Object.fromEntries(Object.entries(v.enabledPlugins).filter(([id]) => !ids.includes(id)))
  return `${JSON.stringify({ ...v, enabledPlugins: enabled }, null, 2)}\n`
}

/** The local install records of sessions for this project, from `claude plugin list --json` */
export function localSessionsRecords(listJson: string, projectRoot: string): { id: string; version: string }[] {
  let v: unknown
  try {
    v = JSON.parse(listJson)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  const norm = (p: string) => p.replace(/\/+$/, '')
  return v
    .filter((r): r is Record<string, unknown> => isObject(r) && typeof r.id === 'string' && /^sessions@/.test(r.id) && r.scope === 'local' && typeof r.projectPath === 'string' && norm(r.projectPath) === norm(projectRoot))
    .map(r => ({ id: String(r.id), version: typeof r.version === 'string' ? r.version : '?' }))
}

/** The line that says so, and the one command that fixes it, run in the project */
export function localRecordLine(r: { id: string; version: string }): string {
  return `${r.id} ${r.version} is installed for this project alone (a local record), and \`claude plugin update ${r.id}\` never updates it: run \`claude plugin uninstall ${r.id} --scope local\` in the project (it warns that fleet requires it; fleet then uses your user-scope ${r.id.split('@')[0]})`
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
