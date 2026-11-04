import { expect, test } from 'claude-code/testing'

import { answerName, noteName } from '../hooks/decisions'
import { DEC, FLEET, REF, ROOT, SID, decide, fleet, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// What an instance hears of the decisions around it: a change the person applied that another session drafted, and a
// decision of another session it said its work waits on, once it closes; and the brief's closed questions

const ROSTER = JSON.stringify({
  rosterFormat: 1,
  sections: [{ id: 'owners', title: 'Owners' }],
  roles: { owner: { agent: 'owner', model: 'haiku' } },
  instances: [
    { name: 'Owner A', role: 'owner', section: 'owners' },
    { name: 'Owner B', role: 'owner', section: 'owners' },
  ],
})
const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, AskUserQuestion, SendMessage, mcp__fleet__*\n---\nYou own a part of the notes.\n'
const B = { ref: 'bbbbbbbb', sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', name: 'Owner B', root: ROOT }
const GO = [{ question: 'Go ahead with the split?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'w' }]

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

async function ownerA($: any, on: any): Promise<World> {
  const w = world(on, {
    worldPaths: ['notes/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: { [`${FLEET}/roster.json`]: ROSTER, [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/owner-a.json`]: '{}\n', [`${FLEET}/charter.md`]: '# Charter\n' },
  })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  await startSession($, w)
  await tick(w)
  return w
}

async function step($: any): Promise<string> {
  const r: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  return (r.context ?? []).join('\n')
}

function closedRecord(id: string, at: number, answers: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ registerFormat: 1, id, source: 'decide', fleet: '0.8.2', at, asker: B, questions: GO, answers, state: 'delivered', delivered: { at, how: 'submit' }, closedAt: at, ...extra })
}

test('an instance hears, once, a change the person applied that another session drafted; never its own', WITH_SESSIONS, async ($, on) => {
  const w = await ownerA($, on)
  const at = w.clock.now()
  w.touch(`${DEC}/register/2026-11/D-5.json`, closedRecord('D-5', at, [{ label: 'applied', origin: 'composer', session: 'TEST Person', at }], { questions: [], kind: 'change', change: { path: '.claude/fleet/charter.md', summary: 'the areas and who owns each' } }))
  w.touch(`${DEC}/applied/D-5.json`, JSON.stringify({ format: 1, id: 'D-5', at, session: 'TEST Person', origin: 'composer' }))
  const first = await step($)
  expect(first).toMatch(/fleet: the person applied D-5, a change to \.claude\/fleet\/charter\.md \("the areas and who owns each", drafted by Owner B\), at \d\d:\d\d: read \.claude\/fleet\/charter\.md again before you rely on it\./)
  expect(await step($)).not.toContain('D-5')
  // Its own change: it hears the answer as its drafter, not this line
  const mine = { ref: REF, sessionId: SID, name: 'Owner A', root: ROOT }
  w.touch(`${DEC}/register/2026-11/D-6.json`, closedRecord('D-6', at, [{ label: 'applied', origin: 'composer', at }], { questions: [], asker: mine, kind: 'change', change: { path: '.claude/fleet/charter.md', summary: 'mine' } }))
  w.touch(`${DEC}/applied/D-6.json`, JSON.stringify({ format: 1, id: 'D-6', at, session: 'TEST Person', origin: 'composer' }))
  expect(await step($)).not.toContain('D-6')
})

test('decide kind wait: another session’s open decision is told once it closes, with its outcome; its own, a closed one and an unknown one are said at once', WITH_SESSIONS, async ($, on) => {
  const w = await ownerA($, on)
  const at = w.clock.now()
  w.touch(`${DEC}/queue/D-7.json`, JSON.stringify({ format: 1, fleet: '0.8.2', id: 'D-7', at, asker: B, questions: GO }))
  expect((await decide($, { kind: 'wait', id: 'D-7' })).result).toBe("D-7 (asked by Owner B) is still open: fleet tells you at your next step once it's settled, with its outcome. Keep working on what doesn't depend on it.")
  expect(await step($)).not.toContain('D-7')
  // It closes: answered Yes by the person
  w.files.delete(`${DEC}/queue/D-7.json`)
  w.touch(`${DEC}/register/2026-11/D-7.json`, closedRecord('D-7', at, [{ label: 'Yes', origin: 'composer', at }]))
  expect(await step($)).toContain('fleet: D-7, which your work waits on, is settled (asked by Owner B): "Go ahead with the split?" → Yes. Go on with what waited on it.')
  expect(await step($)).not.toContain('D-7')
  // Closed already: said at once
  expect((await decide($, { kind: 'wait', id: 'D-7' })).result).toBe('D-7 is closed already (asked by Owner B): "Go ahead with the split?" → Yes.')
  // Its own: it reaches it anyway
  await decide($, { questions: GO })
  expect((await decide($, { kind: 'wait', id: 'D-8' })).result).toContain('D-8 is your own: its answer reaches you anyway')
  expect((await decide($, { kind: 'wait', id: 'D-99' })).deny).toContain("D-99 isn't a decision of this project")
  expect((await decide($, { kind: 'wait', id: 'soon' })).deny).toContain('id: the decision your work waits on, as D-<n>')
})

test('the brief lists the questions closed in its window with their outcome, apart from the decisions carried out', WITH_SESSIONS, async ($, on) => {
  const w = await ownerA($, on)
  const at = w.clock.now()
  w.touch(`${DEC}/register/2026-11/D-7.json`, closedRecord('D-7', at, [{ label: 'Yes', origin: 'composer', at }]))
  w.touch(`${DEC}/register/2026-11/D-9.json`, closedRecord('D-9', at, [{ text: 'only after the review', origin: 'composer', at }]))
  const brief = await fleet($, 'brief')
  expect(brief).toContain('2 questions closed')
  expect(brief).toContain('   - D-7 (Owner B): "Go ahead with the split?" → Yes')
  expect(brief).toContain('   - D-9 (Owner B): "Go ahead with the split?" → "only after the review"')
})

test('the brief lists a resource the person got with his words, and keeps his part of a question a judge answered in part', WITH_SESSIONS, async ($, on) => {
  const w = await ownerA($, on)
  const at = w.clock.now()
  w.touch(`${DEC}/register/2026-11/D-13.json`, closedRecord('D-13', at, [{ label: 'done', note: 'in the lab cabinet', origin: 'composer', at }], { questions: [], kind: 'resource', resource: { what: 'the spare test board', why: 'w' } }))
  const two = [...GO, { question: 'Which week?', options: [{ label: 'This' }, { label: 'Next' }], recommended: 'Next', why: 'w' }]
  w.touch(`${DEC}/register/2026-11/D-14.json`, closedRecord('D-14', at, [{ label: 'Yes', origin: 'judge', at }, { label: 'Next', origin: 'composer', at }], { questions: two }))
  const brief = await fleet($, 'brief')
  expect(brief).toContain('   - D-13 (Owner B, the spare test board): done: "in the lab cabinet"')
  expect(brief).toContain('"Which week?" → Next')
})

test('a delivery to an instance carries today’s date, as its nudges do', WITH_SESSIONS, async ($, on) => {
  const w = await ownerA($, on)
  await decide($, { questions: GO })
  await fleet($, '')
  await fleet($, '1a')
  await tick(w, 10000)
  const last = w.submits[w.submits.length - 1] ?? ''
  expect(last).toContain('[D-1]')
  expect(last).toContain('\n\nToday is ')
})

test('an applied change is still told after its drafter was told (its applied/ claim gone, the register keeps it); never as a nudge of its own', WITH_SESSIONS, async ($, on) => {
  const w = await ownerA($, on)
  const at = w.clock.now()
  // The drafter's delivery closed it: only the register has it now
  w.touch(`${DEC}/register/2026-11/D-5.json`, closedRecord('D-5', at, [{ label: 'applied', origin: 'composer', session: 'TEST Person', at }], { questions: [], kind: 'change', change: { path: '.claude/fleet/charter.md', summary: 'the areas and who owns each' } }))
  // Idle for long: no nudge carries it (a nudge would be a turn of its own for every idle instance)
  await tick(w, 120000)
  expect(w.submits.some(s => s.includes('D-5'))).toBe(false)
  // Its next step that comes anyway hears it, once
  expect(await step($)).toContain('fleet: the person applied D-5, a change to .claude/fleet/charter.md')
  expect(await step($)).not.toContain('D-5')
  // One applied before its conversation started isn't news
  w.touch(`${DEC}/register/2026-11/D-4.json`, closedRecord('D-4', at - 86400000, [{ label: 'applied', origin: 'composer', at: at - 86400000 }], { questions: [], kind: 'change', change: { path: '.claude/fleet/charter.md', summary: 'old' } }))
  expect(await step($)).not.toContain('D-4')
})

test('kind wait on a resource, a change or an outbound says its real outcome; settled once answered, before its asker is told; kept in its heartbeat', WITH_SESSIONS, async ($, on) => {
  const w = await ownerA($, on)
  const at = w.clock.now()
  w.touch(`${DEC}/queue/D-11.json`, JSON.stringify({ format: 1, fleet: '0.8.2', id: 'D-11', at, asker: B, questions: [], kind: 'resource', resource: { what: 'a license for the simulator', why: 'w' } }))
  expect((await decide($, { kind: 'wait', id: 'D-11' })).result).toContain('D-11 (asked by Owner B) is still open')
  await tick(w, 31000)
  // In its heartbeat: a restart keeps it, and status can show it
  expect(JSON.parse(w.files.get(`${FLEET}/instances/owner-a/state.json`) ?? '{}').waits).toEqual({ 'D-11': expect.any(Number) })
  // The person answered it; its asker hasn't been told yet (the queue file is still there)
  w.touch(`${DEC}/answers/${answerName('D-11', 1)}`, JSON.stringify({ format: 1, id: 'D-11', q: 1, label: 'done', origin: 'composer', session: 'TEST Person', at }))
  w.touch(`${DEC}/answers/${noteName('D-11', 1)}`, JSON.stringify({ format: 1, id: 'D-11', q: 1, text: 'in the shared folder, file seat.lic', origin: 'composer', session: 'TEST Person', at }))
  expect(await step($)).toContain('fleet: D-11, which your work waits on, is settled (asked by Owner B): done: "in the shared folder, file seat.lic". Go on with what waited on it.')
  // A closed change, asked about once it's closed: its label, not "closed"
  w.touch(`${DEC}/register/2026-11/D-12.json`, closedRecord('D-12', at, [{ label: 'rejected', text: 'not this week', origin: 'composer', at }], { questions: [], kind: 'change', change: { path: '.claude/fleet/charter.md', summary: 's' } }))
  expect((await decide($, { kind: 'wait', id: 'D-12' })).result).toBe('D-12 is closed already (asked by Owner B): rejected: "not this week".')
})
