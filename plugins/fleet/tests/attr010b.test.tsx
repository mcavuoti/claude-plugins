import { expect, test } from 'claude-code/testing'

import { bashWritesNothing, hashText, hourFolder } from '../hooks/changes'
import { FLEET, REF, ROOT, SID, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// The second review of 0.10's attribution part: a mark that stands only for the write it announces, copies decided
// pin by pin and read once, the quiet cap from a burst's start and each reason told once, marks read only for the
// files changed, BSD's -l inside a cluster, and a copy into a folder of the world

const STATE = `${FLEET}/state`
const R1 = `${ROOT}/req/R-1.md`
const R2 = `${ROOT}/req/R-2.md`
const B1 = `${ROOT}/board/B-1.md`
const PLAN = `${ROOT}/notes/plan.md`
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
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path: rel, from: before === undefined ? null : hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: RB, id, rev, kind, pins: [] }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}

function eventsOf(w: World, rel: string): any[] {
  return [...w.files.keys()]
    .filter(p => p.startsWith(`${FLEET}/events/`) && /\/\d{4}-\d{2}-\d{2}\/\d{2}\/[^/]+\.json$/.test(p))
    .map(p => JSON.parse(w.files.get(p) as string))
    .filter(e => e.path === rel)
    .sort((a, b) => a.at - b.at)
}
const said = (e: any) => `${e.via}${e.blind ? ' blind' : ''}${e.probably ? ' probably' : ''} ${e.by?.name ?? 'nobody'}${e.suspect ? ` ${e.suspect.join(',')}` : ''}`
const markOf = (rel: string, sid8: string) => `${FLEET}/state/writing/${hashText(rel).slice(1, 17)}-${sid8}-main.json`

// ---- 1. A mark stands only for the write it announces ----

