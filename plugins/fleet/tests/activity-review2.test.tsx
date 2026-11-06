import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { settingsText } from '../hooks/roster'
import { FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// fleet 0.10's activity part after its second review: lint errors at accept and apply whatever their form, the front
// door's idle line past an item nobody took, an item's writer kept, one no-response blamed on nobody, the model of an
// instance whose roster entry has an error left alone, "anyone but its writer", the sweeper's quiet events folders

const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, AskUserQuestion, SendMessage, mcp__fleet__*\n---\nYou own a part of the notes.\n'
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }
const HB = `${FLEET}/instances/owner-a`
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const HOUR = 3600000

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

async function step($: any, model: string, extra: Record<string, unknown> = {}) {
  const s = $.turn.step({ turnId: 't-1', index: 0, model, messageCount: 1, ...extra })
  for await (const _ of s) {
  }
  return s.result
}

function landed(w: any, path: string, text: string, by: { name: string; ref: string }, n: number, from: string | null = null) {
  const at = w.clock.now()
  w.touch(`${ROOT}/${path}`, text)
  w.touch(`${FLEET}/events/${hourFolder(at)}/${at}-bbbbbbbb-${n}.json`, JSON.stringify({ format: 1, at, path, from, to: hashText(text), via: 'tool', tool: from ? 'Edit' : 'Write', blind: false, by: { sessionId: `${by.ref}-0000-0000-0000-000000000000`, ref: by.ref, name: by.name, agentId: null } }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: `${at}-bbbbbbbb-${n}.json` }))
}

// ---- Q1: the solo template's world has no board/**, so an item's writer is never known ----

// templates/solo/fleet/roster.json and world.json as shipped (paths and roster shape)
const SOLO_ROSTER = {
  rosterFormat: 1,
  sections: [{ id: 'owners', title: 'Owners', order: 230 }],
  roles: { owner: { agent: 'owner', model: 'sonnet', budget: { usdDay: 5 }, cadenceH: 24 } },
  instances: [
    { name: 'Owner A', role: 'owner', section: 'owners', wave: 1 },
    { name: 'Owner B', role: 'owner', section: 'owners', wave: 1 },
    { name: 'Owner C', role: 'owner', section: 'owners', wave: 1 },
  ],
  budget: { usdDay: 15 },
  wakes: { everyMin: 60, perDay: 8 },
}
// The solo template's world.json paths (dev/fleet/check-templates.py checks a template whose roles write board items lists board/**)
const SOLO_WORLD = { worldFormat: 1, paths: ['notes/**', 'journals/**', 'board/**'] }

test("the solo template's world has board/**: the item Owner A wrote (no for:) goes to another owner first", WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: { [`${FLEET}/roster.json`]: JSON.stringify(SOLO_ROSTER), [`${FLEET}/world.json`]: JSON.stringify(SOLO_WORLD), [`${ROOT}/.claude/agents/owner.md`]: OWNER },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle'), bbbbbbb1: row('bbbbbbb1', 'Owner B', 'idle'), ccccccc1: row('ccccccc1', 'Owner C', 'idle') } })
  await startSession($, w)
  await tick(w, 30000)
  // Owner A writes board/B-1.md: a landing in the world, so its writer is known
  landed(w, 'board/B-1.md', '---\nowner: open\nstatus: open\n---\n# Cross-check part B against part A\n\nDone: both parts agree on the dates.\n', { name: 'Owner A', ref: 'aaaaaaa1' }, 1)
  for (let i = 0; i < 3; i++) await tick(w, 30000)
  const u = json(w, `${FLEET}/state/work.json`).unowned['B-1']
  expect(u.writer).toBe('Owner A')
  expect(u.offers[0].slug).not.toBe('owner-a')
})

// ---- Q2: the writer is the item's last landing: another instance's edit makes its real writer eligible ----

