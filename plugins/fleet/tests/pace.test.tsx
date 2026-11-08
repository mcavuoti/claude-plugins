import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { cadenceNudgeText, cadencePerDayOf, COMPACT_DEFAULTS, effectivePerDay, forecastOf, instancesOf, lintRoster, perDayText, wakeVerdict, wakesOf, type Roster } from '../hooks/roster'
import { FAKE_LOG, FLEET, REF, ROOT, SID, fleet, json, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// The pace and the cost of a fleet: the wakes' real room (everyMin and perDay, perDay null for no daily cap), the
// cadence's own cap, the idle compaction, a routine poll, paths an instance watches, roster.json's pin, and a restart
// once an instance is idle

const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, mcp__fleet__*\n---\nYou own a part of the notes.\n'
const HB = `${FLEET}/instances/owner-a`
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }
const HOUR = 3600000
const MIN = 60000

function roster(role: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    rosterFormat: 1,
    sections: [{ id: 'owners', title: 'Owners' }],
    roles: { owner: { agent: 'owner', model: 'haiku', budget: { usdDay: 1 }, ...role } },
    instances: [
      { name: 'Owner A', role: 'owner', section: 'owners' },
      { name: 'Owner C', role: 'owner', section: 'owners' },
    ],
    budget: { usdDay: 5 },
    ...extra,
  })
}

