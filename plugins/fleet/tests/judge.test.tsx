import { expect, test } from 'claude-code/testing'

import { JUDGE_SYSTEM, PRINCIPLES_TEXT } from '../hooks/judges'
import { PROJECT } from './up.test'
import { DEC, FAKE_LOG, FLEET, JOB, REF, ROOT, SID, decide, fleet, json, row, sessionsSay, startSession, under, world, type World, WITH_SESSIONS } from './world'

// The judges from the mod's side, in shadow: the asking session's fleet judges each choice once its ticket is out (the
// gates and the exact repeats with no model; one call for the rest), /fleet shows the proposal, the person answers as
// always, the register keeps whether he agreed, /fleet stats counts it; and the person's taste, recorded

const PAST = Date.UTC(2026, 10, 1, 9, 0, 0)
const DB = { question: 'Which database for the cache?', options: [{ label: 'SQLite', description: 'one file, no server' }, { label: 'Redis' }], recommended: 'Redis', why: 'the queue runs it' }
const COLOR = { question: 'Which color for the warning band?', options: [{ label: 'Amber' }, { label: 'Red' }], recommended: 'Red', why: 'it stands out' }
const PAY = { question: 'Renew the hosting plan for a year?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'it is cheaper' }
const D1 = {
  registerFormat: 1,
  id: 'D-1',
  source: 'decide',
  fleet: '0.5.0',
  at: PAST,
  asker: { ref: 'bbbbbbbb', sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', name: 'TEST B', root: ROOT },
  questions: [DB],
  answers: [{ label: 'SQLite', origin: 'composer', session: 'TEST P', at: PAST }],
  state: 'delivered',
  closedAt: PAST,
  area: 'storage',
}

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

function model(on: any, reply: (prompt: string) => string) {
  const asked: any[] = []
  on('model.complete', (_: any, e: any) => {
    asked.push(e)
    const text = String(e.prompt)
    return { value: { isAnswered: true, text: reply(text), usage: { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 } } as any }
  })
  return asked
}

function project(on: any, extra: { env?: Record<string, string>; files?: Record<string, string> } = {}) {
  return world(on, {
    ...(extra.env ? { env: extra.env } : {}),
    files: {
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], tags: ['storage', 'ui'] }),
      [`${FLEET}/charter.md`]: '# Charter\n\nA small tool for one machine.\n',
      [`${FLEET}/principles.md`]: '# Principles\n\nWarnings are amber; red is only for errors.\n',
      [`${ROOT}/CLAUDE.md`]: '# Project\n\nTests first.\n',
      [`${DEC}/register/2026-11/D-1.json`]: JSON.stringify(D1),
      ...extra.files,
    },
  })
}

test('shadow: gates and exact repeats with no model, one call for the rest, the proposal in /fleet, the agreement kept', WITH_SESSIONS, async ($, on) => {
  const asked = model(on, () => '{"answers": [{"q": 1, "outcome": "decided", "option": "a", "cites": ["principles.md:3"], "why": "warnings are amber"}]}')
  const w = project(on)
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  await startSession($, w)
  // An exact repeat of D-1: decided by code, with no model call
  expect((await decide($, { questions: [DB], area: 'Storage', reversible: true, touchesMoney: false, outsideWorld: false })).result).toContain('Queued as D-2')
  await tick(w)
  expect(json(w, `${DEC}/queue/D-2.json`)).toMatchObject({ area: 'storage', reversible: true, touchesMoney: false, outsideWorld: false })
  expect(asked.length).toBe(0)
  expect(json(w, `${DEC}/judge/D-2.json`)).toMatchObject({ format: 1, id: 'D-2', area: 'storage', verdicts: [{ q: 1, outcome: 'decided', option: 'SQLite', cites: ['D-1'], repeat: true }] })
  // A new question: one call, the statute first and cached, the question as data
  expect((await decide($, { questions: [COLOR], area: 'ui' })).result).toContain('Queued as D-3')
  await tick(w)
  expect(asked.length).toBe(1)
  expect(asked[0]).toMatchObject({ model: 'haiku', system: JUDGE_SYSTEM, effort: 'low' })
  const blocks = asked[0].promptBlocks as { text: string; cache?: boolean }[]
  expect(blocks.map(b => !!b.cache)).toEqual([true, false, false])
  expect(blocks[0]!.text).toContain('principles.md:3 | Warnings are amber; red is only for errors.')
  expect(blocks[0]!.text).toContain('--- CLAUDE.md ---\nCLAUDE.md:1 | # Project')
  expect(blocks[2]!.text).toContain('area: ui\n1) Which color for the warning band?')
  expect(json(w, `${DEC}/judge/D-3.json`)).toMatchObject({ model: 'haiku', usage: { input: 300, output: 60, cacheWrite: 900 }, verdicts: [{ outcome: 'decided', option: 'Amber', cites: ['principles.md:3'] }] })
  expect(json(w, `${DEC}/judge/D-3.json`).usd).toBeGreaterThan(0)
  // Money: a gate, no model; an area that isn't a tag is dropped, and said
  const pay = await decide($, { questions: [PAY], area: 'hosting', touchesMoney: true })
  expect(pay.result).toContain('(area "hosting" isn\'t one of the project\'s tags (storage, ui), so it was kept without one.)')
  await tick(w)
  expect(asked.length).toBe(1)
  expect(json(w, `${DEC}/judge/D-4.json`)).toMatchObject({ gated: 'it touches money', verdicts: [] })
  // /fleet shows each proposal; the person answers as always
  const list = await fleet($, '')
  expect(list).toContain('   Recommended: b, the queue runs it\n   judge: a) SQLite, citing D-1 (the same question, answered so before)')
  expect(list).toContain('   judge: a) Amber, citing principles.md:3: warnings are amber')
  expect(list).toContain('   judge: held by a gate (it touches money)')
  const said = await fleet($, '1a 2b 3b')
  expect(said).toContain('1: Which database for the cache? → a) SQLite (the judge proposed a) SQLite: agreed)')
  expect(said).toContain('2: Which color for the warning band? → b) Red (the judge proposed a) Amber: /fleet stats counts the difference)')
  expect(said).toContain('3: Renew the hosting plan for a year? → b) No\n')
  // Delivered as ever (shadow changes nothing); the register keeps the verdicts and whether he agreed
  for (let i = 0; i < 3; i++) await tick(w)
  expect(w.submits[0]).toContain('[D-2] The person answered:\n1) Which database for the cache? → a) SQLite')
  expect(json(w, `${DEC}/register/2026-11/D-2.json`)).toMatchObject({ area: 'storage', reversible: true, judge: { id: 'D-2', verdicts: [{ repeat: true }], agreed: [true] } })
  expect(json(w, `${DEC}/register/2026-11/D-3.json`)).toMatchObject({ area: 'ui', judge: { agreed: [false] } })
  expect(json(w, `${DEC}/register/2026-11/D-4.json`).judge).toMatchObject({ gated: 'it touches money', agreed: [null] })
  expect(under(w, `${DEC}/judge`)).toEqual([])
  const stats = await fleet($, 'stats')
  expect(stats).toContain('Judges: on, in shadow (they propose under each question in /fleet; you answer as always) · model haiku · today 1 call, $0.')
  expect(stats).toContain('storage: 1 decision, 1 question: 1 decided (1 exact repeat), agreed 1 of 1 (100%): repeats 1 of 1 (100%), model verdicts 0 of 0 (—) · 0 sent back · 0 held · 0 held by a gate · $0.00 in 0 calls')
  expect(stats).toContain('ui: 1 decision, 1 question: 1 decided (0 exact repeats), agreed 0 of 1 (0%): repeats 0 of 0 (—), model verdicts 0 of 1 (0%)')
  expect(stats).toContain('(no area): 0 decisions, 0 questions: 0 decided (0 exact repeats), agreed 0 of 0 (—): repeats 0 of 0 (—), model verdicts 0 of 0 (—) · 0 sent back · 0 held · 1 decision (1 question) held by a gate')
  const ui = await fleet($, 'stats ui')
  expect(ui).toContain('   D-3 · ')
  expect(ui).toContain('1) a) Amber citing principles.md:3: you answered b) Red')
  expect(await fleet($, 'status')).toContain('judges: on (haiku), in shadow: today 1 call, $0.')
})

