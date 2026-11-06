import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// What 0.10.1's slower pace must not delay: a used-up budget, a /fleet down or a budget lift the person types elsewhere,
// an urgent nudge past the wakes' window, a code watch the person stamps, a slot given from the line, what must
// outlive a restart, a worktree moved. Each was a review's proof that the first cut of 0.10.1 got wrong

const MIN = 60000
const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, mcp__fleet__*\n---\nYou own a part of the notes.\n'
function roster(extra: Record<string, unknown> = {}, roleUsd = 1, projectUsd = 5): string {
  return JSON.stringify({
    rosterFormat: 1,
    sections: [{ id: 'owners', title: 'Owners' }],
    roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: roleUsd } } },
    instances: [
      { name: 'Owner A', role: 'owner', section: 'owners', brief: 'You own notes/a.' },
      { name: 'Owner B', role: 'owner', section: 'owners' },
    ],
    budget: { usdDay: projectUsd },
    settings: { env: {} },
    ...extra,
  })
}
const HB = `${FLEET}/instances/owner-a`
const BDIR = `${FLEET}/instances/owner-b`
const STATE = `${FLEET}/state`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }
const DAY = '2026-11-02'

// Another session holds the sweeper's lease (renewed as its fleet would)
function otherSweeps(w: World) {
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner B', at: w.clock.now(), remote: null }))
}
// The clock moved in steps of 1 s, the other sweeper renewing its lease every 20 s
async function run(w: World, ms: number) {
  for (let left = ms; left > 0; left -= 1000) {
    await w.clock.advance(Math.min(left, 1000))
    await w.clock.settle()
    if (w.clock.now() % 20000 < 1000) otherSweeps(w)
  }
}
function land(w: World, path: string, text: string, n: number) {
  const before = w.files.get(`${ROOT}/${path}`) ?? ''
  w.touch(`${ROOT}/${path}`, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${n}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path, from: hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'Owner B' } }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}
const spend = (slug: string, usd: number) => JSON.stringify({ format: 1, slug, day: DAY, usd, last: usd, sessionId: slug === 'owner-b' ? B_SID : SID, at: Date.UTC(2026, 10, 2, 11, 0, 0) })

