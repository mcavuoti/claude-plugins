import { expect, test } from 'claude-code/testing'

import { BAND, DATA, ROOT, SID, startSession, world, type World } from './world'

// How the mod starts in a session (the world it sees is in world.ts)

test('session.start starts the mod once: heartbeat, panel and /sessions; a draw after it starts nothing more', async ($, on) => {
  const w = world(on)
  await startSession($, w)
  expect(w.registered).toEqual(['sessions'])
  expect(w.opens.filter(o => o.id === 'sessions').length).toBe(1)
  const beat = w.files.get(`${DATA}/alive/${SID}`) ?? ''
  expect(beat).toContain('format=1\n')
  expect(beat).toContain('via=session.start\n')
  expect(beat).toContain('version=0.10.0\n')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await w.clock.advance(100)
  expect(JSON.stringify(await ui.drawn())).toContain('"aaaaaaaa"')
  expect(w.registered).toEqual(['sessions'])
  await ui.unmount()
})

test('the band is shared: what Claude and other mods draw there stays, after this line, and a survey has it alone', async ($, on) => {
  const w = world(on)
  w.band.value = 'a line from another mod'
  await startSession($, w)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"aaaaaaaa"')
  expect(drawn).toContain('a line from another mod')
  expect(drawn.indexOf('aaaaaaaa')).toBeLessThan(drawn.indexOf('a line from another mod'))
  await ui.unmount()
  const survey = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  const alone = JSON.stringify(await survey.drawn())
  expect(alone).toContain('a line from another mod')
  expect(alone).not.toContain('aaaaaaaa')
  await survey.unmount()
})

test("without session.start, the first draw starts the mod (the old pre-started process case)", async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(w.registered).toEqual([])
  await w.clock.advance(10)
  expect(w.registered).toEqual(['sessions'])
  expect(w.files.get(`${DATA}/alive/${SID}`)).toContain('via=first draw\n')
  // A later session.start doesn't start it again
  await startSession($, w)
  expect(w.registered).toEqual(['sessions'])
  await ui.unmount()
})

test('a non-interactive run (claude -p) with nothing drawn does nothing', async ($, on) => {
  const w = world(on)
  await startSession($, w, false)
  await w.clock.advance(5000)
  expect(w.registered).toEqual([])
  expect(w.files.size).toBe(0)
})

test('the heartbeat is rewritten every 15 s, with the pid from the official list', async ($, on) => {
  const w = world(on)
  await startSession($, w)
  await w.clock.advance(16000)
  const beat = w.files.get(`${DATA}/alive/${SID}`) ?? ''
  expect(beat).toContain('pid=4242\n')
  expect(beat).toContain(`at=${1_000_000_000 + 15000}\n`)
})

test('a fresh focus request from ccc gives the panel the keyboard and is consumed; a stale one is dropped', async ($, on) => {
  const w = world(on)
  await startSession($, w)
  const inbox = `${DATA}/inbox/${SID}`
  w.files.set(inbox, `format=1\naction=focus\nat=${w.clock.now()}\n`)
  await w.clock.advance(600)
  expect(w.files.has(inbox)).toBe(false)
  expect(w.opens.some(o => o.id === 'sessions' && o.focus === true)).toBe(true)
  const before = w.opens.length
  w.files.set(inbox, `format=1\naction=focus\nat=${w.clock.now() - 60000}\n`)
  await w.clock.advance(600)
  expect(w.files.has(inbox)).toBe(false)
  expect(w.opens.slice(before).some(o => o.focus === true)).toBe(false)
})

test('a request in another format is consumed and not acted on', async ($, on) => {
  const w = world(on)
  await startSession($, w)
  const inbox = `${DATA}/inbox/${SID}`
  w.files.set(inbox, `format=2\naction=focus\nat=${w.clock.now()}\n`)
  await w.clock.advance(600)
  expect(w.files.has(inbox)).toBe(false)
  expect(w.opens.some(o => o.focus === true)).toBe(false)
})

test('the order file lists the project rows for the launcher, in the panel order', async ($, on) => {
  const list = [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'one' },
    { id: 'bbbbbbbb', sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', cwd: `${ROOT}/src`, kind: 'background', status: 'waiting', pid: 4243, name: 'two' },
    { id: 'cccccccc', sessionId: 'cccccccc-0000-0000-0000-000000000000', cwd: '/Users/x/other', kind: 'background', status: 'idle', pid: 4244, name: 'three' },
  ]
  const w = world(on, { list })
  await startSession($, w)
  const order = w.files.get(`${DATA}/order/_Users_x_myapp`) ?? ''
  expect(order).toContain(`root=${ROOT}\n`)
  const rows = order.split('\n').filter(l => l.startsWith('row='))
  expect(rows.map(r => r.split('\t')[2])).toEqual(['bbbbbbbb', 'aaaaaaaa'])
})