// In steps of 5 min at most: one long advance fires thousands of timers at once, past what the kit keeps up with
async function tick(w: World, ms = 2100) {
  for (let left = ms; left > 0; left -= 5 * MIN) {
    await w.clock.advance(Math.min(left, 5 * MIN))
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


// An instance of the roster in its own session (Owner A), its conversation started; tokens: what its context holds
async function instance($: any, on: any, role: Record<string, unknown>, extra: Record<string, unknown> = {}, usage: { tokens?: number } = {}, more: string[] = []) {
  const w = world(on, {
    worldPaths: ['notes/**', 'journals/**', 'board/**'],
    env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' },
    files: { [`${FLEET}/roster.json`]: roster(role, { wakes: { everyMin: 5, perDay: 8 }, ...extra }), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/seeds/owner.md`]: 'Plan your part.', [`${FLEET}/instances/owner-a.json`]: '{}\n' },
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, ...(usage.tokens !== undefined ? { tokens: usage.tokens } : {}) }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  // more: a sessions version to say (an older one than fleet needs), when a test gives one
  const version = more.find(m => /^\d/.test(m))
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') }, ...(version ? { version } : {}) })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  return w
}

// A turn of its conversation, start to end (it's idle from its end)
let turns = 0
async function turn($: any, w: World) {
  const id = `t-${++turns}`
  await $.turn.start({ text: 'work', turnId: id })
  await w.clock.settle()
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: id, reason: 'answer' } as any)
  await w.clock.settle()
}

// A landing under the shared files, as fleet records it: the file, its event (events/<hour>/<at>-<id>.json), then
// events/latest rewritten
function landing(w: World, path: string, at: number, by: { sessionId: string; ref: string; name: string }, n = 1) {
  w.touch(`${ROOT}/${path}`, path)
  w.touch(`${FLEET}/events/${hourFolder(at)}/${at}-bbbbbbbb-${n}.json`, JSON.stringify({ format: 1, at, path, from: null, to: hashText(path), via: 'tool', tool: 'Write', blind: false, by: { ...by, agentId: null } }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: `${at}-bbbbbbbb-${n}.json` }))
}
const OTHER = { sessionId: 'cccccccc-0000-0000-0000-000000000000', ref: 'ccccccc1', name: 'Owner C' }

// A running or retired instance's heartbeat, as the sweeper reads it
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
function beat(name: string, slug: string, ref: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ format: 1, instance: name, slug, ref, sessionId: `${ref}-0000-0000-0000-000000000000`, at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: NOW - 3 * HOUR, lastLanding: NOW - 10 * MIN, ...extra })
}

// ---- The roster's knobs ----

test('the wakes a day hold: perDay, and no more than one every everyMin allows; perDay null has no daily cap', async () => {
  const r = (wakes: unknown): Roster => JSON.parse(roster({}, { wakes }))
  expect(wakesOf(r({ everyMin: 30, perDay: null }))).toEqual({ everyMin: 30, perDay: Infinity })
  expect(wakesOf(r({ everyMin: 30 }))).toEqual({ everyMin: 30, perDay: 8 })
  expect(effectivePerDay({ everyMin: 240, perDay: 8 })).toBe(6)
  expect(effectivePerDay({ everyMin: 20, perDay: Infinity })).toBe(72)
  expect(effectivePerDay({ everyMin: 5, perDay: 8 })).toBe(8)
  expect(perDayText(Infinity)).toBe('no cap')
  expect(perDayText(8)).toBe('8')
  // No daily cap: only the gap between wakes holds one
  expect(wakeVerdict({ day: '2026-11-02', count: 500, last: 0 }, 0, 30 * MIN, '2026-11-02', { everyMin: 20, perDay: Infinity }, false)).toBe('ok')
  expect(wakeVerdict({ day: '2026-11-02', count: 8, last: 0 }, 0, 30 * MIN, '2026-11-02', { everyMin: 20, perDay: 8 }, false)).toBe('cap')
})

test('the forecast counts the wakes a day can hold (B21): a gap of 4 h allows 6 of the 8, and no daily cap the gap’s own', async () => {
  const r = (wakes: unknown): Roster => JSON.parse(roster({}, { wakes }))
  const inst = instancesOf(r({ everyMin: 240, perDay: 8 }))
  const six = forecastOf(inst, { everyMin: 240, perDay: 6 }).wakesUsd
  expect(forecastOf(inst, wakesOf(r({ everyMin: 240, perDay: 8 }))).wakesUsd).toBe(six)
  expect(forecastOf(inst, wakesOf(r({ everyMin: 20, perDay: null }))).wakesUsd).toBe(forecastOf(inst, { everyMin: 20, perDay: 72 }).wakesUsd)
  // Each running one at its own context: the lint's forecast is the plan's (the same sizes)
  const big = lintRoster(r({ everyMin: 5, perDay: 8 }), new Map([['owner', OWNER]]), { 'owner-a': 2000000, 'owner-c': 2000000 })
  expect(big.warnings.some(x => x.startsWith('the wake forecast ('))).toBe(true)
  expect(lintRoster(r({ everyMin: 5, perDay: 8 }), new Map([['owner', OWNER]])).warnings.some(x => x.startsWith('the wake forecast ('))).toBe(false)
})

test('a cadence the wakes can’t carry is a warning in the dry run; the cadence’s own cap is roster.json’s cadence.perDay', async () => {
  const r: Roster = JSON.parse(roster({ cadenceH: 0.25 }, { wakes: { everyMin: 600, perDay: 8 } }))
  expect(lintRoster(r, new Map([['owner', OWNER]])).warnings).toContain('"Owner A": its cadence (every 15 min) asks for up to 3 nudges a day, and the wakes allow 2 (one every 600 min, 8 a day): raise wakes.perDay (null: no daily cap) or lower everyMin')
  const many: Roster = JSON.parse(roster({ cadenceH: 0.25 }, { wakes: { everyMin: 60, perDay: 8 }, cadence: { perDay: 20 } }))
  expect(lintRoster(many, new Map([['owner', OWNER]])).warnings).toContain('"Owner A": its cadence (every 15 min) asks for up to 20 nudges a day, and the wakes allow 8 (one every 60 min, 8 a day): raise wakes.perDay (null: no daily cap) or lower everyMin')
  expect(lintRoster(JSON.parse(roster({ cadenceH: 2 })), new Map([['owner', OWNER]])).warnings.filter(x => x.includes('its cadence'))).toEqual([])
  expect(cadencePerDayOf(null)).toBe(3)
  expect(cadencePerDayOf(many)).toBe(20)
  expect(cadencePerDayOf(JSON.parse(roster({}, { cadence: { perDay: null } })))).toBe(Infinity)
  // While it owns open board items they're its work: no cap
  expect(cadencePerDayOf(many, 2)).toBe(Infinity)
  expect(cadenceNudgeText({ cadenceH: 1, journal: 'journals/a.md' }, 1, [], Infinity)).toMatch(/fleet nudges once each period while nothing lands\.$/)
  expect(cadenceNudgeText({ cadenceH: 1, journal: 'journals/a.md' }, 1, [], 5)).toMatch(/at most 5 a day\.$/)
})

test('the roster gives an instance its watched paths, its pin, its poll and its idle compaction (role, then instance)', async () => {
  const r: Roster = JSON.parse(
    JSON.stringify({
      rosterFormat: 1,
      sections: [{ id: 'owners', title: 'Owners' }],
      roles: { owner: { agent: 'owner', watch: ['board/**', '../out/**'], poll: { everyMin: 20, prompt: ' Check the inbox. ' }, compact: { idleMin: 30 } }, scanner: { agent: 'scanner', compact: false } },
      instances: [
        { name: 'Owner A', role: 'owner', section: 'owners', watch: ['findings/**', 'board/**'], pin: true },
        { name: 'Owner B', role: 'owner', section: 'owners', poll: { everyMin: 0, prompt: 'x' }, compact: false },
        { name: 'Scanner', role: 'scanner', section: 'owners', compact: { minTokens: 100000 } },
        { name: 'Scanner B', role: 'scanner', section: 'owners' },
      ],
    }),
  )
  const [a, b, s, s2] = instancesOf(r)
  expect(a?.watch).toEqual(['board/**', 'findings/**'])
  expect(a?.pin).toBe(true)
  expect(a?.poll).toEqual({ everyMin: 20, prompt: 'Check the inbox.' })
  expect(a?.compact).toEqual({ idleMin: 30, minTokens: COMPACT_DEFAULTS.minTokens })
  expect(b?.pin).toBe(false)
  expect(b?.poll).toBe(null)
  expect(b?.compact).toBe(null)
  expect(s?.watch).toEqual([])
  expect(s?.compact).toEqual({ idleMin: COMPACT_DEFAULTS.idleMin, minTokens: 100000 })
  expect(s2?.compact).toBe(null)
  // Off for the whole roster, on again for one role
  const off: Roster = { ...r, compact: false, roles: { owner: { agent: 'owner', compact: {} }, scanner: { agent: 'scanner' } } } as Roster
  expect(instancesOf(off).map(i => i.compact)).toEqual([COMPACT_DEFAULTS, null, { idleMin: 45, minTokens: 100000 }, null])
})

// ---- An instance's own fleet ----

test('the idle compaction (G22): a large context idle a while is compacted once per idle spell, before the cache runs out', { ...WITH_SESSIONS, timeoutMs: 90000 }, async ($, on) => {
  const compacted: string[] = []
  on('command.run', { command: 'compact' }, () => (compacted.push('x'), { text: '' }))
  const usage = { tokens: 250000 }
  // 45 min by default (the unit tests check it); 10 here
  const w = await instance($, on, { context: 'long', compact: { idleMin: 10 } }, {}, usage)
  await tick(w)
  await turn($, w)
  await tick(w, 8 * MIN)
  expect(compacted).toEqual([])
  await tick(w, 3 * MIN)
  expect(compacted).toEqual(['x'])
  // Once per idle spell
  await tick(w, 20 * MIN)
  expect(compacted).toEqual(['x'])
  expect(json(w, `${HB}/state.json`).compactedAt).toBeGreaterThan(0)
  expect(await fleet($, 'status')).toMatch(/context 250k, compacted \d+m ago/)
  // Another spell with a small context: nothing to compact
  usage.tokens = 50000
  await turn($, w)
  await tick(w, 12 * MIN)
  expect(compacted).toEqual(['x'])
  // Another with a large one: again
  usage.tokens = 300000
  await turn($, w)
  await tick(w, 12 * MIN)
  expect(compacted).toEqual(['x', 'x'])
})

test('the idle compaction is off with "compact": false', WITH_SESSIONS, async ($, on) => {
  const compacted: string[] = []
  on('command.run', { command: 'compact' }, () => (compacted.push('x'), { text: '' }))
  const w = await instance($, on, { context: 'long', compact: false }, {}, { tokens: 500000 })
  await tick(w)
  await turn($, w)
  await tick(w, 50 * MIN)
  expect(compacted).toEqual([])
})

test('a routine poll (B13): fleet sends its prompt every everyMin while it’s idle, apart from the wakes’ caps, and keeps when it last did', { ...WITH_SESSIONS, timeoutMs: 60000 }, async ($, on) => {
  const w = await instance($, on, { context: 'long', poll: { everyMin: 20, prompt: 'Check the inbox and file what came.' } }, { wakes: { everyMin: 5, perDay: 1 } })
  await tick(w)
  expect(w.submits.length).toBe(1)
  const ctx: any = await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  expect(ctx.additionalContext.join('\n')).toContain("fleet sends you your routine poll every 20 min while you're idle: don't schedule your own with CronCreate.")
  await tick(w, 18 * MIN)
  expect(w.submits.length).toBe(1)
  await tick(w, 3 * MIN)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]?.split('\n\nToday is ')[0]).toBe("fleet: your routine poll (every 20 min, from roster.json; fleet sends it, so don't schedule your own with CronCreate): Check the inbox and file what came.")
  const at = json(w, `${HB}/poll.json`).at
  expect(json(w, `${HB}/poll.json`)).toEqual({ format: 1, at })
  // Its own count: the wakes' cap (1 a day) doesn't hold it
  await tick(w, 21 * MIN)
  await tick(w, 21 * MIN)
  expect(w.submits.filter(s => s.startsWith('fleet: your routine poll')).length).toBe(3)
  await tick(w, 30000)
  expect(json(w, `${HB}/state.json`).lastPoll).toBe(json(w, `${HB}/poll.json`).at)
  expect(await fleet($, 'status')).toMatch(/last poll \d+m ago \(every 20 min\)/)
})

test('watched paths (B6): another session’s change under them nudges a running instance once, its own never does', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, { context: 'long', watch: ['board/**'] })
  await tick(w)
  expect(w.submits.length).toBe(1)
  const ctx: any = await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  expect(ctx.additionalContext.join('\n')).toContain("Changes under board/** reach you as fleet's nudges.")
  // Past the wakes' window the seed opened; its own landing: nothing
  await tick(w, 5 * MIN)
  landing(w, 'board/items/B-0.md', w.clock.now(), { sessionId: SID, ref: REF, name: 'Owner A' }, 0)
  await tick(w, MIN)
  expect(w.submits.length).toBe(1)
  // Another's
  const at = w.clock.now()
  landing(w, 'board/items/B-1.md', at, OTHER)
  landing(w, 'notes/elsewhere.md', at, OTHER, 2)
  await tick(w, MIN)
  expect(w.submits.length).toBe(2)
  const text = w.submits[1] ?? ''
  expect(text).toMatch(/^fleet: files you watch \(board\/\*\*\) changed:\n- board\/items\/B-1\.md: changed at \d\d:\d\d by Owner C\n\nThis is a nudge from fleet \(at most one every 5 min, 8 a day\)/)
  expect(text).not.toContain('notes/elsewhere.md')
  // Told once
  await tick(w, 10 * MIN)
  expect(w.submits.length).toBe(2)
  // Its heartbeat keeps until when it was told: a woken watcher's next process starts from there
  expect(json(w, `${HB}/state.json`).watchTold).toBeGreaterThan(at)
})

test('the cadence’s cap is roster.json’s cadence.perDay', { ...WITH_SESSIONS, timeoutMs: 60000 }, async ($, on) => {
  const w = await instance($, on, { cadenceH: 0.25, context: 'long' }, { cadence: { perDay: 1 } })
  await tick(w)
  for (let k = 0; k < 4; k++) await tick(w, 8 * MIN)
  const nudges = w.submits.filter(s => s.includes('since you last landed anything'))
  expect(nudges.length).toBe(1)
  expect(nudges[0]?.split('\n\nToday is ')[0]).toMatch(/fleet nudges once each period while nothing lands, at most 1 a day\.$/)
  for (let k = 0; k < 4; k++) await tick(w, 8 * MIN)
  expect(w.submits.filter(s => s.includes('since you last landed anything')).length).toBe(1)
})

test('a restart once idle (G15): it waits for a minute idle, then asks sessions to restart it; queued and not carried out, it asks again after 5 min', { ...WITH_SESSIONS, timeoutMs: 60000 }, async ($, on) => {
  const w = await instance($, on, { context: 'long' }, {}, {}, ['restart'])
  await tick(w)
  await turn($, w)
  await tick(w, 5000)
  // /fleet up --restart-when-idle wrote it (after this process started)
  w.touch(`${HB}/restart.json`, JSON.stringify({ format: 1, at: w.clock.now() }))
  await tick(w, 45000)
  expect(calls(w, 'restart')).toEqual([])
  await tick(w, 20000)
  expect(calls(w, 'restart')).toEqual([{ ref: REF, reason: 'fleet: its settings changed (restart when idle)' }])
  await tick(w, 4 * MIN)
  expect(calls(w, 'restart').length).toBe(1)
  expect(json(w, `${HB}/state.json`).restartWait).toBe(undefined)
  // Queued, and still this process 5 min later: sessions dropped it (a turn started in between); asked again
  await tick(w, 2 * MIN)
  expect(calls(w, 'restart').length).toBe(2)
  // Asked by name with its settings unchanged: the reason says so
  w.touch(`${HB}/restart.json`, JSON.stringify({ format: 1, at: w.clock.now(), named: true }))
  await tick(w, 10000)
  expect(calls(w, 'restart').at(-1)).toEqual({ ref: REF, reason: 'fleet: restart asked (/fleet up --restart-when-idle)' })
})

test('a restart sessions refuses (a window not opened with ccc) is asked again after 2 min, once the cause may be gone; status says why it waits, once', { ...WITH_SESSIONS, timeoutMs: 60000 }, async ($, on) => {
  const w = await instance($, on, { context: 'long' }, {}, {}, ['restart'])
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') }, refuseRestart: 'a window that wasn’t opened with ccc shows "Owner A": it wouldn’t come back by itself after the restart; u in the panel restarts it' })
  await tick(w)
  await turn($, w)
  w.touch(`${HB}/restart.json`, JSON.stringify({ format: 1, at: w.clock.now() }))
  await tick(w, 70000)
  expect(calls(w, 'restart').length).toBe(1)
  await tick(w, 30000)
  const wait = json(w, `${HB}/state.json`).restartWait
  expect(wait).toBe('sessions: a window that wasn’t opened with ccc shows "Owner A": it wouldn’t come back by itself after the restart; fleet asks again in 2 min (u in the panel restarts it now)')
  expect(await fleet($, 'status')).toContain(`restart pending (${wait})`)
  // The window closed: the next ask, 2 min after the refusal, goes through
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  await tick(w, 30000)
  expect(calls(w, 'restart').length).toBe(1)
  await tick(w, 70000)
  expect(calls(w, 'restart').length).toBe(2)
  await tick(w, 10000)
  expect(json(w, `${HB}/state.json`).restartWait).toBe(undefined)
})

test('a restart once idle with a sessions older than fleet needs: its heartbeat says what to update, and nothing is asked', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, { context: 'long' }, {}, {}, ['0.16.3'])
  await tick(w)
  await turn($, w)
  w.touch(`${HB}/restart.json`, JSON.stringify({ format: 1, at: w.clock.now() }))
  await tick(w, 2 * MIN)
  expect(json(w, `${HB}/state.json`).restartWait).toBe('fleet needs sessions 0.18.0 or later (0.16.3 here): update it (claude plugin update sessions@mcavuoti) and restart (u)')
  expect(calls(w, 'restart')).toEqual([])
  // A restart.json older than this process: carried out already
  w.touch(`${HB}/restart.json`, JSON.stringify({ format: 1, at: 1 }))
  await tick(w, MIN)
  expect(json(w, `${HB}/state.json`).restartWait).toBe(undefined)
})

// ---- The sweeper ----


test('the sweeper wakes a retired instance once for changes under the paths it watches, never for its own', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    worldPaths: ['notes/**', 'board/**'],
    files: {
      [`${FLEET}/roster.json`]: roster({ watch: ['board/**'] }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/instances/owner-c/state.json`]: beat('Owner C', 'owner-c', 'ccccccc1', { at: NOW - HOUR }),
    },
  })
  sessionsSay(w, { rows: { ccccccc1: { ...row('ccccccc1', 'Owner C', 'stopped'), stopped: 'idle' } } })
  await startSession($, w)
  landing(w, 'board/items/B-1.md', NOW - 30 * MIN, { sessionId: 'ccccccc1-0000-0000-0000-000000000000', ref: 'ccccccc1', name: 'Owner C' })
  await tick(w, 61000)
  expect(calls(w, 'wake')).toEqual([])
  landing(w, 'board/items/B-2.md', w.clock.now(), { sessionId: 'aaaaaaa1-0000-0000-0000-000000000000', ref: 'aaaaaaa1', name: 'Owner A' }, 2)
  await tick(w, 61000)
  expect(calls(w, 'wake')).toEqual([{ ref: 'ccccccc1', reason: 'fleet: files it watches changed' }])
  for (let k = 0; k < 3; k++) await tick(w, 61000)
  expect(calls(w, 'wake').length).toBe(1)
  expect(json(w, `${FLEET}/state/wakes.json`).instances['owner-c'].watchFor).toBeGreaterThan(NOW)
})

