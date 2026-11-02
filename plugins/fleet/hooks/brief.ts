// Pure logic of /fleet brief (tested in tests/brief.test.ts): what the person reads when he comes by, computed from the
// project's files at no token cost, always in the same order: what needs him; what changed in the world and who
// changed it; what's blocked, stale, suspect, quiet past its cadence or without fleet; the spend and its forecast; the
// inputs and ideas. The chief may add up to five lines of its own (/fleet brief --chief). No `$` here.

import type { Level } from './authority'
import { changeLine, clock, type ChangeEvent, type Me } from './changes'
import { ago } from './decisions'
import { hoursText, usd, usdOf } from './roster'

/** judge: what the judge proposed on a choice, in a few words ("a) SQLite, citing D-3") */
export type BriefNeed = { id: string; kind: 'choice' | 'change' | 'resource' | 'outbound'; what: string; who: string; at: number; blocks?: string; outside?: string; judge?: string }
export type BriefFacts = {
  now: number
  me: Me
  /** The window's start (the last 24 h) */
  since: number
  needs: BriefNeed[]
  /** Answered, not delivered yet */
  waiting: number
  /** Instances waiting on a permission prompt, with nobody at them (their tool, since when) */
  prompts?: { name: string; tool: string; at: number }[]
  /** The landings of the window, any order (the newest per file is shown) */
  events: ChangeEvent[]
  /** The decisions closed in the window that changed something or sent something: a change applied, an outbound sent */
  closed: { id: string; at: number; line: string }[]
  levelOf: (path: string) => Level
  blocked: {
    blocks: { id: string; who: string; at: number; blocks: string }[]
    /** One line each, as /fleet status says them (records.ts suspectLine) */
    suspects: { line: string; who: string | null }[]
    failing: { path: string; check: string; message: string; who: string | null }[]
    cadence: { name: string; hours: number; cadenceH: number }[]
    noFleet: string[]
    down: string[]
    stale: { name: string; files: number }[]
  }
  spend: {
    project: { usd: number; cap: number | null } | null
    instances: { name: string; usd: number; cap: number | null; state: string }[]
    forecast: { caps: number; wakesUsd: number } | null
    windows: { kind: string; percentUsed: number }[]
  }
  /** The intake records of the window: what each is, who sent it, who it reached (none: nobody subscribes, and there's
   * no front door); a request for a change and its drafter */
  intake?: { id: string; path: string; at: number; kind: string; from: string; standing: string; to: string[]; front: boolean; drafter: string | null; targets: string[] }[]
  /** Derived documents a revised record made stale, and the slots someone waits for */
  derived?: { path: string; kind: string; owner: string; pins: string[] }[]
  slots?: { slot: string; waiting: { name: string; at: number }[] }[]
  intakeSpend?: { usd: number; records: number } | null
  /** What the judges did in the window in live areas (answered, sent back), the person's overrules, and an area that
   * went back to shadow by itself: one line each */
  judges?: string[]
}

export const SHOWN = 15

function kindWords(n: number, one: string, many: string): string {
  return n ? `${n} ${n === 1 ? one : many}` : ''
}

function windowName(kind: string): string {
  return kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind
}

function eventLine(e: ChangeEvent, f: BriefFacts): string {
  const level = f.levelOf(e.path)
  const tags = [level !== 'owner' ? level : '', e.outside ? 'its writer had read outside content' : ''].filter(Boolean)
  return `   - ${e.path}${tags.length ? ` (${tags.join('; ')})` : ''}: ${changeLine(e, f.me)}`
}

/** The newest event per file, newest first; command-level ones first */
function newestPerFile(events: readonly ChangeEvent[], f: BriefFacts): ChangeEvent[] {
  const by = new Map<string, ChangeEvent>()
  for (const e of events) {
    if (e.at < f.since) continue
    const had = by.get(e.path)
    if (!had || e.at >= had.at) by.set(e.path, e)
  }
  const rank = (e: ChangeEvent) => (f.levelOf(e.path) === 'command' ? 0 : 1)
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || b.at - a.at || a.path.localeCompare(b.path))
}

