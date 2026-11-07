import { expect, test } from 'claude-code/testing'

import {
  bracketedIds,
  checkDecide,
  classifyDialog,
  deliveryText,
  gitignoreText,
  heldCount,
  listedItems,
  listedKey,
  listedMembers,
  monthBefore,
  monthOf,
  parseAnswerName,
  parseAnswers,
  parseCommand,
  parseConfig,
  parseWire,
  pointsAtItem,
  progress,
  shown,
  type QueueRecord,
} from '../hooks/decisions'
import { alikeQuestion } from '../hooks/judges'

const record = (id: string, n: number): QueueRecord => ({
  format: 1,
  fleet: '0.1.0',
  id,
  at: 0,
  asker: { ref: 'aaaaaaaa', sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'TEST A', root: '/Users/x/proj' },
  questions: Array.from({ length: n }, (_, i) => ({ question: `Q${i + 1}?`, options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'w' })),
})

test('answers: 1a 2b, 1) a 2) b, commas, free text in quotes; anything else is refused with how to write it', () => {
  expect(parseAnswers('1a 2b')).toEqual([{ n: 1, letter: 'a' }, { n: 2, letter: 'b' }])
  expect(parseAnswers('1) a 2) B')).toEqual([{ n: 1, letter: 'a' }, { n: 2, letter: 'b' }])
  expect(parseAnswers('1a, 2b')).toEqual([{ n: 1, letter: 'a' }, { n: 2, letter: 'b' }])
  expect(parseAnswers('1a2b')).toEqual([{ n: 1, letter: 'a' }, { n: 2, letter: 'b' }])
  expect(typeof parseAnswers('1ab')).toBe('string')
  expect(parseAnswers('3 "a plain map, for now" 4c')).toEqual([{ n: 3, text: 'a plain map, for now' }, { n: 4, letter: 'c' }])
  expect(parseAnswers('1 “curly”')).toEqual([{ n: 1, text: 'curly' }])
  expect(typeof parseAnswers('1e')).toBe('string')
  expect(typeof parseAnswers('1a 1b')).toBe('string')
  expect(typeof parseAnswers('yes')).toBe('string')
  expect(typeof parseAnswers('1 ""')).toBe('string')
})

