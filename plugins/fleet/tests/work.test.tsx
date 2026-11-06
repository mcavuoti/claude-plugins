import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { BAND, FAKE_LOG, FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'
import { OWNER, PROJECT, ROSTER } from './up.test'

// The work around the instances (B14, B15, B16, G2, G18, P19, P21): open board items nobody owns offered to an idle
// instance of their role, the capacity line and the band's flag, a raised budget, the runs instances declare (their
// done-files watched, their owners told or woken), and what an instance had in flight after a restart

const STATE = `${FLEET}/state`
const RUNS = `${FLEET}/runs`
const HOUR = 3600000
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0)

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

function calls(w: World, kind: string): any[] {
  return (w.files.get(FAKE_LOG) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(c => c[kind])
    .map(c => c[kind])
}

function beat(name: string, slug: string, ref: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ format: 1, instance: name, slug, ref, sessionId: `${ref}-0000-0000-0000-000000000000`, at: T0 - HOUR, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, ...extra })
}

const item = (owner: string, status: string, forWho?: string) => `---\nowner: ${owner}\nstatus: ${status}\n${forWho ? `for: ${forWho}\n` : ''}---\n# an item\n`

const TESTERS = {
  rosterFormat: 1,
  sections: [{ id: 'work', title: 'Work' }],
  roles: { chief: { agent: 'owner', model: 'haiku' }, tester: { agent: 'owner', model: 'haiku' } },
  instances: [
    { name: 'Chief', role: 'chief', section: 'work' },
    { name: 'Tester 1', role: 'tester', section: 'work' },
    { name: 'Tester 2', role: 'tester', section: 'work' },
  ],
}

