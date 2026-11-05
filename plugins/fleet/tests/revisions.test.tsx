import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { FLEET, REF, ROOT, SID, fleet, json, sessionsSay, startSession, under, world, type World, WITH_SESSIONS } from './world'

// What lands as whose after a command, versions taken twice, and what a revision elsewhere makes of the files that
// cite it: in one session (TEST A, the project's sweeper), with the engine's tools and shell standing in beneath fleet.
// Another session (TEST B) lands as its fleet would: the file, its next version, its event

const STATE = `${FLEET}/state`
const PLAN = `${ROOT}/notes/plan.md`
const TODO = `${ROOT}/notes/todo.md`
const R1 = `${ROOT}/req/R-1.md`
const R2 = `${ROOT}/req/R-2.md`
const B1 = `${ROOT}/board/B-1.md`
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

test('B5: a command lands at once only what it names; what it changed and doesn’t name waits for its writer, else is probably its; a temporary name is nobody’s', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [TODO]: 'todo v1\n' } })
  await begin($, w)
  // The command edits plan.md, which it names; todo.md changes meanwhile, by TEST B's tool, whose event comes a moment
  // later: it's TEST B's alone
  w.bash.value = () => {
    w.touch(PLAN, 'plan by sed\n')
    w.touch(TODO, 'todo by B\n')
  }
  await call($, { tool: 'Bash', command: "sed -i '' 's/v1/x/' notes/plan.md" })
  expect(of(w, 'notes/plan.md')).toEqual([expect.objectContaining({ via: 'bash', blind: true, by: expect.objectContaining({ sessionId: SID }) })])
  expect(of(w, 'notes/todo.md')).toEqual([])
  await tick(w, 1000)
  landByB(w, TODO, 'todo by B\n')
  await tick(w, 10000)
  await tick(w, 10000)
  expect(of(w, 'notes/todo.md').map(e => e.by.sessionId)).toEqual([B_SID])
  // A script that names nothing changes todo.md, and leaves a temporary file beside plan.md: no event explains todo.md,
  // and its time falls in the run, so it's probably the script's; the temporary name is never a landing
  w.bash.value = () => {
    w.touch(TODO, 'todo by the script\n')
    w.touch(`${ROOT}/notes/plan.md.tmp.4242.1`, 'half a plan\n')
  }
  await call($, { tool: 'Bash', command: 'python3 tools/gen.py' })
  expect(of(w, 'notes/todo.md').length).toBe(1)
  await tick(w, 1100)
  expect(json(w, `${FLEET}/reads/${SID}.json`)?.finished?.at(-1)).toEqual({ thread: 'main', at: expect.any(Number), end: expect.any(Number) })
  await tick(w, 10000)
  await tick(w, 10000)
  expect(of(w, 'notes/todo.md').at(-1)).toMatchObject({ via: 'bash', blind: true, probably: true, by: { sessionId: SID }, to: hashText('todo by the script\n') })
  expect(events(w).some(e => e.path.includes('.tmp.'))).toBe(false)
  // A word outside the project names nothing in it; a removal it doesn't name is probably its too
  w.bash.value = () => {
    w.files.delete(TODO)
  }
  await call($, { tool: 'Bash', command: 'python3 tools/gen.py --log /tmp/gen.log' })
  expect(of(w, 'notes/todo.md').length).toBe(2)
  await tick(w, 10000)
  await tick(w, 10000)
  expect(of(w, 'notes/todo.md').at(-1)).toMatchObject({ via: 'bash', probably: true, by: { sessionId: SID }, to: null })
  w.touch(TODO, 'todo v2\n')
  await tick(w, 10000)
  await tick(w, 10000)
  expect(await fleet($, 'status')).toContain("by this session's main thread (probably a command of its, landed blind)")
  // A change a minute after it isn't its: outside fleet
  await tick(w, 61000)
  w.touch(PLAN, 'plan from the editor\n')
  await tick(w, 10000)
  await tick(w, 10000)
  expect(of(w, 'notes/plan.md').at(-1)).toMatchObject({ via: 'outside', by: null })
  // Another session's command that ended a moment ago, whose run covers the change (its reads file says so): probably its
  w.touch(TODO, 'todo by B’s script\n')
  const at = w.clock.now()
  w.touch(`${FLEET}/reads/${B_SID}.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'TEST B', at, threads: {}, finished: [{ thread: 'main', at: at - 2000, end: at + 500 }] }))
  await tick(w, 10000)
  await tick(w, 10000)
  expect(of(w, 'notes/todo.md').at(-1)).toMatchObject({ via: 'bash', probably: true, by: { sessionId: B_SID } })
})

test('B5: a command that writes nothing tells its model of a change meanwhile only for a file it had read', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n', [TODO]: 'todo v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: PLAN })
  w.bash.value = () => {
    w.touch(PLAN, 'plan by someone\n')
    w.touch(TODO, 'todo by someone\n')
  }
  const text = ((await call($, { tool: 'Bash', command: 'grep -n x notes/plan.md' })).context ?? []).join('\n')
  expect(text).toContain('fleet: notes/plan.md changed while your command ran')
  expect(text).not.toContain('notes/todo.md')
})

test("B24: a Write whose version a peer's blind post-scan took first is one version, corrected to the tool's author", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'notes/**'], files: { [R1]: 'R-1 v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: R1 })
  const text = 'R-1 v2, written\n'
  w.beforeTool.value = tool => {
    if (tool !== 'Write') return
    w.beforeTool.value = () => {}
    // TEST B's command was running: its post-scan saw this write land and took the next version as its blind landing
    w.touch(R1, text)
    w.touch(`${STATE}/revs/R-1/2.json`, JSON.stringify({ format: 1, id: 'R-1', path: 'req/R-1.md', rev: 2, hash: hashText(text), kind: 'revision', changeHash: null, at: w.clock.now(), by: B, via: 'bash', pins: [], suspect: ['R-9@1:unread'] }))
  }
  const r = await call($, { tool: 'Write', file_path: R1, content: text })
  expect(r.deny).toBe(undefined)
  expect(r.context).toContain('fleet: req/R-1.md is now R-1@2.')
  expect(under(w, `${STATE}/revs/R-1`).sort()).toEqual(['1.json', '2.by.json', '2.json'])
  expect(json(w, `${STATE}/revs/R-1/2.by.json`)).toMatchObject({ format: 1, via: 'tool', by: { sessionId: SID } })
  expect(of(w, 'req/R-1.md').at(-1)).toMatchObject({ via: 'tool', rev: 2, by: { sessionId: SID } })
  // The version reads as this session's: its writer, and no blind claim's suspect
  await tick(w, 61000)
  expect(suspects(w)).toEqual([])
  expect(await fleet($, 'status --all')).not.toContain('R-9')
})

test('G19 and G27: a re-pin is editorial and flags nobody who cites it; history in the change line is no pin; 11a: a board item with no change line is editorial', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    files: {
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['req/**', 'board/**', 'notes/**'], defaultKind: { 'board/**': 'editorial' } }),
      [R1]: 'R-1 v1\n',
      [R2]: '---\nchange: "addition: first"\n---\nR-2 rests on R-1@1\n',
      [B1]: 'B-1: open\n',
      [PLAN]: 'The plan rests on R-2@1 and B-1@1\n',
    },
  })
  await begin($, w)
  landByB(w, R1, 'R-1 v2, revised\n', 2)
  await tick(w)
  await call($, { tool: 'Read', file_path: R1 })
  await call($, { tool: 'Read', file_path: R2 })
  // R-2 re-pinned to R-1@2, with a change line naming the old pin: editorial, so the plan's R-2@1 stays current
  const repin = await call($, { tool: 'Edit', file_path: R2, old_string: 'change: "addition: first"\n---\nR-2 rests on R-1@1', new_string: 'change: "revision: re-pinned from R-1@1"\n---\nR-2 rests on R-1@2' })
  expect(repin.deny).toBe(undefined)
  expect(of(w, 'req/R-2.md').at(-1)).toMatchObject({ id: 'R-2', rev: 2, kind: 'editorial', pins: ['R-1@2'] })
  // A board item read: no warning that every edit is a revision, but that only a revision change line tells whoever
  // cites it; its status moves editorially
  expect((await call($, { tool: 'Read', file_path: B1 })).context).toEqual(['fleet: this is B-1@1 (cite it so). An edit of it is editorial unless its change: line says "revision: …" (what it says changed): only then does fleet tell whoever cites it.'])
  expect((await call($, { tool: 'Edit', file_path: B1, old_string: 'open', new_string: 'done' })).deny).toBe(undefined)
  expect(of(w, 'board/B-1.md').at(-1)).toMatchObject({ id: 'B-1', rev: 2, kind: 'editorial' })
  await tick(w, 61000)
  expect(suspects(w)).toEqual([])
})

test('G19: files checked against a record as it is now are confirmed with mcp__fleet__confirm: their flags clear with no new version, until it moves again', WITH_SESSIONS, async ($, on) => {
  const P1 = `${ROOT}/notes/P-1.md`
  const P2 = `${ROOT}/notes/P-2.md`
  const w = world(on, { worldPaths: ['req/**', 'notes/**'], files: { [R1]: 'R-1 v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: R1 })
  expect((await call($, { tool: 'Write', file_path: P1, content: 'The plan rests on R-1@1\n' })).deny).toBe(undefined)
  expect((await call($, { tool: 'Write', file_path: P2, content: 'The todo rests on R-1@1\n' })).deny).toBe(undefined)
  landByB(w, R1, 'R-1 v2, revised\n', 2)
  await tick(w, 61000)
  expect(suspects(w)).toEqual(['notes/P-1.md', 'notes/P-2.md'])
  const confirm = (input: Record<string, unknown>) => call($, { tool: 'mcp__fleet__confirm', ...input })
  expect((await confirm({ of: 'R-1' })).deny).toContain('read req/R-1.md first')
  await call($, { tool: 'Read', file_path: R1 })
  expect((await confirm({ of: 'R-1@1' })).deny).toContain('R-1 is at v2, not v1')
  expect((await confirm({ of: 'R-7' })).deny).toContain('is no record fleet knows')
  expect((await confirm({ of: 'R-1', paths: ['notes/nothing.md'] })).deny).toContain("doesn't cite R-1")
  const versions = () => [...under(w, `${STATE}/revs/P-1`), ...under(w, `${STATE}/revs/P-2`)]
  const before = versions()
  // P-1 only, by name; then every file it wrote last that cites R-1
  expect((await confirm({ of: 'R-1', paths: ['notes/P-1.md'], why: 'the rate it uses is unchanged' })).result).toContain('1 file(s) confirmed against R-1@2 (notes/P-1.md)')
  await tick(w, 61000)
  expect(suspects(w)).toEqual(['notes/P-2.md'])
  expect((await confirm({ of: 'R-1@2' })).result).toContain('2 file(s) confirmed against R-1@2 (notes/P-1.md, notes/P-2.md)')
  await tick(w, 61000)
  expect(suspects(w)).toEqual([])
  expect(under(w, `${STATE}/confirms`).length).toBe(2)
  expect(versions()).toEqual(before)
  expect(json(w, `${STATE}/confirms/${under(w, `${STATE}/confirms`)[0]}`)).toMatchObject({ format: 1, of: 'R-1', rev: 2, by: { sessionId: SID } })
  // R-1 moves again: flagged again
  landByB(w, R1, 'R-1 v3, revised again\n', 3)
  await tick(w, 61000)
  expect(suspects(w)).toEqual(['notes/P-1.md', 'notes/P-2.md'])
})

test('integrator: a pin of exactly the version this thread read, in the last 15 minutes, passes the gate though the record moved; flagged later all the same', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'notes/**'], files: { [R1]: 'R-1 v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: R1 })
  landByB(w, R1, 'R-1 v2, revised\n', 2)
  await tick(w)
  expect((await call($, { tool: 'Write', file_path: PLAN, content: 'The plan rests on R-1@1\n' })).deny).toBe(undefined)
  await tick(w, 61000)
  expect(suspects(w)).toEqual(['notes/plan.md'])
  // A quarter of an hour on, that read isn't fresh: refused once, with what to read
  await tick(w, 15 * 60000)
  expect((await call($, { tool: 'Write', file_path: TODO, content: 'The todo rests on R-1@1\n' })).deny).toContain('- R-1@1: R-1 is at v2 now')
})

test('pin gate: an Edit is refused only for the stale pins it writes; one left elsewhere in the file is told after it lands', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'notes/**'], files: { [R1]: 'R-1 v1\n', [R2]: 'R-2 v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: R1 })
  await call($, { tool: 'Read', file_path: R2 })
  expect((await call($, { tool: 'Write', file_path: PLAN, content: 'Rests on R-1@1.\nAnd on R-2@1.\nStatus: open\n' })).deny).toBe(undefined)
  landByB(w, R1, 'R-1 v2, revised\n', 2)
  landByB(w, R2, 'R-2 v2, revised\n', 2)
  await tick(w, 16 * 60000)
  const status = await call($, { tool: 'Edit', file_path: PLAN, old_string: 'Status: open', new_string: 'Status: done' })
  expect(status.deny).toBe(undefined)
  expect(status.context).toContain("fleet: notes/plan.md still cites R-1@1 (R-1 is at v2), R-2@1 (R-2 is at v2), outside what you edited. It stays flagged to you until that's checked: read what it cites, then re-pin it, or say it holds with mcp__fleet__confirm.")
  const pinned = await call($, { tool: 'Edit', file_path: PLAN, old_string: 'And on R-2@1.', new_string: 'And on R-2@1, still.' })
  expect(pinned.deny).toContain('- R-2@1: R-2 is at v2 now')
  expect(pinned.deny).not.toContain('R-1@1')
  expect(pinned.deny).toContain('A read is the Read tool or a plain cat of the file.')
})

test('quotes: a finding whose quoted source lands is checked again with it; one whose source changed outside fleet, at the next sweep', WITH_SESSIONS, async ($, on) => {
  const SHEET = `${ROOT}/notes/sheet.md`
  const F1 = `${ROOT}/findings/F-1.md`
  const checks = [{ name: 'proofs', glob: 'findings/**', argv: ['python3', 'checks/proof-check.py'] }]
  const w = world(on, {
    files: {
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['findings/**', 'notes/**'], proofs: { paths: ['findings/**'] }, checks }),
      [`${ROOT}/checks/proof-check.py`]: 'print()\n',
      [SHEET]: 'The rate is 42 per second.\n',
      [F1]: '---\nkind: finding\nsource: notes/sheet.md\nquote: "The rate is 42 per second"\n---\n',
    },
  })
  const ran: string[][] = []
  w.exec.value = argv => {
    if (argv[0] !== 'python3') return undefined
    ran.push(argv.slice(2))
    const bad = argv.slice(2).filter(p => p === 'findings/F-1.md' && !w.files.get(SHEET)?.includes('42 per second'))
    return bad.length ? { exitCode: 1, stdout: bad.map(p => `${p}: quote no longer in notes/sheet.md (it changed after this file)`).join('\n') } : { exitCode: 0 }
  }
  await begin($, w)
  expect(await fleet($, 'accept checks')).toContain('Stamped: proofs')
  await tick(w, 61000)
  expect(ran).toEqual([['findings/F-1.md']])
  // The sheet lands through the gate: the finding that quotes it is checked again at once
  await call($, { tool: 'Read', file_path: SHEET })
  expect((await call($, { tool: 'Edit', file_path: SHEET, old_string: '42', new_string: '41' })).deny).toBe(undefined)
  await tick(w, 100)
  expect(ran.at(-1)).toEqual(['findings/F-1.md'])
  await tick(w)
  expect(await fleet($, 'status')).toContain('findings/F-1.md: proofs: quote no longer in notes/sheet.md')
  // Back to 42 by an editor: the next sweep checks the finding again, and it passes
  w.touch(SHEET, 'The rate is 42 per second.\n')
  await tick(w, 61000)
  await tick(w, 61000)
  expect(await fleet($, 'status')).toContain('failing a check: nothing')
})
