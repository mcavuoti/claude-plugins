import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { BAND, FLEET, REF, ROOT, SID, decide, fleet, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// The guard for a busy session with no debug window (the idle hour's guard is in f0150.test.tsx): scripted work (three
// turns, each with a check, two Reads, a Write, two Bash commands, a question, a permission prompt; landings and bells
// from another session; a band draw; /fleet status and /fleet), and what fleet asked of the engine meanwhile. The
// review of the meter ran this same script on the code before the meter (e17f869: sessions' debug-perf with fleet
// 0.14.3) and on the meter's branch, and found them identical, path by path and atom by atom. Those numbers are held
// here: file and command calls, $.state calls and timer callbacks. With no window fleet does exactly that, but for one
// $.state write (its read and its write) at the proof of the watch: sessions' debug path, kept for a module that comes
// in by a reload.
// Placeholders only: /Users/x/proj, ids aaaaaaaa and bbbbbbbb, made-up names.

declare const console: { log: (...a: unknown[]) => void }

const MIN = 60000
const SECOND = 1000
const STATE = `${FLEET}/state`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }
const NOTE = `${ROOT}/notes/a.md`
const OTHER = `${ROOT}/notes/b.md`
const LONG = { ...WITH_SESSIONS, timeoutMs: 240000 }
const LATEST = `${FLEET}/events/latest`
const ROSTER = {
  rosterFormat: 1,
  sections: [{ id: 'owners', title: 'Owners' }],
  roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 } } },
  instances: [
    { name: 'Owner A', role: 'owner', section: 'owners', brief: 'You own notes/a.' },
    { name: 'Owner B', role: 'owner', section: 'owners', parent: 'Owner A' },
  ],
  budget: { usdDay: 5 },
}
const PROJECT = {
  [`${FLEET}/roster.json`]: JSON.stringify(ROSTER),
  [`${ROOT}/.claude/agents/owner.md`]: '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, mcp__fleet__*\n---\nYou own a part of the notes.\n',
  [`${FLEET}/seeds/owner.md`]: 'Read the charter, then plan your part ({name}).',
}

async function tick(w: World, ms = 2100) {
  for (let left = ms; left > 0; left -= MIN) {
    await w.clock.advance(Math.min(left, MIN))
    await w.clock.settle()
  }
}
function otherSweeps(w: World) {
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner B', at: w.clock.now(), remote: null }))
}
const GIT = (argv: string[]) => (argv[0] === 'git' ? { exitCode: 128, stdout: '', stderr: 'not a git repository' } : undefined)

type Kind = 'person' | 'instance'
function session(on: any, kind: Kind): { w: World; state: Map<string, number> } {
  const w =
    kind === 'instance'
      ? world(on, { worldPaths: ['notes/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' }, files: { ...PROJECT, [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n', [NOTE]: 'a\n', [OTHER]: 'b\n' } })
      : world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT, [NOTE]: 'a\n', [OTHER]: 'b\n' } })
  const state = new Map<string, number>()
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.25 } } }))
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  on('state.get' as any, (_: any, e: any, next: any) => {
    const key = `get ${e?.ref?.key ?? e?.key}`
    state.set(key, (state.get(key) ?? 0) + 1)
    return next(e)
  })
  on('state.set' as any, (_: any, e: any, next: any) => {
    const key = `set ${e?.ref?.key ?? e?.key}`
    state.set(key, (state.get(key) ?? 0) + 1)
    return next(e)
  })
  w.exec.value = GIT
  sessionsSay(w, { current: kind === 'instance' ? CURRENT : undefined, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  return { w, state }
}
async function changed($: any, path: string, event = 'change') {
  await $.classic.FileChanged({ file_path: path, event } as any)
}
let eventN = 0
let stampN = 0
function land(w: World, path: string, text: string, via = 'tool'): string {
  const before = w.files.get(path) ?? ''
  w.touch(path, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${++eventN}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path: path.slice(ROOT.length + 1), from: hashText(before), to: hashText(text), via, tool: 'Edit', blind: false, by: { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'Owner B' } }))
  let chain: string[] = []
  try {
    const cur = JSON.parse(w.files.get(LATEST) ?? '{}')
    chain = Array.isArray(cur.chain) ? cur.chain : cur.last ? [cur.last] : []
  } catch {}
  w.touch(LATEST, JSON.stringify({ format: 1, last: name, chain: [...chain, name].slice(-32) }), w.clock.now() - 1 + (++stampN % 900) / 1000)
  return name
}
async function idle(w: World, minutes: number, sweeps: 'other' | 'me') {
  for (let i = 0; i < minutes * 3; i++) {
    if (sweeps === 'other') otherSweeps(w)
    await tick(w, 20 * SECOND)
  }
}

