// Pure logic of fleet's decisions (tested in tests/decisions.test.ts): the records and their files, the decide tool's
// input, the /fleet grammar, what the person reads and what the asking model reads. No `$` here.
//
// Files, all under <project>/.claude/fleet/ (the project folder is fleet's data folder):
//   config.json                          person data (configFormat): the template and whether the register is committed
//   world.json                           person data (worldFormat): the world, the globs of the shared files (changes.ts)
//   .gitignore                           written by /fleet init from config.json
//   decisions/queue/D-<n>.json           wire (format): an open decision, written once by the session that asked
//   decisions/answers/D-<n>.<q>.json     wire: the answer to question q, published no-clobber (the first answer wins)
//   decisions/answers/D-<n>.<q>.note.json  wire: a note on question q (the last one wins)
//   decisions/answers/D-<n>.drop.json    wire: the person dropped the decision without answering it
//   decisions/register/YYYY-MM/<id>.json person data (registerFormat): every closed decision and recorded dialog
//   decisions/last                       wire: the highest D-<n> handed out (a hint for the next one)
//   decisions/prune/YYYY-MM-DD           wire: the session that publishes it runs that day's prune
//   decisions/tmp/                       files about to be published or moved into place (events' too)
//   events/YYYY-MM-DD/HH/<ms>-<sid8>-<n>.json  wire: one landing on a world file, written once by the session that saw it
//   events/latest                        wire: the last event's name, rewritten by each writer; every session watches it
//   events/claims/<hash>                 wire: an outside change claimed no-clobber, so one session records it
//   reads/<sessionId>.json               wire: what that session's threads read of the world, written only by it
//   state/revs/<id>/<n>.json             wire: version n of the record <id> (records.ts), published no-clobber
//   state/suspects.json                  wire: the suspect files, written by the sweeper
//   state/checks/<hash>.json             wire: the last results of the checks on one file (the last run wins)
//   state/checks-stamp.json              wire: the checks the person stamped (/fleet accept checks)
//   state/sweeper.json                   wire: the sweeper's lease, rewritten by whoever holds or takes it
//   state/commit.json                    wire: the last world commit, written by the sweeper
// A reader that meets another format acts on nothing and says to restart (u): there is no code for older formats.

/** The format of the wire files: queue/, answers/, last, prune/, events/, reads/, state/. Raise it when a key or its
 * meaning changes */
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
export type QueueRecord = {
  format: number
  fleet: string
  id: string
  at: number
  asker: Asker
  questions: Question[]
  blocks?: string
}
/** origin: how the person typed it (composer: a terminal); session: the session it was typed in */
export type AnswerFile = { format: number; id: string; q: number; label?: string; text?: string; origin: string; session: string; at: number }
export type NoteFile = { format: number; id: string; q: number; text: string; origin: string; at: number }
export type DropFile = { format: number; id: string; why?: string; origin: string; session: string; at: number }
/** One question's outcome in the register: the option picked or the text typed, and any note */
export type Outcome = { label?: string; text?: string; note?: string; origin?: string; session?: string; at?: number }
export type RegisterState = 'delivered' | 'dropped' | 'abandoned' | 'answered' | 'not answered'
export type RegisterRecord = {
  registerFormat: number
  id: string
  /** decide: asked through mcp__fleet__decide; dialog: an AskUserQuestion the person answered in the session */
  source: 'decide' | 'dialog'
  fleet: string
  at: number
  asker: Asker
  questions: (Question | DialogQuestion)[]
  blocks?: string
  answers: (Outcome | null)[]
  state: RegisterState
  why?: string
  delivered?: { at: number; turnId?: string; how: 'submit' }
  closedAt: number
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
    const p = progress(r.id, r.questions.length, names)
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

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** The input of mcp__fleet__decide as JSON schema: 1-4 questions, each with 2-4 options, the recommended one and why */
export const DECIDE_SCHEMA = {
  type: 'object',
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      description: 'The questions, numbered for the person in this order',
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
                label: { type: 'string', maxLength: 60 },
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
  },
} as const

export const DECIDE_DESCRIPTION =
  "Ask the person to decide something without stopping your work. This is a background session: nobody may be watching it, so AskUserQuestion or a question in your reply would leave the work waiting until the person comes by. Use this tool instead whenever you need the person's choice. It answers at once with a ticket (D-<n>); the person answers from any session of this project, and the answer reaches you later as a message from the fleet plugin that starts with [D-<n>]. Meanwhile keep working on whatever doesn't depend on the answer, or end your turn. 1-4 questions, each with 2-4 options, the option you recommend and one line on why."

