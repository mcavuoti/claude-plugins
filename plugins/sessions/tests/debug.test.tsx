import { expect, test } from 'claude-code/testing'

import { buildReport, bytes, checkHandIn, cleanVersion, correlation, count, driversText, foldProgram, MAX_ACTIONS, MAX_HOLDINGS, median, megabytes, ms, num, pluginSetName, PROGRAMS, REFUSALS, RULES, TERMINALS } from '../hooks/debug/report'
import { NAME, type ReportInput } from '../hooks/debug/types'

// ---- made-up input: placeholders and round numbers only ----

const ID = (n: number) => `${'abcdefghijklmnop'.charAt(n).repeat(8)}-0000-0000-0000-000000000000`
const PID = (n: number) => 100 + n

const session = (n: number, over: Record<string, unknown> = {}) => ({
  sessionId: ID(n),
  pid: PID(n),
  root: '/Users/x/alpha',
  title: `title ${n}`,
  kind: 'regular',
  status: 'idle',
  ageHours: 10,
  plugins: [] as string[],
  ...over,
})

const proc = (over: Record<string, unknown> = {}) => ({
  cpuMs: 600,
  childCpuMs: 0,
  memoryMB: [200, 200],
  memoryKind: 'footprint',
  peakMB: null,
  pssMB: null,
  wakeups: null,
  threads: null,
  gone: false,
  started: {},
  helpers: {},
  transcriptMB: null,
  ...over,
})

const MACHINE = { cores: 8, memoryMB: 16384, freeMB: [4000, 4000], swapUsedMB: [0, 0], pressure: [1, 1], pressureKind: 'level', battery: false }

// A sampler's output for these processes, by session number
const sampler = (processes: Record<number, unknown>, over: Record<string, unknown> = {}) => ({
  format: 1,
  how: 'libproc',
  seconds: 60,
  samples: 120,
  machine: MACHINE,
  processes: Object.fromEntries(Object.entries(processes).map(([n, p]) => [String(PID(Number(n))), p])),
  other: null,
  roles: { terminal: null, service: null },
  unavailable: [] as string[],
  ...over,
})

const action = (over: Record<string, unknown> = {}) => ({
  drivers: ['clock'],
  grows: [] as string[],
  runs: 0,
  ms: 0,
  slowest: 0,
  mostWork: 0,
  work: {},
  failed: {},
  sent: {},
  started: {},
  bytesRead: 0,
  bytesWritten: 0,
  ...over,
})

const TOTALS = { work: {}, failed: {}, sent: {}, started: {}, bytesRead: 0, bytesWritten: 0 }

// A hand-in that counted for one minute
const handIn = (over: Record<string, unknown> = {}) => ({
  format: 1,
  loadedAt: 0,
  from: 1000,
  to: 61000,
  facts: {},
  actions: {},
  totals: TOTALS,
  holdings: {},
  ...over,
})

const input = (over: Record<string, unknown> = {}): ReportInput =>
  ({
    report: 'r-0a0a0a',
    profile: 'perf',
    at: 1_800_000_000_000,
    seconds: 60,
    host: { os: 'macos', osMajor: 26, claude: '2.1.300', plugins: { sessions: '0.21.0', fleet: '0.15.0' } },
    sessions: [],
    sampler: null,
    handIns: {},
    programs: PROGRAMS,
    ...over,
  }) as unknown as ReportInput

// Idle sessions 0…n-1, each with a process, running these plugins and handing in what `meters` gives for it
const fleet = (n: number, plugins: string[], meters: (k: number) => Record<string, unknown> = () => ({}), process: (k: number) => Record<string, unknown> = () => ({})) => {
  const ks = Array.from({ length: n }, (_, k) => k)
  return input({
    sessions: ks.map(k => session(k, { plugins })),
    sampler: sampler(Object.fromEntries(ks.map(k => [k, proc(process(k))]))),
    handIns: Object.fromEntries(ks.map(k => [ID(k), meters(k)])),
  })
}

const lines = (text: string) => text.split('\n')
const lineWith = (text: string, part: string) => lines(text).find(l => l.includes(part)) ?? ''
// The text with every wrapped line joined to the one it continues
const flat = (text: string) => text.replace(/\n +/g, ' ')
const rulesOf = (i: ReportInput) => buildReport(i).report.off.map(o => o.rule)

// ---- numbers ----

test('debug report: the median is the middle value, or the mean of the two in the middle', () => {
  expect(median([])).toBeNull()
  expect(median([7])).toBe(7)
  expect(median([3, 1, 2])).toBe(2)
  expect(median([4, 1, 3, 2])).toBe(2.5)
  // The input is left as it was
  const values = [3, 1, 2]
  median(values)
  expect(values).toEqual([3, 1, 2])
})

test("debug report: a correlation is Pearson's r, and null with fewer than 3 pairs or no spread", () => {
  expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBe(1)
  expect(correlation([1, 2, 3, 4], [8, 6, 4, 2])).toBe(-1)
  expect(Math.abs(correlation([1, 2, 3, 4], [1, -1, -1, 1]) ?? 1) < 1e-12).toBe(true)
  expect(Math.round((correlation([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]) ?? 0) * 100)).toBe(80)
  expect(correlation([1, 2], [1, 2])).toBeNull()
  expect(correlation([], [])).toBeNull()
  expect(correlation([5, 5, 5, 5], [1, 2, 3, 4])).toBeNull()
  expect(correlation([1, 2, 3, 4], [0.1, 0.1, 0.1, 0.1])).toBeNull()
})

test('debug report: numbers print with one decimal under 10, none from 100 on, and a comma every three digits', () => {
  expect(num(0)).toBe('0')
  expect(num(0.04)).toBe('0.0')
  expect(num(2)).toBe('2.0')
  expect(num(2.14)).toBe('2.1')
  expect(num(9.96)).toBe('10')
  expect(num(20.6)).toBe('20.6')
  expect(num(24)).toBe('24')
  expect(num(99.96)).toBe('100')
  expect(num(390.4)).toBe('390')
  expect(num(1260)).toBe('1,260')
  expect(num(1234567)).toBe('1,234,567')
  expect(num(-3.21)).toBe('-3.2')
  expect(count(3)).toBe('3')
  expect(count(0.5)).toBe('0.5')
  expect(megabytes(210)).toBe('210 MB')
  expect(megabytes(1740)).toBe('1.7 GB')
  expect(bytes(512)).toBe('512 B')
  expect(bytes(4096)).toBe('4.0 KB')
  expect(bytes(6.1 * 1024 * 1024)).toBe('6.1 MB')
  // An action under a millisecond reads as 0: when it ran, that's "<1"
  expect(ms(0, true)).toBe('<1')
  expect(ms(0, false)).toBe('0')
  expect(ms(2.5, true)).toBe('2.5')
})

test('debug report: small words: the plugins a process runs, what makes an action run, versions', () => {
  expect(pluginSetName([])).toBe('no plugin')
  expect(pluginSetName(['sessions'])).toBe('sessions only')
  expect(pluginSetName(['sessions', 'fleet'])).toBe('sessions and fleet')
  expect(pluginSetName(['sessions', 'fleet', 'easel'])).toBe('sessions, fleet and easel')
  expect(driversText(['clock'])).toBe('its own timer')
  expect(driversText(['self'])).toBe('its own turns')
  expect(driversText(['person'])).toBe('the person')
  expect(driversText(['peer'])).toBe('another session')
  expect(driversText(['peer', 'self'])).toBe('another session + turns')
  expect(driversText([])).toBe('-')
  expect(cleanVersion('2.1.300')).toBe('2.1.300')
  expect(cleanVersion('0.21.0-beta.1+build')).toBe('0.21.0-beta.1+build')
  expect(cleanVersion('2.1.300 on host.example')).toBe('unknown')
  expect(cleanVersion('v2')).toBe('unknown')
  expect(cleanVersion(undefined)).toBe('unknown')
  expect(PROGRAMS.includes('git') && PROGRAMS.includes('mv') && !PROGRAMS.includes('other')).toBe(true)
  expect(TERMINALS.includes('Terminal') && TERMINALS.includes('gnome-terminal-server')).toBe(true)
})

// ---- what a plugin hands in ----

const FULL = handIn({
  loadedAt: 500,
  partial: 'reloaded',
  facts: { live: 'own-watch', leads: false, rows: 12, sweeper: { label: 'session', key: ID(0) }, role: { label: 'role', key: 'alpha builder' } },
  actions: {
    refresh: action({ drivers: ['peer', 'self'], grows: ['sessions'], runs: 2, ms: 1, slowest: 1, mostWork: 3, work: { read: 6 }, failed: { read: 1 }, bytesRead: 8000 }),
    'landing.chain': action({ drivers: ['peer'], grows: ['landings'], runs: 20 }),
    'sweep.outside': action({ within: 'sweep', runs: 6, ms: 300 }),
    heartbeat: action({ runs: 4, sent: { heartbeat: 4 }, started: { 'mv:heartbeat': 4 }, bytesWritten: 400 }),
  },
  totals: { work: { read: 6, write: 4 }, failed: { read: 1, timeout: 0 }, sent: { heartbeat: 4 }, started: { 'mv:heartbeat': 4, git: 1 }, bytesRead: 8000, bytesWritten: 400 },
  holdings: { list: { grows: ['sessions'], open: [12, 6000], close: [12, 6000] }, timers: { grows: [], open: [5, null], close: [5, null] } },
  project: { landings: { tool: 17, command: 3 }, who: { sweeper: { label: 'session', key: ID(0) }, since: 3 } },
})

