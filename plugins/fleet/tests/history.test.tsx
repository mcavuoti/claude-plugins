import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { bodyHashOf, pinsOf, recordsOf } from '../hooks/records'
import { FLEET, REF, ROOT, SID, json, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// G31: a register many sessions write a row of (a list of runs, a log) is history, like a journal: each row cites what
// it rested on when it was written. world.json's history globs name such files: their pins are never stale, never
// refused, never make the file suspect

const STATE = `${FLEET}/state`
const R1 = `${ROOT}/req/R-1.md`
const RUNS = `${ROOT}/notes/runs.md`
const R_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const RB = { sessionId: R_SID, agentId: null, ref: 'bbbbbbbb', name: 'TEST R' }
const CURRENT = { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST W', root: ROOT, background: true, agent: null } }

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
function landByR(w: World, path: string, text: string, rev: number, kind = 'revision') {
  const rel = path.slice(ROOT.length + 1)
  const id = (/^[A-Z]+-\d+/.exec(rel.slice(rel.lastIndexOf('/') + 1)) as RegExpExecArray)[0]
  const before = w.files.get(path)
  w.touch(path, text)
  const at = w.clock.now()
  w.touch(`${STATE}/revs/${id}/${rev}.json`, JSON.stringify({ format: 1, id, path: rel, rev, hash: hashText(text), kind, changeHash: null, at, by: RB, via: 'tool', pins: [] }))
  const name = `${at}-bbbbbbbb-${++n}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path: rel, from: before === undefined ? null : hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: RB, id, rev, kind }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}

const WORLD = (history: boolean) => JSON.stringify({ worldFormat: 1, paths: ['req/**', 'notes/**'], ...(history ? { history: ['notes/runs.md'] } : {}) })

for (const history of [false, true]) {
  test(`G31: a shared register ${history ? 'named in world.json history keeps its rows’ pins as written' : 'not named in history is flagged and refused as any file'}`, WITH_SESSIONS, async ($, on) => {
    const w = world(on, { files: { [`${FLEET}/world.json`]: WORLD(history), [R1]: 'R-1 v1\n', [RUNS]: '| run | rests on |\n| --- | --- |\n' } })
    await begin($, w)
    await $.tool.call({ tool: 'Read', file_path: R1 } as any)
    await $.tool.call({ tool: 'Read', file_path: RUNS } as any)
    expect((await $.tool.call({ tool: 'Edit', file_path: RUNS, old_string: '| --- | --- |\n', new_string: '| --- | --- |\n| run-1 | R-1@1 |\n' } as any)).deny).toBe(undefined)
    // R-1 is revised; much later, another row still says what it rested on then
    landByR(w, R1, 'R-1 v2, changed\n', 2)
    for (let i = 0; i < 6; i++) await tick(w, 10000)
    const suspects = (json(w, `${STATE}/suspects.json`)?.suspects ?? []).map((s: any) => s.path)
    await tick(w, 20 * 60000)
    const row = (await $.tool.call({ tool: 'Edit', file_path: RUNS, old_string: '| run-1 | R-1@1 |\n', new_string: '| run-1 | R-1@1 |\n| run-2 | R-1@1 |\n' } as any)).deny
    if (history) {
      expect(suspects).not.toContain('notes/runs.md')
      expect(row).toBe(undefined)
      expect(w.files.get(RUNS)).toContain('| run-2 | R-1@1 |')
    } else {
      expect(suspects).toContain('notes/runs.md')
      expect(String(row)).toContain('R-1@1: R-1 is at v2 now')
    }
  })
}

test('world.json history: a list of globs; anything else is named', () => {
  const ok = recordsOf({ worldFormat: 1, paths: ['notes/**'], history: ['notes/runs.md', 'logs/**'] }, false)
  expect('records' in ok && ok.records.history.map(h => h.glob)).toEqual(['notes/runs.md', 'logs/**'])
  expect(recordsOf({ worldFormat: 1, paths: [], history: 'notes/runs.md' }, false)).toEqual({ problem: 'world.json: history is a list of globs: ["notes/runs.md"]' })
  expect('problem' in recordsOf({ worldFormat: 1, paths: [], history: ['/abs/x.md'] }, false)).toBe(true)
})

test('a range of versions in prose (F-7@3–@5, F-7@3-@5, F-7@3..5, F-7@3 to @5) cites its last one; its body hash ignores both ends', () => {
  const r = recordsOf({ worldFormat: 1, paths: ['notes/**'] }, false)
  if (!('records' in r)) throw new Error('records')
  const pins = (s: string) => pinsOf(s, r.records).map(p => `${p.id}@${p.rev}`)
  expect(pins('Checked from F-7@3–@5, all hold.')).toEqual(['F-7@5'])
  expect(pins('F-7@3 – @5')).toEqual(['F-7@5'])
  expect(pins('F-7@3—@6')).toEqual(['F-7@6'])
  expect(pins('F-7@3-@5')).toEqual(['F-7@5'])
  expect(pins('F-7@3..5')).toEqual(['F-7@5'])
  expect(pins('F-7@3..@5')).toEqual(['F-7@5'])
  expect(pins('F-7@3 to @5')).toEqual(['F-7@5'])
  // Not ranges: a sentence ending, another id's pin, a dash with no @
  expect(pins('Rests on F-7@3... and more')).toEqual(['F-7@3'])
  expect(pins('F-7@3 to F-8@2')).toEqual(['F-7@3', 'F-8@2'])
  expect(pins('F-7@3-5 east')).toEqual(['F-7@3'])
  expect(bodyHashOf('Checked F-7@3–@5.', r.records)).toBe(bodyHashOf('Checked F-7@4–@9.', r.records))
})

test("a derived copy made by a command (tail -n +N of a checked file) carries its source's pins: no read of its own needed, a pin it adds still needs one", WITH_SESSIONS, async ($, on) => {
  const CHECKED = `${ROOT}/notes/checked.md`
  const SEND = `${ROOT}/notes/send.md`
  const w = world(on, { worldPaths: ['req/**', 'notes/**'], files: { [R1]: 'R-1 v1\n', [`${ROOT}/req/R-2.md`]: 'R-2 v1\n', [CHECKED]: '---\nfront: x\n---\nThe plan rests on R-1@1.\n' } })
  await begin($, w)
  // This thread never read R-1: the copy's pin is the checked file's, which it names
  w.bash.value = () => w.touch(SEND, 'The plan rests on R-1@1.\n')
  const r: any = await $.tool.call({ tool: 'Bash', command: 'tail -n +4 notes/checked.md > notes/send.md' } as any)
  expect((r.context ?? []).join('\n')).not.toContain('marked suspect')
  for (let i = 0; i < 3; i++) await tick(w, 10000)
  expect((json(w, `${STATE}/suspects.json`)?.suspects ?? []).map((s: any) => s.path)).not.toContain('notes/send.md')
  // A pin the copy adds on a line of its own still needs its read; the copied line's pin is still carried
  w.bash.value = () => w.touch(SEND, 'The plan rests on R-1@1.\nand R-2@1\n')
  const more: any = await $.tool.call({ tool: 'Bash', command: '{ tail -n +4 notes/checked.md; echo and R-2@1; } > notes/send.md' } as any)
  const told = (more.context ?? []).join('\n')
  expect(told).toContain('R-2@1')
  expect(told).toContain('marked suspect')
  expect(told).not.toContain('R-1@1')
  // A copied line rewritten (here: a pin added to it) isn't a copy: its pins need their reads
  w.bash.value = () => w.touch(`${ROOT}/notes/send2.md`, 'The plan rests on R-1@1 and R-2@1.\n')
  const merged: any = await $.tool.call({ tool: 'Bash', command: "sed 's/R-1@1/R-1@1 and R-2@1/' notes/checked.md | tail -n +4 > notes/send2.md" } as any)
  expect((merged.context ?? []).join('\n')).toContain('R-1@1')
})
