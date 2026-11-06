import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { postableSentences, sourceDifference } from '../hooks/outbound'
import { DEC, FAKE_SESSIONS, FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// What a ready post must be when it goes out, not only when it was called: a call to a tool the organisation always
// asks the person about would wait at that prompt in a background session with its text frozen, so it goes to the
// person as a draft; an approved draft is checked against its source again when he sends it, and runs through the
// session's own permission check (the organisation's prompt shows there); a hold in the file holds its whole part;
// a send from a thread that read a file which changed since, however long ago it read it, is refused once

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

const POST = 'mcp__claude_ai_Office__send_chat_message'
const READY = `${ROOT}/notes/ready.md`
const SOURCED = JSON.stringify({ outboundFormat: 1, hosts: [], remotes: [], recipients: [], calls: [{ tool: POST, match: { chatId: '19:aaaa' }, source: 'notes/ready.md', body: 'content' }] })
const UNSOURCED = JSON.stringify({ outboundFormat: 1, hosts: [], remotes: [], recipients: [], calls: [{ tool: POST, match: { chatId: '19:aaaa' } }] })
const B = { sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', agentId: null, ref: 'bbbbbbbb', name: 'TEST B' }

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

const LIAISON = '---\nname: liaison\ndescription: posts what is ready\ntools: Read, Write, Edit, SendMessage, mcp__fleet__*, mcp__claude_ai_Office__send_chat_message\n---\nYou post what is ready.\n'
const ROSTER = JSON.stringify({ rosterFormat: 1, sections: [{ id: 'team', title: 'Team' }], roles: { liaison: { agent: 'liaison', model: 'haiku', budget: { usdDay: 1 } } }, instances: [{ name: 'Liaison', role: 'liaison', section: 'team', brief: 'You post what is ready.' }] })

/** The liaison, an instance of the roster in a background session. The engine's permission check answers ask (the
 * mode's decider) beneath fleet's; a test asks it as the engine does inside the call, with the organisation's ceiling */
async function liaison($: any, on: any, out: string, ready: string): Promise<{ w: World; sent: string[]; mcp: unknown[] }> {
  const w = world(on, { worldPaths: ['notes/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Liaison', FLEET_ROLE: 'liaison' }, files: { [READY]: ready, [`${FLEET}/outbound.json`]: out, [`${FLEET}/roster.json`]: ROSTER, [`${ROOT}/.claude/agents/liaison.md`]: LIAISON, [`${FLEET}/instances/liaison.json`]: '{}\n' } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  verdicts(on)
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Liaison', root: ROOT, background: true, agent: 'liaison' }, rows: { [REF]: row(REF, 'Liaison', 'idle') } })
  const sent: string[] = []
  const mcp: unknown[] = []
  on('tool.call', { tool: POST }, (_: any, e: any) => {
    // The permission prompt said no: the tool doesn't run
    if (refuseNext) return { deny: 'The user denied this call.' } as any
    sent.push(String(e.content))
    return { result: 'posted', text: 'posted' } as any
  })
  on('mcp.call', (_: any, e: any) => {
    mcp.push(e)
    return { value: { content: [{ type: 'text', text: 'posted' }], isError: false } }
  })
  on('classic.SessionStart', () => ({}))
  await startSession($, w)
  await tick(w)
  return { w, sent, mcp }
}

let refuseNext = false
let refuseCheck = false

const post = ($: any, content: string) => $.tool.call({ tool: POST, chatId: '19:aaaa', content } as any) as Promise<any>

// The engine's own verdict beneath fleet's: allow (a call on $ gets it as a value, the engine's own check as its result)
let asking = false
function verdicts(on: any) {
  on('tool.check', () => (refuseCheck ? { decision: 'deny', reason: 'a rule refuses it' } : { decision: 'allow' }))
}
async function ask($: any, tool: string, input: unknown, ceiling?: 'ask'): Promise<any> {
  asking = true
  try {
    return await $.tool.check({ tool, input, tool_use_id: 'u-check', approver: 'person', ...(ceiling ? { ceiling } : {}) } as any)
  } finally {
    asking = false
  }
}
const check = ($: any, content: string, ceiling?: 'ask') => ask($, POST, { chatId: '19:aaaa', content }, ceiling)

test('a background instance’s ready post to a tool its organisation always asks about isn’t left at that prompt with its text frozen: it goes to the person as a draft', { plugins: [FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const { w } = await liaison($, on, SOURCED, '# Ready\n\nWhich packet sizes matter most?\n')
  await $.tool.call({ tool: 'Read', file_path: READY } as any)
  const v = await check($, 'Which packet sizes matter most?', 'ask')
  expect(v.decision).toBe('deny')
  expect(v.reason).toContain('Your organisation asks the person about every call of mcp__claude_ai_Office__send_chat_message')
  expect(v.reason).toContain('draft it with mcp__fleet__send')
  // A read of the same server is left to the prompt, as before
  expect((await ask($, 'mcp__claude_ai_Office__read_resource', { uri: 'x' }, 'ask')).decision).not.toBe('deny')
  // The draft, as the liaison would file it: it keeps the entry's source and its version, and says what it is
  const q: any = await $.tool.call({ tool: 'mcp__fleet__send', to: 'the team chat', why: 'a ready post', mcp_tool: POST, input: { chatId: '19:aaaa', content: 'Which packet sizes matter most?' } } as any)
  expect(q.result).toContain('Queued as D-1 for the person')
  const spec = json(w, `${DEC}/queue/D-1.json`).outbound
  expect(spec.sources).toEqual([{ path: 'notes/ready.md', v: hashText('# Ready\n\nWhich packet sizes matter most?\n') }])
  expect(spec.what).toBe('send_chat_message on claude_ai_Office')
})

test('without the organisation’s ask the check is left as it was, and the post goes straight out', { plugins: [FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const { sent } = await liaison($, on, SOURCED, '# Ready\n\nWhich packet sizes matter most?\n')
  await $.tool.call({ tool: 'Read', file_path: READY } as any)
  expect((await check($, 'Which packet sizes matter most?')).decision).not.toBe('deny')
  expect((await post($, 'Which packet sizes matter most?')).deny).toBe(undefined)
  expect(sent).toEqual(['Which packet sizes matter most?'])
})

test('the person’s own background session (no instance of the roster) leaves the organisation’s prompt to him', async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [READY]: '# Ready\n\nWhich packet sizes matter most?\n', [`${FLEET}/outbound.json`]: SOURCED } })
  verdicts(on)
  await startSession($, w)
  await tick(w, 1100)
  expect((await check($, 'Which packet sizes matter most?', 'ask')).decision).not.toBe('deny')
})

test('an approved ready post is checked against its source when the person sends it: changed since, it waits for his typed version; it runs through the session’s own permission check', { plugins: [FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const { w, sent, mcp } = await liaison($, on, SOURCED, '# Ready\n\nWhich packet sizes matter most?\n\nWe can run both sizes this week.\n')
  await $.tool.call({ tool: 'mcp__fleet__send', to: 'the team chat', why: 'a ready post', mcp_tool: POST, input: { chatId: '19:aaaa', content: 'We can run both sizes this week.' } } as any)
  // The source changes before he approves: the sentence was taken back
  landByB(w, READY, '# Ready\n\nWhich packet sizes matter most?\n\nWe can run one size this week.\n')
  await tick(w)
  const list = await fleet($, '')
  expect(list).toContain("⚠ its text isn't word for word in notes/ready.md as it is now")
  expect(list).toContain('notes/ready.md changed since it was drafted')
  const plain = await fleet($, '1 send')
  expect(plain).toContain("1: D-1 wasn't sent: its text isn't word for word in notes/ready.md as it is now")
  expect(plain).toMatch(/\/fleet 1 send h[0-9a-f]{8} sends it as drafted/)
  expect(sent).toEqual([])
  expect(w.files.has(`${DEC}/applied/D-1.json`)).toBe(false)
  const v = /\/fleet 1 send (h[0-9a-f]{8})/.exec(plain)?.[1] as string
  expect(await fleet($, `1 send ${v}`)).toContain('1: sent D-1 (send_chat_message on claude_ai_Office to the team chat), exactly as shown: it answered: posted.')
  // Through the tool call (the permission check, the organisation's prompt), not around it
  expect(sent).toEqual(['We can run both sizes this week.'])
  expect(mcp).toEqual([])
})

test('an approved post the session’s permission check refuses isn’t sent: its claim goes, and /fleet n send asks again', { plugins: [FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const { w, sent } = await liaison($, on, SOURCED, '# Ready\n\nWhich packet sizes matter most?\n')
  await $.tool.call({ tool: 'mcp__fleet__send', to: 'the team chat', why: 'a ready post', mcp_tool: POST, input: { chatId: '19:aaaa', content: 'Which packet sizes matter most?' } } as any)
  await fleet($, '')
  // A rule refuses it at the permission check: it never ran
  refuseCheck = true
  try {
    expect(await fleet($, '1 send')).toContain("1: D-1 wasn't sent: ")
  } finally {
    refuseCheck = false
  }
  expect(w.files.has(`${DEC}/applied/D-1.json`)).toBe(false)
  expect(sent).toEqual([])
  expect(await fleet($, '1 send')).toContain('1: sent D-1')
  expect(sent).toEqual(['Which packet sizes matter most?'])
})

test('an approved post refused after the check (the prompt said no, or the tool refused it) may have gone out: kept, sent again only by its version', { plugins: [FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const { w, sent } = await liaison($, on, SOURCED, '# Ready\n\nWhich packet sizes matter most?\n')
  await $.tool.call({ tool: 'mcp__fleet__send', to: 'the team chat', why: 'a ready post', mcp_tool: POST, input: { chatId: '19:aaaa', content: 'Which packet sizes matter most?' } } as any)
  await fleet($, '')
  refuseNext = true
  let first = ''
  try {
    first = await fleet($, '1 send')
  } finally {
    refuseNext = false
  }
  expect(first).toContain('1: D-1 may have gone out: its call was refused, failed or had its result withheld (The user denied this call)')
  expect(w.files.has(`${DEC}/applied/D-1.json`)).toBe(true)
  expect(await fleet($, '')).toContain('⚠ D-1 may have gone out')
  expect(await fleet($, '1 send')).toContain('D-1 may have gone out')
  expect(sent).toEqual([])
  const v = /\/fleet 1 send (h[0-9a-f]{8}) sends it again/.exec(first)?.[1] as string
  expect(await fleet($, `1 send ${v}`)).toContain('1: sent D-1')
  expect(sent).toEqual(['Which packet sizes matter most?'])
})

test('a send the gate lets through is refused once when a file its thread read changed since, however long ago it read it', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${ROOT}/notes/a.md`]: 'a1\n', [`${FLEET}/outbound.json`]: UNSOURCED } })
  const sent: string[] = []
  on('tool.call', { tool: POST } as any, (_: any, e: any) => {
    sent.push(String(e.content))
    return { result: 'posted', text: 'posted' } as any
  })
  await startSession($, w)
  await tick(w, 1100)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  await tick(w, 2 * 3600000)
  landByB(w, `${ROOT}/notes/a.md`, 'a2\n')
  await tick(w)
  const r = await post($, 'the numbers from notes/a.md')
  expect(r.deny).toMatch(/^fleet: this wasn't sent: a shared file you read changed since you read it \(notes\/a\.md: changed at \d\d:\d\d by TEST B \(Edit\)\)/)
  expect((await post($, 'the numbers from notes/a.md')).deny).toBe(undefined)
  expect(sent).toEqual(['the numbers from notes/a.md'])
})

test('a hold in the source holds its whole part: a "do not post" line or a HELD label under a heading takes the heading’s section out, to the next heading of its level', () => {
  const file = '# Ready\n\n## Q-1\n\nDO NOT POST this one yet.\n\nWe can deliver the first test on Friday.\n\n## Q-2\n\nHELD: waiting for the person.\n\nThe second run starts Monday.\n\n## Q-3\n\nThe report is attached.\n'
  expect(sourceDifference('We can deliver the first test on Friday.', file)).toContain('marked not to post')
  expect(sourceDifference('The second run starts Monday.', file)).toContain('marked not to post')
  expect(sourceDifference('The report is attached.', file)).toBe(null)
  expect(postableSentences(file)).toEqual(['Ready', 'Q-3', 'The report is attached.'])
  // An internal label is its own block's, as before: the rest of the section posts
  const internal = '# Ready\n\nInternal: the figure is from the old run.\n\nThe new run is done.\n'
  expect(sourceDifference('The new run is done.', internal)).toBe(null)
})