/** Checks and tidies decide's input. The engine may not enforce the schema, so this is what holds */
export function checkDecide(input: any): { ok: true; questions: Question[]; blocks?: string } | { ok: false; reason: string } {
  const list = input?.questions
  if (!Array.isArray(list) || list.length < 1 || list.length > 4) return { ok: false, reason: 'questions: give 1 to 4 questions' }
  const questions: Question[] = []
  for (const [i, raw] of list.entries()) {
    const n = i + 1
    const question = text(raw?.question, 400)
    if (!question) return { ok: false, reason: `question ${n}: the question text is missing` }
    const opts = raw?.options
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > 4) return { ok: false, reason: `question ${n}: give 2 to 4 options` }
    const options: Option[] = []
    for (const o of opts) {
      const label = text(typeof o === 'string' ? o : o?.label, 60)
      if (!label) return { ok: false, reason: `question ${n}: every option needs a label` }
      if (options.some(x => x.label.toLowerCase() === label.toLowerCase())) return { ok: false, reason: `question ${n}: two options are both "${label}"` }
      const description = text(o?.description, 200)
      options.push(description ? { label, description } : { label })
    }
    // The recommendation: an option's label, or its letter (a-d)
    const said = text(raw?.recommended, 60)
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
  return blocks ? { ok: true, questions, blocks } : { ok: true, questions }
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
  return o.note ? `${s} (note: ${o.note})` : s
}

export type Delivery = { record: QueueRecord; outcomes: (Outcome | null)[]; drop: DropFile | null }

/** One submit for every decision ready at once: each part starts with its [D-<n>], the id the turn is matched on */
export function deliveryText(parts: readonly Delivery[]): string {
  const blocks = parts.map(({ record, outcomes, drop }) => {
    if (drop) {
      const asked = record.questions.map((q, i) => `${i + 1}) ${q.question}`).join(' ')
      const why = drop.why ? ` (${drop.why})` : ''
      return `[${record.id}] The person dropped this decision without answering it${why}: ${asked}\nDon't wait for it: go on as you think best, and say what you chose in your report.`
    }
    const lines = record.questions.map((q, i) => `${i + 1}) ${q.question} → ${outcomeText(q, outcomes[i] ?? null)}`)
    return `[${record.id}] The person answered:\n${lines.join('\n')}`
  })
  const answered = parts.some(p => !p.drop)
  return blocks.join('\n\n') + (answered ? '\n\nGo on with what depended on it.' : '')
}

/** The ids a turn's text carries in brackets (the turn that delivers them) */
export function bracketedIds(textIn: string): string[] {
  return [...new Set([...textIn.matchAll(/\[(D-\d+)\]/g)].map(m => m[1] as string))]
}

// ---- /fleet ----

export type AnswerItem = { n: number; letter?: string; text?: string }
export type Command =
  | { kind: 'list' }
  | { kind: 'answer'; items: AnswerItem[] }
  | { kind: 'note'; n: number; text: string }
  | { kind: 'drop'; target: string; why: string }
  | { kind: 'status' }
  | { kind: 'init'; template: string; commitRegister: boolean }
  | { kind: 'world'; action: 'list' | 'add' | 'remove'; glob: string }
  | { kind: 'accept'; path: string }
  | { kind: 'help' }
  | { kind: 'bad'; reason: string }

