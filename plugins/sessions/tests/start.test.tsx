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
}

// The world the mod sees: a session with an id and a root, an in-memory folder tree, a claude that lists one session
function world(on: On, options: { id?: string; list?: unknown[] } = {}): World {
  const files = new Map<string, string>()
  const opens: any[] = []
  const registered: string[] = []
  const id = { value: options.id ?? SID }
  const panes: any[] = []
  const clock = mock.clock(on, { now: 1_000_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/Users/x', SESSIONS_CLAUDE: '/bin/claude', SESSIONS_JOBS_DIR: '/Users/x/jobs', SESSIONS_DAEMON_LOG: '/Users/x/daemon.log' })
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
  on('process.run', (_, e) => {
    const argv = e.argv
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
    if (pane) pane.isFocused = !!e.focus
    else panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: !!e.focus, isPlaced: true })
    return { value: { isPlaced: true } }
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
  return { files, opens, registered, clock, id, panes }
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