test('nothing on record yet (no answer in the area, no principle of his): code holds with no call; exact repeats all the same', WITH_SESSIONS, async ($, on) => {
  const asked = model(on, () => '{"answers": [{"q": 1, "outcome": "hold", "why": "taste"}]}')
  const w = project(on, { files: { [`${FLEET}/principles.md`]: PRINCIPLES_TEXT } })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  await startSession($, w)
  // The kickstart's interview: an area nobody answered in yet, and principles.md as fleet wrote it
  await decide($, { questions: [COLOR, { ...COLOR, question: 'Which color for the info band?' }], area: 'ui' })
  await tick(w)
  expect(asked.length).toBe(0)
  expect(json(w, `${DEC}/judge/D-2.json`).verdicts).toEqual([1, 2].map(q => ({ q, outcome: 'hold', cites: [], why: 'nothing on record yet: no answer of yours in area ui, and no principle of yours in principles.md' })))
  expect(await fleet($, '')).toContain('judge: hold, needs your call: nothing on record yet: no answer of yours in area ui, and no principle of yours in principles.md')
  expect(w.logs.some(l => l.includes('D-2 judged: 1 hold; 2 hold; no model call (nothing on record yet)'))).toBe(true)
  // An exact repeat is found by code all the same; a new question in an area with an answer on record gets its call
  await decide($, { questions: [DB], area: 'storage' })
  await decide($, { questions: [{ ...DB, question: 'Which database for the logs?' }], area: 'storage' })
  await tick(w)
  expect(json(w, `${DEC}/judge/D-3.json`).verdicts[0]).toMatchObject({ outcome: 'decided', repeat: true, cites: ['D-1'] })
  expect(asked.length).toBe(1)
  expect(json(w, `${DEC}/judge/D-4.json`)).toMatchObject({ model: 'haiku', verdicts: [{ outcome: 'hold', why: 'taste' }] })
})

