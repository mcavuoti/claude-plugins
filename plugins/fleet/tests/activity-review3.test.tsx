import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { settingsText } from '../hooks/roster'
import { FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// fleet 0.10's activity part after its second review (the long run: the front door three hours on): lint errors at accept and apply whatever their form, the front
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

// ---- Q5: once every tester was offered the item and none took it, the front door never hears they're idle ----

test('an item every tester was offered and none took: the front door still hears they are idle with nothing to take', { ...WITH_SESSIONS, timeoutMs: 90000 }, async ($, on) => {
  const TEAM = { rosterFormat: 1, sections: [{ id: 'work', title: 'Work' }], roles: { chief: { agent: 'owner', model: 'haiku' }, tester: { agent: 'owner', model: 'haiku' } }, instances: [{ name: 'Chief', role: 'chief', section: 'work' }, { name: 'Tester 1', role: 'tester', section: 'work' }, { name: 'Tester 2', role: 'tester', section: 'work' }], wakes: { everyMin: 5, perDay: 8 } }
  const w = world(on, {
    worldPaths: ['notes/**', 'board/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Chief', FLEET_ROLE: 'chief' },
    files: { [`${FLEET}/roster.json`]: JSON.stringify(TEAM), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/chief.json`]: '{"env":{}}\n', [`${ROOT}/notes/plan.md`]: '# plan\n', [`${ROOT}/board/B-5.md`]: '---\nowner: open\nstatus: open\nfor: tester\n---\n# Measure on the lab machine\n' },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: 'aaaaaaaa', sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Chief', root: ROOT, background: true, agent: 'owner' }, rows: { aaaaaaaa: row('aaaaaaaa', 'Chief', 'working'), ttttttt1: row('ttttttt1', 'Tester 1', 'idle'), ttttttt2: row('ttttttt2', 'Tester 2', 'idle') } })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  // Both testers are offered B-5 (30 min apart), neither takes it, and they stay idle; from the 60th minute it is
  // offered to nobody again (allOffered). What the Chief hears in hours 2 and 3, past that
  for (let i = 0; i < 13; i++) await tick(w, 300000)
  const work = json(w, `${FLEET}/state/work.json`)
  expect(work.unowned['B-5'].allOffered).toBeTruthy()
  expect(work.capacity.idle).toEqual(['Tester 1', 'Tester 2'])
  const submitted = w.submits.length
  const heard: string[] = []
  for (let h = 0; h < 2; h++) {
    for (let i = 0; i < 12; i++) await tick(w, 300000)
    heard.push(...(((await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/plan.md` } as any)).context ?? []) as string[]))
  }
  const later = [...w.submits.slice(submitted), ...heard].join('\n')
  expect(later).toContain('idle with no item to take: Tester 1, Tester 2')
})

