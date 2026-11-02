// Pure logic of fleet's decisions (tested in tests/decisions.test.ts): the records and their files, decide's input,
// the /fleet grammar, what the person reads and what the asking model reads. No `$` here.
//
// Files, all under <project>/.claude/fleet/ (the project folder is fleet's data folder):
//   config.json                          person data (configFormat): the template and whether the register is committed
//   world.json                           person data (worldFormat): the world, the globs of the shared files (changes.ts)
//   roster.json                          person data (rosterFormat): roles and instances (roster.ts)
//   outbound.json                        person data (outboundFormat): what may leave without asking (outbound.ts)
//   slots.json                           person data (slotsFormat): the project's scarce resources (slots.ts)
//   charter.md, interview.md, seeds/     the project's charter, the chief's interview, each role's first prompt (templates)
//   principles.md                        the person's principles, the judges' statute with the charter (command-level)
//   .gitignore                           written by /fleet init from config.json
//   decisions/queue/D-<n>.json           wire (format): an open decision, written once by the session that asked
//   decisions/answers/D-<n>.<q>.json     wire: the answer to question q, published no-clobber (the first answer wins)
//   decisions/answers/D-<n>.<q>.note.json  wire: a note on question q (the last one wins)
//   decisions/answers/D-<n>.drop.json    wire: the person dropped the decision without answering it
//   decisions/drafts/D-<n>.<ext>, .diff  a change's draft and its line diff, written once by the session that filed it
//   decisions/drafts/D-<n>.json          an outbound's exact call (a command, or an MCP tool and its input), the same
//   decisions/applied/D-<n>.json         wire: a change claimed for applying, or an outbound for sending, published
//                                        no-clobber (it's applied or sent once)
//   decisions/register/YYYY-MM/<id>.json person data (registerFormat): every closed decision and recorded dialog, and
//                                        each piece of the person's taste (T-<n>, mcp__fleet__taste)
//   decisions/judge/D-<n>.json           wire: what the judge proposed on a choice (judges.ts), written once by the session
//                                        that asked; it goes into the register with the decision
//   decisions/last                       wire: the highest D-<n> handed out (a hint for the next one)
//   decisions/prune/YYYY-MM-DD           wire: the session that publishes it runs that day's prune
//   decisions/tmp/                       files about to be published or moved into place (events' too)
//   events/YYYY-MM-DD/HH/<ms>-<sid8>-<n>.json  wire: one landing on a world file, written once by the session that saw it
//   events/latest                        wire: the last event's name, rewritten by each writer; every session watches it
//   events/claims/<hash>                 wire: an outside change claimed no-clobber, so one session records it
//   reads/<sessionId>.json               wire: what that session's threads read of the world, and the outside content
//                                        its conversation read, written only by it
//   state/revs/<id>/<n>.json             wire: version n of the record <id> (records.ts), published no-clobber
//   state/suspects.json                  wire: the suspect files, written by the sweeper
//   state/checks/<hash>.json             wire: the last results of the checks on one file (the last run wins)
//   state/checks-stamp.json              wire: the checks the person stamped (/fleet accept checks)
//   state/sweeper.json                   wire: the sweeper's lease, rewritten by whoever holds or takes it
//   state/commit.json                    wire: the last world commit, written by the sweeper
//   state/stamps.json                    wire: the command-level files' versions fleet wrote or the person stamped, and
//                                        outbound.json's text as stamped (what the gate uses)
//   state/lifts.json, state/down.json    wire: today's budgets the person lifted; the instances he took down
//   state/wakes.json                     wire: the sweeper's wakes of retired instances today
//   state/intake.json                    wire: intake's counts and spend today, its sources' last polls (the sweeper's)
//   state/alerts.json, channel-stamp.json  wire: the alerts sent to the person today; the command channel he stamped
//   state/slots/<slot>/<n>.json          wire: lease n of a slot, published no-clobber by its taker (slots.ts)
//   state/slots/<slot>/waiting/<who>.json  wire: one in line for a slot, written by the session that waits
//   state/judges/<day>/<sid8>.json       wire: a session's judge calls and their cost today, written only by it
//   inbox/<source>/<name>.json, latest   a poller's items (itemFormat, intake.ts), and the trigger it rewrites
//   intake/seen/<key>.json               wire: an item read (dedup), published no-clobber by the sweeper
//   intake/raw/, dup/, failed/           items as they arrived, kept aside once read, duplicates, unreadable ones and
//                                        those the model couldn't answer in three tries (with a .why)
//   instances/<slug>.json                generated by /fleet up: an instance's --settings file
//   instances/<slug>/state.json          wire: an instance's heartbeat, written only by its fleet
//   instances/<slug>/spend.json, nudges.json, seed-<ref>.json  wire: its spend today, its nudges, its seed sent
// A reader that meets another format acts on nothing and says to restart (u): there is no code for older formats.

import type { OutsideMark, ResourceSpec } from './authority'
import type { ChangeSpec } from './drafts'
import type { JudgeEntry, TasteSpec } from './judges'
import type { OutboundSpec } from './outbound'

/** The format of the wire files: queue/, answers/, applied/, last, prune/, events/, reads/, state/, instances/. Raise it
 * when a key or its meaning changes */
export const FORMAT = 1
/** Person data: the register. It only gains fields, and a write keeps the fields it doesn't know */
export const REGISTER_FORMAT = 1
/** Person data: config.json. The same rule */
export const CONFIG_FORMAT = 1
/** The section a session that waits on the person is put in (sessions' panel) */
export const ASKING_SECTION = 'fleet:asking'