test('an open item nobody owns is offered to one idle instance of its for:, then the next; a retired one is woken for it; the capacity line and the band say it', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: JSON.stringify(TESTERS),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/instances/tester-1/state.json`]: beat('Tester 1', 'tester-1', 'bbbbbbb1'),
      [`${ROOT}/board/B-4.md`]: item('open', 'open', 'tester'),
      [`${ROOT}/board/B-5.md`]: item('open', 'open'),
      [`${ROOT}/board/B-3.md`]: item('Tester 2', 'started'),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Chief', 'working'), bbbbbbb1: row('bbbbbbb1', 'Tester 1', 'idle'), ccccccc1: row('ccccccc1', 'Tester 2', 'working') } })
  await startSession($, w)
  for (let i = 0; i < 4; i++) await tick(w, 30000)
  // B-4 is for the testers: offered to the idle one; B-5 names nobody: the front door's (the chief), busy
  const work = json(w, `${STATE}/work.json`)
  expect(work.format).toBe(1)
  expect(work.unowned['B-4']).toMatchObject({ for: 'tester', offers: [{ slug: 'tester-1' }] })
  expect(work.unowned['B-5']).toMatchObject({ for: null, offers: [] })
  expect(work.unowned['B-3']).toBe(undefined)
  expect(work.capacity).toMatchObject({ idle: ['Tester 1'], unowned: 2, runs: 0, unrecorded: 0, flags: [] })
  const status = await fleet($, 'status')
  expect(status).toContain('capacity: idle: Tester 1 · 2 open items nobody owns (the oldest waits')
  expect(status).toMatch(/ {2}B-4: open, nobody owns it \(for tester\), waiting \d+m; offered to Tester 1 \d+m ago/)
  expect(status).toContain('  B-5: open, nobody owns it (for the front door), waiting')
  expect(status).toContain('no idle instance it fits yet')
  // Idle 20 min beside work that fits it: the band's red flag (a mark: nothing is held)
  await tick(w, 20 * 60000)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toContain('! idle with queued work: Tester 1 (B-4) · /fleet status')
  expect(drawn).toContain('"color":"error"')
  await band.unmount()
  expect(await fleet($, 'brief')).toContain('   - idle with queued work: Tester 1 (B-4)')
  // Still nobody's after 30 min: the next idle tester gets it (not Tester 1 again)
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Chief', 'working'), bbbbbbb1: row('bbbbbbb1', 'Tester 1', 'idle'), ccccccc1: row('ccccccc1', 'Tester 2', 'idle') } })
  await tick(w, 11 * 60000)
  expect(json(w, `${STATE}/work.json`).unowned['B-4'].offers.map((o: any) => o.slug)).toEqual(['tester-1', 'tester-2'])
  expect(calls(w, 'wake')).toEqual([])
  // Tester 1 retired for being idle; a new item for the testers goes to it (Tester 2 has one on offer): it's woken for it
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Chief', 'working'), bbbbbbb1: { ...row('bbbbbbb1', 'Tester 1', 'stopped'), stopped: 'idle' }, ccccccc1: row('ccccccc1', 'Tester 2', 'idle') } })
  w.touch(`${ROOT}/board/B-6.md`, item('open', 'open', 'testers'))
  await tick(w, 2 * 60000)
  expect(json(w, `${STATE}/work.json`).unowned['B-6'].offers.map((o: any) => o.slug)).toEqual(['tester-1'])
  expect(calls(w, 'wake')).toEqual([{ ref: 'bbbbbbb1', reason: 'fleet: an open item fits it (B-6)' }])
  // Once an owner takes it, it's no longer offered
  w.touch(`${ROOT}/board/B-4.md`, item('Tester 2', 'started', 'tester'))
  await tick(w, 61000)
  expect(json(w, `${STATE}/work.json`).unowned['B-4']).toBe(undefined)
})

async function instance($: any, on: any, files: Record<string, string> = {}, role: Record<string, unknown> = {}) {
  const roster = { ...ROSTER, roles: { owner: { ...ROSTER.roles.owner, ...role } }, wakes: { everyMin: 5, perDay: 8 } }
  const w = world(on, { env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' }, files: { ...PROJECT, [`${FLEET}/roster.json`]: JSON.stringify(roster), [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n', ...files } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'working') } })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  return w
}

test('an instance hears an item offered to it once, as a nudge; owning none, its cadence nudge names the items that fit it', { ...WITH_SESSIONS, timeoutMs: 60000 }, async ($, on) => {
  const w = await instance($, on, { [`${ROOT}/board/B-4.md`]: item('open', 'open', 'owner') }, { cadenceH: 0.25 })
  for (let i = 0; i < 4; i++) await tick(w, 30000)
  const offer = w.submits.filter(s => s.includes('B-4 is open'))
  expect(offer.length).toBe(1)
  expect(offer[0]).toContain("fleet: B-4 is open, nobody owns it, and it fits you: take it (read it, write your name as its owner and status started, then land a step of it; once it's finished, set its status done with where its result is), or say in your journal why not.")
  expect(offer[0]).toContain('This is a nudge from fleet (at most one every 5 min, 8 a day).')
  expect(offer[0]).not.toContain('check whether your work still holds')
  // Its context says so from the start
  const ctx: any = await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  expect(ctx.additionalContext.join('\n')).toContain('When you own none, fleet offers you an open item nobody owns')
  expect(ctx.additionalContext.join('\n')).toContain('A run in flight is no reason to end your turn')
  await tick(w, 5 * 60000)
  expect(w.submits.filter(s => s.includes('B-4 is open')).length).toBe(1)
  // Its cadence: nothing landed in 15 min, and it owns nothing: the nudge names what fits it
  await tick(w, 8 * 60000)
  await tick(w, 4 * 60000)
  const cadence = w.submits.filter(s => s.includes('since you last landed'))
  expect(cadence.length).toBe(1)
  expect(cadence[0]).toContain('Open items nobody owns fit you: B-4. Take one (your name as its owner, status started) and land a step of it, or say in your journal why not.')
})

test('a run: declared, listed, its done-file watched; its owner hears it finished and records it; status lists it', { ...WITH_SESSIONS, timeoutMs: 60000 }, async ($, on) => {
  const w = await instance($, on)
  await tick(w)
  const declared: any = await $.tool.call({ tool: 'mcp__fleet__run', action: 'declare', what: 'the timing sim', item: 'B-4', dir: 'sims/s1', done: 'sims/s1/done', log: 'sims/s1/log' } as any)
  expect(declared.result).toContain('Declared run-1. fleet watches sims/s1/done and tells you when it appears, even after your session restarted')
  expect(json(w, `${RUNS}/run-1.json`)).toMatchObject({ format: 1, id: 'run-1', owner: { name: 'Owner A', slug: 'owner-a', ref: REF, sessionId: SID }, what: 'the timing sim', item: 'B-4', host: null, done: 'sims/s1/done', log: 'sims/s1/log' })
  // On a host outbound.json doesn't allow: declared, and told fleet can't watch it yet
  const far: any = await $.tool.call({ tool: 'mcp__fleet__run', action: 'declare', what: 'a far sim', host: 'far.example.invalid', done: '/scratch/x/far/done' } as any)
  expect(far.result).toContain("Declared run-2. fleet watches far.example.invalid:/scratch/x/far/done")
  expect(far.result).toContain("fleet can't watch it yet: it reaches far.example.invalid over ssh only once outbound.json lists it")
  expect(((await $.tool.call({ tool: 'mcp__fleet__run', action: 'declare', what: 'x', done: 'a b' } as any)) as any).deny).toContain('done has characters')
  expect(((await $.tool.call({ tool: 'mcp__fleet__run', action: 'list', agentId: 'h1' } as any)) as any).deny).toContain('only for the main thread')
  const list: any = await $.tool.call({ tool: 'mcp__fleet__run', action: 'list' } as any)
  expect(list.result).toMatch(/- run-1 \(Owner A, B-4\): the timing sim: running since \d\d:\d\d \(done-file sims\/s1\/done\)/)
  await tick(w, 61000)
  const status = await fleet($, 'status')
  expect(status).toContain('2 runs in flight')
  expect(status).toMatch(/runs:\n  run-1 \(Owner A, B-4\): the timing sim: running since \d\d:\d\d/)
  expect(w.runs.some(a => a[0] === 'ssh')).toBe(false)
  // It ends: the sweeper (this session) sees its done-file, and its owner hears it once, at idle as a nudge
  w.touch(`${ROOT}/sims/s1/done`, '0\n')
  for (let i = 0; i < 5; i++) await tick(w, 30000)
  expect(json(w, `${RUNS}/run-1.done.json`)).toMatchObject({ format: 1, id: 'run-1', exit: 0 })
  const told = w.submits.filter(s => s.includes('your run run-1'))
  expect(told.length).toBe(1)
  expect(told[0]).toMatch(/fleet: your run run-1 for B-4 \(the timing sim\) finished at \d\d:\d\d \(exit 0\)\. Read its output \(sims\/s1\/log\), land the result where it goes, and record it: mcp__fleet__run record with its id and where the result is\./)
  expect(await fleet($, 'status')).toContain('1 run finished and not recorded')
  const recorded: any = await $.tool.call({ tool: 'mcp__fleet__run', action: 'record', id: 'run-1', result: 'results/sim1.md' } as any)
  expect(recorded.result).toBe('Recorded run-1.')
  expect(json(w, `${RUNS}/run-1.recorded.json`)).toMatchObject({ format: 1, id: 'run-1', result: 'results/sim1.md' })
  expect(((await $.tool.call({ tool: 'mcp__fleet__run', action: 'record', id: 'run-1', result: 'again' } as any)) as any).result).toBe('run-1 is recorded already.')
  expect(((await $.tool.call({ tool: 'mcp__fleet__run', action: 'list' } as any)) as any).result).toContain('run-1 (Owner A, B-4): the timing sim: recorded')
  await tick(w, 5 * 60000)
  expect(w.submits.filter(s => s.includes('your run run-1')).length).toBe(1)
})

test('after a restart an instance hears what it had in flight: its background commands, its runs; once', WITH_SESSIONS, async ($, on) => {
  const HB = `${FLEET}/instances/owner-a`
  const run = { format: 1, id: 'run-1', at: T0 - HOUR, owner: { name: 'Owner A', slug: 'owner-a', ref: REF, sessionId: SID }, what: 'the timing sim', item: 'B-4', host: null, dir: 'sims/s1', done: 'sims/s1/done', log: 'sims/s1/log' }
  const w = await instance($, on, {
    [`${HB}/state.json`]: JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: REF, sessionId: SID, at: T0 - 60000, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: T0 - HOUR, bg: [{ command: 'make sim > sims/log 2>&1', at: T0 - 600000 }] }),
    [`${HB}/seed-${REF}.json`]: JSON.stringify({ format: 1, ref: REF, at: T0 - HOUR }),
    [`${RUNS}/run-1.json`]: JSON.stringify(run),
  })
  for (let i = 0; i < 3; i++) await tick(w, 30000)
  const told = w.submits.filter(s => s.includes('in flight'))
  expect(told.length).toBe(1)
  expect(told[0]).toContain('fleet: your conversation was restarted while these were in flight: background commands: `make sim > sims/log 2>&1`; your declared runs: run-1 (the timing sim). Check their outputs (their logs, their done-files) before going on')
  await tick(w, 6 * 60000)
  const r: any = await $.tool.call({ tool: 'Read', file_path: `${FLEET}/roster.json` } as any)
  expect((r.context ?? []).join('\n')).not.toContain('in flight')
  expect(w.submits.filter(s => s.includes('in flight')).length).toBe(1)
})

test('a raised budget wakes a retired instance that stopped over it, once; the 80% line reaches no model', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: {
      ...PROJECT,
      [`${FLEET}/instances/owner-c/state.json`]: beat('Owner C', 'owner-c', 'ccccccc1', { budget: { day: '2026-11-02', usd: 2, cap: 1, state: 'over' } }),
      [`${FLEET}/instances/owner-c/spend.json`]: JSON.stringify({ format: 1, slug: 'owner-c', day: '2026-11-02', usd: 2, sessionId: 's', last: 2, at: 0 }),
    },
  })
  sessionsSay(w, { rows: { ccccccc1: { ...row('ccccccc1', 'Owner C', 'stopped'), stopped: 'idle' } } })
  await startSession($, w)
  for (let i = 0; i < 4; i++) await tick(w, 30000)
  expect(calls(w, 'wake')).toEqual([])
  expect(await fleet($, 'budget "Owner C" +2')).toContain('Owner C: $3.00 for today')
  for (let i = 0; i < 3; i++) await tick(w, 30000)
  expect(calls(w, 'wake')).toEqual([{ ref: 'ccccccc1', reason: 'fleet: its budget was raised' }])
  for (let i = 0; i < 30; i++) await tick(w, 60000)
  expect(calls(w, 'wake').length).toBe(1)
})

test('a run that finished wakes its retired owner; a done-file on a host is read only where outbound.json allows', WITH_SESSIONS, async ($, on) => {
  const owner = { name: 'Owner C', slug: 'owner-c', ref: 'ccccccc1', sessionId: 'ccccccc1-0000-0000-0000-000000000000' }
  const run = (id: string, host: string | null, done: string) => JSON.stringify({ format: 1, id, at: T0 - HOUR, owner, what: `the sim ${id}`, item: null, host, dir: null, done, log: null })
  const w = world(on, {
    background: false,
    files: {
      ...PROJECT,
      [`${FLEET}/outbound.json`]: JSON.stringify({ outboundFormat: 1, hosts: ['dev.example.invalid'], remotes: [], recipients: [], commands: [], outside: [] }),
      [`${FLEET}/instances/owner-c/state.json`]: beat('Owner C', 'owner-c', 'ccccccc1'),
      [`${RUNS}/run-1.json`]: run('run-1', null, 'sims/c1/done'),
      [`${RUNS}/run-2.json`]: run('run-2', 'dev.example.invalid', '/scratch/x/c2/done'),
      [`${RUNS}/run-3.json`]: run('run-3', 'other.example.invalid', '/scratch/x/c3/done'),
    },
  })
  const remote: string[][] = []
  let c2 = false
  w.exec.value = argv => {
    if (argv[0] !== 'ssh') return undefined
    remote.push(argv)
    return c2 ? { exitCode: 0, stdout: '3\n' } : { exitCode: 1, stderr: 'cat: /scratch/x/c2/done: No such file or directory' }
  }
  sessionsSay(w, { rows: { ccccccc1: { ...row('ccccccc1', 'Owner C', 'stopped'), stopped: 'idle' } } })
  await startSession($, w)
  for (let i = 0; i < 4; i++) await tick(w, 30000)
  expect(remote.length).toBeGreaterThan(0)
  expect(remote.every(a => a.join(' ') === 'ssh -o BatchMode=yes -o ConnectTimeout=15 dev.example.invalid -- cat -- /scratch/x/c2/done')).toBe(true)
  expect(calls(w, 'wake')).toEqual([])
  w.touch(`${ROOT}/sims/c1/done`, '0\n')
  c2 = true
  for (let i = 0; i < 5; i++) await tick(w, 30000)
  expect(json(w, `${RUNS}/run-1.done.json`)).toMatchObject({ id: 'run-1', exit: 0 })
  expect(json(w, `${RUNS}/run-2.done.json`)).toMatchObject({ id: 'run-2', exit: 3 })
  expect(json(w, `${RUNS}/run-3.done.json`)).toBe(undefined)
  expect(calls(w, 'wake')[0]).toEqual({ ref: 'ccccccc1', reason: 'fleet: its runs run-1, run-2 finished' })
  const status = await fleet($, 'status')
  expect(status).toContain('run-2 (Owner C): the sim run-2 on dev.example.invalid: finished at')
  expect(status).toContain('(exit 3), not recorded yet')
  expect(status).toContain('run-3 (Owner C): the sim run-3 on other.example.invalid: running since')
})

// ---- 0.9.0's review: one round of offers per item, items for nobody, a run whose log went quiet, a new day's budget ----

test('an item nobody takes is offered to each instance it’s for once, then no more (status and the brief say so); its file changing starts a new round', { ...WITH_SESSIONS, timeoutMs: 60000 }, async ($, on) => {
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: JSON.stringify(TESTERS),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${ROOT}/board/B-4.md`]: item('open', 'open', 'tester'),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Chief', 'working'), bbbbbbb1: row('bbbbbbb1', 'Tester 1', 'idle'), ccccccc1: row('ccccccc1', 'Tester 2', 'idle') } })
  await startSession($, w)
  for (let i = 0; i < 4; i++) await tick(w, 30000)
  expect(json(w, `${STATE}/work.json`).unowned['B-4'].offers.length).toBe(1)
  for (let i = 0; i < 7; i++) await tick(w, 5 * 60000)
  expect(json(w, `${STATE}/work.json`).unowned['B-4'].offers.map((o: any) => o.slug).sort()).toEqual(['tester-1', 'tester-2'])
  // Each was offered it and none took it: no third offer, not in two hours, not in a day
  for (let i = 0; i < 7; i++) await tick(w, 5 * 60000)
  const done = json(w, `${STATE}/work.json`).unowned['B-4']
  expect(done.offers.length).toBe(2)
  expect(done.allOffered).toBeGreaterThan(0)
  for (let i = 0; i < 30; i++) await tick(w, 5 * 60000)
  expect(json(w, `${STATE}/work.json`).unowned['B-4'].offers.length).toBe(2)
  const status = await fleet($, 'status')
  expect(status).toContain('  B-4: open, nobody owns it (for tester), waiting')
  expect(status).toContain("offered to all 2 it's for, nobody took it (offered again once its file changes)")
  expect(await fleet($, 'brief')).toContain("   - B-4: offered to all it's for (2), nobody took it: give it an owner, a for: that fits, or close it")
  // No idle flag for it: every instance it's for already said why not
  expect(json(w, `${STATE}/work.json`).capacity.flags).toEqual([])
  // Its file changes (the person unblocked it): a new round, which counts within the wakes' caps
  w.touch(`${ROOT}/board/B-4.md`, `${item('open', 'open', 'tester')}\nUnblocked: the data is in.\n`)
  for (let i = 0; i < 3; i++) await tick(w, 30000)
  const again = json(w, `${STATE}/work.json`).unowned['B-4']
  expect(again).toMatchObject({ round: 2, allOffered: null })
  expect(again.offers.length).toBe(1)
})

