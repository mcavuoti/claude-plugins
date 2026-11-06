import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { FLEET, REF, ROOT, SID, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// The gate's "once" is spent only from a later model step: the calls of one batch (sent before the model saw the first
// refusal) all get the same verdict, so a second Edit in the same batch citing the same unread pin is refused too. And
// a SendMessage of the step whose write was refused is held once: it may announce a write that didn't land (G33)

const STATE = `${FLEET}/state`
const R1 = `${ROOT}/req/R-1.md`
const R2 = `${ROOT}/req/R-2.md`
const B1 = `${ROOT}/board/B-1.md`
const R_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const RB = { sessionId: R_SID, agentId: null, ref: 'bbbbbbbb', name: 'TEST R' }
const CURRENT = { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST W', root: ROOT, background: true, agent: null } }
const WORK = '---\nrelies_on: [R-1@1]\n---\nB-1: the work, built on R-1@1\n\n| row | value |\n| --- | --- |\n| a | 1 |\n'

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

// A model step of the main loop (the engine's request, answered beneath fleet by the test)
async function step($: any, on: any, turnId: string, index: number) {
  const s = $.turn.step({ turnId, index, model: 'claude-haiku-5-5', messageCount: 1 + index })
  for await (const _ of s) {
  }
  await s.result
}

function stepsAnswered(on: any) {
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
  })
}

test("the gate's once is spent from a later step: two Edits of one batch citing an unread pin are both refused, and pass when sent again", WITH_SESSIONS, async ($, on) => {
  stepsAnswered(on)
  const w = world(on, { worldPaths: ['req/**', 'board/**'], files: { [R1]: 'R-1 v1\n', [R2]: 'R-2 v1\n', [B1]: WORK } })
  await begin($, w)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await step($, on, 't-1', 0)
  await $.tool.call({ tool: 'Read', file_path: B1 } as any)
  await step($, on, 't-1', 1)
  // One batch: two Edits that newly cite R-2@1, never read in this conversation (the second in a table row)
  const first = { tool: 'Edit', file_path: B1, old_string: 'built on R-1@1', new_string: 'built on R-1@1 and R-2@1' }
  const second = { tool: 'Edit', file_path: B1, old_string: '| a | 1 |', new_string: '| a | 1 (R-2@1) |' }
  const refused = String((await $.tool.call(first as any)).deny ?? '')
  expect(refused).toMatch(/R-2@1: you haven't read R-2/)
  // What counts as a read, said where it's asked for
  expect(refused).toContain("A read is the Read tool, or one file shown by cat, head, tail, nl or sed -n N,Mp alone (a grep or a pipe doesn't count).")
  expect((await $.tool.call(second as any)).deny).toMatch(/R-2@1: you haven't read R-2/)
  expect(w.files.get(B1)).toBe(WORK)
  // The next step, having seen the refusals: sent again as they are, they pass (the gate tells once)
  await step($, on, 't-1', 2)
  expect((await $.tool.call(first as any)).deny).toBe(undefined)
  expect((await $.tool.call(second as any)).deny).toBe(undefined)
  expect(w.files.get(B1)).toContain('| a | 1 (R-2@1) |')
})

test("the gate's once on a stale file, too: a second Write of the same batch is refused; the next step's passes", WITH_SESSIONS, async ($, on) => {
  stepsAnswered(on)
  const w = world(on, { worldPaths: ['req/**', 'board/**'], files: { [R1]: 'R-1 v1\n', [B1]: WORK } })
  await begin($, w)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await step($, on, 't-1', 0)
  await $.tool.call({ tool: 'Read', file_path: B1 } as any)
  landByR(w, B1, `${WORK}\npeer's line\n`, 2, 'editorial')
  await tick(w)
  await step($, on, 't-1', 1)
  const write = { tool: 'Edit', file_path: B1, old_string: 'the work', new_string: 'the work, part one' }
  expect((await $.tool.call(write as any)).deny).toBeTruthy()
  expect((await $.tool.call({ ...write, new_string: 'the work, part two' } as any)).deny).toBeTruthy()
  await step($, on, 't-1', 2)
  expect((await $.tool.call(write as any)).deny).toBe(undefined)
})

test('a session with no steps seen (a hook reloaded mid-turn) keeps the once as before: the second try passes', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'board/**'], files: { [R1]: 'R-1 v1\n', [R2]: 'R-2 v1\n', [B1]: WORK } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: B1 } as any)
  const add = { tool: 'Edit', file_path: B1, old_string: 'built on R-1@1', new_string: 'built on R-1@1 and R-2@1' }
  expect((await $.tool.call(add as any)).deny).toMatch(/R-2@1/)
  expect((await $.tool.call(add as any)).deny).toBe(undefined)
})

