import { expect, test } from 'claude-code/testing'

import { DEC, FLEET, JOB, REF, ROOT, SID, decide, fleet, json, row, sessionsSay, startSession, under, world, type World, WITH_SESSIONS } from './world'

// Answering from the person's side (0.8.1): a decision by its id, the list's header, an answer that points at another
// item, the same question from several askers, Remote Control, changes that can't apply any more, and an answer typed in
// the asker's own session

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

const AT = Date.UTC(2026, 10, 2, 11, 0, 0)
const SPLIT = {
  question: 'Which part of the site is yours?',
  options: [{ label: 'Docs' }, { label: 'Tests' }, { label: 'Build' }],
  recommended: 'Docs',
  why: 'nobody has it yet',
}

/** A decision on the queue, as an asker's fleet writes it */
function queued(w: World, id: string, asker: { ref: string; name: string }, questions: unknown[], extra: Record<string, unknown> = {}) {
  w.files.set(`${DEC}/queue/${id}.json`, JSON.stringify({ format: 1, fleet: '0.8.1', id, at: AT, asker: { ref: asker.ref, sessionId: `${asker.ref}-0000-0000-0000-000000000000`, name: asker.name, root: ROOT }, questions, ...extra }))
}

const A = { ref: 'bbbbbbb1', name: 'Owner A' }
const B = { ref: 'bbbbbbb2', name: 'Owner B' }
const C = { ref: 'bbbbbbb3', name: 'Owner C' }

test('a decision by its id needs no list; with one thing waiting, 1 is it; with more, the list comes first', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false })
  sessionsSay(w, { rows: { [A.ref]: row(A.ref, A.name, 'idle'), [B.ref]: row(B.ref, B.name, 'idle') } })
  queued(w, 'D-3', A, [SPLIT])
  await startSession($, w)
  // One waiting, no list shown here yet: 1 means it
  const one = await fleet($, '1b')
  expect(one).toContain('1: Which part of the site is yours? → b) Tests')
  expect(json(w, `${DEC}/answers/D-3.1.json`)).toMatchObject({ label: 'Tests', origin: 'composer' })
  // By its id, whatever the list: its only open question
  queued(w, 'D-4', B, [{ ...SPLIT, question: 'Which test runner?', options: [{ label: 'Fast' }, { label: 'Thorough' }], recommended: 'Fast' }])
  const byId = await fleet($, 'D-4 b')
  expect(byId).toContain('D-4: Which test runner? → b) Thorough')
  expect(byId).toContain("D-4 goes to Owner B when it's idle")
  expect(json(w, `${DEC}/answers/D-4.1.json`)).toMatchObject({ label: 'Thorough' })
  // One that's answered, or not there
  expect(await fleet($, 'D-3 a')).toBe('D-3: D-3 is answered already')
  expect(await fleet($, 'D-99 a')).toContain('D-99: D-99 is closed already')
})

test('with no list shown and several waiting, a number answers nothing and shows the list', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false })
  sessionsSay(w, { rows: { [A.ref]: row(A.ref, A.name, 'idle'), [B.ref]: row(B.ref, B.name, 'idle') } })
  queued(w, 'D-4', A, [{ ...SPLIT, question: 'Which test runner?', options: [{ label: 'Fast' }, { label: 'Thorough' }], recommended: 'Fast' }])
  queued(w, 'D-5', B, [{ ...SPLIT, question: 'Which release day?', options: [{ label: 'Monday' }, { label: 'Friday' }], recommended: 'Monday' }])
  await startSession($, w)
  const said = await fleet($, '1a')
  expect(said).toContain('Nothing was answered: these are the numbers to answer by.')
  expect(said).toContain('1. Which test runner?')
  expect(under(w, `${DEC}/answers`)).toEqual([])
  // Now the numbers are this list's
  expect(await fleet($, '1a')).toContain('1: Which test runner? → a) Fast')
})