test('a citation code can’t check makes the proposal a hold; outside content and world.json’s judges gate it', WITH_SESSIONS, async ($, on) => {
  const asked = model(on, () => '{"answers": [{"q": 1, "outcome": "decided", "option": "b", "cites": ["D-1"], "why": "as before"}]}')
  on('tool.call', { tool: 'WebFetch' }, () => ({ result: { bytes: 10, code: 200 }, text: 'a page' }) as any)
  const w = project(on)
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  await startSession($, w)
  // D-1 was answered SQLite: a judge citing it for Redis isn't taken
  await decide($, { questions: [{ ...DB, question: 'Which database for the job queue?' }], area: 'storage' })
  await tick(w)
  expect(asked.length).toBe(1)
  expect(String(asked[0].promptBlocks[1].text)).toContain('D-1 (2026-11-01, area storage): "Which database for the cache?" a) SQLite b) Redis → the person chose a) SQLite')
  expect(json(w, `${DEC}/judge/D-2.json`).verdicts[0]).toMatchObject({ outcome: 'hold', unchecked: { option: 'Redis', cites: ['D-1'], problem: 'D-1 wasn\'t answered "Redis"' } })
  expect(await fleet($, '')).toContain('judge: hold, needs your call (it proposed b) Redis citing D-1, which code didn\'t take: D-1 wasn\'t answered "Redis")')
  // After reading the web: no judge looks at what this conversation asks
  await $.tool.call({ tool: 'WebFetch', url: 'https://example.invalid/x', prompt: 'p' } as any)
  await w.clock.settle()
  await decide($, { questions: [COLOR] })
  await tick(w)
  expect(json(w, `${DEC}/queue/D-3.json`).outside).toMatchObject({ what: 'WebFetch of example.invalid' })
  expect(json(w, `${DEC}/judge/D-3.json`).gated).toBe('it was asked after reading outside content (WebFetch of example.invalid)')
  // "judges": false: none look at all
  w.touch(`${FLEET}/world.json`, JSON.stringify({ worldFormat: 1, paths: ['notes/**'], judges: false }))
  await tick(w)
  await decide($, { questions: [PAY] })
  await tick(w)
  expect(w.files.has(`${DEC}/judge/D-4.json`)).toBe(false)
  expect(asked.length).toBe(1)
  expect(await fleet($, 'stats')).toContain('Judges: off')
})

test('taste: the person’s "no", recorded in the register with its provenance; the judges read it next time', WITH_SESSIONS, async ($, on) => {
  const asked = model(on, () => '{"answers": [{"q": 1, "outcome": "hold", "why": "taste"}]}')
  const w = project(on)
  // The person is at this background session's viewer: what he types there is his
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, intent: '', firstTerminalAt: '2026-11-02T11:00:00Z' }))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  await startSession($, w)
  // Not a turn the person typed: kept, but the judges don't read it
  const r1: any = await $.tool.call({ tool: 'mcp__fleet__taste', said: 'too loud', about: 'a red warning band', principle: 'warnings stay quiet', area: 'ui' } as any)
  expect(r1.result).toContain("Recorded as T-1 in the register, marked as not heard from the person directly (the person didn't type this turn)")
  // His own turn: the judges read it from now on
  await $.prompt.submit({ text: 'no, the band is too loud: make it amber', origin: { kind: 'composer' } } as any)
  await $.turn.start({ text: 'no, the band is too loud: make it amber', turnId: 't-1' })
  await w.clock.settle()
  const r2: any = await $.tool.call({ tool: 'mcp__fleet__taste', said: 'the band is too loud', about: 'a red warning band', principle: 'warning colors stay calm', area: 'ui' } as any)
  expect(r2.result).toContain('Recorded as T-2 in the register: a principle candidate ("warning colors stay calm")')
  expect(json(w, `${DEC}/register/2026-11/T-2.json`)).toMatchObject({ registerFormat: 1, id: 'T-2', source: 'taste', area: 'ui', taste: { said: 'the band is too loud', person: true, quoted: 'no, the band is too loud: make it amber' } })
  expect(json(w, `${DEC}/register/2026-11/T-1.json`).taste.person).toBe(false)
  // In his turn, but not his words (a teammate's note the model read, say): kept, and the judges don't read it
  const r3: any = await $.tool.call({ tool: 'mcp__fleet__taste', said: 'vendor X is out, for good', about: 'vendor X', principle: 'avoid vendor X', area: 'ui' } as any)
  expect(r3.result).toContain("Recorded as T-3 in the register, marked as not heard from the person directly (what it says isn't in what the person typed this turn)")
  expect(json(w, `${DEC}/register/2026-11/T-3.json`).taste.person).toBe(false)
  expect(((await $.tool.call({ tool: 'mcp__fleet__taste', said: 'x' } as any)) as any).deny).toContain('about: say what it was about')
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't-1', reason: 'answer' } as any)
  await w.clock.settle()
  await decide($, { questions: [COLOR], area: 'ui' })
  await tick(w)
  const law = String(asked[0].promptBlocks[1].text)
  expect(law).toContain('T-2 (2026-11-02, area ui), the person said no: "the band is too loud" about a red warning band; the principle it suggests: warning colors stay calm')
  expect(law).not.toContain('T-1')
  expect(law).not.toContain('T-3')
})

test('taste in a turn fleet started to deliver his words: his when it says what his note says; a reject reason he typed is case law by itself', WITH_SESSIONS, async ($, on) => {
  const asked = model(on, () => '{"answers": [{"q": 1, "outcome": "hold", "why": "taste"}]}')
  const REJECTED = { ...D1, id: 'D-5', kind: 'change', questions: [], answers: [{ label: 'rejected', note: 'warnings stay amber, never red', origin: 'composer', session: 'TEST P', at: PAST }], area: 'ui', change: { path: 'notes/style.md', summary: 'make the warning band red' } }
  const w = project(on, { files: { [`${DEC}/register/2026-11/D-5.json`]: JSON.stringify(REJECTED) } })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  await startSession($, w)
  await decide($, { questions: [COLOR], area: 'ui' })
  await tick(w)
  // The change he rejected saying why is in the case law, copied by code from his answer
  expect(String(asked[0].promptBlocks[1].text)).toContain('D-5 (2026-11-01, area ui), the person rejected the change to notes/style.md ("make the warning band red"), saying: "warnings stay amber, never red"')
  // He answers with a note; fleet delivers it, and the turn it starts carries his words
  await fleet($, '')
  expect(await fleet($, 'note 1 amber reads calmer next to the logo')).toContain('Note on 1 saved')
  await fleet($, '1a')
  for (let i = 0; i < 10 && !w.submits.length; i++) await tick(w, 500)
  expect(w.submits[0]).toContain('[D-6] The person answered:\n1) Which color for the warning band? → a) Amber (note: amber reads calmer next to the logo)')
  await $.turn.start({ text: w.submits[0] as string, turnId: 't-2' })
  await w.clock.settle()
  const mine: any = await $.tool.call({ tool: 'mcp__fleet__taste', said: 'amber reads calmer next to the logo', about: 'a red warning band', principle: 'warnings stay calm', area: 'ui' } as any)
  expect(mine.result).toContain('Recorded as T-1 in the register: a principle candidate ("warnings stay calm")')
  expect(json(w, `${DEC}/register/2026-11/T-1.json`).taste).toMatchObject({ person: true, quoted: 'amber reads calmer next to the logo' })
  const not: any = await $.tool.call({ tool: 'mcp__fleet__taste', said: 'red belongs to the vendor brand', about: 'red', principle: 'leave red to the vendor', area: 'ui' } as any)
  expect(not.result).toContain("(what it says isn't in the person's words fleet delivered this turn)")
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't-2', reason: 'answer' } as any)
  await w.clock.settle()
  // The next turn isn't fleet's delivery: nothing of his to quote
  const after: any = await $.tool.call({ tool: 'mcp__fleet__taste', said: 'amber reads calmer next to the logo', about: 'a red warning band', principle: 'warnings stay calm', area: 'ui' } as any)
  expect(after.result).toContain("(the person didn't type this turn)")
})

