import { expect, test } from 'claude-code/testing'

import { bashWritesNothing, hashText, hourFolder } from '../hooks/changes'
import { bodyHashOf, landingKind, pinsOf, recordsOf } from '../hooks/records'
import { FLEET, REF, ROOT, SID, json, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// The review of 0.10's attribution part: version ranges that are prose, a mark that outlives a long permission prompt,
// copies that aren't copies, sed read both ways, a quiet tell held back for one busy record, and state/writing/'s format
// and upkeep

const STATE = `${FLEET}/state`
const R1 = `${ROOT}/req/R-1.md`
const R2 = `${ROOT}/req/R-2.md`
const B1 = `${ROOT}/board/B-1.md`
const B2 = `${ROOT}/board/B-2.md`
const PLAN = `${ROOT}/notes/plan.md`
const R_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const RB = { sessionId: R_SID, agentId: null, ref: 'bbbbbbbb', name: 'TEST R' }
const CURRENT = { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST W', root: ROOT, background: true, agent: null } }
const inWorld = (t: string) => !t.startsWith('/tmp/')
const recs = (() => {
  const r = recordsOf({ worldFormat: 1, paths: ['notes/**', 'board/**', 'req/**'] }, false)
  if (!('records' in r)) throw new Error(JSON.stringify(r))
  return r.records
})()
const pins = (s: string) => pinsOf(s, recs).map(p => `${p.id}@${p.rev}`)

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
function landByR(w: World, path: string, text: string, rev: number, kind = 'revision', pinList: string[] = []) {
  const rel = path.slice(ROOT.length + 1)
  const id = (/^[A-Z]+-\d+/.exec(rel.slice(rel.lastIndexOf('/') + 1)) as RegExpExecArray)[0]
  const before = w.files.get(path)
  w.touch(path, text)
  const at = w.clock.now()
  w.touch(`${STATE}/revs/${id}/${rev}.json`, JSON.stringify({ format: 1, id, path: rel, rev, hash: hashText(text), kind, changeHash: null, at, by: RB, via: 'tool', pins: pinList }))
  const name = `${at}-bbbbbbbb-${++n}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path: rel, from: before === undefined ? null : hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: RB, id, rev, kind, pins: pinList }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}

function eventsOf(w: World, rel: string): any[] {
  return [...w.files.keys()]
    .filter(p => p.startsWith(`${FLEET}/events/`) && /\/\d{4}-\d{2}-\d{2}\/\d{2}\/[^/]+\.json$/.test(p))
    .map(p => JSON.parse(w.files.get(p) as string))
    .filter(e => e.path === rel)
    .sort((a, b) => a.at - b.at)
}

const markOf = (rel: string, sid8 = 'bbbbbbbb') => `${FLEET}/state/writing/${hashText(rel).slice(1, 17)}-${sid8}-main.json`

// ---- 1. Ranges: only with an @ after a dash, and an end past the start ----

test('a dash and a number after a pin is prose, not a range: a count, a date, a time', () => {
  expect(pins('Built on F-7@3 — 2 tests still fail.')).toEqual(['F-7@3'])
  expect(pins('Decided on R-12@4 – 2026-11-05 review.')).toEqual(['R-12@4'])
  expect(pins('B-7@3 — 14:00 standup')).toEqual(['B-7@3'])
  expect(pins('F-7@3 – 120 ms')).toEqual(['F-7@3'])
  // A range's end is past its start
  expect(pins('F-7@5–@3')).toEqual(['F-7@5'])
  expect(pins('F-7@5..2')).toEqual(['F-7@5'])
  expect(pins('Checked F-7@3–@5.')).toEqual(['F-7@5'])
})

test("a number after a pin and a dash is part of the body: a revision of it isn't editorial", () => {
  const a = '---\nchange: "addition: first result"\n---\nResult: F-7@3 — 2 of 5 checks fail.\n'
  const b = '---\nchange: "revision: more failures"\n---\nResult: F-7@3 — 4 of 5 checks fail.\n'
  expect(bodyHashOf(a, recs)).not.toBe(bodyHashOf(b, recs))
  const prev = { rev: 1, hash: 'hA', kind: 'addition', changeHash: 'x', bodyHash: bodyHashOf(a, recs) } as any
  expect(landingKind({ kind: 'revision', hash: 'y' }, prev, false, { bodyHash: bodyHashOf(b, recs) })).toBe('revision')
  // A real range's ends are pins' numbers: moving them is a re-pin
  expect(bodyHashOf('Checked F-7@3–@5.', recs)).toBe(bodyHashOf('Checked F-7@4–@9.', recs))
  // An end that isn't one stays in the body
  expect(bodyHashOf('F-7@5..2 left', recs)).not.toBe(bodyHashOf('F-7@5..3 left', recs))
})

test('prose after a pin makes no file suspect for a version not there', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'notes/**'], files: { [R1]: 'R-1 v1\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: R1 } as any)
  expect((await $.tool.call({ tool: 'Write', file_path: PLAN, content: 'Plan: per R-1@1 — 2 open questions left.\n' } as any)).deny).toBe(undefined)
  await tick(w, 10000)
  await tick(w, 10000)
  expect(json(w, `${STATE}/suspects.json`).suspects).toEqual([])
})

// ---- 2. A mark stays fresh while its write waits (a permission prompt) ----

test("this session's mark is kept fresh while its write waits beneath (a permission prompt), and done after", WITH_SESSIONS, async ($, on) => {
  let release: (() => void) | null = null
  let seen: any = null
  on('tool.call', { tool: 'Write' } as any, async () => {
    await new Promise<void>(r => {
      release = r
    })
    seen = JSON.parse(w.files.get(markOf('notes/plan.md', 'aaaaaaaa')) ?? 'null')
    return { deny: 'The user rejected this write' } as any
  })
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  const pending = $.tool.call({ tool: 'Write', file_path: PLAN, content: 'plan v2\n' } as any)
  for (let i = 0; i < 4; i++) await tick(w, 10000)
  ;(release as unknown as () => void)()
  const r: any = await pending
  expect(r.deny).toBe('The user rejected this write')
  expect(seen).toMatchObject({ path: 'notes/plan.md' })
  expect(seen.done).toBe(undefined)
  expect(w.clock.now() - seen.at).toBeLessThan(15000)
  await tick(w)
  expect(json(w, markOf('notes/plan.md', 'aaaaaaaa'))).toMatchObject({ done: true })
})

// ---- 3. A copy carries its source's pins only when it is one ----

const B1_OLD = '---\nrelies_on: [R-1@1]\n---\nB-1: built on R-1@1\n'
const B2_NOW = '---\nrelies_on: [R-1@2]\n---\nB-2: built on R-1@2\n'

test("a blind re-pin over a glob isn't cleared by another file the glob names that cites the new version", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'board/**'], files: { [R1]: 'R-1 v1\n', [B1]: B1_OLD } })
  await begin($, w)
  landByR(w, R1, 'R-1 v2, revised\n', 2)
  await tick(w)
  landByR(w, B2, B2_NOW, 1, 'addition', ['R-1@2'])
  await tick(w)
  await tick(w)
  w.bash.value = () => w.touch(B1, B1_OLD.replaceAll('R-1@1', 'R-1@2'))
  const r: any = await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/R-1@1/R-1@2/g' board/*.md" } as any)
  expect((r.context ?? []).join('\n')).toContain("your command wrote board/B-1.md, which cites R-1@2 (you haven't read R-1)")
  expect(eventsOf(w, 'board/B-1.md').at(-1)).toMatchObject({ via: 'bash', blind: true, suspect: ['R-1@2:unread'] })
})

// ---- 4. sed read both ways (GNU and BSD), and its options ----

test("sed: a write either GNU's or BSD's reading finds counts; -l's value is a number; -I is in place; long options by prefix", () => {
  for (const c of [
    "sed -n ':a;N;$!ba;w board/out.md' notes/a.md",
    "sed -n ':a;N;$!ba;s/x/y/gw board/out.md' notes/a.md",
    "sed -l 's/x/y/w board/out.md' board/in.md",
    "sed 's/[/]/ a/w board/out.md' board/in.md",
    "sed -I '' 's/x/y/' board/in.md",
    "sed -n --expr='w board/out.md' board/in.md",
    "sed --in 's/x/y/' board/in.md",
    "sed --fi=/tmp/x.sed board/in.md",
  ]) {
    expect([c, bashWritesNothing(c, inWorld)]).toEqual([c, false])
  }
  for (const c of ["sed -l 100 -n '1,5p' board/in.md", "sed -n ':a;N;$!ba;p' notes/a.md", "sed -n 's/[/]/x/p' board/in.md", "sed --quiet -e '1p' board/in.md"]) {
    expect([c, bashWritesNothing(c, inWorld)]).toEqual([c, true])
  }
})

// ---- 5. The quiet tell holds back only what's busy, and not for ever ----

const WORK2 = '---\nrelies_on: [R-1@1, R-2@1]\n---\nB-1: the work, built on R-1@1 and R-2@1\n'

test('a file citing a quiet revised record and a busy one is told the quiet one; the busy one at most 10 minutes late', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'board/**'], files: { [R1]: 'R-1 v1\n', [R2]: 'R-2 v1\n', [B1]: WORK2 } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: R1 } as any)
  await $.tool.call({ tool: 'Read', file_path: R2 } as any)
  await $.tool.call({ tool: 'Read', file_path: B1 } as any)
  expect(((await $.tool.call({ tool: 'Edit', file_path: B1, old_string: 'the work', new_string: 'the work, started' } as any)) as any).deny).toBe(undefined)
  landByR(w, R1, 'R-1 v2, revised\n', 2)
  await tick(w)
  await tick(w)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  // R-1 is quiet from here on; R-2 moves every 90 s
  const said: string[] = []
  for (let k = 2; k <= 10; k++) {
    await tick(w, 88000)
    landByR(w, R2, `R-2 v${k}\n`, k)
    await tick(w)
    said.push(((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)) as any).context?.join('\n') ?? '')
  }
  const r1At = said.findIndex(s => s.includes('cites R-1@1'))
  const r2At = said.findIndex(s => s.includes('cites R-2@1'))
  // R-1's line in the first steps (it's quiet two minutes after its revision); R-2's within the cap, though R-2 never stops
  expect(r1At).toBeGreaterThanOrEqual(0)
  expect(r1At).toBeLessThanOrEqual(1)
  expect(r2At).toBeGreaterThan(r1At)
  expect(r2At).toBeLessThanOrEqual(7)
})

// ---- The held SendMessage, in words for one write and for several ----

test('a SendMessage held after two refused writes of the same batch says they were refused, so they didn’t land', WITH_SESSIONS, async ($, on) => {
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
  })
  on('tool.call', { tool: 'SendMessage' } as any, () => ({ result: { success: true }, text: 'sent' }) as any)
  const step = async (index: number) => {
    const s = $.turn.step({ turnId: 't-1', index, model: 'claude-haiku-5-5', messageCount: 1 + index })
    for await (const _ of s) {
    }
    await s.result
  }
  const w = world(on, { worldPaths: ['req/**', 'board/**'], files: { [R1]: 'R-1 v1\n', [R2]: 'R-2 v1\n', [B1]: 'B-1 on R-1@1\n', [B2]: 'B-2 on R-1@1\n' } })
  await begin($, w)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await step(0)
  await $.tool.call({ tool: 'Read', file_path: B1 } as any)
  await $.tool.call({ tool: 'Read', file_path: B2 } as any)
  await step(1)
  expect((await $.tool.call({ tool: 'Edit', file_path: B1, old_string: 'on R-1@1', new_string: 'on R-1@1 and R-2@1' } as any)).deny).toBeTruthy()
  expect((await $.tool.call({ tool: 'Edit', file_path: B2, old_string: 'on R-1@1', new_string: 'on R-1@1 and R-2@1' } as any)).deny).toBeTruthy()
  const held: any = await $.tool.call({ tool: 'SendMessage', to: 'TEST R', message: 'both cite R-2@1 now' } as any)
  expect(String(held.deny)).toContain("your Edit of board/B-1.md and Edit of board/B-2.md in this same batch were refused, so they didn't land. Send it once they land, or send it again as it is.")
})

// ---- 6 and 7. state/writing/: a format, put in place whole, read once a scan, done marks gone soon ----

test("a mark of another format is acted on by nothing: the command's write is its own", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  w.touch(markOf('notes/plan.md'), JSON.stringify({ format: 99, path: 'notes/plan.md', sessionId: R_SID, agentId: null, at: w.clock.now() }))
  w.bash.value = () => w.touch(PLAN, 'plan by the script\n')
  await $.tool.call({ tool: 'Bash', command: 'python3 /tmp/x/fix.py notes/plan.md' } as any)
  expect(eventsOf(w, 'notes/plan.md').map(e => `${e.via}${e.blind ? ' blind' : ''} ${e.by?.name ?? 'nobody'}`)).toEqual(['bash blind TEST W'])
})

test("a command's post-scan lists state/writing/ once, whatever it changed; a done mark is gone within minutes", WITH_SESSIONS, async ($, on) => {
  const files: Record<string, string> = {}
  for (let i = 1; i <= 8; i++) files[`${ROOT}/notes/n${i}.md`] = `n${i}\n`
  const w = world(on, { worldPaths: ['notes/**'], files })
  await begin($, w)
  w.touch(markOf('notes/other.md'), JSON.stringify({ format: 1, path: 'notes/other.md', sessionId: R_SID, agentId: null, at: w.clock.now(), done: true }))
  w.bash.value = () => {
    for (let i = 1; i <= 8; i++) w.touch(`${ROOT}/notes/n${i}.md`, `n${i} rewritten\n`)
  }
  const from = w.lists.length
  await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/n/m/' notes/*.md" } as any)
  expect(w.lists.slice(from).filter(p => p.endsWith('/.claude/fleet/state/writing')).length).toBeLessThanOrEqual(1)
  expect(eventsOf(w, 'notes/n1.md').at(-1)).toMatchObject({ via: 'bash', blind: true })
  for (let i = 0; i < 8; i++) await tick(w, 2 * 60000)
  expect(w.files.has(markOf('notes/other.md'))).toBe(false)
})

test("this session's marks are put in place whole (a temporary file moved over it) and carry a format", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  expect((await $.tool.call({ tool: 'Write', file_path: PLAN, content: 'plan v2\n' } as any)).deny).toBe(undefined)
  expect(json(w, markOf('notes/plan.md', 'aaaaaaaa'))).toMatchObject({ format: 1, path: 'notes/plan.md', done: true })
  expect(w.runs.some(r => r[0] === 'mv' && String(r.at(-1)).includes('/state/writing/'))).toBe(true)
})
