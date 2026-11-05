import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, under, world, type World, WITH_SESSIONS } from './world'

// Who a change is credited to when more than one command may have made it, a command that names a file a peer's command
// names too, the scan waiting on a long command, and confirmations against a record that moved only editorially since:
// in one session (TEST A, the project's sweeper), with the engine's tools and shell beneath fleet; TEST B and TEST C land,
// run and finish commands as their fleet would (their files, events and reads files)

const STATE = `${FLEET}/state`
const PLAN = `${ROOT}/notes/plan.md`
const TODO = `${ROOT}/notes/todo.md`
const R1 = `${ROOT}/req/R-1.md`
const PA = `${ROOT}/notes/plan-a.md`
const PB = `${ROOT}/notes/plan-b.md`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const C_SID = 'cccccccc-0000-0000-0000-000000000000'
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

let n = 0
function landByB(w: World, path: string, text: string, rev?: number, kind = 'revision') {
  const rel = path.slice(ROOT.length + 1)
  const id = /^[A-Z]+-\d+/.exec(rel.slice(rel.lastIndexOf('/') + 1))?.[0]
  const before = w.files.get(path)
  w.touch(path, text)
  const at = w.clock.now()
  if (id && rev) w.touch(`${STATE}/revs/${id}/${rev}.json`, JSON.stringify({ format: 1, id, path: rel, rev, hash: hashText(text), kind, changeHash: null, at, by: B, via: 'tool', pins: [] }))
  const name = `${at}-bbbbbbbb-${++n}.json`
  const event = { format: 1, at, path: rel, from: before === undefined ? null : hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: B, ...(id && rev ? { id, rev, kind } : {}) }
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify(event))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}

/** A peer's reads file: what it runs now, what it finished lately */
function readsOf(w: World, sid: string, name: string, extra: Record<string, unknown>) {
  w.touch(`${FLEET}/reads/${sid}.json`, JSON.stringify({ format: 1, sessionId: sid, ref: sid.slice(0, 8), name, at: w.clock.now(), threads: {}, ...extra }))
}

function events(w: World): any[] {
  return [...w.files.keys()]
    .filter(p => p.startsWith(`${FLEET}/events/`) && /\/\d{4}-\d{2}-\d{2}\/\d{2}\/[^/]+\.json$/.test(p))
    .map(p => JSON.parse(w.files.get(p) as string))
    .sort((a, b) => a.at - b.at)
}

function of(w: World, path: string): any[] {
  return events(w).filter(e => e.path === path)
}

async function call($: any, input: Record<string, unknown>): Promise<any> {
  return $.tool.call(input as any)
}

function suspects(w: World): string[] {
  return (json(w, `${STATE}/suspects.json`)?.suspects ?? []).map((s: any) => s.path)
}