async function instance($: any, on: any, opts: { files?: Record<string, string>; roster?: string; cost?: { value: number } } = {}) {
  const cost = opts.cost ?? { value: 0.25 }
  const w = world(on, {
    worldPaths: ['notes/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: {
      [`${FLEET}/roster.json`]: opts.roster ?? roster(),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/seeds/owner.md`]: 'Read the charter, then plan your part ({name}).',
      [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n',
      [`${ROOT}/notes/a.md`]: 'a\n',
      ...opts.files,
    },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: cost.value } } }))
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a9' }))
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  otherSweeps(w)
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  return w
}
const reads = (w: World, path: string) => w.readCount.get(path) ?? 0
async function untilRead(w: World, path: string) {
  const n = reads(w, path)
  for (let i = 0; i < 120 && reads(w, path) === n; i++) await run(w, 1000)
}

// ---- 1: the project's budget used up by another instance's spend: an idle instance is still nudged ----

async function budgetFlow($: any, on: any, crosses: boolean) {
  // The project's cap is $2; each instance's own $10: Owner B's spend alone takes the project over
  const w = await instance($, on, { roster: roster({}, 10, 2), files: { [`${BDIR}/spend.json`]: spend('owner-b', 1) } })
  await run(w, 3000)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  await run(w, 3 * MIN)
  // Just after Owner A's fleet read the spends again
  await untilRead(w, `${BDIR}/spend.json`)
  // Owner B's heartbeat writes its spend: $2.50 today, past the project's $2 (every instance is over)
  if (crosses) w.touch(`${BDIR}/spend.json`, spend('owner-b', 2.5))
  await run(w, 10000)
  const before = w.submits.length
  land(w, 'notes/a.md', 'a, by B\n', 1)
  await $.classic.FileChanged({ file_path: `${FLEET}/events/latest`, event: 'change' } as any)
  await run(w, 30000)
  return w.submits.slice(before).filter(s => s.includes('notes/a.md'))
}
test('1 control: under the project budget, the landing nudges the idle instance', WITH_SESSIONS, async ($, on) => {
  expect((await budgetFlow($, on, false)).length).toBe(1)
})
test('1: the project budget used up by another instance 10 s before: the idle instance is not nudged', WITH_SESSIONS, async ($, on) => {
  expect(await budgetFlow($, on, true)).toEqual([])
})

// ---- 2: an urgent nudge (an item offered, first round) waits past ten minutes after the last nudge ----

test('2: an item offered just after a nudge goes as an urgent nudge within ten minutes of the offer', { ...WITH_SESSIONS, timeoutMs: 120000 }, async ($, on) => {
  const w = await instance($, on, { roster: roster({ wakes: { everyMin: 30, perDay: 8 } }) })
  const times: { at: number; text: string }[] = []
  w.answerSubmit.value = (text: string) => {
    times.push({ at: w.clock.now(), text })
    return { text }
  }
  await run(w, 3000)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  // A landing 20 s past a minute: the digest nudge goes at once (its time isn't the minute's pass)
  await run(w, 2 * MIN + 17000)
  land(w, 'notes/a.md', 'a, by B\n', 1)
  await $.classic.FileChanged({ file_path: `${FLEET}/events/latest`, event: 'change' } as any)
  await run(w, 8000)
  const digest = times.find(t => t.text.includes('notes/a.md'))
  expect(digest).toBeTruthy()
  // The sweeper offers B-4 to it a second later (work.json, round 1: urgent, like an answer)
  await run(w, 1000)
  const offeredAt = w.clock.now()
  w.touch(`${STATE}/work.json`, JSON.stringify({ format: 1, at: offeredAt, unowned: { 'B-4': { for: 'owner', since: offeredAt - MIN, offers: [{ slug: 'owner-a', at: offeredAt }], round: 1 } }, capacity: { idle: ['Owner A'], unowned: 1, oldest: offeredAt - MIN, slotsFree: null, slotsTotal: null, runs: 0, unrecorded: 0, flags: [] } }))
  await run(w, 12 * MIN)
  const offer = times.find(t => t.text.includes('B-4 is open'))
  expect(offer).toBeTruthy()
  // "waits ten minutes at most" (the rule), 5 s of the old tick allowed
  expect((offer as { at: number }).at - offeredAt).toBeLessThanOrEqual(10 * MIN + 5000)
})

// ---- 3: the first /fleet down: the instance taken down is still nudged within 30 s ----

async function downFlow($: any, on: any, down: boolean) {
  const w = await instance($, on)
  await run(w, 3000)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  await run(w, 3 * MIN)
  // Just after its fleet looked for down.json (none yet: nobody was ever taken down here)
  await untilRead(w, `${STATE}/down.json`)
  // The person, in his own session: /fleet down "Owner A" ("fleet won't wake or nudge them")
  if (down) w.touch(`${STATE}/down.json`, JSON.stringify({ format: 1, instances: { 'owner-a': w.clock.now() } }))
  await run(w, 3000)
  const before = w.submits.length
  land(w, 'notes/a.md', 'a, by B\n', 1)
  await $.classic.FileChanged({ file_path: `${FLEET}/events/latest`, event: 'change' } as any)
  await run(w, 20000)
  return w.submits.slice(before).filter(s => s.includes('notes/a.md'))
}
test('3 control: not down, the landing nudges it', WITH_SESSIONS, async ($, on) => {
  expect((await downFlow($, on, false)).length).toBe(1)
})
test('3: taken down (the first down.json of the project) 3 s before: no nudge', WITH_SESSIONS, async ($, on) => {
  expect(await downFlow($, on, true)).toEqual([])
})

// ---- 4: the first lift of the day's budget (lifts.json new): a helper still refused 10 s later ----

test('4: over its budget, the person lifts it in his session (the first lifts.json): a helper 10 s later starts', WITH_SESSIONS, async ($, on) => {
  const cost = { value: 1.1 }
  const w = await instance($, on, { cost })
  await run(w, 3000)
  await run(w, 2 * MIN)
  const refused: any = await $.agent.spawn({ prompt: 'help me' } as any)
  expect(String(refused.deny ?? '')).toContain('no new helper starts')
  // Just after its fleet looked for lifts.json (none yet)
  await untilRead(w, `${STATE}/lifts.json`)
  // /fleet budget "Owner A" +1, typed in the person's session: $2.10 for today
  w.touch(`${STATE}/lifts.json`, JSON.stringify({ format: 1, day: DAY, instances: { 'owner-a': 2.1 } }))
  await run(w, 10000)
  const spawn: any = await $.agent.spawn({ prompt: 'help me' } as any)
  expect(spawn).toMatchObject({ agentId: 'a9' })
})

// ---- 5: the code watch backs off while a repository waits on the person's stamp (no command ran): once he stamps it,
// its first poll waits up to 30 min instead of everyMin ----

test('5: a command repository unstamped 45 min, then stamped: its commands run within everyMin (5 min)', { ...WITH_SESSIONS, timeoutMs: 120000 }, async ($, on) => {
  const now0 = Date.UTC(2026, 10, 2, 12, 0, 0)
  const beat = (name: string, slug: string, ref: string, at: number) => JSON.stringify({ format: 1, instance: name, slug, ref, sessionId: `${ref}-0000-0000-0000-000000000000`, at, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: at, lastLanding: at })
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: JSON.stringify({ rosterFormat: 1, roles: { owner: { agent: 'owner' } }, instances: [{ name: 'Area A', role: 'owner', code: { tools: {} } }] }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/seeds/owner.md`]: 'Take an item.',
      [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], code: { tools: { kind: 'command', changed: ['bash', 'tools/up.sh', '{marker}'], open: ['bash', 'tools/open.sh', '{instance}', '{slug}'] } } }),
      [`${ROOT}/notes/a.md`]: 'a\n',
      [`${ROOT}/tools/up.sh`]: 'echo up\n',
      [`${ROOT}/tools/open.sh`]: 'echo open\n',
      [`${FLEET}/instances/area-a/state.json`]: beat('Area A', 'area-a', 'aaaaaaa1', now0),
    },
  })
  const ran: number[] = []
  w.exec.value = argv => {
    if (argv[0] !== 'bash') return undefined
    ran.push(w.clock.now())
    return { exitCode: 0, stdout: argv[1] === 'tools/up.sh' ? 'src/x.c\tTEST B\t41\n' : '' }
  }
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Area A', 'idle') } })
  await startSession($, w)
  for (let i = 0; i < 90; i++) {
    w.touch(`${FLEET}/instances/area-a/state.json`, beat('Area A', 'area-a', 'aaaaaaa1', w.clock.now()))
    await w.clock.advance(30000)
    await w.clock.settle()
  }
  expect(ran).toEqual([])
  expect(json(w, `${STATE}/code.json`).repos.tools.problem).toBe('its commands run as you: fleet runs them only once you stamp them (/fleet accept checks)')
  // He stamps them now
  expect(await fleet($, 'accept checks')).toContain('Stamped: the code watch tools')
  const stampedAt = w.clock.now()
  for (let i = 0; i < 24 && !ran.length; i++) {
    w.touch(`${FLEET}/instances/area-a/state.json`, beat('Area A', 'area-a', 'aaaaaaa1', w.clock.now()))
    await w.clock.advance(30000)
    await w.clock.settle()
  }
  expect(ran.length).toBeGreaterThan(0)
  expect(ran[0] - stampedAt).toBeLessThanOrEqual(6 * MIN)
})