test("a peer's prompt open five minutes hides no other write of the file: this session's sed is its own, told at once", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**', 'req/**'], files: { [PLAN]: 'plan v1\n', [R1]: 'R-1 v1\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  // The peer's gate: its mark for the text its Write will leave, rewritten every 10 s while its prompt is open
  const since = w.clock.now()
  const peerMark = (done = false) =>
    w.touch(markOf('notes/plan.md', 'bbbbbbbb'), JSON.stringify({ format: 1, path: 'notes/plan.md', sessionId: R_SID, agentId: null, at: w.clock.now(), since, to: hashText('plan by the peer\n'), ...(done ? { done: true } : {}) }))
  peerMark()
  for (let t = 0; t < 300000; t += 10000) {
    await tick(w, 10000)
    peerMark()
  }
  w.bash.value = () => w.touch(PLAN, 'plan v1, per R-1@1\n')
  const r: any = await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/v1/v1, per R-1@1/' notes/plan.md" } as any)
  for (let t = 0; t < 60000; t += 10000) {
    await tick(w, 10000)
    peerMark()
  }
  peerMark(true)
  for (let i = 0; i < 4; i++) await tick(w, 10000)
  expect(eventsOf(w, 'notes/plan.md').map(said)).toEqual(['bash blind TEST W R-1@1:unread'])
  expect((r.context ?? []).join('\n')).toContain("haven't read R-1")
  const next: any = await $.tool.call({ tool: 'Edit', file_path: PLAN, old_string: 'per R-1@1', new_string: 'per R-1@1, edited' } as any)
  expect(String(next.deny ?? '')).not.toContain('after you read it')
})

test("the peer's own write, approved after five minutes, is still left to its event: the file has the text its mark announced", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  const since = w.clock.now()
  const peerMark = (done = false) =>
    w.touch(markOf('notes/plan.md', 'bbbbbbbb'), JSON.stringify({ format: 1, path: 'notes/plan.md', sessionId: R_SID, agentId: null, at: w.clock.now(), since, to: hashText('plan by the peer\n'), ...(done ? { done: true } : {}) }))
  peerMark()
  for (let t = 0; t < 300000; t += 10000) {
    await tick(w, 10000)
    peerMark()
  }
  w.bash.value = () => w.touch(PLAN, 'plan by the peer\n')
  await $.tool.call({ tool: 'Bash', command: 'python3 /tmp/x/check.py notes/plan.md' } as any)
  const at = w.clock.now()
  w.touch(`${FLEET}/events/${hourFolder(at)}/${at}-bbbbbbbb-99.json`, JSON.stringify({ format: 1, at, path: 'notes/plan.md', from: hashText('plan v1\n'), to: hashText('plan by the peer\n'), via: 'tool', tool: 'Write', blind: false, by: RB }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: `${at}-bbbbbbbb-99.json` }))
  peerMark(true)
  for (let i = 0; i < 2; i++) await tick(w, 10000)
  expect(eventsOf(w, 'notes/plan.md').map(said)).toEqual(['tool TEST R'])
})

test("a mark with no text to compare (a write fleet can't foresee) counts for 30 s from its first writing, however often it's rewritten", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  const since = w.clock.now()
  const peerMark = () => w.touch(markOf('notes/plan.md', 'bbbbbbbb'), JSON.stringify({ format: 1, path: 'notes/plan.md', sessionId: R_SID, agentId: null, at: w.clock.now(), since }))
  peerMark()
  for (let t = 0; t < 60000; t += 10000) {
    await tick(w, 10000)
    peerMark()
  }
  w.bash.value = () => w.touch(PLAN, 'plan by the script\n')
  await $.tool.call({ tool: 'Bash', command: 'python3 /tmp/x/fix.py notes/plan.md' } as any)
  expect(eventsOf(w, 'notes/plan.md').map(said)).toEqual(['bash blind TEST W'])
})

test("this session's mark carries the text its write will leave, and when it was first written", WITH_SESSIONS, async ($, on) => {
  let seen: any = null
  on('tool.call', { tool: 'Write' } as any, async (_$: any, e: any, next: any) => {
    seen = JSON.parse(w.files.get(markOf('notes/plan.md', 'aaaaaaaa')) ?? 'null')
    return next(e)
  })
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  expect((await $.tool.call({ tool: 'Write', file_path: PLAN, content: 'plan v2\n' } as any)).deny).toBe(undefined)
  expect(seen).toMatchObject({ path: 'notes/plan.md', to: hashText('plan v2\n') })
  expect(typeof seen.since).toBe('number')
})

// ---- 2 and 4. Copies: decided pin by pin, each named file read once ----

const CHECKED = `${ROOT}/notes/checked.md`
const OTHER = `${ROOT}/notes/other.md`
const SEND = `${ROOT}/notes/send.md`
const LOG = `${ROOT}/notes/log.md`

async function copies($: any, on: any) {
  const w = world(on, {
    worldPaths: ['req/**', 'notes/**'],
    files: { [R1]: 'R-1 v1\n', [R2]: 'R-2 v1\n', [`${ROOT}/req/R-3.md`]: 'R-3 v1\n', [CHECKED]: '---\nfront: x\n---\nThe plan rests on R-1@1.\n', [OTHER]: 'The other part rests on R-2@1.\n', [LOG]: 'Log\n' },
  })
  await begin($, w)
  return w
}
const flagged = (r: any) => {
  const t = (r.context ?? []).join('\n')
  return ['R-1@1', 'R-2@1', 'R-3@1'].filter(p => t.includes(p))
}

for (const [label, command, path, text, expected] of [
  ['a pure span', 'tail -n +4 notes/checked.md > notes/send.md', SEND, 'The plan rests on R-1@1.\n', []],
  ['a span with a pin of its own added: only that one', '{ tail -n +4 notes/checked.md; echo and R-3@1; } > notes/send.md', SEND, 'The plan rests on R-1@1.\nand R-3@1\n', ['R-3@1']],
  ['a copy with a header line added', '{ echo "# Sent"; tail -n +4 notes/checked.md; } > notes/send.md', SEND, '# Sent\nThe plan rests on R-1@1.\n', []],
  ['two named files put together', 'tail -n +4 notes/checked.md | cat - notes/other.md > notes/send.md', SEND, 'The plan rests on R-1@1.\nThe other part rests on R-2@1.\n', []],
  ['a span appended to another file', 'tail -n 1 notes/checked.md >> notes/log.md', LOG, 'Log\nThe plan rests on R-1@1.\n', []],
  ['a line that cites a carried pin but was rewritten', "sed 's/plan/whole plan/' notes/checked.md > notes/send.md", SEND, '---\nfront: x\n---\nThe whole plan rests on R-1@1.\n', ['R-1@1']],
] as [string, string, string, string, string[]][]) {
  test(`a copy carries a pin only when every line citing it is a named file's line citing it: ${label}`, WITH_SESSIONS, async ($, on) => {
    const w = await copies($, on)
    w.bash.value = () => w.touch(path, text)
    expect(flagged(await $.tool.call({ tool: 'Bash', command } as any))).toEqual(expected)
  })
}

test('a bulk copy reads each file it copies from once, whatever it wrote', { ...WITH_SESSIONS, timeoutMs: 120000 }, async ($, on) => {
  const N = 120
  const files: Record<string, string> = { [R1]: 'R-1 v1\n' }
  for (let i = 1; i <= N; i++) files[`${ROOT}/board/B-${i}.md`] = `---\nrelies_on: [R-1@1]\n---\nB-${i}: item ${i}, built on R-1@1\n`
  const w = world(on, { worldPaths: ['req/**', 'board/**', 'archive/**'], files })
  await begin($, w)
  for (let i = 0; i < 3; i++) await tick(w, 10000)
  const boardReads = () => [...w.readCount].filter(([p]) => p.startsWith(`${ROOT}/board/`)).reduce((a, [, c]) => a + c, 0)
  const from = boardReads()
  w.bash.value = () => {
    for (let i = 1; i <= N; i++) w.touch(`${ROOT}/archive/B-${i}.md`, files[`${ROOT}/board/B-${i}.md`] as string)
  }
  const r: any = await $.tool.call({ tool: 'Bash', command: 'for f in board/*.md; do cp "$f" "archive/${f#board/}"; done' } as any)
  expect(boardReads() - from).toBeLessThanOrEqual(2 * N)
  expect((r.context ?? []).join('\n')).not.toContain("haven't read R-1")
  expect(eventsOf(w, 'archive/B-7.md').at(-1)).toMatchObject({ via: 'bash', blind: true })
})

// ---- 3. The quiet cap from a burst's first move; a reason told once ----

const WORK = '---\nrelies_on: [R-1@1]\n---\nB-1: the work, built on R-1@1\n'

for (const staleFirst of [false, true]) {
  test(`a burst of revisions is told once${staleFirst ? ', on a pin left stale for 15 minutes too' : ''}`, WITH_SESSIONS, async ($, on) => {
    const NOTE = `${ROOT}/notes/n.md`
    const w = world(on, { worldPaths: ['req/**', 'board/**', 'notes/**'], files: { [R1]: 'R-1 v1\n', [B1]: WORK, [NOTE]: 'note\n' } })
    await begin($, w)
    await $.tool.call({ tool: 'Read', file_path: R1 } as any)
    await $.tool.call({ tool: 'Read', file_path: B1 } as any)
    expect((await $.tool.call({ tool: 'Edit', file_path: B1, old_string: 'the work', new_string: 'the work, mine' } as any)).deny).toBe(undefined)
    const told: string[] = []
    const look = async () => told.push(((await $.tool.call({ tool: 'Read', file_path: NOTE } as any)).context ?? []).join('\n'))
    let v = 1
    if (staleFirst) {
      landByR(w, R1, `R-1 v${++v}\n`, v)
      for (let i = 0; i < 15; i++) await tick(w, 10000)
      await look()
      for (let i = 0; i < 90; i++) await tick(w, 10000)
      await look()
    }
    const count = () => told.join('\n').split('board/B-1.md (B-1) cites R-1@1').length - 1
    const before = count()
    for (let k = 0; k < 3; k++) {
      landByR(w, R1, `R-1 v${++v}\n`, v)
      for (let i = 0; i < 3; i++) await tick(w, 10000)
      await look()
    }
    for (let i = 0; i < 13; i++) await tick(w, 10000)
    await look()
    expect(before).toBe(staleFirst ? 1 : 0)
    expect(count() - before).toBe(1)
  })
}

test("a file's quiet reason is told once, not again when its busy one settles", WITH_SESSIONS, async ($, on) => {
  const WORK2 = '---\nrelies_on: [R-1@1, R-2@1]\n---\nB-1: the work, built on R-1@1 and R-2@1\n'
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
  const out: string[] = []
  for (let k = 2; k <= 4; k++) {
    await tick(w, 88000)
    landByR(w, R2, `R-2 v${k}\n`, k)
    await tick(w)
    out.push(((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)) as any).context?.join('\n') ?? '')
  }
  for (let i = 0; i < 4; i++) {
    await tick(w, 60000)
    out.push(((await $.tool.call({ tool: 'Bash', command: 'ls' } as any)) as any).context?.join('\n') ?? '')
  }
  const lines = out.flatMap(s => s.split('\n')).filter(l => l.includes('board/B-1.md'))
  expect(lines.filter(l => l.includes('R-1@1')).length).toBe(1)
  expect(lines.filter(l => l.includes('R-2@1')).length).toBe(1)
})

// ---- 5. Marks read only for the files changed ----

test("a command that changes one named file reads only that file's marks", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan v1\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: PLAN } as any)
  for (let i = 0; i < 300; i++) {
    const rel = `notes/other-${i}.md`
    w.touch(`${FLEET}/state/writing/${hashText(rel).slice(1, 17)}-cccccccc-agent${i}.json`, JSON.stringify({ format: 1, path: rel, sessionId: 'cccccccc-0000-0000-0000-000000000000', agentId: `agent${i}`, at: w.clock.now(), done: true }))
  }
  const markReads = () => [...w.readCount].filter(([p]) => p.startsWith(`${FLEET}/state/writing/`)).reduce((a, [, c]) => a + c, 0)
  const from = markReads()
  w.bash.value = () => w.touch(PLAN, 'plan v2\n')
  await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/v1/v2/' notes/plan.md" } as any)
  expect(markReads() - from).toBeLessThanOrEqual(1)
})

// ---- 6. BSD's -l inside a cluster ----

test("sed: after -l in a cluster, the letters that follow are flags unless they're a number", () => {
  const inWorld = (t: string) => !t.startsWith('/tmp/')
  for (const c of ["sed -le 'w board/out.md' -e p board/in.md", "sed -nle 'w board/out.md' -e p board/in.md", "sed -lf /tmp/x.sed board/in.md", "sed -lI '' 's/x/y/' board/in.md"]) {
    expect([c, bashWritesNothing(c, inWorld)]).toEqual([c, false])
  }
  for (const c of ["sed -l80 -n '1,5p' board/in.md", "sed -nl80 '1p' board/in.md", "sed -ln '1p' board/in.md"]) {
    expect([c, bashWritesNothing(c, inWorld)]).toEqual([c, true])
  }
})

// ---- 7. A copy into a folder of the world ----

test('cp -r into a folder whose files are shared writes them: its copies land as its own', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'board/**', 'archive/**'], files: { [R1]: 'R-1 v1\n', [B1]: 'B-1, on R-1@1\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: R1 } as any)
  await $.tool.call({ tool: 'Read', file_path: B1 } as any)
  w.bash.value = () => w.touch(`${ROOT}/archive/B-1.md`, 'B-1, on R-1@1\n')
  await $.tool.call({ tool: 'Bash', command: 'cp -r board archive' } as any)
  expect(eventsOf(w, 'archive/B-1.md').map(said)).toEqual(['bash blind TEST W'])
})
