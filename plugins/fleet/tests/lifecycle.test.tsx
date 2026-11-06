import { expect, test } from 'claude-code/testing'

import { hashText } from '../hooks/changes'
import { settingsText } from '../hooks/roster'
import { FLEET, ROOT, decide, fleet, json, row, sessionsSay, startSession, world, WITH_SESSIONS } from './world'

// An instance's lifecycle as the roster changes it (P26): an applied or accepted roster change takes effect by
// itself, the restart when idle for the settings a restart carries, the next request for a model or an effort

const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, mcp__fleet__*\n---\nYou own a part of the notes.\n'
const HB = `${FLEET}/instances/owner-a`
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const HOUR = 3600000

function roster(role: Record<string, unknown>) {
  return JSON.stringify({
    rosterFormat: 1,
    sections: [{ id: 'owners', title: 'Owners' }],
    roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 }, ...role } },
    instances: [
      { name: 'Owner A', role: 'owner', section: 'owners' },
      { name: 'Owner C', role: 'owner', section: 'owners' },
    ],
    budget: { usdDay: 5 },
  })
}

function beat(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'aaaaaaa1', sessionId: 'aaaaaaa1-0000-0000-0000-000000000000', at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: NOW - 3 * HOUR, lastLanding: NOW - 600000, ...extra })
}

// The hash an instance keeps of its settings file: without its model and effort (they reach it at its next request)
function coreHash(text: string): string {
  const { model: _m, effortLevel: _e, ...rest } = JSON.parse(text)
  return hashText(settingsText(rest))
}

test('an accepted roster.json takes effect by itself: settings a restart carries restart the instance once idle, a model alone reaches it at its next request', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${HB}/state.json`]: beat() },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  // Its settings file as the running instance started with it
  await fleet($, 'accept roster.json')
  const first = w.files.get(`${FLEET}/instances/owner-a.json`) as string
  expect(JSON.parse(first).model).toBe('haiku')
  w.touch(`${HB}/state.json`, beat({ settingsHash: coreHash(first) }))
  // A model change alone: the file is rewritten, nothing restarts
  w.touch(`${FLEET}/roster.json`, roster({ model: 'sonnet' }))
  const model = await fleet($, 'accept roster.json')
  expect(JSON.parse(w.files.get(`${FLEET}/instances/owner-a.json`) as string).model).toBe('sonnet')
  expect(w.files.has(`${HB}/restart.json`)).toBe(false)
  expect(model).toContain('Owner A: model sonnet at its next request (no restart)')
  // A change a restart carries (its env): it restarts once idle, with nothing for the person to do
  w.touch(`${FLEET}/roster.json`, roster({ model: 'sonnet', settings: { env: { NOTES_MODE: 'draft' } } }))
  const env = await fleet($, 'accept roster.json')
  expect(json(w, `${HB}/restart.json`)).toMatchObject({ format: 1 })
  expect(env).toContain('Owner A: restarts with its new settings once idle (nothing in flight)')
  expect(JSON.parse(w.files.get(`${FLEET}/instances/owner-a.json`) as string).env.NOTES_MODE).toBe('draft')
})

test('an applied change to roster.json takes effect by itself too, and the apply says what it did to each instance', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: { [`${FLEET}/roster.json`]: roster({}), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${HB}/state.json`]: beat() },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  await fleet($, 'accept roster.json')
  const first = w.files.get(`${FLEET}/instances/owner-a.json`) as string
  w.touch(`${HB}/state.json`, beat({ settingsHash: coreHash(first) }))
  expect((await decide($, { kind: 'change', path: '.claude/fleet/roster.json', summary: 'owners on sonnet at high', content: roster({ model: 'sonnet', effort: 'high' }) })).result).toContain('Queued as D-1')
  const applied = await fleet($, '1 apply')
  expect(applied).toContain('1: applied D-1: fleet wrote .claude/fleet/roster.json as drafted')
  expect(applied).toContain('It takes effect now:')
  expect(applied).toContain('Owner A: model sonnet, effort high at its next request (no restart)')
  expect(applied).not.toContain('takes effect at the next /fleet up')
  const s = JSON.parse(w.files.get(`${FLEET}/instances/owner-a.json`) as string)
  expect([s.model, s.effortLevel]).toEqual(['sonnet', 'high'])
  expect(w.files.has(`${HB}/restart.json`)).toBe(false)
})
