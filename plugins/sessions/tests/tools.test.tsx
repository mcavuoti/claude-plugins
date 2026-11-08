import { expect, test } from 'claude-code/testing'

import { agentAddress, agentFromFlags, modelWakesOf, pickSession, roleTools, toolRowLine, TOOLS_UNKNOWN_ROLE_WAIT_MS, TOOLS_WAIT_MS, wakeLimit, wokenLine } from '../hooks/state'
import { parseRegistry } from '../hooks/watch'
import { COMMAND, DATA, ROOT, SID, SLOW, startSession, world, type World } from './world'

// The tools for Claude (mcp__sessions__list, mcp__sessions__wake): what the start registers for which agent, what
// each tool answers, and every guard on a wake

const PANEL = { plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

const IDLE = 'dddddddd-0000-0000-0000-000000000000'
const PERSON = 'eeeeeeee-0000-0000-0000-000000000000'
const MEMORY = 'ffffffff-0000-0000-0000-000000000000'
const MYSTERY = '22222222-0000-0000-0000-000000000000'
const RUNNER = '11111111-0000-0000-0000-000000000000'
const REGULAR = 'cccccccc-0000-0000-0000-000000000000'
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000000'
// The mocked clock starts here (world.tsx); the service's log says what happened 2 hours before
const T0 = 1_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()
const LOG_AT = T0 - 121 * 60000
const LOG = [
  `[${iso(LOG_AT)}] [bg] bg retire dddddddd: settled, idle 61m`,
  `[${iso(LOG_AT + 1000)}] [bg] bg settled dddddddd (done)`,
  // Stopped by the person: the process ends with no retire before it
  `[${iso(LOG_AT + 2000)}] [bg] bg settled eeeeeeee (killed)`,
  `[${iso(LOG_AT + 3000)}] [bg] bg retire ffffffff: settled, idle 38h [low memory, pinned]`,
  `[${iso(LOG_AT + 4000)}] [bg] bg retire bbbbbbbb: settled, idle 61m`,
].join('\n')

function sessions(): any[] {
  return [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'lead' },
    { id: '11111111', sessionId: RUNNER, cwd: ROOT, kind: 'background', status: 'idle', pid: 4243, name: 'runner' },
    { id: 'dddddddd', sessionId: IDLE, cwd: ROOT, kind: 'background', name: 'worker a' },
    { id: 'eeeeeeee', sessionId: PERSON, cwd: ROOT, kind: 'background', name: 'worker b' },
    { id: 'ffffffff', sessionId: MEMORY, cwd: ROOT, kind: 'background', name: 'memory one' },
    { id: '22222222', sessionId: MYSTERY, cwd: ROOT, kind: 'background', name: 'mystery' },
    { sessionId: REGULAR, cwd: ROOT, kind: 'interactive', status: 'busy', pid: 4244, name: 'myapp-1f' },
    { id: 'bbbbbbbb', sessionId: OTHER, cwd: '/Users/x/other', kind: 'background', name: 'elsewhere' },
  ]
}

type Setup = {
  w: World
  list: any[]
  // Each tool registration (its spec), in order; while gate holds a promise, each one answers only once it resolves
  registered: any[]
  gate: { value: Promise<void> | null }
  // What the permission check answers, by call (every tool.check the mod asked, in order)
  check: { value: (e: any) => any }
  checks: any[]
  // ListAgents' rows, and how many times it was called
  agents: { value: any[] }
  agentCalls: { value: number }
  // The sessions claude respawn restarted (each one comes up with a process unless up is false)
  respawned: string[]
  up: { value: boolean }
  // Run when a session takes <data>/bringback.lock (what happens meanwhile elsewhere)
  atLock: { value: () => void }
}

function setup(on: any, options: { list?: any[]; store?: Record<string, unknown>; onStart?: ($: any) => Promise<void> } = {}): Setup {
  const list = options.list ?? sessions()
  const respawned: string[] = []
  const up = { value: true }
  const atLock = { value: () => {} }
  // A respawn brings the session up in the list claude agents answers
  const onRun = (a: readonly string[]) => {
    if (a[0] === 'mkdir' && String(a[1]).endsWith('/bringback.lock')) atLock.value()
    if (a[0] !== '/bin/claude' || a[1] !== 'respawn') return
    respawned.push(String(a[2]))
    const s = list.find(x => x.id === a[2])
    if (s && up.value) Object.assign(s, { pid: 7000 + respawned.length, status: 'idle' })
  }
  const registered: any[] = []
  const gate: { value: Promise<void> | null } = { value: null }
  on('tool.register', async (_: any, e: any) => {
    if (gate.value) await gate.value
    registered.push(e)
    return { value: { tool: `mcp__sessions__${e.name}` } }
  })
  const check = { value: (_e: any): any => ({ decision: 'allow' }) }
  const checks: any[] = []
  on('tool.check', (_: any, e: any) => {
    checks.push(e)
    return check.value(e)
  })
  const agents = { value: [{ name: 'worker a', ref: 'ab12cd', type: 'bg', status: 'idle' }, { name: 'runner', ref: '0f0f0f', type: 'bg', status: 'idle' }, { name: 'elsewhere work', ref: '123abc', type: 'bg', status: 'idle' }] as any[] }
  const agentCalls = { value: 0 }
  on('tool.call', { tool: 'ListAgents' }, () => {
    agentCalls.value++
    return { result: { listing: '', sections: [{ kind: 'sessions', total: agents.value.length, rows: agents.value }] } } as any
  })
  const w = world(on, { list, store: { [`state:${IDLE}`]: { agent: 'reviewer' }, ...options.store }, onRun, onStart: options.onStart })
  w.files.set('/Users/x/daemon.log', LOG)
  return { w, list, registered, gate, check, checks, agents, agentCalls, respawned, up, atLock }
}

// A session started as the engine starts one: its SessionStart (with the agent it runs as), then session.start
async function started($: any, t: Setup, agent?: string) {
  await $.classic.SessionStart({ source: 'startup', session_id: SID, ...(agent ? { agent_type: agent } : {}) } as any)
  await startSession($, t.w)
  await t.w.clock.advance(100)
}