test('the sweeper marks a poll twice overdue, and the brief says so', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: roster({ poll: { everyMin: 20, prompt: 'Check the inbox.' } }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/instances/owner-a/state.json`]: beat('Owner A', 'owner-a', 'aaaaaaa1', { lastPoll: NOW - 50 * MIN }),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  w.touch(`${FLEET}/instances/owner-a/state.json`, beat('Owner A', 'owner-a', 'aaaaaaa1', { at: w.clock.now(), lastPoll: NOW - 50 * MIN }))
  await tick(w, 30000)
  const marks = calls(w, 'setMarks')
  expect(marks[marks.length - 1]?.rows.aaaaaaa1).toEqual({ badge: '⏲', tint: 'warning', line: 'poll overdue: last 50m ago (every 20 min)' })
  expect(await fleet($, 'status')).toMatch(/last poll 5\dm ago \(every 20 min\): overdue/)
  expect(await fleet($, 'brief')).toMatch(/\n   - Owner A: its routine poll is overdue \(every 20 min; last 5\dm ago\)\n/)
})

test('roster.json’s pin (5a): the sweeper asks sessions to pin a running instance once; a sessions without pin is said in status', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: roster({ pin: true }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/instances/owner-a/state.json`]: beat('Owner A', 'owner-a', 'aaaaaaa1'),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  for (let k = 0; k < 3; k++) {
    w.touch(`${FLEET}/instances/owner-a/state.json`, beat('Owner A', 'owner-a', 'aaaaaaa1', { at: w.clock.now() }))
    await tick(w, 30000)
  }
  expect(calls(w, 'pin')).toEqual([{ ref: 'aaaaaaa1', pinned: true, reason: 'fleet: roster.json pins it' }])
  expect(await fleet($, 'status')).toContain('pinned')
  expect(json(w, `${FLEET}/state/pinned.json`)).toEqual({ format: 1, refs: ['aaaaaaa1'] })
  // The roster no longer pins it: the pin fleet asked for is undone, once (sessions leaves one the person made)
  w.touch(`${FLEET}/roster.json`, roster({}))
  for (let k = 0; k < 3; k++) {
    w.touch(`${FLEET}/instances/owner-a/state.json`, beat('Owner A', 'owner-a', 'aaaaaaa1', { at: w.clock.now() }))
    await tick(w, 30000)
  }
  expect(calls(w, 'pin')).toEqual([
    { ref: 'aaaaaaa1', pinned: true, reason: 'fleet: roster.json pins it' },
    { ref: 'aaaaaaa1', pinned: false, reason: 'fleet: roster.json no longer pins it' },
  ])
  expect(json(w, `${FLEET}/state/pinned.json`)).toEqual({ format: 1, refs: [] })
})

