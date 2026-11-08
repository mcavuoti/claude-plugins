import { expect, test } from 'claude-code/testing'

import { FAKE_LOG, FLEET, JOB, ROOT, SID, fleet, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'
import { OWNER } from './up.test'

// The review of 0.12.0 (/fleet up --force and wake's force): who may run the person's commands, and what happens to the
// paced wakes after the reply

function roster(n = 3): string {
  const names = Array.from({ length: n }, (_, i) => `Owner ${String.fromCharCode(65 + i)}`)
  return JSON.stringify({
    rosterFormat: 1,
    sections: [{ id: 'owners', title: 'Owners' }],
    roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 } } },
    instances: names.map(name => ({ name, role: 'owner', section: 'owners' })),
    budget: { usdDay: 50 },
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

const ref = (i: number) => `${String.fromCharCode(97 + i).repeat(7)}1`

function setup(on: any, opts: { n?: number; why?: string | undefined; version?: string; background?: boolean; rows?: Record<string, unknown>; env?: Record<string, string> } = {}): World {
  const n = opts.n ?? 3
  const w = world(on, { background: opts.background ?? false, files: { [`${FLEET}/roster.json`]: roster(n), [`${ROOT}/.claude/agents/owner.md`]: OWNER }, ...(opts.env ? { env: opts.env } : {}) })
  const rows: Record<string, unknown> = opts.rows ?? {}
  if (!opts.rows)
    for (let i = 0; i < n; i++) {
      const why = 'why' in opts ? opts.why : 'person'
      rows[ref(i)] = { ...row(ref(i), `Owner ${String.fromCharCode(65 + i)}`, 'stopped'), ...(why ? { stopped: why } : {}) }
    }
  sessionsSay(w, { rows, version: opts.version ?? '0.17.0' } as any)
  return w
}

async function after(w: World, ms: number) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

// ---- F1/G1: a launch prompt, or a session started from another session's shell, isn't the person ----

test('a launch prompt of /fleet up --force (it reads as composer) wakes nothing, and says why', WITH_SESSIONS, async ($, on) => {
  const w = setup(on, { background: true })
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, intent: '/fleet up --force', firstTerminalAt: null }))
  await startSession($, w)
  const up = await fleet($, 'up --force')
  await after(w, 7000)
  expect(up).toContain("Only the person starts instances, typing it at a terminal (this is this session's launch prompt")
  expect(up).toContain("not typed in this session's prompt box: type it here")
  expect(wakes(w)).toEqual([])
})

