import { expect, test } from 'claude-code/testing'

import {
  abbreviate,
  actionFromAnswer,
  reconcilePins,
  sparkline,
  stopReasons,
  daysUpTo,
  paneWidth,
  buildNotice,
  colorOf,
  displayWidth,
  compareVersions,
  timeSince,
  inProject,
  parseNotice,
  parsePins,
  parseVersion,
  shortModelName,
  recentReopens,
  realTasks,
  RESTART_OPTIONS,
  STOP_OPTIONS,
  REMOVE_OPTIONS,
  validateList,
  neighbor,
  remainingNeighbor,
  usageWindow,
  versionFromExecutable,
  parseWindows,
  sortRows,
  orderFileText,
  parseOrderFile,
  fileKey,
  keyLines,
  parseKeyLines,
  windowTargetText,
  parseInbox,
  parseHeartbeat,
  heartbeatText,
  heartbeatStatus,
  type Heartbeat,
  expectsHeartbeat,
  HEARTBEAT_VERSION,
  parsePluginList,
  rootFrom,
  rootCandidates,
  autoName,
  debugLogName,
  adoptAutoPins,
  reloadDecision,
  refOf,
  agentFromTranscript,
  groupRows,
  foldRows,
  drawPlan,
  ringKeys,
  assignChange,
  sectionHeaders,
  keepPlaces,
  parseSectionsFile,
  sectionsView,
  sectionsFileText,
  emptySectionsFile,
  personAssign,
  pruneMembers,
  slugOf,
  type SectionsView,
  spendOf,
  publishedSpend,
  formatUsd,
  limitsText,
  waitingMembers,
} from '../hooks/state'

// These run after every Claude update: if the mod API or the state format change, they fail here.
const NOW = 1_000_000_000

test('colors: each official status gives its color and when the time counts from', () => {
  expect(colorOf({ status: 'busy' }, { turnStarted: 5 }, 0)).toEqual({ color: 'blue', since: 5 })
  expect(colorOf({ status: 'waiting' }, null, 0, 7)).toEqual({ color: 'red', since: 7 })
  expect(colorOf({}, null, 0).color).toBe('gray')
  expect(colorOf({ status: 'idle' }, { finished: 100 }, 0)).toEqual({ color: 'yellow', since: 100 })
  expect(colorOf({ status: 'idle' }, { finished: 100 }, 200)).toEqual({ color: 'green', since: 100 })
  expect(colorOf({ status: 'idle' }, { created: 3 }, 0)).toEqual({ color: 'green', since: 3 })
})

test("colors: a status that doesn't exist today shows as gray, not as done", () => {
  expect(colorOf({ status: 'paused' }, { finished: 1 }, 0).color).toBe('gray')
})

test('short time: now, minutes, hours and days', () => {
  expect(timeSince(NOW - 20_000, NOW)).toBe('now')
  expect(timeSince(NOW - 3 * 60_000, NOW)).toBe('3m')
  expect(timeSince(NOW - 2 * 3_600_000, NOW)).toBe('2h')
  expect(timeSince(NOW - 3 * 86_400_000, NOW)).toBe('3d')
})