export type Option = { label: string; description?: string }
/** One question of a decision: its options, the one the asker recommends (a label) and why */
export type Question = { question: string; header?: string; options: Option[]; recommended: string; why: string }
/** Who asked: the session's official short id (it stays across /clear and restarts), id, name and project */
export type Asker = { ref: string | null; sessionId: string; name: string | null; root: string }
/** The kinds besides a choice: change (drafts.ts), resource (authority.ts), outbound (outbound.ts). Their questions are
 * empty, so a fleet that doesn't know the kind can't answer it */
export type Kind = 'change' | 'resource' | 'outbound'
export type QueueRecord = {
  format: number
  fleet: string
  id: string
  at: number
  asker: Asker
  questions: Question[]
  blocks?: string
  kind?: Kind
  change?: ChangeSpec
  resource?: ResourceSpec
  outbound?: OutboundSpec
  /** The asker's context had read outside content when it filed this (decision 2b): what, and when */
  outside?: OutsideMark
  /** A choice's area (one of the project's tags) and the asker's own word on it, which the judges' gates read */
  area?: string
  reversible?: boolean
  touchesMoney?: boolean
  outsideWorld?: boolean
}
/** origin: how the person typed it (composer: a terminal); session: the session it was typed in. pre: a change applied
 * as it was filed, because the person typed the turn that filed it (quoted: the start of what he typed); hash: the
 * version of an outbound the person approved; allowed: the hosts and remotes his send --allow added to outbound.json;
 * replacedJudge: the judge's answer his /fleet overrule replaced before its asker had it */
export type AnswerFile = { format: number; id: string; q: number; label?: string; text?: string; origin: string; session: string; at: number; pre?: true; quoted?: string; hash?: string; allowed?: string[]; judge?: JudgeCite; replacedJudge?: ReplacedJudge }
export type NoteFile = { format: number; id: string; q: number; text: string; origin: string; at: number }
/** A drop by the judge (origin judge, 0.7.0) sends the decision back to its asker, with why */
export type DropFile = { format: number; id: string; why?: string; origin: string; session: string; at: number; sentBack?: true }
/** What a judge's own answer rests on (origin judge): the precedents or statute lines it cites; repeat: an exact repeat */
export type JudgeCite = { cites: string[]; repeat?: true }
/** A judge's answer the person's own replaced while it was on its way to its asker (an overrule before delivery) */
export type ReplacedJudge = { label?: string; text?: string; cites: string[]; repeat?: true; at: number }
/** One question's outcome in the register: the option picked or the text typed, and any note (allowed: an outbound's
 * hosts and remotes the person allowed as he sent it; labels: the options he picked in a dialog's multi-select, text
 * then only what matched none) */
export type Outcome = { label?: string; labels?: string[]; text?: string; note?: string; origin?: string; session?: string; at?: number; pre?: true; allowed?: string[]; judge?: JudgeCite; replacedJudge?: ReplacedJudge }
export type RegisterState = 'delivered' | 'dropped' | 'abandoned' | 'answered' | 'not answered'
export type RegisterRecord = {
  registerFormat: number
  id: string
  /** decide: asked through mcp__fleet__decide; dialog: an AskUserQuestion the person answered in the session; taste:
   * the person said no to something, recorded with mcp__fleet__taste (T-<n>) */
  source: 'decide' | 'dialog' | 'taste'
  fleet: string
  at: number
  asker: Asker
  questions: (Question | DialogQuestion)[]
  blocks?: string
  answers: (Outcome | null)[]
  state: RegisterState
  why?: string
  /** submit: in a prompt of fleet's own; result: in the result of the tool call that filed it (a change applied at once) */
  delivered?: { at: number; turnId?: string; how: 'submit' | 'result' }
  closedAt: number
  kind?: Kind
  change?: ChangeSpec
  resource?: ResourceSpec
  outbound?: OutboundSpec
  outside?: OutsideMark
  /** An outbound's call as its draft held it when it closed (what was sent, or would have been) */
  call?: string
  area?: string
  reversible?: boolean
  touchesMoney?: boolean
  outsideWorld?: boolean
  /** What the judge proposed on it, and whether the person agreed (judges.ts) */
  judge?: JudgeEntry
  /** A taste record's what, about, principle and provenance */
  taste?: TasteSpec
}
export type DialogQuestion = { question: string; header?: string; options: Option[]; multiSelect?: boolean }
export type Config = { configFormat: number; template: string; commitRegister: boolean; [key: string]: unknown }

const ID = /^D-(\d+)$/

export function isDecisionId(id: string): boolean {
  return ID.test(id)
}

export function idNumber(id: string): number {
  const m = ID.exec(id)
  return m ? Number(m[1]) : 0
}

export function queueName(id: string): string {
  return `${id}.json`
}
export function answerName(id: string, q: number): string {
  return `${id}.${q}.json`
}
export function noteName(id: string, q: number): string {
  return `${id}.${q}.note.json`
}
export function dropName(id: string): string {
  return `${id}.drop.json`
}

/** What a file in answers/ is, or null for anything else */
export function parseAnswerName(name: string): { id: string; q: number; kind: 'answer' | 'note' } | { id: string; kind: 'drop' } | null {
  let m = /^(D-\d+)\.(\d+)\.json$/.exec(name)
  if (m) return { id: m[1] as string, q: Number(m[2]), kind: 'answer' }
  m = /^(D-\d+)\.(\d+)\.note\.json$/.exec(name)
  if (m) return { id: m[1] as string, q: Number(m[2]), kind: 'note' }
  m = /^(D-\d+)\.drop\.json$/.exec(name)
  if (m) return { id: m[1] as string, kind: 'drop' }
  return null
}

/** How many answers a decision waits for: one per question, and one for each other kind (a change applied, rejected or
 * why not; a resource got or not; an outbound sent, rejected, or sent by the person himself) */