// A tool call of the model's, answered once the clock moved on far enough for the wake queue and the wait for the
// session to run
async function call($: any, t: Setup, input: Record<string, unknown>, ms = 6000): Promise<any> {
  const answer = $.tool.call(input)
  await t.w.clock.advance(ms)
  return answer
}
const wake = ($: any, t: Setup, session: unknown, extra: Record<string, unknown> = {}) => call($, t, { tool: 'mcp__sessions__wake', session, ...extra })
const listed = ($: any, t: Setup, extra: Record<string, unknown> = {}) => call($, t, { tool: 'mcp__sessions__list', ...extra }, 100)
const denied = async (p: Promise<any>) => String((await p).deny ?? `not denied: ${JSON.stringify(await p)}`)

const WOKE = 'Woke “worker a” (retired for being idle 2 h ago). It runs now: SendMessage to "worker a [ab12cd]" (the [ref] changes at each restart).'

// ---- The pure parts ----

test("roleTools: an agent's tools: line decides which tools are registered, and how long the start waits", () => {
  const file = (front: string) => `---\nname: x\ndescription: y\n${front}---\nYou are x.\n`
  expect(roleTools(null)).toEqual({ tools: ['list', 'wake'], waitMs: TOOLS_UNKNOWN_ROLE_WAIT_MS, why: 'its agent file was not found (a plugin agent, or --agents)' })
  expect(roleTools(file(''))).toEqual({ tools: ['list', 'wake'], waitMs: TOOLS_WAIT_MS, why: 'its agent file has no tools: line' })
  expect(roleTools(file('tools: Read, Bash\n')).tools).toEqual([])
  expect(roleTools(file('tools: Read, Bash\n')).why).toBe("its agent file's tools: line doesn't name mcp__sessions__*")
  expect(roleTools(file('tools: Read, mcp__sessions__*, SendMessage\n')).tools).toEqual(['list', 'wake'])
  expect(roleTools(file('tools: Read, mcp__sessions\n')).tools).toEqual(['list', 'wake'])
  expect(roleTools(file('tools: [Read, "mcp__sessions__list"]\n')).tools).toEqual(['list'])
  expect(roleTools(file('tools:\n  - Read\n  - mcp__sessions__wake\n')).tools).toEqual(['wake'])
  expect(roleTools(file("tools: '*'\n")).tools).toEqual(['list', 'wake'])
  expect(roleTools(file('disallowedTools: mcp__sessions__wake\n')).tools).toEqual(['list'])
  // A tools: line in the body, not the front matter, is no tools: line
  expect(roleTools('---\nname: x\n---\ntools: Read\n').tools).toEqual(['list', 'wake'])
  expect(roleTools('no front matter at all').tools).toEqual(['list', 'wake'])
})

test('wakeLimit: 6 per caller in 10 minutes, 20 in an hour, 3 per session in an hour; and when it can go again', () => {
  const now = 10_000_000
  const by = (caller: string, target: string, ago: number) => ({ at: now - ago, by: caller, target })
  const six = [1, 2, 3, 4, 5, 6].map(i => by('me', `t${i}`, i * 60000))
  expect(wakeLimit(six.slice(0, 5), 'me', 'x', now)).toBe(null)
  expect(wakeLimit(six, 'me', 'x', now)).toEqual({ who: 'caller', count: 6, ms: 600000, until: now - 6 * 60000 + 600000 })
  // Another caller's wakes don't count against this one
  expect(wakeLimit(six, 'you', 'x', now)).toBe(null)
  const twenty = Array.from({ length: 20 }, (_, i) => by('me', `t${i}`, 11 * 60000 + i * 60000))
  expect(wakeLimit(twenty, 'me', 'x', now)?.ms).toBe(3600000)
  expect(wakeLimit(twenty, 'me', 'x', now)?.until).toBe(now - 30 * 60000 + 3600000)
  const three = [by('a', 'x', 1000), by('b', 'x', 2000), by('c', 'x', 3000)]
  expect(wakeLimit(three, 'me', 'x', now)).toEqual({ who: 'target', count: 3, ms: 3600000, until: now - 3000 + 3600000 })
  expect(wakeLimit(three, 'me', 'y', now)).toBe(null)
  // The log keeps an hour, and nothing malformed
  expect(modelWakesOf([by('a', 'x', 1000), by('a', 'x', 3600001), { at: 'x' }, null], now)).toEqual([by('a', 'x', 1000)])
  expect(modelWakesOf('nonsense', now)).toEqual([])
})

test('pickSession: by short id, session id, name or title, then ignoring case; ListAgents\' "name [ref]" and quotes too', () => {
  const all = [
    { sessionId: IDLE, id: 'dddddddd', name: 'worker a', title: 'worker a' },
    { sessionId: PERSON, id: 'eeeeeeee', name: '', title: 'Fix the login' },
    { sessionId: REGULAR, id: null, name: 'myapp-1f', title: 'myapp-1f' },
  ]
  const found = (asked: string) => {
    const r = pickSession(all, asked)
    return 'found' in r ? r.found.sessionId : 'many' in r ? r.many.length : 'none'
  }
  expect(found('dddddddd')).toBe(IDLE)
  expect(found(IDLE)).toBe(IDLE)
  expect(found(`sid:${REGULAR}`)).toBe(REGULAR)
  expect(found('worker a')).toBe(IDLE)
  expect(found('Worker A')).toBe(IDLE)
  expect(found('worker a [ab12cd]')).toBe(IDLE)
  expect(found('“worker a”')).toBe(IDLE)
  expect(found('fix the login')).toBe(PERSON)
  expect(found('worker')).toBe('none')
  expect(found('  ')).toBe('none')
  expect(found('w')).toBe('none')
  expect(found('twin')).toBe('none')
  const twins = [...all, { sessionId: MEMORY, id: 'ffffffff', name: 'worker a', title: 'worker a' }]
  const r = pickSession(twins, 'worker a')
  expect('many' in r && r.many.map(x => x.id)).toEqual(['dddddddd', 'ffffffff'])
})

test("agentAddress: ListAgents' ref when one row has the name; the name alone when none or several do", () => {
  const rows = [{ name: 'worker a', ref: 'ab12cd' }, { name: 'twin', ref: '111111' }, { name: 'twin', ref: '222222' }, { name: 'odd', ref: 'no spaces allowed' }]
  expect(agentAddress(rows, 'worker a')).toBe('worker a [ab12cd]')
  expect(agentAddress(rows, 'twin')).toBe('twin')
  expect(agentAddress(rows, 'nobody')).toBe('nobody')
  expect(agentAddress(rows, 'odd')).toBe('odd')
  expect(agentAddress([null, 3, 'x'], 'worker a')).toBe('worker a')
})

