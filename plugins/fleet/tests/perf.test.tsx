import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { codeEveryMs } from '../hooks/code'
import { BAND, FAKE_LOG, FLEET, REF, ROOT, SID, fleet, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'
import { OWNER, PROJECT } from './up.test'

// fleet's steady pace (0.10.1): what an idle session reads, lists and runs a minute, and that what it acts on comes no
// later than before. Each count below was several times higher before (the nudges every 5 s, the world every 2 s, the
// overrules listed every 2 s, git twice a minute everywhere, the heartbeat every 30 s)

const MIN = 60000
const HB = `${FLEET}/instances/owner-a`
const STATE = `${FLEET}/state`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }

// In steps of a minute at most: one long advance fires thousands of timers at once
async function tick(w: World, ms = 2100) {
  for (let left = ms; left > 0; left -= MIN) {
    await w.clock.advance(Math.min(left, MIN))
    await w.clock.settle()
  }
}

function calls(w: World, kind: string): any[] {
  return (w.files.get(FAKE_LOG) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(c => c[kind])
    .map(c => c[kind])
}

const GIT = (argv: string[]) => {
  if (argv[0] !== 'git') return undefined
  if (argv.includes('rev-parse')) return { exitCode: 0, stdout: `${ROOT}\n${ROOT}/.git\n${ROOT}/.git\n` }
  if (argv.includes('worktree')) return { exitCode: 0, stdout: `worktree ${ROOT}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n\n` }
  return { exitCode: 0, stdout: '' }
}

// Another session holds the sweeper's lease (renewed as its fleet would)
function otherSweeps(w: World) {
  w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: B_SID, ref: 'bbbbbbbb', name: 'Owner B', at: w.clock.now(), remote: null }))
}

async function instance($: any, on: any, files: Record<string, string> = {}) {
  const w = world(on, { worldPaths: ['notes/**', 'journals/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' }, files: { ...PROJECT, [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n', [`${ROOT}/notes/a.md`]: 'a\n', ...files } })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.25 } } }))
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  w.exec.value = GIT
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  return w
}

// Owner B lands a change to a shared file, as its fleet would: the file, its event, events/latest
function land(w: World, path: string, text: string, n: number) {
  const before = w.files.get(`${ROOT}/${path}`) ?? ''
  w.touch(`${ROOT}/${path}`, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${n}.json`
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path, from: hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'Owner B' } }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}

const count = (m: Map<string, number>, path: string) => m.get(path) ?? 0
const mvTo = (w: World, path: string) => w.runs.filter(a => a[0] === 'mv' && a[a.length - 1] === path).length

test('an idle instance looks at its nudges once a minute: work.json a few times, its journal not at all while no fresh period is due', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, { [`${ROOT}/journals/owner-a.md`]: `# journal\n${'x'.repeat(20000)}\n` })
  await tick(w, 3 * MIN)
  w.readCount.clear()
  await tick(w, 10 * MIN)
  // (every 5 s, two reads a look: about 240 in ten minutes)
  expect(count(w.readCount, `${STATE}/work.json`)).toBeLessThanOrEqual(40)
  expect(count(w.readCount, `${ROOT}/journals/owner-a.md`)).toBe(0)
})

test('a landing the watcher brings still reaches an idle instance within seconds, as when it looked every 5 s', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await tick(w)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  await tick(w, 2 * MIN)
  const before = w.submits.length
  land(w, 'notes/a.md', 'a, by B\n', 1)
  await $.classic.FileChanged({ file_path: `${FLEET}/events/latest`, event: 'change' } as any)
  await tick(w, 6000)
  expect(w.submits.length).toBe(before + 1)
  expect(w.submits.at(-1)).toContain('- notes/a.md: changed at')
})

test('an instance writes its heartbeat once a minute (each one an mv), not every 30 s', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await tick(w, 2 * MIN)
  const before = mvTo(w, `${HB}/state.json`)
  await tick(w, 10 * MIN)
  const beats = mvTo(w, `${HB}/state.json`) - before
  expect(beats).toBeGreaterThanOrEqual(9)
  expect(beats).toBeLessThanOrEqual(11)
})

test('the overrules folder, missing, is listed every half a minute, not every 2 s; the runs folder too', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await tick(w, 2 * MIN)
  const at = w.lists.length
  await tick(w, 10 * MIN)
  const listed = w.lists.slice(at)
  expect(listed.filter(p => p === `${FLEET}/decisions/overrules`).length).toBeLessThanOrEqual(22)
  expect(listed.filter(p => p === `${FLEET}/runs`).length).toBeLessThanOrEqual(22)
  // ... and one this session writes in is seen at once (a run it declares)
  const r: any = await $.tool.call({ tool: 'mcp__fleet__run', action: 'declare', what: 'a sim', done: 'sims/a/done' } as any)
  expect(r.result).toContain('run-1')
  const mine: any = await $.tool.call({ tool: 'mcp__fleet__run', action: 'list' } as any)
  expect(mine.result).toContain('run-1')
})

test("git: the repository's own facts once per process; its worktree list again only when the worktrees folder moves", WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await tick(w, 12 * MIN)
  const revs = () => w.runs.filter(a => a[0] === 'git' && a.includes('rev-parse') && a.includes('--git-common-dir')).length
  const lists = () => w.runs.filter(a => a[0] === 'git' && a.includes('worktree') && a.includes('list')).length
  expect(revs()).toBe(1)
  expect(lists()).toBe(1)
  // A linked worktree added: its folder under .git/worktrees moves the folder's time
  w.touch(`${ROOT}/.git/worktrees/area-a`, 'gitdir\n')
  await tick(w, 70000)
  expect(lists()).toBe(2)
  expect(revs()).toBe(1)
})

