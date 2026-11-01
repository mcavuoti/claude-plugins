import { expect, test } from 'claude-code/testing'

import {
  abbreviate,
  actionFromAnswer,
  reconcilePins,
  sparkline,
  closedForLowMemory,
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
  expect(parseNotice(m)).toEqual({ format: 1, kind: 'ask', data: { format: 1, kind: 'ask', from: 'abc', topic: 'stop' } })
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

test('reopen: only the ones whose last event was a closure for lack of memory', () => {
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
  expect(closedForLowMemory(log)).toEqual({ 'dddddddd': Date.parse('2026-10-26T12:41:57.273Z'), aaaaaaaa: Date.parse('2026-10-26T12:41:58.000Z') })
  // Closed for memory and later again for another reason: not reopened
  expect(closedForLowMemory(log + '\n[2026-10-26T14:00:00.000Z] [bg] bg retire dddddddd: stale-spare, idle 1h')['dddddddd']).toBe(undefined)
  expect(closedForLowMemory('')).toEqual({})
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
  expect(back?.format).toBe(1)
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
  expect(windowTargetText({ command: 'attach', id: 'aaaaaaaa', title: 'One' })).toBe('format=1\ncommand=attach\nid=aaaaaaaa\ntitle=One\n')
  expect(windowTargetText({ command: 'agents', title: 'Agents', folder: '/Users/x/myapp' })).toBe('format=1\ncommand=agents\ntitle=Agents\nfolder=/Users/x/myapp\n')
  expect(parseInbox('format=1\naction=bring\nat=5\ntty=/dev/ttys001\nreply=/r\n')).toEqual({ format: 1, action: 'bring', at: 5, tty: '/dev/ttys001', title: '', reply: '/r' })
  expect(parseInbox('action=focus\n')).toBe(null)
})

test('heartbeat: fresh, same format and same process is ok; old, missing or another process is missing', () => {
  const now = 1_000_000
  const h = parseHeartbeat(heartbeatText({ pid: 42, at: now - 10000, version: '0.10.0', via: 'session.start' }))
  expect(h).toEqual({ format: 1, pid: 42, at: now - 10000, version: '0.10.0', via: 'session.start' })
  expect(heartbeatStatus(h, 42, now)).toBe('ok')
  expect(heartbeatStatus(h, 43, now)).toBe('missing')
  expect(heartbeatStatus(h, undefined, now)).toBe('ok')
  expect(heartbeatStatus(h, 42, now + 40000)).toBe('missing')
  expect(heartbeatStatus(null, 42, now)).toBe('missing')
  expect(heartbeatStatus({ ...(h as Heartbeat), format: 2 }, 42, now)).toBe('other-format')
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