test('roster.json’s pin with a sessions older than fleet needs: /fleet status says what to update', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: roster({ pin: true }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/instances/owner-a/state.json`]: beat('Owner A', 'owner-a', 'aaaaaaa1'),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') }, version: '0.16.3' })
  await startSession($, w)
  w.touch(`${FLEET}/instances/owner-a/state.json`, beat('Owner A', 'owner-a', 'aaaaaaa1', { at: w.clock.now() }))
  await tick(w, 30000)
  expect(calls(w, 'pin')).toEqual([])
  const status = await fleet($, 'status')
  // Without the sessions fleet needs, an instance has no running row: the one line says what to update
  expect(status).toContain('✗ fleet needs sessions 0.18.0 or later (0.16.3 here)')
})

test('/fleet status: the wake cap reached on a running instance, and no daily cap with perDay null (G14)', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: roster({}, { wakes: { everyMin: 30, perDay: 8 } }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/instances/owner-a/state.json`]: beat('Owner A', 'owner-a', 'aaaaaaa1'),
      [`${FLEET}/instances/owner-a/nudges.json`]: JSON.stringify({ format: 1, day: '2026-11-02', count: 8, last: NOW - HOUR }),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  expect(await fleet($, 'status')).toContain('wake cap reached (8/8) until 00:00')
  w.touch(`${FLEET}/roster.json`, roster({}, { wakes: { everyMin: 30, perDay: null } }))
  await tick(w, 3000)
  const status = await fleet($, 'status')
  expect(status).toContain('no daily wake cap, one every 30 min')
  expect(status).toContain('wakes 8/no cap today')
})