test('a row of mcp__sessions__list, and the woken line', () => {
  const now = 50_000_000
  const row = { sessionId: IDLE, id: 'dddddddd', name: 'worker a', title: 'Fixing the tests', state: 'stopped' as const, stopped: 'idle' as const, stoppedAt: now - 3 * 3600000, wake: '', agent: 'reviewer' }
  expect(toolRowLine(row, now)).toBe('- “worker a” (“Fixing the tests” in the panel) · dddddddd · stopped: retired for being idle 3 h ago · wake: yes · runs as agent reviewer')
  expect(toolRowLine({ ...row, title: 'worker a', stopped: 'person', wake: 'the person stopped it', agent: null }, now)).toBe('- “worker a” · dddddddd · stopped by the person 3 h ago · wake: no (the person stopped it)')
  expect(toolRowLine({ ...row, id: null, name: '', title: 'myapp-1f', state: 'waiting', stopped: undefined, stoppedAt: undefined, wake: 'it runs', agent: null }, now)).toBe('- “myapp-1f” · regular session · waiting for the person · wake: no (it runs)')
  expect(wokenLine('lead')).toBe('woken by “lead”')
  expect(Array.from(wokenLine('x'.repeat(100))).length).toBeLessThanOrEqual(60)
})

// ---- Registration ----

test('registered at session.start after the plugins beneath, both deferred, with the input other plugins code against', async ($, on) => {
  const t = setup(on)
  await started($, t)
  expect(t.registered.map(r => r.name)).toEqual(['list', 'wake'])
  expect(t.registered.every(r => r.isDeferred === true)).toBe(true)
  expect(t.registered[0].inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false })
  expect(t.registered[1].inputSchema).toEqual({
    type: 'object',
    properties: { session: { type: 'string', description: "The session's name or short id, as mcp__sessions__list shows it" } },
    required: ['session'],
    additionalProperties: false,
  })
  const status: any = await $.command.run({ command: 'sessions', args: 'status', ...COMMAND })
  expect(String(status.text)).toContain('Tools for Claude: mcp__sessions__list, mcp__sessions__wake (no agent)')
})

test('a session.start answers within a second however long the registration takes (no agent), and the tools come later', async ($, on) => {
  const t = setup(on)
  let release = () => {}
  t.gate.value = new Promise<void>(r => (release = r))
  await $.classic.SessionStart({ source: 'startup', session_id: SID } as any)
  let done = false
  const start = $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true }).then(() => (done = true))
  await t.w.clock.advance(999)
  expect(done).toBe(false)
  await t.w.clock.advance(1)
  expect(done).toBe(true)
  await start
  release()
  await t.w.clock.advance(10)
  expect(t.registered.map(r => r.name)).toEqual(['list', 'wake'])
})

test("an agent whose file isn't found (a plugin's agent, --agents): the start waits 300 ms at most", async ($, on) => {
  const t = setup(on)
  t.gate.value = new Promise<void>(() => {})
  await $.classic.SessionStart({ source: 'startup', session_id: SID, agent_type: 'plugin-agent' } as any)
  let done = false
  const start = $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true }).then(() => (done = true))
  await t.w.clock.advance(299)
  expect(done).toBe(false)
  await t.w.clock.advance(1)
  expect(done).toBe(true)
  await start
})

test("an agent's file decides: tools: naming them registers them, one that doesn't registers none, and holds nothing", async ($, on) => {
  const t = setup(on)
  t.w.files.set(`${ROOT}/.claude/agents/lead.md`, '---\nname: lead\ntools: Read, SendMessage, mcp__sessions__*\n---\nLead.\n')
  await started($, t, 'lead')
  expect(t.registered.map(r => r.name)).toEqual(['list', 'wake'])
  const status: any = await $.command.run({ command: 'sessions', args: 'status', ...COMMAND })
  expect(String(status.text)).toContain("Tools for Claude: mcp__sessions__list, mcp__sessions__wake (agent lead: its agent file's tools: line names mcp__sessions__list and mcp__sessions__wake)")
})

test("an agent whose tools: line doesn't name them gets none: no registration, so no 8 s hold at each start", async ($, on) => {
  const t = setup(on)
  // In the person's own agents, found from the home folder
  t.w.files.set('/Users/x/.claude/agents/coder.md', '---\nname: coder\ntools: Read, Edit, Bash\n---\nCode.\n')
  // A registration would never answer: the start would wait for it
  t.gate.value = new Promise<void>(() => {})
  await $.classic.SessionStart({ source: 'startup', session_id: SID, agent_type: 'coder' } as any)
  let done = false
  const start = $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true }).then(() => (done = true))
  await t.w.clock.settle()
  expect(done).toBe(true)
  await start
  expect(t.registered).toEqual([])
  const status: any = await $.command.run({ command: 'sessions', args: 'status', ...COMMAND })
  expect(String(status.text)).toContain("Tools for Claude: not offered: agent coder, its agent file's tools: line doesn't name mcp__sessions__*")
})

test('the project folder wins over the home folder, and a parent folder of the project counts', async ($, on) => {
  const t = setup(on)
  t.w.files.set('/Users/x/.claude/agents/lead.md', '---\nname: lead\ntools: Read\n---\n')
  t.w.files.set('/Users/x/myapp/.claude/agents/lead.md', '---\nname: lead\ntools: mcp__sessions__list\n---\n')
  await started($, t, 'lead')
  expect(t.registered.map(r => r.name)).toEqual(['list'])
})

test('off (sessionTools false): nothing registered, and a call is refused', { options: { sessionTools: false } }, async ($, on) => {
  const t = setup(on)
  await started($, t)
  expect(t.registered).toEqual([])
  expect(await denied(listed($, t))).toBe("mcp__sessions__list is turned off in the sessions plugin's options (sessionTools)")
  expect(await denied(wake($, t, 'worker a'))).toBe("mcp__sessions__wake is turned off in the sessions plugin's options (sessionTools)")
  expect(t.respawned).toEqual([])
})

test('a non-interactive run (claude -p) registers nothing', async ($, on) => {
  const t = setup(on)
  await $.classic.SessionStart({ source: 'startup', session_id: SID } as any)
  await startSession($, t.w, false)
  expect(t.registered).toEqual([])
})