test('an open item with no for: in a roster with no front door, written by its only instance: status says it’s for nobody, the band flags it, the brief says it needs the person', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    worldPaths: ['board/**', 'notes/**'],
    files: { ...PROJECT, [`${FLEET}/roster.json`]: JSON.stringify({ ...ROSTER, instances: ROSTER.instances.filter((i: any) => i.name === 'Owner A') }), [`${ROOT}/board/B-3.md`]: item('none', 'open'), [`${FLEET}/instances/owner-a/state.json`]: beat('Owner A', 'owner-a', 'aaaaaaa1'),
      // Its writer is the only instance: an item with no for: goes to anyone but its writer, and there is nobody else
      [`${FLEET}/events/${hourFolder(T0 - 60000)}/${T0 - 60000}-bbbbbbbb-1.json`]: JSON.stringify({ format: 1, at: T0 - 60000, path: 'board/B-3.md', from: null, to: hashText(item('none', 'open')), via: 'tool', tool: 'Write', blind: false, by: { sessionId: 'aaaaaaa1-0000-0000-0000-000000000000', ref: 'aaaaaaa1', name: 'Owner A', agentId: null } }),
      [`${FLEET}/events/latest`]: JSON.stringify({ format: 1, last: `${T0 - 60000}-bbbbbbbb-1.json` }),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  for (let i = 0; i < 2; i++) await tick(w, 30000)
  expect(json(w, `${STATE}/work.json`).unowned['B-3'].offers).toEqual([])
  const status = await fleet($, 'status')
  expect(status).toContain('  B-3: open, nobody owns it (for nobody), waiting')
  expect(status).toContain(': the roster has no front door (person.front or a chief): give it a for:')
  await tick(w, 21 * 60000)
  expect(json(w, `${STATE}/work.json`).capacity.nobody).toEqual(['B-3'])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toContain('B-3 for nobody: give it a for:')
  expect(drawn).toContain('"color":"error"')
  await band.unmount()
  const brief = await fleet($, 'brief')
  expect(brief).toContain('1. Needs you: 1 open item for nobody')
  expect(brief).toContain('   - B-3: open, for nobody: the roster has no front door (person.front or a chief): give it a for:')
  expect(brief).not.toContain('Nothing needs you')
})

