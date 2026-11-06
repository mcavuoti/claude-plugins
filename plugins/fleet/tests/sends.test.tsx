import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { postableSentences } from '../hooks/outbound'
import { FORMAT } from '../hooks/decisions'
import { DEC, FAKE_SESSIONS, FLEET, REF, ROOT, SID, decide, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// What /fleet n send does with an approved MCP draft, beyond its version: the call is the one shown (its input can't
// name another tool), shown in this session before it goes, checked against its source as it is when sent; a call
// still at the permission prompt, refused, or whose result was withheld after it ran isn't taken for sent or for not
// sent; fleet's own call carries nobody's answers and lets nobody else's call through. And what a hold line is

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

const POST = 'mcp__claude_ai_Office__send_chat_message'
const DRAFT = 'mcp__claude_ai_Office__create_draft'
const READY = `${ROOT}/notes/ready.md`
const SOURCED = JSON.stringify({ outboundFormat: 1, hosts: [], remotes: [], recipients: [], calls: [{ tool: POST, match: { chatId: '19:aaaa' }, source: 'notes/ready.md', body: 'content' }] })
const B = { sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', agentId: null, ref: 'bbbbbbbb', name: 'TEST B' }
const READY_POST = { to: 'the team chat', why: 'a ready post', mcp_tool: POST, input: { chatId: '19:aaaa', content: 'We can run both sizes this week.' } }

let n = 0
function landByB(w: World, path: string, text: string) {
  const before = w.files.get(path)
  w.touch(path, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${++n}.json`
  const event = { format: 1, at, path: path.slice(ROOT.length + 1), from: before === undefined ? null : hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: B }
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify(event))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}

// The tools beneath fleet: they run fleet's own call, or wait at a prompt the test answers, or run and then have their
// result withheld (a plugin beneath that redacts)
const calls: { tool: string; input: any }[] = []
let mode: 'ok' | 'prompt' | 'ran-then-withheld' = 'ok'
let answerPrompt: (how: 'run' | 'deny') => void = () => {}
let checkVerdict: 'allow' | 'deny' = 'allow'

function serve(on: any) {
  checkVerdict = 'allow'
  calls.length = 0
  mode = 'ok'
  for (const tool of [POST, DRAFT, 'mcp__claude_ai_Gmail__send_message']) {
    on('tool.call', { tool } as any, async (_: any, e: any) => {
      const { tool: t, tool_use_id: _u, agentId: _a, ...input } = e
      if (mode === 'prompt') {
        const how = await new Promise<'run' | 'deny'>(res => (answerPrompt = res))
        if (how === 'deny') return { deny: 'The user denied this call.' } as any
      }
      calls.push({ tool: t, input })
      if (mode === 'ran-then-withheld') return { deny: 'a plugin withheld its result' } as any
      return { result: 'posted', text: 'posted' } as any
    })
  }
}

const LIAISON = '---\nname: liaison\ndescription: posts what is ready\ntools: Read, Write, Edit, SendMessage, mcp__fleet__*, mcp__claude_ai_Office__send_chat_message\n---\nYou post what is ready.\n'
const ROSTER = JSON.stringify({ rosterFormat: 1, sections: [{ id: 'team', title: 'Team' }], roles: { liaison: { agent: 'liaison', model: 'haiku', budget: { usdDay: 1 } } }, instances: [{ name: 'Liaison', role: 'liaison', section: 'team', brief: 'You post what is ready.' }] })

async function liaison($: any, on: any, ready = '# Ready\n\n## Q-1\n\nWe can run both sizes this week.\n'): Promise<World> {
  const w = world(on, { worldPaths: ['notes/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Liaison', FLEET_ROLE: 'liaison' }, files: { [READY]: ready, [`${FLEET}/outbound.json`]: SOURCED, [`${FLEET}/roster.json`]: ROSTER, [`${ROOT}/.claude/agents/liaison.md`]: LIAISON, [`${FLEET}/instances/liaison.json`]: '{}\n' } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('tool.check', () => (checkVerdict === 'deny' ? { decision: 'deny', reason: 'a deny rule refuses it' } : { decision: 'allow' }))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Liaison', root: ROOT, background: true, agent: 'liaison' }, rows: { [REF]: row(REF, 'Liaison', 'idle') } })
  serve(on)
  on('classic.SessionStart', () => ({}))
  await startSession($, w)
  await tick(w)
  return w
}

const draft = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__fleet__send', ...input } as any) as Promise<any>

test('a draft whose input sets a key the call itself sets (its tool, its id) is refused when filed, and one edited in is refused when sent', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { [READY]: '# Ready\n' } })
  on('tool.check', () => ({ decision: 'allow' }))
  serve(on)
  await startSession($, w)
  await tick(w, 1100)
  // Shown as a draft of one tool, made as a post of another: never filed
  const sneaky = await draft($, { to: 'my drafts folder', why: 'a draft to read', mcp_tool: DRAFT, input: { tool: POST, chatId: '19:bbbb', content: 'the numbers' } })
  expect(sneaky.deny).toContain('input: tool is a key the call itself sets')
  // A tool whose own argument is named tool can't go through /fleet either: it would be taken for the tool's name
  expect((await draft($, { to: 'the team chat', why: 'a post', mcp_tool: 'mcp__gateway__execute', input: { tool: 'post_message', args: { text: 'hi' } } })).deny).toContain('input: tool is a key the call itself sets')
  expect((await draft($, { to: 'x', why: 'y', mcp_tool: DRAFT, input: { tool_use_id: 'u1', body: 'b' } })).deny).toContain('input: tool_use_id is a key the call itself sets')
  // One filed clean, then edited to name another tool: /fleet says it can't run, and send refuses
  expect((await draft($, { to: 'my drafts folder', why: 'a draft to read', mcp_tool: DRAFT, input: { body: 'the numbers' } })).result).toContain('Queued as D-1')
  w.touch(`${DEC}/drafts/D-1.json`, `${JSON.stringify({ tool: DRAFT, input: { tool: POST, chatId: '19:bbbb', content: 'the numbers' } }, null, 2)}\n`)
  const list = await fleet($, '')
  expect(list).toContain("the draft can't be run (its input sets tool, which the call itself sets)")
  expect(await fleet($, '1 send')).toContain('its input sets tool, which the call itself sets')
  expect(calls).toEqual([])
})

test('a bare /fleet send in a session that showed no list shows the outbound instead of sending it', { plugins: [FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  await liaison($, on)
  await draft($, READY_POST)
  const first = await fleet($, 'send')
  expect(first).toContain('Nothing was sent: an outbound goes only as /fleet shows it. Here it is; /fleet 1 send sends it.')
  expect(first).toContain('We can run both sizes this week.')
  expect(calls).toEqual([])
  // Shown now: the same bare send goes
  expect(await fleet($, 'send')).toContain('1: sent D-1')
  expect(calls.length).toBe(1)
})

test('a version typed from a /fleet before the source changed doesn’t send past what the source says now; the version the refusal gives does', { plugins: [FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const w = await liaison($, on)
  await draft($, READY_POST)
  const list = await fleet($, '')
  const old = /\((h[0-9a-f]{8})\) · \/fleet 1 send/.exec(list)?.[1] as string
  expect(old).toBeTruthy()
  landByB(w, READY, '# Ready\n\n## Q-1\n\nDO NOT POST until QA signs off.\n\nWe can run both sizes this week.\n')
  await tick(w)
  const typed = await fleet($, `1 send ${old}`)
  expect(typed).toContain("1: D-1 wasn't sent: its text isn't word for word in notes/ready.md as it is now")
  expect(calls).toEqual([])
  const now = /\/fleet 1 send (h[0-9a-f]{8}) sends it as drafted/.exec(typed)?.[1] as string
  expect(now).toBeTruthy()
  expect(now).not.toBe(old)
  // /fleet gives the same version on its warning line
  expect(await fleet($, '')).toContain(`/fleet 1 send ${now} sends it as drafted anyway`)
  expect(await fleet($, `1 send ${now}`)).toContain('1: sent D-1')
  expect(calls.length).toBe(1)
})

test('a send still at the permission prompt after five minutes isn’t recorded as sent; how the prompt is answered is', { plugins: [FAKE_SESSIONS], timeoutMs: 60000 }, async ($, on) => {
  const w = await liaison($, on)
  await draft($, READY_POST)
  await draft($, { ...READY_POST, why: 'the second post' })
  await fleet($, '')
  mode = 'prompt'
  const p = fleet($, '1 send')
  for (let i = 0; i < 6; i++) await tick(w, 60000)
  const r = await p
  expect(r).toContain('1: D-1 is waiting at the permission prompt in this session')
  expect(r).not.toContain('sent D-1')
  expect(w.files.has(`${DEC}/answers/D-1.1.json`)).toBe(false)
  expect(await fleet($, '1 send')).toContain('D-1 is waiting at the permission prompt in this session')
  // The person says no there: nothing ran; it may still be sent again, by its version
  answerPrompt('deny')
  await tick(w)
  expect(w.files.has(`${DEC}/answers/D-1.1.json`)).toBe(false)
  const again = await fleet($, '1 send')
  expect(again).toContain('D-1 may have gone out')
  expect(calls).toEqual([])
  const v = /\/fleet 1 send (h[0-9a-f]{8}) sends it again/.exec(again)?.[1] as string
  mode = 'ok'
  expect(await fleet($, `1 send ${v}`)).toContain('1: sent D-1')
  expect(calls.length).toBe(1)
})

test('a send still at the permission prompt after five minutes, then allowed there, is recorded as sent when it ran', { plugins: [FAKE_SESSIONS], timeoutMs: 60000 }, async ($, on) => {
  const w = await liaison($, on)
  await draft($, READY_POST)
  await fleet($, '')
  mode = 'prompt'
  const p = fleet($, '1 send')
  for (let i = 0; i < 6; i++) await tick(w, 60000)
  expect(await p).toContain('1: D-1 is waiting at the permission prompt')
  expect(await fleet($, '')).toContain('⏳ waiting at the permission prompt in Liaison since ')
  answerPrompt('run')
  await tick(w)
  expect(json(w, `${DEC}/answers/D-1.1.json`) ?? json(w, `${DEC}/register/2026-11/D-1.json`)?.answers?.[0]).toMatchObject({ label: 'sent' })
  expect(calls.length).toBe(1)
  expect(w.logs.some(l => l.includes('D-1 settled: 1: sent D-1'))).toBe(true)
})

test('a deny after the tool ran (its result withheld) isn’t taken for not sent: a second send doesn’t post it again', { plugins: [FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  await liaison($, on)
  await draft($, READY_POST)
  await fleet($, '')
  mode = 'ran-then-withheld'
  const r1 = await fleet($, '1 send')
  expect(r1).toContain('1: D-1 may have gone out: its call was refused, failed or had its result withheld (a plugin withheld its result)')
  mode = 'ok'
  expect(await fleet($, '1 send')).toContain('D-1 may have gone out')
  expect(calls.length).toBe(1)
})

test('while fleet’s own approved call waits at the prompt, the instance’s own call of it is still refused before the organisation’s prompt', { plugins: [FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const w = await liaison($, on)
  await draft($, READY_POST)
  await fleet($, '')
  mode = 'prompt'
  const p = fleet($, '1 send')
  await tick(w, 1000)
  const v: any = await $.tool.check({ tool: POST, input: READY_POST.input, tool_use_id: 'u-model', approver: 'person', ceiling: 'ask' } as any)
  expect(v.decision).toBe('deny')
  answerPrompt('run')
  expect(await p).toContain('1: sent D-1')
})

test('answers waiting for a busy session don’t ride on fleet’s own call: the session hears them', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  on('tool.check', () => ({ decision: 'allow' }))
  serve(on)
  await startSession($, w)
  await decide($, { questions: [{ question: 'Which database for the cache?', options: [{ label: 'SQLite' }, { label: 'Redis' }], recommended: 'Redis', why: 'the queue runs it' }] })
  await draft($, { to: 'me', why: 'a note', mcp_tool: 'mcp__claude_ai_Gmail__send_message', input: { to: 'someone@else.invalid', body: 'x' } })
  await $.turn.start({ text: 'working on it', turnId: 't-1' })
  await w.clock.settle()
  await fleet($, '')
  await fleet($, '1b')
  await tick(w)
  expect(await fleet($, '2 send')).toContain('2: sent D-2')
  expect(w.files.has(`${DEC}/register/2026-11/D-1.json`)).toBe(false)
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't-1', reason: 'answer' } as any)
  await tick(w)
  await tick(w, 10000)
  expect(w.submits.some(s => s.includes('[D-1]'))).toBe(true)
})

test('a hold line holds its section when it says so as a marker (decorated, in capitals, before a separator); an ordinary sentence starting Hold doesn’t', () => {
  const post = 'We can run both sizes this week.'
  const holds = (line: string) => !postableSentences(`# Ready\n\n## Q-1\n\n${line}\n\n${post}\n\n## Q-2\n\nThe report is attached.\n`).includes(post)
  for (const line of ['DO NOT POST until QA signs off.', '**[DO NOT POST]** until QA signs off.', '⛔ DO NOT POST until QA signs off.', '(Held) waiting for QA.', '[HOLD] waiting for QA.', 'HOLD for QA.', 'Held until QA signs off.', 'Hold: waiting for QA.', 'Held — waiting for QA.', 'Status: held until QA signs off.', 'Not ready: the figures move.', 'Held']) {
    expect([line, holds(line)]).toEqual([line, true])
  }
  for (const line of ['Hold the date: the launch is on 12 Dec.', 'Held on Friday, the review covered both sizes.', 'Holding costs fall with the larger size.']) {
    expect([line, holds(line)]).toEqual([line, false])
  }
})

test('“replaced by” says the asker can withdraw it only when it could: one answered in part stays, to answer or drop', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'] })
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Console', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'Console', 'working') } })
  await startSession($, w)
  const Q = { question: 'Which color for the band?', options: [{ label: 'Amber' }, { label: 'Red' }], recommended: 'Amber', why: 'calm' }
  await decide($, { questions: [Q, { ...Q, question: 'Which font for the band?' }] })
  await fleet($, '')
  await fleet($, '1a')
  await decide($, { questions: [{ ...Q, question: 'Which color and font for the band?' }], supersedes: 'D-1' })
  const list = await fleet($, '')
  expect(list).toContain('   replaced by D-2: it stays, answered in part (answer the rest or /fleet drop D-1)')
  expect(list).not.toContain('can withdraw it')
})

// A plugin above fleet whose check answers over a deny beneath it (an organisation's policy that lets its own chat
// through whatever the local rules say): the last word up the chain is the decision
const OVERRIDE = {
  name: 'policy',
  tier: 'prepend' as const,
  register(on: any) {
    on('tool.check', { tool: 'mcp__claude_ai_Office__send_chat_message' }, async ($: any, e: any, next: any) => {
      const r = await next(e)
      return r?.decision === 'deny' ? { decision: 'allow', reason: 'the organisation allows its own chat' } : r
    })
  },
}

test('a deny fleet saw beneath it that a hook above answered over (the tool ran) is sent, once: the claim isn’t freed for a second post', { plugins: [FAKE_SESSIONS, OVERRIDE], timeoutMs: 30000 }, async ($, on) => {
  await liaison($, on)
  await draft($, READY_POST)
  await fleet($, '')
  checkVerdict = 'deny'
  expect(await fleet($, '1 send')).toContain('1: sent D-1')
  expect(await fleet($, '1 send')).toContain('D-1 was answered already')
  expect(calls.length).toBe(1)
})

test('a pending claim its process didn’t settle (that session restarted, or it waited past 12 hours) reads as may have gone out: sent again by its version', { plugins: [FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const w = await liaison($, on)
  await draft($, READY_POST)
  // As answerOutbound writes it after its wait, by a process gone since, three days ago
  w.touch(`${DEC}/applied/D-1.json`, JSON.stringify({ format: FORMAT, id: 'D-1', at: w.clock.now() - 3 * 24 * 3600000, session: 'Liaison', origin: 'composer', hash: 'x', pending: true }))
  await tick(w)
  const list = await fleet($, '')
  expect(list).not.toContain('⏳')
  expect(list).toContain('⚠ D-1 may have gone out')
  const plain = await fleet($, '1 send')
  expect(plain).toContain('1: D-1 may have gone out: it waited at the permission prompt in Liaison')
  const v = /\/fleet 1 send (h[0-9a-f]{8}) sends it again/.exec(plain)?.[1] as string
  expect(await fleet($, `1 send ${v}`)).toContain('1: sent D-1')
  expect(calls.length).toBe(1)
})

test('a pending claim of this session made by another process (it restarted an hour ago) reads as may have gone out; one of another session that recent still waits', { plugins: [FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const w = await liaison($, on)
  await draft($, READY_POST)
  await draft($, { ...READY_POST, why: 'the second post' })
  const hour = w.clock.now() - 3600000
  w.touch(`${DEC}/applied/D-1.json`, JSON.stringify({ format: FORMAT, id: 'D-1', at: hour, session: 'Liaison', origin: 'composer', hash: 'x', pending: true, sid: SID, proc: 'an-earlier-process' }))
  w.touch(`${DEC}/applied/D-2.json`, JSON.stringify({ format: FORMAT, id: 'D-2', at: hour, session: 'Console', origin: 'composer', hash: 'x', pending: true, sid: 'cccccccc-0000-0000-0000-000000000000', proc: 'its-process' }))
  await tick(w)
  await fleet($, '')
  expect(await fleet($, '1 send')).toContain('1: D-1 may have gone out: it waited at the permission prompt in Liaison')
  expect(await fleet($, '2 send')).toContain('2: D-2 is waiting at the permission prompt in Console')
  expect(calls).toEqual([])
})

test('one this session’s own process still waits on says the way out; reject, done and drop wait for the prompt; a yes there after a close says so', { plugins: [FAKE_SESSIONS], timeoutMs: 60000 }, async ($, on) => {
  const w = await liaison($, on)
  await draft($, READY_POST)
  await fleet($, '')
  mode = 'prompt'
  const p = fleet($, '1 send')
  for (let i = 0; i < 6; i++) await tick(w, 60000)
  expect(await p).toContain('1: D-1 is waiting at the permission prompt')
  expect(await fleet($, '')).toContain('answer it there: yes sends it, No and then /fleet 1 reject')
  for (const verb of ['reject', 'done']) expect(await fleet($, `1 ${verb}`)).toContain(`1: D-1 waits at the permission prompt in Liaison: answer No there first, then /fleet 1 ${verb}`)
  expect(await fleet($, 'drop 1')).toContain('D-1 waits at the permission prompt in Liaison: answer No there first')
  expect(w.files.has(`${DEC}/answers/D-1.1.json`)).toBe(false)
  // Closed meanwhile another way (another fleet's answer): the yes still sends it, and fleet says what really happened
  w.touch(`${DEC}/answers/D-1.1.json`, JSON.stringify({ format: FORMAT, id: 'D-1', q: 1, label: 'rejected', origin: 'composer', session: 'Console', at: w.clock.now() }))
  answerPrompt('run')
  await tick(w)
  expect(calls.length).toBe(1)
  expect(w.logs.some(l => l.includes('D-1 settled: 1: D-1 went out (it answered: posted) after it was closed as rejected'))).toBe(true)
})

test('a hold line with a short label before it holds its section; a hyphenated term doesn’t', () => {
  const post = 'We can run both sizes this week.'
  const holds = (line: string) => !postableSentences(`# Ready\n\n## Q-1\n\n${line}\n\n${post}\n\n## Q-2\n\nThe report is attached.\n`).includes(post)
  for (const line of ['Status: not ready', 'Status: do not post', 'Status: DO NOT POST until QA signs off.', 'Note: do not post until QA signs off.', 'NB: hold until QA signs off.', 'Holding until QA signs off.', 'Pending QA: do not post.', 'Don’t post until QA signs off.', '~~Hold until QA signs off.~~', 'On hold until QA signs off.', 'Do NOT post yet.', 'Held - waiting for QA.']) {
    expect([line, holds(line)]).toEqual([line, true])
  }
  for (const line of ['Held-out accuracy is 92% on both sizes.', 'Hold-out set: both sizes pass.', 'Holding costs fall with the larger size.', 'Holding: the larger size.', 'Hold the date: the launch is on 12 Dec.']) {
    expect([line, holds(line)]).toEqual([line, false])
  }
})
