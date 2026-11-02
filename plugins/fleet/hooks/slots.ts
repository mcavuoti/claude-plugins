// Pure logic of slots (tested in tests/slots.test.ts): the project's scarce resources (a pool of test machines,
// an access), counted in <project>/.claude/fleet/slots.json, a command-level file. A session takes one with
// mcp__fleet__slot for a while (a lease that runs out); with none free it waits in line, and the sweeper hands a freed
// one to the first in line and takes back the leases that ran out. Nothing is held but the slot: a session that waits
// does other work or ends its turn. No `$` here.
//
// Files (wire, format): <project>/.claude/fleet/state/slots/<slot>/<n>.json, lease n of the pool (published
// no-clobber by whoever takes it; rewritten with mv by its holder to extend it; removed by its holder, or by the
// sweeper once it ran out), and <project>/.claude/fleet/state/slots/<slot>/waiting/<who>.json, one in line (written by
// the session that waits; removed when it gets one or gives up).

/** Project data: slots.json. It only gains fields, and a write keeps the fields it doesn't know */
export const SLOTS_FORMAT = 1
export const DEFAULT_LEASE_MIN = 30
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/

export type SlotSpec = { name: string; count: number; leaseMin: number; what: string }
export type Holder = { sessionId: string; ref: string | null; name: string | null }
export type Lease = { format: number; slot: string; n: number; holder: Holder; at: number; until: number; why?: string; granted?: true }
export type Waiter = { format: number; slot: string; holder: Holder; at: number; why?: string; minutes?: number }

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function newSlots(): Record<string, unknown> {
  return { slotsFormat: SLOTS_FORMAT, slots: {} }
}

/** slots.json: the pools, or why fleet can't use it */
export function parseSlots(text: string): { slots: SlotSpec[] } | { problem: string } {
  let v: any
  try {
    v = JSON.parse(text)
  } catch {
    return { problem: "slots.json isn't valid JSON" }
  }
  if (!isObject(v) || typeof v.slotsFormat !== 'number') return { problem: 'slots.json has no slotsFormat' }
  if (v.slotsFormat > SLOTS_FORMAT) return { problem: `slots.json is from a newer fleet (slotsFormat ${v.slotsFormat}): restart this session (u) to load it` }
  if (v.slots !== undefined && !isObject(v.slots)) return { problem: 'slots.json: slots is an object, name → { "count": n, "leaseMin": 30, "what": "…" }' }
  const out: SlotSpec[] = []
  for (const [name, raw] of Object.entries((v.slots ?? {}) as Record<string, unknown>)) {
    if (!NAME.test(name)) return { problem: `slots.json: "${name}" can't be a slot's name (lowercase letters, digits and -)` }
    if (!isObject(raw) || typeof raw.count !== 'number' || !Number.isInteger(raw.count) || raw.count < 0 || raw.count > 1000) return { problem: `slots.json: ${name} needs a count (a whole number)` }
    const lease = typeof raw.leaseMin === 'number' && Number.isFinite(raw.leaseMin) && raw.leaseMin > 0 ? Math.min(raw.leaseMin, 7 * 24 * 60) : DEFAULT_LEASE_MIN
    out.push({ name, count: raw.count, leaseMin: lease, what: typeof raw.what === 'string' ? raw.what.trim().slice(0, 200) : '' })
  }
  return { slots: out }
}

export function parseLease(text: string | null, format: number): Lease | null {
  try {
    const v = JSON.parse(text ?? '')
    return v && v.format === format && typeof v.n === 'number' && typeof v.until === 'number' && isObject(v.holder) ? (v as Lease) : null
  } catch {
    return null
  }
}

export function parseWaiter(text: string | null, format: number): Waiter | null {
  try {
    const v = JSON.parse(text ?? '')
    return v && v.format === format && typeof v.at === 'number' && isObject(v.holder) ? (v as Waiter) : null
  } catch {
    return null
  }
}

/** The same session: its short id when both have one (it stays across /clear and restarts), else its id */
export function sameHolder(a: Holder, b: Holder): boolean {
  return a.ref && b.ref ? a.ref === b.ref : a.sessionId === b.sessionId
}

/** A waiting file's name: the session's short id, or its id's start */
export function holderKey(h: Holder): string {
  return (h.ref ?? h.sessionId.slice(0, 8)).replace(/[^A-Za-z0-9_-]/g, '')
}

export function leaseMinutes(spec: SlotSpec, asked: unknown): number {
  return typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? Math.min(asked, spec.leaseMin) : spec.leaseMin
}

/** What a take gets: its own lease extended, a free one (n), or a place in line. A free one goes to whoever is first in
 * line: a newcomer takes one only when more are free than are waiting ahead of it */
export function takeVerdict(p: { spec: SlotSpec; leases: readonly Lease[]; waiters: readonly Waiter[]; me: Holder; now: number }): { kind: 'renew'; lease: Lease } | { kind: 'grant'; n: number } | { kind: 'wait'; place: number } {
  const live = p.leases.filter(l => l.until > p.now)
  const mine = live.find(l => sameHolder(l.holder, p.me))
  if (mine) return { kind: 'renew', lease: mine }
  const line = [...p.waiters].sort((a, b) => a.at - b.at)
  const at = line.findIndex(w => sameHolder(w.holder, p.me))
  const ahead = at >= 0 ? at : line.length
  const taken = new Set(live.map(l => l.n))
  const free = Array.from({ length: p.spec.count }, (_, n) => n).filter(n => !taken.has(n))
  if (free.length > ahead) return { kind: 'grant', n: free[0] as number }
  return { kind: 'wait', place: ahead + 1 }
}

/** The sweeper's part: leases that ran out, and the waiters a free lease goes to (oldest first) */
export function sweepSlots(p: { spec: SlotSpec; leases: readonly Lease[]; waiters: readonly Waiter[]; now: number }): { expired: Lease[]; grants: { waiter: Waiter; n: number }[] } {
  const expired = p.leases.filter(l => l.until <= p.now)
  const live = p.leases.filter(l => l.until > p.now)
  const taken = new Set(live.map(l => l.n))
  const free = Array.from({ length: p.spec.count }, (_, n) => n).filter(n => !taken.has(n))
  const line = [...p.waiters].filter(w => !live.some(l => sameHolder(l.holder, w.holder))).sort((a, b) => a.at - b.at)
  return { expired, grants: line.slice(0, free.length).map((waiter, k) => ({ waiter, n: free[k] as number })) }
}

// ---- mcp__fleet__slot ----

export const SLOT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['take', 'release', 'list'], description: 'take one (again, to extend your lease), release yours, or list the pools' },
    slot: { type: 'string', description: "the pool's name, as slots.json lists it" },
    why: { type: 'string', description: 'one line: what it is for (shown in /fleet status)' },
    minutes: { type: 'number', description: 'how long you need it (at most the pool\'s lease)' },
  },
  required: ['action'],
} as const

export const SLOT_DESCRIPTION =
  "Takes or releases one of the project's scarce resources (a license, a machine), counted in .claude/fleet/slots.json. take gives you a lease that runs out (take again to extend it); with none free you wait in line, and fleet gives you one as soon as it's yours, then tells you: do other work or end your turn meanwhile. release it as soon as you're done. list shows the pools."

export function slotHolderWords(h: Holder): string {
  return h.name || h.ref || h.sessionId.slice(0, 8)
}
