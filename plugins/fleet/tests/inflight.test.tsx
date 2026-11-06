import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { FLEET, REF, ROOT, SID, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// A peer's tool write that lands while this session's command runs, in the gap between the file's write and its event
// (B28's last shape): the peer's gate marks the write in flight first (state/writing/), so a command that names the file
// leaves it to the scan, which finds the peer's event. TEST B lands as its fleet would: the mark, the file, the event

const PLAN = `${ROOT}/notes/plan.md`
const OTHER = `${ROOT}/notes/other.md`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const B = { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'TEST B' }
const CURRENT = { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null } }

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

async function begin($: any, w: World) {
  sessionsSay(w, CURRENT)
  await startSession($, w)
  await tick(w, 1100)
  await tick(w)
  await tick(w)
}

const markOf = (rel: string) => `${FLEET}/state/writing/${hashText(rel).slice(1, 17)}-bbbbbbbb-main.json`

function markByB(w: World, rel: string, done: boolean) {
  w.touch(markOf(rel), JSON.stringify({ format: 1, path: rel, sessionId: B_SID, agentId: null, at: w.clock.now(), ...(done ? { done: true } : {}) }))
}

let n = 0
function eventByB(w: World, path: string, from: string, text: string) {
  const rel = path.slice(ROOT.length + 1)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${++n}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path: rel, from: hashText(from), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: B }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}

function eventsOf(w: World, rel: string): any[] {
  return [...w.files.keys()]
    .filter(p => p.startsWith(`${FLEET}/events/`) && /\/\d{4}-\d{2}-\d{2}\/\d{2}\/[^/]+\.json$/.test(p))
    .map(p => JSON.parse(w.files.get(p) as string))
    .filter(e => e.path === rel)
    .sort((a, b) => a.at - b.at)
}

test("B28: a command that names a file isn't credited with a peer's tool write that was in flight while it ran", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [OTHER]: 'other\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  // B's Edit: its mark, then the file; its event comes after this session's post-scan
  w.bash.value = () => {
    markByB(w, 'notes/plan.md', false)
    w.touch(PLAN, 'plan by B edit\n')
  }
  const r: any = await $.tool.call({ tool: 'Bash', command: 'python3 /tmp/x/check.py notes/plan.md' } as any)
  eventByB(w, PLAN, 'plan v1\n', 'plan by B edit\n')
  markByB(w, 'notes/plan.md', true)
  await tick(w, 10000)
  await tick(w, 10000)
  const said = (r.context ?? []).join('\n')
  expect(said).not.toContain('your command changed notes/plan.md')
  // One version, B's: no blind one of this session's beside it
  expect(eventsOf(w, 'notes/plan.md').map(e => `${e.via} ${e.by?.name ?? 'nobody'}`)).toEqual(['tool TEST B'])
})

test('B28: a mark that says the write is done, or one gone stale, leaves a named change to the command as before', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  markByB(w, 'notes/plan.md', true)
  w.bash.value = () => w.touch(PLAN, 'plan by the script\n')
  await $.tool.call({ tool: 'Bash', command: 'python3 /tmp/x/fix.py notes/plan.md' } as any)
  expect(eventsOf(w, 'notes/plan.md').map(e => `${e.via}${e.blind ? ' blind' : ''} ${e.by?.name ?? 'nobody'}`)).toEqual(['bash blind TEST A'])
  // Stale: a mark from long ago that never said done (its session died)
  await tick(w, 60000)
  w.touch(markOf('notes/plan.md'), JSON.stringify({ format: 1, path: 'notes/plan.md', sessionId: B_SID, agentId: null, at: w.clock.now() - 120000 }))
  w.bash.value = () => w.touch(PLAN, 'plan by the script again\n')
  await $.tool.call({ tool: 'Bash', command: 'python3 /tmp/x/fix.py notes/plan.md' } as any)
  expect(eventsOf(w, 'notes/plan.md').map(e => `${e.via}${e.blind ? ' blind' : ''} ${e.by?.name ?? 'nobody'}`)).toEqual(['bash blind TEST A', 'bash blind TEST A'])
})

test("this session's own Write of a shared file is marked in flight while it lands, and done once its event is out", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  const mark = `${FLEET}/state/writing/${hashText('notes/plan.md').slice(1, 17)}-aaaaaaaa-main.json`
  let during: any = null
  w.beforeTool.value = () => {
    during = JSON.parse(w.files.get(mark) ?? 'null')
  }
  expect((await $.tool.call({ tool: 'Write', file_path: PLAN, content: 'plan v2\n' } as any)).deny).toBe(undefined)
  expect(during).toMatchObject({ path: 'notes/plan.md', sessionId: SID, agentId: null })
  expect(during.done).toBe(undefined)
  expect(JSON.parse(w.files.get(mark) as string)).toMatchObject({ path: 'notes/plan.md', done: true })
})

test("B28: a command that writes nothing hears of a change meanwhile only for a file it names; the digest tells the rest", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [OTHER]: 'other\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  await $.tool.call({ tool: 'Read', file_path: OTHER } as any)
  w.bash.value = () => w.touch(PLAN, 'plan by B\n')
  const r: any = await $.tool.call({ tool: 'Bash', command: 'grep -n x notes/other.md' } as any)
  expect((r.context ?? []).join('\n')).not.toContain('notes/plan.md')
  eventByB(w, PLAN, 'plan v1\n', 'plan by B\n')
  await tick(w)
  const next: any = await $.tool.call({ tool: 'Read', file_path: OTHER } as any)
  expect((next.context ?? []).join('\n')).toContain('notes/plan.md')
})