// ---- Live areas (0.7.0) ----

const FLAGS = { reversible: true, touchesMoney: false, outsideWorld: false }

test('live: an area the person turns on goes live at once; an exact repeat answered by the judge, the model’s own verdicts only proposing, a money one held', WITH_SESSIONS, async ($, on) => {
  const asked = model(on, text => (text.includes('Which cache, the fast one or the quick one?') ? '{"answers": [{"q": 1, "outcome": "send-back", "why": "the two options are the same thing"}]}' : '{"answers": [{"q": 1, "outcome": "hold", "why": "taste"}]}'))
  const w = project(on)
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  await startSession($, w)
  // Only the person turns an area live, and it's live at once (nothing judged yet): its exact repeats are his answers
  expect(await fleet($, 'judges live storage', { kind: 'plugin', name: 'other' })).toContain('Only the person turns an area live')
  expect(await fleet($, 'judges live hosting')).toContain("hosting isn't one of the project's tags (storage, ui)")
  expect(await fleet($, 'judges live storage --force "trying it"')).toContain('write /fleet judges, /fleet judges live <area> or /fleet judges off <area>')
  expect(w.files.has(`${FLEET}/state/judges.json`)).toBe(false)
  expect(await fleet($, 'stats storage')).toContain("storage: in shadow (/fleet judges live storage answers its exact repeats at once); the model's own verdicts have 0 compared (they need 30 compared at 90%): they'd only propose")
  const on1 = await fleet($, 'judges live storage')
  expect(on1.split('\n')[0]).toBe('Area storage is live.')
  expect(on1).toContain("The model's own verdicts only propose there until they earn it apart (the model's own verdicts have 0 compared (they need 30 compared at 90%))")
  expect(json(w, `${FLEET}/state/judges.json`)).toEqual({ format: 1, live: { storage: { at: expect.any(Number), by: 'TEST A' } }, back: {}, seen: {} })
  expect(await fleet($, 'judges live storage')).toContain('storage is live already')
  expect(await fleet($, 'stats storage')).toContain("storage: live, its exact repeats answered at once; the model's own verdicts have 0 compared (they need 30 compared at 90%): they only propose")
  // An exact repeat of D-1, with the asker's word that it's reversible, touches no money and stays inside: answered at once
  await decide($, { questions: [DB], area: 'storage', ...FLAGS })
  await tick(w)
  expect(asked.length).toBe(0)
  expect(json(w, `${DEC}/answers/D-2.1.json`)).toMatchObject({ format: 1, id: 'D-2', q: 1, label: 'SQLite', origin: 'judge', judge: { cites: ['D-1'], repeat: true } })
  for (let i = 0; i < 2; i++) await tick(w)
  expect(w.submits[0]).toBe(
    "[D-2] The judge answered for the person, from what they decided before (they can overrule it):\n1) Which database for the cache? → a) SQLite (the judge's answer, citing D-1: the same question, answered so before)\n\nGo on with what depended on it. If the person overrules the judge, you'll hear it as a message from the fleet plugin that starts with the same id: then undo what you built on its answer.",
  )
  expect(json(w, `${DEC}/register/2026-11/D-2.json`)).toMatchObject({ state: 'delivered', judge: { live: true, answered: [1], agreed: [null] } })
  // A malformed one: the model's own verdict, which hasn't earned live answers here (D3): it only proposes
  await decide($, { questions: [{ question: 'Which cache, the fast one or the quick one?', options: [{ label: 'Fast' }, { label: 'Quick' }], recommended: 'Fast', why: 'speed' }], area: 'storage', ...FLAGS })
  for (let i = 0; i < 3; i++) await tick(w)
  expect(w.submits.length).toBe(1)
  expect(json(w, `${DEC}/judge/D-3.json`)).toMatchObject({ live: true, liveWhy: "the model's own verdicts have 0 compared (they need 30 compared at 90%): they only propose here", verdicts: [{ outcome: 'send-back' }] })
  expect(w.files.has(`${DEC}/answers/D-3.drop.json`)).toBe(false)
  // Money: held by a gate, waits for the person; no flags given: the judge proposes, and waits too
  await decide($, { questions: [PAY], area: 'storage', touchesMoney: true })
  await decide($, { questions: [{ ...DB, question: 'Which database for the logs?' }], area: 'storage' })
  for (let i = 0; i < 3; i++) await tick(w)
  expect(w.submits.length).toBe(1)
  expect(json(w, `${DEC}/judge/D-4.json`).gated).toBe('it touches money')
  expect(json(w, `${DEC}/judge/D-5.json`)).toMatchObject({ live: true, liveWhy: "its asker didn't say it's reversible" })
  const list = await fleet($, '')
  expect(list).toContain('3 questions for you')
  expect(list).toContain('judge: held by a gate (it touches money)')
  expect(list).toContain('judge: send back: the two options are the same thing')
  expect((await fleet($, 'stats')).split('\n')[0]).toContain('Judges: on, live in storage, in shadow elsewhere · model haiku · today 2 calls')
  expect(await fleet($, 'status')).toContain('judges: on (haiku), live in storage, in shadow elsewhere: today 2 calls')
  expect(await fleet($, 'judges')).toContain('1 answered, 0 overruled; exact repeats only)')
  expect(json(w, `${FLEET}/state/judges/2026-11-02/aaaaaaaa.json`)).toMatchObject({ format: 1, calls: 2, live: 1 })
  // The cap: past perDay a live area only proposes
  w.touch(`${FLEET}/world.json`, JSON.stringify({ worldFormat: 1, paths: ['notes/**'], tags: ['storage', 'ui'], judges: { perDay: 1 } }))
  await tick(w)
  await decide($, { questions: [DB], area: 'storage', ...FLAGS })
  await tick(w)
  expect(json(w, `${DEC}/judge/D-6.json`)).toMatchObject({ live: true, liveWhy: "today's 1 live answers in the project are used up", verdicts: [{ outcome: 'decided', repeat: true }] })
  expect(w.files.has(`${DEC}/answers/D-6.1.json`)).toBe(false)
})

