import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { FAKE_LOG, FAKE_SESSIONS, FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World } from './world'
import { OWNER } from './up.test'

// An instance's cadence (a mark and one nudge when nothing landed in a period), its fresh periods (/clear and its
// journal handed to the next conversation), and /fleet brief

const WITH_SESSIONS = { plugins: [FAKE_SESSIONS] }
const HB = `${FLEET}/instances/owner-a`
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }
const HOUR = 3600000

function roster(role: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    rosterFormat: 1,
    sections: [{ id: 'owners', title: 'Owners' }],
    roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 }, ...role } },
    instances: [
      { name: 'Owner A', role: 'owner', section: 'owners' },
      { name: 'Owner C', role: 'owner', section: 'owners' },
    ],
    budget: { usdDay: 5 },
    ...extra,
  })
}

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

function calls(w: World, kind: string): any[] {
  return (w.files.get(FAKE_LOG) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(c => c[kind])
    .map(c => c[kind])
}

async function instance($: any, on: any, role: Record<string, unknown>) {
  const w = world(on, {
    worldPaths: ['notes/**', 'journals/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: { [`${FLEET}/roster.json`]: roster(role, { wakes: { everyMin: 5, perDay: 8 } }), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/seeds/owner.md`]: 'Plan your part.', [`${FLEET}/instances/owner-a.json`]: '{}\n' },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  await startSession($, w)
  return w
}

test('nothing landed in its cadence period: one nudge from its own fleet, never a second for that period', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, { cadenceH: 0.25, context: 'long' })
  await tick(w)
  expect(w.submits.length).toBe(1)
  const ctx: any = await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  expect(ctx.additionalContext.join('\n')).toContain('Keep your journal at journals/owner-a.md: what you did, what you found (a negative result too), where you stopped. Land something every 15 min (in the shared files, or your journal).')
  expect(ctx.additionalContext.join('\n')).toContain('draft it with mcp__fleet__send')
  await tick(w, 8 * 60000)
  expect(w.submits.length).toBe(1)
  await tick(w, 8 * 60000)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toBe("fleet: 15 min since you last landed anything in the shared world (your cadence is 15 min). Land what you have: a result, a negative result, or where you're blocked and why, in your journal (journals/owner-a.md) and where your work goes; or ask the person with mcp__fleet__decide. This is fleet's one nudge for this period.")
  expect(json(w, `${HB}/nudges.json`)).toMatchObject({ format: 1, count: 1 })
  await tick(w, 20 * 60000)
  expect(w.submits.length).toBe(2)
  // It lands its journal (a negative result counts): the next period counts from there
  const r: any = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/journals/owner-a.md`, content: 'result: nothing found in the first source\n' } as any)
  expect(r.deny).toBe(undefined)
  await tick(w, 30100)
  expect(json(w, `${HB}/state.json`)).toMatchObject({ cadenceH: 0.25, context: 'long', journal: 'journals/owner-a.md' })
  expect(json(w, `${HB}/state.json`).lastLanding).toBeGreaterThan(Date.UTC(2026, 10, 2, 12, 30, 0))
  await tick(w, 16 * 60000)
  expect(w.submits.length).toBe(3)
  expect(w.submits[2]).toContain('since you last landed anything')
})

test('a fresh period: a period-old conversation, idle, its journal written: fleet clears it and hands it the journal', WITH_SESSIONS, async ($, on) => {
  const cleared: string[] = []
  on('command.run', { command: 'clear' }, (_, e) => {
    cleared.push(String(e.origin?.kind))
    return { text: '' }
  })
  const w = await instance($, on, { cadenceH: 1 })
  await tick(w)
  expect(w.submits.length).toBe(1)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/journals/owner-a.md`, content: '# Owner A\n\n- read the charter\n- result: plan in notes/a.md\n- next: the second part\n' } as any)
  await tick(w, 30 * 60000)
  expect(cleared).toEqual([])
  await tick(w, 31 * 60000)
  expect(cleared).toEqual(['plugin'])
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toContain(`You are Owner A, the owner of this project's fleet (the project folder is ${ROOT}). This is a fresh period: fleet cleared your context after 1 h, as it does every period, and hands you your journal (journals/owner-a.md) to go on from.`)
  expect(w.submits[1]).toContain('Your journal:\n\n# Owner A\n\n- read the charter\n- result: plan in notes/a.md\n- next: the second part')
  expect(w.logs.some(l => l.includes('fresh period for Owner A: /clear, then its journal (journals/owner-a.md)'))).toBe(true)
  // The engine's /clear: a new conversation in this process; nothing more until its own period is up
  w.id.value = 'cccccccc-0000-0000-0000-000000000000'
  await $.session.end({ reason: 'clear', sessionId: SID } as any)
  await w.clock.settle()
  await tick(w, 10 * 60000)
  expect(cleared.length).toBe(1)
})

