import { expect, test } from 'claude-code/testing'

import {
  addSpend,
  askBadge,
  budgetState,
  capFor,
  commandLevel,
  compareVersions,
  countWake,
  denyRules,
  expandBraces,
  familyOf,
  forecastOf,
  instancesOf,
  isCommandLevel,
  lintRoster,
  markRow,
  mergeSettings,
  modeOf,
  modeWaits,
  overBudgetLine,
  parseAmount,
  parseRoleFile,
  parseRoster,
  pickInstances,
  seesFleet,
  settingsFor,
  slugOf,
  usd,
  usdOf,
  localSessionsRecords,
  redundantSessionsKeys,
  withoutPlugins,
  wakeUsd,
  wakeVerdict,
  wakesOf,
  type Roster,
} from '../hooks/roster'

const ROOT = '/Users/x/proj'
const ROLE = (name: string, tools = 'Read, Write, mcp__fleet__*') => `---\nname: ${name}\ndescription: a role\ntools: ${tools}\n---\nThe charter.\n`

function roster(extra: Partial<Roster> = {}): Roster {
  return {
    rosterFormat: 1,
    sections: [
      { id: 'front', title: 'Front' },
      { id: 'work', title: 'Work' },
    ],
    roles: {
      chief: { agent: 'chief', model: 'opus', budget: { usdDay: 10 } },
      worker: { agent: 'worker', model: 'sonnet', effort: 'high', budget: { usdDay: 5 }, settings: { env: { A: '1' } } },
    },
    instances: [
      { name: 'Chief', role: 'chief', section: 'front', wave: 1 },
      { name: 'Lead', role: 'worker', section: 'work', wave: 1, brief: 'You lead.' },
      { name: 'Area A', role: 'worker', section: 'work', wave: 2, parent: 'Lead', model: 'haiku', budget: { usdDay: 2 }, settings: { env: { B: '2' } } },
    ],
    budget: { usdDay: 40 },
    ...extra,
  }
}

const FILES = new Map([
  ['chief', ROLE('chief')],
  ['worker', ROLE('worker')],
])

test('roster.json: its fields, or why not (a newer fleet wrote it, it is not a roster)', () => {
  expect(parseRoster('{')).toEqual({ problem: "roster.json isn't valid JSON" })
  expect(parseRoster('{"rosterFormat": 2, "roles": {}, "instances": []}')).toMatchObject({ problem: expect.stringContaining('newer fleet') })
  expect(parseRoster('{"rosterFormat": 1, "instances": []}')).toMatchObject({ problem: expect.stringContaining('roles') })
  expect(parseRoster('{"rosterFormat": 1, "roles": {}, "instances": [], "later": 1}')).toEqual({ roster: { rosterFormat: 1, roles: {}, instances: [], later: 1 } })
})

test("instances: the role's fields under the instance's, sections in order after fleet's own, the settings merged", () => {
  const [chief, lead, a] = instancesOf(roster())
  expect(chief).toMatchObject({ name: 'Chief', slug: 'chief', agent: 'chief', model: 'opus', usdDay: 10, wave: 1, section: { id: 'front', title: 'Front', order: 201 }, parent: null, seed: 'seeds/chief.md' })
  expect(lead).toMatchObject({ slug: 'lead', model: 'sonnet', effort: 'high', usdDay: 5, brief: 'You lead.', section: { order: 202 } })
  // A section's own order (the templates give each of theirs one no other template uses); a bad one falls back
  const own = roster()
  own.sections = (own.sections ?? []).map((s, i) => ({ ...s, order: i ? 150 : 230 }))
  const [c2, l2] = instancesOf(own)
  expect([c2?.section?.order, l2?.section?.order]).toEqual([230, 202])
  expect(a).toMatchObject({ slug: 'area-a', model: 'haiku', effort: 'high', usdDay: 2, wave: 2, parent: 'Lead', settings: { env: { A: '1', B: '2' } } })
  expect(slugOf('  Área B / 2 ')).toBe('area-b-2')
  expect(mergeSettings({ a: { x: 1 }, l: ['p'] }, { a: { y: 2 }, l: ['p', 'q'], s: 'v' })).toEqual({ a: { x: 1, y: 2 }, l: ['p', 'q'], s: 'v' })
})