// Two closed decisions of the area whose model verdicts the person agreed with: with promote.proposals at 2, the area
// has earned live answers, and its model verdicts too
function judgedBefore(id: string, q: typeof COLOR, label: string) {
  return JSON.stringify({ ...D1, id, questions: [q], answers: [{ label, origin: 'composer', session: 'TEST P', at: PAST }], judge: { id, at: PAST, area: 'storage', model: 'haiku', usd: 0.0002, verdicts: [{ q: 1, outcome: 'decided', option: label, cites: ['principles.md:3'], why: '' }], agreed: [true] } })
}

test('live: the model’s own verdicts answer once they earned it apart, citing only charter.md or principles.md; a malformed one goes back', WITH_SESSIONS, async ($, on) => {
  const ERRORS = { question: 'Which color for the error banner?', options: [{ label: 'Red', description: 'errors only' }, { label: 'Amber', description: 'warnings' }], recommended: 'Red', why: 'it is an error' }
  const TESTS = { question: 'Write the tests first or after?', options: [{ label: 'First', description: 'tests before code' }, { label: 'After' }], recommended: 'First', why: 'habit' }
  const asked = model(on, text => {
    if (text.includes('Which color for the error banner?')) return '{"answers": [{"q": 1, "outcome": "decided", "option": "a", "cites": ["principles.md:3"], "why": "red is for errors"}]}'
    if (text.includes('Write the tests first or after?')) return '{"answers": [{"q": 1, "outcome": "decided", "option": "a", "cites": ["CLAUDE.md:3"], "why": "tests first"}]}'
    if (text.includes('Which cache, the fast one or the quick one?')) return '{"answers": [{"q": 1, "outcome": "send-back", "why": "the two options are the same thing"}]}'
    return '{"answers": [{"q": 1, "outcome": "hold", "why": "taste"}]}'
  })
  const w = project(on, {
    files: {
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], tags: ['storage', 'ui'], judges: { promote: { proposals: 2 } } }),
      [`${DEC}/register/2026-11/D-2.json`]: judgedBefore('D-2', COLOR, 'Amber'),
      [`${DEC}/register/2026-11/D-3.json`]: judgedBefore('D-3', { ...COLOR, question: 'Which color for the notice band?' }, 'Amber'),
    },
  })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  await startSession($, w)
  const on1 = await fleet($, 'judges live storage')
  expect(on1).toContain('Area storage is live.')
  expect(on1).toContain("The model's own verdicts answer too (a citation of charter.md, principles.md or your answers that code checks), and one it finds malformed goes back to its asker with why: the model's own verdicts: 2 compared, 100% agreement.")
  expect(await fleet($, 'stats storage')).toContain('model verdicts 2 of 2 (100%)')
  // A model verdict citing principles.md: the asker's answer, labelled
  await decide($, { questions: [ERRORS], area: 'storage', ...FLAGS })
  await tick(w)
  expect(asked.length).toBe(1)
  expect(json(w, `${DEC}/answers/D-4.1.json`)).toMatchObject({ label: 'Red', origin: 'judge', judge: { cites: ['principles.md:3'] } })
  for (let i = 0; i < 2; i++) await tick(w)
  expect(w.submits[0]).toContain("[D-4] The judge answered for the person, from what they decided before (they can overrule it):\n1) Which color for the error banner? → a) Red (the judge's answer, citing principles.md:3)")
  // One citing CLAUDE.md, which sessions write too: proposed, never answered live
  await decide($, { questions: [TESTS], area: 'storage', ...FLAGS })
  for (let i = 0; i < 3; i++) await tick(w)
  expect(json(w, `${DEC}/judge/D-5.json`)).toMatchObject({
    live: true,
    liveWhy: 'not as a live answer: 1) CLAUDE.md:3 is in CLAUDE.md, which sessions write too: a live answer cites only charter.md or principles.md',
    verdicts: [{ outcome: 'decided', option: 'First', cites: ['CLAUDE.md:3'] }],
  })
  expect(w.files.has(`${DEC}/answers/D-5.1.json`)).toBe(false)
  expect(await fleet($, '')).toContain('judge: a) First, citing CLAUDE.md:3: tests first')
  // A malformed one goes back to its asker
  await decide($, { questions: [{ question: 'Which cache, the fast one or the quick one?', options: [{ label: 'Fast' }, { label: 'Quick' }], recommended: 'Fast', why: 'speed' }], area: 'storage', ...FLAGS })
  for (let i = 0; i < 3; i++) await tick(w)
  expect(w.submits[1]).toContain('[D-6] The judge sent this question back without asking the person: the two options are the same thing\nYou asked: 1) Which cache, the fast one or the quick one?')
  expect(json(w, `${DEC}/register/2026-11/D-6.json`)).toMatchObject({ state: 'dropped', why: 'the two options are the same thing', judge: { sentBack: true } })
  expect(await fleet($, 'judges')).toContain("1 answered, 0 overruled; the model's own verdicts answer too)")
})