test('his words: quotes inside a quoted answer are kept, unquoted words run to the end, and what can\'t be read shows the line and the form that records it', () => {
  // B20: the answer ends at the closing quote after which the rest reads, so quotes inside it stay
  const said = 'Start from the copy called "Archive" on the shared drive, then tell me what is missing'
  expect(parseAnswers(`1 "${said}"`)).toEqual([{ n: 1, text: said }])
  expect(parseAnswers('3 "the copy called "Archive" please" 4b')).toEqual([{ n: 3, text: 'the copy called "Archive" please' }, { n: 4, letter: 'b' }])
  expect(parseAnswers('1 "he said "no" to that"')).toEqual([{ n: 1, text: 'he said "no" to that' }])
  expect(parseAnswers('1 "use version "2 of it" please"')).toEqual([{ n: 1, text: 'use version "2 of it" please' }])
  expect(parseAnswers('1 "x" 2 "y"')).toEqual([{ n: 1, text: 'x' }, { n: 2, text: 'y' }])
  expect(parseAnswers('2 “mixed "quotes” inside”')).toEqual([{ n: 2, text: 'mixed "quotes” inside' }])
  // Unquoted words after the number: to the end of the line, as his words; a quote left open too
  expect(parseAnswers('3 use the fast path, the other is too slow')).toEqual([{ n: 3, text: 'use the fast path, the other is too slow', bare: true }])
  expect(parseAnswers('1a 2 keep both for now')).toEqual([{ n: 1, letter: 'a' }, { n: 2, text: 'keep both for now', bare: true }])
  expect(parseAnswers('3 "use the fast path')).toEqual([{ n: 3, text: 'use the fast path' }])
  expect(parseAnswers('D-7 neither, ask again next week')).toEqual([{ n: 'D-7', text: 'neither, ask again next week', bare: true }])
  // A verb then words: the note (and on a question, the words are the answer)
  expect(parseAnswers('5 done the key is in the vault')).toEqual([{ n: 5, verb: 'done', note: 'the key is in the vault', words: 'done the key is in the vault', bareNote: true }])
  expect(parseAnswers('2 no, the other one')).toEqual([{ n: 2, verb: 'no', note: 'the other one', words: 'no, the other one', bareNote: true }])
  // After send or apply, words in no quotes are marked: the answer refuses them (they may say not to)
  expect(parseAnswers('2 send not yet')).toEqual([{ n: 2, verb: 'send', note: 'not yet', words: 'send not yet', bareNote: true }])
  expect(parseAnswers('2 send?')).toEqual([{ n: 2, verb: 'send', note: '?', words: 'send?', bareNote: true }])
  expect(parseAnswers('2 send --allow just this once')).toEqual([{ n: 2, verb: 'send', allow: true, note: 'just this once', words: 'send --allow just this once', bareNote: true }])
  expect(parseAnswers('3 apply but rename X first')).toMatchObject([{ n: 3, verb: 'apply', note: 'but rename X first', bareNote: true }])
  expect(parseAnswers('2 send "not yet"')).toEqual([{ n: 2, verb: 'send', note: 'not yet' }])
  // What can't be read: the whole line back, and the form that records it
  const letterThen = parseAnswers('1a 3 b because it is faster') as string
  expect(letterThen).toBe(`can't read "3 b because it is faster", so nothing was recorded. You typed:\n/fleet 1a 3 b because it is faster\nThis records it: /fleet 1a 3 "b because it is faster"`)
  expect(parseAnswers('2 ok')).toContain('This records it: /fleet 2 "ok"')
  expect(parseAnswers('yes please')).toContain('You typed:\n/fleet yes please\nAnswer like /fleet 1a 2b')
  // Past the cap: refused with its length, never cut
  const long = 'x'.repeat(4001)
  expect(parseAnswers(`1 "${long}"`)).toContain('1: your words are 4001 characters, and an answer keeps at most 4000, so nothing was recorded.')
  expect(parseAnswers(`1 "${'x'.repeat(4000)}"`)).toEqual([{ n: 1, text: 'x'.repeat(4000) }])
  expect(parseCommand(`note 2 ${long}`)).toMatchObject({ kind: 'bad', reason: expect.stringContaining('your note is 4001 characters') })
  expect(parseCommand(`note 2 "keep it local"`)).toEqual({ kind: 'note', n: 2, text: 'keep it local' })
  expect(parseCommand(`drop 3 ${'y'.repeat(1001)}`)).toMatchObject({ kind: 'bad', reason: expect.stringContaining('your reason is 1001 characters') })
})

test('/fleet words: list, status, init, note, drop, help; the rest are answers', () => {
  expect(parseCommand('')).toEqual({ kind: 'list' })
  expect(parseCommand(' status ')).toEqual({ kind: 'status' })
  expect(parseCommand('init')).toEqual({ kind: 'init', template: '', commitRegister: false })
  expect(parseCommand('init blank --commit-register')).toEqual({ kind: 'init', template: 'blank', commitRegister: true })
  expect(parseCommand('init --force').kind).toBe('bad')
  expect(parseCommand('note 2 keep it local')).toEqual({ kind: 'note', n: 2, text: 'keep it local' })
  expect(parseCommand('note').kind).toBe('bad')
  expect(parseCommand('drop 3 not needed')).toEqual({ kind: 'drop', target: '3', why: 'not needed' })
  expect(parseCommand('drop d-12')).toEqual({ kind: 'drop', target: 'D-12', why: '' })
  expect(parseCommand('1a 2b')).toEqual({ kind: 'answer', items: [{ n: 1, letter: 'a' }, { n: 2, letter: 'b' }] })
})

test('a change is answered with a verb: apply (with the edited draft’s version), reject, edit; mixed with letters', () => {
  expect(parseAnswers('1 apply 2b 3 reject')).toEqual([{ n: 1, verb: 'apply' }, { n: 2, letter: 'b' }, { n: 3, verb: 'reject' }])
  expect(parseAnswers('4 Apply h1A2b3c4d')).toEqual([{ n: 4, verb: 'apply', hash: 'h1a2b3c4d' }])
  expect(parseAnswers('1 edit, 2 apply')).toEqual([{ n: 1, verb: 'edit' }, { n: 2, verb: 'apply' }])
  // Not a verb: his words (a change says it records none of them)
  expect(parseAnswers('1 applied')).toEqual([{ n: 1, text: 'applied', bare: true }])
  expect(parseAnswers('1 apply 1a')).toContain('1 is answered twice')
})