test('a reload: registered again (Claude keeps them as they are), by the agent the session recorded, and they still answer', async ($, on) => {
  const t = setup(on)
  t.w.files.set(`${ROOT}/.claude/agents/lead.md`, '---\nname: lead\ntools: mcp__sessions__*\n---\n')
  await started($, t, 'lead')
  // A reload runs session.start again, with no SessionStart: the agent comes from $.state
  await startSession($, t.w)
  expect(t.registered.map(r => r.name)).toEqual(['list', 'wake', 'list', 'wake'])
  expect((await listed($, t)).result).toContain('“worker a”')
})

test("a SessionStart that comes after session.start's plugins beneath answered: the start waits for it", async ($, on) => {
  // The mod's own start held up meanwhile (its first write waits), so only the SessionStart can end the wait
  let open = () => {}
  const held = new Promise<void>(r => (open = r))
  on('state.set', async (_: any, e: any, next: any) => {
    if (e.plugin === 'sessions' && e.key === 'shortId') await held
    return next(e)
  })
  const t = setup(on)
  t.w.files.set(`${ROOT}/.claude/agents/lead.md`, '---\nname: lead\ntools: mcp__sessions__wake\n---\n')
  let done = false
  const start = $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true }).then(() => (done = true))
  await t.w.clock.advance(20)
  expect(done).toBe(false)
  await $.classic.SessionStart({ source: 'startup', session_id: SID, agent_type: 'lead' } as any)
  await t.w.clock.advance(10)
  expect(done).toBe(true)
  await start
  expect(t.registered.map(r => r.name)).toEqual(['wake'])
  open()
})

// ---- No SessionStart at a fresh start: a plugin that runs before this one (a managed or built-in one) sends
// classic.SessionStart on past it, at every start ----

// This session's entry in Claude's registry of running sessions, as Claude writes it (agent: the one it runs as, absent
// with none)
function registryEntry(t: Setup, extra: Record<string, unknown> = {}) {
  t.w.files.set('/Users/x/.claude/sessions/4242.json', JSON.stringify({ pid: 4242, sessionId: SID, cwd: ROOT, kind: 'bg', jobId: 'aaaaaaaa', status: 'idle', ...extra }))
}
// One line of /sessions status, by how it starts
async function statusLine($: any, head: string): Promise<string> {
  const status: any = await $.command.run({ command: 'sessions', args: 'status', ...COMMAND })
  return String(status.text).split('\n').find(l => l.startsWith(head)) ?? `no line starts with ${head}`
}

test('agentFromFlags: --agent <name> or --agent=<name> among a job\'s respawnFlags; a name or settings text is never read as one', () => {
  expect(agentFromFlags(['--settings', '{"enabledPlugins":{}}', '-n', 'lead', '--agent', 'probe', '--model', 'opus[1m]'])).toBe('probe')
  expect(agentFromFlags(['-n', 'lead', '--agent=lead'])).toBe('lead')
  expect(agentFromFlags(['-n', '--agent', '--model', 'opus'])).toBe(null)
  expect(agentFromFlags(['--plugin-dir', '/Users/x/p', '--permission-mode', 'auto', '--name', 'x'])).toBe(null)
  expect(agentFromFlags([])).toBe(null)
})

test("the registry's agent: a session's entry says the agent it runs as, and none when it has none", () => {
  const entry = (extra: Record<string, unknown>) => (parseRegistry(JSON.stringify({ pid: 1, sessionId: SID, cwd: ROOT, kind: 'bg', ...extra })) as any).entry
  expect(entry({ agent: 'lead' }).agent).toBe('lead')
  expect(entry({}).agent).toBeUndefined()
  expect(entry({ agent: '' }).agent).toBeUndefined()
})

test("no SessionStart at a fresh start: the agent from Claude's registry, the tools offered, the status says why and no u", async ($, on) => {
  const t = setup(on)
  registryEntry(t)
  await startSession($, t.w)
  await t.w.clock.advance(100)
  expect(t.registered.map(r => r.name)).toEqual(['list', 'wake'])
  expect(await statusLine($, 'Tools for Claude:')).toBe(
    "Tools for Claude: mcp__sessions__list, mcp__sessions__wake (no agent; from Claude's registry of sessions, since no SessionStart reached the mod)",
  )
  const live = await statusLine($, 'Not live:')
  expect(live).toContain('Not live: no SessionStart reached the mod in this session: a plugin that runs before sessions (such as a managed or built-in one) sent it on past it')
  expect(live).toContain("which a restart doesn't change")
  expect(live).toContain('reads them every 3 s')
  expect(live).not.toContain('updated in place')
  expect(live).not.toContain('(u)')
  // This machine remembers, once it's clear none is coming, so its next starts don't wait for one
  expect(t.w.store.get('startSkipped')).toBeUndefined()
  await t.w.clock.advance(10000)
  expect(typeof (t.w.store.get('startSkipped') as any)?.at).toBe('number')
})

test("no SessionStart: an agent the registry names decides as SessionStart's would; one whose file lists the tools gets them", async ($, on) => {
  const t = setup(on)
  registryEntry(t, { agent: 'lead' })
  t.w.files.set(`${ROOT}/.claude/agents/lead.md`, '---\nname: lead\ntools: Read, SendMessage, mcp__sessions__*\n---\nLead.\n')
  await startSession($, t.w)
  await t.w.clock.advance(100)
  expect(t.registered.map(r => r.name)).toEqual(['list', 'wake'])
  expect(await statusLine($, 'Tools for Claude:')).toBe(
    "Tools for Claude: mcp__sessions__list, mcp__sessions__wake (agent lead: its agent file's tools: line names mcp__sessions__list and mcp__sessions__wake; from Claude's registry of sessions, since no SessionStart reached the mod)",
  )
})

test("no SessionStart: an agent whose file leaves the tools out gets none, so its start isn't held", async ($, on) => {
  const t = setup(on)
  registryEntry(t, { agent: 'coder' })
  t.w.files.set('/Users/x/.claude/agents/coder.md', '---\nname: coder\ntools: Read, Edit, Bash\n---\nCode.\n')
  // A registration would never answer: the start would wait for it
  t.gate.value = new Promise<void>(() => {})
  let done = false
  const start = $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true }).then(() => (done = true))
  await t.w.clock.settle()
  expect(done).toBe(true)
  await start
  expect(t.registered).toEqual([])
  expect(await statusLine($, 'Tools for Claude:')).toBe(
    "Tools for Claude: not offered: agent coder, its agent file's tools: line doesn't name mcp__sessions__* (from Claude's registry of sessions, since no SessionStart reached the mod)",
  )
})