test('overrule: the asker hears it once, the correction is case law ahead of the judge, and the area goes back to shadow', WITH_SESSIONS, async ($, on) => {
  model(on, () => '{"answers": [{"q": 1, "outcome": "hold", "why": "taste"}]}')
  const w = project(on)
  w.touch(`${FLEET}/world.json`, JSON.stringify({ worldFormat: 1, paths: ['notes/**'], tags: ['storage', 'ui'], judges: { reviewer: 'TEST A' } }))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  await startSession($, w)
  await fleet($, 'judges live storage')
  // Two live answers, the same question twice (exact repeats of D-1)
  for (let n = 0; n < 2; n++) {
    await decide($, { questions: [DB], area: 'storage', ...FLAGS })
    for (let i = 0; i < 3; i++) await tick(w)
  }
  expect(w.submits.length).toBe(2)
  expect(await fleet($, 'overrule D-1 b')).toBe("D-1 wasn't answered by a judge: there's nothing to overrule (what you answered stands).")
  expect(await fleet($, 'overrule D-2 a')).toBe('1: the judge answered a) SQLite already: nothing to overrule')
  expect(await fleet($, 'overrule D-2 b "the queue runs it"', { kind: 'plugin', name: 'other' })).toContain('Only the person overrules a judge')
  const said = await fleet($, 'overrule D-2 b "the queue runs it"')
  expect(said).toContain('Overruled D-2:\n  1) Which database for the cache? → b) Redis (the judge had a) SQLite)')
  expect(said).toContain('TEST A hears it as a message from fleet when it\'s idle. The correction is in the register: the judges read it from now on, ahead of their own answers. TEST A is told, to propose a principle.')
  // One overrule; D-3, which he never saw, counts neither way
  expect(said).toContain('Area storage: you overruled 1 of the last 1 live answer you reviewed, still live (2 of the last 10 bring it back to shadow).')
  expect(await fleet($, 'overrule D-2 b')).toBe('D-2 was overruled already: the judges read that correction')
  expect(json(w, `${DEC}/register/2026-11/D-2.overrule.json`)).toMatchObject({ registerFormat: 1, id: 'D-2', overrules: 'D-2', answers: [{ label: 'Redis', origin: 'composer', session: 'TEST A' }], judged: ['SQLite'], why: 'the queue runs it', area: 'storage' })
  expect(json(w, `${FLEET}/state/judges.json`)).toMatchObject({ live: { storage: { by: 'TEST A' } }, back: {} })
  expect(await fleet($, '')).toContain("   D-2 · TEST A · you overruled the judge, told when it's idle")
  // Delivered once, at idle; the notice goes
  for (let i = 0; i < 3; i++) await tick(w)
  const told = w.submits.find(s => s.includes('overruled')) ?? ''
  expect(told).toBe('[D-2] The person overruled the judge on D-2:\n1) Which database for the cache? → b) Redis, not a) SQLite\nWhy: "the queue runs it"\n\nUndo what you built on the judge\'s answer, and go on with theirs.')
  expect(w.files.has(`${DEC}/overrules/D-2.json`)).toBe(false)
  for (let i = 0; i < 3; i++) await tick(w)
  expect(w.submits.filter(s => s.includes('overruled')).length).toBe(1)
  // A second overrule among the last 10 live answers he reviewed: back to shadow
  const again = await fleet($, 'overrule D-3 b "the queue still runs it"')
  expect(again).toContain('Area storage: you overruled 2 of the last 2 live answers you reviewed: back to shadow')
  expect(json(w, `${FLEET}/state/judges.json`)).toMatchObject({ live: {}, back: { storage: { why: 'you overruled 2 of the last 2 live answers you reviewed when you overruled D-3' } } })
  // The stats count it against the area; the brief says what happened, and what it listed counts as seen
  expect(await fleet($, 'stats storage')).toContain('1) a) SQLite citing D-1 (an exact repeat): answered live, you overruled it')
  const brief = await fleet($, 'brief')
  expect(brief).toContain('2. What changed: the judges')
  expect(brief).toContain('   - the judge answered D-2 (area storage) for you, citing D-1\n')
  expect(brief).toContain('   - you overruled the judge on D-2 (area storage): "the queue runs it"')
  expect(brief).toContain('   - area storage went back to shadow at ')
  expect(Object.keys(json(w, `${FLEET}/state/judges.json`).seen).sort()).toEqual(['D-2', 'D-3'])
  const judges = await fleet($, 'judges')
  expect(judges).toContain('Live: no area; the judges only propose (shadow).')
  expect(judges).toContain('Back to shadow: storage at ')
  // The next time, the correction is the case law: the same question is now an exact repeat of D-3's, with Redis
  await decide($, { questions: [DB], area: 'storage', ...FLAGS })
  await tick(w)
  expect(json(w, `${DEC}/judge/D-4.json`).verdicts[0]).toMatchObject({ outcome: 'decided', option: 'Redis', cites: ['D-3'], repeat: true })
  expect(w.files.has(`${DEC}/answers/D-4.1.json`)).toBe(false)
})