export function briefText(f: BriefFacts, chief: string[] = []): string {
  const out: string[] = [`Brief · ${new Date(f.now + f.me.offsetMin * 60000).toISOString().slice(0, 10)} ${clock(f.now, f.me.offsetMin)} · the last ${Math.round((f.now - f.since) / 3600000)} h`]
  // 1. What needs the person
  const count = (k: BriefNeed['kind']) => f.needs.filter(n => n.kind === k).length
  const what = [kindWords(count('choice'), 'question', 'questions'), kindWords(count('change'), 'change', 'changes'), kindWords(count('resource'), 'resource', 'resources'), kindWords(count('outbound'), 'outbound draft', 'outbound drafts')].filter(Boolean)
  out.push('', what.length ? `1. Needs you: ${what.join(', ')} (/fleet lists them to answer)` : '1. Nothing needs you.')
  const needsAt = out.length - 1
  for (const n of [...f.needs].sort((a, b) => a.at - b.at).slice(0, SHOWN)) {
    out.push(`   - ${n.id} ${n.kind === 'choice' ? 'question' : n.kind}: ${n.what} · ${n.who} · ${ago(f.now - n.at)} ago${n.blocks ? ` · blocks: ${n.blocks}` : ''}${n.outside ? ` · ${n.kind === 'choice' ? 'asked' : 'drafted'} after reading outside content (${n.outside})` : ''}${n.judge ? ` · ${n.judge}` : ''}`)
  }
  if (f.needs.length > SHOWN) out.push(`   - and ${f.needs.length - SHOWN} more`)
  // Instances stopped at a permission prompt nobody sees
  const prompts = f.prompts ?? []
  if (prompts.length && !f.needs.length) out[needsAt] = `1. Needs you: ${kindWords(prompts.length, 'permission prompt', 'permission prompts')}`
  for (const p of prompts) out.push(`   - ${p.name} waits on a permission prompt (${p.tool}) · ${ago(f.now - p.at)}: Enter on its row in the panel answers it`)
  if (f.waiting) out.push(`   ${f.waiting} answered, not delivered yet`)
  // Items from outside that reached nobody (no subscriber, no front door), and requests for a change nobody drafts
  const intake = (f.intake ?? []).filter(i => i.at >= f.since)
  const orphans = intake.filter(i => !i.to.length)
  const undrafted = intake.filter(i => i.kind === 'command-claim' && !i.drafter)
  if (orphans.length || undrafted.length) {
    if (!f.needs.length) out[needsAt] = '1. Needs you: items from outside nobody takes up'
    for (const i of undrafted) out.push(`   - ${i.id}: a request for a change to ${i.targets.join(', ') || 'something it names'} from ${i.from || 'an unknown sender'} (${i.standing}), and nobody subscribes to draft it: read ${i.path}`)
    for (const i of orphans.filter(x => !undrafted.includes(x))) out.push(`   - ${i.id}: ${i.kind} from ${i.from || 'an unknown sender'} reached nobody (no subscriber, no front door): ${i.path}`)
  }
  // 2. What changed, and who changed it
  const shared = newestPerFile(f.events, f).filter(e => !['information', 'proposal'].includes(f.levelOf(e.path)))
  const closed = [...f.closed].filter(c => c.at >= f.since).sort((a, b) => b.at - a.at)
  const judged = f.judges ?? []
  const counts = [
    shared.length ? `${shared.length} shared file${shared.length === 1 ? '' : 's'}` : '',
    closed.length ? `${closed.length} decision${closed.length === 1 ? '' : 's'} carried out` : '',
    judged.length ? 'the judges' : '',
  ].filter(Boolean)
  out.push('', counts.length ? `2. What changed: ${counts.join(', ')}` : '2. No shared file changed.')
  for (const c of closed.slice(0, SHOWN)) out.push(`   - ${c.line}`)
  for (const j of judged.slice(0, SHOWN)) out.push(`   - ${j}`)
  for (const e of shared.slice(0, SHOWN)) out.push(eventLine(e, f))
  if (shared.length > SHOWN) out.push(`   - and ${shared.length - SHOWN} more: /fleet status lists the last changes`)
  // 3. Blocked, stale, suspect, quiet, without fleet
  const b = f.blocked
  const lines: string[] = [
    ...b.blocks.map(x => `   - ${x.id} (${x.who}, ${ago(f.now - x.at)}) holds up: ${x.blocks}`),
    ...b.suspects.map(x => `   - suspect: ${x.line}${x.who ? ` (written last by ${x.who})` : ''}`),
    ...b.failing.map(x => `   - ${x.path} fails the check ${x.check}: ${x.message}${x.who ? ` (written last by ${x.who})` : ''}`),
    ...b.cadence.map(x => `   - ${x.name}: nothing landed in ${hoursText(x.hours)} (its cadence is ${hoursText(x.cadenceH)})`),
    ...b.stale.map(x => `   - ${x.name} read ${x.files} shared file${x.files === 1 ? '' : 's'} that changed since`),
    ...b.noFleet.map(x => `   - ${x}: running with no fleet (u in the panel restarts it)`),
    ...b.down.map(x => `   - ${x}: down (/fleet up "${x}" brings it back)`),
    ...(f.derived ?? []).map(d => `   - stale: ${d.path} (${d.kind}, owned by ${d.owner}): ${d.pins.join(', ')} moved since it cited them`),
    ...(f.slots ?? []).flatMap(x => x.waiting.map(w => `   - ${w.name} waits for the slot ${x.slot} (${ago(f.now - w.at)})`)),
  ]
  out.push('', lines.length ? '3. Blocked and stale:' : '3. Nothing is blocked or stale.', ...lines)
  // 4. Spend, in both kinds of account
  const s = f.spend
  const parts: string[] = []
  if (s.project) parts.push(`${usdOf(s.project.usd, s.project.cap)} today${s.project.cap !== null ? " (the project's cap)" : ''}, estimated at list price`)
  if (s.forecast) parts.push(`budgets ${usd(s.forecast.caps)} a day, wakes ~${usd(s.forecast.wakesUsd)} a day`)
  if (s.windows.length) parts.push(`this account's windows: ${s.windows.map(w => `${windowName(w.kind)} ${w.percentUsed}%`).join(', ')}`)
  out.push('', parts.length ? `4. Spend: ${parts.join('; ')}` : '4. Spend: no roster, and no window reading yet')
  const heavy = s.instances.filter(i => i.state !== 'ok' || i.usd > 0).sort((a, c) => c.usd - a.usd)
  for (const i of heavy.slice(0, SHOWN)) out.push(`   - ${i.name}: ${usdOf(i.usd, i.cap)}${i.state === 'over' ? ', used up' : i.state === 'warn' ? ', past 80%' : ''}`)
  // 5. Inputs and ideas: the items from outside (with whom they reached), then the other landings on those levels
  const ideas = newestPerFile(f.events, f).filter(e => e.via !== 'intake' && ['information', 'proposal'].includes(f.levelOf(e.path)))
  const shownIntake = [...intake].sort((a, c) => c.at - a.at)
  const n = ideas.length + shownIntake.length
  out.push('', n ? `5. Inputs and ideas: ${n}${shownIntake.length ? ` (${shownIntake.length} from outside${f.intakeSpend ? `, intake ${usd(f.intakeSpend.usd)} today` : ''})` : ''}` : '5. No new inputs or ideas.')
  for (const i of shownIntake.slice(0, SHOWN)) {
    const reached = i.to.length ? `${i.front ? 'the front door, ' : ''}${i.to.join(', ')}` : 'nobody'
    out.push(`   - ${i.id} (${i.path}): ${i.kind} from ${i.from || 'an unknown sender'} (${i.standing}) at ${clock(i.at, f.me.offsetMin)} → ${reached}${i.drafter ? `; ${i.drafter} drafts it` : ''}`)
  }
  if (shownIntake.length > SHOWN) out.push(`   - and ${shownIntake.length - SHOWN} more from outside`)
  for (const e of ideas.slice(0, SHOWN)) out.push(eventLine(e, f))
  if (ideas.length > SHOWN) out.push(`   - and ${ideas.length - SHOWN} more`)
  if (chief.length) out.push('', "The chief's notes:", ...chief.map(l => `   ${l}`))
  return out.join('\n')
}