test('a role that keeps a long context is never cleared; one without a journal written this period is nudged instead', WITH_SESSIONS, async ($, on) => {
  const cleared: string[] = []
  on('command.run', { command: 'clear' }, () => (cleared.push('x'), { text: '' }))
  const w = await instance($, on, { cadenceH: 1 })
  await tick(w, 62 * 60000)
  expect(cleared).toEqual([])
  expect(w.submits[w.submits.length - 1]).toContain('since you last landed anything')
})

test('the sweeper marks an instance quiet past its cadence and wakes a retired one once for it', WITH_SESSIONS, async ($, on) => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  const beat = (name: string, slug: string, ref: string, at: number) => JSON.stringify({ format: 1, instance: name, slug, ref, sessionId: `${ref}-sid`, at, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: now - 3 * HOUR, lastLanding: null })
  const w = world(on, {
    background: false,
    worldPaths: ['notes/**'],
    files: {
      [`${FLEET}/roster.json`]: roster({ cadenceH: 2 }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/instances/owner-a/state.json`]: beat('Owner A', 'owner-a', 'aaaaaaa1', now),
      [`${FLEET}/instances/owner-c/state.json`]: beat('Owner C', 'owner-c', 'ccccccc1', now - HOUR),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle'), ccccccc1: row('ccccccc1', 'Owner C', 'stopped') } })
  await startSession($, w)
  // Owner A's fleet beats every 30 s, as a running instance's does
  const run = async (n: number) => {
    for (let i = 0; i < n; i++) {
      w.touch(`${FLEET}/instances/owner-a/state.json`, beat('Owner A', 'owner-a', 'aaaaaaa1', w.clock.now()))
      await tick(w, 30000)
    }
  }
  await run(8)
  const marks = calls(w, 'setMarks')
  expect(marks.length).toBeGreaterThan(0)
  expect(marks[marks.length - 1].rows.aaaaaaa1).toEqual({ badge: '◷', tint: 'warning', line: 'nothing landed in 3 h (its cadence is 2 h)' })
  expect(calls(w, 'wake')).toEqual([{ ref: 'ccccccc1', reason: 'fleet: nothing landed in its cadence period' }])
  await run(8)
  expect(calls(w, 'wake').length).toBe(1)
  const brief = await fleet($, 'brief')
  expect(brief).toContain('   - Owner A: nothing landed in 3 h (its cadence is 2 h)')
})

test('/fleet brief: what needs you, what changed and who changed it, what’s blocked, the spend, the inputs and ideas', WITH_SESSIONS, async ($, on) => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  const asker = { ref: 'bbbbbbb1', sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', name: 'Owner B', root: ROOT }
  const q = (id: string, extra: Record<string, unknown>) => JSON.stringify({ format: 1, fleet: '0.4.0', id, at: now - 2 * HOUR, asker, questions: [], ...extra })
  const ev = (path: string, at: number, by: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ format: 1, at, path, from: null, to: hashText(path), via: by ? 'tool' : 'outside', tool: 'Write', blind: !by, by, ...extra })
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**', 'req/**', 'proposals/**'], command: ['req/**'], proposal: ['proposals/**'] }),
      [`${FLEET}/roster.json`]: roster({}),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/instances/owner-a/spend.json`]: JSON.stringify({ format: 1, slug: 'owner-a', day: '2026-11-02', usd: 0.9, sessionId: 's', last: 0.9, at: now }),
      [`${FLEET}/decisions/queue/D-1.json`]: q('D-1', { questions: [{ question: 'Which store?', options: [{ label: 'A' }, { label: 'B' }], recommended: 'A', why: 'w' }], blocks: 'the cache layer' }),
      [`${FLEET}/decisions/queue/D-2.json`]: q('D-2', { kind: 'change', change: { path: 'req/R-1.md', summary: 'the target is 8', base: null, result: 'h1', draft: 'decisions/drafts/D-2.md', diff: 'decisions/drafts/D-2.diff', added: 1, removed: 0 }, outside: { at: now - 3 * HOUR, what: 'WebFetch of example.invalid' } }),
      [`${FLEET}/decisions/queue/D-3.json`]: q('D-3', { kind: 'resource', resource: { what: 'a license', why: 'the runs' } }),
      [`${FLEET}/decisions/queue/D-4.json`]: q('D-4', { kind: 'outbound', outbound: { to: 'example.invalid', why: 'w', what: 'curl sending data', how: 'command', draft: 'decisions/drafts/D-4.json', files: [], cwd: ROOT, hash: 'h2' } }),
      [`${ROOT}/req/R-1.md`]: 'R-1\n',
      [`${ROOT}/notes/a.md`]: 'a\n',
      [`${ROOT}/proposals/P-1.md`]: 'P-1\n',
      [`${FLEET}/events/${hourFolder(now - HOUR)}/${now - HOUR}-bbbbbbbb-1.json`]: ev('notes/a.md', now - HOUR, { sessionId: asker.sessionId, agentId: null, ref: asker.ref, name: 'Owner B' }, { outside: true }),
      [`${FLEET}/events/${hourFolder(now - 2 * HOUR)}/${now - 2 * HOUR}-bbbbbbbb-2.json`]: ev('req/R-1.md', now - 2 * HOUR, { sessionId: null, agentId: null, ref: null, name: null, person: true }, { via: 'answer' }),
      [`${FLEET}/events/${hourFolder(now - 3 * HOUR)}/${now - 3 * HOUR}-bbbbbbbb-3.json`]: ev('proposals/P-1.md', now - 3 * HOUR, { sessionId: asker.sessionId, agentId: null, ref: asker.ref, name: 'Owner B' }),
      [`${FLEET}/events/${hourFolder(now - 30 * HOUR)}/${now - 30 * HOUR}-bbbbbbbb-4.json`]: ev('notes/old.md', now - 30 * HOUR, null),
    },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 43 }], cost: { usd: 0 } } }))
  sessionsSay(w, { rows: { bbbbbbb1: row('bbbbbbb1', 'Owner B', 'idle') } })
  await startSession($, w)
  await tick(w)
  const b = await fleet($, 'brief')
  expect(b).toContain('Brief · 2026-11-02 ')
  expect(b).toContain('1. Needs you: 1 question, 1 change, 1 resource, 1 outbound draft (/fleet lists them to answer)')
  expect(b).toContain('   - D-1 question: Which store? · Owner B · 2h ago · blocks: the cache layer')
  expect(b).toContain('   - D-2 change: req/R-1.md, "the target is 8" · Owner B · 2h ago · drafted after reading outside content (WebFetch of example.invalid at ')
  expect(b).toContain('   - D-3 resource: a license · Owner B')
  expect(b).toContain('   - D-4 outbound: curl sending data to example.invalid · Owner B')
  expect(b).toContain('2. What changed: 2 shared files')
  expect(b).toContain('   - req/R-1.md (command): changed at ')
  expect(b).toContain('by the person (a change applied by fleet)')
  expect(b).toContain('   - notes/a.md (its writer had read outside content): changed at ')
  expect(b).not.toContain('notes/old.md')
  expect(b).toContain('3. Blocked and stale:\n   - D-1 (Owner B, 2h) holds up: the cache layer')
  expect(b).toContain("4. Spend: $0.90 today of $5.00 (the project's cap), estimated at list price; budgets $2.00 a day, wakes ~$0.08 a day; this account's windows: 7d 43%")
  expect(b).toContain('   - Owner A: $0.90 of $1.00, past 80%')
  expect(b).toContain('5. Inputs and ideas: 1\n   - proposals/P-1.md (proposal): changed at ')
  // The chief's lines come only with --chief, typed by the person, and only when the roster has one
  expect(await fleet($, 'brief --chief')).toContain("The roster has no chief: the brief above is fleet's own.")
  expect(await fleet($, 'brief --chief', { kind: 'plugin', name: 'other' })).toContain("Only the person asks for the chief's lines")
})