test("B5: a change two sessions' commands may have made is nobody's (outside fleet, both named); a finished run counts as long as the scan waited on another command", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [TODO]: 'todo v1\n' } })
  await begin($, w)
  // TEST B finished a command a moment ago and TEST C runs one in the background: both ran when todo.md changed
  w.touch(TODO, 'todo by someone\n')
  const at = w.clock.now()
  readsOf(w, B_SID, 'TEST B', { finished: [{ thread: 'main', at: at - 2000, end: at + 500 }] })
  readsOf(w, C_SID, 'TEST C', { running: [{ thread: 'main', at: at - 60000, task: 'bg1', command: 'make test' }] })
  await tick(w, 10000)
  await tick(w, 10000)
  const ev = of(w, 'notes/todo.md').at(-1)
  expect(ev).toMatchObject({ via: 'outside', by: null })
  expect(ev.candidates.map((c: any) => c.name).sort()).toEqual(['TEST B', 'TEST C'])
  expect(await fleet($, 'status')).toContain('notes/todo.md (commands of TEST B or TEST C ran then)')
  // TEST C's background command alone (TEST B's run ended long ago): probably TEST C's
  await tick(w, 61000)
  readsOf(w, B_SID, 'TEST B', { finished: [{ thread: 'main', at: at - 2000, end: at + 500 }] })
  readsOf(w, C_SID, 'TEST C', { running: [{ thread: 'main', at: at - 60000, task: 'bg1', command: 'make test' }] })
  w.touch(TODO, 'todo again\n')
  await tick(w, 10000)
  await tick(w, 10000)
  expect(of(w, 'notes/todo.md').at(-1)).toMatchObject({ via: 'bash', probably: true, by: { sessionId: C_SID } })
  // TEST B's command changed plan.md without naming it while TEST C ran a long foreground command: the scan waits for
  // TEST C's; by then TEST B's run ended over a minute ago, and it still counts
  readsOf(w, C_SID, 'TEST C', {})
  w.touch(PLAN, 'plan by B’s script\n')
  const t = w.clock.now()
  readsOf(w, B_SID, 'TEST B', { finished: [{ thread: 'main', at: t - 2000, end: t + 500 }] })
  readsOf(w, C_SID, 'TEST C', { running: [{ thread: 'main', at: t - 1000, command: 'ssh build.example.invalid ./replay.sh' }] })
  for (let i = 0; i < 9; i++) {
    await tick(w, 10000)
    readsOf(w, B_SID, 'TEST B', { finished: [{ thread: 'main', at: t - 2000, end: t + 500 }] })
    readsOf(w, C_SID, 'TEST C', { running: [{ thread: 'main', at: t - 1000, command: 'ssh build.example.invalid ./replay.sh' }] })
  }
  expect(of(w, 'notes/plan.md')).toEqual([])
  readsOf(w, C_SID, 'TEST C', {})
  await tick(w, 10000)
  await tick(w, 10000)
  expect(of(w, 'notes/plan.md').at(-1)).toMatchObject({ via: 'bash', probably: true, by: { sessionId: B_SID } })
})

test("B5: a file a command names, that a peer's running command names too, is left to the scan; a command's own landing takes it, even over the scan's guess", WITH_SESSIONS, async ($, on) => {
  on('classic.Stop', () => ({}))
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  // TEST B's sed of plan.md runs (past 3 s: its reads file says so) while this session lists notes/ and runs a script
  w.bash.value = () => {
    w.touch(PLAN, 'plan by B’s sed\n')
    readsOf(w, B_SID, 'TEST B', { running: [{ thread: 'main', at: w.clock.now() - 5000, command: "sed -i '' s/v1/x/ notes/plan.md" }] })
  }
  await call($, { tool: 'Bash', command: 'ls notes/ && python3 tools/x.py' })
  expect(of(w, 'notes/plan.md')).toEqual([])
  // B's sed ends and its post-scan lands it: B's, not this command's
  readsOf(w, B_SID, 'TEST B', {})
  landByB(w, PLAN, 'plan by B’s sed\n')
  await tick(w, 10000)
  await tick(w, 10000)
  expect(of(w, 'notes/plan.md').map(e => e.by?.sessionId)).toEqual([B_SID])
  // A background command of this session that names todo.md: while it runs the scan records the change as probably
  // its; when it completes, its own landing (named) replaces that guess
  w.bash.value = () => {}
  const r = await call($, { tool: 'Bash', command: 'python3 tools/long.py > notes/todo.md', run_in_background: true })
  w.touch(TODO, 'todo by the long run\n')
  await tick(w, 10000)
  await tick(w, 10000)
  expect(of(w, 'notes/todo.md').at(-1)).toMatchObject({ via: 'bash', probably: true, by: { sessionId: SID } })
  await $.prompt.submit({ text: `<task-notification><task-id>${r.result.backgroundTaskId}</task-id><status>completed</status></task-notification>`, origin: { kind: 'task-notification' }, wait: false } as any)
  await w.clock.settle()
  const last = of(w, 'notes/todo.md').at(-1)
  expect(last).toMatchObject({ via: 'bash', blind: true, by: { sessionId: SID }, to: hashText('todo by the long run\n') })
  expect(last.probably).toBe(undefined)
})