/** A closed decision's line for the brief, when it changed or sent something: a change applied (by the person's apply,
 * or as filed because he typed the turn), an outbound sent by fleet or by the person himself; null otherwise */
export function closedLine(r: { id: string; kind?: string; change?: { path: string; summary: string }; outbound?: { what: string; to: string }; answers: ({ label?: string; text?: string; session?: string; pre?: true } | null)[] }, asker: string): string | null {
  const a = r.answers[0]
  if (!a) return null
  if (r.kind === 'change' && r.change && a.label === 'applied') {
    const how = a.pre ? `as filed: the person typed it to ${asker}${a.session ? ` in ${a.session}` : ''}` : `by the person's apply${a.session ? ` in ${a.session}` : ''}`
    return `${r.change.path}: ${r.id} applied ${how} ("${r.change.summary}")`
  }
  if (r.kind === 'outbound' && r.outbound && (a.label === 'sent' || a.label === 'done')) {
    return `went out: ${r.outbound.what} to ${r.outbound.to}, ${r.id} ${a.label === 'sent' ? `sent by fleet as the person approved (${a.text ?? 'done'})` : 'sent by the person himself'}`
  }
  return null
}

/** The chief's lines, from its reply: at most five, none empty, each at most 300 characters */
export function chiefLines(reply: string): string[] {
  return reply
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map(l => (l.length > 300 ? `${l.slice(0, 299)}…` : l))
}

export const CHIEF_PROMPT =
  "Here is the project's brief, computed from its files. Write at most five lines for the person: what matters most now, and what you recommend they do first. Only those lines: no heading, no preamble. Facts only from the brief and the charter; don't invent any."