test('a session that does not sweep looks at the world every 10 s while the watcher brings landings; back to 2 s once it missed two', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT, [`${ROOT}/notes/a.md`]: 'a\n' } })
  w.exec.value = GIT
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { rows: {} })
  otherSweeps(w)
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup' } as any)
  for (let i = 0; i < 6; i++) {
    otherSweeps(w)
    await tick(w, 20000)
  }
  w.statCount.clear()
  for (let i = 0; i < 30; i++) {
    otherSweeps(w)
    await tick(w, 20000)
  }
  // Ten minutes: about 60 looks at world.json (every 2 s, 300)
  expect(count(w.statCount, `${FLEET}/world.json`)).toBeLessThanOrEqual(70)
  // Two landings the watcher never brought: the tick found them a few seconds old
  land(w, 'notes/a.md', 'a, by B\n', 1)
  otherSweeps(w)
  await tick(w, 25000)
  land(w, 'notes/a.md', 'a, by B again\n', 2)
  otherSweeps(w)
  await tick(w, 25000)
  expect(w.logs.join('\n')).toContain("events/latest: the engine's watcher didn't bring two landings; the world is looked at every 2 s")
  w.statCount.clear()
  otherSweeps(w)
  await tick(w, 20000)
  expect(count(w.statCount, `${FLEET}/world.json`)).toBeGreaterThanOrEqual(8)
})

test("a person's session takes the band's restart line from the sweeper's work.json: no status call of its own every 10 s", WITH_SESSIONS, async ($, on) => {
  const work = { format: 1, at: Date.UTC(2026, 10, 2, 12, 0, 0), unowned: {}, capacity: { idle: [], unowned: 0, oldest: null, slotsFree: null, slotsTotal: null, runs: 0, unrecorded: 0, flags: [] }, restart: '2 stopped since a restart: /fleet up --stopped' }
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT, [`${STATE}/work.json`]: JSON.stringify(work) } })
  sessionsSay(w, { rows: {} })
  otherSweeps(w)
  await startSession($, w)
  for (let i = 0; i < 9; i++) {
    otherSweeps(w)
    await tick(w, 20000)
  }
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).toContain('2 stopped since a restart: /fleet up --stopped')
  await ui.unmount()
  expect(calls(w, 'status').length).toBe(0)
})

test("identical marks are sent to sessions again only near their end, not at every sweep", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT } })
  // Owner A runs with no fleet: a mark that stays the same
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  await tick(w, 3 * MIN)
  const at = calls(w, 'setMarks').length
  expect(at).toBeGreaterThan(0)
  await tick(w, 10 * MIN)
  const set = calls(w, 'setMarks')
  // (every sweep, once a minute: 10)
  expect(set.length - at).toBeLessThanOrEqual(5)
  expect(set.at(-1).ttlMs).toBe(300000)
})