test('G19: a confirmation and a kept pin outlast an editorial version of the record; a confirm names files it read or wrote, and an edit since needs its own', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'notes/**'], files: { [R1]: 'R-1 v1\n', [PB]: 'B wrote this, on R-1@1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: R1 })
  expect((await call($, { tool: 'Write', file_path: PA, content: 'The plan rests on R-1@1\n' })).deny).toBe(undefined)
  landByB(w, PB, 'B wrote this, on R-1@1\nmore\n')
  landByB(w, R1, 'R-1 v2, revised\n', 2)
  await tick(w, 61000)
  expect(suspects(w)).toEqual(['notes/plan-a.md', 'notes/plan-b.md'])
  // The digest names the way to confirm
  const told = ((await call($, { tool: 'Read', file_path: R1 })).context ?? []).join('\n')
  expect(told).toContain('or, once checked, say they still hold with mcp__fleet__confirm (of: <id>), with no new version')
  const confirm = (input: Record<string, unknown>) => call($, { tool: 'mcp__fleet__confirm', ...input })
  // plan-b is TEST B's and this thread never read it: not confirmed
  expect((await confirm({ of: 'R-1', paths: ['notes/plan-b.md'] })).deny).toContain('notes/plan-b.md: read it as it is now first')
  await call($, { tool: 'Read', file_path: PB })
  expect((await confirm({ of: 'R-1', paths: ['notes/plan-a.md', 'notes/plan-b.md'] })).result).toContain('2 file(s) confirmed against R-1@2')
  expect(json(w, `${STATE}/confirms/${under(w, `${STATE}/confirms`)[0]}`)?.versions).toEqual({ 'notes/plan-a.md': hashText('The plan rests on R-1@1\n'), 'notes/plan-b.md': hashText('B wrote this, on R-1@1\nmore\n') })
  await tick(w, 61000)
  expect(suspects(w)).toEqual([])
  // An editorial version of R-1: nothing comes back, and R-1@2 or R-1@3 both confirm what it says now
  landByB(w, R1, 'R-1 v2, revised (a typo)\n', 3, 'editorial')
  await tick(w, 61000)
  expect(suspects(w)).toEqual([])
  await call($, { tool: 'Read', file_path: R1 })
  expect((await confirm({ of: 'R-1@2', paths: ['notes/plan-a.md'] })).result).toContain('confirmed against R-1@3')
  expect((await confirm({ of: 'R-1@1' })).deny).toContain('R-1 is at v3 (revised last at v2), not v1')
  // TEST B edits plan-b since, still citing R-1@1: its own check is needed
  landByB(w, PB, 'B wrote this, on R-1@1\nmore, and a new claim\n')
  await tick(w, 61000)
  expect(suspects(w)).toEqual(['notes/plan-b.md'])
  // A revision: everything confirmed is flagged again
  landByB(w, R1, 'R-1 v4, revised again\n', 4)
  await tick(w, 61000)
  expect(suspects(w)).toEqual(['notes/plan-a.md', 'notes/plan-b.md'])
})