test('/fleet up --restart-when-idle: a running instance whose settings changed restarts once idle; the dry run says how, and flags a big context with nothing to shrink it', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: roster({ compact: false }, { wakes: { everyMin: 240, perDay: 8 } }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/instances/owner-a/state.json`]: beat('Owner A', 'owner-a', 'aaaaaaa1', { settingsHash: 'h0000000', contextTokens: 350000 }),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: row('aaaaaaa1', 'Owner A', 'idle') } })
  await startSession($, w)
  const dry = await fleet($, 'up --dry-run')
  expect(dry).toContain('its settings would be rewritten: u restarts it with them, or /fleet up --restart-when-idle restarts it once idle')
  expect(dry).toContain('each instance at most 6 a day: one every 240 min, 8 a day;')
  expect(dry).toContain("  ! Owner A: context 350k with nothing to shrink it: each wake reloads it (roster.json's compact, or settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)")
  expect(w.files.has(`${HB}/restart.json`)).toBe(false)
  const up = await fleet($, 'up --restart-when-idle')
  expect(up).toContain('settings rewritten: it restarts with them once idle')
  expect(up).toContain('  Owner A: restarts with its settings once idle (nothing in flight); /fleet status shows what it waits for')
  expect(json(w, `${HB}/restart.json`)).toEqual({ format: 1, at: w.clock.now() })
  // Nothing to restart for one whose settings didn't change
  expect(w.files.has(`${FLEET}/instances/owner-c/restart.json`)).toBe(false)
  // --restart-when-idle starts and wakes nothing: Owner C, never started, is left alone, and the plan's first line says so
  expect(up.split('\n')[0]).toBe("/fleet up for 2 of the roster's 2 instance(s) (--restart-when-idle: restarts running ones once idle; starts and wakes none):")
  expect(up).toContain('Owner C · owner')
  expect(up).toContain('never started: left alone (--restart-when-idle restarts running ones only; /fleet up starts it)')
  expect(calls(w, 'start')).toEqual([])
})

// ---- 0.9.0's review: the polls' cost, a retired poller, fleet's own compaction, a change already told ----

test('the forecast prices the routine polls (1440 / everyMin turns a day at the instance’s context); a poll before the idle compaction’s wait is a warning', async () => {
  const r: Roster = JSON.parse(roster({ poll: { everyMin: 20, prompt: 'Check the inbox.' } }, { wakes: { everyMin: 60, perDay: 8 } }))
  const inst = instancesOf(r)
  const f = forecastOf(inst, wakesOf(r))
  expect(f.polls).toBe(144)
  expect(f.pollsUsd).toBeGreaterThan(0)
  // Each a turn at the instance's context, like a wake: 72 a day each cost what 72 wakes would
  const none = forecastOf(instancesOf(JSON.parse(roster({}, { wakes: { everyMin: 60, perDay: 8 } }))), wakesOf(r))
  expect(none.pollsUsd).toBe(0)
  expect(f.wakesUsd).toBe(none.wakesUsd)
  expect(Math.round(f.pollsUsd * 1e6)).toBe(Math.round(forecastOf(inst, { everyMin: 20, perDay: 72 }).wakesUsd * 1e6))
  const lint = lintRoster(r, new Map([['owner', OWNER]]))
  expect(lint.warnings).toContain('"Owner A": its poll (every 20 min) comes before its idle compaction\'s wait (45 min), so it never idle-compacts and each poll reopens its whole context: a longer poll, or a shorter compact.idleMin')
  // Over half the project's budget with the polls in
  const big = lintRoster(r, new Map([['owner', OWNER]]), { 'owner-a': 2000000, 'owner-c': 2000000 })
  expect(big.warnings.find(x => x.startsWith('the wake forecast ('))).toMatch(/of it the routine polls\) is over half the project's budget$/)
})

test('/fleet up --dry-run and /fleet status say the polls’ cost', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: { [`${FLEET}/roster.json`]: roster({ poll: { everyMin: 30, prompt: 'Check the inbox.' } }), [`${ROOT}/.claude/agents/owner.md`]: OWNER },
  })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  const dry = await fleet($, 'up --dry-run')
  expect(dry).toMatch(/; routine polls about \$[\d.]+ a day \(96 turns a day, on their own count, apart from the wakes' caps\)/)
  expect(dry).toMatch(/Owner A · .*, polls ~\$[\d.]+\/day \(48 a day\)/)
  expect(await fleet($, 'status')).toMatch(/; routine polls ~\$[\d.]+ a day \(96 turns a day, apart from the wakes' caps\)/)
  expect(await fleet($, 'brief')).toMatch(/wakes ~\$[\d.]+ a day, routine polls ~\$[\d.]+ a day/)
})

test('a retired instance whose routine poll is due is woken for it, on the poll’s own count (past the wakes’ cap), once per poll due; status and the brief say an overdue poll of a retired one', WITH_SESSIONS, async ($, on) => {
  const w = world(on, {
    background: false,
    files: {
      [`${FLEET}/roster.json`]: roster({ poll: { everyMin: 20, prompt: 'Check the inbox.' } }, { wakes: { everyMin: 5, perDay: 1 } }),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${FLEET}/instances/owner-a/state.json`]: beat('Owner A', 'owner-a', 'aaaaaaa1', { at: NOW - 60 * MIN, lastPoll: NOW - 50 * MIN }),
      [`${FLEET}/instances/owner-a/poll.json`]: JSON.stringify({ format: 1, at: NOW - 50 * MIN }),
      [`${FLEET}/state/wakes.json`]: JSON.stringify({ format: 1, day: '2026-11-02', instances: { 'owner-a': { day: '2026-11-02', count: 1, last: NOW - 3 * HOUR } } }),
    },
  })
  sessionsSay(w, { rows: { aaaaaaa1: { ...row('aaaaaaa1', 'Owner A', 'stopped'), stopped: 'idle' } } })
  await startSession($, w)
  // Overdue (none in two of its periods) while retired: status and the brief say so
  const status = await fleet($, 'status')
  expect(status).toContain('retired for being idle')
  expect(status).toMatch(/last poll 50m ago \(every 20 min\): overdue/)
  expect(await fleet($, 'brief')).toMatch(/\n   - Owner A: its routine poll is overdue \(every 20 min; last 50m ago\)\n/)
  await tick(w, 61000)
  expect(calls(w, 'wake')).toEqual([{ ref: 'aaaaaaa1', reason: 'fleet: its routine poll is due (every 20 min)' }])
  // Not counted among the wakes, and not again for the same poll
  expect(json(w, `${FLEET}/state/wakes.json`).instances['owner-a']).toMatchObject({ count: 1, pollFor: NOW - 50 * MIN })
  for (let k = 0; k < 3; k++) await tick(w, 61000)
  expect(calls(w, 'wake').length).toBe(1)
})