export function slots(r: Pick<QueueRecord, 'questions' | 'kind'>): number {
  return r.kind === undefined ? r.questions.length : 1
}

/** A kind this fleet knows: a choice (no kind), a change, a resource or an outbound */
export function knownKind(r: Pick<QueueRecord, 'kind'>): boolean {
  return r.kind === undefined || r.kind === 'change' || r.kind === 'resource' || r.kind === 'outbound'
}

/** Where a decision stands, from the names in answers/: which questions have an answer, and whether it was dropped */
export function progress(id: string, questions: number, names: ReadonlySet<string>) {
  const answered = Array.from({ length: questions }, (_, i) => names.has(answerName(id, i + 1)))
  const dropped = names.has(dropName(id))
  return { answered, dropped, complete: dropped || answered.every(Boolean) }
}

/** The questions nobody answered yet, across the project's open decisions: what the band counts */
export function heldCount(records: readonly QueueRecord[], names: ReadonlySet<string>): number {
  let n = 0
  for (const r of records) {
    if (!knownKind(r)) continue
    const p = progress(r.id, slots(r), names)
    if (!p.dropped) n += p.answered.filter(a => !a).length
  }
  return n
}

/** YYYY-MM of a time, the register's folder; and the month before it */
export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7)
}
export function monthBefore(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

const LETTERS = 'abcd'

export function letter(i: number): string {
  return LETTERS[i] ?? '?'
}

/** A label reads well up to this many characters; a longer one is kept whole and the asker is told */
export const LABEL_READS = 60
/** The longest label fleet keeps */
export const LABEL_MAX = 200

/** A text shortened for a one-line display, with an ellipsis when it was longer (the text itself is kept whole) */
export function shown(s: string, max: number): string {
  return Array.from(s).length > max ? `${Array.from(s).slice(0, max - 1).join('').trimEnd()}…` : s
}

/** At most max UTF-16 units of a text, never ending on half of a character: a lone high surrogate at the end (an emoji
 * cut in two, here or by an earlier slice) is dropped, since the API refuses a request that carries one. Every text fleet
 * cuts on its way to a model goes through this */
export function cut(s: string, max: number): string {
  const t = s.length > max ? s.slice(0, Math.max(0, max)) : s
  const last = t.charCodeAt(t.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? t.slice(0, -1) : t
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? cut(v.trim(), max) : ''
}

/** The input of mcp__fleet__decide as JSON schema: 1-4 questions, each with 2-4 options, the recommended one and why;
 * or, with kind change, a change to a command-level file (drafts.ts) */
export const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['choice', 'change', 'resource'],
      description:
        "choice (the default): questions for the person. change: a change to a command-level file of this project (the charter, roster.json, world.json, outbound.json, a role file in .claude/agents/, a check script, or the records world.json lists under command), which your own tools can't write: fleet writes your draft once the person applies it. resource: something only the person can get for you (a license, an access, a machine, more budget), with what, why and optionally cost, byWhen and alternatives",
    },
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      description: 'kind choice: the questions, numbered for the person in this order',
      items: {
        type: 'object',
        required: ['question', 'options', 'recommended', 'why'],
        properties: {
          question: { type: 'string', maxLength: 400, description: 'Complete enough to answer without reading your conversation' },
          header: { type: 'string', maxLength: 12, description: 'Optional short label, up to 12 characters' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              required: ['label'],
              properties: {
                label: { type: 'string', description: 'A few words, up to about 60 characters; the detail goes in description' },
                description: { type: 'string', maxLength: 200, description: 'Optional: what choosing it means' },
              },
            },
          },
          recommended: { type: 'string', description: 'The label of the option you recommend' },
          why: { type: 'string', maxLength: 300, description: 'One line: why you recommend it' },
        },
      },
    },
    blocks: { type: 'string', maxLength: 200, description: 'Optional: what waits on the answer' },
    area: { type: 'string', maxLength: 40, description: "kind choice, optional: the area the decision belongs to, one of the project's tags (world.json tags)" },
    reversible: { type: 'boolean', description: "kind choice: true if a wrong choice is cheap to undo, false if it can't be undone" },
    touchesMoney: { type: 'boolean', description: 'kind choice: true if any option spends, moves, promises or prices money' },
    outsideWorld: { type: 'boolean', description: 'kind choice: true if any option sends, publishes, buys, deletes or reaches people or services outside this project' },
    path: { type: 'string', description: 'kind change: the file, relative to the project folder' },
    summary: { type: 'string', maxLength: 200, description: 'kind change: one line on what the change does and why' },
    edits: {
      type: 'array',
      description: 'kind change: replacements in the file as it is now, applied in order (as with Edit)',
      items: {
        type: 'object',
        required: ['old_string', 'new_string'],
        properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
      },
    },
    content: { type: 'string', description: 'kind change: the whole new text instead of edits (for a new file, or a rewrite)' },
    what: { type: 'string', maxLength: 200, description: 'kind resource: what you need' },
    why: { type: 'string', maxLength: 300, description: 'kind resource: what it is for, in one line' },
    cost: { type: 'string', maxLength: 200, description: 'kind resource, optional: what it costs, roughly' },
    byWhen: { type: 'string', maxLength: 200, description: 'kind resource, optional: when you need it by' },
    alternatives: { type: 'string', maxLength: 200, description: 'kind resource, optional: what you would do without it' },
  },
} as const