test("no SessionStart: a background job's --agent wins over a registry entry that names none", async ($, on) => {
  const t = setup(on)
  registryEntry(t)
  t.w.files.set('/Users/x/jobs/aaaaaaaa/state.json', JSON.stringify({ sessionId: SID, cwd: ROOT, respawnFlags: ['-n', 'lead', '--agent', 'coder', '--model', 'opus[1m]'] }))
  t.w.files.set('/Users/x/.claude/agents/coder.md', '---\nname: coder\ntools: Read\n---\n')
  await startSession($, t.w)
  await t.w.clock.advance(100)
  expect(t.registered).toEqual([])
  expect(await statusLine($, 'Tools for Claude:')).toContain("not offered: agent coder, its agent file's tools: line doesn't name mcp__sessions__* (from its background job's flags")
})

test('no SessionStart and nothing on disk says the agent: taken as no agent, registered without holding the start', async ($, on) => {
  const t = setup(on)
  let open = () => {}
  t.gate.value = new Promise<void>(r => (open = r))
  let done = false
  const start = $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true }).then(() => (done = true))
  await t.w.clock.settle()
  expect(done).toBe(true)
  await start
  open()
  await t.w.clock.advance(100)
  expect(t.registered.map(r => r.name)).toEqual(['list', 'wake'])
  expect(await statusLine($, 'Tools for Claude:')).toBe(
    "Tools for Claude: mcp__sessions__list, mcp__sessions__wake (taken as no agent, since no SessionStart reached the mod and Claude's files didn't say in time: from the next request on)",
  )
  expect(await statusLine($, 'Not live:')).toContain('Not live: no SessionStart reached the mod in this session')
})

// The mod's own start held up after its first step (its read of the launcher's settings waits), so that only the wait
// for SessionStart, or the machine's memory of none, can end session.start's wait
function holdStart(t: Setup): () => void {
  let open = () => {}
  t.w.readsHeld.set(`${DATA}/config`, new Promise<void>(r => (open = r)))
  return open
}

test('without the memory, a start with no SessionStart waits a second for one', async ($, on) => {
  const t = setup(on)
  const open = holdStart(t)
  registryEntry(t)
  let done = false
  const start = $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true }).then(() => (done = true))
  await t.w.clock.advance(999)
  expect(done).toBe(false)
  await t.w.clock.advance(1)
  expect(done).toBe(true)
  await start
  expect(t.registered.map(r => r.name)).toEqual(['list', 'wake'])
  open()
})

test('a machine whose starts find no SessionStart remembers it: the next start takes the files at once, with no wait', async ($, on) => {
  const t = setup(on, { store: { startSkipped: { at: 1 } } })
  const open = holdStart(t)
  registryEntry(t)
  let done = false
  const start = $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true }).then(() => (done = true))
  await t.w.clock.advance(10)
  expect(done).toBe(true)
  await start
  expect(t.registered.map(r => r.name)).toEqual(['list', 'wake'])
  open()
})

test("a SessionStart that reaches the mod at a process's start: the machine's starts wait for one again", async ($, on) => {
  const t = setup(on, { store: { startSkipped: { at: 1 } } })
  await started($, t)
  expect(t.w.store.has('startSkipped')).toBe(false)
  expect(t.registered.map(r => r.name)).toEqual(['list', 'wake'])
  expect(await statusLine($, 'Tools for Claude:')).toBe('Tools for Claude: mcp__sessions__list, mcp__sessions__wake (no agent)')
})

// What a module before this one left in the session's $.state (a reload keeps it), answered until the mod writes it
function stateSeeds(on: any, seeds: Record<string, unknown>) {
  const left = new Map(Object.entries(seeds))
  on('state.set', (_: any, e: any, next: any) => {
    if (e.plugin === 'sessions') left.delete(e.key)
    return next(e)
  })
  on('state.get', (_: any, e: any, next: any) => (e.plugin === 'sessions' && left.has(e.key) ? { value: { value: left.get(e.key), version: 1 } } : next(e)))
}

// A reload where the module before this one drew (its shortId stays), recorded no agent, and no SessionStart comes
test("updated in place with no agent recorded: none in Claude's registry, the tools come in the background", async ($, on) => {
  stateSeeds(on, { shortId: 'aaaaaaaa' })
  const t = setup(on)
  registryEntry(t)
  // The registration answers only later: session.start isn't held for it
  let open = () => {}
  t.gate.value = new Promise<void>(r => (open = r))
  let done = false
  const start = $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true }).then(() => (done = true))
  await t.w.clock.settle()
  expect(done).toBe(true)
  await start
  open()
  await t.w.clock.advance(100)
  expect(t.registered.map(r => r.name)).toEqual(['list', 'wake'])
  const status: any = await $.command.run({ command: 'sessions', args: 'status', ...COMMAND })
  expect(String(status.text)).toContain('Tools for Claude: mcp__sessions__list, mcp__sessions__wake (no agent, as Claude\'s registry of sessions says; offered after an update in place, from the next request on)')
  // Recorded: the next reload registers them as a start does, awaited for a moment
  await startSession($, t.w)
  expect(t.registered.map(r => r.name)).toEqual(['list', 'wake', 'list', 'wake'])
})

test("updated in place with no agent recorded: an agent in Claude's registry gets none until it restarts", async ($, on) => {
  stateSeeds(on, { shortId: 'aaaaaaaa' })
  const t = setup(on)
  t.w.files.set(`${ROOT}/.claude/agents/lead.md`, '---\nname: lead\ntools: mcp__sessions__*, SendMessage\n---\n')
  registryEntry(t, { agent: 'lead' })
  await startSession($, t.w)
  await t.w.clock.advance(100)
  expect(t.registered).toEqual([])
  const status: any = await $.command.run({ command: 'sessions', args: 'status', ...COMMAND })
  expect(String(status.text)).toContain('Tools for Claude: not offered: agent lead, and no SessionStart reached the mod in this session; a restart (u) offers them')
  // Nothing recorded: another reload decides the same
  await startSession($, t.w)
  await t.w.clock.advance(100)
  expect(t.registered).toEqual([])
})