test("the list's header names no option, and a decision with two open questions isn't answered by its id", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false })
  sessionsSay(w, { rows: { [A.ref]: row(A.ref, A.name, 'idle') } })
  queued(w, 'D-6', A, [SPLIT, { ...SPLIT, question: 'Which release day?', options: [{ label: 'Monday' }, { label: 'Friday' }], recommended: 'Monday' }])
  await startSession($, w)
  const list = await fleet($, '')
  expect(list).toContain('2 questions for you · answer with /fleet 1<letter>, or 1 "your words" · /fleet help')
  expect(await fleet($, 'D-6 a')).toBe('D-6: D-6 has 2 questions open: answer them by their numbers in /fleet')
})

test('an answer that points at another item of the list is warned once, with that item’s answer to send instead', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false })
  sessionsSay(w, { rows: { [A.ref]: row(A.ref, A.name, 'idle'), [B.ref]: row(B.ref, B.name, 'idle') } })
  queued(w, 'D-7', A, [{ ...SPLIT, question: 'Light or dark theme?', options: [{ label: 'Light' }, { label: 'Dark' }], recommended: 'Light' }])
  queued(w, 'D-8', B, [{ ...SPLIT, question: 'Which color for the buttons?', options: [{ label: 'Blue' }, { label: 'Green' }], recommended: 'Blue' }])
  await startSession($, w)
  await fleet($, '')
  await fleet($, '1a')
  const warned = await fleet($, '2 "the same as question 1"')
  expect(warned).toContain('2: your answer points at item 1 of this list ("the same as question 1"), and Owner B never sees this list: write the answer itself (item 1 was answered "Light": /fleet 2 "Light" sends that). Typed again as it is, it goes as it is.')
  expect(w.files.has(`${DEC}/answers/D-8.1.json`)).toBe(false)
  // Typed again as it is: it goes
  expect(await fleet($, '2 "the same as question 1"')).toContain('2: Which color for the buttons? → "the same as question 1"')
  expect(json(w, `${DEC}/answers/D-8.1.json`)).toMatchObject({ text: 'the same as question 1' })
})

test('a pointer’s fix: the pointed item’s answer from the register once delivered, offered as a letter where this question has it; words that only say a number pass', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false })
  sessionsSay(w, { rows: { [A.ref]: row(A.ref, A.name, 'idle'), [C.ref]: row(C.ref, C.name, 'idle') } })
  queued(w, 'D-7', A, [{ ...SPLIT, question: 'Light or dark theme?', options: [{ label: 'Light' }, { label: 'Dark' }], recommended: 'Light' }])
  queued(w, 'D-9', C, [{ ...SPLIT, question: 'Theme for the docs?', options: [{ label: 'Dark' }, { label: 'Light' }], recommended: 'Dark' }])
  await startSession($, w)
  await fleet($, '')
  await fleet($, '1a')
  // D-7 reached its asker: its answer file is gone, the register has it
  w.files.delete(`${DEC}/answers/D-7.1.json`)
  w.files.delete(`${DEC}/queue/D-7.json`)
  w.files.set(`${DEC}/register/2026-11/D-7.json`, JSON.stringify({ registerFormat: 1, id: 'D-7', source: 'decide', at: AT, asker: { ref: A.ref, name: A.name }, questions: [{ question: 'Light or dark theme?', options: [{ label: 'Light' }, { label: 'Dark' }] }], answers: [{ label: 'Light', origin: 'composer', session: 'x', at: AT }], state: 'delivered', closedAt: AT }))
  expect(await fleet($, '2 "the same as question 1"')).toContain('(item 1 was answered "Light": /fleet 2b sends that)')
  expect(w.files.has(`${DEC}/answers/D-9.1.json`)).toBe(false)
  // A number said in passing isn't a pointer
  expect(await fleet($, '2 "launch it in Q1"')).toContain('2: Theme for the docs? → "launch it in Q1"')
})