/** `1a 2b`, `1a2b`, `1) a 2) b`, `1a, 2b`, `3 "free text"` (straight or curly quotes) */
export function parseAnswers(args: string): AnswerItem[] | string {
  const items: AnswerItem[] = []
  let rest = args.trim()
  while (rest) {
    const m = /^(\d+)\s*[).:]?\s*(?:([a-dA-D])(?![a-zA-Z])|"([^"]*)"|“([^”]*)”)\s*[,;]?\s*/.exec(rest)
    if (!m) return `can't read "${rest.slice(0, 30)}": answer like /fleet 1a 2b, or 3 "your words"`
    const n = Number(m[1])
    if (items.some(i => i.n === n)) return `${n} is answered twice`
    const said = m[3] ?? m[4]
    if (said !== undefined) {
      if (!said.trim()) return `${n}: the quotes are empty`
      items.push({ n, text: said.trim().slice(0, 2000) })
    } else items.push({ n, letter: (m[2] as string).toLowerCase() })
    rest = rest.slice(m[0].length)
  }
  return items.length ? items : 'nothing to answer'
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
    case 'init': {
      const flags = more.filter(w => w.startsWith('--'))
      const names = more.filter(w => !w.startsWith('--'))
      const bad = flags.filter(f => f !== '--commit-register')
      if (bad.length) return { kind: 'bad', reason: `unknown option ${bad.join(' ')} (there is --commit-register)` }
      if (names.length > 1) return { kind: 'bad', reason: 'one template at most: /fleet init [blank] [--commit-register]' }
      return { kind: 'init', template: names[0] ?? 'blank', commitRegister: flags.includes('--commit-register') }
    }
    case 'note': {
      const m = /^(\d+)\s+([\s\S]+)$/.exec(tail)
      if (!m) return { kind: 'bad', reason: 'write /fleet note <n> <text>' }
      return { kind: 'note', n: Number(m[1]), text: (m[2] as string).trim().slice(0, 1000) }
    }
    case 'drop': {
      const m = /^(\d+|D-\d+)\b\s*([\s\S]*)$/i.exec(tail)
      if (!m) return { kind: 'bad', reason: 'write /fleet drop <n> [why] (or the decision, D-<n>)' }
      return { kind: 'drop', target: (m[1] as string).toUpperCase(), why: (m[2] as string).trim().replace(/^["“]|["”]$/g, '').slice(0, 300) }
    }
    case 'world': {
      const [action = '', glob = '', ...extra] = more
      if (!action) return { kind: 'world', action: 'list', glob: '' }
      const a = action.toLowerCase()
      if ((a !== 'add' && a !== 'remove') || !glob || extra.length) return { kind: 'bad', reason: 'write /fleet world, /fleet world add <glob> or /fleet world remove <glob>' }
      return { kind: 'world', action: a as 'add' | 'remove', glob }
    }
    case 'accept':
      return { kind: 'accept', path: tail.replace(/^["']|["']$/g, '') }
  }
  const items = parseAnswers(line)
  return typeof items === 'string' ? { kind: 'bad', reason: items } : { kind: 'answer', items }
}

export const HELP = [
  '/fleet                 the questions waiting for you in this project, numbered',
  '/fleet 1a 2b           answer them (also 1) a 2) b, or 3 "your words")',
  '/fleet note <n> <text> add a note for whoever asked question n',
  '/fleet drop <n> [why]  drop the decision of question n without answering it',
  '/fleet status          what fleet does in this session, the shared files, what changed and who is behind',
  '/fleet world           the shared files (world.json); /fleet world add <glob>, /fleet world remove <glob>',
  '/fleet accept [path]   stamp a change made outside fleet (your editor, a script) as yours; alone, lists them',
  '/fleet accept checks   let fleet run the check scripts world.json lists, as they are now',
  '/fleet init            set fleet up in this project (.claude/fleet/)',
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

/** One numbered question, as /fleet shows it */
export function heldText(n: number, record: QueueRecord, q: number, asker: AskerView, now: number): string {
  const question = record.questions[q - 1] as Question
  const lines = [`${n}. ${question.question}`]
  for (const [i, o] of question.options.entries()) lines.push(`   ${letter(i)}) ${o.label}${o.description ? `: ${o.description}` : ''}`)
  const k = question.options.findIndex(o => o.label === question.recommended)
  lines.push(`   Recommended: ${letter(k)}, ${question.why}`)
  const who = asker.state ? `${asker.name} (${asker.state})` : asker.name
  const of = record.questions.length > 1 ? ` (${q} of ${record.questions.length})` : ''
  lines.push(`   ${who} · ${record.id}${of} · ${ago(now - record.at)} ago${record.blocks ? ` · blocks: ${record.blocks}` : ''}`)
  return lines.join('\n')
}

/** What the person is told about a decision that's answered but not delivered yet, by its asker's state */
export function waitingText(record: QueueRecord, asker: AskerView, dropped: boolean): string {
  const what = dropped ? 'dropped' : 'answered'
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
  const runtime = "# What fleet's sessions write as they work: the landings on shared files, what each session read, versions and flags\nevents/\nreads/\nstate/\n"
  return commitRegister
    ? `# Written by /fleet init from config.json ("commitRegister": true): the register is committed, the rest of decisions/ is not\ndecisions/*\n!decisions/register/\n${runtime}`
    : `# Written by /fleet init from config.json ("commitRegister": false): fleet's decisions and their register stay out of git\ndecisions/\n${runtime}`
}

// ---- AskUserQuestion, as the person answered it in the session ----

/** The person's answers to a model's AskUserQuestion, from what the dialog returned: an object with answers (an option
 * picked, or text typed), or an error string ("Chat about this", Esc), which records as not answered */
export function classifyDialog(questions: readonly DialogQuestion[], r: any): { answers: (Outcome | null)[]; state: RegisterState; why?: string } {
  const res = r?.result
  if (res && typeof res === 'object' && res.answers && typeof res.answers === 'object') {
    const answers = questions.map(q => {
      const a = res.answers[q.question]
      if (typeof a !== 'string' || !a) return null
      return q.options.some(o => o.label === a) ? { label: a } : { text: a.slice(0, 2000) }
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
