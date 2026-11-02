import { expect, test } from 'claude-code/testing'

import { JUDGE_SYSTEM } from '../hooks/judges'
import { DEC, FAKE_SESSIONS, FLEET, JOB, REF, ROOT, SID, decide, fleet, json, row, sessionsSay, startSession, under, world, type World } from './world'

// The judges from the mod's side, in shadow: the asking session's fleet judges each choice once its ticket is out (the
// gates and the exact repeats with no model; one call for the rest), /fleet shows the proposal, the person answers as
// always, the register keeps whether he agreed, /fleet stats counts it; and the person's taste, recorded

const WITH_SESSIONS = { plugins: [FAKE_SESSIONS] }
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

function project(on: any) {
  return world(on, {
    files: {
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], tags: ['storage', 'ui'] }),
      [`${FLEET}/charter.md`]: '# Charter\n\nA small tool for one machine.\n',
      [`${FLEET}/principles.md`]: '# Principles\n\nWarnings are amber; red is only for errors.\n',
      [`${ROOT}/CLAUDE.md`]: '# Project\n\nTests first.\n',
      [`${DEC}/register/2026-11/D-1.json`]: JSON.stringify(D1),
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
  expect(stats).toContain('storage: 1 proposal · 1 decided (1 exact repeat), agreed 1 of 1 (100%) · 0 sent back · 0 held · 0 held by a gate · $0.00 in 0 calls')
  expect(stats).toContain('ui: 1 proposal · 1 decided (0 exact repeats), agreed 0 of 1 (0%)')
  expect(stats).toContain('(no area): 0 proposals · 0 decided (0 exact repeats), agreed 0 of 0 (—) · 0 sent back · 0 held · 1 held by a gate')
  const ui = await fleet($, 'stats ui')
  expect(ui).toContain('   D-3 · ')
  expect(ui).toContain('1) a) Amber citing principles.md:3: you answered b) Red')
  expect(await fleet($, 'status')).toContain('judges: on, in shadow (haiku): today 1 call, $0.')
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
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, firstTerminalAt: '2026-11-02T11:00:00Z' }))
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
  expect(((await $.tool.call({ tool: 'mcp__fleet__taste', said: 'x' } as any)) as any).deny).toContain('about: say what it was about')
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't-1', reason: 'answer' } as any)
  await w.clock.settle()
  await decide($, { questions: [COLOR], area: 'ui' })
  await tick(w)
  const law = String(asked[0].promptBlocks[1].text)
  expect(law).toContain('T-2 (2026-11-02, area ui), the person said no: "the band is too loud" about a red warning band; the principle it suggests: warning colors stay calm')
  expect(law).not.toContain('T-1')
})