// ---- 6: a slot given from the line to an idle instance (by another session's release): told within the old 5 s ----

test('6: a slot another session gives to this idle, waiting instance is told within seconds (its lease runs meanwhile)', WITH_SESSIONS, async ($, on) => {
  const SLOTS = `${FLEET}/state/slots/lab`
  const OTHER = { sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner B' }
  const w = await instance($, on, { files: { [`${FLEET}/slots.json`]: JSON.stringify({ slotsFormat: 1, slots: { lab: { count: 1, leaseMin: 30, what: 'the test machine' } } }) } })
  const times: { at: number; text: string }[] = []
  w.answerSubmit.value = (text: string) => {
    times.push({ at: w.clock.now(), text })
    return { text }
  }
  await run(w, 3000)
  const now = w.clock.now()
  w.touch(`${SLOTS}/0.json`, JSON.stringify({ format: 1, slot: 'lab', n: 0, holder: OTHER, at: now - 10 * MIN, until: now + 20 * MIN, why: 'its run' }))
  const r: any = await $.tool.call({ tool: 'mcp__fleet__slot', action: 'take', slot: 'lab', why: 'my run' } as any)
  expect(String(r.result)).toContain("You're number 1 in line")
  await run(w, 2 * MIN + 7000)
  // Owner B releases it: its fleet gives it to the first in line (moves the waiting file, publishes the lease)
  const given = w.clock.now()
  w.files.delete(`${SLOTS}/0.json`)
  w.files.delete(`${SLOTS}/waiting/${REF}.json`)
  w.touch(`${SLOTS}/0.json`, JSON.stringify({ format: 1, slot: 'lab', n: 0, holder: { sessionId: SID, ref: REF, name: 'Owner A' }, at: given, until: given + 30 * MIN, why: 'my run', granted: true }))
  await run(w, 70000)
  const told = times.find(t => t.text.includes('lab is yours now'))
  expect(told).toBeTruthy()
  expect((told as { at: number }).at - given).toBeLessThanOrEqual(6000)
})

// ---- 8: git worktree move (the worktrees folder's time doesn't move): the linked worktrees stay as they were ----

test('8: a linked worktree moved inside the project is known within ten minutes', WITH_SESSIONS, async ($, on) => {
  let where = `${ROOT}/wt/area-a`
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { [`${ROOT}/notes/a.md`]: 'a\n', [`${ROOT}/.git/worktrees/area-a/gitdir`]: `${ROOT}/wt/area-a/.git\n`, [`${ROOT}/wt/area-a/.git`]: `gitdir: ${ROOT}/.git/worktrees/area-a\n` } })
  w.exec.value = argv => {
    if (argv[0] !== 'git') return undefined
    if (argv.includes('rev-parse')) return { exitCode: 0, stdout: `${ROOT}\n${ROOT}/.git\n${ROOT}/.git\n` }
    if (argv.includes('worktree')) return { exitCode: 0, stdout: `worktree ${ROOT}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n\nworktree ${where}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/area-a\n\n` }
    return { exitCode: 0, stdout: '' }
  }
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup' } as any)
  await run(w, 2 * MIN)
  expect(await fleet($, 'status')).toContain(`worktrees: 1 linked (${ROOT}/wt/area-a)`)
  // git worktree move wt/area-a wt/area-b: the folder moves, and git rewrites .git/worktrees/area-a/gitdir in place
  w.files.delete(`${ROOT}/wt/area-a/.git`)
  w.dirs.delete(`${ROOT}/wt/area-a`)
  w.touch(`${ROOT}/wt/area-b/.git`, `gitdir: ${ROOT}/.git/worktrees/area-a\n`)
  w.touch(`${ROOT}/.git/worktrees/area-a/gitdir`, `${ROOT}/wt/area-b/.git\n`)
  where = `${ROOT}/wt/area-b`
  // (the list is read again at least every 10 minutes, whatever the folder's time says)
  await run(w, 11 * MIN)
  expect(await fleet($, 'status')).toContain(`worktrees: 1 linked (${ROOT}/wt/area-b)`)
})

// ---- 7: a background command's text reaches the heartbeat (what a restart reads back) within the old 30 s ----

test('7: a background command an instance starts is in its heartbeat within 35 s (a restart reads it back from there)', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await run(w, 3000)
  await run(w, 2 * MIN)
  // Just after a heartbeat
  const hb = () => w.files.get(`${HB}/state.json`) ?? ''
  const was = hb()
  for (let i = 0; i < 90 && hb() === was; i++) await run(w, 1000)
  await run(w, 1000)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'make sim > sims/log 2>&1', run_in_background: true } as any)
  expect(r.result.backgroundTaskId).toBe('bash-1')
  await run(w, 35000)
  expect(JSON.parse(hb()).bg).toEqual([{ command: 'make sim > sims/log 2>&1', at: expect.any(Number) }])
})
