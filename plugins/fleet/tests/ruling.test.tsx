import { expect, test } from 'claude-code/testing'

import { markWords } from '../hooks/authority'
import { clockOn } from '../hooks/changes'
import { precedentsOf } from '../hooks/judges'
import { DEC, FLEET, JOB, REF, ROOT, SID, decide, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// What the person rules unprompted in his own session (decide kind ruling), and the small things around answers: a
// list of decisions one replaces and what /fleet shows on the replaced one, a bare verb when one item waits, an
// outside mark's date, and taste said again in other words

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

const Q = { question: 'Which color for the band?', options: ['Amber', 'Red'], recommended: 'Amber', why: 'calm' }

async function console_($: any, on: any): Promise<World> {
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${FLEET}/charter.md`]: '# Charter\n' } })
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, intent: '', firstTerminalAt: null }))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Console', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'Console', 'working') } })
  on('tool.call', { tool: 'WebFetch' }, () => ({ result: { bytes: 10, code: 200 }, text: 'a page' }) as any)
  await startSession($, w)
  return w
}


async function typed($: any, w: World, text: string, turnId: string) {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ text, turnId })
  await w.clock.settle()
}

test('a ruling the person types unprompted in his own session is recorded as his words, closed at once, and read as his record', WITH_SESSIONS, async ($, on) => {
  const w = await console_($, on)
  // Not his turn: refused
  await $.turn.start({ text: 'The fleet plugin sent a message:\nsomething', turnId: 't-0' })
  expect((await decide($, { kind: 'ruling', about: 'which packet sizes the report shows' })).deny).toContain('only in a turn the person typed in this session')
  await $.turn.complete({ text: '' } as any)
  await typed($, w, 'From now on the report shows only the two packet sizes we quote, not the others.', 't-1')
  expect((await decide($, { kind: 'ruling' })).deny).toContain('about: one line on what the person ruled')
  const r = await decide($, { kind: 'ruling', about: 'which packet sizes the report shows' })
  expect(r.result).toContain('Recorded as D-1: the person\'s ruling on which packet sizes the report shows, in his words')
  const reg = json(w, `${DEC}/register/2026-11/D-1.json`)
  expect(reg).toMatchObject({ source: 'decide', ruling: true, state: 'delivered', questions: [{ question: 'which packet sizes the report shows', options: [] }], answers: [{ text: 'From now on the report shows only the two packet sizes we quote, not the others.', origin: 'composer', pre: true }] })
  expect(w.files.has(`${DEC}/queue/D-1.json`)).toBe(false)
  expect(w.logs).toContain('recorded as your ruling (D-1, on which packet sizes the report shows): "From now on the report shows only the two packet sizes we quote, not the others.". To change it, say it again here: a new ruling of yours stands over this one.')
  expect(await fleet($, '')).toContain('Nothing is waiting for you')
  // The judges read it as his answer
  const ps = precedentsOf([reg])
  expect(ps).toMatchObject([{ id: 'D-1', kind: 'answer', questions: [{ question: 'which packet sizes the report shows', text: 'From now on the report shows only the two packet sizes we quote, not the others.' }] }])
  // The same words again in this turn: kept once
  expect((await decide($, { kind: 'ruling', about: 'the packet sizes again' })).result).toContain('D-1 has this ruling already')
})

test('a ruling typed in an instance’s window isn’t recorded: the instance isn’t the person’s console', WITH_SESSIONS, async ($, on) => {
  const OWNER = '---\nname: owner\ndescription: owns notes\ntools: Read, Write, Edit, AskUserQuestion, SendMessage, mcp__fleet__*\n---\nYou own notes.\n'
  const ROSTER = JSON.stringify({ rosterFormat: 1, sections: [{ id: 'owners', title: 'Owners' }], roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 } } }, instances: [{ name: 'Owner A', role: 'owner', section: 'owners', brief: 'You own notes.' }] })
  const w = world(on, { worldPaths: ['notes/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' }, files: { [`${FLEET}/roster.json`]: ROSTER, [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/owner-a.json`]: '{}\n' } })
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, intent: '', firstTerminalAt: null }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  on('classic.SessionStart', () => ({}))
  await startSession($, w)
  await tick(w)
  await typed($, w, 'Only the two sizes from now on.', 't-1')
  expect((await decide($, { kind: 'ruling', about: 'packet sizes' })).deny).toContain("Owner A is an instance of the roster, not the person's own session")
})

