import { expect, test } from 'claude-code/testing'

import { circularOf, derivedKindOf, derivedOf, derivedText, ownsKind, quietEnough, staleDerived } from '../hooks/derived'
import type { Suspect } from '../hooks/records'

// Derived documents' pure parts: world.json's "derived", which documents a revised record made stale, the debounce,
// the owner's words, and no circular authority

const WORLD = { worldFormat: 1, paths: ['plan/**', 'req/**'], derived: { businessplan: { paths: ['plan/business-plan.md'], owner: 'planner', debounceMin: 10 }, proposal: { paths: 'proposal/**', owner: 'Integrator' } } }
const ME = { sessionId: 'aaaaaaaa', offsetMin: 0 }

test("world.json's derived: each kind's files, owner and debounce", () => {
  const d = derivedOf(WORLD, false)
  if (!('kinds' in d)) throw new Error(d.problem)
  expect(d.kinds.map(k => [k.kind, k.globs, k.owner, k.debounceMin])).toEqual([
    ['businessplan', ['plan/business-plan.md'], 'planner', 10],
    ['proposal', ['proposal/**'], 'Integrator', 30],
  ])
  expect(derivedKindOf('proposal/p.md', d.kinds)?.kind).toBe('proposal')
  expect(derivedKindOf('plan/other.md', d.kinds)).toBe(null)
  expect(ownsKind(d.kinds[0] as never, { name: 'Business Plan', role: 'planner' })).toBe(true)
  expect(ownsKind(d.kinds[1] as never, { name: 'integrator', role: 'x' })).toBe(true)
  expect(derivedOf({ worldFormat: 1, paths: [] }, false)).toEqual({ kinds: [] })
  expect(derivedOf({ worldFormat: 1, paths: [], derived: { plan: { paths: ['x'] } } }, false)).toEqual({ problem: 'world.json: derived plan needs an owner (a role or an instance of the roster)' })
})

test('stale: a derived document citing a record revised since; the debounce counts from the newest move', () => {
  const d = derivedOf(WORLD, false) as { kinds: never[] }
  const at = Date.UTC(2026, 10, 2, 12, 0, 0)
  const suspects: Suspect[] = [
    { path: 'plan/business-plan.md', id: null, owner: null, reasons: [{ why: 'stale', pin: 'R-1@1', of: 'R-1', now: 2, moved: { rev: 2, kind: 'revision', at, by: null, hash: 'h1' } }, { why: 'unknown', pin: 'X-9@1', of: 'X-9' }] },
    { path: 'notes/n.md', id: null, owner: null, reasons: [{ why: 'stale', pin: 'R-1@1', of: 'R-1', now: 2, moved: { rev: 2, kind: 'revision', at, by: null, hash: 'h1' } }] },
    { path: 'proposal/p.md', id: null, owner: null, reasons: [{ why: 'ahead', pin: 'R-1@9', of: 'R-1', now: 2 }] },
  ]
  const stale = staleDerived(suspects, d.kinds)
  expect(stale).toEqual([{ path: 'plan/business-plan.md', kind: 'businessplan', owner: 'planner', debounceMin: 10, pins: [{ pin: 'R-1@1', now: 2 }], movedAt: at, key: 'plan/business-plan.md|R-1@1>2' }])
  expect(quietEnough(stale[0] as never, at + 9 * 60000)).toBe(false)
  expect(quietEnough(stale[0] as never, at + 10 * 60000)).toBe(true)
  expect(derivedText(stale, ME)).toContain('- plan/business-plan.md (businessplan): R-1@1 → v2; the last moved at 12:00')
  expect(derivedText(stale, ME)).toContain('"inputs unchanged since" its last version is a valid landing')
})

test('no circular authority: a change to a record whose only cited authority is a derived document resting on it', () => {
  const base = { targetId: 'R-1', newPins: [], addedText: '', derivedPaths: ['plan/business-plan.md'], derivedIds: new Map<string, string>([['BP-1', 'plan/BP-1.md']]), inputsOf: (p: string) => (p === 'plan/business-plan.md' || p === 'plan/BP-1.md' ? ['R-1', 'F-2'] : []) }
  expect(circularOf({ ...base, summary: 'R-1 becomes 3, as plan/business-plan.md says' })).toEqual({ via: ['plan/business-plan.md'] })
  expect(circularOf({ ...base, summary: 'R-1 becomes 3', newPins: [{ id: 'BP-1', rev: 4 }] })).toEqual({ via: ['plan/BP-1.md'] })
  // Another authority cited too: not circular
  expect(circularOf({ ...base, summary: 'R-1 becomes 3 (plan/business-plan.md, and the finding F-2@1)' })).toBe(null)
  // A derived document that doesn't rest on the record: no circle
  expect(circularOf({ ...base, targetId: 'R-7', summary: 'R-7 changes, per plan/business-plan.md' })).toBe(null)
  expect(circularOf({ ...base, summary: 'R-1 becomes 3' })).toBe(null)
  expect(circularOf({ ...base, targetId: null, summary: 'per plan/business-plan.md' })).toBe(null)
})