test('an item Owner A wrote and Owner B then edited keeps Owner A as its writer: never offered to it', WITH_SESSIONS, async ($, on) => {
  const TWO = { ...SOLO_ROSTER, instances: SOLO_ROSTER.instances.slice(0, 2) }
  const w = world(on, {
    background: false,
    files: { [`${FLEET}/roster.json`]: JSON.stringify(TWO), [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**', 'board/**'] }), [`${ROOT}/.claude/agents/owner.md`]: OWNER },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle'), bbbbbbb1: row('bbbbbbb1', 'Owner B', 'idle') } })
  await startSession($, w)
  await tick(w, 30000)
  const v1 = '---\nowner: open\nstatus: open\n---\n# Cross-check part B against part A\n'
  landed(w, 'board/B-1.md', v1, { name: 'Owner A', ref: 'aaaaaaa1' }, 1)
  for (let i = 0; i < 2; i++) await tick(w, 30000)
  const first = json(w, `${FLEET}/state/work.json`).unowned['B-1']
  expect(first.offers.map((o: any) => o.slug)).toEqual(['owner-b'])
  // Owner B, offered it, adds a line to it (what it found) and leaves it open
  landed(w, 'board/B-1.md', `${v1}\nOwner B: part B's dates are in notes/b/dates.md.\n`, { name: 'Owner B', ref: 'bbbbbbb1' }, 2, hashText(v1))
  for (let i = 0; i < 4; i++) await tick(w, 30000)
  const u = json(w, `${FLEET}/state/work.json`).unowned['B-1']
  expect(u.writer).toBe('Owner A')
  expect(u.offers.map((o: any) => o.slug)).not.toContain('owner-a')
})

// ---- Q4: after ONE no-response the heartbeat says fleet asked for the roster model and the account fell back ----

test('one no-response to the roster model, the last step of a turn: status blames nobody, its next request asks again', WITH_SESSIONS, async ($, on) => {
  let failing = 1
  const w = world(on, {
    worldPaths: ['notes/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: {
      [`${FLEET}/roster.json`]: JSON.stringify({ rosterFormat: 1, sections: [{ id: 'owners', title: 'Owners' }], roles: { owner: { agent: 'owner', model: 'claude-opus-5-5', budget: { usdDay: 1 } } }, instances: [{ name: 'Owner A', role: 'owner', section: 'owners' }] }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/instances/owner-a.json`]: '{}\n',
    },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  on('turn.step', async function* (_$: any, e: any) {
    if (e.model === 'claude-opus-5-5' && failing > 0) {
      failing--
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: e.model } }
  } as any)
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  await startSession($, w)
  await step($, 'claude-haiku-5-5')
  await tick(w, 31000)
  const hb = json(w, `${HB}/state.json`)
  const status = await fleet($, 'status')
  expect(hb.asked).toBe('claude-haiku-5-5')
  expect(status).toContain('runs claude-haiku-5-5, roster says claude-opus-5-5 (its next request asks for claude-opus-5-5)')
})

// ---- Q6: a lint error that doesn't start with the instance's name: settings rewritten, restart asked ----

function roster(role: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ rosterFormat: 1, sections: [{ id: 'owners', title: 'Owners' }], roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 }, ...role } }, instances: [{ name: 'Owner A', role: 'owner', section: 'owners' }], budget: { usdDay: 5 }, ...extra })
}

function beat(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'aaaaaaa1', sessionId: 'aaaaaaa1-0000-0000-0000-000000000000', at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: NOW - 3 * HOUR, lastLanding: NOW - 600000, ...extra })
}

function coreHash(text: string): string {
  const { model: _m, effortLevel: _e, ...rest } = JSON.parse(text)
  return hashText(settingsText(rest))
}

test("a roster change /fleet up refuses with an error not prefixed by the instance's name (no role file for its new role): not applied, no restart", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${HB}/state.json`]: beat() } })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  await fleet($, 'accept roster.json')
  const first = w.files.get(`${FLEET}/instances/owner-a.json`) as string
  w.touch(`${HB}/state.json`, beat({ settingsHash: coreHash(first) }))
  // Owner A moves to a new role whose role file nobody wrote yet
  const next = JSON.parse(roster({}))
  next.roles.tester = { agent: 'tester', model: 'haiku' }
  next.instances[0].role = 'tester'
  w.touch(`${FLEET}/roster.json`, JSON.stringify(next))
  const up = await fleet($, 'up --dry-run')
  expect(up).toContain('✗ no role file .claude/agents/tester.md (the role of Owner A)')
  const accepted = await fleet($, 'accept roster.json')
  expect(accepted).toContain('not applied to Owner A: no role file .claude/agents/tester.md (the role of Owner A)')
  expect(JSON.parse(w.files.get(`${FLEET}/instances/owner-a.json`) as string).env.FLEET_ROLE).toBe('owner')
  expect(w.files.has(`${HB}/restart.json`)).toBe(false)
})

test('the reason for an error that names the instance in another form is said whole', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${HB}/state.json`]: beat() } })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  await fleet($, 'accept roster.json')
  const next = JSON.parse(roster({ model: 'sonnet' }))
  next.instances[0].parent = 'Owner A'
  w.touch(`${FLEET}/roster.json`, JSON.stringify(next))
  const accepted = await fleet($, 'accept roster.json')
  expect(accepted).toContain('not applied to Owner A: "Owner A" is its own parent')
})

// ---- Q7: "not applied" while the roster's new model reaches the instance at its next request anyway ----

test('a roster entry with a lint error: the reply says it is not applied, and its model and effort are left alone until it is fixed', WITH_SESSIONS, async ($, on) => {
  const received: { model: string; effort?: unknown }[] = []
  const w = world(on, {
    worldPaths: ['notes/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: { [`${FLEET}/roster.json`]: roster({ model: 'claude-haiku-5-5' }), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/owner-a.json`]: '{}\n' },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  on('turn.step', async function* (_$: any, e: any) {
    received.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: e.model } }
  } as any)
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  await startSession($, w)
  await step($, 'claude-haiku-5-5', { effort: 'medium' })
  // The person moves Owner A to opus, with an effort typo
  w.touch(`${FLEET}/roster.json`, roster({ model: 'claude-opus-5-5', effort: 'hihg' }))
  const accepted = await fleet($, 'accept roster.json')
  expect(accepted).toContain('not applied to Owner A: effort "hihg" isn\'t a level')
  await tick(w, 31000)
  received.length = 0
  await step($, 'claude-haiku-5-5', { effort: 'medium' })
  expect(received[0]?.model).toBe('claude-haiku-5-5')
  expect(accepted).toContain('its model and effort stay as they were too')
})

// ---- Q8: status says an item with no for: in a roster with no front door is "for the front door" ----

test('/fleet status says an item with no for: in a roster with no front door is for anyone but its writer', WITH_SESSIONS, async ($, on) => {
  const TWO = { ...SOLO_ROSTER, instances: SOLO_ROSTER.instances.slice(0, 2) }
  const w = world(on, {
    background: false,
    files: { [`${FLEET}/roster.json`]: JSON.stringify(TWO), [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**', 'board/**'] }), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${ROOT}/board/B-1.md`]: '---\nowner: open\nstatus: open\n---\n# Cross-check\n' },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'busy'), bbbbbbb1: row('bbbbbbb1', 'Owner B', 'busy') } })
  await startSession($, w)
  for (let i = 0; i < 3; i++) await tick(w, 30000)
  const status = await fleet($, 'status')
  expect(status).toContain('B-1: open, nobody owns it (for anyone but its writer)')
})


test("the sweeper doesn't list the events folders at every sweep while nothing lands", WITH_SESSIONS, async ($, on) => {
  const TWO = { rosterFormat: 1, sections: [{ id: 'owners', title: 'Owners' }], roles: { owner: { agent: 'owner', model: 'sonnet' } }, instances: [{ name: 'Owner A', role: 'owner', section: 'owners' }, { name: 'Owner B', role: 'owner', section: 'owners' }] }
  const w = world(on, {
    background: false,
    files: { [`${FLEET}/roster.json`]: JSON.stringify(TWO), [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**', 'board/**'] }), [`${ROOT}/.claude/agents/owner.md`]: OWNER },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'busy'), bbbbbbb1: row('bbbbbbb1', 'Owner B', 'busy') } })
  await startSession($, w)
  for (let i = 0; i < 4; i++) await tick(w, 30000)
  const before = w.lists.length
  for (let i = 0; i < 20; i++) await tick(w, 30000)
  const ev = w.lists.slice(before).filter(p => p.startsWith(`${FLEET}/events/`))
  expect(ev.length).toBeLessThanOrEqual(2)
})