test('role files: the name and the tools of the front matter, in each form', () => {
  expect(parseRoleFile(ROLE('chief'))).toEqual({ name: 'chief', tools: ['Read', 'Write', 'mcp__fleet__*'] })
  expect(parseRoleFile('---\nname: "x"\ntools: [Read, "Bash"]\n---\n')).toEqual({ name: 'x', tools: ['Read', 'Bash'] })
  expect(parseRoleFile('---\nname: x\ntools:\n  - Read\n  - mcp__fleet\n---\n')).toEqual({ name: 'x', tools: ['Read', 'mcp__fleet'] })
  expect(parseRoleFile('---\nname: x\n---\nall tools')).toEqual({ name: 'x', tools: null })
  expect(parseRoleFile('no front matter')).toEqual({ name: null, tools: null })
  expect(seesFleet(['Read'])).toBe(false)
  expect(seesFleet(null)).toBe(true)
})

test('the lints: what stops /fleet up, and what it only says', () => {
  expect(lintRoster(roster(), FILES)).toEqual({ errors: [], warnings: [] })
  const missing = lintRoster(roster(), new Map([['chief', ROLE('chief')], ['worker', null]]))
  expect(missing.errors).toEqual(['no role file .claude/agents/worker.md (the role of Lead, Area A)'])
  const hidden = lintRoster(roster(), new Map([['chief', ROLE('chief', 'Read, Write')], ['worker', ROLE('other')]]))
  expect(hidden.errors).toEqual([
    ".claude/agents/chief.md: its tools don't list mcp__fleet__*, so fleet's tools would be hidden from it (and its start would hold 8 s)",
    '.claude/agents/worker.md is named "other" in its front matter: --agent worker finds a role by that name',
  ])
  const bad = roster({
    instances: [
      { name: 'Chief', role: 'chief', section: 'front' },
      { name: 'chief', role: 'boss', section: 'nowhere', parent: 'Nobody', wave: 0 },
      { name: 'Lead', role: 'worker', permissions: { defaultMode: 'bypassPermissions' } },
    ],
  })
  const l = lintRoster(bad, FILES)
  expect(l.errors).toEqual([
    'two instances are named "chief"',
    `"chief": its role "boss" isn't in roles`,
    `"chief": its section "nowhere" isn't in sections`,
    '"chief": wave is a whole number from 1',
    `"chief": its parent "Nobody" isn't an instance`,
    '"Lead": fleet doesn\'t start an instance with bypassPermissions (it would send things out with nobody asked)',
  ])
  const over = lintRoster(roster({ budget: { usdDay: 10 } }), FILES)
  expect(over.warnings[0]).toContain("the instances' budgets add up to $17.00 a day, over the project's $10.00")
  expect(lintRoster(roster({ instances: [] }), FILES).warnings).toEqual(['the roster has no instances yet: nothing to start'])
  // A role that can open a dialog nobody answers: marked, never refused
  const every = lintRoster(roster(), new Map([['chief', '---\nname: chief\n---\nall tools'], ['worker', ROLE('worker', 'Read, AskUserQuestion, mcp__fleet__*')]]))
  expect(every.errors).toEqual([])
  expect(every.warnings).toEqual([
    '.claude/agents/chief.md: with no tools line it has every tool, AskUserQuestion included: a question it asks that way waits for nobody (an instance asks with mcp__fleet__decide); list its tools without it',
    '.claude/agents/worker.md: its tools include AskUserQuestion: a question it asks that way waits for nobody (an instance asks with mcp__fleet__decide); list its tools without it',
  ])
})