test('the reviewer of the judges hears each overrule once, to propose a principle', WITH_SESSIONS, async ($, on) => {
  const notice = { format: 1, id: 'D-9', at: PAST, asker: { ref: 'bbbbbbbb', sessionId: 'x', name: 'TEST B', root: ROOT }, questions: [DB], judged: ['SQLite'], answers: [{ label: 'Redis' }], why: 'the queue runs it', area: 'storage' }
  const w = project(on, {
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Chief', FLEET_ROLE: 'chief' },
    files: {
      [`${DEC}/overrules/D-9.review.json`]: JSON.stringify(notice),
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], tags: ['storage'], judges: { reviewer: 'chief' } }),
      [`${FLEET}/roster.json`]: JSON.stringify({ rosterFormat: 1, roles: { chief: { agent: 'chief', model: 'haiku' } }, instances: [{ name: 'Chief', role: 'chief' }] }),
      [`${ROOT}/.claude/agents/chief.md`]: '---\nname: chief\ntools: Read, mcp__fleet__*\n---\nYou are the chief.\n',
      [`${FLEET}/instances/chief.json`]: '{}\n',
    },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.01 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Chief', root: ROOT, background: true, agent: 'chief' }, rows: { [REF]: row(REF, 'Chief', 'idle') } })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'chief' } as any)
  for (let i = 0; i < 20; i++) await tick(w)
  const told = w.submits.find(s => s.includes('overruled')) ?? ''
  expect(told).toContain('fleet: the person overruled the project\'s judge once (you review the judges\' disagreements):\n- D-9 (area storage): "Which database for the cache?" → b) Redis, not a) SQLite (why: "the queue runs it")')
  expect(told).toContain('a change to .claude/fleet/principles.md with mcp__fleet__decide kind "change"')
  expect(w.files.has(`${DEC}/overrules/D-9.review.json`)).toBe(false)
})

test('live: a send-back saying the statute answers it acts only when its citations check; a re-ask of what was sent back is the person’s', WITH_SESSIONS, async ($, on) => {
  const CACHE = { question: 'Which cache, the fast one or the quick one?', options: [{ label: 'Fast' }, { label: 'Quick' }], recommended: 'Fast', why: 'speed' }
  const TESTS = { question: 'Write the tests first or after?', options: [{ label: 'First', description: 'tests before code' }, { label: 'After' }], recommended: 'First', why: 'habit' }
  const asked = model(on, text => {
    if (text.includes('Which cache, the fast one or the quick one?')) return '{"answers": [{"q": 1, "outcome": "send-back", "because": "malformed", "why": "the two options are the same thing"}]}'
    if (text.includes('Write the tests first or after?')) return '{"answers": [{"q": 1, "outcome": "send-back", "because": "statute", "cites": ["CLAUDE.md:3"], "why": "the rules say tests first"}]}'
    return '{"answers": [{"q": 1, "outcome": "hold", "why": "taste"}]}'
  })
  const w = project(on, {
    files: {
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], tags: ['storage', 'ui'], judges: { promote: { proposals: 2 } } }),
      [`${ROOT}/CLAUDE.md`]: '# Project\n\nTests first, before any code.\n',
      [`${DEC}/register/2026-11/D-2.json`]: judgedBefore('D-2', COLOR, 'Amber'),
      [`${DEC}/register/2026-11/D-3.json`]: judgedBefore('D-3', { ...COLOR, question: 'Which color for the notice band?' }, 'Amber'),
    },
  })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  await startSession($, w)
  expect(await fleet($, 'judges live storage')).toContain('Area storage is live')
  // Citing CLAUDE.md, which sessions write too: shown, never acted on; the person answers it
  await decide($, { questions: [TESTS], area: 'storage', ...FLAGS })
  for (let i = 0; i < 3; i++) await tick(w)
  expect(w.files.has(`${DEC}/answers/D-4.drop.json`)).toBe(false)
  expect(json(w, `${DEC}/judge/D-4.json`)).toMatchObject({ live: true, liveWhy: 'not as a live answer: the send-back of 1) CLAUDE.md:3 is in CLAUDE.md, which sessions write too: a live send-back cites only charter.md or principles.md', verdicts: [{ outcome: 'send-back', because: 'statute', cites: ['CLAUDE.md:3'] }] })
  expect(await fleet($, '')).toContain('judge: send back: the rules say tests first, citing CLAUDE.md:3\n')
  // A malformed one goes back; asked again by the same session within a day, it's the person's
  await decide($, { questions: [CACHE], area: 'storage', ...FLAGS })
  for (let i = 0; i < 3; i++) await tick(w)
  expect(w.submits.some(x => x.startsWith('[D-5] The judge sent this question back'))).toBe(true)
  expect(json(w, `${DEC}/register/2026-11/D-5.json`)).toMatchObject({ state: 'dropped', judge: { sentBack: true } })
  const calls = asked.length
  await decide($, { questions: [{ ...CACHE, question: 'Which cache: the fast one or the quick one?' }], area: 'storage', ...FLAGS })
  for (let i = 0; i < 3; i++) await tick(w)
  expect(asked.length).toBe(calls)
  expect(json(w, `${DEC}/judge/D-6.json`)).toMatchObject({ gated: 'it asks again what the judge sent back as D-5: yours to answer', verdicts: [] })
  expect(w.files.has(`${DEC}/answers/D-6.drop.json`)).toBe(false)
  expect(await fleet($, '')).toContain('judge: held by a gate (it asks again what the judge sent back as D-5: yours to answer)')
})

