import { expect, test } from 'claude-code/testing'

import { FAKE_LOG, FLEET, JOB, REF, ROOT, SID, decide, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'
import { OWNER } from './up.test'

// Derived documents from the mod's side: a business plan citing two requirements turns stale when one is revised;
// its owner hears it once the inputs are quiet (debounced), once, or is woken for it when retired; and a change whose
// only authority is the plan it rests on is flagged and never applied as filed

const PLANNER = OWNER.replace('name: owner', 'name: planner')
const WORLD = { worldFormat: 1, paths: ['req/**', 'plan/**', 'journals/**'], command: ['req/**'], derived: { businessplan: { paths: ['plan/business-plan.md'], owner: 'planner', debounceMin: 5 } } }
const ROSTER = {
  rosterFormat: 1,
  roles: { planner: { agent: 'planner', model: 'haiku' }, owner: { agent: 'owner', model: 'haiku' } },
  instances: [
    { name: 'Business Plan', role: 'planner' },
    { name: 'Requirements', role: 'owner' },
  ],
  wakes: { everyMin: 1, perDay: 8 },
}
const PLAN = '# Business plan\n\n| assumption | rests on |\n|---|---|\n| the target is met | R-1@1 |\n| the cost | R-2@1 |\n'
const FILES = {
  [`${FLEET}/world.json`]: JSON.stringify(WORLD),
  [`${FLEET}/roster.json`]: JSON.stringify(ROSTER),
  [`${ROOT}/.claude/agents/planner.md`]: PLANNER,
  [`${ROOT}/.claude/agents/owner.md`]: OWNER,
  [`${FLEET}/seeds/planner.md`]: 'Plan.',
  [`${FLEET}/seeds/owner.md`]: 'Own.',
  [`${ROOT}/req/R-1.md`]: '# R-1\n\nThe target is 5.\n',
  [`${ROOT}/req/R-2.md`]: '# R-2\n\nThe cost is 3.\n',
  [`${ROOT}/plan/business-plan.md`]: PLAN,
}

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

async function planner($: any, on: any) {
  const w = world(on, { env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Business Plan', FLEET_ROLE: 'planner' }, files: { ...FILES, [`${FLEET}/instances/business-plan.json`]: '{}\n' } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.01 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Business Plan', root: ROOT, background: true, agent: 'planner' }, rows: { [REF]: row(REF, 'Business Plan', 'idle') } })
  await startSession($, w)
  return w
}

test('a derived document goes stale when a cited record is revised; its owner hears it once the inputs are quiet, once', WITH_SESSIONS, async ($, on) => {
  const w = await planner($, on)
  const ctx: any = await $.classic.SessionStart({ source: 'startup', agent_type: 'planner' } as any)
  expect(ctx.additionalContext.join('\n')).toContain('You own derived documents: `plan/business-plan.md` (businessplan).')
  for (let i = 0; i < 10; i++) await tick(w)
  expect(w.submits.length).toBe(1)
  // Requirements revises R-1 (here, an edit outside fleet with its change line)
  w.touch(`${ROOT}/req/R-1.md`, '---\nchange: "revision: the target is 8"\n---\n# R-1\n\nThe target is 8.\n')
  for (let i = 0; i < 12; i++) await tick(w)
  expect(json(w, `${FLEET}/state/suspects.json`).derived).toMatchObject([{ path: 'plan/business-plan.md', kind: 'businessplan', owner: 'planner', pins: [{ pin: 'R-1@1', now: 2 }] }])
  expect(await fleet($, 'status')).toContain('  stale: plan/business-plan.md (businessplan): R-1@1 → v2; its owner (planner) is told once its inputs are quiet 5 min')
  // Not before the inputs have been quiet 5 minutes
  expect(w.submits.length).toBe(1)
  for (let i = 0; i < 150; i++) await tick(w)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toContain('fleet: documents you own are derived from records that moved since they cited them (nothing is held; refresh them when you can):\n- plan/business-plan.md (businessplan): R-1@1 → v2; the last moved at ')
  expect(w.submits[1]).toContain('"inputs unchanged since" its last version is a valid landing')
  // Once: no second nudge for the same state
  for (let i = 0; i < 100; i++) await tick(w)
  expect(w.submits.length).toBe(2)
  const brief = await fleet($, 'brief')
  expect(brief).toContain('   - stale: plan/business-plan.md (businessplan, owned by planner): R-1@1 (now v2) moved since it cited them')
  expect(brief).not.toContain('   - suspect: plan/business-plan.md')
  // It refreshes it, citing R-1 as it is now: no longer stale
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/req/R-1.md` } as any)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/plan/business-plan.md` } as any)
  const r: any = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/plan/business-plan.md`, content: PLAN.replace('R-1@1', 'R-1@2') } as any)
  expect(r.deny).toBe(undefined)
  for (let i = 0; i < 5; i++) await tick(w)
  expect(json(w, `${FLEET}/state/suspects.json`).derived).toBe(undefined)
})

test('the owner who read a revised input hears it with the derived line, once the inputs are quiet, not at its next step', WITH_SESSIONS, async ($, on) => {
  const w = await planner($, on)
  for (let i = 0; i < 10; i++) await tick(w)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/req/R-1.md` } as any)
  w.touch(`${ROOT}/req/R-1.md`, '---\nchange: "revision: the target is 8"\n---\n# R-1\n\nThe target is 8.\n')
  for (let i = 0; i < 12; i++) await tick(w)
  // Its next step doesn't carry "changed since you read it" for R-1: that waits for the debounce
  const step: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect((step.context ?? []).join('\n')).not.toContain('req/R-1.md')
  expect(w.submits.length).toBe(1)
  for (let i = 0; i < 150; i++) await tick(w)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toContain('- req/R-1.md: changed at ')
  expect(w.submits[1]).toContain('- plan/business-plan.md (businessplan): R-1@1 → v2; the last moved at ')
})

