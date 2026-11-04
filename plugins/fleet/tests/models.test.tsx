import { expect, test } from 'claude-code/testing'

import { parseCommand } from '../hooks/decisions'
import { FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// An instance's real model (B4), today's date in what fleet tells it (G5), a local install record of fleet (#16),
// /fleet status --all (G9)

const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, AskUserQuestion, SendMessage, mcp__fleet__*\n---\nYou own a part of the notes.\n'
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

async function instance($: any, on: any, model: string, role: Record<string, unknown> = {}) {
  const w = world(on, {
    worldPaths: ['notes/**', 'journals/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: {
      [`${FLEET}/roster.json`]: JSON.stringify({ rosterFormat: 1, sections: [{ id: 'owners', title: 'Owners' }], roles: { owner: { agent: 'owner', model, budget: { usdDay: 1 }, ...role } }, instances: [{ name: 'Owner A', role: 'owner', section: 'owners' }] }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/seeds/owner.md`]: 'Plan your part.',
      [`${FLEET}/instances/owner-a.json`]: '{}\n',
    },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  // Beneath fleet: the model's answer to a step (usage.model: the model that answered, when a test sets one)
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage: answeredBy.value ? { model: answeredBy.value } : null }
  } as any)
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  await startSession($, w)
  return w
}

// The model the API reports as having answered, when it isn't the one the request named
const answeredBy: { value: string | null } = { value: null }

async function step($: any, model: string) {
  const s = $.turn.step({ turnId: 't-1', index: 0, model, messageCount: 1 })
  for await (const _ of s) {
  }
  return s.result
}

test('a roster model the account lacks falls back: the heartbeat says what really runs, and status says it differs', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, 'fable')
  await step($, 'claude-sonnet-5-5')
  await tick(w, 31000)
  expect(json(w, `${FLEET}/instances/owner-a/state.json`).model).toBe('claude-sonnet-5-5')
  const status = await fleet($, 'status')
  expect(status).toContain('runs claude-sonnet-5-5, roster says fable (a model the account lacks falls back)')
})

test('the model the roster names, as an alias, is the same as the id it runs: status says only what runs', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, 'opus')
  await step($, 'claude-opus-5-5')
  await tick(w, 31000)
  const status = await fleet($, 'status')
  expect(status).toContain('runs claude-opus-5-5')
  expect(status).not.toContain('roster says')
})

test("the seed and the context carry today's date, so a long conversation doesn't date files by the hours it ran", WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, 'haiku')
  await tick(w, 6000)
  expect(w.submits.some(t => t.includes('You are Owner A') && /Today is \d{4}-\d{2}-\d{2} here \(\d{2}:\d{2}, UTC[+-]\d{2}:\d{2}\); in UTC it is \d{4}-\d{2}-\d{2}/.test(t))).toBe(true)
  const ctx: any = await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  expect(ctx.additionalContext.join('\n')).toMatch(/This conversation started on \d{4}-\d{2}-\d{2} here \(UTC[+-]\d{2}:\d{2}\); fleet's messages carry today's date/)
})

test("a nudge carries today's date too", WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, 'haiku', { cadenceH: 0.25, context: 'long' })
  for (let k = 0; k < 40 && !w.submits.some(t => t.includes('since you last landed')); k++) await tick(w, 60000)
  const nudge = w.submits.find(t => t.includes('since you last landed'))
  expect(nudge).toMatch(/\n\nToday is \d{4}-\d{2}-\d{2} here \(\d{2}:\d{2}, UTC[+-]\d{2}:\d{2}\); in UTC it is /)
})

test('a local install record of fleet at another version than the user scope one is named, with the command that updates it', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { fleet: false, background: false, env: { FLEET_CLAUDE: '/opt/x/claude' } })
  w.exec.value = argv => {
    if (argv[0] !== '/opt/x/claude') return undefined
    if (argv.slice(1).join(' ') === 'plugin list --json')
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { id: 'fleet@m', version: '0.8.2', scope: 'user', enabled: false },
          { id: 'fleet@m', version: '0.8.1', scope: 'local', enabled: true, projectPath: ROOT },
        ]),
      }
    return undefined
  }
  await startSession($, w)
  await fleet($, 'init')
  const status = await fleet($, 'status')
  expect(status).toContain('plan B: fleet@m 0.8.1 is installed for this project alone (a local record, which a session started here can make), and your user scope has 0.8.2')
  expect(status).toContain('`claude plugin update fleet@m --scope local`')
  expect(await fleet($, 'up --dry-run')).toContain('fleet@m 0.8.1 is installed for this project alone')
})

test('/fleet status --all lists each file; anything else after status is refused with how to write it', () => {
  expect(parseCommand('status')).toEqual({ kind: 'status' })
  expect(parseCommand('status --all')).toEqual({ kind: 'status', all: true })
  expect(parseCommand('status everything')).toMatchObject({ kind: 'bad' })
})

test('the model that answered wins over the one the request named; an alias that picks for itself is never a fallback', WITH_SESSIONS, async ($, on) => {
  answeredBy.value = 'claude-sonnet-5-5'
  try {
    const w = await instance($, on, 'fable')
    // The request names the roster's model; the organisation's default answers it
    await step($, 'fable')
    await tick(w, 31000)
    expect(json(w, `${FLEET}/instances/owner-a/state.json`).model).toBe('claude-sonnet-5-5')
    expect(await fleet($, 'status')).toContain('runs claude-sonnet-5-5, roster says fable (a model the account lacks falls back)')
  } finally {
    answeredBy.value = null
  }
})

test("an instance whose turns end on an API error isn't shown as idle: status says its last turn failed, until one answers", WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, 'claude-nonexistent-1')
  await $.turn.start({ text: 'go', turnId: 't-9' } as any)
  await $.turn.complete({ answer: 'API Error: model not found', durationMs: 10, isAborted: false, turnId: 't-9', reason: 'error' } as any)
  await tick(w, 31000)
  expect(json(w, `${FLEET}/instances/owner-a/state.json`).failed).toMatchObject({ why: 'API Error: model not found' })
  expect(await fleet($, 'status')).toContain('last turn failed')
  await $.turn.start({ text: 'again', turnId: 't-10' } as any)
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't-10', reason: 'answer' } as any)
  await tick(w, 31000)
  expect(json(w, `${FLEET}/instances/owner-a/state.json`).failed).toBe(null)
})
