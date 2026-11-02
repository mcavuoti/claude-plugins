import { expect, test } from 'claude-code/testing'

import { holderKey, leaseMinutes, parseSlots, renewVerdict, sameExpired, sameHolder, sweepSlots, takeVerdict, waiterGone, type Holder, type Lease, type Waiter } from '../hooks/slots'

// Slots' pure parts: slots.json, what a take gets (its own lease extended, a free one, or a place in line), and the
// sweeper's part (leases that ran out back, free ones to the first in line)

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const A: Holder = { sessionId: 'aaaaaaaa-1', ref: 'aaaaaaaa', name: 'Tester 1' }
const B: Holder = { sessionId: 'bbbbbbbb-1', ref: 'bbbbbbbb', name: 'Tester 2' }
const C: Holder = { sessionId: 'cccccccc-1', ref: null, name: null }
const SPEC = { name: 'sim', count: 1, leaseMin: 30, what: 'the simulator licenses' }
const lease = (n: number, holder: Holder, until: number): Lease => ({ format: 1, slot: 'sim', n, holder, at: NOW - 60000, until })
const waiter = (holder: Holder, at: number): Waiter => ({ format: 1, slot: 'sim', holder, at })

test('slots.json: its pools, a newer one left alone', () => {
  expect(parseSlots('{"slotsFormat": 1, "slots": {"sim": {"count": 2, "leaseMin": 45, "what": "licenses"}, "box": {"count": 1}}}')).toEqual({
    slots: [
      { name: 'sim', count: 2, leaseMin: 45, what: 'licenses' },
      { name: 'box', count: 1, leaseMin: 30, what: '' },
    ],
  })
  expect(parseSlots('{"slotsFormat": 2}')).toEqual({ problem: 'slots.json is from a newer fleet (slotsFormat 2): restart this session (u) to load it' })
  expect(parseSlots('{"slotsFormat": 1, "slots": {"Sim X": {"count": 1}}}')).toMatchObject({ problem: expect.stringContaining("can't be a slot's name") })
  expect(parseSlots('{"slotsFormat": 1, "slots": {"sim": {}}}')).toEqual({ problem: 'slots.json: sim needs a count (a whole number)' })
  expect(leaseMinutes(SPEC, 10)).toBe(10)
  expect(leaseMinutes(SPEC, 90)).toBe(30)
})

test('a take: its own lease extended, a free one, or a place in line (the line goes first)', () => {
  expect(takeVerdict({ spec: SPEC, leases: [], waiters: [], me: A, now: NOW })).toEqual({ kind: 'grant', n: 0 })
  expect(takeVerdict({ spec: SPEC, leases: [lease(0, A, NOW + 60000)], waiters: [], me: A, now: NOW })).toMatchObject({ kind: 'renew' })
  expect(takeVerdict({ spec: SPEC, leases: [lease(0, A, NOW + 60000)], waiters: [], me: B, now: NOW })).toEqual({ kind: 'wait', place: 1 })
  // A lease that ran out is free; a newcomer waits behind the line
  expect(takeVerdict({ spec: SPEC, leases: [lease(0, A, NOW - 1)], waiters: [], me: B, now: NOW })).toEqual({ kind: 'grant', n: 0 })
  expect(takeVerdict({ spec: SPEC, leases: [lease(0, A, NOW - 1)], waiters: [waiter(B, NOW - 5000)], me: C, now: NOW })).toEqual({ kind: 'wait', place: 2 })
  expect(takeVerdict({ spec: SPEC, leases: [lease(0, A, NOW - 1)], waiters: [waiter(B, NOW - 5000)], me: B, now: NOW })).toEqual({ kind: 'grant', n: 0 })
  expect(takeVerdict({ spec: { ...SPEC, count: 2 }, leases: [lease(0, A, NOW + 1000)], waiters: [], me: B, now: NOW })).toEqual({ kind: 'grant', n: 1 })
  expect(sameHolder(C, { ...C, name: 'x' })).toBe(true)
  expect([holderKey(A), holderKey(C)]).toEqual(['aaaaaaaa', 'cccccccc'])
})

test("the sweeper's part: leases that ran out go back, free ones go to the first in line", () => {
  const r = sweepSlots({ spec: SPEC, leases: [lease(0, A, NOW - 1)], waiters: [waiter(C, NOW - 1000), waiter(B, NOW - 5000)], now: NOW })
  expect(r.expired.map(l => l.holder.name)).toEqual(['Tester 1'])
  expect(r.grants.map(g => [g.waiter.holder.name, g.n])).toEqual([['Tester 2', 0]])
  expect(sweepSlots({ spec: SPEC, leases: [lease(0, A, NOW + 1000)], waiters: [waiter(B, NOW)], now: NOW }).grants).toEqual([])
})

test('a renewal while others wait holds it no longer than a lease from when it was taken; waiters gone or a day old leave the line', () => {
  const held = { ...lease(0, A, NOW + 10 * 60000), at: NOW - 15 * 60000 }
  // Nobody waits: any length, up to the pool's lease
  expect(renewVerdict({ spec: SPEC, lease: held, minutes: 30, now: NOW, waiting: 0 })).toEqual({ until: NOW + 30 * 60000, capped: false })
  // Someone waits: capped at 30 min since it was taken, and refused once it's there
  expect(renewVerdict({ spec: SPEC, lease: held, minutes: 30, now: NOW, waiting: 1 })).toEqual({ until: NOW + 15 * 60000, capped: true })
  expect(renewVerdict({ spec: SPEC, lease: { ...held, until: NOW + 15 * 60000 }, minutes: 30, now: NOW, waiting: 1 })).toEqual({ refused: true, cap: NOW + 15 * 60000 })
  expect(renewVerdict({ spec: SPEC, lease: held, minutes: 5, now: NOW, waiting: 1 })).toEqual({ until: NOW + 5 * 60000, capped: false })
  expect(waiterGone({ state: 'gone', mtimeMs: NOW, now: NOW })).toBe('its session is gone')
  expect(waiterGone({ state: 'idle', mtimeMs: NOW - 25 * 3600000, now: NOW })).toBe('it has waited over a day without taking again')
  expect(waiterGone({ state: null, mtimeMs: NOW - 3600000, now: NOW })).toBe(null)
  // Taken back only if it's the very lease that ran out
  const ran = lease(0, A, NOW - 1)
  expect(sameExpired(ran, ran, NOW)).toBe(true)
  expect(sameExpired({ ...ran, at: NOW, until: NOW + 60000, holder: B }, ran, NOW)).toBe(false)
  expect(sameExpired(null, ran, NOW)).toBe(false)
})
