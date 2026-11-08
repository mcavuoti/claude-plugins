import { expect, test } from 'claude-code/testing'

import { parseCommand } from '../hooks/decisions'
import { FAKE_LOG, FLEET, ROOT, fleet, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'
import { OWNER } from './up.test'

// /fleet up --force: the instances the person stopped (another session stopped them all for an update, say) come back
// through sessions' wake with force, paced, and only on his own command

function roster(): string {
  return JSON.stringify({
    rosterFormat: 1,
    sections: [{ id: 'owners', title: 'Owners' }],
    roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 } } },
    instances: [
      { name: 'Owner A', role: 'owner', section: 'owners' },
      { name: 'Owner B', role: 'owner', section: 'owners' },
      { name: 'Owner C', role: 'owner', section: 'owners' },
    ],
    budget: { usdDay: 5 },
  })
}

function wakes(w: World): any[] {
  return (w.files.get(FAKE_LOG) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(c => c.wake)
    .map(c => c.wake)
}

// Every instance stopped, by the person unless said otherwise; version: what the stand-in sessions says it is
function setup(on: any, stopped: Record<string, string | undefined> = {}, version = '0.18.0'): World {
  const w = world(on, { background: false, files: { [`${FLEET}/roster.json`]: roster(), [`${ROOT}/.claude/agents/owner.md`]: OWNER } })
  const stop = (ref: string, name: string, why: string | undefined) => ({ ...row(ref, name, 'stopped'), ...(why ? { stopped: why } : {}) })
  const rows = {
    aaaaaaa1: stop('aaaaaaa1', 'Owner A', 'a' in stopped ? stopped.a : 'person'),
    bbbbbbb1: stop('bbbbbbb1', 'Owner B', 'b' in stopped ? stopped.b : 'person'),
    ccccccc1: stop('ccccccc1', 'Owner C', 'c' in stopped ? stopped.c : 'person'),
  }
  sessionsSay(w, { rows, version } as any)
  return w
}

test('/fleet up leaves the instances the person stopped alone and says --force wakes them', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  const up = await fleet($, 'up')
  expect(up).toContain('Owner A: stopped by you, left alone (Enter or u in the panel restarts it, or /fleet up --force wakes it)')
  expect(up).toContain('stopped by you: not woken (Enter or u in the panel restarts it, or /fleet up --force)')
  await w.clock.advance(10000)
  expect(wakes(w)).toEqual([])
})

test('/fleet up --force --dry-run shows what it would wake and wakes nothing', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  const plan = await fleet($, 'up --force --dry-run')
  expect(plan).toContain('(--force: wakes the ones you stopped too):')
  expect(plan).toContain('stopped by you: to wake (--force)')
  expect(plan).toContain('force: wakes 3 you stopped: Owner A, Owner B, Owner C.')
  expect(plan).toContain('Nothing was started (--dry-run).')
  await w.clock.advance(10000)
  expect(wakes(w)).toEqual([])
})

test('/fleet up --force wakes every one the person stopped, with force, one every 3 s (the first at once)', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  const up = await fleet($, 'up --force')
  expect(up).toContain('  force: wakes 3 you stopped: Owner A, Owner B, Owner C; one every 3 s')
  expect(up).toContain('  Owner A: waking (--force)')
  expect(up).toContain('  Owner B: waking (--force) in 3 s')
  expect(up).toContain('  Owner C: waking (--force) in 6 s')
  // The first at once (its answer is in the reply), the others paced
  expect(wakes(w).map(x => x.ref)).toEqual(['aaaaaaa1'])
  await w.clock.advance(3000)
  await w.clock.settle()
  expect(wakes(w).map(x => x.ref)).toEqual(['aaaaaaa1', 'bbbbbbb1'])
  await w.clock.advance(3000)
  await w.clock.settle()
  expect(wakes(w)).toEqual([
    { ref: 'aaaaaaa1', reason: 'fleet up --force (the person typed it)', force: true },
    { ref: 'bbbbbbb1', reason: 'fleet up --force (the person typed it)', force: true },
    { ref: 'ccccccc1', reason: 'fleet up --force (the person typed it)', force: true },
  ])
})

test('--force: a restart stopped one is woken as always (no force); the person\'s and an unexplained stop get force', WITH_SESSIONS, async ($, on) => {
  const w = setup(on, { a: 'ended', c: undefined })
  await startSession($, w)
  const up = await fleet($, 'up --force')
  expect(up).toContain('  force: wakes 1 you stopped: Owner B; and 1 nothing says why stopped: Owner C; one every 3 s')
  await w.clock.advance(7000)
  await w.clock.settle()
  expect(wakes(w)).toEqual([
    { ref: 'aaaaaaa1', reason: 'fleet up' },
    { ref: 'bbbbbbb1', reason: 'fleet up --force (the person typed it)', force: true },
    { ref: 'ccccccc1', reason: 'fleet up --force (the person typed it)', force: true },
  ])
})

test('a sessions older than the one fleet needs: /fleet up starts and wakes nothing, and says to update it', WITH_SESSIONS, async ($, on) => {
  const w = setup(on, {}, '0.16.3')
  await startSession($, w)
  const plan = await fleet($, 'up --force --dry-run')
  expect(plan).toContain('✗ fleet needs sessions 0.18.0 or later (0.16.3 here): update it (claude plugin update sessions@mcavuoti) and restart (u)')
  const up = await fleet($, 'up --force')
  expect(up).toContain('Nothing was started or woken: update sessions, restart this session (u), then /fleet up again.')
  await w.clock.advance(10000)
  expect(wakes(w)).toEqual([])
})

test('--force leaves an instance the person put down alone, unless he names it', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  await fleet($, 'down "Owner A"')
  const up = await fleet($, 'up --force')
  expect(up).toContain('Owner A · owner')
  expect(up).toContain('down: skipped (/fleet up <name> brings it back)')
  expect(up).toContain('  force: wakes 2 you stopped: Owner B, Owner C; one every 3 s')
  await w.clock.advance(4000)
  await w.clock.settle()
  expect(wakes(w).map(x => x.ref)).toEqual(['bbbbbbb1', 'ccccccc1'])
  // Named, it's no longer down, and it's woken
  const named = await fleet($, 'up --force "Owner A"')
  expect(named).toContain('  Owner A: waking (--force)')
  expect(wakes(w).map(x => x.ref)).toEqual(['bbbbbbb1', 'ccccccc1', 'aaaaaaa1'])
})

test('--force is the person\'s: from another origin it starts nothing; with --restart-when-idle it is refused', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  expect(await fleet($, 'up --force', { kind: 'plugin', plugin: 'x' })).toContain('/fleet up --dry-run shows the plan')
  await w.clock.advance(10000)
  expect(wakes(w)).toEqual([])
  expect(parseCommand('up --force --restart-when-idle')).toEqual({ kind: 'bad', reason: '--force wakes stopped instances and --restart-when-idle restarts running ones: one at a time' })
  expect(parseCommand('up --force')).toMatchObject({ kind: 'up', force: true, stopped: false })
})