test('inputs that keep moving: the owner is told anyway 8 × debounceMin after the first move, that they are still moving', WITH_SESSIONS, async ($, on) => {
  const w = await planner($, on)
  for (let i = 0; i < 10; i++) await tick(w)
  // R-1 revised every 4 minutes (the debounce is 5): never quiet
  const first = w.clock.now()
  for (let n = 2; w.clock.now() - first < 45 * 60000 && w.submits.length < 2; n++) {
    w.touch(`${ROOT}/req/R-1.md`, `---\nchange: "revision: the target is ${n}"\n---\n# R-1\n\nThe target is ${n}.\n`)
    for (let i = 0; i < 24 && w.submits.length < 2; i++) await tick(w, 10000)
  }
  expect(w.submits.length).toBe(2)
  expect(w.clock.now() - first).toBeGreaterThan(40 * 60000)
  expect(w.clock.now() - first).toBeLessThan(43 * 60000)
  expect(w.submits[1]).toMatch(/- plan\/business-plan\.md \(businessplan\): R-1@1 → v\d+; the last moved at \d\d:\d\d: its inputs are still moving, so refresh what has settled/)
})

test('no circular authority: a change to a requirement resting only on the plan that cites it is flagged, never applied as filed', WITH_SESSIONS, async ($, on) => {
  const w = await planner($, on)
  // The person is attached and types this turn: a change filed in it would be applied as filed, but for the circle
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, intent: '', firstTerminalAt: '2026-11-02T11:00:00Z' }))
  for (let i = 0; i < 10; i++) await tick(w)
  await $.prompt.submit({ text: 'Lower R-1 so the plan works', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ text: 'Lower R-1 so the plan works', turnId: 't-1' })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/req/R-1.md` } as any)
  const r = await decide($, { kind: 'change', path: 'req/R-1.md', summary: 'R-1 becomes 3, as plan/business-plan.md needs', edits: [{ old_string: 'is 5', new_string: 'is 3' }] })
  expect(r.result).toContain('Queued as D-1 for the person: a change to req/R-1.md')
  expect(r.result).toContain('fleet flagged it for the person: its only cited authority is a derived document (plan/business-plan.md) that rests on this very record')
  expect(json(w, `${FLEET}/decisions/queue/D-1.json`).change.circular).toEqual(['plan/business-plan.md'])
  expect(w.files.get(`${ROOT}/req/R-1.md`)).toBe('# R-1\n\nThe target is 5.\n')
  expect(await fleet($, '')).toContain("   ⚠ its only cited authority is a derived document (plan/business-plan.md) that rests on this very record: a derived document can't be the sole authority for changing its own inputs. Check that the change stands on its own.")
  // One that stands on something else is no circle
  const ok = await decide($, { kind: 'change', path: 'req/R-2.md', summary: 'R-2 becomes 4', edits: [{ old_string: 'is 3', new_string: 'is 4' }] })
  expect(ok.result).not.toContain('flagged')
})

test('a retired owner is woken for its stale derived document, once its inputs are quiet, once', WITH_SESSIONS, async ($, on) => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  const w = world(on, {
    background: false,
    files: {
      ...FILES,
      [`${FLEET}/instances/business-plan/state.json`]: JSON.stringify({ format: 1, instance: 'Business Plan', slug: 'business-plan', ref: 'bbbbbbb1', sessionId: 'bbbbbbb1-sid', at: now - 3 * 3600000, cwd: ROOT, bound: true, startedAt: now - 4 * 3600000 }),
    },
  })
  sessionsSay(w, { rows: { bbbbbbb1: row('bbbbbbb1', 'Business Plan', 'stopped') } })
  await startSession($, w)
  for (let i = 0; i < 10; i++) await tick(w)
  w.touch(`${ROOT}/req/R-2.md`, '---\nchange: "revision: the cost is 4"\n---\n# R-2\n\nThe cost is 4.\n')
  const wakes = () =>
    (w.files.get(FAKE_LOG) ?? '')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
      .filter(c => c.wake)
      .map(c => c.wake)
  for (let i = 0; i < 60; i++) await tick(w)
  expect(wakes()).toEqual([])
  for (let i = 0; i < 120; i++) await tick(w)
  expect(wakes()).toEqual([{ ref: 'bbbbbbb1', reason: 'fleet: plan/business-plan.md, which it owns, is stale' }])
  expect(json(w, `${FLEET}/state/wakes.json`).instances['business-plan']).toMatchObject({ count: 1, derivedFor: 'plan/business-plan.md|R-2@1>2' })
  for (let i = 0; i < 120; i++) await tick(w)
  expect(wakes().length).toBe(1)
})