test('the same question from several askers is one item: one answer goes to each', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false })
  sessionsSay(w, { rows: { [A.ref]: row(A.ref, A.name, 'idle'), [B.ref]: row(B.ref, B.name, 'idle'), [C.ref]: row(C.ref, C.name, 'idle') } })
  queued(w, 'D-10', A, [SPLIT])
  queued(w, 'D-11', B, [{ ...SPLIT, question: 'Which part of the site is Yours?' }])
  // The same words with other options, or alike words that mean something else: listed apart
  queued(w, 'D-12', C, [{ ...SPLIT, question: 'Which part of the site is yours?', options: [{ label: 'Docs' }, { label: 'Tests' }] }])
  queued(w, 'D-13', B, [{ ...SPLIT, question: 'Which part of the site is mine?' }])
  await startSession($, w)
  const list = await fleet($, '')
  expect(list).toContain('3 questions for you')
  expect(list).toContain('1. Which part of the site is yours?')
  expect(list).toContain('   Asked the same: Owner B · D-11. Your answer goes to each.')
  expect(list).toContain('2. Which part of the site is yours?')
  expect(list).toContain('3. Which part of the site is mine?')
  // The count is the list's: a question several asked counts once
  expect(await fleet($, 'status')).toContain('project: 3 question(s) for you')
  const said = await fleet($, '1c')
  expect(said).toContain('1: Which part of the site is yours? → c) Build (the same answer to D-11)')
  expect(said).toContain("D-10 goes to Owner A when it's idle")
  expect(said).toContain("D-11 goes to Owner B when it's idle")
  expect(json(w, `${DEC}/answers/D-10.1.json`)).toMatchObject({ label: 'Build' })
  expect(json(w, `${DEC}/answers/D-11.1.json`)).toMatchObject({ label: 'Build' })
  expect(w.files.has(`${DEC}/answers/D-12.1.json`)).toBe(false)
  // A note on a shared item goes to each
  await fleet($, '')
  expect(await fleet($, 'note 1 "keep it short"')).toContain('Note on 1 saved')
})

test('a question several asked: one asker closed it meanwhile, the others are answered; by the id of one, all of them', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false })
  sessionsSay(w, { rows: { [A.ref]: row(A.ref, A.name, 'idle'), [B.ref]: row(B.ref, B.name, 'idle'), [C.ref]: row(C.ref, C.name, 'idle') } })
  queued(w, 'D-10', A, [SPLIT])
  queued(w, 'D-11', B, [SPLIT])
  await startSession($, w)
  expect(await fleet($, '')).toContain('Asked the same: Owner B · D-11')
  // D-10 closes in its own session (kind answered there): the answer goes to D-11, and D-10 is said
  w.files.delete(`${DEC}/queue/D-10.json`)
  const said = await fleet($, '1b')
  expect(said).toContain('1: D-10: D-10 is closed already')
  expect(said).toContain('1: Which part of the site is yours? → b) Tests')
  expect(json(w, `${DEC}/answers/D-11.1.json`)).toMatchObject({ label: 'Tests' })
  // By the id of one, with no list: every asker of that question
  queued(w, 'D-12', A, [SPLIT])
  queued(w, 'D-13', C, [SPLIT])
  const byId = await fleet($, 'D-13 a')
  expect(byId).toContain('(the same answer to D-12)')
  expect(json(w, `${DEC}/answers/D-12.1.json`)).toMatchObject({ label: 'Docs' })
  expect(json(w, `${DEC}/answers/D-13.1.json`)).toMatchObject({ label: 'Docs' })
  // A note by id once it's answered goes with the answer, as by its number
  expect(await fleet($, 'note D-13 keep it short')).toContain('Note on D-13 saved')
})