test('debug report: a full hand-in is taken, as a copy', () => {
  const checked = checkHandIn(FULL)
  expect(checked.ok).toBe(true)
  if (!checked.ok) return
  expect(checked.handIn).toEqual(FULL)
  expect(checked.handIn === (FULL as unknown)).toBe(false)
  expect(checked.handIn.actions === (FULL.actions as unknown)).toBe(false)
  // The least a hand-in can be
  expect(checkHandIn(handIn()).ok).toBe(true)
  expect(checkHandIn(handIn({ partial: undefined, project: undefined })).ok).toBe(true)
})

test('debug report: a hand-in with anything else is refused whole, with a fixed reason', () => {
  const why = (data: unknown) => {
    const checked = checkHandIn(data)
    return checked.ok ? 'taken' : checked.why
  }
  const withAction = (over: Record<string, unknown>) => handIn({ actions: { refresh: action(over) } })
  const many = (n: number, of: unknown) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i}`, of]))

  // Not a hand-in at all
  for (const data of [null, undefined, 3, 'text', [], [handIn()]]) expect(why(data)).toBe('shape')
  expect(why(handIn({ format: 2 }))).toBe('format')
  expect(why({ ...handIn(), format: '1' })).toBe('format')
  expect(why({})).toBe('format')

  // A part missing, mistyped, or one the format doesn't have
  const { totals: _totals, ...noTotals } = handIn()
  expect(why(noTotals)).toBe('shape')
  expect(why(handIn({ notes: 'alpha' }))).toBe('shape')
  expect(why(handIn({ partial: 'restarted' }))).toBe('shape')
  expect(why(handIn({ facts: [] }))).toBe('shape')
  expect(why(handIn({ actions: { refresh: { ...action(), note: 1 } } }))).toBe('shape')
  expect(why(handIn({ actions: { refresh: { drivers: ['clock'] } } }))).toBe('shape')
  expect(why(withAction({ drivers: 'clock' }))).toBe('shape')
  expect(why(withAction({ grows: 'sessions' }))).toBe('shape')
  expect(why(handIn({ totals: { ...TOTALS, extra: {} } }))).toBe('shape')
  expect(why(handIn({ holdings: { list: { grows: [], open: [1], close: [1, null] } } }))).toBe('shape')
  expect(why(handIn({ holdings: { list: { grows: [], open: [1, null] } } }))).toBe('shape')
  expect(why(handIn({ facts: { rows: null } }))).toBe('shape')
  expect(why(handIn({ project: { landings: 3 } }))).toBe('shape')

  // A key or a word that isn't a name
  expect(why(handIn({ actions: { 'file events': action() } }))).toBe('name')
  expect(why(handIn({ actions: { 'sweep/outside': action() } }))).toBe('name')
  expect(why(handIn({ actions: { Refresh: action() } }))).toBe('name')
  expect(why(handIn({ actions: { ['a'.repeat(49)]: action() } }))).toBe('name')
  expect(why(handIn({ facts: { where: '/Users/x/alpha' } }))).toBe('name')
  expect(why(handIn({ facts: { 'what it is': 1 } }))).toBe('name')
  expect(why(withAction({ grows: ['the sessions'] }))).toBe('name')
  expect(why(withAction({ within: 'a b' }))).toBe('name')
  expect(why(withAction({ work: { 'read file': 1 } }))).toBe('name')
  expect(why(withAction({ started: { '/usr/bin/git': 1 } }))).toBe('name')
  expect(why(handIn({ totals: { ...TOTALS, started: { 'my tool': 1 } } }))).toBe('name')
  expect(why(handIn({ holdings: { 'file cache': { grows: [], open: [1, null], close: [1, null] } } }))).toBe('name')
  expect(why(handIn({ project: { 'on disk': {} } }))).toBe('name')
  expect(why(handIn({ project: { disk: { path: '~/alpha' } } }))).toBe('name')

  // A number that isn't one, isn't finite, or is negative
  expect(why(handIn({ from: '1000' }))).toBe('number')
  expect(why(handIn({ to: Infinity }))).toBe('number')
  expect(why(handIn({ loadedAt: -1 }))).toBe('number')
  expect(why(handIn({ facts: { rows: NaN } }))).toBe('number')
  expect(why(withAction({ runs: -2 }))).toBe('number')
  expect(why(withAction({ ms: null }))).toBe('number')
  expect(why(withAction({ work: { read: '6' } }))).toBe('number')
  expect(why(handIn({ totals: { ...TOTALS, bytesRead: -1 } }))).toBe('number')
  expect(why(handIn({ holdings: { list: { grows: [], open: [1, null], close: [1, -5] } } }))).toBe('number')

  // A driver off the list
  expect(why(withAction({ drivers: ['cron'] }))).toBe('driver')
  expect(why(withAction({ drivers: ['clock', 3] }))).toBe('driver')

  // A label that isn't one
  expect(why(handIn({ facts: { who: { label: 'project', key: 'alpha' } } }))).toBe('label')
  expect(why(handIn({ facts: { who: { label: 'session' } } }))).toBe('label')
  expect(why(handIn({ facts: { who: { label: 'session', key: '' } } }))).toBe('label')
  expect(why(handIn({ facts: { who: { label: 'role', key: 7 } } }))).toBe('label')
  expect(why(handIn({ facts: { who: { label: 'role', key: 'alpha', title: 'beta' } } }))).toBe('label')
  expect(why(handIn({ facts: { who: { label: 'role', key: 'a'.repeat(201) } } }))).toBe('label')

  // Too much of it
  expect(why(handIn({ actions: many(MAX_ACTIONS, action()) }))).toBe('taken')
  expect(why(handIn({ actions: many(MAX_ACTIONS + 1, action()) }))).toBe('too-many-actions')
  const held = { grows: [], open: [1, null], close: [1, null] }
  expect(why(handIn({ holdings: many(MAX_HOLDINGS, held) }))).toBe('taken')
  expect(why(handIn({ holdings: many(MAX_HOLDINGS + 1, held) }))).toBe('too-many-holdings')
  expect(why(handIn({ facts: many(401, 1) }))).toBe('too-many-keys')

  // Something that throws when read is refused like the rest
  const trap = { ...handIn() }
  Object.defineProperty(trap, 'facts', { enumerable: true, get: () => { throw new Error('/Users/x/alpha') } })
  expect(why(trap)).toBe('shape')

  // Every reason above is one of the fixed words, and each is a name
  expect(REFUSALS.every(r => NAME.test(r))).toBe(true)
})

// ---- labels ----

test("debug report: sessions are S1… by pid, projects P1… as they appear, roles R1… the same in every plugin's part", () => {
  const fleetPart = (who: string, role: string) => handIn({ facts: { role: { label: 'role', key: role }, sweeper: { label: 'session', key: who } }, project: { who: { leader: { label: 'session', key: who }, stranger: { label: 'session', key: 'zzzzzzzz-0000-0000-0000-000000000000' } } } })
  const build = (order: number[]) =>
    buildReport(
      input({
        sessions: order.map(n => session(n, { root: n === 1 ? '/Users/x/beta' : '/Users/x/alpha', plugins: ['sessions', 'fleet'] })),
        handIns: {
          [ID(0)]: { sessions: handIn({ facts: { role: { label: 'role', key: 'alpha builder' } } }), fleet: fleetPart(ID(2), 'alpha builder') },
          [ID(1)]: { sessions: handIn({ facts: { role: { label: 'role', key: 'beta reviewer' } } }), fleet: fleetPart(ID(2), 'beta reviewer') },
          [ID(2)]: { sessions: handIn({ facts: { role: { label: 'role', key: 'alpha builder' } } }), fleet: fleetPart(ID(2), 'gamma sweeper') },
        },
      }),
    )
  const { report, key } = build([2, 0, 1])
  expect(report.sessions.map(s => s.id)).toEqual(['S1', 'S2', 'S3'])
  expect(report.sessions.map(s => s.project)).toEqual(['P1', 'P2', 'P1'])
  expect(key).toEqual({
    report: 'r-0a0a0a',
    sessions: {
      S1: { title: 'title 0', sessionId: ID(0), root: '/Users/x/alpha' },
      S2: { title: 'title 1', sessionId: ID(1), root: '/Users/x/beta' },
      S3: { title: 'title 2', sessionId: ID(2), root: '/Users/x/alpha' },
    },
    projects: { P1: '/Users/x/alpha', P2: '/Users/x/beta' },
    roles: { R1: 'alpha builder', R2: 'beta reviewer', R3: 'gamma sweeper' },
  })
  // The same role has the same label in both plugins' parts, and a session named by a plugin has its own
  expect(report.sessions.map(s => s.meters.sessions?.facts.role)).toEqual(['R1', 'R2', 'R1'])
  expect(report.sessions.map(s => s.meters.fleet?.facts.role)).toEqual(['R1', 'R2', 'R3'])
  expect(report.sessions.map(s => s.meters.fleet?.facts.sweeper)).toEqual(['S3', 'S3', 'S3'])
  // A session the list doesn't have is `unknown`, never its id
  expect(report.sessions[0]?.meters.fleet?.project).toEqual({ who: { leader: 'S3', stranger: 'unknown' } })
  // The order the list came in changes nothing
  const again = build([1, 2, 0])
  expect(again.report).toEqual(report)
  expect(again.key).toEqual(key)
  expect(again.plain).toBe(build([0, 1, 2]).plain)
})

test('debug report: the file names a project, a kind, a status and a time by fixed words only', () => {
  const { report } = buildReport(input({ sessions: [session(0, { kind: 'background', status: 'busy' }), session(1, { kind: 'odd one', status: 'paused somewhere', ageHours: -4 })], report: 'report for alpha' }))
  expect(report.sessions.map(s => [s.kind, s.status, s.ageHours])).toEqual([
    ['background', 'busy', 10],
    ['regular', 'stopped', null],
  ])
  expect(report.report).toBe('unknown')
  expect(report.at).toBe('2027-01-15T08:00:00.000Z')
  expect(report.format).toBe(1)
  expect(report.profile).toBe('perf')
})

// ---- programs ----

test('debug report: a program off the list is `other`, with its purpose', () => {
  expect(foldProgram('git', PROGRAMS)).toBe('git')
  expect(foldProgram('mv:heartbeat', PROGRAMS)).toBe('mv:heartbeat')
  expect(foldProgram('alphatool', PROGRAMS)).toBe('other')
  expect(foldProgram('alphatool:checks', PROGRAMS)).toBe('other:checks')
  expect(foldProgram('alphatool:checks:fast', PROGRAMS)).toBe('other:checks:fast')
  expect(foldProgram('git', [])).toBe('other')
  // A purpose that isn't a word's part doesn't go on
  expect(foldProgram('alphatool:some thing', PROGRAMS)).toBe('other')

  const started = { 'mv:heartbeat': 4, alphatool: 2, 'betatool:checks': 1, 'gammatool:checks': 2, other: 1, git: 3 }
  const built = buildReport(
    input({
      sessions: [session(0, { plugins: ['fleet'] })],
      sampler: sampler({ 0: proc({ started: { git: 3, alphatool: 2, 'Beta Tool': 4, other: 1 }, helpers: { node: { count: 1, memoryMB: 10 }, alphatool: { count: 2, memoryMB: 5 }, betatool: { count: 1, memoryMB: 7 } } }) }),
      handIns: { [ID(0)]: { fleet: handIn({ actions: { tick: action({ runs: 1, started }) }, totals: { ...TOTALS, started } }) } },
    }),
  )
  const s = built.report.sessions[0]
  const folded = { 'mv:heartbeat': 4, other: 3, 'other:checks': 3, git: 3 }
  expect(s?.meters.fleet?.totals.started).toEqual(folded)
  expect(s?.meters.fleet?.actions.tick?.started).toEqual(folded)
  expect(s?.process?.started).toEqual({ git: 3, other: 7 })
  expect(s?.process?.helpers).toEqual({ node: { count: 1, memoryMB: 10 }, other: { count: 3, memoryMB: 12 } })
  // Seen against said, by program: the purposes add up
  expect(lineWith(built.plain, '  git  ').trim().split(/\s+/)).toEqual(['git', '3.0', '3.0'])
  expect(lineWith(built.plain, '  other  ').trim().split(/\s+/).slice(0, 3)).toEqual(['other', '7.0', '6.0'])
  expect(lineWith(built.plain, '  other  ')).toContain('<- started around the plugins')
  expect(lineWith(built.plain, '  mv  ').trim().split(/\s+/)).toEqual(['mv', '0', '4.0'])
  // With a list of its own, the report names only what's on it
  const narrow = buildReport(input({ sessions: [session(0)], sampler: sampler({ 0: proc({ started: { git: 3, mv: 1 } }) }), programs: ['mv'] }))
  expect(narrow.report.sessions[0]?.process?.started).toEqual({ other: 3, mv: 1 })
})

// ---- the groups by what runs in the process ----

test('debug report: idle sessions are set side by side by the plugins they run', () => {
  const sets = [[], ['sessions'], ['sessions'], ['sessions', 'fleet'], ['fleet', 'sessions']]
  const cpu = [600, 1200, 2400, 3000, 3600]
  const built = buildReport(
    input({
      sessions: [...sets.map((plugins, k) => session(k, { plugins })), session(5, { status: 'busy', plugins: ['sessions'] })],
      sampler: sampler(Object.fromEntries([...cpu, 30000].map((cpuMs, k) => [k, proc({ cpuMs, memoryMB: [100, 100 + 20 * k], wakeups: { idle: 600 * (k + 1), interrupt: 0 } })]))),
    }),
  )
  const at = lines(built.plain).findIndex(l => l.startsWith('By what runs in the process (idle only)'))
  expect(lines(built.plain)[at]).toContain('wake-ups a second (idle and interrupt)')
  expect(lines(built.plain).slice(at + 1, at + 4).map(l => l.trim().split(/\s{2,}/))).toEqual([
    ['no plugin (1)', '1.0 %', '100 MB', '10'],
    ['sessions only (2)', '3.0 %', '130 MB', '25'],
    ['sessions and fleet (2)', '5.5 %', '170 MB', '45'],
  ])
  expect(lines(built.plain)[at + 4]).toBe('')
  expect(built.plain.includes('to compare with')).toBe(false)

  // With no session without plugins, it says there's none to compare with; Linux counts context switches
  const none = buildReport(
    input({
      host: { os: 'linux', osMajor: null, claude: '2.1.300', plugins: {} },
      sessions: [session(0, { plugins: ['sessions'] })],
      sampler: sampler({ 0: proc({ memoryKind: 'rss', wakeups: { voluntary: 60, involuntary: 60 } }) }),
    }),
  )
  expect(none.plain).toContain('context switches a second (voluntary and involuntary)')
  expect(none.plain).toContain('  no idle session without plugins here to compare with')
  expect(none.plain).toContain('Memory (resident size)')
  expect(none.plain).toContain('Machine: Linux, 8 cores, 16 GB')
})

// ---- CPU, and what the plugins' actions account for ----

test("debug report: of an idle session's CPU, about how much falls inside each plugin's actions", () => {
  const sessionsMs = [3, 6, 9]
  const fleetMs = [20, 24, 40]
  const cpu = [600, 1200, 1800]
  const built = buildReport(
    fleet(
      3,
      ['sessions', 'fleet'],
      k => ({
        sessions: handIn({ actions: { refresh: action({ runs: 2, ms: sessionsMs[k] }) } }),
        fleet: handIn({ actions: { tick: action({ runs: 2, ms: fleetMs[k] }) } }),
      }),
      k => ({ cpuMs: cpu[k], childCpuMs: 60 }),
    ),
  )
  const at = lines(built.plain).findIndex(l => l.startsWith("  of an idle session's"))
  expect(lines(built.plain).slice(at, at + 2)).toEqual(["  of an idle session's 1,200 ms of CPU a minute: about 6.0 ms inside sessions' actions,", "  about 24 ms inside fleet's, the rest outside both"])
  const head = lines(built.plain).findIndex(l => l.startsWith('CPU, of one core'))
  expect(lines(built.plain).slice(head, head + 3).map(l => l.trim().split(/\s{2,}/))).toEqual([
    ['CPU, of one core', 'each (median)', 'all together'],
    ['idle sessions (3)', '2.0 % (1.0 to 3.0)', '6.0 %'],
    ['their helper processes', '0.1 %', '0.3 %'],
  ])
  // Too few sessions for a trend across them: it says so
  expect(lineWith(built.plain, 'across idle sessions')).toContain('too few idle sessions with counts to compare (3; it takes 6)')

  // A hand-in that counted for half the window: its rates are over the time it counted
  const half = buildReport(fleet(1, ['sessions'], () => ({ sessions: handIn({ from: 31000, to: 61000, actions: { refresh: action({ runs: 2, ms: 3 }) } }) })))
  expect(flat(half.plain)).toContain("of an idle session's 600 ms of CPU a minute: about 6.0 ms inside sessions' actions, the rest outside it")

  // Actions under a millisecond read as 0: "<1", not nothing
  const quick = buildReport(fleet(1, ['sessions'], () => ({ sessions: handIn({ actions: { refresh: action({ runs: 40, ms: 0 }) } }) })))
  expect(quick.plain).toContain("about <1 ms inside sessions' actions")
  expect(lineWith(quick.plain, 'refresh ').trim().split(/\s{2,}/).slice(0, 4)).toEqual(['refresh', '40', '<1', '<1'])
  expect(lineWith(quick.plain, 'total ').trim().split(/\s{2,}/)).toEqual(['total', '<1', "ms a minute inside sessions' actions"])
})

test('debug report: across six idle sessions or more, whether CPU rises with the peer actions a session ran', () => {
  const runs = [10, 20, 30, 40, 50, 60]
  const build = (cpu: number[]) => buildReport(fleet(6, ['sessions'], k => ({ sessions: handIn({ actions: { events: action({ drivers: ['peer'], runs: runs[k] }) } }) }), k => ({ cpuMs: cpu[k] })))
  expect(lineWith(build([600, 700, 800, 900, 1000, 1100]).plain, 'across idle sessions')).toContain('CPU rises with the peer actions a session ran (+1.00)')
  expect(lineWith(build([900, 600, 1100, 700, 1000, 800]).plain, 'across idle sessions')).toContain("CPU doesn't rise with the peer actions a session ran (+0.09)")
  expect(lineWith(build([600, 600, 600, 600, 600, 600]).plain, 'across idle sessions')).toContain('no spread between them to compare')
})

// ---- a plugin's table ----

test("debug report: an action that is part of another is printed under it and left out of the plugin's total", () => {
  const part = handIn({
    actions: {
      tick: action({ runs: 2, ms: 4 }),
      sweep: action({ drivers: ['peer', 'clock'], grows: ['sessions', 'files'], runs: 6, ms: 30 }),
      'sweep.outside': action({ grows: ['files'], within: 'sweep', runs: 6, ms: 20, work: { stat: 1480 } }),
      'sweep.checks': action({ within: 'sweep', runs: 6, ms: 6 }),
    },
  })
  const built = buildReport(fleet(1, ['fleet'], () => ({ fleet: part })))
  const table = lines(built.plain)
  const head = table.findIndex(l => l.startsWith('action '))
  expect(table.slice(head + 1, head + 6).map(l => l.split(/\s{2,}/).slice(0, 4))).toEqual([
    ['sweep', '6.0', '5.0', '30'],
    ['', 'sweep.outside', '6.0', '3.3'],
    ['', 'sweep.checks', '6.0', '1.0'],
    ['tick', '2.0', '2.0', '4.0'],
    ['total', '34', "ms a minute inside fleet's actions"],
  ])
  expect(table[head + 2]?.startsWith('  sweep.outside')).toBe(true)
  // Nor in the "about" line, nor in the scaling's runs
  expect(built.plain).toContain("about 34 ms inside fleet's actions")
  expect(lineWith(built.plain, 'with sessions x activity')).toContain('sweep · 6.0 runs a minute across all · x4 if the fleet doubles')
  expect(built.plain).toContain('the rest (1 action)')
})

test("debug report: a plugin's table is the median idle session among those with the same facts", () => {
  const live = (k: number) => (k < 3 ? 'own-watch' : 'timers')
  const built = buildReport(
    fleet(5, ['sessions'], k => ({
      sessions: handIn({
        facts: { live: live(k), leads: false },
        actions: {
          refresh: action({ drivers: ['peer', 'self'], grows: ['sessions'], runs: [2, 4, 6, 60, 60][k], ms: [2, 8, 18, 300, 500][k], mostWork: [3, 9, 212, 1, 1][k], work: { read: 12 * (k + 1), list: 2 * (k + 1), listed: 24 * (k + 1) }, bytesRead: 16384 * (k + 1) }),
          heartbeat: action({ runs: 4, ms: 4, work: { write: 4, command: 4 }, started: { 'mv:heartbeat': 4 }, sent: { heartbeat: 4 }, bytesWritten: 400 }),
          'draw.panel': action({ drivers: ['peer', 'person'] }),
        },
        totals: { work: { read: [10, 20, 30, 1, 1][k], write: 4, list: 1, listed: 25 }, failed: { read: [0, 0, 9, 0, 0][k], lock: 0 }, sent: { heartbeat: 4, store: 1 }, started: { 'mv:heartbeat': 4, git: 1 }, bytesRead: 20480, bytesWritten: 2048 },
        holdings: {
          list: { grows: ['sessions'], open: [25, null], close: [25, null] },
          'file-cache': { grows: ['files'], open: [30, 40960], close: [31 + k, 49152] },
        },
        ...(k === 1 ? { project: { shared: { registry: 25, leader: { label: 'session', key: ID(1) }, live: true } } } : {}),
      }),
    })),
  )
  const p = built.plain
  expect(p).toContain('── sessions: an idle session, per minute ─')
  expect(p).toContain('the median of these 3 of 5: leads=no · live=own-watch')
  const head = lines(p).findIndex(l => l.startsWith('action '))
  expect(lines(p).slice(head, head + 5).map(l => l.trim().split(/\s{2,}/))).toEqual([
    ['action', 'runs', 'ms each', 'ms/min', 'work each run', 'runs because', 'grows with'],
    ['refresh', '4.0', '2.0', '8.0', '6 reads, 1 listing, 8.0 KB', 'another session + turns', 'sessions'],
    ['heartbeat', '4.0', '1.0', '4.0', '1 write, 1 mv', 'its own timer', 'nothing'],
    ['draw.panel', '0', '-', '0', 'another session + person', 'nothing'],
    ['total', '12', "ms a minute inside sessions' actions"],
  ])
  // The other group: its count, the facts that differ and its total
  expect(p).toContain("2 other idle sessions with live=timers: 404 ms a minute inside its actions")
  expect(flat(p)).toContain('work in all, exact: 20 reads (20 KB), 4 writes (2.0 KB), 1 listing (25 entries) a minute · processes started: 5.0 (mv 4.0, git 1.0)')
  expect(p).toContain('failed: 0 lock tries lost · 0 reads (9.0 at most) a minute')
  expect(p).toContain('it sent, for others to react to: 4 heartbeats · 1 store write a minute')
  expect(p).toContain('most work in one run: 212 calls (refresh)')
  expect(p).toContain('it holds, about 48 KB in all: file-cache 32, about 48 KB · list 25')
  expect(p).toContain('grew in this window, at most: file-cache +3 (about +8.0 KB)')
  const at = lines(p).indexOf("shared (the project's part, from S2):")
  expect(lines(p).slice(at + 1, at + 4)).toEqual(['  leader: S2', '  live: yes', '  registry: 25'])

  // With no idle session it's the median of all that handed in, and says so
  const busy = buildReport(input({ sessions: [session(0, { status: 'busy', plugins: ['sessions'] })], handIns: { [ID(0)]: { sessions: handIn({ partial: 'reloaded', loadedAt: 2000 }) } } }))
  expect(busy.plain).toContain('── sessions: a session (none is idle), per minute ─')
  expect(busy.plain).toContain('the median of the one: no facts handed in')
  expect(busy.plain).toContain('counted for part of the window only (reloaded inside it): 1 session')
  expect(busy.plain).toContain('failed: nothing')
})

test('debug report: past 12 actions, the least active fold into "the rest"; no line is wider than 100 columns', () => {
  const actions = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`action.number-${String(i).padStart(2, '0')}`, action({ drivers: ['peer', 'clock'], grows: ['sessions', 'files'], runs: 15 - i, ms: 2 * (15 - i), work: { read: 40, stat: 30, list: 20, listed: 4000, write: 10 }, bytesRead: 1e6 })]))
  const built = buildReport(fleet(3, ['fleet'], () => ({ fleet: handIn({ actions }) })))
  const table = lines(built.plain)
  const head = table.findIndex(l => l.startsWith('action '))
  expect(table.slice(head + 1, head + 13).map(l => l.split(/\s+/)[0])).toEqual(Array.from({ length: 12 }, (_, i) => `action.number-${String(i).padStart(2, '0')}`))
  // Runs 3 + 2 + 1 and ms 6 + 4 + 2 a minute in the three folded; the total is all fifteen
  expect(table[head + 13]?.trim().split(/\s{2,}/)).toEqual(['the rest (3)', '6.0', '12'])
  expect(table[head + 14]?.trim().split(/\s{2,}/)).toEqual(['total', '240', "ms a minute inside fleet's actions"])
  expect(Math.max(...table.map(l => l.length)) <= 100).toBe(true)
  // The work of one run says less where the column is narrow, and all of it where there's room
  expect(table[head + 1]?.split(/\s{2,}/)).toEqual(['action.number-00', '15', '2.0', '30', '2.7 reads', 'another session + timer', 'sessions, files'])
  expect(table[head + 12]?.split(/\s{2,}/)).toEqual(['action.number-11', '4.0', '2.0', '8.0', '10 reads, 244 KB', 'another session + timer', 'sessions, files'])
  const wide = buildReport(fleet(1, ['fleet'], () => ({ fleet: handIn({ actions: { list: action({ runs: 2, ms: 2, work: { list: 2, listed: 24, read: 4, stat: 1 }, bytesRead: 8192 }) } }) })))
  expect(lineWith(wide.plain, 'list  ').trim().split(/\s{2,}/)).toEqual(['list', '2.0', '1.0', '2.0', '2 reads, 1 listing (12), 0.5 stats, 4.0 KB', 'its own timer', 'nothing'])
})

test('debug report: scaling, from what makes each action run', () => {
  const built = buildReport(
    fleet(4, ['sessions', 'fleet'], () => ({
      sessions: handIn({
        actions: {
          events: action({ drivers: ['peer', 'self'], runs: 20 }),
          list: action({ drivers: ['clock'], grows: ['sessions'], runs: 1 }),
          heartbeat: action({ drivers: ['clock'], runs: 4 }),
          command: action({ drivers: ['person'], grows: ['sessions'], runs: 1 }),
        },
      }),
      fleet: handIn({ actions: { 'landing.chain': action({ drivers: ['peer'], grows: ['landings'], runs: 30 }) } }),
    })),
  )
  const at = lines(built.plain).indexOf('Scaling, from what makes each action run:')
  expect(lines(built.plain).slice(at + 1, at + 6)).toEqual([
    '  with sessions x activity   fleet/landing.chain, sessions/events · 200 runs a minute across all ·',
    '                             x4 if the fleet doubles',
    '  with sessions              sessions/list · 4.0 runs a minute across all · x2 if the fleet doubles,',
    '                             each run doing more',
    '  with nothing               the rest (2 actions)',
  ])
})

// ---- "Looks off" ----

// Six sessions whose two readings correlate by exactly r: x apart by 2, and y made of x and of a reading with no
// correlation to it
const X = [-5, -3, -1, 1, 3, 5]
const Z = [5, -1, -4, -4, -1, 5].map(z => z * Math.sqrt(70 / 84))
const withTrend = (r: number, k: number): number => r * (X[k] ?? 0) + Math.sqrt(1 - r * r) * (Z[k] ?? 0)

// One idle session with a process and one hand-in from `sessions`
const one = (meter: Record<string, unknown>, process: Record<string, unknown> = {}) => fleet(1, ['sessions'], () => ({ sessions: handIn(meter) }), () => process)
const withTotals = (over: Record<string, unknown>) => ({ totals: { ...TOTALS, ...over } })
const machine = (over: Record<string, unknown>, more: Record<string, unknown> = {}) => input({ sessions: [session(0)], sampler: sampler({ 0: proc() }, { machine: { ...MACHINE, ...over }, ...more }) })

// For each rule: input just under its limit, and just past it
const CASES: Record<string, [ReportInput, ReportInput]> = {
  'idle-cpu': [fleet(1, [], undefined, () => ({ cpuMs: 2940 })), fleet(1, [], undefined, () => ({ cpuMs: 3060 }))],
  'cpu-with-peer': [0.59, 0.61].map(r => fleet(6, ['sessions'], k => ({ sessions: handIn({ actions: { events: action({ drivers: ['peer'], runs: 20 + (X[k] ?? 0) }) } }) }), k => ({ cpuMs: 1000 + 20 * withTrend(r, k) }))) as [ReportInput, ReportInput],
  'idle-starts': [fleet(1, [], undefined, () => ({ started: { git: 1, mv: 1 } })), fleet(1, [], undefined, () => ({ started: { git: 2, mv: 1 } }))],
  'unclaimed-program': [one({}, { started: { git: 10 } }), one({}, { started: { git: 11 } })],
  failures: [one(withTotals({ failed: { read: 5, stat: 5 } })), one(withTotals({ failed: { read: 6 } }))],
  timeout: [one(withTotals({ failed: { timeout: 0, command: 1 } })), one(withTotals({ failed: { timeout: 1 } }))],
  'wakes-with-plugins': [1140, 1260].map(idle => input({ sessions: [session(0), session(1, { plugins: ['sessions'] })], sampler: sampler({ 0: proc({ wakeups: { idle: 600 } }), 1: proc({ wakeups: { idle } }) }) })) as [ReportInput, ReportInput],
  'action-reads': [one({ actions: { refresh: action({ runs: 1, bytesRead: 1000000 }) } }), one({ actions: { refresh: action({ runs: 1, bytesRead: 1100000 }) } })],
  'on-timers': ['timers', 'own-watch'].map(live => fleet(2, ['sessions'], k => ({ sessions: handIn({ facts: { live: k ? live : 'timers' } }) }))) as [ReportInput, ReportInput],
  'slow-action': [one({ actions: { refresh: action({ runs: 2, ms: 98 }) } }), one({ actions: { refresh: action({ runs: 2, ms: 102 }) } })],
  'action-cpu': [one({ actions: { refresh: action({ runs: 100, ms: 594 }) } }), one({ actions: { refresh: action({ runs: 100, ms: 606 }) } })],
  'peer-action-rate': [one({ actions: { events: action({ drivers: ['peer'], runs: 60 }) } }), one({ actions: { events: action({ drivers: ['self', 'peer'], runs: 61 }) } })],
  'draw-unseen': [one({ facts: { looking:false }, actions: { 'draw.panel': action({ runs: 0 }), drawer: action({ runs: 9 }) } }), one({ facts: { looking:false }, actions: { 'draw.panel': action({ runs: 1 }) } })],
  'holding-grew': [one({ holdings: { timers: { grows: [], open: [5, null], close: [5, null] } } }), one({ holdings: { timers: { grows: [], open: [5, null], close: [6, null] } } })],
  unavailable: [machine({}, { unavailable: ['pss'] }), machine({}, { unavailable: ['pressure'] })],
  'memory-with-age': [0.59, 0.61].map(r => input({ sessions: X.map((x, k) => session(k, { ageHours: 10 + x })), sampler: sampler(Object.fromEntries(X.map((_, k) => [k, proc({ memoryMB: [200, 200 + 4 * withTrend(r, k)] })]))) })) as [ReportInput, ReportInput],
  'memory-pressure': [machine({ pressure: [1, 1] }), machine({ pressure: [1, 2] })],
  'memory-stall': [machine({ pressureKind: 'psi', pressure: [2, 9.5] }), machine({ pressureKind: 'psi', pressure: [2, 10.5] })],
  'swap-growing': [machine({ swapUsedMB: [100, 100.5] }), machine({ swapUsedMB: [100, 101.5] })],
  'no-answer': [fleet(2, ['sessions'], () => ({ sessions: handIn() })), fleet(2, ['sessions'], k => (k ? {} : { sessions: handIn() }))],
  'nobody-answered': [fleet(2, []), fleet(2, ['sessions'])],
  'hand-in-refused': [one({}), one({ facts: { where: '/Users/x/alpha' } })],
}

test('debug report: each "looks off" rule fires just past its limit and not just under it', () => {
  expect(Object.keys(CASES)).toEqual(RULES.map(r => r.name))
  for (const rule of RULES) {
    const [under, past] = CASES[rule.name] ?? []
    if (!under || !past) continue
    expect([rule.name, rulesOf(under).includes(rule.name)]).toEqual([rule.name, false])
    expect([rule.name, rulesOf(past).includes(rule.name)]).toEqual([rule.name, true])
    // What the file holds for it: the rule's name and limit, a value past it, and a label or a word
    for (const o of buildReport(past).report.off.filter(x => x.rule === rule.name)) {
      expect(o.limit).toBe(rule.limit)
      expect(o.value > rule.limit).toBe(true)
      expect(/^(S[0-9]+|[a-z][A-Za-z0-9.:-]*)$/.test(o.about)).toBe(true)
    }
  }
  // A rule's name is a fixed word, and no two share one
  expect(RULES.every(r => NAME.test(r.name))).toBe(true)
  expect(new Set(RULES.map(r => r.name)).size).toBe(RULES.length)
})

test('debug report: what the "looks off" rules leave alone', () => {
  // A busy session's CPU and starts, and a session that ended inside the window
  expect(rulesOf(input({ sessions: [session(0, { status: 'busy' })], sampler: sampler({ 0: proc({ cpuMs: 30000, started: { git: 30 } }) }) }))).toEqual([])
  expect(rulesOf(input({ sessions: [session(0)], sampler: sampler({ 0: proc({ cpuMs: 30000, gone: true }) }) }))).toEqual([])
  // With no hand-in at all, nobody says anything about any program
  expect(rulesOf(fleet(1, [], undefined, () => ({ started: { git: 1 }, cpuMs: 60 })))).toEqual([])
  expect(rulesOf(fleet(1, [], undefined, () => ({ started: { git: 30 } })))).toEqual(['idle-starts'])
  // A program a plugin says it started
  expect(rulesOf(one(withTotals({ started: { 'git:status': 30 } }), { started: { git: 30 } })).includes('unclaimed-program')).toBe(false)
  // A draw where somebody could be looking, or where the plugin doesn't say
  expect(rulesOf(one({ facts: { looking:true }, actions: { 'draw.panel': action({ runs: 5 }) } }))).toEqual([])
  expect(rulesOf(one({ actions: { 'band.draw': action({ runs: 5 }) } }))).toEqual([])
  expect(rulesOf(one({ facts: { looking:false }, actions: { 'band.draw': action({ runs: 5 }) } }))).toEqual(['draw-unseen'])
  // A holding that grows with something else, or with the sessions when one is new; but not with the sessions when none is
  const grew = (grows: string[]) => ({ holdings: { rows: { grows, open: [5, null], close: [9, null] } } })
  expect(rulesOf(one(grew(['events'])))).toEqual([])
  expect(rulesOf(one(grew(['sessions'])))).toEqual(['holding-grew'])
  const fresh = one(grew(['sessions']))
  fresh.sessions.push(session(1, { ageHours: 0.01 }) as never)
  expect(rulesOf(fresh)).toEqual([])
  // What a system isn't expected to have: Linux with no memory pressure, battery or terminal
  expect(rulesOf(input({ host: { os: 'linux', osMajor: 3, claude: '2.1.300', plugins: {} }, sessions: [session(0)], sampler: sampler({ 0: proc() }, { unavailable: ['pressure', 'battery', 'terminal', 'pss'] }) }))).toEqual([])
  // A slow part is an action too; an idle session's peer rate isn't a busy one's
  expect(rulesOf(one({ actions: { sweep: action({ runs: 1, ms: 40 }), 'sweep.outside': action({ within: 'sweep', runs: 1, ms: 60 }) } }))).toEqual(['slow-action'])
  const busy = one({ actions: { events: action({ drivers: ['peer'], runs: 500 }) } })
  ;(busy.sessions[0] as { status: string }).status = 'busy'
  expect(rulesOf(busy)).toEqual([])
  // A stopped session, and one that ended inside the window, couldn't answer
  expect(rulesOf(input({ sessions: [session(0, { plugins: ['sessions'] }), session(1, { status: 'stopped', plugins: ['sessions'] })], handIns: { [ID(0)]: { sessions: handIn() } } }))).toEqual([])
  expect(rulesOf(input({ sessions: [session(0, { plugins: ['sessions'] }), session(1, { plugins: ['sessions'] })], sampler: sampler({ 0: proc(), 1: proc({ gone: true }) }), handIns: { [ID(0)]: { sessions: handIn() } } }))).toEqual([])
})

test('debug report: a "looks off" line names a session by its label, and on screen by its title too', () => {
  const built = buildReport(
    input({
      sessions: [session(0, { title: 'alpha one' }), session(1, { title: 'beta $1 two' })],
      sampler: sampler({ 0: proc({ cpuMs: 6000 }), 1: proc({ cpuMs: 4200, started: { git: 5 } }) }),
    }),
  )
  expect(built.report.off).toEqual([
    { rule: 'idle-cpu', about: 'S1', value: 10, limit: 5 },
    { rule: 'idle-cpu', about: 'S2', value: (4200 / (60 * 1000)) * 100, limit: 5 },
    { rule: 'idle-starts', about: 'S2', value: 5, limit: 2 },
  ])
  const tail = (text: string) => lines(text).slice(lines(text).indexOf('Looks off:'))
  expect(tail(built.plain)).toEqual(['Looks off:', '  - S1: 10 % of a core while idle (over 5.0 %)', '  - S2: 7.0 % of a core while idle (over 5.0 %)', '  - S2: starts 5.0 processes a minute while idle (over 2)'])
  expect(tail(built.text)).toEqual([
    'Looks off:',
    '  - S1 (alpha one): 10 % of a core while idle (over 5.0 %)',
    '  - S2 (beta $1 two): 7.0 % of a core while idle (over 5.0 %)',
    '  - S2 (beta $1 two): starts 5.0 processes a minute while idle (over 2)',
  ])
  // Nothing else differs between the two
  const cut = (text: string) => text.slice(0, text.indexOf('Looks off:'))
  expect(cut(built.text)).toBe(cut(built.plain))
  expect(built.plain.includes('alpha one')).toBe(false)

  // Nothing found: it says none. Many of one rule: the first five, and how many more
  const calm = buildReport(fleet(2, []))
  expect(tail(calm.plain)).toEqual(['Looks off:', '  - none'])
  expect(calm.text).toBe(calm.plain)
  const hot = buildReport(fleet(8, [], undefined, k => ({ cpuMs: 6000 + 600 * k })))
  expect(hot.report.off).toHaveLength(8)
  expect(tail(hot.plain)).toHaveLength(7)
  expect(tail(hot.plain)[1]).toBe('  - S8: 17 % of a core while idle (over 5.0 %)')
  expect(tail(hot.plain)[6]).toBe('  - and 3 more like it (idle-cpu, in the report)')
})

// ---- partial input ----

test('debug report: with no sampler there are no process numbers, and it says so', () => {
  const built = buildReport(input({ sessions: [session(0, { plugins: ['sessions'] }), session(1)], handIns: { [ID(0)]: { sessions: handIn({ actions: { refresh: action({ runs: 2, ms: 3 }) } }) } } }))
  expect(built.report.missing).toEqual([{ what: 'sampler', count: 1, why: 'missing' }])
  expect(built.report.sessions.map(s => s.process)).toEqual([null, null])
  expect(built.report.host.cores).toBeNull()
  expect(built.report.other).toBeNull()
  expect(built.report.roles).toEqual({ terminal: null, service: null })
  expect(lines(built.plain).slice(0, 3)).toEqual([
    'sessions debug · perf · 60 s · report r-0a0a0a',
    'Machine: macOS 26 · no process numbers: the sampler gave nothing',
    'Claude 2.1.300 · sessions 0.21.0 · fleet 0.15.0 · 2 sessions (2 idle) · 1 of 1 answered',
  ])
  for (const title of ['CPU, of one core', 'By what runs', 'Memory (', 'Around the sessions', 'Processes started']) expect(built.plain.includes(title)).toBe(false)
  // The plugin's part is still there
  expect(built.plain).toContain('── sessions: an idle session, per minute ─')
  expect(built.report.off).toEqual([])
  // No section is printed empty: no two blank lines, none at the end
  expect(built.plain.includes('\n\n\n')).toBe(false)
  expect(built.plain.endsWith('  - none')).toBe(true)

  // A sampler of another format, or not a sampler's output, is no sampler
  expect(buildReport(input({ sampler: { ...sampler({}), format: 2 } })).report.missing).toEqual([{ what: 'sampler', count: 1, why: 'format' }])
  expect(buildReport(input({ sampler: { format: 1 } })).report.missing).toEqual([{ what: 'sampler', count: 1, why: 'shape' }])
})

test('debug report: with no hand-in at all it is the sampler alone', () => {
  const built = buildReport(
    input({
      sessions: [session(0), session(1), session(2, { status: 'busy' }), session(3, { status: 'waiting' })],
      sampler: sampler(
        { 0: proc({ cpuMs: 600, started: { git: 2 } }), 1: proc({ cpuMs: 1200, memoryMB: [200, 210] }), 2: proc({ cpuMs: 12000, childCpuMs: 600, memoryMB: [400, 1400], helpers: { node: { count: 2, memoryMB: 30 } } }), 3: proc() },
        { other: { cpuMs: 51000, largestMs: 36000, over20: 1 }, roles: { terminal: { count: 1, cpuMs: 1800, memoryMB: 410, threads: 9 }, service: { count: 2, cpuMs: 240, memoryMB: 95, threads: null } } },
      ),
    }),
  )
  expect(built.report.missing).toEqual([])
  expect(built.report.off).toEqual([])
  expect(built.report.sessions.every(s => Object.keys(s.meters).length === 0)).toBe(true)
  const p = built.plain
  expect(lines(p)[2]).toBe('Claude 2.1.300 · sessions 0.21.0 · fleet 0.15.0 · 4 sessions (1 busy, 2 idle, 1 waiting)')
  const rows = (title: string, n: number) => {
    const at = lines(p).findIndex(l => l.startsWith(title))
    return lines(p).slice(at + 1, at + 1 + n).map(l => l.trim().split(/\s{2,}/))
  }
  expect(rows('CPU, of one core', 4)).toEqual([
    ['idle sessions (2)', '1.5 % (1.0 to 2.0)', '3.0 %'],
    ['busy sessions (1)', '20 %', '20 %'],
    ['waiting sessions (1)', '1.0 %', '1.0 %'],
    ['their helper processes', '0 %', '1.0 %'],
  ])
  expect(rows('Memory (footprint)', 5)).toEqual([
    ['idle sessions (2)', '205 MB (200 to 210)', '410 MB'],
    ['busy sessions (1)', '1,400 MB', '1.4 GB'],
    ['waiting sessions (1)', '200 MB', '200 MB'],
    ['their helper processes', '0 MB', '30 MB'],
    ['change in this window', '+5.0 MB each'],
  ])
  expect(lineWith(p, 'across sessions')).toContain('too few sessions to compare (4; it takes 6)')
  expect(rows('Around the sessions', 3)).toEqual([
    ['other software', '85 % CPU in all, the largest 60 %, 1 over 20 % of a core'],
    ['the terminal', '3.0 % CPU · 410 MB · 9 threads'],
    ['the background service', '0.4 % CPU · 95 MB · 2 processes'],
  ])
  // What was seen, with nothing to set it against
  expect(rows('Processes started a minute, all sessions', 1)).toEqual([['git', '2.0']])
  expect(lineWith(p, 'Processes started a minute')).toBe('Processes started a minute, all sessions  seen')
  for (const part of ['about', 'across idle sessions', 'per minute', 'Scaling', 'the plugins say']) expect(p.includes(part)).toBe(false)
})

test('debug report: a refused hand-in, a plugin that handed nothing in, a session with no process', () => {
  const built = buildReport(
    input({
      sessions: [session(0, { plugins: ['sessions', 'fleet'] }), session(1, { plugins: ['sessions', 'fleet'] }), session(2, { plugins: ['sessions'] }), session(3, { status: 'stopped', plugins: [] })],
      sampler: sampler({ 0: proc(), 1: proc() }),
      handIns: {
        [ID(0)]: { sessions: handIn(), fleet: handIn({ actions: { 'bad name': action() } }) },
        [ID(1)]: { sessions: handIn({ facts: { where: '/Users/x/alpha' } }), fleet: handIn({ format: 9 }) },
        [ID(2)]: { easel: handIn() },
      },
    }),
  )
  expect(built.report.missing).toEqual([
    { what: 'hand-in', plugin: 'fleet', count: 1, why: 'name' },
    { what: 'hand-in', plugin: 'fleet', count: 1, why: 'format' },
    { what: 'hand-in', plugin: 'sessions', count: 1, why: 'name' },
    { what: 'session', plugin: 'sessions', count: 1, why: 'no-answer' },
    { what: 'session', count: 1, why: 'no-process' },
  ])
  // A plugin is in a session's list when its heartbeat or its hand-in shows it; null is one that didn't hand in
  expect(built.report.sessions.map(s => s.plugins)).toEqual([['fleet', 'sessions'], ['fleet', 'sessions'], ['easel', 'sessions'], []])
  expect(built.report.sessions.map(s => Object.fromEntries(Object.entries(s.meters).map(([p, m]) => [p, m === null ? null : 'taken'])))).toEqual([
    { fleet: null, sessions: 'taken' },
    { fleet: null, sessions: null },
    { easel: 'taken', sessions: null },
    {},
  ])
  expect(built.report.sessions[2]?.process).toBeNull()
  expect(built.report.off.map(o => [o.rule, o.about, o.value])).toEqual([
    ['no-answer', 'S3', 1],
    ['hand-in-refused', 'fleet', 2],
    ['hand-in-refused', 'sessions', 1],
  ])
  expect(flat(built.plain)).toContain('4 sessions (3 idle, 1 stopped) · 3 of 3 answered · 3 hand-ins refused')
  expect(built.plain).toContain("  - S3: 1 of its plugins handed nothing in, where other sessions' did")
  expect(built.plain).toContain('  - fleet: 2 of its hand-ins refused (the report says why)')
  // A plugin whose name isn't a name is `other`, and what it handed in is refused
  const odd = buildReport(input({ host: { os: 'macos', osMajor: 26, claude: '2.1.300', plugins: { 'My Plugin': '1.0.0' } }, sessions: [session(0, { plugins: ['My Plugin'] })], handIns: { [ID(0)]: { 'My Plugin': handIn() } } }))
  expect(odd.report.sessions[0]?.plugins).toEqual(['other'])
  expect(odd.report.sessions[0]?.meters).toEqual({ other: null })
  expect(odd.report.host.plugins).toEqual({ other: '1.0.0' })
  expect(odd.report.missing).toEqual([{ what: 'sampler', count: 1, why: 'missing' }, { what: 'hand-in', plugin: 'other', count: 1, why: 'name' }])
  // A hand-in filed under a session the list doesn't have is counted and not read
  const stray = buildReport(input({ sessions: [session(0)], sampler: sampler({ 0: proc() }), handIns: { [ID(5)]: { sessions: handIn(), fleet: handIn() }, [ID(6)]: { sessions: handIn() } } }))
  expect(stray.report.missing).toEqual([{ what: 'hand-in', plugin: 'sessions', count: 2, why: 'no-session' }, { what: 'hand-in', plugin: 'fleet', count: 1, why: 'no-session' }])
  expect(stray.report.sessions[0]?.meters).toEqual({})
  expect(stray.plain.includes('per minute')).toBe(false)
})

test('debug report: one session, no session, and sessions that are gone', () => {
  const alone = buildReport(fleet(1, ['sessions'], () => ({ sessions: handIn({ actions: { refresh: action({ runs: 2, ms: 3 }) } }) })))
  expect(alone.report.sessions).toHaveLength(1)
  expect(lineWith(alone.plain, 'idle sessions (1)').trim().split(/\s{2,}/)).toEqual(['idle sessions (1)', '1.0 %', '1.0 %'])
  expect(alone.plain).toContain('1 session (1 idle) · 1 of 1 answered')
  expect(alone.plain).toContain('the median of the one: no facts handed in')

  const empty = buildReport(input())
  expect(empty.report.sessions).toEqual([])
  expect(empty.key).toEqual({ report: 'r-0a0a0a', sessions: {}, projects: {}, roles: {} })
  expect(lines(empty.plain)).toEqual(['sessions debug · perf · 60 s · report r-0a0a0a', 'Machine: macOS 26 · no process numbers: the sampler gave nothing', 'Claude 2.1.300 · sessions 0.21.0 · fleet 0.15.0 · 0 sessions', '', 'Looks off:', '  - none'])

  // A session that ended inside the window is in the file and out of the medians; one the sampler never saw has no process
  const gone = buildReport(input({ sessions: [session(0), session(1), session(2)], sampler: sampler({ 0: proc({ cpuMs: 600 }), 1: proc({ cpuMs: 60000, gone: true }) }) }))
  expect(gone.report.sessions.map(s => s.process?.gone ?? null)).toEqual([false, true, null])
  expect(gone.report.missing).toEqual([{ what: 'session', count: 1, why: 'no-process' }])
  expect(lineWith(gone.plain, 'idle sessions (1)').trim().split(/\s{2,}/)).toEqual(['idle sessions (1)', '1.0 %', '1.0 %'])
  expect(gone.plain).toContain('3 sessions (3 idle) · 1 ended inside the window')
  expect(gone.report.off).toEqual([])
})

// ---- what a system doesn't have ----

test('debug report: a reading the system does not have prints "not available here", never a stand-in', () => {
  const build = (unavailable: string[], os = 'linux') =>
    buildReport(
      input({
        host: { os, osMajor: 5, claude: '2.1.300', plugins: {} },
        sessions: [session(0)],
        sampler: sampler({ 0: proc({ memoryKind: 'rss' }) }, { machine: { cores: 4, memoryMB: 8192, freeMB: null, swapUsedMB: null, pressure: null, pressureKind: null, battery: null }, unavailable }),
      }),
    )
  const all = build(['pressure', 'free', 'swap', 'battery', 'wakeups', 'terminal', 'service', 'other', 'pss', 'peak', 'a reading with words'])
  const p = all.plain
  expect(lines(p)[1]).toBe('Machine: Linux 5, 4 cores, 8.0 GB · memory pressure not available here,')
  expect(lines(p)[2]).toBe('  free memory not available here, swap not available here · battery not available here')
  expect(lines(p)[4]).toBe('Not available here: pss, peak, unknown')
  expect(lineWith(p, 'no plugin (1)').trim().split(/\s{2,}/)).toEqual(['no plugin (1)', '1.0 %', '200 MB', 'not available here'])
  expect(lineWith(p, 'By what runs')).toContain('wake-ups a second')
  expect(lineWith(p, '  other software').trim().split(/\s{2,}/)).toEqual(['other software', 'not available here'])
  expect(lineWith(p, '  the terminal').trim().split(/\s{2,}/)).toEqual(['the terminal', 'not available here'])
  expect(lineWith(p, '  the background service').trim().split(/\s{2,}/)).toEqual(['the background service', 'not available here'])
  expect(all.report.unavailable).toEqual(['pressure', 'free', 'swap', 'battery', 'wakeups', 'terminal', 'service', 'other', 'pss', 'peak', 'unknown'])
  // Linux should have some of them: those are worth a line
  expect(all.report.off.map(o => [o.rule, o.about])).toEqual([['unavailable', 'free'], ['unavailable', 'swap'], ['unavailable', 'wakeups'], ['unavailable', 'other'], ['unavailable', 'peak']])
  expect(p).toContain("  - free: a reading this system should have, and it's not available here")

  // A reading that's simply absent, and not said to be unavailable, is left out
  const quiet = build([])
  expect(quiet.plain.includes('not available')).toBe(false)
  expect(lines(quiet.plain)[1]).toBe('Machine: Linux 5, 4 cores, 8.0 GB')
  expect(quiet.plain.includes('Around the sessions')).toBe(false)
  expect(lineWith(quiet.plain, 'no plugin (1)').trim().split(/\s{2,}/)).toEqual(['no plugin (1)', '1.0 %', '200 MB', '-'])

  // The machine's line when it has them
  const mac = buildReport(input({ sessions: [session(0)], sampler: sampler({ 0: proc() }, { machine: { ...MACHINE, memoryMB: 36864, cores: 14, pressure: [1, 2], swapUsedMB: [3072, 3174.4], battery: true } }) }))
  expect(lines(mac.plain)[1]).toBe('Machine: macOS 26, 14 cores, 36 GB · memory pressure normal, then warning, 3.9 GB free,')
  expect(lines(mac.plain)[2]).toBe('  swap 3.1 GB (+102 MB in the window) · on battery')
  const psi = buildReport(input({ host: { os: 'linux', osMajor: 6, claude: '2.1.300', plugins: {} }, sessions: [session(0)], sampler: sampler({ 0: proc() }, { machine: { ...MACHINE, pressureKind: 'psi', pressure: [0, 0.4] } }) }))
  expect(lines(psi.plain)[1]).toBe('Machine: Linux 6, 8 cores, 16 GB · tasks waiting for memory 0.4 % of the time, 3.9 GB free,')
  expect(lines(psi.plain)[2]).toBe('  swap 0 MB · plugged in')
})

// ---- nothing free-text reaches the file or the plain text ----

// Every field that takes free text, filled with made-up names that would identify a machine, a project or its work.
// `names` gives the strings, so the same input can be built twice with other names
const SECRETS_A = {
  titles: ['Zephyrine payroll migration', 'Quixotic merger brief'],
  roots: ['/Users/x/Clients/borealis-heavy/monorepo', '/home/x/vault/kestrel-ledger'],
  ids: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj', 'kkkkkkkk-llll-mmmm-nnnn-oooooooooooo'],
  roles: ['sessions reviewer for Borealis', 'Kestrel on-call'],
  stranger: 'pppppppp-qqqq-rrrr-ssss-tttttttttttt',
  actions: ['deploy to wolverine', 'vault/kestrel-ledger'],
  factPath: '/Users/x/Clients/borealis-heavy/secrets.env',
  tool: 'wolverinedeploy',
  toolWithPurpose: 'ospreyctl:release',
  sampled: 'Hummingbird Sidecar',
  version: '2.1.300-internal@buildbox.borealis.example',
  pluginVersion: '0.21.0 (kestrel-laptop)',
  plugin: 'Borealis Internal Tools',
  report: 'r-borealis-monday',
  reading: 'thermals of kestrel-laptop',
  wakeKind: 'kestrel-interrupts',
  status: 'paused by Zephyrine',
  kind: 'quixotic',
  memoryKind: 'borealis-pages',
  hostKey: 'buildbox.borealis.example',
}
type Secrets = typeof SECRETS_A
const SECRETS_B: Secrets = {
  titles: ['Xylograph tax audit', 'Wisteria layoffs plan'],
  roots: ['/Users/x/Customers/umbra-light/platform', '/home/x/safe/vireo-journal'],
  ids: ['bbbbbbbb-cccc-dddd-eeee-ffffffffffff', 'gggggggg-hhhh-iiii-jjjj-kkkkkkkkkkkk', 'llllllll-mmmm-nnnn-oooo-pppppppppppp'],
  roles: ['fleet approver at Umbra', 'Vireo pager'],
  stranger: 'qqqqqqqq-rrrr-ssss-tttt-uuuuuuuuuuuu',
  actions: ['publish on mongoose', 'safe/vireo-journal'],
  factPath: '/Users/x/Customers/umbra-light/tokens.txt',
  tool: 'mongoosepublish',
  toolWithPurpose: 'falconcli:release',
  sampled: 'Dragonfly Daemon',
  version: '2.1.300-private@ci.umbra.example',
  pluginVersion: '0.21.0 (vireo-desktop)',
  plugin: 'Umbra Private Kit',
  report: 'r-umbra-tuesday',
  reading: 'fans of vireo-desktop',
  wakeKind: 'vireo-signals',
  status: 'held by Xylograph',
  kind: 'wisteria',
  memoryKind: 'umbra-pages',
  hostKey: 'ci.umbra.example',
}

const stuffed = (s: Secrets): ReportInput => {
  const [a, b, c] = s.ids as [string, string, string]
  const good = (role: string) =>
    handIn({
      facts: { live: 'own-watch', role: { label: 'role', key: role }, leader: { label: 'session', key: a }, other: { label: 'session', key: s.stranger } },
      actions: { tick: action({ runs: 3, ms: 9, started: { [s.tool]: 2, [s.toolWithPurpose]: 1, git: 1 }, work: { command: 4 } }) },
      totals: { ...TOTALS, started: { [s.tool]: 2, [s.toolWithPurpose]: 1, git: 1 } },
      holdings: { rows: { grows: ['sessions'], open: [2, 100], close: [2, 100] } },
      project: { who: { sweeper: { label: 'session', key: b }, role: { label: 'role', key: s.roles[1] as string } } },
    })
  return {
    report: s.report,
    profile: 'perf',
    at: 1_800_000_000_000,
    seconds: 60,
    host: { os: 'macos', osMajor: 26, claude: s.version, plugins: { sessions: s.pluginVersion, fleet: '0.15.0', [s.plugin]: '1.0.0', [s.hostKey]: s.version } },
    sessions: [
      { sessionId: a, pid: 301, root: s.roots[0], title: s.titles[0], kind: s.kind, status: 'idle', ageHours: 3, plugins: ['sessions', 'fleet', s.plugin] },
      { sessionId: b, pid: 302, root: s.roots[1], title: s.titles[1], kind: 'regular', status: 'idle', ageHours: 5, plugins: ['sessions', 'fleet'] },
      { sessionId: c, pid: 303, root: s.roots[0], title: s.titles[0], kind: 'background', status: s.status, ageHours: 7, plugins: ['sessions'] },
    ],
    sampler: {
      format: 1,
      how: s.sampled,
      seconds: 60,
      samples: 120,
      machine: { ...MACHINE, pressureKind: s.memoryKind, host: s.hostKey },
      processes: {
        301: { ...proc({ cpuMs: 6600, memoryKind: s.memoryKind, wakeups: { idle: 600, [s.wakeKind]: 60 }, started: { [s.sampled]: 5, [s.tool]: 30, git: 2 }, helpers: { [s.sampled]: { count: 1, memoryMB: 20 }, node: { count: 1, memoryMB: 10 } } }), title: s.titles[0], cwd: s.roots[0] },
        302: proc({ cpuMs: 900, started: { [s.toolWithPurpose]: 3 } }),
        303: proc(),
      },
      other: { cpuMs: 3000, largestMs: 1200, over20: 0, largest: s.sampled },
      roles: { terminal: { count: 1, cpuMs: 600, memoryMB: 300, threads: 9, name: s.sampled }, service: null },
      unavailable: ['pss', s.reading],
    },
    handIns: {
      [a]: {
        sessions: good(s.roles[0] as string),
        fleet: good(s.roles[1] as string),
        [s.plugin]: handIn(),
      },
      [b]: {
        // An action whose name has a space, another with a slash, a fact that is a path: each refused whole
        sessions: handIn({ actions: { [s.actions[0] as string]: action({ runs: 1 }) } }),
        fleet: handIn({ facts: { where: s.factPath } }),
      },
      [c]: { sessions: handIn({ actions: { [s.actions[1] as string]: action() }, notes: s.titles[1] }) },
      [s.stranger]: { sessions: good(s.roles[0] as string) },
    },
    programs: PROGRAMS,
  } as unknown as ReportInput
}

// The report's own words that a made-up name above happens to hold, and the purpose a plugin's code gave a program
const FIXED = ['sessions', 'fleet', 'call', 'release']

// Every string of a made-up input, whole and in its parts of 4 characters or more
const stringsOf = (x: unknown): string[] => (typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(stringsOf) : [])
const fragments = (s: Secrets): string[] => {
  const whole = Object.values(s).flatMap(stringsOf)
  const parts = whole.flatMap(text => text.split(/[^A-Za-z0-9]+/)).filter(part => part.length >= 4 && !FIXED.includes(part.toLowerCase()))
  return [...new Set([...whole, ...parts])]
}

test('debug report: no name, path, id or free text of the input reaches the file or the plain text', () => {
  const built = buildReport(stuffed(SECRETS_A))
  const file = JSON.stringify(built.report)
  const found = fragments(SECRETS_A).filter(part => file.toLowerCase().includes(part.toLowerCase()) || built.plain.toLowerCase().includes(part.toLowerCase()))
  expect(found).toEqual([])
  expect(fragments(SECRETS_A).length > 60).toBe(true)

  // What it wrote in their place
  expect(built.report.report).toBe('unknown')
  expect(built.report.host.claude).toBe('unknown')
  expect(built.report.host.plugins).toEqual({ sessions: 'unknown', fleet: '0.15.0', other: 'unknown' })
  expect(built.report.sessions.map(s => [s.id, s.project, s.kind, s.status, s.plugins])).toEqual([
    ['S1', 'P1', 'regular', 'idle', ['fleet', 'other', 'sessions']],
    ['S2', 'P2', 'regular', 'idle', ['fleet', 'sessions']],
    ['S3', 'P1', 'background', 'stopped', ['sessions']],
  ])
  const first = built.report.sessions[0]
  expect(first?.meters.sessions?.facts).toEqual({ leader: 'S1', live: 'own-watch', other: 'unknown', role: 'R2' })
  expect(first?.meters.fleet?.facts.role).toBe('R1')
  expect(first?.meters.fleet?.project).toEqual({ who: { role: 'R1', sweeper: 'S2' } })
  expect(first?.meters.sessions?.totals.started).toEqual({ other: 2, 'other:release': 1, git: 1 })
  expect(first?.meters.other).toBeNull()
  expect(first?.process?.started).toEqual({ other: 35, git: 2 })
  expect(first?.process?.helpers).toEqual({ other: { count: 1, memoryMB: 20 }, node: { count: 1, memoryMB: 10 } })
  expect(first?.process?.wakeups).toEqual({ idle: 600, other: 60 })
  expect(first?.process?.memoryKind).toBe('footprint')
  expect(Object.keys(first?.process ?? {}).sort()).toEqual(Object.keys(proc()).sort())
  expect(built.report.host.pressureKind).toBeNull()
  expect(Object.keys(built.report.host).sort()).toEqual(['battery', 'claude', 'cores', 'freeMB', 'memoryMB', 'os', 'osMajor', 'plugins', 'pressure', 'pressureKind', 'swapUsedMB'])
  expect(built.report.other).toEqual({ cpuMs: 3000, largestMs: 1200, over20: 0 })
  expect(built.report.roles.terminal).toEqual({ count: 1, cpuMs: 600, memoryMB: 300, threads: 9 })
  expect(built.report.unavailable).toEqual(['pss', 'unknown'])
  expect(built.report.missing).toEqual([
    { what: 'hand-in', plugin: 'other', count: 1, why: 'name' },
    { what: 'hand-in', plugin: 'fleet', count: 1, why: 'name' },
    { what: 'hand-in', plugin: 'sessions', count: 1, why: 'name' },
    { what: 'hand-in', plugin: 'sessions', count: 1, why: 'shape' },
    { what: 'hand-in', plugin: 'sessions', count: 1, why: 'no-session' },
  ])
  // A refused hand-in leaves nothing of itself, and one filed under a session the list doesn't have isn't read
  expect(built.report.sessions[1]?.meters).toEqual({ fleet: null, sessions: null })
  expect(built.report.sessions[2]?.meters).toEqual({ sessions: null })

  // The names are in the key, which stays, and on screen in a "looks off" line's parentheses, and nowhere else
  expect(built.key).toEqual({
    report: 'unknown',
    sessions: {
      S1: { title: SECRETS_A.titles[0], sessionId: SECRETS_A.ids[0], root: SECRETS_A.roots[0] },
      S2: { title: SECRETS_A.titles[1], sessionId: SECRETS_A.ids[1], root: SECRETS_A.roots[1] },
      S3: { title: SECRETS_A.titles[0], sessionId: SECRETS_A.ids[2], root: SECRETS_A.roots[0] },
    },
    projects: { P1: SECRETS_A.roots[0], P2: SECRETS_A.roots[1] },
    roles: { R1: SECRETS_A.roles[1], R2: SECRETS_A.roles[0] },
  })
  expect(built.text).toContain(`  - S1 (${SECRETS_A.titles[0]}): 11 % of a core while idle (over 5.0 %)`)
  const withoutTitles = SECRETS_A.titles.reduce((text, title) => text.split(` (${title})`).join(''), built.text)
  expect(withoutTitles).toBe(built.plain)

  // Every string the file holds is a number's neighbour of a known kind: a fixed word, a label, a version or a time
  const strings: string[] = []
  JSON.stringify(built.report, (_key, v) => {
    if (typeof v === 'string') strings.push(v)
    if (v && typeof v === 'object' && !Array.isArray(v)) strings.push(...Object.keys(v))
    return v
  })
  const allowed = /^([a-z][A-Za-z0-9.:-]{0,47}|[SPR][0-9]+|[0-9][0-9A-Za-z.+-]{0,23}|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z|[0-9]+)$/
  expect(strings.filter(x => !allowed.test(x))).toEqual([])
})

test('debug report: the file and the plain text are the same whatever the names in the input are', () => {
  const a = buildReport(stuffed(SECRETS_A))
  const b = buildReport(stuffed(SECRETS_B))
  expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report))
  expect(a.plain).toBe(b.plain)
  // The keys and the on-screen text are where they differ
  expect(JSON.stringify(a.key) === JSON.stringify(b.key)).toBe(false)
  expect(a.text === b.text).toBe(false)
  expect(fragments(SECRETS_B).filter(part => JSON.stringify(a.report).toLowerCase().includes(part.toLowerCase()) || a.plain.toLowerCase().includes(part.toLowerCase()))).toEqual([])
})