test("the settings fleet writes: the roster's, then its env, model, effort and the denies of the command-level files", () => {
  const level = commandLevel({ worldFormat: 1, paths: ['req/**', 'notes/**'], command: ['req/**', 'spec/{a,b}.md', '../bad'] }, ['checks/board.sh'])
  expect(level).toEqual({ files: ['.claude/fleet/charter.md', '.claude/fleet/principles.md', '.claude/fleet/roster.json', '.claude/fleet/world.json', '.claude/fleet/outbound.json', '.claude/fleet/slots.json', 'checks/board.sh'], globs: ['.claude/agents/**', 'req/**', 'spec/{a,b}.md'] })
  expect(isCommandLevel('req/R-1.md', level, false)).toBe(true)
  expect(isCommandLevel('.claude/agents/chief.md', level, false)).toBe(true)
  expect(isCommandLevel('notes/a.md', level, false)).toBe(false)
  expect(expandBraces('spec/{a,b}.md')).toEqual(['spec/a.md', 'spec/b.md'])
  const deny = denyRules(ROOT, level)
  expect(deny).toEqual([
    'Edit(//Users/x/proj/.claude/fleet/charter.md)',
    'Edit(//Users/x/proj/.claude/fleet/principles.md)',
    'Edit(//Users/x/proj/.claude/fleet/roster.json)',
    'Edit(//Users/x/proj/.claude/fleet/world.json)',
    'Edit(//Users/x/proj/.claude/fleet/outbound.json)',
    'Edit(//Users/x/proj/.claude/fleet/slots.json)',
    'Edit(//Users/x/proj/checks/board.sh)',
    'Edit(//Users/x/proj/.claude/agents/**)',
    'Edit(//Users/x/proj/req/**)',
    'Edit(//Users/x/proj/spec/a.md)',
    'Edit(//Users/x/proj/spec/b.md)',
    'Edit(//Users/x/proj/.claude/fleet/instances/**)',
  ])
  const a = instancesOf(roster({ settings: { enabledPlugins: { 'p@m': true }, permissions: { allow: ['Bash(make:*)'] } } }))[2]!
  const s = settingsFor({ ...a, permissions: { defaultMode: 'acceptEdits', deny: ['WebFetch'] }, settings: { ...a.settings, env: { ...(a.settings.env as object), FLEET_ROOT: '/elsewhere' } } }, ROOT, deny)
  expect(s.env).toEqual({ A: '1', B: '2', FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Area A', FLEET_ROLE: 'worker' })
  expect(s.model).toBe('haiku')
  expect(s.effortLevel).toBe('high')
  expect(s.enabledPlugins).toEqual({ 'p@m': true })
  expect(s.permissions).toEqual({ allow: ['Bash(make:*)'], defaultMode: 'acceptEdits', deny: ['WebFetch', ...deny] })
})

test('the forecast: wakes at the cache-write price of each model; models with no price are named', () => {
  expect(familyOf('claude-opus-5-5')).toBe('opus')
  expect(familyOf('haiku')).toBe('haiku')
  expect(familyOf('gpt')).toBe(null)
  expect(Math.round((wakeUsd('opus', 8) ?? 0) * 1000)).toBe(1600)
  expect(Math.round((wakeUsd('haiku', 8) ?? 0) * 1000)).toBe(40)
  const f = forecastOf(instancesOf(roster()), wakesOf(roster()))
  expect(f.caps).toBe(17)
  expect(Math.round(f.wakesUsd * 1000)).toBe(2440)
  expect(f.unpriced).toEqual([])
  expect(wakesOf(null)).toEqual({ everyMin: 60, perDay: 8 })
  expect(wakesOf(roster({ wakes: { everyMin: 0, perDay: 3 } }))).toEqual({ everyMin: 1, perDay: 3 })
})

test("budgets: today's spend from the session's cost; 80% warns, 100% is over; the person's lift for the day", () => {
  const base = { format: 1, slug: 'lead', day: '2026-11-02', sessionId: 's1', at: 1 }
  const one = addSpend(null, { ...base, cost: 0.5 })
  expect(one).toMatchObject({ usd: 0.5, last: 0.5 })
  const two = addSpend(one, { ...base, cost: 1.25 })
  expect(two).toMatchObject({ usd: 1.25, last: 1.25 })
  // A /clear starts the session's total over: what it shows now is new spend
  expect(addSpend(two, { ...base, cost: 0.1 })).toMatchObject({ usd: 1.35, last: 0.1 })
  // Another session (a restart, a new one) counts from its own total
  expect(addSpend(two, { ...base, sessionId: 's2', cost: 0.2 })).toMatchObject({ usd: 1.45, sessionId: 's2' })
  // A new day starts at the growth since the last reading
  expect(addSpend(two, { ...base, day: '2026-11-03', cost: 1.5 })).toMatchObject({ usd: 0.25, day: '2026-11-03' })
  expect(budgetState(3.9, 5)).toBe('ok')
  expect(budgetState(4, 5)).toBe('warn')
  expect(budgetState(5, 5)).toBe('over')
  expect(budgetState(500, null)).toBe('ok')
  expect([usd(0), usd(0.002), usd(0.25), usd(12.4), usd(10), usd(10.02)]).toEqual(['$0.00', '$0.002', '$0.25', '$12.40', '$10.00', '$10.02'])
  // below a dollar, three significant digits: a small budget doesn't read as used up
  expect([usd(0.016), usd(0.02), usd(0.123456), usd(0.5)]).toEqual(['$0.016', '$0.02', '$0.123', '$0.50'])
  expect([usdOf(0.016, 0.02), usdOf(1.5, null), usdOf(12, 10)]).toEqual(['$0.016 of $0.02 (80%)', '$1.50', '$12.00 of $10.00'])
  const lifts = { format: 1, day: '2026-11-02', instances: { lead: 9 }, project: 60 }
  expect(capFor(5, lifts, '2026-11-02', 'lead')).toBe(9)
  expect(capFor(5, lifts, '2026-11-03', 'lead')).toBe(5)
  expect(capFor(40, lifts, '2026-11-02', null)).toBe(60)
  expect(parseAmount('+5')).toEqual({ add: 5 })
  expect(parseAmount('$12.5')).toEqual({ set: 12.5 })
  expect(parseAmount('five')).toBe(null)
})

test('wakes: at most one per window (an answer waits ten minutes at most) and a few a day in all', () => {
  const wakes = { everyMin: 60, perDay: 3 }
  const now = Date.UTC(2026, 10, 2, 12)
  expect(wakeVerdict(null, 0, now, '2026-11-02', wakes, false)).toBe('ok')
  const once = countWake(null, now, '2026-11-02')
  expect(once).toEqual({ day: '2026-11-02', count: 1, last: now })
  expect(wakeVerdict(once, 0, now + 30 * 60000, '2026-11-02', wakes, false)).toBe('window')
  expect(wakeVerdict(once, 0, now + 30 * 60000, '2026-11-02', wakes, true)).toBe('ok')
  expect(wakeVerdict(once, 0, now + 5 * 60000, '2026-11-02', wakes, true)).toBe('window')
  expect(wakeVerdict(once, 0, now + 61 * 60000, '2026-11-02', wakes, false)).toBe('ok')
  expect(wakeVerdict(once, 2, now + 61 * 60000, '2026-11-02', wakes, true)).toBe('cap')
  // A new day starts the count again
  expect(wakeVerdict({ ...once, count: 3 }, 0, now, '2026-11-03', wakes, false)).toBe('ok')
})

test('picking instances by what the person typed: names in any case, file names, a name with spaces unquoted', () => {
  const all = instancesOf(roster())
  expect(pickInstances(['chief', 'area-a'], all).picked.map(i => i.name)).toEqual(['Chief', 'Area A'])
  expect(pickInstances(['Area', 'A'], all).picked.map(i => i.name)).toEqual(['Area A'])
  expect(pickInstances(['Lead', 'Nobody'], all)).toMatchObject({ unknown: ['Nobody'] })
})

test("a row's mark within sessions' limits: the badge to 3 columns, the line to 60 characters, one line each", () => {
  expect(markRow({ badge: '?12', tint: 'warning', line: 'asks you 12: /fleet', needsPerson: true })).toEqual({ badge: '?12', tint: 'warning', line: 'asks you 12: /fleet', needsPerson: true })
  expect(markRow({ badge: 'abcd', tint: 'error', line: 'x' }).badge).toBe('abc')
  expect(markRow({ badge: '🔥🔥', tint: 'error', line: 'x' }).badge).toBe('🔥')
  const cut = markRow({ badge: '$', tint: 'error', line: `${'a'.repeat(70)}\nmore` })
  expect(Array.from(cut.line).length).toBe(60)
  expect(cut.line.endsWith('…')).toBe(true)
  expect(markRow({ badge: '$', tint: 'error', line: 'two\nlines' }).line).toBe('two lines')
  expect(markRow({ badge: '$', tint: 'error', line: 'x', needsPerson: false })).toEqual({ badge: '$', tint: 'error', line: 'x' })
  // The over-budget line: the name, else the file name, else the name cut
  expect(overBudgetLine('TEST Business Plan', 'test-business-plan')).toBe('over budget: /fleet budget "TEST Business Plan" +n')
  expect(overBudgetLine('Plan: Business & Financials, v2', 'plan-business-financials-v2')).toBe('over budget: /fleet budget plan-business-financials-v2 +n')
  const long = overBudgetLine('The Business Plan, the Financials and the Market Study', 'the-business-plan-the-financials-and-the')
  expect(Array.from(long).length).toBeLessThanOrEqual(60)
  expect(long).toMatch(/^over budget: \/fleet budget "The Business Plan.*…" \+n$/)
  expect(askBadge(3)).toBe('?3')
  expect(askBadge(250)).toBe('?99')
})

test('the permission mode an instance runs in: managed, its own, the project\'s, the person\'s; and which modes wait', () => {
  const mode = (m: string) => ({ permissions: { defaultMode: m } })
  expect(modeOf({})).toEqual({ mode: 'default', from: "Claude's default" })
  expect(modeOf({ user: mode('auto') })).toEqual({ mode: 'auto', from: 'your settings' })
  expect(modeOf({ user: mode('auto'), project: mode('acceptEdits') })).toEqual({ mode: 'acceptEdits', from: "the project's settings.json" })
  expect(modeOf({ user: mode('auto'), instance: mode('dontAsk'), local: mode('default') })).toEqual({ mode: 'dontAsk', from: 'roster.json' })
  expect(modeOf({ policy: mode('default'), instance: mode('auto') })).toEqual({ mode: 'default', from: 'managed settings' })
  expect(modeWaits('default')).toContain('the first write or command waits for you')
  expect(modeWaits('plan')).toContain('the first write or command waits for you')
  expect(modeWaits('acceptEdits')).toContain('the first Bash command waits')
  expect(modeWaits('auto')).toBeNull()
  expect(modeWaits('dontAsk')).toBeNull()
  expect(compareVersions('0.6.0', '0.7.0')).toBe(-1)
  expect(compareVersions('0.10.0', '0.9.2')).toBe(1)
  expect(compareVersions('0.7.1', '0.7.1')).toBe(0)
})

test('plan B: the sessions key settings.local.json repeats from the user settings, and a local record of it', () => {
  const local = { enabledPlugins: { 'fleet@m': true, 'sessions@m': true, 'other@m': true }, env: { A: '1' } }
  expect(redundantSessionsKeys(local, { enabledPlugins: { 'sessions@m': true, 'fleet@m': false } })).toEqual(['sessions@m'])
  // the user's sessions isn't enabled (or this is a test copy, inline): the key stays
  expect(redundantSessionsKeys(local, { enabledPlugins: { 'sessions@m': false } })).toEqual([])
  expect(redundantSessionsKeys({ enabledPlugins: { 'sessions@inline': true } }, { enabledPlugins: { 'sessions@inline': true } })).toEqual([])
  expect(redundantSessionsKeys(null, {})).toEqual([])
  expect(JSON.parse(withoutPlugins(JSON.stringify(local), ['sessions@m']) as string)).toEqual({ enabledPlugins: { 'fleet@m': true, 'other@m': true }, env: { A: '1' } })
  expect(withoutPlugins('not json', ['sessions@m'])).toBeNull()
  const list = JSON.stringify([
    { id: 'sessions@m', version: '0.13.1', scope: 'user', enabled: true },
    { id: 'sessions@m', version: '0.13.0', scope: 'local', enabled: true, projectPath: '/Users/x/proj' },
    { id: 'sessions@m', version: '0.12.0', scope: 'local', enabled: true, projectPath: '/Users/x/other' },
    { id: 'fleet@m', version: '0.7.1', scope: 'local', projectPath: '/Users/x/proj' },
  ])
  expect(localSessionsRecords(list, '/Users/x/proj/')).toEqual([{ id: 'sessions@m', version: '0.13.0' }])
  expect(localSessionsRecords('oops', '/Users/x/proj')).toEqual([])
})