test("updated in place and Claude's files don't say the agent: nothing registered, said", async ($, on) => {
  stateSeeds(on, { shortId: 'aaaaaaaa' })
  const t = setup(on)
  await startSession($, t.w)
  await t.w.clock.advance(6000)
  expect(t.registered).toEqual([])
  const status: any = await $.command.run({ command: 'sessions', args: 'status', ...COMMAND })
  expect(String(status.text)).toContain('Tools for Claude: not offered: no SessionStart reached the mod in this session (it came in by a reload); a restart (u) offers them')
  // Its own text for not being live: a restart or /clear makes it live
  expect(await statusLine($, 'Not live:')).toContain('Not live: this session was updated in place from a version that watched other files; it reads them every 3 s until it restarts (u) or is cleared (/clear)')
})

test('updated in place on a machine whose starts find no SessionStart: the status says so, and neither it nor the panel names u', async ($, on) => {
  stateSeeds(on, { shortId: 'aaaaaaaa' })
  const t = setup(on, { store: { startSkipped: { at: 1 } } })
  await startSession($, t.w)
  await t.w.clock.advance(100)
  const live = await statusLine($, 'Not live:')
  expect(live).toContain('Not live: no SessionStart reached the mod in this session: a plugin that runs before sessions')
  expect(live).not.toContain('(u)')
  const ui = await $.ui.mount(PANEL)
  expect(JSON.stringify(await ui.drawn())).not.toContain('Live updates off')
  await ui.unmount()
})

test("the agent comes from the SessionStart inside session.start's plugins beneath, as in a session", async ($, on) => {
  // Beneath the mod, as the engine raises it: SessionStart inside session.start
  const t = setup(on, { onStart: async () => void (await $.classic.SessionStart({ source: 'startup', session_id: SID, agent_type: 'coder' } as any)) })
  t.w.files.set(`${ROOT}/.claude/agents/coder.md`, '---\nname: coder\ntools: Read\n---\n')
  await startSession($, t.w)
  expect(t.registered).toEqual([])
})

// ---- mcp__sessions__list ----

test("mcp__sessions__list: one line per other session of the project, by Claude's name, with why it stopped and whether it wakes", async ($, on) => {
  const t = setup(on)
  await started($, t)
  expect((await listed($, t)).result).toBe(
    [
      `This project's other sessions (${ROOT}), by the name ListAgents and SendMessage know them:`,
      '- “runner” · 11111111 · idle · wake: no (it runs)',
      '- “worker a” · dddddddd · stopped: retired for being idle 2 h ago · wake: yes · runs as agent reviewer',
      '- “worker b” · eeeeeeee · stopped by the person 2 h ago · wake: no (“worker b” was stopped by the person: only they restart it (Enter or u in the panel))',
      '- “memory one” · ffffffff · stopped: closed for lack of memory 2 h ago · wake: yes',
      "- “mystery” · 22222222 · stopped, and nothing says why · wake: no (nothing says why “mystery” stopped (no idle retirement, crash or restart in the background service's log): only the person restarts it (Enter or u in the panel))",
      '- “myapp-1f” · regular session · working · wake: no (it runs)',
      'Running ones take SendMessage. SendMessage to a stopped one fails at once: one with "wake: yes" takes mcp__sessions__wake first (session: its name or short id), which says the name to SendMessage to.',
    ].join('\n'),
  )
})

test('mcp__sessions__list while memory is short, and past a limit: wake: no, with why', async ($, on) => {
  const now = T0 + 100
  const t = setup(on, { store: { modelWakes: [1, 2, 3].map(i => ({ at: now - i * 60000, by: `zz${i}`, target: IDLE })) } })
  await started($, t)
  const text = String((await listed($, t)).result)
  expect(text).toContain('“worker a” · dddddddd · stopped: retired for being idle 2 h ago · wake: no (“worker a” was woken 3 times in the last hour (it may fail to start): it can be woken again at')
  t.w.memory.value = '4'
  const short = String((await listed($, t)).result)
  expect(short).toContain('“memory one” · ffffffff · stopped: closed for lack of memory 2 h ago · wake: no (Claude closed “memory one” for lack of memory, and memory is still short)')
  expect(short).toContain("“worker a” · dddddddd · stopped: retired for being idle 2 h ago · wake: no (memory is short on this computer, and no session is woken until it's normal again)")
  // A stop of the person's is said as such, memory or not
  expect(short).toContain('“worker b” · eeeeeeee · stopped by the person 2 h ago · wake: no (“worker b” was stopped by the person')
})

test('mcp__sessions__list with no other session, and before the panel read the list', async ($, on) => {
  const t = setup(on, { list: [sessions()[0]] })
  expect(await denied(listed($, t))).toBe("the sessions panel hasn't read the session list in this session yet: try again in a few seconds")
  await started($, t)
  expect((await listed($, t)).result).toBe(`This project (${ROOT}) has no other sessions.`)
})

// ---- mcp__sessions__wake ----

test('mcp__sessions__wake: a retired session comes back through the wake queue, once; the answer names it for SendMessage', async ($, on) => {
  const t = setup(on)
  await started($, t)
  expect(await wake($, t, 'worker a')).toEqual({ result: WOKE })
  expect(t.respawned).toEqual(['dddddddd'])
  expect(t.w.toasts).toContain("Woke “worker a” for this session's Claude")
  // Counted in the store every session shares; its claim went once it ran
  expect(t.w.store.get('modelWakes')).toEqual([{ at: expect.any(Number), by: SID, target: IDLE }])
  expect(t.w.store.get('broughtBack')).toEqual({})
  // Once it runs: already running, no second respawn
  expect(await wake($, t, 'dddddddd')).toEqual({ result: '“worker a” already runs: SendMessage to "worker a [ab12cd]" (the [ref] changes at each restart).' })
  expect(t.respawned).toEqual(['dddddddd'])
})

test("woken: “woken by …” under its row in every panel for 15 minutes, then gone", SLOW, async ($, on) => {
  const t = setup(on)
  await started($, t)
  await wake($, t, 'worker a')
  const mark: any = t.w.store.get(`marks:sessions:${IDLE}`)
  expect(mark.rows).toEqual({ dddddddd: { line: 'woken by “lead”', tint: 'suggestion' } })
  expect(mark.until - mark.at).toBe(900000)
  await t.w.clock.advance(4000)
  const drawn = async () => {
    const ui = await $.ui.mount(PANEL)
    const text = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return text
  }
  expect(await drawn()).toContain('woken by “lead”')
  await t.w.clock.advance(900000 + 70000)
  expect(t.w.store.has(`marks:sessions:${IDLE}`)).toBe(false)
  expect(await drawn()).not.toContain('woken by')
})

