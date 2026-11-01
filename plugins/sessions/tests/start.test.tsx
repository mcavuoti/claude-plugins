import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// How the mod starts in a session, with the engine's own test kit: every hook here stands for the engine (files,
// processes, the clock, the store and the environment are answered from memory)

const SID = 'aaaaaaaa-0000-0000-0000-000000000000'
const ROOT = '/Users/x/myapp'
const DATA = '/Users/x/.claude/mods/sessions-data'
const BAND = { plugin: 'sessions', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const

type World = {
  files: Map<string, string>
  opens: any[]
  registered: string[]
  clock: ReturnType<typeof mock.clock>
  id: { value: string }
  panes: any[]
  store: Map<string, unknown>
  runs: string[][]
}

// The world the mod sees: a session with an id and a root, an in-memory folder tree, a claude that lists one session
function world(on: On, options: { id?: string; list?: unknown[]; store?: Record<string, unknown>; placed?: boolean; env?: Record<string, string> } = {}): World {
  const files = new Map<string, string>()
  const opens: any[] = []
  const registered: string[] = []
  const id = { value: options.id ?? SID }
  const panes: any[] = []
  const clock = mock.clock(on, { now: 1_000_000_000 })
  // The store, in memory (readable by the tests)
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  on('store.get', (_, e) => ({ value: store.get(e.key) as any }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.env(on, { HOME: '/Users/x', SESSIONS_CLAUDE: '/bin/claude', SESSIONS_JOBS_DIR: '/Users/x/jobs', SESSIONS_DAEMON_LOG: '/Users/x/daemon.log', ...options.env })
  const list = options.list ?? [{ id: id.value.slice(0, 8), sessionId: id.value, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'one' }]
  on('session.id', () => ({ value: id.value }))
  on('session.root', () => ({ value: ROOT }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { percent: 10 } } as any }))
  on('session.version', () => ({ value: { version: '2.1.316' } as any }))
  on('session.messages', () => ({ value: [] as any }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"version": "0.10.0"}' }
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.list', (_, e) => ({
    value: [...files.keys()].filter(p => p.startsWith(`${e.path}/`)).map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.ancestors', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
  const runs: string[][] = []
  on('process.run', (_, e) => {
    const argv = e.argv
    runs.push([...argv])
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'rm') {
      for (const p of argv.slice(2)) files.delete(p)
      return ok()
    }
    if (argv[0] === '/bin/claude' && argv[1] === 'agents') return ok(JSON.stringify(list))
    if (argv[0] === '/bin/claude' && argv[1] === '--version') return ok('2.1.316 (Claude Code)')
    if (argv[0] === '/bin/claude' && argv[1] === 'plugin') return ok('[]')
    if (argv[0] === '/bin/sh' && String(argv[2]).includes('uname')) return ok('Darwin|')
    return ok()
  })
  on('command.register', (_, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', (_, e) => {
    opens.push(e)
    const pane = panes.find(p => p.id === e.id)
    const placed = options.placed ?? true
    if (pane) pane.isFocused = !!e.focus
    else panes.push({ id: e.id, title: e.title ?? e.id, isShown: placed, isFocused: !!e.focus, isPlaced: placed })
    return { value: placed ? { isPlaced: true } : ({ isPlaced: false, reason: 'narrow' } as any) }
  })
  on('ui.close', (_, e) => {
    const i = panes.findIndex(p => p.id === e.id)
    if (i >= 0) panes.splice(i, 1)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: panes.map(p => ({ ...p })) }))
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return { files, opens, registered, clock, id, panes, store, runs }
}

async function startSession($: any, w: World, isInteractive = true) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive })
  await w.clock.settle()
}

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
  const created = w.runs.find(a => a[1] === '--bg')
  expect(created?.slice(0, 3)).toEqual(['/bin/claude', '--bg', '-n'])
  expect(created?.[3]).toMatch(/^myapp-[0-9a-f]{2,3}$/)
  expect(created?.[3]).not.toBe('myapp-00')
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