export const DECIDE_DESCRIPTION =
  "Ask the person to decide something without stopping your work. This is a background session: nobody may be watching it, so AskUserQuestion or a question in your reply would leave the work waiting until the person comes by. Use this tool instead whenever you need the person's choice. It answers at once with a ticket (D-<n>); the person answers from any session of this project, and the answer reaches you later as a message from the fleet plugin that starts with [D-<n>]. Meanwhile keep working on whatever doesn't depend on the answer, or end your turn. 1-4 questions, each with 2-4 options, the option you recommend and one line on why; give its area (one of the project's tags) and say honestly whether it's reversible and whether it touchesMoney or reaches the outsideWorld: a judge may propose an answer from what the person decided before, and never touches one that spends money, reaches outside or can't be undone. The flags are the whole call's: ask a question that touches money or reaches the outside world in a call of its own, so it doesn't hold the other questions from the judge. With kind change, it files a change to a command-level file instead (path, summary, and edits or content): the person reads its diff and applies it, and fleet writes your draft if the file is still as it was. With kind resource, it asks the person for something only they can get (a license, an access, hardware, budget: what, why, and optionally cost, byWhen, alternatives), apart from the questions of taste."

/** Checks and tidies decide's input. The engine may not enforce the schema, so this is what holds */
/** The asker's own word on a choice, which only the judges' gates read (a flag that isn't a boolean says nothing) */
export type DecideFlags = { area?: unknown; reversible?: boolean; touchesMoney?: boolean; outsideWorld?: boolean }

/** notes: what the asker should hear about its input (a long label, kept whole) */
export function checkDecide(input: any): ({ ok: true; questions: Question[]; blocks?: string; notes: string[] } & DecideFlags) | { ok: false; reason: string } {
  const list = input?.questions
  if (!Array.isArray(list) || list.length < 1 || list.length > 4) return { ok: false, reason: 'questions: give 1 to 4 questions' }
  const questions: Question[] = []
  const notes: string[] = []
  for (const [i, raw] of list.entries()) {
    const n = i + 1
    const question = text(raw?.question, 400)
    if (!question) return { ok: false, reason: `question ${n}: the question text is missing` }
    const opts = raw?.options
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > 4) return { ok: false, reason: `question ${n}: give 2 to 4 options` }
    const options: Option[] = []
    for (const o of opts) {
      const label = text(typeof o === 'string' ? o : o?.label, LABEL_MAX)
      if (!label) return { ok: false, reason: `question ${n}: every option needs a label` }
      if (Array.from(label).length > LABEL_READS) notes.push(`question ${n}, option ${letter(options.length)}: its label is ${Array.from(label).length} characters, kept whole, but a label of a few words with the detail in its description reads better`)
      if (options.some(x => x.label.toLowerCase() === label.toLowerCase())) return { ok: false, reason: `question ${n}: two options are both "${label}"` }
      const description = text(o?.description, 200)
      options.push(description ? { label, description } : { label })
    }
    // The recommendation: an option's label, or its letter (a-d)
    const said = text(raw?.recommended, LABEL_MAX)
    const k = options.findIndex(o => o.label.toLowerCase() === said.toLowerCase())
    const byLetter = /^[a-d]\)?$/i.test(said) ? LETTERS.indexOf(said[0]!.toLowerCase()) : -1
    const pick = k >= 0 ? k : byLetter < options.length ? byLetter : -1
    if (pick < 0) return { ok: false, reason: `question ${n}: recommended must be one of the option labels (${options.map(o => o.label).join(', ')})` }
    const why = text(raw?.why, 300)
    if (!why) return { ok: false, reason: `question ${n}: say in one line why you recommend "${options[pick]!.label}"` }
    const header = text(raw?.header, 12)
    questions.push({ question, ...(header ? { header } : {}), options, recommended: options[pick]!.label, why })
  }
  const blocks = text(input?.blocks, 200)
  const flags: DecideFlags = {}
  for (const k of ['reversible', 'touchesMoney', 'outsideWorld'] as const) if (typeof input?.[k] === 'boolean') flags[k] = input[k]
  if (input?.area !== undefined) flags.area = input.area
  return { ok: true, questions, notes, ...(blocks ? { blocks } : {}), ...flags }
}

export function ticketText(id: string): string {
  return `Queued as ${id} for the person. Don't assume an answer and don't build on any option yet. Keep working on what doesn't depend on it, or end your turn. The answer arrives later as a message from the fleet plugin that starts with [${id}].`
}

export const SUBAGENT_REFUSAL =
  'mcp__fleet__decide is only for the main thread: put the question, its options and your recommendation in your report to the main thread instead.'

// ---- What the asking model reads when the answers arrive. It stands on its own (after a /clear too) ----

function outcomeText(q: Question, o: Outcome | null): string {
  if (!o) return 'no answer'
  let s = ''
  if (o.label !== undefined) {
    const i = q.options.findIndex(x => x.label === o.label)
    s = i >= 0 ? `${letter(i)}) ${o.label}` : o.label
  } else s = `they wrote: "${o.text ?? ''}"`
  if (o.origin === 'judge') s += ` (the judge's answer, citing ${o.judge?.cites.join(', ') || 'the record'}${o.judge?.repeat ? ': the same question, answered so before' : ''})`
  return o.note ? `${s} (note: ${o.note})` : s
}

export type Delivery = { record: QueueRecord; outcomes: (Outcome | null)[]; drop: DropFile | null }

/** One submit for every decision ready at once: each part starts with its [D-<n>], the id the turn is matched on. own:
 * the words for a part of another kind (a change), or null for a choice */