test('Remote Control: answers are taken (pick, change, resource); what changes the project, and an outbound, stay at a terminal', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, files: { [`${FLEET}/charter.md`]: '# Charter\n' } })
  sessionsSay(w, { rows: { [A.ref]: row(A.ref, A.name, 'idle') } })
  queued(w, 'D-20', A, [SPLIT])
  await startSession($, w)
  const RC = { kind: 'bridge' }
  await fleet($, '', RC)
  const said = await fleet($, '1a', RC)
  expect(said).toContain('1: Which part of the site is yours? → a) Docs')
  expect(json(w, `${DEC}/answers/D-20.1.json`)).toMatchObject({ label: 'Docs', origin: 'bridge' })
  expect(await fleet($, 'up', RC)).toContain('Only the person starts instances, typing it at a terminal (this came over Remote Control, which takes your answers only)')
  expect(await fleet($, 'accept charter.md', RC)).toContain('this came over Remote Control, which takes your answers only')
  // Anything else that isn't the person still answers nothing
  expect(await fleet($, '1a', { kind: 'plugin', name: 'other' })).toContain('Only the person answers, typing /fleet at a terminal or over Remote Control (this came from plugin)')
})

test('a change applied leaves the others to its file stale: the list says so and rejects them all in one go', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${FLEET}/charter.md`]: '# Charter\n' } })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  await startSession($, w)
  for (const goal of ['A', 'B', 'C']) expect((await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: `goal ${goal}`, content: `# Charter\n\nGoal ${goal}.\n` })).result).toContain('Queued as D-')
  const list = await fleet($, '')
  expect(list).toContain('3 changes for you')
  const applied = await fleet($, '1 apply')
  expect(applied).toContain('1: applied D-1: fleet wrote .claude/fleet/charter.md as drafted')
  expect(applied).toContain('D-2, D-3 change .claude/fleet/charter.md too, drafted on the version it just left, so they can\'t apply: /fleet D-2 reject D-3 reject')
  const again = await fleet($, '')
  expect(again).toContain('⚠ stale: .claude/fleet/charter.md changed since this was drafted')
  expect(again).toContain("2 changes can't apply any more (their files moved since they were drafted): /fleet 1 reject 2 reject rejects them all")
  const rejected = await fleet($, 'D-2 reject D-3 reject')
  expect(rejected).toContain('D-2: rejected D-2')
  expect(rejected).toContain('D-3: rejected D-3')
})

test('the person answers in the asker’s own session: the turn hears which question waits, and decide kind answered takes it off the queue with their words', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, intent: '', firstTerminalAt: null }))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Owner B', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'Owner B', 'working') } })
  await startSession($, w)
  const asked = await decide($, { questions: [{ question: 'Should notes/summary.md stay Owner A’s?', options: [{ label: 'Leave it to Owner A' }, { label: 'Replace it' }], recommended: 'Leave it to Owner A', why: 'each owner keeps its own file' }] })
  expect(asked.result).toContain('Queued as D-1')
  await $.turn.complete({ text: '' } as any)
  // A turn of fleet's own isn't the person: no kind answered there
  await $.turn.start({ text: 'The fleet plugin sent a message:\nsomething', turnId: 't-0' })
  expect((await decide($, { kind: 'answered', id: 'D-1' })).deny).toContain('only in a turn the person started by typing in this session')
  await $.turn.complete({ text: '' } as any)
  await w.clock.advance(1000)
  // The person types the answer here
  await $.prompt.submit({ text: 'keep it as it is, Owner A has it', origin: { kind: 'composer' }, wait: false } as any)
  const p = w.prompts.find(x => x.text === 'keep it as it is, Owner A has it')
  expect(p?.context.join('\n')).toContain("fleet: your question D-1 (\"Should notes/summary.md stay Owner A’s?\") still waits in the person's queue. If what they just typed answers it, call mcp__fleet__decide with kind \"answered\" and its id")
  await $.turn.start({ text: 'keep it as it is, Owner A has it', turnId: 't-1' })
  const r = await decide($, { kind: 'answered', id: 'D-1' })
  expect(r.result).toContain("D-1 is off the person's queue: what they typed this turn is the answer to question 1, in the register.")
  expect(r.result).toContain('[D-1] The person answered:\n1) Should notes/summary.md stay Owner A’s? → they wrote: "keep it as it is, Owner A has it"')
  expect(json(w, `${DEC}/register/2026-11/D-1.json`)).toMatchObject({ state: 'delivered', delivered: { how: 'result' }, answers: [{ text: 'keep it as it is, Owner A has it', origin: 'composer', pre: true }] })
  expect(w.files.has(`${DEC}/queue/D-1.json`)).toBe(false)
  await $.turn.complete({ text: '' } as any)
  await tick(w)
  expect(w.submits).toEqual([])
  expect(await fleet($, '')).toContain('Nothing is waiting for you')
  // Another session's question, or a change, isn't closed this way
  queued(w, 'D-2', A, [SPLIT])
  await $.prompt.submit({ text: 'and the other one', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ text: 'and the other one', turnId: 't-2' })
  expect((await decide($, { kind: 'answered', id: 'D-2' })).deny).toContain('was asked by another session (Owner A)')
})