test('G33: a SendMessage of the same step as a refused write is held once, saying the write did not land; the next step sends', WITH_SESSIONS, async ($, on) => {
  stepsAnswered(on)
  on('tool.call', { tool: 'SendMessage' } as any, () => ({ result: { success: true }, text: 'sent' }) as any)
  const w = world(on, { worldPaths: ['req/**', 'board/**'], files: { [R1]: 'R-1 v1\n', [R2]: 'R-2 v1\n', [B1]: WORK } })
  await begin($, w)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await step($, on, 't-1', 0)
  await $.tool.call({ tool: 'Read', file_path: B1 } as any)
  await step($, on, 't-1', 1)
  const edit = { tool: 'Edit', file_path: B1, old_string: 'built on R-1@1', new_string: 'built on R-1@1 and R-2@1' }
  expect((await $.tool.call(edit as any)).deny).toMatch(/R-2@1/)
  const msg = { tool: 'SendMessage', to: 'TEST R', message: 'B-1 now cites R-2@1' }
  const held: any = await $.tool.call(msg as any)
  expect(String(held.deny ?? '')).toContain("your Edit of board/B-1.md in this same batch was refused, so it didn't land")
  // Sent again in the same step (the model insists): it goes
  expect((await $.tool.call(msg as any)).deny).toBe(undefined)
  // A later step: no hold at all
  await step($, on, 't-1', 2)
  expect((await $.tool.call({ ...msg, message: 'another' } as any)).deny).toBe(undefined)
})

test('G33: a record revised in a burst tells the owners of what cites it once, when it has been quiet 2 minutes', WITH_SESSIONS, async ($, on) => {
  const NOTE = `${ROOT}/notes/n.md`
  const w = world(on, { worldPaths: ['req/**', 'board/**', 'notes/**'], files: { [R1]: 'R-1 v1\n', [B1]: WORK, [NOTE]: 'note\n' } })
  await begin($, w)
  await $.tool.call({ tool: 'Read', file_path: R1 } as any)
  await $.tool.call({ tool: 'Read', file_path: B1 } as any)
  expect((await $.tool.call({ tool: 'Edit', file_path: B1, old_string: 'the work', new_string: 'the work, mine' } as any)).deny).toBe(undefined)
  const told: string[] = []
  const look = async () => told.push(((await $.tool.call({ tool: 'Read', file_path: NOTE } as any)).context ?? []).join('\n'))
  // Three revisions half a minute apart
  for (const v of [2, 3, 4]) {
    landByR(w, R1, `R-1 v${v}\n`, v)
    for (let i = 0; i < 3; i++) await tick(w, 10000)
    await look()
  }
  expect(told.join('\n')).not.toContain('board/B-1.md (B-1) cites R-1@1')
  // Quiet 2 minutes: told once, at the version it came to
  for (let i = 0; i < 13; i++) await tick(w, 10000)
  await look()
  await tick(w, 10000)
  await look()
  const all = told.join('\n')
  expect(all).toContain('board/B-1.md (B-1) cites R-1@1, and R-1 is at v4')
  expect(all.split('board/B-1.md (B-1) cites R-1@1').length - 1).toBe(1)
})