test('fleet’s own idle compaction with a run in flight: no nudge of its own; the instance hears it at its next step, with nothing about a restart', { ...WITH_SESSIONS, timeoutMs: 90000 }, async ($, on) => {
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'the summary', toolUses: [] }] }))
  on('command.run', { command: 'compact' }, async () => {
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'a long talk', toolUses: [] }] } as any)
    return { text: '' }
  })
  const w = await instance($, on, { context: 'long', compact: { idleMin: 10 } }, {}, { tokens: 250000 })
  w.touch(`${FLEET}/runs/run-1.json`, JSON.stringify({ format: 1, id: 'run-1', at: w.clock.now(), owner: { name: 'Owner A', slug: 'owner-a', ref: REF, sessionId: SID }, what: 'the long sim', item: null, host: null, dir: 'sims/s1', done: 'sims/s1/done', log: null }))
  await tick(w)
  await turn($, w)
  const before = w.submits.length
  await tick(w, 11 * MIN)
  expect(json(w, `${HB}/state.json`).compactedAt).toBeGreaterThan(0)
  // Idle a while after it: nothing submitted for what was in flight
  await tick(w, 15 * MIN)
  expect(w.submits.slice(before).filter(s => s.includes('in flight'))).toEqual([])
  // Its next step carries it
  const r: any = await $.tool.call({ tool: 'Read', file_path: `${FLEET}/roster.json` } as any)
  const ctx = (r.context ?? []).join('\n')
  expect(ctx).toContain('fleet: your conversation was compacted while these were in flight: your declared runs: run-1 (the long sim). Check their outputs (their logs, their done-files) before going on. Record what finished')
  expect(ctx).not.toContain('survive a restart')
})