test('a launch prompt of /fleet accept outbound.json stamps nothing', async ($, on) => {
  const ALLOW = JSON.stringify({ outboundFormat: 1, hosts: ['devbox'], remotes: ['origin'], recipients: ['me@example.com'] })
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${ROOT}/notes/x.md`]: 'x\n', [`${FLEET}/outbound.json`]: ALLOW } })
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, intent: '/fleet accept outbound.json', firstTerminalAt: null }))
  await startSession($, w)
  // Widened by a Bash write (Bash is never held), then the launch prompt
  w.touch(`${FLEET}/outbound.json`, JSON.stringify({ outboundFormat: 1, hosts: ['devbox', 'far.invalid'] }))
  const r = await fleet($, 'accept outbound.json')
  expect(r).not.toContain('stamped as yours')
  expect(r).toContain("this session's launch prompt")
})

test('a launch prompt of /fleet down, and of /fleet init, change nothing', WITH_SESSIONS, async ($, on) => {
  const w = setup(on, { background: true })
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, intent: '/fleet down', firstTerminalAt: null }))
  await startSession($, w)
  expect(await fleet($, 'down')).toContain("this session's launch prompt")
  expect(w.files.has(`${FLEET}/state/down.json`)).toBe(false)
})

test('in a background session, the person typing a /fleet that is not its launch prompt is his', WITH_SESSIONS, async ($, on) => {
  const w = setup(on, { background: true })
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, intent: 'Reply only: ok', firstTerminalAt: null }))
  await startSession($, w)
  const up = await fleet($, 'up --force')
  expect(up).toContain('  Owner A: waking (--force)')
  expect(wakes(w).map(x => x.ref)).toEqual(['aaaaaaa1'])
})

test('a session started from another session\'s shell (it inherited its CLAUDE_JOB_DIR) runs none of the person\'s commands', WITH_SESSIONS, async ($, on) => {
  const w = setup(on, { background: true })
  // The job folder names another session: this one is a claude -p that session ran
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: 'ffffffff-0000-0000-0000-000000000000', intent: 'work', firstTerminalAt: null }))
  await startSession($, w)
  const up = await fleet($, 'up --force')
  expect(up).toContain("this session was started from another session's shell")
  await after(w, 7000)
  expect(wakes(w)).toEqual([])
})

test("a session with an instance's FLEET_INSTANCE but no job of its own (its shell's claude -p) runs none of the person's commands", WITH_SESSIONS, async ($, on) => {
  const w = setup(on, { env: { FLEET_INSTANCE: 'Owner A' } })
  await startSession($, w)
  expect(await fleet($, 'down')).toContain("this session was started from another session's shell")
  expect(w.files.has(`${FLEET}/state/down.json`)).toBe(false)
})

// ---- F2/F3: the paced wakes ----

test('/fleet down after /fleet up --force keeps the down one from being woken by a wake still to send', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  const up = await fleet($, 'up --force')
  expect(up).toContain('  Owner C: waking (--force) in 6 s')
  expect(up).toContain('if it ends before the last one, /fleet up --force again sends the rest')
  await fleet($, 'down "Owner C"')
  await after(w, 7000)
  expect(wakes(w).map(x => x.ref)).toEqual(['aaaaaaa1', 'bbbbbbb1'])
})

test('a wake still to send is checked again when its time comes: one taken down meanwhile by another session stays stopped', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  await fleet($, 'up --force')
  // down.json written by another session (no /fleet down here)
  w.touch(`${FLEET}/state/down.json`, JSON.stringify({ format: 1, instances: { 'owner-c': 1 } }))
  await after(w, 7000)
  expect(wakes(w).map(x => x.ref)).toEqual(['aaaaaaa1', 'bbbbbbb1'])
})

test('the wakes still to send go once each, in order, and a second /fleet up --force meanwhile sends none twice', WITH_SESSIONS, async ($, on) => {
  const w = setup(on)
  await startSession($, w)
  await fleet($, 'up --force')
  await after(w, 1000)
  // Typed again before the queue drained (the session reloaded, say): the same instances aren't queued twice
  await fleet($, 'up --force')
  await after(w, 9000)
  const refs = wakes(w).map(x => x.ref)
  expect(refs.filter(r => r === 'bbbbbbb1').length).toBe(1)
  expect(refs.filter(r => r === 'ccccccc1').length).toBe(1)
})

test('pacing: 16 stopped by the person, the last wake 45 s after the first', WITH_SESSIONS, async ($, on) => {
  const w = setup(on, { n: 16 })
  await startSession($, w)
  const up = await fleet($, 'up --force')
  expect(up).toContain('Owner P: waking (--force) in 45 s')
  expect(wakes(w).length).toBe(1)
  await after(w, 44000)
  expect(wakes(w).length).toBe(15)
  await after(w, 1000)
  expect(wakes(w).length).toBe(16)
  expect(new Set(wakes(w).map(x => x.ref)).size).toBe(16)
})

// ---- F5: a forced wake only for this project's own session ----

test('--force never force-wakes a stopped session with no folder of the same name (it may be another project\'s)', WITH_SESSIONS, async ($, on) => {
  const rows = { eeeeeee1: { ref: 'eeeeeee1', sessionId: null, name: 'Owner A', state: 'stopped', panel: 'none', root: null, background: true, agent: null, stopped: 'person' } }
  const w = setup(on, { n: 1, rows })
  await startSession($, w)
  const up = await fleet($, 'up --force')
  await after(w, 4000)
  expect(up).toContain("Owner A: stopped by you, not woken: the stopped session of that name isn't known to be this project's")
  expect(wakes(w)).toEqual([])
})

test('--force wakes a session with no folder when the instance\'s heartbeat names that job', WITH_SESSIONS, async ($, on) => {
  const rows = { eeeeeee1: { ref: 'eeeeeee1', sessionId: null, name: 'Owner A', state: 'stopped', panel: 'none', root: null, background: true, agent: null, stopped: 'person' } }
  const w = setup(on, { n: 1, rows })
  w.files.set(`${FLEET}/instances/owner-a/state.json`, JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'eeeeeee1', sessionId: 'eeeeeee1-0000-0000-0000-000000000000', at: 0, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0 }))
  await startSession($, w)
  const up = await fleet($, 'up --force')
  expect(up).toContain('  Owner A: waking (--force)')
  expect(wakes(w)).toEqual([{ ref: 'eeeeeee1', reason: 'fleet up --force (the person typed it)', force: true }])
})

// ---- F6: the texts ----

test('a sessions that gives no version, or an older one, gets the one dependency line, and /fleet up wakes nothing', WITH_SESSIONS, async ($, on) => {
  const w = setup(on, { version: '' })
  await startSession($, w)
  const up = await fleet($, 'up --force')
  expect(up).toContain('fleet needs sessions 0.17.0 or later (an older version here)')
  expect(up).toContain('Nothing was started or woken')
  expect(up).not.toContain('stopped by you: to wake (--force)')
  await after(w, 7000)
  expect(wakes(w)).toEqual([])
})

test('/fleet status for a down instance the person stopped names it in the --force it needs', WITH_SESSIONS, async ($, on) => {
  const w = setup(on, { why: 'unknown' })
  sessionsSay(w, { rows: { aaaaaaa1: { ...row('aaaaaaa1', 'Owner A', 'stopped'), stopped: 'person' }, bbbbbbb1: { ...row('bbbbbbb1', 'Owner B', 'stopped'), stopped: 'unknown' } }, version: '0.17.0' } as any)
  await startSession($, w)
  await fleet($, 'down "Owner A"')
  const status = await fleet($, 'status')
  expect(status).toContain('stopped by you (/fleet up --force "Owner A" wakes it)')
  expect(status).toContain('stopped, and nothing says why (Enter or u in the panel restarts it, or /fleet up --force)')
})

// ---- 8: sessions' model tool mcp__sessions__wake: never for an instance of the roster ----

test("mcp__sessions__wake of an instance of the roster (by name, any case, or its job's id) is refused; another session's passes", WITH_SESSIONS, async ($, on) => {
  // A stand-in for sessions' tool, beneath fleet (sessions answers it from its own tool.call hook)
  on('tool.call', { tool: 'mcp__sessions__wake' } as any, () => ({ result: 'woken', text: 'woken' }) as any)
  const w = setup(on)
  w.files.set(`${FLEET}/instances/owner-b/state.json`, JSON.stringify({ format: 1, instance: 'Owner B', slug: 'owner-b', ref: 'bbbbbbb1', sessionId: 'bbbbbbb1-0000-0000-0000-000000000000', at: 0, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0 }))
  await startSession($, w)
  const wake = async (session: string): Promise<any> => $.tool.call({ tool: 'mcp__sessions__wake', session } as any)
  // Every form sessions' wake reads: quoted, "name [ref]" as it hands back for SendMessage, the full session id
  for (const target of ['Owner A', 'owner a', 'bbbbbbb1', 'sid:bbbbbbb1-0000', '“Owner A”', '"owner a"', 'Owner A [aaaaaaa1]', 'Someone [bbbbbbb1]', 'bbbbbbb1-0000-0000-0000-000000000000', '  "Owner B [sid:bbbbbbb1]"  ']) {
    const r = await wake(target)
    expect(String(r?.deny ?? '')).toContain("is an instance of this project's fleet, and fleet wakes its instances itself")
    expect(String(r?.deny ?? '')).toContain('/fleet up --force')
  }
  // Not an instance: fleet lets it through to the tool
  const other = await wake('"Research notes [ccccccc9]"')
  expect(String(other?.deny ?? '')).not.toContain("instance of this project's fleet")
  expect(wakes(w)).toEqual([])
})
