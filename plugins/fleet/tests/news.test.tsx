import { expect, test } from 'claude-code/testing'

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
  expect((await decide($, { kind: 'wait', id: 'D-7' })).result).toBe("D-7 (asked by Owner B) is still open: fleet tells you at your next step once it closes, with its outcome. Keep working on what doesn't depend on it.")
  expect(await step($)).not.toContain('D-7')
  // It closes: answered Yes by the person
  w.files.delete(`${DEC}/queue/D-7.json`)
  w.touch(`${DEC}/register/2026-11/D-7.json`, closedRecord('D-7', at, [{ label: 'Yes', origin: 'composer', at }]))
  expect(await step($)).toContain('fleet: D-7, which your work waits on, is closed (asked by Owner B): "Go ahead with the split?" → Yes. Go on with what waited on it.')
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