test('a notice in another format is consumed, never handed to the model', async ($, on) => {
  const w = world(on)
  await startSession($, w)
  const r = await $.session.receive({ text: 'sessions-notice:7f3a {"format": 9, "kind": "focus"}', origin: { kind: 'peer', plugin: 'sessions' } } as any)
  expect((r as any).consumed).toBeDefined()
})

test('closed by you: no panel at start, no panel on arrival, the band says how to open it, and its button opens it', async ($, on) => {
  const w = world(on, { store: { panelClosed: true } })
  await startSession($, w)
  expect(w.opens.filter(o => o.id === 'sessions')).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).toContain('panel closed · /sessions to open')
  // Arriving with ccc (a focus request) lands on the prompt
  w.files.set(`${DATA}/inbox/${SID}`, `format=1\naction=focus\nat=${w.clock.now()}\n`)
  await w.clock.advance(600)
  expect(w.opens.filter(o => o.id === 'sessions')).toEqual([])
  await ui.press({ key: 'show-panel' })
  expect(w.opens.some(o => o.id === 'sessions' && o.focus === true)).toBe(true)
  expect(w.store.get('panelClosed')).toBe(undefined)
  await ui.unmount()
})

test('/sessions opens a panel you closed (and forgets the close); closing it with /sessions is yours too', async ($, on) => {
  const w = world(on, { store: { panelClosed: true } })
  await startSession($, w)
  await $.command.run({ command: 'sessions', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(w.opens.some(o => o.id === 'sessions' && o.focus === true)).toBe(true)
  expect(w.store.get('panelClosed')).toBe(undefined)
  await $.command.run({ command: 'sessions', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(w.store.get('panelClosed')).toBe(true)
})

test('a panel waiting for a wider window: the band says so', async ($, on) => {
  const w = world(on, { placed: false })
  await startSession($, w)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).toContain('panel hidden: window too narrow · /sessions to show')
  await ui.unmount()
})

test('/sessions status: how the mod started, the session, the copy of the mod, the heartbeat, the silent peers', async ($, on) => {
  const list = [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'one', startedAt: 1 },
    { id: 'bbbbbbbb', sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'idle', pid: 4243, name: 'two', startedAt: 999_000_000 },
  ]
  const w = world(on, { list, env: { SESSIONS_PLUGIN_VERSION: '0.10.0', SESSIONS_PLUGIN_SINCE: '0' } })
  await startSession($, w)
  await w.clock.advance(3000)
  const r: any = await $.command.run({ command: 'sessions', args: 'status', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(r.text).toContain('sessions 0.10.0 · folder copy')
  expect(r.text).toContain('started 3 s ago by session.start')
  expect(r.text).toContain(`Session: ${SID} · project: ${ROOT}`)
  expect(r.text).toContain('Heartbeat: written 3 s ago')
  expect(r.text).toContain('No panel running in: two (no heartbeat)')
  expect(r.text).toContain('For other plugins: $.sessions api 1 · contract, current, status, sections, defineSection, assignSection (ready)')
})

test("New: Enter on an empty name creates a session named after the folder, unused in the project", async ($, on) => {
  const list = [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'one' },
    { id: 'bbbbbbbb', sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'idle', pid: 4243, name: 'myapp-00' },
  ]
  const w = world(on, { list })
  await startSession($, w)
  await $.ui.mount({ plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  await $.ui.press({ plugin: 'sessions', key: 'new', requestId: 'sessions', surface: 'terminal' })
  await $.ui.input({ plugin: 'sessions', key: 'name', text: '', requestId: 'sessions', surface: 'terminal' })
  await w.clock.advance(4000)
  const created = w.runs.findIndex(a => a[1] === '--bg')
  expect(w.runs[created]?.slice(0, 3)).toEqual(['/bin/claude', '--bg', '-n'])
  expect(w.runs[created]?.[3]).toMatch(/^myapp-[0-9a-f]{2,3}$/)
  expect(w.runs[created]?.[3]).not.toBe('myapp-00')
  // In the project root, the only command that runs there
  expect(w.cwds[created]).toBe(ROOT)
})

for (const reason of ['clear', 'resume'] as const) {
  test(`/${reason}: the session id changes and the mod follows it (record, heartbeat, short id), with no new start`, async ($, on) => {
    const w = world(on)
    await startSession($, w)
    w.store.set(`title:${SID}`, 'old first prompt')
    w.store.set(`seen:${SID}`, 5)
    const NEW = 'dddddddd-0000-0000-0000-000000000000'
    await $.session.end({ reason, sessionId: SID, resume: { id: SID } } as any)
    w.id.value = NEW
    await w.clock.advance(1000)
    expect(w.files.has(`${DATA}/alive/${SID}`)).toBe(false)
    expect(w.files.get(`${DATA}/alive/${NEW}`)).toContain('format=1\n')
    expect(w.store.get(`state:${SID}`)).toBe(undefined)
    expect((w.store.get(`state:${NEW}`) as any)?.created).toBeDefined()
    // The old conversation's title isn't the new one's; having seen the session carries over
    expect(w.store.get(`title:${NEW}`)).toBe(undefined)
    expect(w.store.get(`seen:${NEW}`)).toBe(5)
    expect(w.registered).toEqual(['sessions'])
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(JSON.stringify(await ui.drawn())).toContain('"dddddddd"')
    await ui.unmount()
    // A request for the new id is heard
    w.files.set(`${DATA}/inbox/${NEW}`, `format=1\naction=focus\nat=${w.clock.now()}\n`)
    await w.clock.advance(600)
    expect(w.files.has(`${DATA}/inbox/${NEW}`)).toBe(false)
  })
}

test('an id change nobody announced (no session.end) is caught by the 15 s beat', async ($, on) => {
  const w = world(on)
  await startSession($, w)
  const NEW = 'eeeeeeee-0000-0000-0000-000000000000'
  w.id.value = NEW
  await w.clock.advance(15500)
  expect(w.files.get(`${DATA}/alive/${NEW}`)).toContain('format=1\n')
  expect(w.files.has(`${DATA}/alive/${SID}`)).toBe(false)
})

test('debug logs off (the default): no --debug-file, and the launcher is told so', async ($, on) => {
  const w = world(on)
  await startSession($, w)
  expect(w.files.get(`${DATA}/config`)).toBe('format=1\ndebug=0\n')
})

test('debug logs on: the launcher is told, and a session the panel creates writes its debug log', { options: { debugLogs: true } }, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  expect(w.files.get(`${DATA}/config`)).toBe('format=1\ndebug=1\n')
  await $.ui.mount({ plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  await $.ui.press({ plugin: 'sessions', key: 'new', requestId: 'sessions', surface: 'terminal' })
  await $.ui.input({ plugin: 'sessions', key: 'name', text: 'TEST one', requestId: 'sessions', surface: 'terminal' })
  await w.clock.advance(4000)
  const created = w.runs.find(a => a[1] === '--bg')
  expect(created).toEqual(['/bin/claude', '--bg', '-n', 'TEST one', '--debug-file', `${DATA}/debug/TEST_one.log`])
})

test('a missing auto-pin record is rebuilt once, under the pins lock, from the pinned sessions with Remote Control', async ($, on) => {
  const list = [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'one' },
    { id: 'bbbbbbbb', sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'idle', pid: 4243, name: 'two' },
  ]
  const w = world(on, { list })
  w.files.set('/Users/x/jobs/pins.json', '[\n  "aaaaaaaa",\n  "bbbbbbbb"\n]')
  w.files.set('/Users/x/jobs/aaaaaaaa/state.json', '{"bridgeSessionId": "x"}')
  w.files.set('/Users/x/jobs/bbbbbbbb/state.json', '{}')
  await startSession($, w)
  await w.clock.advance(100)
  expect(w.store.get('autoPins')).toEqual({ ids: ['aaaaaaaa'], released: [] })
  // The lock was taken and given back
  expect(w.runs.some(a => a[0] === 'mkdir' && a[1] === '/Users/x/jobs/pins.json.lock')).toBe(true)
  expect(w.runs.some(a => a[0] === 'rmdir' && a[1] === '/Users/x/jobs/pins.json.lock')).toBe(true)
  // Nothing was pinned or unpinned
  expect(w.files.get('/Users/x/jobs/pins.json')).toBe('[\n  "aaaaaaaa",\n  "bbbbbbbb"\n]')
})

// A session that changes folder: EnterWorktree and ExitWorktree move $.session.root() (and its row in the official
// list), and the worktree can be deleted afterwards
const WT = `${ROOT}/.claude/worktrees/w1`
const PANEL = { plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

function folderList(): any[] {
  return [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'one' },
    { id: 'bbbbbbbb', sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'idle', pid: 4243, name: 'two' },
    { id: 'cccccccc', sessionId: 'cccccccc-0000-0000-0000-000000000000', cwd: WT, kind: 'background', status: 'idle', pid: 4244, name: 'three' },
  ]
}

// The short ids in a project's order file (empty if there's none)
function orderIds(w: World, root: string): string[] {
  return (w.files.get(`${DATA}/order/${root.replace(/\//g, '_')}`) ?? '')
    .split('\n')
    .filter(l => l.startsWith('row='))
    .map(l => l.split('\t')[2] ?? '')
    .sort()
}

// Moves the session (and its row in the official list) to a folder, and lets a refresh run past the list's cache
async function move(w: World, list: any[], root: string, cwd = root) {
  w.root.value = root
  w.cwd.value = cwd
  list[0].cwd = cwd
  await w.clock.advance(4000)
}

test("every command runs in a folder that exists, never the session's own, which can be gone", async ($, on) => {
  const w = world(on, { list: folderList() })
  // The session's folder is deleted under it: nothing can start there any more
  w.dirs.delete(ROOT)
  await startSession($, w)
  await w.clock.advance(20000)
  expect(w.runs.length).toBeGreaterThan(5)
  expect(w.cwds.filter(c => c !== '/Users/x')).toEqual([])
  const ui = await $.ui.mount(PANEL)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain("Couldn't read the session list")
  expect(drawn).toContain('one')
  await ui.unmount()
})

test('the root follows the session into a worktree and back, and so do the list and the order file', async ($, on) => {
  const list = folderList()
  const w = world(on, { list })
  w.files.set(`${ROOT}/CLAUDE.md`, '# myapp')
  w.files.set(`${WT}/CLAUDE.md`, '# myapp')
  w.dirs.add(WT)
  await startSession($, w)
  expect(orderIds(w, ROOT)).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'])
  // EnterWorktree: the worktree, a checkout with its own CLAUDE.md, is the project now
  await move(w, list, WT)
  expect(w.files.get(`${DATA}/order/${WT.replace(/\//g, '_')}`)).toContain(`root=${WT}\n`)
  expect(orderIds(w, WT)).toEqual(['aaaaaaaa', 'cccccccc'])
  // ExitWorktree, and the worktree is deleted: back to the main checkout, and the dead folder's order file goes
  w.dirs.delete(WT)
  w.files.delete(`${WT}/CLAUDE.md`)
  list.splice(2, 1)
  await move(w, list, ROOT)
  expect(w.files.has(`${DATA}/order/${WT.replace(/\//g, '_')}`)).toBe(false)
  expect(orderIds(w, ROOT)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  const r: any = await $.command.run({ command: 'sessions', args: 'status', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(r.text).toContain(`project: ${ROOT}`)
})

test("a root folder that's gone gives way to the session's current folder", async ($, on) => {
  const list = folderList()
  const w = world(on, { list })
  w.dirs.add(WT)
  await startSession($, w)
  await move(w, list, WT)
  expect(orderIds(w, WT)).toEqual(['aaaaaaaa', 'cccccccc'])
  // The session's root still names the worktree, which was deleted; the session itself is back in the main checkout
  w.dirs.delete(WT)
  await move(w, list, WT, ROOT)
  expect(orderIds(w, ROOT)).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'])
  const ui = await $.ui.mount(PANEL)
  expect(JSON.stringify(await ui.drawn())).toContain('two')
  await ui.unmount()
})

test('New in a session whose folder is gone: a clear notice, nothing created, and the session still in its own list', async ($, on) => {
  const GONE = '/Users/x/gone'
  const list = folderList()
  list[0].cwd = GONE
  const w = world(on, { list })
  w.root.value = GONE
  w.cwd.value = GONE
  await startSession($, w)
  await w.clock.advance(4000)
  const ui = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, isFocused: true } })
  expect(JSON.stringify(await ui.drawn())).toContain('one')
  await $.ui.press({ plugin: 'sessions', key: 'new', requestId: 'sessions', surface: 'terminal' })
  await $.ui.input({ plugin: 'sessions', key: 'name', text: 'TEST two', requestId: 'sessions', surface: 'terminal' })
  await w.clock.advance(1000)
  expect(w.runs.some(a => a[1] === '--bg')).toBe(false)
  expect(w.toasts).toContain(`Can't create a session: this session's folder no longer exists (${GONE})`)
  await ui.unmount()
})