test('supersedes takes a list: each of the asker’s own open decisions it names is withdrawn; another session’s shows “replaced by” in /fleet', WITH_SESSIONS, async ($, on) => {
  const w = await console_($, on)
  await decide($, { questions: [Q] })
  await decide($, { questions: [{ ...Q, question: 'Which font for the band?' }] })
  const r = await decide($, { questions: [{ ...Q, question: 'Which color and font for the band?' }], supersedes: ['D-1', 'D-2'] })
  expect(r.result).toContain('Queued as D-3')
  expect(r.result).toContain('D-1, which it replaces, is withdrawn.')
  expect(r.result).toContain('D-2, which it replaces, is withdrawn.')
  expect(json(w, `${DEC}/register/2026-11/D-2.json`)).toMatchObject({ state: 'withdrawn', why: 'replaced by D-3' })
  // Another session's open decision: it stays, and /fleet shows on it what replaces it
  w.touch(`${DEC}/queue/D-9.json`, JSON.stringify({ format: 1, fleet: '0.8.0', id: 'D-9', at: w.clock.now(), asker: { ref: 'bbbbbbbb', sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', name: 'TEST B', root: ROOT }, questions: [{ question: 'Which size for the band?', options: [{ label: 'Small' }, { label: 'Large' }], recommended: 'Small', why: 'calm' }] }))
  await decide($, { questions: [{ ...Q, question: 'Which size and color for the band?' }], supersedes: 'D-9' })
  const list = await fleet($, '')
  expect(list).toContain('   replaced by D-10 (TEST B can withdraw it)')
})

test('a bare verb answers the one item of its kind that waits; with more than one, one line says which to name', WITH_SESSIONS, async ($, on) => {
  const w = await console_($, on)
  await $.turn.complete({ text: '' } as any)
  await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'the idea', content: '# Charter\n\nThe idea.\n' })
  await fleet($, '')
  const one = await fleet($, 'apply')
  expect(one).toContain('1: applied D-1: fleet wrote .claude/fleet/charter.md as drafted')
  expect(w.files.get(`${FLEET}/charter.md`)).toBe('# Charter\n\nThe idea.\n')
  await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'two', content: '# Charter\n\nTwo.\n' })
  await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'three', content: '# Charter\n\nThree.\n' })
  await fleet($, '')
  const two = await fleet($, 'apply')
  expect(two).toBe('apply what? 2 changes wait: /fleet 1 apply or /fleet 2 apply (/fleet lists them)')
})

test('an outside mark older than today says its date', () => {
  const at = Date.UTC(2026, 10, 3, 18, 57)
  const mark = { at, what: 'WebFetch of example.invalid' }
  // Read this morning: the time; two days ago: the time and the day, in the person's own time (3 h behind UTC here)
  expect(markWords(mark, ms => clockOn(ms, 0, Date.UTC(2026, 10, 3, 22, 0)))).toBe('WebFetch of example.invalid at 18:57')
  expect(markWords(mark, ms => clockOn(ms, 0, Date.UTC(2026, 10, 5, 18, 14)))).toBe('WebFetch of example.invalid at 18:57 on 3 Nov')
  expect(clockOn(at, -180, Date.UTC(2026, 10, 4, 2, 0))).toBe('15:57')
  expect(clockOn(at, -180, Date.UTC(2026, 10, 4, 4, 0))).toBe('15:57 on 3 Nov')
})

test('taste said again in other case, punctuation or spacing within a day is kept once', WITH_SESSIONS, async ($, on) => {
  const w = await console_($, on)
  await typed($, w, 'No more slides about the old design, please.', 't-1')
  const a = await $.tool.call({ tool: 'mcp__fleet__taste', said: 'No more slides about the old design, please.', about: 'the deck', principle: 'Show the current design only.' } as any)
  expect((a as any).result).toContain('Recorded as T-1')
  await $.turn.complete({ text: '' } as any)
  // Past the hour the same words were kept once in before
  await tick(w, 40 * 60000)
  await tick(w, 40 * 60000)
  await typed($, w, 'no more slides about the old design please', 't-2')
  const b: any = await $.tool.call({ tool: 'mcp__fleet__taste', said: 'no more slides about the old design please', about: 'the deck', principle: 'Show the current design only.' } as any)
  expect(b.result).toContain('T-1 has these words already')
})