export function deliveryText(parts: readonly Delivery[], own: (p: Delivery) => string | null = () => null): string {
  const blocks = parts.map(p => {
    const special = own(p)
    if (special !== null) return special
    const { record, outcomes, drop } = p
    const asked = record.questions.map((q, i) => `${i + 1}) ${q.question}`).join(' ')
    if (drop && drop.origin === 'judge') {
      return `[${record.id}] The judge sent this question back without asking the person: ${drop.why ?? 'it is malformed'}\nYou asked: ${asked}\nFix it (options that don't overlap, everything needed to answer it) and ask again with mcp__fleet__decide, or, if the project's files already answer it, go on with that and say so in your report.`
    }
    if (drop) {
      const why = drop.why ? ` (${drop.why})` : ''
      return `[${record.id}] The person dropped this decision without answering it${why}: ${asked}\nDon't wait for it: go on as you think best, and say what you chose in your report.`
    }
    const lines = record.questions.map((q, i) => `${i + 1}) ${q.question} → ${outcomeText(q, outcomes[i] ?? null)}`)
    const byJudge = outcomes.length > 0 && outcomes.every(o => o?.origin === 'judge')
    return `[${record.id}] ${byJudge ? "The judge answered for the person, from what they decided before (they can overrule it):" : 'The person answered:'}\n${lines.join('\n')}`
  })
  const answered = parts.some(p => !p.drop && own(p) === null)
  const judged = parts.some(p => !p.drop && own(p) === null && p.outcomes.some(o => o?.origin === 'judge'))
  return blocks.join('\n\n') + (answered ? `\n\nGo on with what depended on it.${judged ? " If the person overrules the judge, you'll hear it as a message from the fleet plugin that starts with the same id: then undo what you built on its answer." : ''}` : '')
}

/** The ids a turn's text carries in brackets (the turn that delivers them) */
export function bracketedIds(textIn: string): string[] {
  return [...new Set([...textIn.matchAll(/\[(D-\d+)\]/g)].map(m => m[1] as string))]
}

// ---- /fleet ----

/** The other kinds are answered with a verb: a change with apply (with the draft's new version when the person edited
 * it), reject or edit; a resource with done or no; an outbound with send (with its new version after an edit; allow:
 * --allow, which also adds where it goes to outbound.json), reject, edit, or done (he sent it himself). A note in
 * quotes may follow */
export type Verb = 'apply' | 'reject' | 'edit' | 'send' | 'done' | 'no'
export type AnswerItem = { n: number; letter?: string; text?: string; verb?: Verb; hash?: string; allow?: true; note?: string }
export type Command =
  | { kind: 'list' }
  | { kind: 'answer'; items: AnswerItem[] }
  | { kind: 'note'; n: number; text: string }
  | { kind: 'drop'; target: string; why: string }
  | { kind: 'status' }
  | { kind: 'init'; template: string; commitRegister: boolean }
  | { kind: 'world'; action: 'list' | 'add' | 'remove'; glob: string }
  | { kind: 'accept'; paths: string[] }
  | { kind: 'up'; dryRun: boolean; wave: number | null; names: string[] }
  | { kind: 'down'; names: string[] }
  | { kind: 'remove'; names: string[]; yes: boolean }
  | { kind: 'worktrees'; prune: boolean; yes: boolean }
  | { kind: 'budget'; target: string; amount: string }
  | { kind: 'brief'; chief: boolean }
  | { kind: 'stats'; area: string }
  | { kind: 'judges'; action: 'list' | 'live' | 'off'; area: string; force: boolean; why: string }
  | { kind: 'overrule'; id: string; answers: { q: number; letter?: string; text?: string }[]; why: string }
  | { kind: 'help' }
  | { kind: 'bad'; reason: string }

/** `1a 2b`, `1a2b`, `1) a 2) b`, `1a, 2b`, `3 "free text"` (straight or curly quotes); for a change `1 apply`,
 * `1 apply h1a2b3c4d` (the draft's version, after editing it), `1 reject`, `1 edit`; for a resource `1 done`, `1 no`;
 * for an outbound `1 send` (`1 send h1a2b3c4d`, `1 send --allow`), `1 reject`, `1 edit`, `1 done`. A verb may carry a
 * note in quotes: `1 done "the key is in the vault"` */