test('model: short name from how Claude reports it', () => {
  expect(shortModelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(shortModelName('Opus 5.5 (1M context)')).toBe('Opus 5.5')
  expect(shortModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(shortModelName('sonnet')).toBe('sonnet')
})

test("panel width: fits the content, capped at the default width", () => {
  // Short names: the legend sets it (50)
  expect(paneWidth(['One', 'Two'], 89)).toBe(50)
  // No sessions: same as with short names
  expect(paneWidth([], 89)).toBe(50)
  // A long name grows the panel just as much as needed (35 + 25)
  expect(paneWidth(['Refactor the payment retry handling'], 89)).toBe(60)
  // Longer than the cap: stays at the default width (the name gets truncated with …)
  expect(paneWidth(['x'.repeat(80)], 89)).toBe(89)
  // Small window (the panel is 49 wide by default): never more than that, even if more is needed
  expect(paneWidth(['Refactor the payment retry handling'], 49)).toBe(49)
  // Cap smaller than the legend: the cap wins
  expect(paneWidth(['One'], 30)).toBe(30)
  // Unknown cap (not measured yet): 89
  expect(paneWidth(['x'.repeat(80)], 0)).toBe(89)
  // Never less than 20
  expect(paneWidth(['One'], 12)).toBe(20)
  // Emoji take two columns
  expect(displayWidth('🟡 home')).toBe(7)
  expect(paneWidth(['🏠'.repeat(20)], 89)).toBe(65)
})

test('pinned: pins.json is only read if it is a list of ids', () => {
  expect(parsePins('[\n  "ffffffff",\n  "dddddddd"\n]')).toEqual(['ffffffff', 'dddddddd'])
  expect(parsePins('[]')).toEqual([])
  expect(parsePins('{"pins": []}')).toBe(null)
  expect(parsePins('[1, 2]')).toBe(null)
  expect(parsePins('not json')).toBe(null)
})

test('pinned: with Remote Control it gets pinned automatically, and unpinned when turned off', () => {
  const none = { ids: [], released: [] }
  // Remote Control turned on: it gets pinned, after the ones already there
  const a = reconcilePins(['other'], { s1: true, other: false }, none)
  expect(a).toEqual({ pins: ['other', 's1'], auto: { ids: ['s1'], released: [] }, toPin: ['s1'], toUnpin: [] })
  // The next pass changes nothing
  expect(reconcilePins(a.pins, { s1: true, other: false }, a.auto)).toEqual({ pins: ['other', 's1'], auto: a.auto, toPin: [], toUnpin: [] })
  // Turned off: the one the mod pinned is unpinned; the one you pinned (other) stays
  expect(reconcilePins(a.pins, { s1: false, other: false }, a.auto)).toEqual({ pins: ['other'], auto: none, toPin: [], toUnpin: ['s1'] })
  // If its state can't be read, it isn't touched
  expect(reconcilePins(a.pins, { s1: null }, a.auto).pins).toEqual(['other', 's1'])
  // Already pinned by hand with Remote Control: it doesn't become the mod's, and stays pinned when turned off
  const b = reconcilePins(['s2'], { s2: true }, none)
  expect(b).toEqual({ pins: ['s2'], auto: none, toPin: [], toUnpin: [] })
  expect(reconcilePins(['s2'], { s2: false }, b.auto).pins).toEqual(['s2'])
})

test("pinned: if you unpin it by hand it doesn't insist, until you turn Remote Control on again", () => {
  const pinned = { ids: ['s1'], released: [] }
  // The mod pinned it and it's not in pins.json: you unpinned it (Ctrl+T)
  const a = reconcilePins([], { s1: true }, pinned)
  expect(a).toEqual({ pins: [], auto: { ids: [], released: ['s1'] }, toPin: [], toUnpin: [] })
  expect(reconcilePins([], { s1: true }, a.auto).pins).toEqual([])
  // You turn Remote Control off and on: it gets pinned again
  const b = reconcilePins([], { s1: false }, a.auto)
  expect(b.auto).toEqual({ ids: [], released: [] })
  expect(reconcilePins([], { s1: true }, b.auto).toPin).toEqual(['s1'])
})

test('pinned: a deleted session the mod pinned gets unpinned', () => {
  expect(reconcilePins(['s1', 'other'], { other: false }, { ids: ['s1'], released: ['s3'] })).toEqual({
    pins: ['other'],
    auto: { ids: [], released: [] },
    toPin: [],
    toUnpin: ['s1'],
  })
})

const PANE = { title: 'Sessions', isFocused: true, bodyColumns: 60, placement: 'dock' } as any

test('terminal: the panel renders and "New" opens the name field', async $ => {
  const surface = 'terminal'
  const ui = await $.ui.mount({ plugin: 'sessions', surface, component: 'Pane', props: PANE, requestId: 'sessions' })
  expect(JSON.stringify(await ui.drawn())).toContain('↑↓ Select')
  expect(await ui.find({ key: 'new' })).toBeDefined()
  expect(await ui.find({ key: 'restart' })).toBeDefined()
  expect(await ui.find({ key: 'rename' })).toBeDefined()
  expect(await ui.find({ key: 'waiting' })).toBeDefined()
  expect(await ui.find({ key: 'name' })).toBe(undefined)
  await $.ui.press({ plugin: 'sessions', key: 'new', requestId: 'sessions', surface })
  expect(await ui.find({ key: 'name' })).toBeDefined()
})

for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
  test(`${surface}: the panel renders read-only, without jumping or creating`, async $ => {
    const ui = await $.ui.mount({ plugin: 'sessions', surface, component: 'Pane', props: PANE, requestId: 'sessions' })
    expect(JSON.stringify(await ui.drawn())).toContain('Attention')
    expect(await ui.find({ key: 'new' })).toBe(undefined)
    expect(await ui.find({ key: 'agents' })).toBe(undefined)
    expect(await ui.find({ key: 'restart' })).toBe(undefined)
    expect(await ui.find({ key: 'rename' })).toBe(undefined)
    expect(await ui.find({ key: 'waiting' })).toBe(undefined)
  })
}

test("Rename: without a selected session it doesn't open the field", async $ => {
  const surface = 'terminal'
  const ui = await $.ui.mount({ plugin: 'sessions', surface, component: 'Pane', props: PANE, requestId: 'sessions' })
  await $.ui.press({ plugin: 'sessions', key: 'rename', requestId: 'sessions', surface })
  expect(await ui.find({ key: 'rename-input' })).toBe(undefined)
})

test('official list: a format change is detected and reported', () => {
  expect(validateList('not json')).toContain('not JSON')
  expect(validateList('{"sessions": []}')).toContain('not a list')
  expect(validateList('[{"id": "abc"}]')).toContain('missing sessionId or cwd')
  expect(validateList('[]')).toEqual([])
  const good = validateList('[{"sessionId": "x", "cwd": "/a", "status": "idle"}]')
  expect(Array.isArray(good)).toBe(true)
})

test('Stop: Stop & Remove is the second option, and only the dialog options do anything', () => {
  expect(STOP_OPTIONS).toEqual(['Stop', 'Stop & Remove', 'Cancel'])
  expect(REMOVE_OPTIONS).toEqual(['Remove from list', 'Cancel'])
  expect(actionFromAnswer('Stop')).toBe('stop')
  expect(actionFromAnswer('Stop & Remove')).toBe('stop-rm')
  expect(actionFromAnswer('Remove from list')).toBe('rm')
  expect(actionFromAnswer('Cancel')).toBe(null)
  // What's typed by hand in "Type something" never stops anything
  expect(actionFromAnswer('stop')).toBe(null)
  expect(actionFromAnswer('Stop it please')).toBe(null)
})

test("notices between sessions: round trip with format and kind, and nothing if the text isn't a notice", () => {
  const m = buildNotice('ask', { from: 'abc', topic: 'stop' })
  expect(parseNotice(m)).toEqual({ format: 2, kind: 'ask', data: { format: 2, kind: 'ask', from: 'abc', topic: 'stop' } })
  // Even if Claude wraps something around it when delivering it
  expect(parseNotice(`<from peer>${m}</from peer>`)?.kind).toBe('ask')
  expect(parseNotice('sessions-notice:7f3a no data')).toBe(null)
  expect(parseNotice('sessions-notice:7f3a [1, 2]')).toBe(null)
  expect(parseNotice('hello')).toBe(null)
  // A notice from another format is still recognized (to be consumed and reported), with its format
  expect(parseNotice('sessions-notice:7f3a {"format": 2, "kind": "focus"}')?.format).toBe(2)
})

test('selected row when the chosen one leaves the list: the next one, or the previous one if it was the last', () => {
  expect(neighbor(['a', 'b', 'c'], 'b')).toBe('c')
  expect(neighbor(['a', 'b', 'c'], 'c')).toBe('b')
  expect(neighbor(['a'], 'a')).toBe(undefined)
  expect(neighbor(['a', 'b'], 'z')).toBe('a')
})

test('selected row when the one that had the focus already left the list', () => {
  expect(remainingNeighbor(['a', 'b', 'c', 'd'], 'b', ['a', 'c', 'd'])).toBe('c')
  // The next one left too: the next one that remains
  expect(remainingNeighbor(['a', 'b', 'c', 'd'], 'b', ['a', 'd'])).toBe('d')
  // It was the last one: the previous one that remains
  expect(remainingNeighbor(['a', 'b', 'c'], 'c', ['a'])).toBe('a')
  expect(remainingNeighbor(['a'], 'a', [])).toBe(undefined)
  expect(remainingNeighbor(['a', 'b'], 'z', ['b'])).toBe('b')
})

test("Restart: only the dialog's answer triggers it", () => {
  expect(RESTART_OPTIONS).toEqual(['Restart', 'Cancel'])
  expect(actionFromAnswer('Restart')).toBe('restart')
  expect(actionFromAnswer('restart')).toBe(null)
  expect(actionFromAnswer('Cancel')).toBe(null)
})

test('versions: what claude --version says and which one is newer', () => {
  expect(parseVersion('2.1.291 (Claude Code)')).toBe('2.1.291')
  expect(parseVersion('2.1.291')).toBe('2.1.291')
  expect(parseVersion('\x1b[1m2.1.291\x1b[0m')).toBe(null)
  expect(parseVersion('Claude Code 2.1.291')).toBe(null)
  expect(compareVersions('2.1.289', '2.1.291')).toBe(-1)
  expect(compareVersions('2.1.291', '2.1.291')).toBe(0)
  expect(compareVersions('2.1.10', '2.1.9')).toBe(1)
  expect(compareVersions('2.2.0', '2.1.300')).toBe(1)
  // Something that isn't understood never marks a session as outdated
  expect(compareVersions('', '2.1.291')).toBe(0)
  expect(compareVersions('2.1.291', 'something')).toBe(0)
})

test('version of a session with an old mod: the program its process runs', () => {
  expect(versionFromExecutable('p123\nfcwd\nn/Users/x/.local/share/claude/versions/2.1.289\n')).toBe('2.1.289')
  expect(versionFromExecutable('p123\nn/opt/homebrew/bin/claude\n')).toBe(null)
  expect(versionFromExecutable('')).toBe(null)
})

test("background tasks: artifact watches don't count, as in Claude's background service", () => {
  // A session watching two artifacts, nothing else
  expect(realTasks({ tasks: 2, queued: 0, kinds: ['artifact_watch'], drainableMonitors: 2 })).toEqual({ count: 0, kinds: [] })
  // A background terminal task does count
  expect(realTasks({ tasks: 1, queued: 0, kinds: ['local_bash'], drainableMonitors: 0 })).toEqual({ count: 1, kinds: ['local_bash'] })
  // Both together: only the terminal one
  expect(realTasks({ tasks: 3, kinds: ['artifact_watch', 'local_bash'], drainableMonitors: 2 })).toEqual({ count: 1, kinds: ['local_bash'] })
  expect(realTasks({ tasks: 0, kinds: [] })).toEqual({ count: 0, kinds: [] })
  expect(realTasks(undefined)).toBe(null)
})

test('usage: short numbers', () => {
  expect(abbreviate(0)).toBe('0')
  expect(abbreviate(850)).toBe('850')
  expect(abbreviate(1234)).toBe('1.2k')
  expect(abbreviate(18000)).toBe('18k')
  expect(abbreviate(412345)).toBe('412k')
  expect(abbreviate(999999)).toBe('1M')
  expect(abbreviate(41234567)).toBe('41M')
  expect(abbreviate(4321098765)).toBe('4.3B')
})

test('usage: one-line bars', () => {
  expect(sparkline([0, 1, 2, 4, 8], 5)).toBe(' ▁▂▄█')
  // Few values and lots of room: each one takes up to 3 columns
  expect(sparkline([1, 2], 40)).toBe('▄▄▄███')
  // Many values and little room: the last ones are shown
  expect(sparkline([8, 8, 8, 1, 8], 3)).toBe('█▁█')
  expect(sparkline([0, 0], 10)).toBe('      ')
  expect(sparkline([], 10)).toBe('')
})

test('usage: days in the window, also across month and year boundaries', () => {
  expect(daysUpTo('2026-10-06', 3)).toEqual(['2026-10-04', '2026-10-05', '2026-10-06'])
  expect(daysUpTo('2026-03-01', 2)).toEqual(['2026-02-28', '2026-03-01'])
  expect(daysUpTo('2027-01-01', 2)).toEqual(['2026-12-31', '2027-01-01'])
  expect(daysUpTo('2026-10-06', 30)).toHaveLength(30)
})

test('usage: sum for the period and per folder', () => {
  const r = {
    today: '2026-10-06',
    hour: '2026-10-06T02',
    days: {
      '/myapp': { '2026-10-06': [1, 10, 100, 5, 4], '2026-10-01': [2, 20, 200, 6, 3], '2026-09-01': [9, 9, 9, 9, 9] },
      '/other': { '2026-10-06': [1, 1, 1, 1, 0] },
    },
    hours: { '/myapp': { '2026-10-06T00': [1, 2, 3, 4, 1], '2026-10-06T02': [0, 1, 0, 0, 0], '2026-10-05T23': [5, 5, 5, 5, 5] } },
  }
  const all = () => true
  const week = usageWindow(r, 'week', all)
  expect(week.bars).toEqual([0, 228, 0, 0, 0, 0, 120])
  expect(week.totals).toEqual([4, 31, 301, 12, 7])
  // Sep 1 falls outside the 30 days
  expect(usageWindow(r, 'month', all).totals).toEqual([4, 31, 301, 12, 7])
  expect(usageWindow(r, 'week', cwd => cwd === '/other').totals).toEqual([1, 1, 1, 1, 0])
  // Today: per hour, from 00 to the current hour (yesterday's doesn't count)
  const today = usageWindow(r, 'day', all)
  expect(today.bars).toEqual([10, 0, 1])
  expect(today.totals).toEqual([1, 3, 3, 4, 1])
})

test('usage: the block goes at the bottom with the panel docked, and p switches between all and this project', async $ => {
  const surface = 'terminal'
  const ui = await $.ui.mount({ plugin: 'sessions', surface, component: 'Pane', props: PANE, requestId: 'sessions' })
  for (const key of ['usage-day', 'usage-week', 'usage-month', 'usage-scope']) expect(await ui.find({ key })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('Reading token usage')
  expect(JSON.stringify(await ui.drawn())).toContain('All')
  await $.ui.press({ plugin: 'sessions', key: 'usage-scope', requestId: 'sessions', surface })
  expect(JSON.stringify(await ui.drawn())).toContain('Project')
})

test("usage: in the box above the prompt (panel not docked) the block doesn't appear", async $ => {
  const ui = await $.ui.mount({ plugin: 'sessions', surface: 'terminal', component: 'Pane', props: { ...PANE, placement: 'inline' }, requestId: 'sessions' })
  expect(await ui.find({ key: 'usage-day' })).toBe(undefined)
})

test('project: the root and its subfolders, but in the home folder only that folder', () => {
  const home = '/Users/x'
  expect(inProject('/Users/x/myapp', '/Users/x/myapp', home)).toBe(true)
  expect(inProject('/Users/x/myapp/src', '/Users/x/myapp', home)).toBe(true)
  expect(inProject('/Users/x/myapp old', '/Users/x/myapp', home)).toBe(false)
  expect(inProject('/Users/x/Projects/Other', '/Users/x/myapp', home)).toBe(false)
  // Opened in ~: only what's in ~, not everything on the computer
  expect(inProject('/Users/x', home, home)).toBe(true)
  expect(inProject('/Users/x/Projects/Other', home, home)).toBe(false)
  expect(inProject('/Users/x/myapp', home, home)).toBe(false)
  // Without knowing the home folder, same as before
  expect(inProject('/Users/x/myapp', '/Users/x', '')).toBe(true)
})

test('why a session stopped: retired for being idle, closed for lack of memory, or stopped some other way, until it starts again', () => {
  const log = [
    '[2026-10-26T12:41:57.100Z] [bg] bg: low memory persists after shedding non-pinned — retiring pinned settled workers as a last resort',
    '[2026-10-26T12:41:57.273Z] [bg] bg retire dddddddd: settled, idle 38h [low memory, pinned]',
    '[2026-10-26T12:41:57.281Z] [bg] bg retire eeeeeeee: settled, idle 33h [low memory, pinned]',
    '[2026-10-26T12:41:58.000Z] [bg] bg retire aaaaaaaa: settled, idle 2h [low memory]',
    '[2026-10-26T12:41:59.204Z] [bg] bg settled dddddddd (done)',
    '[2026-10-26T12:41:59.215Z] [bg] bg settled eeeeeeee (done)',
    // eeeeeeee started again: it no longer counts
    '[2026-10-26T13:10:00.000Z] [bg] bg claimed-spare eeeeeeee (fleet)',
    // bbbbbbbb was closed for being idle (not for memory)
    '[2026-10-26T13:20:00.000Z] [bg] bg retire bbbbbbbb: settled, idle 8h',
    'a line that is not in this format',
  ].join('\n')
  expect(stopReasons(log)).toEqual({
    dddddddd: { at: Date.parse('2026-10-26T12:41:57.273Z'), why: 'low-memory' },
    aaaaaaaa: { at: Date.parse('2026-10-26T12:41:58.000Z'), why: 'low-memory' },
    bbbbbbbb: { at: Date.parse('2026-10-26T13:20:00.000Z'), why: 'idle' },
  })
  // Closed for memory and later again for another reason: that reason is the one
  expect(stopReasons(log + '\n[2026-10-26T14:00:00.000Z] [bg] bg retire dddddddd: idle-prompt, idle 1h').dddddddd?.why).toBe('idle')
  // A process that ends with no retire before it was stopped some other way (the person, a crash)
  expect(stopReasons(log + '\n[2026-10-26T14:00:00.000Z] [bg] bg claimed-spare cccccccc (fleet)\n[2026-10-26T15:00:00.000Z] [bg] bg settled cccccccc (killed)').cccccccc).toEqual({ at: Date.parse('2026-10-26T15:00:00.000Z'), why: 'stopped' })
  expect(stopReasons('')).toEqual({})
})

test('reopen: only those from the last 2 h count towards the limit', () => {
  const now = 10_000_000
  expect(recentReopens([now - 1000, now - 7_300_000, 'x'], now)).toEqual([now - 1000])
  expect(recentReopens(undefined, now)).toEqual([])
})

// One window of each kind, as `ps -A -o pid=,tty=,command=` lists them on macOS and on Linux
const PS_MAC = [
  '  101 ttys001  bash /Users/x/.claude/plugins/cache/m/sessions/0.10.0/hooks/visor.sh attach aaaaaaaa',
  '  102 ttys001  claude attach aaaaaaaa',
  '  103 ttys002  claude agents --cwd .',
  '  104 ttys002  bash /Users/x/.claude/plugins/cache/m/sessions/0.10.0/hooks/visor.sh agents',
  '  105 ??       /Users/x/.local/share/claude/stable/claude --bg-spare /tmp/x.sock',
  '  106 ttys003  claude',
].join('\n')
const PS_LINUX = [
  ' 2001 pts/0    bash /home/x/.claude/plugins/cache/m/sessions/0.10.0/hooks/visor.sh attach aaaaaaaa',
  ' 2002 pts/0    claude attach aaaaaaaa',
  ' 2003 ?        /home/x/.local/share/claude/versions/2.1.314 --bg-spare /tmp/x.sock',
  ' 2004 pts/1    claude attach aaaaaaaa',
  ' 2005 pts/2    claude attach bbbbbbbb',
].join('\n')

test('windows: viewers, agent views and launchers, from ps on macOS and on Linux', () => {
  const mac = parseWindows(PS_MAC)
  expect(mac.byId).toEqual({ aaaaaaaa: ['/dev/ttys001'] })
  expect(mac.agentsViews).toEqual([{ pid: '103', tty: '/dev/ttys002' }])
  expect(mac.launchers).toEqual({ '/dev/ttys001': '101', '/dev/ttys002': '104' })
  expect(mac.byPid['105']).toBe(undefined)
  const linux = parseWindows(PS_LINUX)
  expect(linux.byId).toEqual({ aaaaaaaa: ['/dev/pts/0', '/dev/pts/1'], bbbbbbbb: ['/dev/pts/2'] })
  expect(linux.clients['/dev/pts/1']).toBe('2004')
  expect(linux.launchers).toEqual({ '/dev/pts/0': '2001' })
  expect(linux.byPid['2003']).toBe(undefined)
})

test('order: the panel order (waiting, done, working, idle, stopped, then title) and its file round trip', () => {
  const rows = [
    { sessionId: 's1', color: 'green' as const, id: 'aaaaaaaa', title: 'beta' },
    { sessionId: 's2', color: 'red' as const, id: 'bbbbbbbb', title: 'zeta' },
    { sessionId: 's3', color: 'gray' as const, id: null, title: 'alpha' },
    { sessionId: 's4', color: 'green' as const, id: 'cccccccc', title: 'alpha\tx' },
    { sessionId: 's5', color: 'yellow' as const, id: 'dddddddd', title: 'mid' },
  ]
  const sorted = sortRows(rows)
  expect(sorted.map(r => r.sessionId)).toEqual(['s2', 's5', 's4', 's1', 's3'])
  const text = orderFileText('/Users/x/myapp', sorted, 1234)
  const back = parseOrderFile(text)
  expect(back?.format).toBe(2)
  expect(back?.at).toBe(1234)
  expect(back?.root).toBe('/Users/x/myapp')
  expect(back?.rows.map(r => r.sessionId)).toEqual(['s2', 's5', 's4', 's1', 's3'])
  // A tab in a title doesn't break the columns; a stopped regular session has no id
  expect(back?.rows[2]).toEqual({ sessionId: 's4', color: 'green', id: 'cccccccc', title: 'alpha x' })
  expect(back?.rows[4]?.id).toBe(null)
  expect(fileKey('/Users/x/myapp')).toBe('_Users_x_myapp')
})

test('shared files: key=value lines, one value per key, line breaks flattened', () => {
  expect(keyLines({ format: 1, title: 'a\nb', none: undefined })).toBe('format=1\ntitle=a b\n')
  expect(parseKeyLines('format=1\ntitle=x=y\nformat=2\njunk\n')).toEqual({ format: '1', title: 'x=y' })
  expect(windowTargetText({ command: 'attach', id: 'aaaaaaaa', title: 'One' })).toBe('format=2\ncommand=attach\nid=aaaaaaaa\ntitle=One\n')
  expect(windowTargetText({ command: 'agents', title: 'Agents', folder: '/Users/x/myapp' })).toBe('format=2\ncommand=agents\ntitle=Agents\nfolder=/Users/x/myapp\n')
  expect(parseInbox('format=1\naction=bring\nat=5\ntty=/dev/ttys001\nreply=/r\n')).toEqual({ format: 1, action: 'bring', at: 5, tty: '/dev/ttys001', title: '', reply: '/r', ref: '' })
  expect(parseInbox('action=focus\n')).toBe(null)
})

test('heartbeat: fresh, same format and same process is ok; old, missing or another process is missing', () => {
  const now = 1_000_000
  const h = parseHeartbeat(heartbeatText({ pid: 42, at: now - 10000, version: '0.10.0', via: 'session.start' }))
  expect(h).toEqual({ format: 2, pid: 42, at: now - 10000, version: '0.10.0', via: 'session.start' })
  expect(heartbeatStatus(h, 42, now)).toBe('ok')
  expect(heartbeatStatus(h, 43, now)).toBe('missing')
  expect(heartbeatStatus(h, undefined, now)).toBe('ok')
  expect(heartbeatStatus(h, 42, now + 40000)).toBe('missing')
  expect(heartbeatStatus(null, 42, now)).toBe('missing')
  expect(heartbeatStatus({ ...(h as Heartbeat), format: 1 }, 42, now)).toBe('other-format')
  // Written before the mod knew its pid: no pid to compare
  expect(heartbeatStatus({ ...(h as Heartbeat), pid: 0 }, 42, now)).toBe('ok')
  expect(parseHeartbeat('pid=1\n')).toBe(null)
})

test('heartbeat expected: a running session started after a version with heartbeats was installed, after 30 s', () => {
  const now = 10_000_000
  const plugin = { version: '0.10.0', since: 5_000_000 }
  const s = { pid: 1, status: 'idle', startedAt: 6_000_000 }
  expect(expectsHeartbeat(s, plugin, now)).toBe(true)
  // Started before that version was installed: it runs an older mod, which a restart would fix but isn't broken
  expect(expectsHeartbeat({ ...s, startedAt: 4_000_000 }, plugin, now)).toBe(false)
  // The installed version doesn't write heartbeats (development: a test session with the repo's copy)
  expect(expectsHeartbeat(s, { ...plugin, version: '0.9.2' }, now)).toBe(false)
  expect(expectsHeartbeat(s, { ...plugin, version: 'x' }, now)).toBe(false)
  expect(expectsHeartbeat(s, null, now)).toBe(false)
  // Just started: its mod has 30 s to come up
  expect(expectsHeartbeat({ ...s, startedAt: now - 10000 }, plugin, now)).toBe(false)
  // Stopped
  expect(expectsHeartbeat({ startedAt: 6_000_000 }, plugin, now)).toBe(false)
  expect(HEARTBEAT_VERSION).toBe('0.10.0')
})

test('installed plugin: the enabled sessions entry of claude plugin list --json', () => {
  const list = JSON.stringify([
    { id: 'other@m', version: '1.0.0', enabled: true, installPath: '/x/other' },
    { id: 'sessions@m', version: '0.10.0', enabled: true, installPath: '/Users/x/.claude/plugins/cache/m/sessions/0.10.0', lastUpdated: '2026-01-01T00:00:00.000Z' },
  ])
  expect(parsePluginList(list)).toEqual({ path: '/Users/x/.claude/plugins/cache/m/sessions/0.10.0', version: '0.10.0', since: Date.parse('2026-01-01T00:00:00.000Z') })
  expect(parsePluginList(JSON.stringify([{ id: 'sessions@m', version: '0.10.0', enabled: false, installPath: '/x' }]))).toBe(null)
  expect(parsePluginList('nope')).toBe(null)
})

test('project root: the nearest folder with AGENTS.md or CLAUDE.md, below the top two levels', () => {
  expect(rootFrom('/Users/x/myapp/src', ['/Users/x/myapp'])).toBe('/Users/x/myapp')
  expect(rootFrom('/Users/x/myapp/src', ['/Users/x/myapp', '/Users/x/myapp/src'])).toBe('/Users/x/myapp/src')
  expect(rootFrom('/Users/x/myapp/src', [])).toBe('/Users/x/myapp/src')
  // /Users/CLAUDE.md is too high up
  expect(rootFrom('/Users/x/myapp', ['/Users'])).toBe('/Users/x/myapp')
  // A marker on another branch doesn't count
  expect(rootFrom('/Users/x/myapp', ['/Users/x/other'])).toBe('/Users/x/myapp')
})

test('project root: the folders to look for a marker in, outermost first, below the top two levels', () => {
  expect(rootCandidates('/Users/x/myapp/src')).toEqual(['/Users/x/myapp', '/Users/x/myapp/src'])
  expect(rootCandidates('/Users/x/myapp/')).toEqual(['/Users/x/myapp'])
  expect(rootCandidates('/Users/x')).toEqual([])
  expect(rootCandidates('/')).toEqual([])
})

test('automatic names: the folder and two hex characters, never one the project already uses', () => {
  const digits = ['1', 'f', '1', 'f', 'a', '0']
  let i = 0
  const random = () => digits[i++ % digits.length] as string
  expect(autoName('/Users/x/myapp', [], random)).toBe('myapp-1f')
  i = 0
  // myapp-1f is taken: the next draw
  expect(autoName('/Users/x/myapp', ['myapp-1f', 'other'], random)).toBe('myapp-a0')
  expect(autoName('/', [], () => '0')).toBe('session-00')
})

test('debug log names: the session name with anything unusual replaced', () => {
  expect(debugLogName('TEST one')).toBe('TEST_one.log')
  expect(debugLogName('../x/y')).toBe('x_y.log')
  expect(debugLogName('')).toBe('session.log')
})

test('pinned: with no record of what the mod pinned, the pinned sessions with Remote Control on become the mod\'s', () => {
  const auto = adoptAutoPins(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'], { aaaaaaaa: true, bbbbbbbb: false, cccccccc: null, dddddddd: true })
  // Only pinned ones (dddddddd isn't pinned), and only with Remote Control on for sure
  expect(auto).toEqual({ ids: ['aaaaaaaa'], released: [] })
  // From then on the usual rules: Remote Control off unpins the adopted one, and leaves the others
  const r = reconcilePins(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'], { aaaaaaaa: false, bbbbbbbb: false, cccccccc: null }, auto)
  expect(r.toUnpin).toEqual(['aaaaaaaa'])
  expect(r.pins).toEqual(['bbbbbbbb', 'cccccccc'])
  expect(adoptAutoPins([], { aaaaaaaa: true })).toEqual({ ids: [], released: [] })
})

test('updating in place: only to a newer version of the same install, once, and only when it cuts nothing', () => {
  const base = {
    running: '0.10.0',
    runningDir: '/Users/x/.claude/plugins/cache/m/sessions/0.10.0',
    installed: { path: '/Users/x/.claude/plugins/cache/m/sessions/0.11.0', version: '0.11.0', since: 0 },
    triedFor: '',
    status: 'idle',
    tasks: 0,
    paneFocused: false,
    fieldOpen: false,
  }
  expect(reloadDecision(base)).toBe('reload')
  // Not newer, not installed, or another copy (a folder copy, in development)
  expect(reloadDecision({ ...base, installed: { ...base.installed, version: '0.10.0' } })).toBe('no')
  expect(reloadDecision({ ...base, installed: null })).toBe('no')
  expect(reloadDecision({ ...base, runningDir: '/Users/x/src/claude-plugins/plugins/sessions' })).toBe('no')
  // Once per version: if it didn't take, the ↑ mark and u remain
  expect(reloadDecision({ ...base, triedFor: '0.11.0' })).toBe('no')
  expect(reloadDecision({ ...base, triedFor: '0.10.5' })).toBe('reload')
  // Not now: working, waiting for you, background tasks (or unknown), you in the panel or in a field
  expect(reloadDecision({ ...base, status: 'busy' })).toBe('wait')
  expect(reloadDecision({ ...base, status: 'waiting' })).toBe('wait')
  expect(reloadDecision({ ...base, status: null })).toBe('wait')
  expect(reloadDecision({ ...base, tasks: 1 })).toBe('wait')
  expect(reloadDecision({ ...base, tasks: null })).toBe('wait')
  expect(reloadDecision({ ...base, paneFocused: true })).toBe('wait')
  expect(reloadDecision({ ...base, fieldOpen: true })).toBe('wait')
})

test('refs: the official short id, or sid:<sessionId> for a regular session (it has none)', () => {
  expect(refOf({ id: 'aaaaaaaa', sessionId: 'aaaaaaaa-0000' })).toBe('aaaaaaaa')
  expect(refOf({ sessionId: 'cccccccc-0000' })).toBe('sid:cccccccc-0000')
  expect(refOf({ id: '', sessionId: 'cccccccc-0000' })).toBe('sid:cccccccc-0000')
})

test("agent: the transcript's last agent-setting row, and only a row that is one", () => {
  expect(agentFromTranscript('{"type":"agent-setting","agentSetting":"scout","sessionId":"x"}\n')).toBe('scout')
  // Written again when the session is resumed or restarted: the last one says
  expect(agentFromTranscript('{"type":"agent-setting","agentSetting":"scout"}\n{"type":"agent-setting","agentSetting":"judge"}')).toBe('judge')
  // A message that mentions one isn't one
  expect(agentFromTranscript('{"parentUuid":null,"type":"user","message":{"content":"{\\"type\\":\\"agent-setting\\",\\"agentSetting\\":\\"x\\"}"}}')).toBe(null)
  expect(agentFromTranscript('{"type":"agent-setting"')).toBe(null)
  expect(agentFromTranscript('')).toBe(null)
})

// Rows as groupRows needs them: a ref, a color and a title
const row = (ref: string, color: 'red' | 'blue' | 'yellow' | 'green' | 'gray', title: string) => ({ sessionId: `${ref}-0000`, ref, color, title })
const VIEW: SectionsView = {
  sections: [
    { id: 'me:renders', title: 'Renders', order: 100, owner: 'person' },
    { id: 'probe:desk', title: 'Desk', order: 10, owner: 'probe' },
    { id: 'me:alpha', title: 'Alpha', order: 100, owner: 'person' },
  ],
  members: {
    bbbbbbbb: { section: 'me:renders', by: 'person' },
    cccccccc: { section: 'probe:desk', by: 'probe' },
    dddddddd: { section: 'me:alpha', by: 'person' },
    eeeeeeee: { section: 'me:renders', by: 'person' },
    // A member of a section that isn't defined counts as in none
    ffffffff: { section: 'me:gone', by: 'person' },
  },
}

test('sections: no section first with no header, then sections by order and title, each in the usual order', () => {
  const rows = [row('aaaaaaaa', 'green', 'one'), row('bbbbbbbb', 'green', 'two'), row('cccccccc', 'blue', 'three'), row('dddddddd', 'gray', 'four'), row('eeeeeeee', 'red', 'five'), row('ffffffff', 'red', 'six')]
  const g = groupRows(rows, VIEW)
  expect(g.map(r => `${r.section}/${r.title}`)).toEqual(['/six', '/one', 'probe:desk/three', 'me:alpha/four', 'me:renders/five', 'me:renders/two'])
  expect(sectionHeaders(g)).toEqual([null, null, 'Desk', 'Alpha', 'Renders', null])
  // Only one group with rows: no headers at all, so a project that uses no sections looks as it always did
  expect(sectionHeaders(groupRows(rows.slice(0, 1), VIEW))).toEqual([null])
  expect(sectionHeaders(groupRows([rows[1], rows[4]] as any, VIEW))).toEqual([null, null])
  // Everything in sections: every section gets its header
  expect(sectionHeaders(groupRows([rows[1], rows[2]] as any, VIEW))).toEqual(['Desk', 'Renders'])
  // No sections at all: the usual order
  expect(groupRows(rows, { sections: [], members: {} }).map(r => r.title)).toEqual(sortRows(rows).map(r => r.title))
})

test('sections: while focused nothing moves, sections included; new rows go at the end; on leaving, the layout applies', () => {
  const before = groupRows([row('aaaaaaaa', 'green', 'one'), row('bbbbbbbb', 'green', 'two')], { sections: [], members: {} })
  // b turned red (it would go first) and was put in a section meanwhile; c is new
  const now = groupRows([row('aaaaaaaa', 'green', 'one'), row('bbbbbbbb', 'red', 'two'), row('cccccccc', 'green', 'three')], VIEW)
  const frozen = keepPlaces(now, before, true)
  expect(frozen.map(r => [r.title, r.section])).toEqual([['one', ''], ['two', ''], ['three', 'probe:desk']])
  expect(frozen[1]?.color).toBe('red')
  expect(keepPlaces(now, before, false).map(r => r.title)).toEqual(['one', 'three', 'two'])
})

test('sections file: its own sectionsFormat, unknown fields kept, a newer one never read as this one', () => {
  const text = JSON.stringify({ sectionsFormat: 1, later: 'kept', sections: [{ id: 'me:renders', title: 'Renders', order: 100, owner: 'person', color: 'kept' }], members: {} })
  const parsed = parseSectionsFile(text)
  if (!('file' in parsed)) throw new Error('should parse')
  const p = personAssign(parsed.file, 'aaaaaaaa', 'renders')
  if (!('file' in p)) throw new Error('should assign')
  const back = JSON.parse(sectionsFileText(p.file))
  expect(back.later).toBe('kept')
  expect(back.sections[0].color).toBe('kept')
  expect(back.members).toEqual({ aaaaaaaa: { section: 'me:renders', by: 'person' } })
  expect((parseSectionsFile(JSON.stringify({ sectionsFormat: 2 })) as any).problem).toContain('newer sessions')
  expect((parseSectionsFile('{nope') as any).problem).toContain("isn't valid JSON")
  expect((parseSectionsFile('{}') as any).problem).toContain('sectionsFormat')
  // Malformed entries are left out of what's read
  const view = sectionsView({ sectionsFormat: 1, sections: [{ id: 'x' }, { id: 'me:a', title: 'A' }, { id: 'me:a', title: 'again' }], members: { r: { section: 1 }, s: { section: 'me:a', by: 'person' } } })
  expect(view).toEqual({ sections: [{ id: 'me:a', title: 'A', order: 200, owner: 'person' }], members: { s: { section: 'me:a', by: 'person' } } })
})

test("sections: the person's own are made by title and go when the last session leaves them", () => {
  const a = personAssign(emptySectionsFile(), 'aaaaaaaa', ' Big  renders! ')
  if (!('file' in a)) throw new Error('should assign')
  expect(a.section).toEqual({ id: 'me:big-renders', title: 'Big renders!', order: 100, owner: 'person' })
  // The same title another way finds the same section, and keeps its first title
  const b = personAssign(a.file, 'bbbbbbbb', 'BIG RENDERS')
  if (!('file' in b)) throw new Error('should assign')
  expect(sectionsView(b.file).sections).toHaveLength(1)
  expect(b.section?.title).toBe('Big renders!')
  const c = personAssign(b.file, 'aaaaaaaa', null)
  const d = 'file' in c ? personAssign(c.file, 'bbbbbbbb', null) : c
  expect('file' in d && sectionsView(d.file)).toEqual({ sections: [], members: {} })
  expect((personAssign(emptySectionsFile(), 'aaaaaaaa', '!!!') as any).problem).toBeDefined()
  expect(slugOf('Árbol de Renders')).toBe('arbol-de-renders')
  // Members of sessions that are gone go, and so do the person's sections they leave empty
  const pruned = pruneMembers(b.file, ref => ref === 'zzzzzzzz')
  expect(sectionsView(pruned)).toEqual({ sections: [], members: {} })
})

test('spend: read per session, a subscription by its windows, an API account by its cost', () => {
  // A subscription: whichever windows the account reports (the weekly one alone is fine), the cost is ignored
  expect(spendOf({ usd: 4, limits: [{ kind: 'seven_day', percent: 43 }] })).toEqual({ mode: 'subscription', limits: [{ kind: 'seven_day', percent: 43 }] })
  // No windows and a cost: an API account
  expect(spendOf({ usd: 1.2, limits: [] })).toEqual({ mode: 'api', usd: 1.2 })
  // Before the first response (no window, nothing spent) or nothing published: not known yet
  expect(spendOf({ usd: 0, limits: [] })).toEqual({ mode: 'unknown' })
  expect(spendOf(null)).toEqual({ mode: 'unknown' })
  expect(spendOf({ limits: [{ kind: 'seven_day' }] })).toEqual({ mode: 'unknown' })
  // What a session publishes from $.session.usage(): its cost to the cent, each window once
  expect(
    publishedSpend({
      rateLimits: [
        { kind: 'five_hour', percentUsed: 12.5 },
        { kind: 'seven_day', percentUsed: 43, resetsAt: 'x' },
        { kind: 'seven_day', percentUsed: 44 },
      ],
      cost: { usd: 1.23456 },
    }),
  ).toEqual({ usd: 1.23, limits: [{ kind: 'five_hour', percent: 12.5 }, { kind: 'seven_day', percent: 43 }] })
  expect(publishedSpend({ rateLimits: [] })).toEqual({ usd: undefined, limits: [] })
  expect(publishedSpend(undefined)).toEqual({ usd: undefined, limits: [] })
  expect(limitsText([{ kind: 'five_hour', percent: 12.5 }, { kind: 'seven_day', percent: 43.4 }, { kind: 'spend_limit', percent: 101 }])).toBe('5h 13% · 7d 43% · limit 101%')
  expect(limitsText([])).toBe('')
  expect([0.04, 1.2, 20.04, 123.4, 1234].map(formatUsd)).toEqual(['$0.04', '$1.20', '$20.04', '$123', '$1.2k'])
  // The spend column widens the panel as much as it needs
  expect(paneWidth(['Refactor the payment retry handling'], 89, 7)).toBe(67)
})

test('the f filter: a snapshot of who waits for you, taken at the toggle and whenever the panel lacks the keyboard', () => {
  const rows = [row('aaaaaaaa', 'red', 'one'), row('bbbbbbbb', 'green', 'two'), row('cccccccc', 'red', 'three')]
  expect(waitingMembers(rows, null, false, false)).toBe(null)
  // Turned on (no snapshot yet), focused or not: the red ones now
  expect([...(waitingMembers(rows, null, true, true) ?? [])]).toEqual(['aaaaaaaa-0000', 'cccccccc-0000'])
  // While focused it's kept, whatever changed: a row answered stays, a new red one doesn't come in
  const later = [row('aaaaaaaa', 'green', 'one'), row('bbbbbbbb', 'red', 'two'), row('cccccccc', 'red', 'three')]
  const kept = waitingMembers(later, new Set(['aaaaaaaa-0000', 'cccccccc-0000']), true, true)
  expect([...(kept ?? [])]).toEqual(['aaaaaaaa-0000', 'cccccccc-0000'])
  // Without the keyboard: taken again
  expect([...(waitingMembers(later, kept, true, false) ?? [])]).toEqual(['bbbbbbbb-0000', 'cccccccc-0000'])
})

test('children: under their parent, in its section, one level; a parent not in the list leaves them as any row', () => {
  const view: SectionsView = {
    sections: [
      { id: 'probe:work', title: 'Work', order: 10, owner: 'probe' },
      { id: 'probe:test', title: 'Test', order: 20, owner: 'probe' },
    ],
    members: {
      aaaaaaaa: { section: 'probe:work', by: 'probe' },
      // In another section than its parent: drawn under the parent, in the parent's section
      bbbbbbbb: { section: 'probe:test', by: 'probe', parent: 'aaaaaaaa' },
      cccccccc: { section: 'probe:work', by: 'probe', parent: 'aaaaaaaa' },
      // A child of a child: one level only, so drawn as any row of its section
      dddddddd: { section: 'probe:work', by: 'probe', parent: 'cccccccc' },
      // Its parent isn't in the list: in its own section
      eeeeeeee: { section: 'probe:test', by: 'probe', parent: 'zzzzzzzz' },
    },
  }
  const rows = [row('aaaaaaaa', 'green', 'lead'), row('bbbbbbbb', 'green', 'tester'), row('cccccccc', 'red', 'sme'), row('dddddddd', 'green', 'deep'), row('eeeeeeee', 'green', 'orphan'), row('ffffffff', 'green', 'loose')]
  const g = groupRows(rows, view)
  expect(g.map(r => `${r.section}/${'  '.repeat(r.depth)}${r.title}`)).toEqual(['/loose', 'probe:work/deep', 'probe:work/lead', 'probe:work/  sme', 'probe:work/  tester', 'probe:test/orphan'])
  // Two sessions that name each other: neither is a child
  const loop = groupRows([row('aaaaaaaa', 'green', 'a'), row('bbbbbbbb', 'green', 'b')], { sections: view.sections, members: { aaaaaaaa: { section: 'probe:work', by: 'probe', parent: 'bbbbbbbb' }, bbbbbbbb: { section: 'probe:work', by: 'probe', parent: 'aaaaaaaa' } } })
  expect(loop.map(r => r.depth)).toEqual([0, 0])
})

test("children: a parent that waits for the person in another section (a plugin's \"Asking you\") leaves them in their own", () => {
  const view: SectionsView = {
    sections: [
      { id: 'probe:asking', title: 'Asking you', order: 5, owner: 'probe' },
      { id: 'probe:poc', title: 'Proofs', order: 10, owner: 'probe' },
    ],
    members: {
      aaaaaaaa: { section: 'probe:asking', by: 'probe' },
      bbbbbbbb: { section: 'probe:poc', by: 'probe', parent: 'aaaaaaaa' },
      cccccccc: { section: 'probe:poc', by: 'probe' },
    },
  }
  const drawn = (lead: ReturnType<typeof row> & { needsPerson?: boolean }) =>
    groupRows([lead, row('bbbbbbbb', 'green', 'poc a'), row('cccccccc', 'green', 'poc b')], view).map(r => `${r.section}/${'  '.repeat(r.depth)}${r.title}`)
  // Asking (marked as needing the person, or red): the child isn't the one waiting
  expect(drawn({ ...row('aaaaaaaa', 'blue', 'lead'), needsPerson: true })).toEqual(['probe:asking/lead', 'probe:poc/poc a', 'probe:poc/poc b'])
  expect(drawn(row('aaaaaaaa', 'red', 'lead'))).toEqual(['probe:asking/lead', 'probe:poc/poc a', 'probe:poc/poc b'])
  // Not waiting: under it, in its section, as before
  expect(drawn(row('aaaaaaaa', 'blue', 'lead'))).toEqual(['probe:asking/lead', 'probe:asking/  poc a', 'probe:poc/poc b'])
  // Waiting in the child's own section: still under it
  const same = groupRows([row('aaaaaaaa', 'red', 'lead'), row('bbbbbbbb', 'green', 'poc a')], { ...view, members: { ...view.members, aaaaaaaa: { section: 'probe:poc', by: 'probe' } } })
  expect(same.map(r => r.depth)).toEqual([0, 1])
})

test('children and folds stay put while focused: a row keeps its indent and fold, a new one goes at the end as any row', () => {
  const view: SectionsView = { sections: [{ id: 'probe:work', title: 'Work', order: 10, owner: 'probe' }], members: { bbbbbbbb: { section: 'probe:work', by: 'probe', parent: 'aaaaaaaa' } } }
  const before = groupRows([row('aaaaaaaa', 'green', 'lead'), row('bbbbbbbb', 'green', 'sme')], { sections: [], members: {} }).map(r => ({ ...r, folded: false }))
  const now = foldRows(groupRows([row('aaaaaaaa', 'green', 'lead'), row('bbbbbbbb', 'green', 'sme'), row('cccccccc', 'green', 'new')], { ...view, members: { ...view.members, cccccccc: { section: 'probe:work', by: 'probe', parent: 'aaaaaaaa' } } }), new Set(['probe:work']), false)
  const frozen = keepPlaces(now, before, true)
  expect(frozen.map(r => [r.title, r.depth, r.folded])).toEqual([['lead', 0, false], ['sme', 0, false], ['new', 0, false]])
  expect(keepPlaces(now, before, false).map(r => [r.title, r.depth])).toEqual([['lead', 0], ['new', 1], ['sme', 1]])
})

test('folds: a folded section draws one line with its count and who waits, the arrows go through it, and f unfolds everything', () => {
  const rows = groupRows([row('aaaaaaaa', 'green', 'one'), row('bbbbbbbb', 'red', 'two'), row('cccccccc', 'green', 'three'), row('eeeeeeee', 'green', 'five')], VIEW)
  const folded = foldRows(rows, new Set(['me:renders']), false)
  const plan = drawPlan(folded)
  expect(plan.map(it => (it.kind === 'row' ? it.row.title : it.kind === 'fold' ? `fold ${it.title} ${it.count} ${it.waiting}` : `header ${it.title}`))).toEqual(['one', 'header Desk', 'three', 'fold Renders 2 1'])
  expect(ringKeys(folded)).toEqual(['s:aaaaaaaa-0000', 's:cccccccc-0000', 'h:me:renders'])
  // With the f filter on nothing folds; nor does a section with no header (the only group)
  expect(foldRows(rows, new Set(['me:renders']), true).some(r => r.folded)).toBe(false)
  expect(foldRows(rows.filter(r => r.section === 'me:renders'), new Set(['me:renders']), false).some(r => r.folded)).toBe(false)
})

test('assignSection with a parent: kept with the member, cleared without one, refused for itself; the person moving it drops it', () => {
  const file = { sectionsFormat: 1, sections: [{ id: 'probe:work', title: 'Work', order: 10, owner: 'probe' }], members: {} }
  const a = assignChange(file, 'probe', 'bbbbbbbb', 'probe:work', 'aaaaaaaa')
  if (!('file' in a)) throw new Error('should assign')
  expect(sectionsView(a.file).members.bbbbbbbb).toEqual({ section: 'probe:work', by: 'probe', parent: 'aaaaaaaa' })
  expect(assignChange(a.file, 'probe', 'bbbbbbbb', 'probe:work', 'aaaaaaaa')).toEqual({ result: { ok: true } })
  const b = assignChange(a.file, 'probe', 'bbbbbbbb', 'probe:work')
  if (!('file' in b)) throw new Error('should assign')
  expect(sectionsView(b.file).members.bbbbbbbb).toEqual({ section: 'probe:work', by: 'probe' })
  expect((assignChange(file, 'probe', 'bbbbbbbb', 'probe:work', 'bbbbbbbb') as any).result.reason).toBe('invalid')
  expect((assignChange(file, 'probe', 'bbbbbbbb', null, 'aaaaaaaa') as any).result.reason).toBe('invalid')
  const p = personAssign(a.file, 'bbbbbbbb', 'Mine')
  if (!('file' in p)) throw new Error('should assign')
  expect(sectionsView(p.file).members.bbbbbbbb).toEqual({ section: 'me:mine', by: 'person' })
})