test('the classic hooks seen are written once each, not at every FileChanged', WITH_SESSIONS, async ($, on) => {
  let writes = 0
  on('state.set' as any, (_: any, e: any, next: any) => {
    if (JSON.stringify(e).includes('classicSeen')) writes++
    return next(e)
  })
  const w = await instance($, on)
  await tick(w)
  const before = writes
  for (let i = 0; i < 20; i++) await $.classic.FileChanged({ file_path: `${ROOT}/somewhere/${i}`, event: 'change' } as any)
  await tick(w)
  expect(writes - before).toBeLessThanOrEqual(1)
  expect(await fleet($, 'status')).toContain('classic hooks reaching fleet here: FileChanged, SessionStart')
})

test("classic.SessionStart makes the files it watches before it returns them: the inbox's trigger, its folder missing", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, files: { ...PROJECT, [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], intake: { folder: 'inputs/intake' } }) } })
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  // As in the first session after intake was set up elsewhere: neither the trigger nor its folder there yet
  w.files.delete(`${FLEET}/inbox/latest`)
  w.dirs.delete(`${FLEET}/inbox`)
  const r: any = await $.classic.SessionStart({ source: 'startup' } as any)
  expect(r.watchPaths).toContain(`${FLEET}/inbox/latest`)
  expect(w.files.has(`${FLEET}/inbox/latest`)).toBe(true)
  expect(w.files.has(`${FLEET}/events/latest`)).toBe(true)
})

test("a host a run's done-file can't be reached on is asked again later each time (up to 30 min); one that answers, every 2 min", WITH_SESSIONS, async ($, on) => {
  const owner = { name: 'Owner C', slug: 'owner-c', ref: 'ccccccc1', sessionId: 'ccccccc1-0000-0000-0000-000000000000' }
  const w = world(on, {
    background: false,
    files: {
      ...PROJECT,
      [`${FLEET}/outbound.json`]: JSON.stringify({ outboundFormat: 1, hosts: ['dev.example.invalid'], remotes: [], recipients: [], commands: [], outside: [] }),
      [`${FLEET}/runs/run-1.json`]: JSON.stringify({ format: 1, id: 'run-1', at: Date.UTC(2026, 10, 2, 11, 0, 0), owner, what: 'the sim', item: null, host: 'dev.example.invalid', dir: null, done: '/scratch/x/done', log: null }),
    },
  })
  let down = true
  const asked: number[] = []
  w.exec.value = argv => {
    if (argv[0] !== 'ssh') return undefined
    asked.push(w.clock.now())
    return down ? { exitCode: 255, stderr: 'ssh: connect to host dev.example.invalid port 22: Operation timed out' } : { exitCode: 1, stderr: 'cat: /scratch/x/done: No such file or directory' }
  }
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  await tick(w, 40 * MIN)
  // 2, 4, 8 and 16 min apart after the first (every 2 min: 20)
  expect(asked.length).toBeGreaterThanOrEqual(3)
  expect(asked.length).toBeLessThanOrEqual(6)
  expect(w.logs.join('\n')).toContain("runs: dev.example.invalid can't be reached (1 time(s)); asked again in 2 min")
  down = false
  await tick(w, 30 * MIN)
  const n = asked.length
  await tick(w, 10 * MIN)
  expect(asked.length - n).toBeGreaterThanOrEqual(4)
})

test("the code watch's poll after failures: everyMin, doubled for each failure in a row after the first, up to 30 min", () => {
  expect(codeEveryMs(5, null)).toBe(5 * MIN)
  expect(codeEveryMs(5, { ok: true })).toBe(5 * MIN)
  expect(codeEveryMs(5, { ok: false, failures: 1 })).toBe(5 * MIN)
  expect(codeEveryMs(5, { ok: false, failures: 2 })).toBe(10 * MIN)
  expect(codeEveryMs(5, { ok: false, failures: 3 })).toBe(20 * MIN)
  expect(codeEveryMs(5, { ok: false, failures: 9 })).toBe(30 * MIN)
  expect(codeEveryMs(60, { ok: false, failures: 9 })).toBe(60 * MIN)
})

test("an instance's budgets read every instance's spend about once a minute, not 18 times", WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  await tick(w, 2 * MIN)
  w.readCount.clear()
  await tick(w, 10 * MIN)
  expect(count(w.readCount, `${FLEET}/instances/owner-b/spend.json`)).toBeLessThanOrEqual(25)
  expect(OWNER).toContain('mcp__fleet__*')
})