export function parseAnswers(args: string): AnswerItem[] | string {
  const items: AnswerItem[] = []
  let rest = args.trim()
  while (rest) {
    const m = /^(\d+)\s*[).:]?\s*(?:(apply|reject|edit|send|done|no)((?:\s+(?:h[0-9a-f]{6,14}|--allow))*)(?![A-Za-z0-9-])(?:\s*(?:"([^"]*)"|“([^”]*)”))?|([a-dA-D])(?![a-zA-Z])|"([^"]*)"|“([^”]*)”)\s*[,;]?\s*/i.exec(rest)
    if (!m) return `can't read "${rest.slice(0, 30)}": answer like /fleet 1a 2b, 3 "your words", 4 apply or 5 done "a note"`
    const n = Number(m[1])
    if (items.some(i => i.n === n)) return `${n} is answered twice`
    const said = m[7] ?? m[8]
    const note = (m[4] ?? m[5])?.trim()
    if (m[2]) {
      const verb = m[2].toLowerCase() as Verb
      const extra = (m[3] ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
      const hashes = extra.filter(x => x !== '--allow')
      if (hashes.length > 1) return `${n}: one version at most`
      const allow = extra.includes('--allow')
      if (allow && verb !== 'send') return `${n}: --allow goes with send (/fleet ${n} send --allow)`
      items.push({ n, verb, ...(hashes[0] ? { hash: hashes[0] } : {}), ...(allow ? { allow: true as const } : {}), ...(note ? { note: cut(note, 1000) } : {}) })
    } else if (said !== undefined) {
      if (!said.trim()) return `${n}: the quotes are empty`
      items.push({ n, text: cut(said.trim(), 2000) })
    } else items.push({ n, letter: (m[6] as string).toLowerCase() })
    rest = rest.slice(m[0].length)
  }
  return items.length ? items : 'nothing to answer'
}

/** Words with "quoted words" kept together */
export function wordsOf(line: string): string[] {
  return (line.match(/"[^"]*"|“[^”]*”|\S+/g) ?? []).map(w => w.replace(/^["“]|["”]$/g, '')).filter(Boolean)
}

export function parseCommand(args: string): Command {
  const line = args.trim()
  if (!line) return { kind: 'list' }
  const [word = '', ...more] = line.split(/\s+/)
  const tail = line.slice(word.length).trim()
  switch (word.toLowerCase()) {
    case 'status':
      return { kind: 'status' }
    case 'help':
      return { kind: 'help' }
    case 'brief': {
      if (more.some(w => w !== '--chief')) return { kind: 'bad', reason: 'write /fleet brief, or /fleet brief --chief for the chief’s lines too' }
      return { kind: 'brief', chief: more.includes('--chief') }
    }
    case 'stats': {
      if (more.length > 1) return { kind: 'bad', reason: 'write /fleet stats, or /fleet stats <area> for one area' }
      return { kind: 'stats', area: (more[0] ?? '').toLowerCase() }
    }
    case 'judges': {
      const w = wordsOf(tail)
      if (!w.length) return { kind: 'judges', action: 'list', area: '', force: false, why: '' }
      const [action = '', area = '', ...rest] = w
      const a = action.toLowerCase()
      const force = rest.includes('--force')
      const extra = rest.filter(x => x !== '--force')
      if ((a !== 'live' && a !== 'off') || !area || area.startsWith('--') || (a === 'off' && rest.length) || extra.length > 1) {
        return { kind: 'bad', reason: 'write /fleet judges, /fleet judges live <area> [--force "why"] or /fleet judges off <area>' }
      }
      return { kind: 'judges', action: a, area: area.toLowerCase(), force, why: cut(extra[0] ?? '', 300) }
    }
    case 'overrule':
      return parseOverrule(tail)
    case 'init': {
      const flags = more.filter(w => w.startsWith('--'))
      const names = more.filter(w => !w.startsWith('--'))
      const bad = flags.filter(f => f !== '--commit-register')
      if (bad.length) return { kind: 'bad', reason: `unknown option ${bad.join(' ')} (there is --commit-register)` }
      if (names.length > 1) return { kind: 'bad', reason: 'one template at most: /fleet init [<template>] [--commit-register]' }
      return { kind: 'init', template: names[0] ?? '', commitRegister: flags.includes('--commit-register') }
    }
    case 'up': {
      const w = wordsOf(tail)
      let wave: number | null = null
      const names: string[] = []
      for (let i = 0; i < w.length; i++) {
        const x = w[i] as string
        if (x === '--dry-run') continue
        if (x === '--wave' || x.startsWith('--wave=')) {
          const v = x === '--wave' ? w[++i] : x.slice('--wave='.length)
          if (!v || !/^\d+$/.test(v) || Number(v) < 1) return { kind: 'bad', reason: 'write /fleet up --wave <n> (a wave of roster.json, from 1)' }
          wave = Number(v)
        } else if (x.startsWith('--')) return { kind: 'bad', reason: `unknown option ${x} (there are --dry-run and --wave <n>)` }
        else names.push(x)
      }
      return { kind: 'up', dryRun: w.includes('--dry-run'), wave, names }
    }
    case 'down':
      return { kind: 'down', names: wordsOf(tail) }
    case 'remove': {
      const w = wordsOf(tail)
      const names = w.filter(x => x !== '--yes')
      if (!names.length) return { kind: 'bad', reason: 'write /fleet remove <name> (then /fleet remove <name> --yes)' }
      return { kind: 'remove', names, yes: w.includes('--yes') }
    }
    case 'worktrees': {
      const w = wordsOf(tail)
      if (w.some(x => x !== 'prune' && x !== '--yes')) return { kind: 'bad', reason: 'write /fleet worktrees, /fleet worktrees prune or /fleet worktrees prune --yes' }
      return { kind: 'worktrees', prune: w.includes('prune'), yes: w.includes('--yes') }
    }
    case 'budget': {
      const w = wordsOf(tail)
      if (w.length === 0) return { kind: 'budget', target: '', amount: '' }
      const amount = w.length > 1 && /^\+?\$?\d+(\.\d+)?$/.test(w[w.length - 1] as string) ? (w[w.length - 1] as string) : ''
      return { kind: 'budget', target: (amount ? w.slice(0, -1) : w).join(' '), amount }
    }
    case 'note': {
      const m = /^(\d+)\s+([\s\S]+)$/.exec(tail)
      if (!m) return { kind: 'bad', reason: 'write /fleet note <n> <text>' }
      return { kind: 'note', n: Number(m[1]), text: cut((m[2] as string).trim(), 1000) }
    }
    case 'drop': {
      const m = /^(\d+|D-\d+)\b\s*([\s\S]*)$/i.exec(tail)
      if (!m) return { kind: 'bad', reason: 'write /fleet drop <n> [why] (or the decision, D-<n>)' }
      return { kind: 'drop', target: (m[1] as string).toUpperCase(), why: cut((m[2] as string).trim().replace(/^["“]|["”]$/g, ''), 300) }
    }
    case 'world': {
      const [action = '', glob = '', ...extra] = more
      if (!action) return { kind: 'world', action: 'list', glob: '' }
      const a = action.toLowerCase()
      if ((a !== 'add' && a !== 'remove') || !glob || extra.length) return { kind: 'bad', reason: 'write /fleet world, /fleet world add <glob> or /fleet world remove <glob>' }
      return { kind: 'world', action: a as 'add' | 'remove', glob }
    }
    case 'accept':
      // Several paths at once (/fleet accept charter.md roster.json), a path with spaces in quotes
      return { kind: 'accept', paths: (tail.match(/"[^"]*"|“[^”]*”|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^["“']|["”']$/g, '')).filter(Boolean) }
  }
  const items = parseAnswers(line)
  return typeof items === 'string' ? { kind: 'bad', reason: items } : { kind: 'answer', items }
}

/** `/fleet overrule D-7 b "why"`: one question's letter (the first question by default), `1b 2a`, or the person's words
 * in quotes (`1 "use both"`); a quoted text after an answer is why */
export function parseOverrule(tail: string): Command {
  const bad: Command = { kind: 'bad', reason: 'write /fleet overrule D-<n> <answer> ["why"]: a letter (b), one per question (1b 2a), or your words in quotes' }
  const m = /^(D-\d+)\s+([\s\S]+)$/i.exec(tail.trim())
  if (!m) return bad
  const answers: { q: number; letter?: string; text?: string }[] = []
  let why = ''
  let rest = (m[2] as string).trim()
  while (rest) {
    const l = /^(?:(\d+)\s*[).:]?\s*)?([a-d])(?![A-Za-z0-9])\s*,?\s*/i.exec(rest)
    if (l) {
      const q = l[1] ? Number(l[1]) : 1
      if (answers.some(a => a.q === q)) return { kind: 'bad', reason: `question ${q} is answered twice` }
      answers.push({ q, letter: (l[2] as string).toLowerCase() })
      rest = rest.slice(l[0].length)
      continue
    }
    const t = /^(?:(\d+)\s*[).:]?\s*)?(?:"([^"]*)"|“([^”]*)”)\s*,?\s*/.exec(rest)
    if (!t) return bad
    const words = (t[2] ?? t[3] ?? '').trim()
    rest = rest.slice(t[0].length)
    if (!words) return { kind: 'bad', reason: 'the quotes are empty' }
    if (!t[1] && answers.length) {
      if (why) return bad
      why = cut(words, 300)
      continue
    }
    const q = t[1] ? Number(t[1]) : 1
    if (answers.some(a => a.q === q)) return { kind: 'bad', reason: `question ${q} is answered twice` }
    answers.push({ q, text: cut(words, 2000) })
  }
  return answers.length ? { kind: 'overrule', id: (m[1] as string).toUpperCase(), answers, why } : bad
}