test('a resource is answered done or no, an outbound send (with its version after an edit), reject, edit or done; a note may follow', () => {
  expect(parseAnswers('1 done "the key is in the vault" 2 no')).toEqual([{ n: 1, verb: 'done', note: 'the key is in the vault' }, { n: 2, verb: 'no' }])
  expect(parseAnswers('3 send h1a2b3c4d, 4 reject “not yet”')).toEqual([{ n: 3, verb: 'send', hash: 'h1a2b3c4d' }, { n: 4, verb: 'reject', note: 'not yet' }])
  expect(parseAnswers('5 "free text" 6a')).toEqual([{ n: 5, text: 'free text' }, { n: 6, letter: 'a' }])
  expect(parseAnswers('1 nope')).toEqual([{ n: 1, text: 'nope', bare: true }])
  // send --allow: it also adds where it goes to outbound.json; with the version, in either order
  expect(parseAnswers('1 send --allow 2 send h1a2b3c --allow "mine"')).toEqual([{ n: 1, verb: 'send', allow: true }, { n: 2, verb: 'send', hash: 'h1a2b3c', allow: true, note: 'mine' }])
  expect(parseAnswers('3 send --allow h1a2b3c4d')).toEqual([{ n: 3, verb: 'send', hash: 'h1a2b3c4d', allow: true }])
  expect(parseAnswers('1 apply --allow')).toContain('1: --allow goes with send (/fleet 1 send --allow), so nothing was recorded.')
  expect(parseAnswers('1 send --allowed')).toContain("1: --allowed isn't an option of send (there is --allow)")
  expect(parseAnswers('1 send h1a2b3c h4d5e6f')).toContain('1: one version at most')
  expect(parseCommand('brief')).toEqual({ kind: 'brief', chief: false })
  expect(parseCommand('brief --chief')).toEqual({ kind: 'brief', chief: true })
  expect(parseCommand('brief all').kind).toBe('bad')
})

test("/fleet up, down, remove, budget, worktrees: their words and what's refused", () => {
  expect(parseCommand('up')).toEqual({ kind: 'up', dryRun: false, wave: null, names: [], stopped: false, restartWhenIdle: false })
  expect(parseCommand('up --dry-run --wave 2')).toEqual({ kind: 'up', dryRun: true, wave: 2, names: [], stopped: false, restartWhenIdle: false })
  expect(parseCommand('up --restart-when-idle Chief')).toEqual({ kind: 'up', dryRun: false, wave: null, names: ['Chief'], stopped: false, restartWhenIdle: true })
  expect(parseCommand('up --stopped')).toEqual({ kind: 'up', dryRun: false, wave: null, names: [], stopped: true, restartWhenIdle: false })
  expect(parseCommand('up "Area A" chief --wave=1')).toEqual({ kind: 'up', dryRun: false, wave: 1, names: ['Area A', 'chief'], stopped: false, restartWhenIdle: false })
  expect(parseCommand('up --wave').kind).toBe('bad')
  expect(parseCommand('up --wave 0').kind).toBe('bad')
  expect(parseCommand('up --force').kind).toBe('bad')
  expect(parseCommand('down')).toEqual({ kind: 'down', names: [] })
  expect(parseCommand('down Lead "Area A"')).toEqual({ kind: 'down', names: ['Lead', 'Area A'] })
  expect(parseCommand('remove "Area A" --yes')).toEqual({ kind: 'remove', names: ['Area A'], yes: true })
  expect(parseCommand('remove').kind).toBe('bad')
  expect(parseCommand('budget')).toEqual({ kind: 'budget', target: '', amount: '' })
  expect(parseCommand('budget "Tester 2" +5')).toEqual({ kind: 'budget', target: 'Tester 2', amount: '+5' })
  expect(parseCommand('budget project 40')).toEqual({ kind: 'budget', target: 'project', amount: '40' })
  expect(parseCommand('budget Lead')).toEqual({ kind: 'budget', target: 'Lead', amount: '' })
  expect(parseCommand('worktrees')).toEqual({ kind: 'worktrees', prune: false, yes: false })
  expect(parseCommand('worktrees prune --yes')).toEqual({ kind: 'worktrees', prune: true, yes: true })
  expect(parseCommand('worktrees all').kind).toBe('bad')
})