// What fleet asked of the engine, with what differs from one load of the module to the next taken out of the paths
// (the temporary files' names, an event's name) and the stand-in for sessions left out
function asked(w: World, state: Map<string, number>) {
  const kinds: Record<string, number> = {}
  const paths: Record<string, number> = {}
  for (const [k, n] of w.ops) {
    if (k.includes(' /fake/')) continue
    const kind = k.slice(0, k.indexOf(' '))
    kinds[kind] = (kinds[kind] ?? 0) + n
    const plain = k
      .replace(/\/decisions\/tmp\/\S+/g, '/decisions/tmp/*')
      .replace(/\/events\/(\d{4}-\d{2}-\d{2}\/\d{2})\/\S+/g, '/events/$1/*')
      .replace(/\/state\/revs\/\S+/g, '/state/revs/*')
      .replace(/\/state\/writing\/\S+/g, '/state/writing/*')
    paths[plain] = (paths[plain] ?? 0) + n
  }
  const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return { kinds: sorted(kinds), state: sorted(Object.fromEntries(state)), timers: sorted(Object.fromEntries(w.timerCount)), paths: sorted(paths) }
}

// The same script on the code before the meter: file and command calls, $.state calls, timer callbacks
const BEFORE_THE_METER = { instance: { calls: 1230, state: 1176, timers: 122 }, sweeper: { calls: 1901, state: 781, timers: 146 } }

for (const who of ['instance', 'sweeper'] as const) {
  test(`no window, a working ${who === 'sweeper' ? 'sweeping session' : 'instance'}: the calls and timers of the code before the meter, and one $.state write more (the debug path, at the proof of the watch)`, LONG, async ($, on) => {
    const { w, state } = session(on, who === 'instance' ? 'instance' : 'person')
    const sweeps = who === 'sweeper' ? 'me' : 'other'
    if (who !== 'sweeper') otherSweeps(w)
    await startSession($, w)
    await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
    await tick(w, 1500)
    await changed($, `${FLEET}/bell/probe`)
    await idle(w, 3, sweeps)
    for (let round = 0; round < 3; round++) {
      await $.prompt.submit({ text: `work on it ${round}`, origin: { kind: 'composer' } } as any).catch(() => {})
      await $.turn.start({ text: `work on it ${round}`, turnId: `t${round}` })
      await $.tool.check({ tool: 'Read', input: { file_path: NOTE }, tool_use_id: `u${round}` } as any).catch(() => {})
      await $.tool.call({ tool: 'Read', file_path: NOTE } as any)
      await $.tool.call({ tool: 'Write', file_path: NOTE, content: `mine ${round}\n` } as any)
      await $.tool.call({ tool: 'Bash', command: 'ls notes' } as any).catch(() => {})
      await $.tool.call({ tool: 'Bash', command: `echo ${round} > notes/c.md` } as any).catch(() => {})
      await $.tool.call({ tool: 'Read', file_path: OTHER } as any)
      if (who === 'instance') await decide($, { questions: [{ question: `Go ${round}?`, header: 'Go', options: [{ label: 'Yes', description: 'go' }, { label: 'No', description: 'wait' }], multiSelect: false }] } as any).catch(() => {})
      await $.classic.PermissionRequest({ tool_name: 'Bash' } as any).catch(() => {})
      await $.classic.PostToolUse({ tool_name: 'Read' } as any).catch(() => {})
      await $.turn.complete({ turnId: `t${round}`, answer: 'done', reason: 'answer' } as any)
      land(w, OTHER, `theirs ${round}\n`)
      await changed($, LATEST)
      w.touch(`${FLEET}/bell/work`, '{}')
      await changed($, `${FLEET}/bell/work`)
      await changed($, `${FLEET}/decisions/queue/D-9.json`)
      await changed($, `${FLEET}/decisions/answers/D-9.1.json`)
      for (const kind of ['runs', 'restart', 'budget']) await changed($, `${FLEET}/bell/${kind}`)
      await $.ui.render(BAND as any).catch(() => {})
      await fleet($, 'status')
      await fleet($, '')
      await idle(w, 2, sweeps)
    }
    const a = asked(w, state)
    const total = (o: Record<string, number>) => Object.values(o).reduce((x, y) => x + y, 0)
    console.log(`F0150 busy ${who} ${JSON.stringify({ calls: total(a.kinds), state: total(a.state), timers: total(a.timers) })}`)
    expect({ calls: total(a.kinds), timers: total(a.timers) }).toEqual({ calls: BEFORE_THE_METER[who].calls, timers: BEFORE_THE_METER[who].timers })
    // The one $.state write more (an update: its read and its write): the debug path kept at the proof of the watch
    expect(Object.fromEntries(Object.entries(a.state).filter(([k]) => k.includes('debug')))).toEqual({ 'get debugPath': 1, 'set debugPath': 1 })
    expect(total(a.state) - 2).toBe(BEFORE_THE_METER[who].state)
  })
}
