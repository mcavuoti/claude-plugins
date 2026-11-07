import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { FLEET, REF, ROOT, SID, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// The review of 0.12.2's own fixes: the digest's memo of what it told, and the gate's view of a record's versions

const STATE = `${FLEET}/state`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const B = { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'TEST B' }
const CURRENT = { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null } }

async function tick(w: World, ms = 2100) {
  for (let left = ms; left > 0; left -= 60000) {
    await w.clock.advance(Math.min(left, 60000))
    await w.clock.settle()
  }
}
async function call($: any, input: Record<string, unknown>): Promise<any> {
  return $.tool.call(input as any)
}
const ctx = (r: any) => (r?.context ?? []).join('\n')

let n = 0
// Another session's landing of a plain file, as its fleet writes it: the file, its event, events/latest
function landByB(w: World, path: string, text: string) {
  const before = w.files.get(path)
  w.touch(path, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${++n}.json`
  const ev = { format: 1, at, path: path.slice(ROOT.length + 1), from: before === undefined ? null : hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: B }
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify(ev))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}
// The same for a record: its next version too
function landRecordByB(w: World, path: string, text: string, rev: number, kind = 'revision') {
  const rel = path.slice(ROOT.length + 1)
  const id = (/^[A-Z]+-\d+/.exec(rel.slice(rel.lastIndexOf('/') + 1)) as RegExpExecArray)[0]
  const before = w.files.get(path)
  w.touch(path, text)
  const at = w.clock.now()
  w.touch(`${STATE}/revs/${id}/${rev}.json`, JSON.stringify({ format: 1, id, path: rel, rev, hash: hashText(text), kind, changeHash: null, at, by: B, via: 'tool', pins: [] }))
  const name = `${at}-bbbbbbbb-${++n}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path: rel, from: before === undefined ? null : hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: B, id, rev, kind }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}
async function begin($: any, w: World) {
  sessionsSay(w, CURRENT)
  await startSession($, w)
  await tick(w, 1100)
  await tick(w)
  await tick(w)
}

// ---- What the digest told: a later change back to that version, after a new read, is news again ----

test('a file that goes back to a version told before, after the thread read a newer one, is told again', WITH_SESSIONS, async ($, on) => {
  const X = `${ROOT}/notes/x.md`
  const P = `${ROOT}/notes/p.md`
  const w = world(on, { worldPaths: ['notes/**'], files: { [X]: 'x v1\n', [P]: 'p\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: X })
  // B changes it: told at the next step
  landByB(w, X, 'x v2\n')
  await tick(w)
  expect(ctx(await call($, { tool: 'Read', file_path: P })).includes('- notes/x.md:')).toBe(true)
  // B changes it again; this thread reads it as it is now (v3)
  landByB(w, X, 'x v3\n')
  await tick(w)
  await call($, { tool: 'Read', file_path: X })
  // B puts back v2 (an undo, a revert): the thread read v3, so this is news to it
  landByB(w, X, 'x v2\n')
  await tick(w)
  expect(ctx(await call($, { tool: 'Read', file_path: P }))).toContain('- notes/x.md:')
})

test('a file that toggles between two texts (a status flipped back and forth) is told each time it changes after a read', WITH_SESSIONS, async ($, on) => {
  const X = `${ROOT}/board/B-5.md`
  const P = `${ROOT}/notes/p.md`
  const OPEN = '---\nowner: open\nstatus: open\n---\n# Measure\n'
  const TAKEN = '---\nowner: TEST B\nstatus: taken\n---\n# Measure\n'
  const w = world(on, { worldPaths: ['notes/**', 'board/**'], files: { [X]: OPEN, [P]: 'p\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: X })
  landByB(w, X, TAKEN)
  await tick(w)
  expect(ctx(await call($, { tool: 'Read', file_path: P })).includes('- board/B-5.md:')).toBe(true)
  // Given back, and this thread reads it open again
  landByB(w, X, OPEN)
  await tick(w)
  await call($, { tool: 'Read', file_path: X })
  // Taken again: news to a thread that read it open
  landByB(w, X, TAKEN)
  await tick(w)
  expect(ctx(await call($, { tool: 'Read', file_path: P }))).toContain('- board/B-5.md:')
})

test('a file that goes back to a version told before, after a refused write told the newer one, is told again', WITH_SESSIONS, async ($, on) => {
  const X = `${ROOT}/notes/x.md`
  const P = `${ROOT}/notes/p.md`
  const w = world(on, { worldPaths: ['notes/**'], files: { [X]: 'x v1\n', [P]: 'p\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: X })
  landByB(w, X, 'x v2\n')
  await tick(w)
  expect(ctx(await call($, { tool: 'Read', file_path: P })).includes('- notes/x.md:')).toBe(true)
  // B changes it again before this thread looks: its write is refused, which tells it v3
  landByB(w, X, 'x v3\n')
  await tick(w)
  expect((await call($, { tool: 'Edit', file_path: X, old_string: 'x', new_string: 'y' })).deny).toContain('notes/x.md')
  // B puts back v2: news to a thread last told v3
  landByB(w, X, 'x v2\n')
  await tick(w)
  expect(ctx(await call($, { tool: 'Read', file_path: P }))).toContain('- notes/x.md:')
})

// ---- The gate sees a version another session published a moment ago ----

test('under strict, a write citing a version another session revised a moment ago is refused (the gate looks at the versions)', WITH_SESSIONS, async ($, on) => {
  const R1 = `${ROOT}/req/R-1.md`
  const B1 = `${ROOT}/board/B-1.md`
  const WORK = '---\nrelies_on: [R-1@1]\n---\nB-1: the work, built on R-1@1\n'
  const w = world(on, { files: { [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['req/**', 'board/**'], strict: true }), [R1]: 'R-1 v1\n', [B1]: WORK } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: B1 })
  await call($, { tool: 'Read', file_path: R1 })
  // Past main's 1 s cache (a world tick that fires meanwhile finds no landing yet)
  await w.clock.advance(1200)
  // B revises R-1 now; this session hasn't pulled its event yet
  landRecordByB(w, R1, 'R-1 v2\n', 2)
  const edit = { tool: 'Edit', file_path: B1, old_string: 'the work', new_string: 'the work, more' }
  expect((await call($, edit)).deny).toContain('R-1@1: R-1 is at v2 now')
})