export const HELP = [
  '/fleet                 the questions waiting for you in this project, numbered',
  '/fleet 1a 2b           answer them (also 1) a 2) b, or 3 "your words")',
  '/fleet note <n> <text> add a note for whoever asked question n',
  '/fleet drop <n> [why]  drop the decision of question n without answering it',
  '/fleet status          what fleet does in this session, the shared files, what changed and who is behind',
  '/fleet world           the shared files (world.json); /fleet world add <glob>, /fleet world remove <glob>',
  '/fleet accept [path…]  stamp changes made outside fleet (your editor, a script) as yours, one path or several; alone, lists them',
  '/fleet accept checks   let fleet run the check scripts world.json lists, as they are now',
  '/fleet accept channel  let fleet run your command channel (roster.json person.channel), as it is now',
  '/fleet 4 apply         apply the change of item 4 as drafted (also 4 reject, and 4 edit to change the draft first)',
  '/fleet 5 done "note"   you got what item 5 asks for (a license, an access…); 5 no "why" if not',
  '/fleet 6 send          send the outbound of item 6 exactly as shown (also 6 reject, 6 edit, and 6 done if you sent it yourself)',
  '/fleet 6 send --allow  send it, and add its host or git remote to outbound.json as yours, so the next one needs no draft',
  '/fleet brief [--chief] what needs you, what changed and who changed it, what’s blocked, the spend, the inputs and ideas',
  '/fleet stats [area]    what the judges proposed per area, how often you agreed, what they cost',
  '/fleet judges          the live areas, the areas back in shadow, your taste; /fleet judges live <area> [--force "why"], /fleet judges off <area>',
  '/fleet overrule D-7 b ["why"]  correct the judge\'s answer to D-7: its asker hears it, and the judges read it next time',
  '/fleet init [template] set fleet up in this project (.claude/fleet/): blank, solo, software or proposal',
  '/fleet up [--dry-run] [--wave n] [name…]  start the roster\'s instances that aren\'t running (--dry-run: the plan, the lints, the cost)',
  '/fleet down [name…]    take instances down: no wakes or nudges, /fleet up skips them (s in the panel stops one)',
  '/fleet remove <name>   forget an instance\'s settings and state (it stays in roster.json); --yes to do it',
  '/fleet budget [name|project] [amount|+n]  today\'s budgets; set or raise one for today',
  '/fleet worktrees [prune [--yes]]  the linked worktrees under .claude/worktrees/, and removing those no session is in',
].join('\n')

/** How long ago, short: 40s, 5m, 3h, 2d */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** What the listing says about an asker, from $.sessions' status (null: not known) */
export type AskerView = { name: string; state: string | null }

/** One numbered question, as /fleet shows it; judge: what the judge proposed on it (judges.ts proposalLine) */
export function heldText(n: number, record: QueueRecord, q: number, asker: AskerView, now: number, judge: string | null = null): string {
  const question = record.questions[q - 1] as Question
  const lines = [`${n}. ${question.question}`]
  for (const [i, o] of question.options.entries()) lines.push(`   ${letter(i)}) ${o.label}${o.description ? `: ${o.description}` : ''}`)
  const k = question.options.findIndex(o => o.label === question.recommended)
  lines.push(`   Recommended: ${letter(k)}, ${question.why}`)
  if (judge) lines.push(`   ${judge}`)
  const who = asker.state ? `${asker.name} (${asker.state})` : asker.name
  const of = record.questions.length > 1 ? ` (${q} of ${record.questions.length})` : ''
  lines.push(`   ${who} · ${record.id}${of} · ${ago(now - record.at)} ago${record.blocks ? ` · blocks: ${record.blocks}` : ''}`)
  return lines.join('\n')
}