test('a declared run here whose log stayed still two hours with no done-file: its owner is told once to check it’s alive, and status says so', { ...WITH_SESSIONS, timeoutMs: 90000 }, async ($, on) => {
  const w = await instance($, on)
  await tick(w)
  await $.tool.call({ tool: 'mcp__fleet__run', action: 'declare', what: 'the timing sim', dir: 'sims/s1', done: 'sims/s1/done', log: 'sims/s1/log' } as any)
  w.touch(`${ROOT}/sims/s1/log`, 'setsid: command not found\n')
  for (let i = 0; i < 20; i++) await tick(w, 5 * 60000)
  expect(w.submits.filter(s => s.includes('has no done-file yet'))).toEqual([])
  for (let i = 0; i < 6; i++) await tick(w, 5 * 60000)
  const told = w.submits.filter(s => s.includes('has no done-file yet'))
  expect(told.length).toBe(1)
  expect(told[0]).toMatch(/fleet: your run run-1 \(the timing sim\) has no done-file yet, and its log \(sims\/s1\/log\) hasn't changed in 2h\d*m?: check it's still alive \(its process, its log\)\. If it never started or died, record it \(mcp__fleet__run record, id run-1, what happened\) and launch it again \(nohup sh -c/)
  expect(await fleet($, 'status')).toMatch(/run-1 \(Owner A\): the timing sim: running since \d\d:\d\d \(done-file sims\/s1\/done\); its log hasn't changed in 2h/)
  for (let i = 0; i < 6; i++) await tick(w, 5 * 60000)
  expect(w.submits.filter(s => s.includes('has no done-file yet')).length).toBe(1)
})

test('a new day resumes a retired instance that stopped over its budget yesterday: it’s woken once to resume', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: {
      ...PROJECT,
      [`${FLEET}/instances/owner-c/state.json`]: beat('Owner C', 'owner-c', 'ccccccc1', { budget: { day: '2026-11-01', usd: 1.2, cap: 1, state: 'over' } }),
      [`${FLEET}/instances/owner-c/spend.json`]: JSON.stringify({ format: 1, slug: 'owner-c', day: '2026-11-01', usd: 1.2, sessionId: 's', last: 1.2, at: 0 }),
    },
  })
  sessionsSay(w, { rows: { ccccccc1: { ...row('ccccccc1', 'Owner C', 'stopped'), stopped: 'idle' } } })
  await startSession($, w)
  for (let i = 0; i < 3; i++) await tick(w, 30000)
  expect(calls(w, 'wake')).toEqual([{ ref: 'ccccccc1', reason: 'fleet: a new day, its budget has room again' }])
  for (let i = 0; i < 10; i++) await tick(w, 60000)
  expect(calls(w, 'wake').length).toBe(1)
})
