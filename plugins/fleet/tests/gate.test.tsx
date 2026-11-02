import { expect, test } from 'claude-code/testing'

import { clock, hashText, hourFolder } from '../hooks/changes'
import { FLEET, REF, ROOT, SID, fleet, json, sessionsSay, startSession, under, world, type World, WITH_SESSIONS } from './world'

// The shared files (the world) in one session, with the engine's file tools and shell standing in beneath fleet.
// Another session's landings are written as its fleet would write them: the file, then its event

const PLAN = `${ROOT}/notes/plan.md`
const TODO = `${ROOT}/notes/todo.md`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const B = { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'TEST B' }
const CURRENT = { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null } }
const WHEN = '\\d\\d:\\d\\d'

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

// A session with the world notes/**, past its first scan (the baseline)
async function begin($: any, w: World) {
  sessionsSay(w, CURRENT)
  await startSession($, w)
  await tick(w, 1100)
}

let n = 0
function landByB(w: World, path: string, text: string, tool = 'Edit') {
  const before = w.files.get(path)
  w.touch(path, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${++n}.json`
  const event = { format: 1, at, path: path.slice(ROOT.length + 1), from: before === undefined ? null : hashText(before), to: hashText(text), via: 'tool', tool, blind: false, by: B }
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify(event))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}

function events(w: World): any[] {
  return [...w.files.keys()]
    .filter(p => p.startsWith(`${FLEET}/events/`) && /\/\d{4}-\d{2}-\d{2}\/\d{2}\/[^/]+\.json$/.test(p))
    .map(p => JSON.parse(w.files.get(p) as string))
    .sort((a, b) => a.at - b.at)
}

function mine(w: World): any[] {
  return events(w).filter(e => e.by?.sessionId === SID || (e.via === 'outside' && e.by === null))
}

async function call($: any, input: Record<string, unknown>): Promise<any> {
  return $.tool.call(input as any)
}

test('a stale write is refused once with who changed it and when; the thread heard it at its next step; after a Read it lands as an event', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  expect((await call($, { tool: 'Read', file_path: PLAN })).context).toBe(undefined)
  landByB(w, PLAN, 'plan v2 from B\n')
  await tick(w)
  // The next step carries the digest, once, with path, who and when (never the content)
  const step = await call($, { tool: 'Bash', command: 'ls' })
  expect(step.context.join('\n')).toMatch(new RegExp(`^fleet: a shared file you read has changed since you read it\\. Read it again before you rely on it or write it:\\n- notes/plan\\.md: changed at ${WHEN} by TEST B \\(Edit\\)$`))
  expect(step.context.join('\n')).not.toContain('plan v2')
  expect((await call($, { tool: 'Bash', command: 'ls' })).context).toBe(undefined)
  // The stale write is refused, and nothing is written
  const refused = await call($, { tool: 'Write', file_path: PLAN, content: 'plan v1 and mine\n' })
  expect(refused.deny).toMatch(new RegExp(`^fleet: notes/plan\\.md changed at ${WHEN} by TEST B \\(Edit\\), after you read it\\. Read it again, then redo this write so it agrees with that change`))
  expect(w.files.get(PLAN)).toBe('plan v2 from B\n')
  // After the re-read it lands, as this session's event
  await call($, { tool: 'Read', file_path: PLAN })
  const landed = await call($, { tool: 'Edit', file_path: PLAN, old_string: 'from B', new_string: 'from B, and mine' })
  expect(landed.deny).toBe(undefined)
  expect(w.files.get(PLAN)).toBe('plan v2 from B, and mine\n')
  const ev = mine(w)
  expect(ev.length).toBe(1)
  expect(ev[0]).toMatchObject({ format: 1, path: 'notes/plan.md', via: 'tool', tool: 'Edit', blind: false, from: hashText('plan v2 from B\n'), to: hashText('plan v2 from B, and mine\n'), by: { sessionId: SID, agentId: null, ref: REF, name: 'TEST A' } })
  expect(json(w, `${FLEET}/events/latest`).last).toMatch(/-aaaaaaaa-\d+\.json$/)
  // What this session read is in its reads file, for /fleet status elsewhere and a restart
  await tick(w, 1100)
  expect(json(w, `${FLEET}/reads/${SID}.json`)).toMatchObject({ format: 1, sessionId: SID, name: 'TEST A', threads: { main: { 'notes/plan.md': { v: hashText('plan v2 from B, and mine\n') } } } })
})

test('the gate tells once: a file never read is refused once, then passes; a new file and a file outside the world pass', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [`${ROOT}/src/a.ts`]: 'x\n' } })
  await begin($, w)
  const first = await call($, { tool: 'Write', file_path: PLAN, content: 'all new\n' })
  expect(first.deny).toBe("fleet: notes/plan.md is a shared file of this project and you haven't read it in this conversation. Read it first, then redo this write so it keeps what's there (this write was not made).")
  const again = await call($, { tool: 'Write', file_path: PLAN, content: 'all new\n' })
  expect(again.deny).toBe(undefined)
  expect(w.files.get(PLAN)).toBe('all new\n')
  expect((await call($, { tool: 'Write', file_path: `${ROOT}/notes/ideas/new.md`, content: 'idea\n' })).deny).toBe(undefined)
  expect((await call($, { tool: 'Write', file_path: `${ROOT}/src/a.ts`, content: 'y\n' })).deny).toBe(undefined)
  expect(mine(w).map(e => [e.path, e.from === null])).toEqual([
    ['notes/plan.md', false],
    ['notes/ideas/new.md', true],
  ])
})

test("each thread answers for itself: a helper's read doesn't count for the main thread, and a helper's reads go when it ends", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: PLAN, agentId: 'a1' })
  expect((await call($, { tool: 'Write', file_path: PLAN, content: 'main\n' })).deny).toContain("you haven't read it")
  expect((await call($, { tool: 'Write', file_path: PLAN, content: 'helper\n', agentId: 'a1' })).deny).toBe(undefined)
  const ev = mine(w)
  expect(ev[0].by).toMatchObject({ sessionId: SID, agentId: 'a1' })
  await tick(w, 1100)
  expect(Object.keys(json(w, `${FLEET}/reads/${SID}.json`).threads)).toEqual(['a1'])
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't-a1', reason: 'answer', agentId: 'a1' } as any)
  await tick(w, 1100)
  expect(Object.keys(json(w, `${FLEET}/reads/${SID}.json`).threads)).toEqual([])
})

test('paths are placed where they land: a case alias on a volume that ignores case, a link, a new file in a new folder', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], insensitive: true, links: { [`${ROOT}/n`]: `${ROOT}/notes` }, files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: `${ROOT}/NOTES/Plan.md` })
  landByB(w, PLAN, 'plan v2\n')
  await tick(w)
  expect((await call($, { tool: 'Write', file_path: '/Users/x/PROJ/Notes/PLAN.md', content: 'x\n' })).deny).toContain('fleet: notes/plan.md changed at')
  expect((await call($, { tool: 'Write', file_path: `${ROOT}/n/plan.md`, content: 'x\n' })).deny).toBe(undefined)
  expect((await call($, { tool: 'Write', file_path: '/Users/x/PROJ/Notes/New/x.md', content: 'x\n' })).deny).toBe(undefined)
  expect(mine(w).map(e => e.path)).toEqual(['notes/plan.md', 'notes/New/x.md'])
})

test('a Bash command that writes a world file lands blind: an event of its thread, a line when it replaced a change it had not read', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [TODO]: 'todo v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: PLAN })
  landByB(w, PLAN, 'plan v2 from B\n')
  await tick(w)
  w.bash.value = command => {
    if (command.startsWith('printf')) w.touch(PLAN, 'written by a command\n')
  }
  const r = await call($, { tool: 'Bash', command: "printf 'written by a command\\n' > notes/plan.md" })
  expect(r.context.join('\n')).toMatch(new RegExp(`fleet: your command changed notes/plan\\.md, which changed at ${WHEN} by TEST B \\(Edit\\) after you read it\\. Read notes/plan\\.md and check that change is still there\\.`))
  const ev = mine(w)
  expect(ev[0]).toMatchObject({ path: 'notes/plan.md', via: 'bash', tool: 'Bash', blind: true, from: hashText('plan v2 from B\n'), to: hashText('written by a command\n'), by: { sessionId: SID } })
  // The command's result doesn't count as read: the thread never saw TEST B's version it replaced, so its next write is
  // refused once (R6). A cat of one file is a read
  expect((await call($, { tool: 'Edit', file_path: PLAN, old_string: 'command', new_string: 'command, then edited' })).deny).toContain('after you read it')
  expect((await call($, { tool: 'Edit', file_path: PLAN, old_string: 'command', new_string: 'command, then edited' })).deny).toBe(undefined)
  await call($, { tool: 'Bash', command: 'cat notes/todo.md' })
  expect((await call($, { tool: 'Write', file_path: TODO, content: 'todo v2\n' })).deny).toBe(undefined)
  // One that changes a file the thread had read as it was: its result counts as read
  w.bash.value = command => {
    if (command.startsWith('sed')) w.touch(TODO, 'todo v3\n')
  }
  await call($, { tool: 'Bash', command: "sed -i '' s/v2/v3/ notes/todo.md" })
  expect((await call($, { tool: 'Write', file_path: TODO, content: 'todo v4\n' })).deny).toBe(undefined)
  // A command that writes nothing of the world records nothing
  w.bash.value = () => w.touch(`${ROOT}/build.log`, 'ok\n')
  await call($, { tool: 'Bash', command: 'make' })
  expect(mine(w).map(e => e.via)).toEqual(['bash', 'tool', 'tool', 'bash', 'tool'])
})

test('R6: the scan runs during a long command; what the command writes lands as its own, what another session’s long command writes waits for it', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [TODO]: 'todo v1\n' } })
  await begin($, w)
  await tick(w)
  // A long command here (npm test): it writes notes/plan.md at once, and runs a minute
  let finish: () => void = () => {}
  w.bash.value = () => {
    w.touch(PLAN, 'plan from the tests\n')
    return new Promise<void>(res => (finish = res))
  }
  const pending = call($, { tool: 'Bash', command: 'npm test' })
  for (let i = 0; i < 6; i++) await tick(w, 10000)
  expect(mine(w)).toEqual([])
  finish()
  await pending
  expect(mine(w)).toEqual([expect.objectContaining({ path: 'notes/plan.md', via: 'bash', by: expect.objectContaining({ sessionId: SID }) })])
  // Another session runs a long command (its reads file says so): a change meanwhile waits for its post-scan
  const OTHER = `${FLEET}/reads/${B_SID}.json`
  const reads = (running: unknown[]) => w.touch(OTHER, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'TEST B', at: w.clock.now(), threads: {}, running }))
  reads([{ thread: 'main', at: w.clock.now() }])
  w.touch(TODO, 'todo by its build\n')
  for (let i = 0; i < 4; i++) await tick(w, 10000)
  expect(mine(w).filter(e => e.path === 'notes/todo.md')).toEqual([])
  // It ended without landing it (here no fleet there): then it's an outside change
  reads([])
  await tick(w, 10000)
  await tick(w, 10000)
  expect(mine(w).filter(e => e.path === 'notes/todo.md')).toEqual([expect.objectContaining({ via: 'outside', by: null })])
  // A command that started after the scan first saw a change looked at the world with it: it isn't its, nothing waits
  w.touch(PLAN, 'plan from the editor\n')
  await tick(w, 10000)
  reads([{ thread: 'main', at: w.clock.now() }])
  await tick(w, 10000)
  await tick(w, 10000)
  expect(mine(w).filter(e => e.path === 'notes/plan.md').at(-1)).toMatchObject({ via: 'outside', to: hashText('plan from the editor\n') })
})

test('a command run in the background: what changes while it runs is probably its; what it changed lands when it completes', WITH_SESSIONS, async ($, on) => {
  on('classic.Stop', () => ({}))
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [TODO]: 'todo v1\n' } })
  await begin($, w)
  await tick(w)
  const r = await call($, { tool: 'Bash', command: 'npm run build', run_in_background: true })
  expect(r.result.backgroundTaskId).toBe('bash-1')
  await tick(w, 1100)
  expect(json(w, `${FLEET}/reads/${SID}.json`)?.running).toEqual([{ thread: 'main', at: expect.any(Number), task: 'bash-1' }])
  // It writes plan.md: the sweeper's scan takes it as probably this session's background command, never the person's
  w.touch(PLAN, 'plan from the build\n')
  await tick(w, 10000)
  await tick(w, 10000)
  expect(mine(w)).toEqual([expect.objectContaining({ path: 'notes/plan.md', via: 'bash', blind: true, probably: true, by: expect.objectContaining({ sessionId: SID, agentId: null }) })])
  expect(await fleet($, 'status')).toContain('notes/plan.md: changed at')
  expect(await fleet($, 'status')).toContain("by this session's main thread (probably its background command, landed blind)")
  // ... which the person can stamp as his, like an outside change
  expect(await fleet($, 'accept')).toContain('notes/plan.md: changed at')
  // It writes todo.md and completes: at the next stop (or its notification), what's left lands as its own
  w.touch(TODO, 'todo from the build\n')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bash-1', type: 'shell', status: 'running', description: 'npm run build' }] } as any)
  await w.clock.settle()
  expect(mine(w).filter(e => e.path === 'notes/todo.md')).toEqual([])
  await $.prompt.submit({ text: '<task-notification><task-id>bash-1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' }, wait: false } as any)
  await w.clock.settle()
  expect(mine(w).filter(e => e.path === 'notes/todo.md')).toEqual([expect.objectContaining({ via: 'bash', blind: true, by: expect.objectContaining({ sessionId: SID }) })])
  expect(mine(w).find(e => e.path === 'notes/todo.md')?.probably).toBe(undefined)
  await tick(w, 1100)
  expect(json(w, `${FLEET}/reads/${SID}.json`)?.running).toBe(undefined)
  // Another one, whose end only the stop says (no notification seen): gone from the background tasks, it lands
  await call($, { tool: 'Bash', command: 'npm run docs', run_in_background: true })
  w.touch(`${ROOT}/notes/docs.md`, 'docs\n')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as any)
  await w.clock.settle()
  expect(mine(w).filter(e => e.path === 'notes/docs.md')).toEqual([expect.objectContaining({ via: 'bash', by: expect.objectContaining({ sessionId: SID }) })])
})

test('a command that writes many shared files lands them in a couple of processes, not several a file', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**', 'req/**'], files: { [PLAN]: 'plan v1\n', [`${ROOT}/req/R-1.md`]: 'R-1 v1\n', [`${ROOT}/req/R-2.md`]: 'R-2 v1\n' } })
  await begin($, w)
  await tick(w)
  w.bash.value = () => {
    for (let i = 0; i < 20; i++) w.touch(`${ROOT}/notes/n${i}.md`, `note ${i}\n`)
    w.touch(`${ROOT}/req/R-1.md`, 'R-1 v2\n')
    w.touch(`${ROOT}/req/R-2.md`, 'R-2 v2\n')
  }
  const before = w.runs.length
  await call($, { tool: 'Bash', command: 'make notes' })
  // One shell for the records' versions, one for the events
  const spawned = w.runs.slice(before)
  expect(spawned.map(a => a[0])).toEqual(['sh', 'sh'])
  expect(mine(w).filter(e => e.via === 'bash').length).toBe(22)
  expect(json(w, `${FLEET}/state/revs/R-1/2.json`)).toMatchObject({ rev: 2, via: 'bash', hash: hashText('R-1 v2\n') })
  expect(json(w, `${FLEET}/state/revs/R-2/2.json`)).toMatchObject({ rev: 2, via: 'bash', hash: hashText('R-2 v2\n') })
  expect(events(w).find(e => e.path === 'req/R-1.md' && e.via === 'bash')).toMatchObject({ id: 'R-1', rev: 2 })
  expect(under(w, `${FLEET}/decisions/tmp`)).toEqual([])
})

test('the walk skips build folders and the like unless a glob names them; past 20000 entries the world is too big to scan', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['**/*.md', 'build/reports/**'], files: { [PLAN]: 'plan v1\n', [`${ROOT}/dist/b.md`]: 'b\n', [`${ROOT}/build/reports/r.md`]: 'r\n', [`${ROOT}/src/.venv/x.md`]: 'x\n' } })
  await begin($, w)
  await tick(w)
  w.touch(PLAN, 'plan v2\n')
  w.touch(`${ROOT}/dist/b.md`, 'b2\n')
  w.touch(`${ROOT}/src/.venv/x.md`, 'x2\n')
  w.touch(`${ROOT}/build/reports/r.md`, 'r2\n')
  await tick(w, 10000)
  await tick(w, 10000)
  expect(mine(w).map(e => e.path).sort()).toEqual(['build/reports/r.md', 'notes/plan.md'])
  // Every entry walked counts, in the world or not
  for (let i = 0; i <= 20000; i++) w.files.set(`${ROOT}/src/f${i}.ts`, 'x\n')
  w.dirs.add(`${ROOT}/src`)
  await tick(w, 10000)
  expect(await fleet($, 'status')).toContain("world too big (more than 20000 entries under its folders): no scan, so outside changes and suspects aren't seen")
})

test('a change made outside fleet is found by the scan, recorded once and heard; /fleet accept stamps it as the person’s', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [TODO]: 'todo v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: PLAN })
  w.touch(PLAN, 'edited in an editor\n')
  await tick(w, 10000)
  expect(mine(w)).toEqual([])
  await tick(w, 10000)
  const ev = mine(w)
  expect(ev).toEqual([expect.objectContaining({ path: 'notes/plan.md', via: 'outside', blind: true, by: null, to: hashText('edited in an editor\n') })])
  expect(under(w, `${FLEET}/events/claims`).length).toBe(1)
  const step = await call($, { tool: 'Bash', command: 'ls' })
  expect(step.context.join('\n')).toMatch(new RegExp(`- notes/plan\\.md: changed at ${WHEN} outside fleet \\(an editor, a script, or a session without fleet\\)`))
  expect(await fleet($, 'accept')).toContain('notes/plan.md: changed at')
  expect(await fleet($, 'accept notes/plan.md', { kind: 'plugin', name: 'other' })).toContain('Only the person')
  expect(await fleet($, 'accept notes/plan.md')).toContain('notes/plan.md: its current version (changed at')
  expect(mine(w).map(e => e.via)).toEqual(['outside', 'accept'])
  expect(events(w).at(-1)).toMatchObject({ via: 'accept', path: 'notes/plan.md', by: { person: true, sessionId: SID }, to: hashText('edited in an editor\n') })
  expect(await fleet($, 'accept notes/plan.md')).toContain('yours already')
  expect(await fleet($, 'accept')).toContain('No change made outside fleet waits')
  // Told once already: the stamp doesn't make a second digest line
  expect((await call($, { tool: 'Bash', command: 'ls' })).context).toBe(undefined)
  landByB(w, TODO, 'todo from B\n')
  await tick(w)
  expect(await fleet($, 'accept notes/todo.md')).toMatch(/notes\/todo\.md: its current version is from TEST B \(Edit\) at \d\d:\d\d: nothing to stamp/)
  expect(await fleet($, 'accept src/x.ts')).toContain("isn't a shared file of this project")
})

test('R3: parallel tool calls of one step carry the digest once', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [TODO]: 'todo v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: PLAN })
  landByB(w, PLAN, 'plan v2 from B\n')
  await tick(w)
  const all = await Promise.all([call($, { tool: 'Read', file_path: TODO }), call($, { tool: 'Bash', command: 'ls' }), call($, { tool: 'Bash', command: 'pwd' })])
  const told = all.map(r => (r.context ?? []).join('\n')).filter(c => c.includes('notes/plan.md: changed at'))
  expect(told.length).toBe(1)
  expect((await call($, { tool: 'Bash', command: 'ls' })).context).toBe(undefined)
})

test('R5: an outside change that keeps an older time (rsync -a, cp -p) is recorded when found, and heard by a thread that read the file since', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  const readAt = w.clock.now()
  await call($, { tool: 'Read', file_path: PLAN })
  await tick(w, 60000)
  w.touch(PLAN, 'synced from elsewhere\n', readAt - 30000)
  await tick(w, 10000)
  await tick(w, 10000)
  const ev = mine(w)
  expect(ev).toEqual([expect.objectContaining({ path: 'notes/plan.md', via: 'outside', changedAt: readAt - 30000 })])
  expect(ev[0].at).toBeGreaterThan(readAt)
  // The words say when the file changed; the digest carries it all the same
  const step = await call($, { tool: 'Bash', command: 'ls' })
  expect(step.context.join('\n')).toContain(`- notes/plan.md: changed at ${clock(readAt - 30000, -new Date(readAt).getTimezoneOffset())} outside fleet (an editor, a script, or a session without fleet)`)
})

test('a prompt that starts a turn carries the main thread’s digest, once; nothing when nothing it read changed', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: PLAN })
  const submit = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as any)
  await submit('first')
  landByB(w, PLAN, 'plan v2\n')
  await tick(w)
  await submit('second')
  await submit('third')
  expect(w.prompts.map(p => [p.text, p.context.length])).toEqual([
    ['first', 0],
    ['second', 1],
    ['third', 0],
  ])
  expect(w.prompts[1]?.context[0]).toMatch(/notes\/plan\.md: changed at \d\d:\d\d by TEST B \(Edit\)/)
})

test('an edit that waited while another landing came in lands on top of it, and says so', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'line one\nline two\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: PLAN })
  w.beforeTool.value = () => {
    w.beforeTool.value = () => {}
    landByB(w, PLAN, 'line one\nline two\nline three from B\n')
  }
  const r = await call($, { tool: 'Edit', file_path: PLAN, old_string: 'line one', new_string: 'line ONE' })
  expect(r.context.join('\n')).toMatch(new RegExp(`fleet: your edit of notes/plan\\.md landed on top of a change that came in at ${WHEN} by TEST B \\(Edit\\) while your edit waited`))
  expect(mine(w)[0]).toMatchObject({ overwrote: true, from: hashText('line one\nline two\nline three from B\n') })
})

test('/fleet world lists, adds and removes globs, typed by the person; /fleet init writes the default; a newer world.json turns the world off', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { fleet: false, background: false, files: { [`${ROOT}/specs/a.md`]: 'a\n' } })
  await startSession($, w)
  expect(await fleet($, 'init')).toContain('Shared files (world.json): `notes/**`, `docs/**`.')
  expect(json(w, `${FLEET}/world.json`)).toEqual({ worldFormat: 1, paths: ['notes/**', 'docs/**'] })
  expect(w.files.get(`${FLEET}/.gitignore`)).toContain('\nevents/\nreads/\n')
  expect(await fleet($, 'world')).toContain('`notes/**`, `docs/**`')
  expect(await fleet($, 'world add specs', { kind: 'plugin', name: 'other' })).toContain('Only the person')
  expect(await fleet($, 'world add specs')).toContain('Added `specs/**`')
  expect(await fleet($, 'world remove docs/**')).toContain('`notes/**`, `specs/**`')
  expect(await fleet($, 'world add ../x')).toContain("can't have . or ..")
  expect(json(w, `${FLEET}/world.json`)).toEqual({ worldFormat: 1, paths: ['notes/**', 'specs/**'] })
  // The world of a newer fleet: left alone, said, and nothing is gated
  w.touch(`${FLEET}/world.json`, '{"worldFormat": 2, "paths": ["notes/**"]}')
  await tick(w)
  expect(await fleet($, 'status')).toContain('world: world.json is from a newer fleet (worldFormat 2): restart this session (u)')
  w.touch(PLAN, 'v1\n')
  expect((await call($, { tool: 'Write', file_path: PLAN, content: 'v2\n' })).deny).toBe(undefined)
  expect(await fleet($, 'world add docs/**')).toContain('newer fleet')
})

test('the first stamps are a baseline of every config file: one stamped alone leaves the others as they were, not changed outside fleet', WITH_SESSIONS, async ($, on) => {
  const charter = `${FLEET}/charter.md`
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { [charter]: '# Charter\n', [`${FLEET}/roster.json`]: JSON.stringify({ rosterFormat: 1, sections: [], roles: {}, instances: [] }), [`${ROOT}/.claude/agents/owner.md`]: '---\nname: owner\n---\n' } })
  await startSession($, w)
  // No stamps yet: the person's typed /fleet world add writes the first ones
  expect(await fleet($, 'world add docs')).toContain('Added `docs`')
  expect(Object.keys(json(w, `${FLEET}/state/stamps.json`).files).sort()).toEqual([
    '.claude/agents/owner.md',
    '.claude/fleet/charter.md',
    '.claude/fleet/outbound.json',
    '.claude/fleet/principles.md',
    '.claude/fleet/roster.json',
    '.claude/fleet/slots.json',
    '.claude/fleet/world.json',
  ])
  expect(await fleet($, 'accept')).toBe('No change made outside fleet waits to be stamped.')
  // An edit after them is flagged
  w.touch(charter, '# Charter\n\nThe goal.\n')
  expect(await fleet($, 'accept')).toContain('.claude/fleet/charter.md: changed outside fleet')
})

test('/fleet status: the world, the latest changes, and who is behind, in this session and the others', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [TODO]: 'todo v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: PLAN })
  w.touch(`${FLEET}/reads/cccccccc-0000-0000-0000-000000000000.json`, JSON.stringify({ format: 1, sessionId: 'cccccccc-0000-0000-0000-000000000000', ref: 'cccccccc', name: 'TEST C', at: w.clock.now(), threads: { main: { 'notes/todo.md': { v: hashText('todo v0\n'), at: 1 }, 'notes/plan.md': { v: hashText('plan v1\n'), at: 1 } } } }))
  landByB(w, PLAN, 'plan v2\n')
  await tick(w)
  const s = await fleet($, 'status')
  expect(s).toContain('world: `notes/**` (world.json)')
  expect(s).toMatch(/recent changes \(newest first\):\n {2}notes\/plan\.md: changed at \d\d:\d\d by TEST B \(Edit\)/)
  expect(s).toContain('behind (read a version that has changed since):')
  expect(s).toMatch(/ {2}this session: notes\/plan\.md, changed at \d\d:\d\d by TEST B \(Edit\)/)
  expect(s).toMatch(/ {2}TEST C: notes\/plan\.md, changed at/)
  expect(s).toContain('  TEST C: notes/todo.md')
  expect(s).toContain('formats: files 1, register 1, config 1, world 1')
})

test('after a restart the reads come back from the file; a /clear forgets them', WITH_SESSIONS, async ($, on) => {
  const reads = { format: 1, sessionId: SID, ref: REF, name: 'TEST A', at: 1, threads: { main: { 'notes/plan.md': { v: hashText('plan v1\n'), at: 1 } } } }
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [`${FLEET}/reads/${SID}.json`]: JSON.stringify(reads) } })
  await begin($, w)
  expect((await call($, { tool: 'Write', file_path: PLAN, content: 'plan v2\n' })).deny).toBe(undefined)
  await $.session.end({ reason: 'clear', sessionId: SID } as any)
  await w.clock.settle()
  expect(w.files.has(`${FLEET}/reads/${SID}.json`)).toBe(false)
  expect((await call($, { tool: 'Write', file_path: PLAN, content: 'plan v3\n' })).deny).toContain("you haven't read it")
})

test('fleet fails open: a world.json it can’t read gates nothing, and says why', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { files: { [PLAN]: 'plan v1\n', [`${FLEET}/world.json`]: 'not json' } })
  await begin($, w)
  expect((await call($, { tool: 'Write', file_path: PLAN, content: 'v2\n' })).deny).toBe(undefined)
  expect(await fleet($, 'status')).toContain("world: world.json isn't valid JSON")
  expect(events(w)).toEqual([])
})
