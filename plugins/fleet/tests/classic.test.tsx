import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { FAKE_SESSIONS, FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// What a managed plugin that sends the classic hooks on past the plugins a person installed (next.to beneath their
// tier) takes from fleet, and what stands in for it; a read-only command during another session's write; an
// organisation's ceiling `ask` on a connector tool

const SKIPPER = {
  name: 'skipper',
  tier: 'prepend' as const,
  register(on: any) {
    on('classic.SessionStart', ($: any, e: any, next: any) => next.to(e, 'builtin'))
    on('classic.PostToolUse', ($: any, e: any, next: any) => next.to(e, 'builtin'))
    on('classic.PermissionRequest', ($: any, e: any, next: any) => next.to(e, 'builtin'))
  },
}

const HB = `${FLEET}/instances/owner-a`
const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, AskUserQuestion, SendMessage, mcp__fleet__*\n---\nYou own a part of the notes.\n'
const ROSTER = JSON.stringify({ rosterFormat: 1, sections: [{ id: 'owners', title: 'Owners' }], roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 } } }, instances: [{ name: 'Owner A', role: 'owner', section: 'owners', brief: 'You own notes/a.' }], settings: { permissions: { defaultMode: 'auto', allow: ['mcp__claude_ai_Office__send_chat_message'] } } })
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

async function instance($: any, on: any, before: (on: any) => void = () => {}): Promise<World> {
  const w = world(on, { worldPaths: ['notes/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' }, files: { [`${FLEET}/roster.json`]: ROSTER, [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/owner-a.json`]: '{}\n' } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  before(on)
  await startSession($, w)
  return w
}

test('a managed plugin sends classic.SessionStart on past fleet: the instance hears who it is from fleet’s own prompt, again after /clear, and status says so', { plugins: [SKIPPER, FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const w = await instance($, on)
  // The hook didn't reach fleet: no context of its
  const ctx: any = await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  expect(ctx.additionalContext).toBe(undefined)
  await tick(w)
  // The seed carries who it is, first
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toMatch(/^fleet: this session is Owner A, the owner of this project's roster/)
  expect(w.submits[0]).toContain('Your budget is $1.00 a day')
  expect(w.submits[0]).toContain('You are Owner A, the owner of this project')
  await $.turn.start({ text: w.submits[0], turnId: 't-1' } as any)
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't-1', reason: 'answer' } as any)
  // Told: a prompt of anyone's doesn't carry it again
  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as any)
  expect(w.prompts.at(-1)?.context.join('\n') ?? '').not.toContain('fleet: this session is Owner A')
  // A /clear: the next prompt carries it
  await $.session.end({ reason: 'clear', sessionId: SID } as any)
  await $.prompt.submit({ text: 'and now?', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as any)
  expect(w.prompts.at(-1)?.context.join('\n')).toContain('fleet: this session is Owner A')
  await tick(w, 1100)
  expect(json(w, `${HB}/state.json`)).toMatchObject({ classicStart: false })
  expect(await fleet($, 'status')).toContain("classic hooks: SessionStart didn't reach fleet in this session")
})

test('with nothing in the way, classic.SessionStart tells it, and fleet’s own prompts don’t say it twice', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  const ctx: any = await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  expect(ctx.additionalContext.join('\n')).toContain('fleet: this session is Owner A')
  await tick(w)
  expect(w.submits[0]).toMatch(/^You are Owner A/)
  expect(await fleet($, 'status')).toContain('classic hooks reaching fleet here: SessionStart')
})

test('a compaction the classic hook doesn’t reach fleet for: fleet puts who it is in the compacted conversation', { plugins: [SKIPPER, FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const w = await instance($, on, o => o('session.compact', () => ({ messages: [{ role: 'user', text: 'the summary', toolUses: [] }] })))
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  await tick(w)
  const r: any = await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'a long talk', toolUses: [] }] } as any)
  expect(r.messages[0].text).toContain('fleet: this session is Owner A')
  expect(r.messages[1].text).toBe('the summary')
})

test('a permission prompt found by the verdict (tool.check), an organisation’s ceiling above all: the heartbeat says so, a call settles it', { plugins: [SKIPPER, FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const w = await instance($, on, o => {
    o('tool.check', () => ({ decision: 'ask' }))
    o('tool.call', () => ({ result: 'ok' }))
  })
  await tick(w)
  await $.tool.check({ tool: 'mcp__claude_ai_Office__send_chat_message', input: {}, tool_use_id: 'u1', approver: 'person', ceiling: 'ask' } as any)
  await tick(w, 1100)
  expect(json(w, `${HB}/state.json`)).toMatchObject({ waitingOn: { kind: 'permission', tool: 'mcp__claude_ai_Office__send_chat_message' }, orgAsk: ['mcp__claude_ai_Office__send_chat_message'] })
  await $.tool.call({ tool: 'mcp__claude_ai_Office__read_resource', uri: 'x' } as any)
  await tick(w, 1100)
  expect(json(w, `${HB}/state.json`).waitingOn).toBe(null)
})

test('in auto mode a plain ask goes to its classifier, not to the person: no permission prompt is marked', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, o => {
    o('tool.check', () => ({ decision: 'ask' }))
  })
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner', permission_mode: 'auto' } as any)
  await tick(w)
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u2', approver: 'person' } as any)
  await tick(w, 1100)
  expect(json(w, `${HB}/state.json`).waitingOn).toBe(null)
})

test('the dry run warns of an instance that waits for the person on every call to a tool its organisation keeps at ask', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, files: { [`${FLEET}/roster.json`]: ROSTER, [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${HB}/state.json`]: JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'cccccccc', sessionId: 's', at: 0, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: null, orgAsk: ['mcp__claude_ai_Office__send_chat_message'] }) } })
  await startSession($, w)
  const out = await fleet($, 'up --dry-run')
  expect(out).toContain('Owner A: your organisation keeps mcp__claude_ai_Office__send_chat_message at "ask", so this instance waits for you on every call to it')
})