test('a retired instance told of a change it chose to leave isn’t woken for it again (told is caught up); an untold one is', WITH_SESSIONS, async ($, on) => {
  const C_SID = 'ccccccc1-0000-0000-0000-000000000000'
  const reads = (told: boolean) => JSON.stringify({ format: 1, sessionId: C_SID, ref: 'ccccccc1', name: 'Owner C', at: NOW - HOUR, threads: { main: { 'notes/x.md': { v: hashText('x v1\n'), at: 1, ...(told ? { told: hashText('x v2\n') } : {}) } } } })
  const w = world(on, {
    background: false,
    worldPaths: ['notes/**'],
    files: {
      [`${FLEET}/roster.json`]: roster({}),
      [`${ROOT}/.claude/agents/owner.md`]: OWNER,
      [`${ROOT}/notes/x.md`]: 'x v2\n',
      [`${FLEET}/instances/owner-c/state.json`]: beat('Owner C', 'owner-c', 'ccccccc1', { at: NOW - HOUR }),
      [`${FLEET}/reads/${C_SID}.json`]: reads(true),
    },
  })
  sessionsSay(w, { rows: { ccccccc1: { ...row('ccccccc1', 'Owner C', 'stopped'), stopped: 'idle' } } })
  await startSession($, w)
  for (let k = 0; k < 4; k++) await tick(w, 61000)
  expect(calls(w, 'wake')).toEqual([])
  expect(await fleet($, 'brief')).not.toContain('Owner C read 1 shared file that changed since')
  // Not told: it is woken
  w.touch(`${FLEET}/reads/${C_SID}.json`, reads(false))
  for (let k = 0; k < 2; k++) await tick(w, 61000)
  expect(calls(w, 'wake')).toEqual([{ ref: 'ccccccc1', reason: 'fleet: shared files it read changed' }])
})
