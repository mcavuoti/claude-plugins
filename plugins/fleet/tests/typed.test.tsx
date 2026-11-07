import { expect, test } from 'claude-code/testing'

import { FAKE_LOG, FLEET, JOB, ROOT, SID, fleet, fleetUntyped, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'
import { OWNER } from './up.test'

// A /fleet command of the person's counts as typed only when a submit from this session's prompt box came before it
// (prompt.change, clear) and no command took it yet: a launch prompt, a resumed job's new prompt, an agent's
// initialPrompt and the interactive positional prompt read as composer and come with none

const ROSTER = JSON.stringify({
  rosterFormat: 1,
  sections: [{ id: 'owners', title: 'Owners' }],
  roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 } } },
  instances: [{ name: 'Owner A', role: 'owner', section: 'owners' }],
  budget: { usdDay: 5 },
})

function setup(on: any, background = false): World {
  const w = world(on, { background, files: { [`${FLEET}/roster.json`]: ROSTER, [`${ROOT}/.claude/agents/owner.md`]: OWNER } })
  sessionsSay(w, { rows: { aaaaaaa1: { ...row('aaaaaaa1', 'Owner A', 'stopped'), stopped: 'person' } }, version: '0.15.1' } as any)
  return w
}

function wakes(w: World): any[] {
  return (w.files.get(FAKE_LOG) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(c => c.wake)
    .map(c => c.wake)
}

const submit = ($: any) => $.prompt.change({ text: '', cursor: 0, origin: { kind: 'clear' } })

test('a person-only command with no submit from the prompt box before it is refused: type it here', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  const r = await fleetUntyped($, 'down')
  expect(r).toContain("not typed in this session's prompt box: type it here")
  expect(w.files.has(`${FLEET}/state/down.json`)).toBe(false)
  // Reading commands still answer
  expect(await fleetUntyped($, 'up --dry-run')).toContain('Nothing was started (--dry-run).')
})

test('typed in the prompt box (its submit came first), the same command runs', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  expect(await fleet($, 'down')).toContain('Down: Owner A')
  expect(w.files.has(`${FLEET}/state/down.json`)).toBe(true)
})

test('one submit carries one command: a second one with no submit of its own is refused; two submits carry two (queued)', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  await submit($)
  expect(await fleetUntyped($, 'down')).toContain('Down: Owner A')
  expect(await fleetUntyped($, 'up --force')).toContain("not typed in this session's prompt box")
  expect(wakes(w)).toEqual([])
  // Two typed while the session was busy, run after
  await submit($)
  await submit($)
  expect(await fleetUntyped($, 'up --force "Owner A"')).toContain('Owner A: waking (--force)')
  expect(await fleetUntyped($, 'down')).toContain('Down: Owner A')
})

test('a submit long gone (minutes before) carries nothing', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  await submit($)
  await w.clock.advance(3 * 60000)
  expect(await fleetUntyped($, 'down')).toContain("not typed in this session's prompt box")
})

test('a resumed background job with a new prompt (its intent is still the old one) runs none of the person\'s commands', WITH_SESSIONS, async ($, on) => {
  const w = setup(on, true)
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, intent: 'Reply only: ok', firstTerminalAt: null }))
  await startSession($, w)
  const r = await fleetUntyped($, 'up --force')
  expect(r).toContain("not typed in this session's prompt box")
  expect(wakes(w)).toEqual([])
})

test("an agent's initialPrompt, or the positional prompt (no submit), runs none of the person's commands", WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  expect(await fleetUntyped($, 'budget "Owner A" +5')).toContain("not typed in this session's prompt box")
})

for (const intent of ['/fleet\tup --force', '/fleet\nup  --force', '/fleet up --force', '  /fleet up --force ']) {
  test(`a launch prompt is refused however the engine spaced it (${JSON.stringify(intent)}), even with a submit`, WITH_SESSIONS, async ($, on) => {
    const w = setup(on, true)
    w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, intent, firstTerminalAt: null }))
    await startSession($, w)
    expect(await fleet($, 'up --force')).toContain("this session's launch prompt")
    expect(wakes(w)).toEqual([])
  })
}

test("a background session whose job state can't be read counts as launched: its first /fleet of the person's is refused", WITH_SESSIONS, async ($, on) => {
  const w = setup(on, true)
  w.files.set(`${JOB}/state.json`, '{not json')
  await startSession($, w)
  expect(await fleet($, 'down')).toContain("this session's launch prompt")
  expect(w.files.has(`${FLEET}/state/down.json`)).toBe(false)
})

test('over Remote Control (the phone) an answer needs no prompt-box submit', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  // Nothing to answer: it gets past the origin check to say so
  expect(await fleet($, '1a', { kind: 'bridge' })).not.toContain("not typed in this session's prompt box")
})