test('overrule before delivery: the person’s answer replaces the judge’s, reaches the asker first, and counts as an overrule', WITH_SESSIONS, async ($, on) => {
  model(on, () => '{"answers": [{"q": 1, "outcome": "hold", "why": "taste"}]}')
  const w = project(on, { files: { [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], tags: ['storage', 'ui'], judges: { reviewer: 'Chief' } }) } })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'working') } })
  await startSession($, w)
  await fleet($, 'judges live storage')
  // The asker is in a turn: the judge's live answer waits for it to end
  await $.turn.start({ text: 'working on the cache', turnId: 't-1' })
  await decide($, { questions: [DB], area: 'storage', ...FLAGS })
  for (let i = 0; i < 3; i++) await tick(w)
  expect(json(w, `${DEC}/answers/D-2.1.json`)).toMatchObject({ label: 'SQLite', origin: 'judge' })
  expect(w.submits).toEqual([])
  expect(await fleet($, 'overrule D-2 a')).toBe('1: the judge answered a) SQLite already: nothing to overrule')
  const said = await fleet($, 'overrule D-2 b "the queue runs it"')
  expect(said).toContain('Overruled D-2 before its asker had it:\n  1) Which database for the cache? → b) Redis (the judge had a) SQLite)')
  expect(said).toContain("TEST A gets your answer instead of the judge's, as yours, when it's idle.")
  expect(said).toContain('Area storage: you overruled 1 of the last 1 live answer you reviewed, still live')
  expect(json(w, `${DEC}/answers/D-2.1.json`)).toMatchObject({ label: 'Redis', origin: 'composer', replacedJudge: { label: 'SQLite', cites: ['D-1'], repeat: true } })
  expect(json(w, `${DEC}/register/2026-11/D-2.overrule.json`)).toMatchObject({ id: 'D-2', answers: [{ label: 'Redis' }], judged: ['SQLite'], why: 'the queue runs it' })
  // The reviewer hears it; the asker doesn't (it gets his answer first)
  expect(w.files.has(`${DEC}/overrules/D-2.review.json`)).toBe(true)
  expect(w.files.has(`${DEC}/overrules/D-2.json`)).toBe(false)
  expect(await fleet($, 'overrule D-2 a')).toBe('question 1 of D-2 was answered by you, not the judge: nothing to overrule there')
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't-1', reason: 'answer' } as any)
  for (let i = 0; i < 3; i++) await tick(w)
  expect(w.submits[0]).toBe('[D-2] The person answered:\n1) Which database for the cache? → b) Redis\n\nGo on with what depended on it.')
  for (let i = 0; i < 3; i++) await tick(w)
  expect(w.submits.filter(x => x.includes('overruled')).length).toBe(0)
  expect(json(w, `${DEC}/register/2026-11/D-2.json`)).toMatchObject({ state: 'delivered', answers: [{ label: 'Redis', replacedJudge: { label: 'SQLite' } }], judge: { answered: [1], agreed: [false] } })
  expect(await fleet($, 'stats storage')).toContain('1) a) SQLite citing D-1 (an exact repeat): answered live, you overruled it')
  expect(await fleet($, 'overrule D-2 a')).toBe('D-2 was overruled already: the judges read that correction')
  // The correction is the case law: the same question again takes his answer
  await decide($, { questions: [DB], area: 'storage', ...FLAGS })
  for (let i = 0; i < 3; i++) await tick(w)
  expect(json(w, `${DEC}/register/2026-11/D-3.json`).judge.verdicts[0]).toMatchObject({ option: 'Redis', cites: ['D-2'], repeat: true })
})

test('the reviewer is woken for an overrule to review, once; one that waited a day for it is counted in /fleet status', WITH_SESSIONS, async ($, on) => {
  const at = Date.UTC(2026, 10, 2, 11, 0, 0)
  const notice = (id: string, when: number) => JSON.stringify({ format: 1, id, at: when, asker: { ref: 'bbbbbbbb', sessionId: 'x', name: 'TEST B', root: ROOT }, questions: [DB], judged: ['SQLite'], answers: [{ label: 'Redis' }], area: 'storage' })
  const w = world(on, {
    background: false,
    files: {
      ...PROJECT,
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], judges: { reviewer: 'Owner C' } }),
      [`${FLEET}/instances/owner-c/state.json`]: JSON.stringify({ format: 1, instance: 'Owner C', slug: 'owner-c', ref: 'ccccccc1', sessionId: 'cccccccc-0000-0000-0000-000000000000', at, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0 }),
      [`${DEC}/overrules/D-8.review.json`]: notice('D-8', PAST),
      [`${DEC}/overrules/D-9.review.json`]: notice('D-9', at),
    },
  })
  sessionsSay(w, { rows: { ccccccc1: row('ccccccc1', 'Owner C', 'stopped') } })
  await startSession($, w)
  for (let i = 0; i < 8; i++) await tick(w, 30000)
  const wakes = () => (w.files.get(FAKE_LOG) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(c => c.wake).map(c => c.wake)
  expect(wakes()).toEqual([{ ref: 'ccccccc1', reason: 'fleet: an overrule of the judge to review' }])
  expect(json(w, `${FLEET}/state/wakes.json`).instances['owner-c']).toMatchObject({ count: 1, reviewFor: 'D-9.review.json' })
  // Two hours on, the same notices: not woken again for them
  for (let i = 0; i < 240; i++) await tick(w, 30000)
  expect(wakes().length).toBe(1)
  expect(await fleet($, 'status')).toContain('  1 overrule of the judge (D-8) has waited a day or more for the reviewer, Owner C (it hears them at its next step, or woken)')
})