/** What the person is told about a decision that's answered but not delivered yet, by its asker's state */
export function waitingText(record: QueueRecord, asker: AskerView, dropped: boolean, byJudge = false): string {
  const what = byJudge ? (dropped ? 'sent back by the judge' : 'answered by the judge') : dropped ? 'dropped' : 'answered'
  const how =
    asker.state === 'idle'
      ? 'delivering'
      : asker.state === 'working'
        ? 'delivered when its turn ends'
        : asker.state === 'waiting'
          ? 'delivered once it gets past what it waits on'
          : asker.state === 'stopped'
            ? 'stopped: u in the panel restarts it, then it gets it'
            : asker.state === 'gone'
              ? `gone: /fleet drop ${record.id} clears it`
              : 'delivered when its fleet runs'
  return `   ${record.id} · ${asker.name} · ${what}, ${how}`
}

export function configText(c: Config): string {
  return `${JSON.stringify(c, null, 2)}\n`
}

/** config.json: its fields, or why it can't be used (a newer fleet wrote it, or it isn't JSON) */
export function parseConfig(textIn: string): { config: Config } | { problem: string } {
  let c: any
  try {
    c = JSON.parse(textIn)
  } catch {
    return { problem: "config.json isn't valid JSON: fix it, or delete it and run /fleet init again" }
  }
  if (!c || typeof c !== 'object' || typeof c.configFormat !== 'number') return { problem: 'config.json has no configFormat: fix it, or delete it and run /fleet init again' }
  if (c.configFormat > CONFIG_FORMAT) return { problem: `config.json is from a newer fleet (configFormat ${c.configFormat}): restart this session (u) to load it` }
  return { config: { ...c, template: typeof c.template === 'string' ? c.template : 'blank', commitRegister: c.commitRegister === true } }
}

export function gitignoreText(commitRegister: boolean): string {
  const runtime = "# What fleet's sessions write as they work: the landings on shared files, what each session read, versions and flags, each instance's settings and state\nevents/\nreads/\nstate/\ninstances/\n# Items from outside as they arrived (the inbox, and intake's raw items, duplicates and seen marks)\ninbox/\nintake/\n"
  return commitRegister
    ? `# Written by /fleet init from config.json ("commitRegister": true): the register is committed, the rest of decisions/ is not\ndecisions/*\n!decisions/register/\n${runtime}`
    : `# Written by /fleet init from config.json ("commitRegister": false): fleet's decisions and their register stay out of git\ndecisions/\n${runtime}`
}

// ---- AskUserQuestion, as the person answered it in the session ----

/** A multi-select's picks: a list, or the labels joined with ", " (a label may hold ", " itself: the longest run of
 * pieces that is a label wins), each matched against the options; what matches none is the text he typed */
export function multiOutcome(q: DialogQuestion, a: unknown): Outcome | null {
  const pieces = Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && !!x) : typeof a === 'string' && a ? a.split(', ') : []
  const labels: string[] = []
  const rest: string[] = []
  for (let i = 0; i < pieces.length; ) {
    let j = pieces.length
    for (; j > i; j--) if (q.options.some(o => o.label === pieces.slice(i, j).join(', '))) break
    if (j > i) {
      const l = pieces.slice(i, j).join(', ')
      if (!labels.includes(l)) labels.push(l)
      i = j
    } else rest.push(pieces[i++] as string)
  }
  const text = cut(rest.join(', ').trim(), 2000)
  if (!labels.length) return text ? { text } : null
  return { labels, ...(text ? { text } : {}) }
}

/** The person's answers to a model's AskUserQuestion, from what the dialog returned: an object with answers (an option
 * picked, the options picked in a multi-select, or text typed), or an error string ("Chat about this", Esc), which
 * records as not answered */
export function classifyDialog(questions: readonly DialogQuestion[], r: any): { answers: (Outcome | null)[]; state: RegisterState; why?: string } {
  const res = r?.result
  if (res && typeof res === 'object' && res.answers && typeof res.answers === 'object') {
    const answers = questions.map(q => {
      const a = res.answers[q.question]
      if (q.multiSelect) return multiOutcome(q, a)
      if (typeof a !== 'string' || !a) return null
      return q.options.some(o => o.label === a) ? { label: a } : { text: cut(a, 2000) }
    })
    return answers.some(Boolean) ? { answers, state: 'answered' } : { answers, state: 'not answered', why: 'no answer' }
  }
  const none = questions.map(() => null)
  if (typeof r?.deny === 'string') return { answers: none, state: 'not answered', why: 'refused before it was asked' }
  if (typeof res === 'string') return { answers: none, state: 'not answered', why: res.includes('wants to clarify') ? 'chat' : 'dismissed' }
  return { answers: none, state: 'not answered', why: 'no answer' }
}

/** A dialog's questions as the register keeps them */
export function dialogQuestions(input: any): DialogQuestion[] {
  const list = Array.isArray(input?.questions) ? input.questions : []
  return list.slice(0, 4).map((q: any) => {
    const options = (Array.isArray(q?.options) ? q.options : []).map((o: any) => {
      const label = text(o?.label, 200)
      const description = text(o?.description, 400)
      return description ? { label, description } : { label }
    })
    const header = text(q?.header, 40)
    return { question: text(q?.question, 1000), ...(header ? { header } : {}), options, ...(q?.multiSelect ? { multiSelect: true } : {}) }
  })
}

/** Reads a wire file of this format, or says why not */
export function parseWire<T>(textIn: string): { value: T } | { otherFormat: number } | null {
  try {
    const v = JSON.parse(textIn)
    if (!v || typeof v !== 'object') return null
    if (v.format !== FORMAT) return { otherFormat: Number(v.format) || 0 }
    return { value: v as T }
  } catch {
    return null
  }
}