test('/fleet brief --chief: one model call with the chief’s role file and the charter, at most five lines', WITH_SESSIONS, async ($, on) => {
  const asked: any[] = []
  on('model.complete', (_, e) => {
    asked.push(e)
    return { value: { isAnswered: true, text: 'Apply D-2 first.\n\nThe cache waits on D-1.\n3\n4\n5\n6', usage: { inputTokens: 1, outputTokens: 1 } } as any }
  })
  const w = world(on, {
    background: false,
    worldPaths: ['notes/**'],
    files: {
      [`${FLEET}/roster.json`]: JSON.stringify({ rosterFormat: 1, roles: { chief: { agent: 'chief', model: 'haiku' } }, instances: [{ name: 'Chief', role: 'chief' }] }),
      [`${ROOT}/.claude/agents/chief.md`]: '---\nname: chief\ntools: Read, mcp__fleet__*\n---\nYou are the chief.\n',
      [`${FLEET}/charter.md`]: '# Charter\n\nThe goal.\n',
    },
  })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  const b = await fleet($, 'brief --chief')
  expect(b).toContain("The chief's notes:\n   Apply D-2 first.\n   The cache waits on D-1.\n   3\n   4\n   5")
  expect(b).not.toContain('   6')
  expect(asked.length).toBe(1)
  expect(asked[0]).toMatchObject({ model: 'haiku', system: 'You are the chief.', maxTokens: 600 })
  expect(String(asked[0].prompt)).toContain('The goal.')
})