test('kind answered: one question at a time (q), the rest stay queued; once complete the result brings every answer; never a question asked after the prompt; a prompt typed into the turn adds to the words; from the phone too', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, intent: '', firstTerminalAt: null }))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Owner B', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'Owner B', 'working') } })
  await startSession($, w)
  const two = [
    { question: 'Which database for the cache?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], recommended: 'SQLite', why: 'one file' },
    { question: 'Should cache entries expire?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'stale data' },
  ]
  expect((await decide($, { questions: two })).result).toContain('Queued as D-1')
  await $.turn.complete({ text: '' } as any)
  await w.clock.advance(1000)
  // Over Remote Control: his words count; the turn hears both questions, numbered
  await $.prompt.submit({ text: 'never expire them', origin: { kind: 'bridge' }, wait: false } as any)
  const p = w.prompts.find(x => x.text === 'never expire them')
  expect(p?.context.join('\n')).toContain('D-1 (q 1: "Which database for the cache?", q 2: "Should cache entries expire?")')
  expect(p?.context.join('\n')).toContain('and q (the number of the question their words answer; once per question)')
  await $.turn.start({ text: 'never expire them', turnId: 't-1' })
  expect((await decide($, { kind: 'answered', id: 'D-1' })).deny).toContain('D-1 has questions 1 and 2 open: call again with q')
  const part = await decide($, { kind: 'answered', id: 'D-1', q: 2 })
  expect(part.result).toContain('D-1 question 2: what they typed this turn is its answer')
  expect(part.result).toContain('Question 1 still waits in their queue')
  expect(json(w, `${DEC}/answers/D-1.2.json`)).toMatchObject({ text: 'never expire them', origin: 'bridge', pre: true })
  expect(w.files.has(`${DEC}/answers/D-1.1.json`)).toBe(false)
  // A question the model asks in this turn can't take the words he typed before it
  expect((await decide($, { questions: [{ question: 'Which log level?', options: [{ label: 'Info' }, { label: 'Debug' }], recommended: 'Info', why: 'quiet' }] })).result).toContain('Queued as D-2')
  expect((await decide($, { kind: 'answered', id: 'D-2' })).deny).toContain('D-2 was asked after the person last typed here')
  await $.turn.complete({ text: '' } as any)
  // He answers question 1 with /fleet; then, typing into a running turn of his, a word for D-2: its words are both prompts
  await fleet($, '')
  await fleet($, '1a')
  await w.clock.advance(1000)
  await $.prompt.submit({ text: 'look at the logs first', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ text: 'look at the logs first', turnId: 't-2' })
  await w.clock.advance(1000)
  await $.prompt.submit({ text: 'and for the log level: Debug', origin: { kind: 'composer' }, turnId: 't-2', wait: false } as any)
  const d2 = await decide($, { kind: 'answered', id: 'D-2' })
  expect(d2.result).toContain('[D-2] The person answered:')
  expect(json(w, `${DEC}/register/2026-11/D-2.json`)).toMatchObject({ answers: [{ text: 'look at the logs first\nand for the log level: Debug', origin: 'composer' }] })
})
