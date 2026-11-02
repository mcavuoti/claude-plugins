import { expect, test } from 'claude-code/testing'

import {
  bracketedIds,
  checkDecide,
  classifyDialog,
  deliveryText,
  gitignoreText,
  heldCount,
  monthBefore,
  monthOf,
  parseAnswerName,
  parseAnswers,
  parseCommand,
  parseConfig,
  parseWire,
  progress,
  type QueueRecord,
} from '../hooks/decisions'

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
  expect(typeof parseAnswers('1 applied')).toBe('string')
  expect(typeof parseAnswers('1 apply 1a')).toBe('string')
})

test('a resource is answered done or no, an outbound send (with its version after an edit), reject, edit or done; a note may follow', () => {
  expect(parseAnswers('1 done "the key is in the vault" 2 no')).toEqual([{ n: 1, verb: 'done', note: 'the key is in the vault' }, { n: 2, verb: 'no' }])
  expect(parseAnswers('3 send h1a2b3c4d, 4 reject “not yet”')).toEqual([{ n: 3, verb: 'send', hash: 'h1a2b3c4d' }, { n: 4, verb: 'reject', note: 'not yet' }])
  expect(parseAnswers('5 "free text" 6a')).toEqual([{ n: 5, text: 'free text' }, { n: 6, letter: 'a' }])
  expect(typeof parseAnswers('1 nope')).toBe('string')
  expect(parseCommand('brief')).toEqual({ kind: 'brief', chief: false })
  expect(parseCommand('brief --chief')).toEqual({ kind: 'brief', chief: true })
  expect(parseCommand('brief all').kind).toBe('bad')
})

test("/fleet up, down, remove, budget, worktrees: their words and what's refused", () => {
  expect(parseCommand('up')).toEqual({ kind: 'up', dryRun: false, wave: null, names: [] })
  expect(parseCommand('up --dry-run --wave 2')).toEqual({ kind: 'up', dryRun: true, wave: 2, names: [] })
  expect(parseCommand('up "Area A" chief --wave=1')).toEqual({ kind: 'up', dryRun: false, wave: 1, names: ['Area A', 'chief'] })
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
  expect(ok).toEqual({ ok: true, questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B', description: 'bee' }], recommended: 'B', why: 'cheaper' }] })
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
})

test('register months', () => {
  expect(monthOf(Date.UTC(2026, 10, 2))).toBe('2026-11')
  expect(monthBefore('2026-11')).toBe('2026-10')
  expect(monthBefore('2027-01')).toBe('2026-12')
})