test('a change waits for one answer and counts for the band; a kind this fleet doesn’t know is never counted', () => {
  const change: QueueRecord = { ...record('D-5', 0), kind: 'change' }
  const other = { ...record('D-6', 0), kind: 'judge' } as unknown as QueueRecord
  expect(heldCount([change, other, record('D-7', 2)], new Set())).toBe(3)
  expect(heldCount([change], new Set(['D-5.1.json']))).toBe(0)
  // The delivery: a change's own words, and "Go on with what depended on it." only after a choice
  const text = deliveryText([{ record: change, outcomes: [{ label: 'applied' }], drop: null }], p => (p.record.kind === 'change' ? `[${p.record.id}] The person applied it.` : null))
  expect(text).toBe('[D-5] The person applied it.')
})

test("decide's input: counts, labels, the recommendation by label or letter, and a reason", () => {
  const ok = checkDecide({ questions: [{ question: ' Which? ', options: ['A', { label: 'B', description: 'bee' }], recommended: 'b', why: 'cheaper' }] })
  expect(ok).toEqual({ ok: true, notes: [], questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B', description: 'bee' }], recommended: 'B', why: 'cheaper' }] })
  // A long label is kept whole (and recommended by it), and the asker hears that a short one reads better
  const long = 'A named colleague may request changes to requirements and the proof of concept'
  const kept = checkDecide({ questions: [{ question: 'Who?', options: ['Only me', long], recommended: long, why: 'w' }] })
  expect(kept.ok && kept.questions[0]!.options[1]!.label).toBe(long)
  expect(kept.ok && kept.questions[0]!.recommended).toBe(long)
  expect(kept.ok && kept.notes).toEqual([`question 1, option b: its label is ${long.length} characters, kept whole, but a label of a few words with the detail in its description reads better`])
  expect(shown('abcdef', 4)).toBe('abc…')
  expect(shown('abc', 4)).toBe('abc')
  const bad = (input: unknown) => {
    const r = checkDecide(input)
    return r.ok ? '' : r.reason
  }
  expect(bad({})).toContain('1 to 4 questions')
  expect(bad({ questions: [1, 2, 3, 4, 5] })).toContain('1 to 4 questions')
  expect(bad({ questions: [{ question: 'Q', options: ['A'], recommended: 'A', why: 'w' }] })).toContain('2 to 4 options')
  expect(bad({ questions: [{ question: 'Q', options: ['A', 'a'], recommended: 'A', why: 'w' }] })).toContain('both')
  expect(bad({ questions: [{ question: 'Q', options: ['A', 'B'], recommended: 'c', why: 'w' }] })).toContain('recommended must be one of')
  expect(bad({ questions: [{ question: 'Q', options: ['A', 'B'], recommended: 'A' }] })).toContain('why you recommend')
  expect(bad({ questions: [{ options: ['A', 'B'], recommended: 'A', why: 'w' }] })).toContain('question text is missing')
  // G21: a field is kept whole up to its cap, and past it refused with its length and how to split it
  const q = (extra: Record<string, unknown>) => ({ questions: [{ question: 'Q', options: ['A', 'B'], recommended: 'A', why: 'w', ...extra }] })
  const big = checkDecide(q({ question: 'q'.repeat(1000) }))
  expect(big.ok && big.questions[0]!.question.length).toBe(1000)
  expect(bad(q({ question: 'q'.repeat(1001) }))).toBe("question 1: question is 1001 characters, and fleet keeps at most 1000 whole: put the detail in the options' descriptions or in why, or ask it as two questions")
  expect(bad(q({ why: 'w'.repeat(501) }))).toContain('question 1: why is 501 characters, and fleet keeps at most 500 whole')
  expect(bad(q({ options: ['A', { label: 'B', description: 'd'.repeat(401) }] }))).toContain('question 1, option b: its description is 401 characters')
  expect(bad({ ...q({}), blocks: 'b'.repeat(501) })).toContain('blocks is 501 characters, and fleet keeps at most 500 whole')
  expect(bad(q({ options: ['A', 'l'.repeat(201)] }))).toContain('question 1, option b: its label is 201 characters, and fleet keeps at most 200 whole')
})

test('held questions and progress: per question, a drop clears the whole decision', () => {
  const names = new Set(['D-1.1.json', 'D-2.drop.json', 'D-1.2.note.json'])
  expect(progress('D-1', 2, names)).toEqual({ answered: [true, false], dropped: false, complete: false })
  expect(progress('D-2', 3, names).complete).toBe(true)
  expect(heldCount([record('D-1', 2), record('D-2', 3), record('D-3', 1)], names)).toBe(2)
  expect(parseAnswerName('D-1.2.note.json')).toEqual({ id: 'D-1', q: 2, kind: 'note' })
  expect(parseAnswerName('D-2.drop.json')).toEqual({ id: 'D-2', kind: 'drop' })
  expect(parseAnswerName('notes.txt')).toBe(null)
})

test('what the asking model reads stands on its own, one block per decision, each led by its id', () => {
  const text = deliveryText([
    { record: record('D-1', 2), outcomes: [{ label: 'No', note: 'for now' }, { text: 'ask me later' }], drop: null },
    { record: record('D-2', 1), outcomes: [null], drop: { format: 1, id: 'D-2', why: 'not needed', origin: 'composer', session: 'TEST B', at: 0 } },
  ])
  expect(text).toBe(
    '[D-1] The person answered:\n1) Q1? → b) No (note: for now)\n2) Q2? → they wrote: "ask me later"\n\n' +
      "[D-2] The person dropped this decision without answering it (not needed): 1) Q1?\nDon't wait for it: go on as you think best, and say what you chose in your report.\n\n" +
      'Go on with what depended on it.',
  )
  expect(bracketedIds(`The fleet plugin sent a message:\n${text}`)).toEqual(['D-1', 'D-2'])
})

test('AskUserQuestion: a pick or typed text is an answer; chat and Esc are not', () => {
  const qs = [
    { question: 'Color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
    { question: 'Fruit?', options: [{ label: 'Apple' }, { label: 'Pear' }] },
  ]
  expect(classifyDialog(qs, { result: { answers: { 'Color?': 'Red', 'Fruit?': 'mango please' } } })).toEqual({ answers: [{ label: 'Red' }, { text: 'mango please' }], state: 'answered' })
  const chat = "Error: The user doesn't want to proceed with this tool use. … The user wants to clarify these questions."
  expect(classifyDialog(qs, { result: chat, isError: true })).toMatchObject({ state: 'not answered', why: 'chat' })
  expect(classifyDialog(qs, { result: "Error: The user doesn't want to proceed with this tool use. STOP", isError: true })).toMatchObject({ state: 'not answered', why: 'dismissed' })
  expect(classifyDialog(qs, { deny: 'no' })).toMatchObject({ state: 'not answered' })
})

test('AskUserQuestion with multiSelect: the picks as labels, each matched against the options, joined or as a list', () => {
  const qs = [
    { question: 'Which checks?', options: [{ label: 'Lint' }, { label: 'Tests, fast' }, { label: 'Tests, slow' }], multiSelect: true },
    { question: 'Which days?', options: [{ label: 'Mon' }, { label: 'Tue' }], multiSelect: true },
    { question: 'Which pets?', options: [{ label: 'Cat' }, { label: 'Dog' }], multiSelect: true },
  ]
  // A label that holds ", " itself is still one pick; a piece that matches no option is what he typed
  expect(classifyDialog(qs, { result: { answers: { 'Which checks?': 'Lint, Tests, slow', 'Which days?': ['Tue', 'Mon'], 'Which pets?': 'Cat, a parrot' } } })).toEqual({
    answers: [{ labels: ['Lint', 'Tests, slow'] }, { labels: ['Tue', 'Mon'] }, { labels: ['Cat'], text: 'a parrot' }],
    state: 'answered',
  })
  expect(classifyDialog(qs.slice(2), { result: { answers: { 'Which pets?': 'a parrot' } } })).toEqual({ answers: [{ text: 'a parrot' }], state: 'answered' })
  expect(classifyDialog(qs.slice(2), { result: { answers: { 'Which pets?': [] } } })).toMatchObject({ answers: [null], state: 'not answered' })
})

test('formats: wire files of another format are recognised, config.json from a newer fleet is left alone', () => {
  expect(parseWire('{"format":1,"id":"D-1"}')).toEqual({ value: { format: 1, id: 'D-1' } })
  expect(parseWire('{"format":2}')).toEqual({ otherFormat: 2 })
  expect(parseWire('not json')).toBe(null)
  expect(parseConfig('{"configFormat":1,"template":"blank","commitRegister":true,"later":1}')).toEqual({ config: { configFormat: 1, template: 'blank', commitRegister: true, later: 1 } })
  expect('problem' in parseConfig('{"configFormat":2}')).toBe(true)
  expect('problem' in parseConfig('{')).toBe(true)
  expect(gitignoreText(false)).toContain('\ndecisions/\n')
  expect(gitignoreText(false)).toContain('\ninbox/\nintake/\n')
  expect(gitignoreText(true)).toContain('decisions/*\n!decisions/register/\n')
  // The bells (live updates, rewritten all the time) and the run register stay out of git too, either way
  for (const commit of [false, true]) expect(gitignoreText(commit)).toContain('\nbell/\nruns/\n')
})

test('register months', () => {
  expect(monthOf(Date.UTC(2026, 10, 2))).toBe('2026-11')
  expect(monthBefore('2026-11')).toBe('2026-10')
  expect(monthBefore('2027-01')).toBe('2026-12')
})

test('answers by the decision id: D-3 b, D-3 apply, a note on D-3', () => {
  expect(parseAnswers('D-3 b')).toEqual([{ n: 'D-3', letter: 'b' }])
  expect(parseAnswers('d-3b 1a')).toEqual([{ n: 'D-3', letter: 'b' }, { n: 1, letter: 'a' }])
  expect(parseAnswers('D-2 reject D-3 apply')).toEqual([{ n: 'D-2', verb: 'reject' }, { n: 'D-3', verb: 'apply' }])
  expect(parseAnswers('D-4 "my words"')).toEqual([{ n: 'D-4', text: 'my words' }])
  expect(parseCommand('note D-4 keep it short')).toEqual({ kind: 'note', n: 'D-4', text: 'keep it short' })
  expect(parseCommand('note 2 keep it short')).toEqual({ kind: 'note', n: 2, text: 'keep it short' })
})

test('an answer that points at another list item, and one that only says a number in passing', () => {
  for (const t of ['the same as question 2', 'same as 2', 'igual que la 2', 'like #2', 'lo mismo que la 2', 'la 2', 'question 2', '#2', 'Same as question 2.']) expect(pointsAtItem(t)).toBe(2)
  // The number ends a reference: said in passing, it isn't one
  for (const t of ['Docs, 2 pages', 'Leave it to Owner A', 'after 2 days', 'version 2.0 of the plan', 'launch it in Q1', 'I would like 2 columns', 'answer 2 emails a day', 'priority #1']) expect(pointsAtItem(t)).toBe(null)
})

test('alike for the list: the same words (case and punctuation aside) and the same options; words merely alike are apart', () => {
  const yn = [{ label: 'Yes' }, { label: 'No' }]
  expect(alikeQuestion({ question: 'Should I delete notes/old.md?', options: yn }, { question: 'Should I keep notes/old.md?', options: yn })).toBe(false)
  expect(alikeQuestion({ question: 'Archive notes/2025/?', options: yn }, { question: 'Archive notes/2024/?', options: yn })).toBe(false)
  expect(alikeQuestion({ question: 'How should notes/ be split?', options: yn }, { question: 'how should notes/ be split', options: yn })).toBe(true)
  expect(alikeQuestion({ question: 'How should notes/ be split?', options: yn }, { question: 'How should notes/ be split?', options: [{ label: 'No' }, { label: 'Yes' }] })).toBe(false)
})

test('the list: one item per open question, the same question from several askers joined, a change alone', () => {
  const q = (question: string, labels: string[]) => ({ question, options: labels.map(label => ({ label })), recommended: labels[0] as string, why: 'w' })
  const a = { ...record('D-1', 0), questions: [q('Which part of the site is yours?', ['Docs', 'Tests'])] }
  const other = { ref: 'bbbbbbbb', sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', name: 'TEST B', root: '/Users/x/proj' }
  const b = { ...record('D-2', 0), asker: other, questions: [q('Which part of the site is yours?', ['Docs', 'Tests']), q('Which release day?', ['Monday', 'Friday'])] }
  const c = { ...record('D-3', 0), questions: [q('Which part of the site is yours?', ['Tests', 'Docs'])] }
  const change = { ...record('D-4', 0), kind: 'change' as const }
  const items = listedItems([a, b, c, change], new Set(['D-2.2.json']), alikeQuestion)
  expect(items.map(listedKey)).toEqual(['D-1.1+D-2.1', 'D-3.1', 'D-4.1'])
  // The same asker asking the same again: listed apart, each answered
  const again = { ...record('D-5', 0), questions: [q('Which part of the site is yours?', ['Docs', 'Tests'])] }
  expect(listedItems([a, again], new Set(), alikeQuestion).map(listedKey)).toEqual(['D-1.1', 'D-5.1'])
  expect(listedMembers('D-1.1+D-2.1')).toEqual([{ id: 'D-1', q: 1 }, { id: 'D-2', q: 1 }])
  expect(listedMembers('nonsense')).toEqual([])
})