// A read-only command while another session's write lands, before that session's event is published (B5)
const PLAN = `${ROOT}/notes/plan.md`
const B = { sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', agentId: null, ref: 'bbbbbbbb', name: 'TEST B' }

test('a command with no write syntax is never blamed for another session’s write that landed while it ran', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null } })
  await startSession($, w)
  await tick(w, 1100)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  // TEST B's edit before: its event is there
  const at = w.clock.now()
  w.touch(PLAN, 'plan v2 from B\n')
  w.touch(`${FLEET}/events/${hourFolder(at)}/${at}-bbbbbbbb-1.json`, JSON.stringify({ format: 1, at, path: 'notes/plan.md', from: hashText('plan v1\n'), to: hashText('plan v2 from B\n'), via: 'tool', tool: 'Edit', blind: false, by: B }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: `${at}-bbbbbbbb-1.json` }))
  await tick(w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  // Its next edit lands while this session's grep runs, before its event is out
  w.bash.value = () => w.touch(PLAN, 'plan v3 from B\n')
  const r: any = await $.tool.call({ tool: 'Bash', command: 'grep -n plan notes/plan.md | wc -l' } as any)
  const said = (r.context ?? []).join('\n')
  expect(said).not.toContain('your command changed')
  expect(said).toContain("fleet: notes/plan.md changed while your command ran (it changed at")
  expect(said).toContain("your command didn't change it. If your command read it, read it again.")
  const mine = [...w.files.keys()].filter(p => p.startsWith(`${FLEET}/events/`) && p.endsWith('.json') && !p.endsWith('latest')).map(p => JSON.parse(w.files.get(p) as string)).filter(e => e.by?.sessionId === SID)
  expect(mine).toEqual([])
})