test("a session slow to come up: the restart is asked, and the answer says to list again", async ($, on) => {
  const t = setup(on)
  t.up.value = false
  await started($, t)
  expect(await wake($, t, 'worker a')).toEqual({ result: "Restart of “worker a” asked (it was retired for being idle 2 h ago), and it isn't running yet: call mcp__sessions__list in a few seconds, then SendMessage to it." })
  expect(t.respawned).toEqual(['dddddddd'])
  // Its claim stays (two minutes): a second call meanwhile doesn't restart it again
  expect(t.w.store.get('broughtBack')).toEqual({ [IDLE]: expect.any(Number) })
  expect(await denied(wake($, t, 'worker a'))).toBe('Not woken: another session or panel is bringing “worker a” back right now: call mcp__sessions__list in a minute.')
  expect(t.respawned).toEqual(['dddddddd'])
})

test("without ListAgents (its permission check doesn't allow it, or no row has the name): the name alone", async ($, on) => {
  const t = setup(on)
  const plain = t.check.value
  t.check.value = e => (e.tool === 'ListAgents' ? { decision: 'ask' } : plain(e))
  await started($, t)
  expect((await wake($, t, 'worker a')).result).toContain('It runs now: SendMessage to "worker a" (the [ref] changes at each restart).')
  // Never called: the call would have put a question to the person (its own permission check, the one a call raises,
  // carries the call's id)
  expect(t.agentCalls.value).toBe(0)
  expect(t.checks.filter(c => c.tool === 'ListAgents').length).toBe(1)
  expect(t.checks.some(c => c.tool === 'ListAgents' && c.tool_use_id)).toBe(false)
  t.check.value = plain
  t.agents.value = [{ name: 'runner', ref: '111111' }, { name: 'runner', ref: '222222' }]
  expect((await wake($, t, 'runner')).result).toBe('“runner” already runs: SendMessage to "runner" (the [ref] changes at each restart).')
})

