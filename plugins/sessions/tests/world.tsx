import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

// The world the mod sees in the tests, with the engine's own test kit: every hook here stands for the engine (files,
// processes, the clock, the store and the environment are answered from memory). Shared by the test files that start
// the mod

export const SID = 'aaaaaaaa-0000-0000-0000-000000000000'
export const ROOT = '/Users/x/myapp'
export const DATA = '/Users/x/.claude/mods/sessions-data'
export const BAND = { plugin: 'sessions', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
export const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

export type World = {
  files: Map<string, string>
  opens: any[]
  registered: string[]
  clock: ReturnType<typeof mock.clock>
  id: { value: string }
  panes: any[]
  store: Map<string, unknown>
  runs: string[][]
  // The folder each command ran in
  cwds: (string | undefined)[]
  // The folders that exist (mkdir and rmdir change them, with when each was made), and the session's root and current
  // folder ($.session.root(), $.session.cwd())
  dirs: Set<string>
  made: Map<string, number>
  root: { value: string }
  cwd: { value: string }
  toasts: string[]
  // What $.session.usage() answers
  usage: { value: any }
  // What Claude (and the mods beneath this one) draw in the band above the prompt: nothing, or a line
  band: { value: string }
  // The start of the session's transcript (WorldOptions.transcript), which a test can change
  transcript: { value: string | undefined }
}

export type WorldOptions = {
  id?: string
  list?: unknown[]
  store?: Record<string, unknown>
  placed?: boolean
  env?: Record<string, string>
  // The start of this session's transcript (~/.claude/projects/*/<id>.jsonl); none: there's no transcript yet
  transcript?: string
}

// A session with an id and a root, an in-memory folder tree, a claude that lists one session
export function world(on: On, options: WorldOptions = {}): World {
  const files = new Map<string, string>()
  const dirs = new Set(['/', '/Users', '/Users/x', ROOT])
  const made = new Map<string, number>()
  const root = { value: ROOT }
  const cwd = { value: ROOT }
  const toasts: string[] = []
  const opens: any[] = []
  const registered: string[] = []
  const id = { value: options.id ?? SID }
  const panes: any[] = []
  const usage = { value: { context: { percent: 10 }, rateLimits: [] } as any }
  const band = { value: '' }
  const transcript = { value: options.transcript }
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return band.value ? <Text>{band.value}</Text> : <Box />
  })
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
  on('session.root', () => ({ value: root.value }))
  on('session.cwd', () => ({ value: cwd.value }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: usage.value }))
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
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || dirs.has(e.path) }))
  on('fs.list', (_, e) => ({
    value: [...files.keys()].filter(p => p.startsWith(`${e.path}/`)).map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.stat', (_, e) => {
    if (dirs.has(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: made.get(e.path) ?? 0, isLink: false } }
    if (!files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
  })
  const runs: string[][] = []
  const cwds: (string | undefined)[] = []
  on('process.run', (_, e) => {
    const argv = e.argv
    runs.push([...argv])
    cwds.push(e.init?.cwd)
    // As on a real computer: a command can't start in a folder that's gone (its own, or else the session's)
    const where = e.init?.cwd ?? cwd.value
    if (!dirs.has(where)) throw new Error(`can't start in ${where}: no such folder`)
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const failed = () => ({ value: { exitCode: 1, stdout: '', stderr: 'failed', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'rm') {
      for (const p of argv.slice(2)) files.delete(p)
      return ok()
    }
    // mkdir without -p is how locks are taken: it fails when the folder is there
    if (argv[0] === 'mkdir' && argv[1] !== '-p') {
      const path = argv[1] ?? ''
      if (dirs.has(path)) return failed()
      dirs.add(path)
      made.set(path, clock.now())
      return ok()
    }
    if (argv[0] === 'mkdir') {
      for (const p of argv.slice(2)) dirs.add(p)
      return ok()
    }
    if (argv[0] === 'rmdir') {
      dirs.delete(argv[1] ?? '')
      return ok()
    }
    if (argv[0] === 'mv') {
      const [from = '', to = ''] = argv.slice(-2)
      const text = files.get(from)
      if (text === undefined) return failed()
      files.set(to, text)
      files.delete(from)
      return ok()
    }
    if (argv[0] === '/bin/claude' && argv[1] === 'agents') return ok(JSON.stringify(list))
    if (argv[0] === '/bin/claude' && argv[1] === '--version') return ok('2.1.316 (Claude Code)')
    if (argv[0] === '/bin/claude' && argv[1] === 'plugin') return ok('[]')
    if (argv[0] === '/bin/sh' && String(argv[2]).includes('uname')) return ok('Darwin|')
    // The transcript's first row (readAgent)
    if (argv[0] === '/bin/sh' && String(argv[2]).includes('.jsonl')) return transcript.value === undefined ? failed() : ok(transcript.value)
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
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  return { files, opens, registered, clock, id, panes, store, runs, cwds, dirs, made, root, cwd, toasts, usage, band, transcript }
}

export async function startSession($: any, w: World, isInteractive = true) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive })
  await w.clock.settle()
}