test('a janitor hears the files only behind a revision that no session wrote last; status and the brief say who is told', WITH_SESSIONS, async ($, on) => {
  const JANITOR = '---\nname: janitor\ndescription: keeps things tidy\ntools: Read, Write, Edit, mcp__fleet__*\n---\nYou keep things tidy.\n'
  const roster = {
    rosterFormat: 1,
    sections: [{ id: 'checks', title: 'Checks' }],
    roles: { janitor: { agent: 'janitor', model: 'haiku', budget: { usdDay: 1 } } },
    instances: [{ name: 'Janitor', role: 'janitor', section: 'checks' }],
  }
  const w = world(on, {
    worldPaths: ['req/**', 'notes/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Janitor', FLEET_ROLE: 'janitor' },
    files: { [`${FLEET}/roster.json`]: JSON.stringify(roster), [`${ROOT}/.claude/agents/janitor.md`]: JANITOR, [`${FLEET}/instances/janitor.json`]: '{}\n', [R1]: 'R-1 v1\n', [PA]: 'An editor wrote this, on R-1@1\n', [PB]: 'And this, on R-1@1\n' },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Janitor', root: ROOT, background: true, agent: 'janitor' }, rows: { [REF]: row(REF, 'Janitor', 'idle') } })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'janitor' } as any)
  await tick(w, 1100)
  await tick(w)
  landByB(w, R1, 'R-1 v2, revised\n', 2)
  await tick(w, 61000)
  expect(suspects(w)).toEqual(['notes/plan-a.md', 'notes/plan-b.md'])
  // Told once: as a nudge while it's idle, or at its next step
  const told = [...w.submits, ...((await call($, { tool: 'Read', file_path: R1 })).context ?? [])].join('\n')
  expect(told).toContain('fleet: shared files no session wrote last (an editor, a script, or the person) are behind a revision, and nobody else is told')
  expect(told).toContain('- 2 file(s) behind R-1@2')
  expect(await fleet($, 'status')).toContain('2 file(s) behind R-1@2')
  expect(await fleet($, 'status')).toContain('no writer to tell, so Janitor is told: 2 (notes/plan-a.md, notes/plan-b.md)')
})

test('a project from an older fleet: status and the dry run say what its world.json and proofs check lack', WITH_SESSIONS, async ($, on) => {
  const checks = [{ name: 'proofs', glob: 'findings/**', argv: ['python3', '.claude/fleet/checks/proof-check.py'] }]
  const w = world(on, {
    files: {
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['board/**', 'findings/**'], checks }),
      [`${FLEET}/checks/proof-check.py`]: '#!/usr/bin/env python3\nprint()\n',
    },
  })
  await begin($, w)
  const status = await fleet($, 'status')
  expect(status).toContain('note: world.json has no defaultKind')
  expect(status).toContain('note: .claude/fleet/checks/proof-check.py is older than the one this fleet ships')
  w.touch(`${FLEET}/checks/proof-check.py`, '#!/usr/bin/env python3\n# proof-check-version: 2\nprint()\n')
  w.touch(`${FLEET}/world.json`, JSON.stringify({ worldFormat: 1, paths: ['board/**', 'findings/**'], defaultKind: { 'board/**': 'editorial' }, checks }))
  await tick(w, 2100)
  const after = await fleet($, 'status')
  expect(after).not.toContain('no defaultKind')
  expect(after).not.toContain('is older than the one this fleet ships')
})

test("B5: a change the scan credits to a command of this session, over a peer's change its thread hadn't read, is told to that thread at its next step", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [TODO]: 'todo v1\n' } })
  await begin($, w)
  landByB(w, PLAN, 'plan by B\n')
  await tick(w)
  // A script that names nothing puts an old plan back
  w.bash.value = () => {
    w.touch(PLAN, 'plan put back by the script\n')
  }
  await call($, { tool: 'Bash', command: 'python3 tools/restore.py' })
  await tick(w, 10000)
  await tick(w, 10000)
  expect(of(w, 'notes/plan.md').at(-1)).toMatchObject({ via: 'bash', probably: true, by: { sessionId: SID } })
  const text = ((await call($, { tool: 'Read', file_path: TODO })).context ?? []).join('\n')
  expect(text).toContain("fleet: notes/plan.md changed while a command of yours ran that doesn't name it (probably your command: a script, a checkout, a stash), over a change: it changed at")
  expect(text).toContain('by TEST B (Edit) after you read it. Read notes/plan.md and check that change is still there.')
  // Told once
  expect(((await call($, { tool: 'Read', file_path: TODO })).context ?? []).join('\n')).not.toContain('changed while a command of yours ran')
})

test("B24: a Write that changes nothing takes over no blind version a peer's command made a moment before", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'notes/**'], files: { [R1]: 'R-1 v1\n' } })
  await begin($, w)
  // TEST B's command rewrote R-1 a moment ago: its post-scan took v2, blind
  const text = 'R-1 v2 by B’s script\n'
  const before = w.files.get(R1) as string
  w.touch(R1, text)
  const at = w.clock.now()
  w.touch(`${STATE}/revs/R-1/2.json`, JSON.stringify({ format: 1, id: 'R-1', path: 'req/R-1.md', rev: 2, hash: hashText(text), kind: 'revision', changeHash: null, at, by: B, via: 'bash', pins: [] }))
  const name = `${at}-bbbbbbbb-${++n}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path: 'req/R-1.md', from: hashText(before), to: hashText(text), via: 'bash', tool: 'Bash', blind: true, by: B, id: 'R-1', rev: 2, kind: 'revision' }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
  await tick(w)
  await call($, { tool: 'Read', file_path: R1 })
  expect((await call($, { tool: 'Write', file_path: R1, content: text })).deny).toBe(undefined)
  expect(under(w, `${STATE}/revs/R-1`).sort()).toEqual(['1.json', '2.json'])
})