test("refused: the person's stop, no evidence, a regular session, another project, this session, unknown and ambiguous names", async ($, on) => {
  const list = [...sessions(), { id: '33333333', sessionId: '33333333-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'idle', pid: 4250, name: 'runner' }]
  const t = setup(on, { list })
  await started($, t)
  expect(await denied(wake($, t, 'worker b'))).toBe('Not woken: “worker b” was stopped by the person: only they restart it (Enter or u in the panel).')
  expect(await denied(wake($, t, 'mystery'))).toBe("Not woken: nothing says why “mystery” stopped (no idle retirement, crash or restart in the background service's log): only the person restarts it (Enter or u in the panel).")
  expect(await denied(wake($, t, 'myapp-1f'))).toBe('Not woken: “myapp-1f” is a regular session: it lives in its own window.')
  expect(await denied(wake($, t, 'elsewhere'))).toBe("“elsewhere” belongs to another project: mcp__sessions__wake wakes only this project's sessions.")
  expect(await denied(wake($, t, 'bbbbbbbb'))).toBe("“bbbbbbbb” belongs to another project: mcp__sessions__wake wakes only this project's sessions.")
  expect(await denied(wake($, t, 'lead'))).toBe('“lead” is this very session.')
  expect(await denied(wake($, t, 'nobody'))).toBe(
    'No session of this project is called “nobody”. This project\'s other sessions: “runner” (11111111), “worker a” (dddddddd), “worker b” (eeeeeeee), “memory one” (ffffffff), “mystery” (22222222), “myapp-1f” (regular session), “runner” (33333333).',
  )
  expect(await denied(wake($, t, 'runner'))).toBe('Several sessions of this project match “runner”: “runner” (11111111), “runner” (33333333). Call again with the short id.')
  expect(await denied(wake($, t, ''))).toBe('session: the name or short id of a session of this project, as mcp__sessions__list shows it')
  expect(await denied(wake($, t, 42))).toBe('session: the name or short id of a session of this project, as mcp__sessions__list shows it')
  expect(t.respawned).toEqual([])
})

test('refused while memory is short: any wake, not only a session closed for lack of memory', async ($, on) => {
  const t = setup(on)
  await started($, t)
  t.w.memory.value = '4'
  expect(await denied(wake($, t, 'worker a'))).toBe("Not woken: memory is short on this computer, and no session is woken until it's normal again.")
  expect(await denied(wake($, t, 'memory one'))).toBe('Not woken: Claude closed “memory one” for lack of memory, and memory is still short.')
  t.w.memory.value = '1'
  expect((await wake($, t, 'memory one')).result).toContain('Woke “memory one” (closed for lack of memory 2 h ago)')
  expect(t.respawned).toEqual(['ffffffff'])
})

test('refused from a subagent or a teammate: the main conversation only', async ($, on) => {
  const t = setup(on)
  await started($, t)
  expect(await denied(wake($, t, 'worker a', { agentId: 'a1' }))).toBe('mcp__sessions__wake answers only the main conversation, not a subagent or a teammate')
  expect(await denied(listed($, t, { agentId: 'a1' }))).toBe('mcp__sessions__list answers only the main conversation, not a subagent or a teammate')
  expect(t.respawned).toEqual([])
})

test("refused in place of the question an ask rule wants (the call is never put to the person); a plain ask isn't a rule", async ($, on) => {
  const t = setup(on)
  const plain = t.check.value
  t.check.value = e => (e.tool === 'mcp__sessions__wake' ? { decision: 'ask', rule: 'mcp__sessions__wake' } : plain(e))
  await started($, t)
  expect(await denied(wake($, t, 'worker a'))).toBe(
    "a permission rule (mcp__sessions__wake) asks the person before mcp__sessions__wake runs, and this tool can't put that question to them, so nothing was done: ask the person to do it, or to change that rule",
  )
  expect(t.respawned).toEqual([])
  expect(t.checks.at(-1)).toEqual({ tool: 'mcp__sessions__wake', input: { session: 'worker a' } })
  t.check.value = e => (e.tool === 'mcp__sessions__list' ? { decision: 'ask', rule: 'mcp__sessions' } : plain(e))
  expect(await denied(listed($, t))).toContain('a permission rule (mcp__sessions) asks the person before mcp__sessions__list runs')
  t.check.value = e => (e.tool === 'mcp__sessions__wake' ? { decision: 'deny', reason: 'a hook said no' } : plain(e))
  expect(await denied(wake($, t, 'worker a'))).toBe('refused by a permission check: a hook said no')
  // An ask with no rule (default mode, nothing granted yet) is what every call gets: the wake goes
  t.check.value = e => (e.tool === 'mcp__sessions__wake' ? { decision: 'ask', reason: "you haven't granted it yet" } : plain(e))
  expect(await wake($, t, 'worker a')).toEqual({ result: WOKE })
})

test('refused past the limits: 6 wakes per caller in 10 minutes, 20 in an hour, 3 per session in an hour; said with when', async ($, on) => {
  const now = T0 + 100
  // The oldest of the six 5.5 minutes ago: this session can wake again in 4.5 minutes
  const t = setup(on, { store: { modelWakes: [1, 2, 3, 4, 5, 6].map(i => ({ at: now - i * 55000, by: SID, target: `t${i}` })) } })
  await started($, t)
  expect(await denied(wake($, t, 'worker a'))).toMatch(/^Not woken: this session already asked for 6 wakes in the last 10 min: it can wake one again at \d\d:\d\d \(in 4 min\)\.$/)
  expect(t.respawned).toEqual([])
  // Another caller's wakes don't count against this one
  t.w.store.set('modelWakes', [1, 2, 3, 4, 5, 6].map(i => ({ at: now - i * 60000, by: 'another-session', target: `t${i}` })))
  expect((await wake($, t, 'worker a')).result).toBe(WOKE)
  const at = t.w.clock.now()
  t.w.store.set('modelWakes', Array.from({ length: 20 }, (_, i) => ({ at: at - 11 * 60000 - i * 60000, by: SID, target: `t${i}` })))
  expect(await denied(wake($, t, 'memory one'))).toContain('this session already asked for 20 wakes in the last 60 min')
  t.w.store.set('modelWakes', [1, 2, 3].map(i => ({ at: at - i * 60000 + 30000, by: `zz${i}`, target: MEMORY })))
  expect(await denied(wake($, t, 'memory one'))).toMatch(/^Not woken: “memory one” was woken 3 times in the last hour \(it may fail to start\): it can be woken again at \d\d:\d\d \(in 57 min\)\.$/)
  expect(t.respawned).toEqual(['dddddddd'])
})

test("claimed under the lock with the panel's b: a claim another session or panel holds refuses, an old one doesn't", async ($, on) => {
  const now = T0 + 100
  const t = setup(on, { store: { broughtBack: { [IDLE]: now - 1000 } } })
  await started($, t)
  expect(await denied(wake($, t, 'worker a'))).toBe('Not woken: another session or panel is bringing “worker a” back right now: call mcp__sessions__list in a minute.')
  expect(t.respawned).toEqual([])
  // Two minutes on, the claim is gone
  t.w.store.set('broughtBack', { [IDLE]: t.w.clock.now() - 121000, [MEMORY]: t.w.clock.now() })
  expect((await wake($, t, 'worker a')).result).toBe(WOKE)
  // Its own claim released, another's left as it was
  expect(t.w.store.get('broughtBack')).toEqual({ [MEMORY]: expect.any(Number) })
})

test('two wakes at once of the same session: one restart; the other hears it runs or is being brought back', async ($, on) => {
  const t = setup(on)
  await started($, t)
  const one = $.tool.call({ tool: 'mcp__sessions__wake', session: 'worker a' } as any)
  const two = $.tool.call({ tool: 'mcp__sessions__wake', session: 'dddddddd' } as any)
  await t.w.clock.advance(6000)
  const answers = [await one, await two].map((r: any) => String(r.result ?? r.deny))
  expect(answers.filter(a => a === WOKE).length).toBe(1)
  expect(answers.find(a => a !== WOKE)).toMatch(/already runs|bringing “worker a” back right now/)
  expect(t.respawned).toEqual(['dddddddd'])
})

test('a session started meanwhile (Enter in a panel, between the check and the claim): it runs, and is not restarted', async ($, on) => {
  const t = setup(on)
  await started($, t)
  t.atLock.value = () => {
    const s = t.list.find(x => x.id === 'dddddddd')
    if (s && !s.pid) Object.assign(s, { pid: 6000, status: 'idle' })
  }
  expect(await wake($, t, 'worker a')).toEqual({ result: '“worker a” already runs: SendMessage to "worker a [ab12cd]" (the [ref] changes at each restart).' })
  expect(t.respawned).toEqual([])
  expect(t.w.store.get('modelWakes')).toBe(undefined)
})

test("the lock held elsewhere: refused, try again", async ($, on) => {
  const t = setup(on)
  await started($, t)
  // Another session holds <data>/bringback.lock, fresh
  t.w.dirs.add('/Users/x/.claude/mods/sessions-data/bringback.lock')
  t.w.made.set('/Users/x/.claude/mods/sessions-data/bringback.lock', t.w.clock.now() + 60000)
  expect(await denied(wake($, t, 'worker a'))).toBe('Not woken: another session holds the wake lock: try again in a few seconds.')
  expect(t.respawned).toEqual([])
})

test("before the panel read the list: try again in a few seconds", async ($, on) => {
  const t = setup(on)
  expect(await denied(wake($, t, 'worker a'))).toBe("the sessions panel hasn't read the session list in this session yet: try again in a few seconds")
})

// Whatever order the plugins' tool.call hooks stand in, every plugin's tool.check hook hears the permission check the
// wake asks before it does anything
const KEEPER = {
  name: 'keeper',
  register(on: any) {
    on('tool.check', { tool: 'mcp__sessions__wake' }, async ($: any, e: any, next: any) => (String(e.input?.session).startsWith('worker') ? { decision: 'deny', reason: 'keeper: not this one' } : next(e)))
  },
}
test('another plugin can refuse a wake with a tool.check hook of its own, and let the rest through', { plugins: [KEEPER] }, async ($, on) => {
  const t = setup(on)
  await started($, t)
  expect(await denied(wake($, t, 'worker a'))).toBe('refused by a permission check: keeper: not this one')
  expect(t.respawned).toEqual([])
  expect((await wake($, t, 'memory one')).result).toContain('Woke “memory one”')
})
