import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

import { storeNamespace } from '../hooks/state'

// The world the mod sees in the tests, with the engine's own test kit: every hook here stands for the engine (files,
// processes, the clock, the store and the environment are answered from memory). Shared by the test files that start
// the mod

export const SID = 'aaaaaaaa-0000-0000-0000-000000000000'
export const ROOT = '/Users/x/myapp'
export const DATA = '/Users/x/.claude/mods/sessions-data'
export const BAND = { plugin: 'sessions', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
export const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const
// For a test that starts the mod and moves the mocked clock through many minutes: 30 s rather than the kit's 5 s,
// which a slow or busy machine (the CI runners) can run past
export const SLOW = { timeoutMs: 30000 } as const

export type World = {
  files: Map<string, string>
  // A file written by someone else (Claude's registry, another session) now, by the mocked clock: its time stays put
  // until it's written again, as a real file's does
  write: (path: string, text: string) => void
  opens: any[]
  registered: string[]
  clock: ReturnType<typeof mock.clock>
  id: { value: string }
  panes: any[]
  store: Map<string, unknown>
  // Every store key the mod asked for, as it asked (with its namespace), and that namespace
  storeKeys: Set<string>
  namespace: string
  runs: string[][]
  // The folder each command ran in, and the variables it set over the session's
  cwds: (string | undefined)[]
  envs: (Record<string, string> | undefined)[]
  // The folders that exist (mkdir and rmdir change them, with when each was made), and the session's root and current
  // folder ($.session.root(), $.session.cwd())
  dirs: Set<string>
  made: Map<string, number>
  root: { value: string }
  cwd: { value: string }
  toasts: string[]
  // What $.session.usage() answers
  usage: { value: any }
  // What Claude (and the mods beneath this one) draw in the band above the prompt: nothing, or a line; and how late
  // they answer the next draw, in ms (0: at once): that draw held open that long, as a slow plugin beneath holds it
  band: { value: string }
  bandLate: { value: number }
  // The start of the session's transcript (WorldOptions.transcript), which a test can change
  transcript: { value: string | undefined }
  // What claude --bg prints when it refuses to start a session ('': it starts it)
  bgError: { value: string }
  // macOS's memory pressure level (sysctl kern.memorystatus_vm_pressure_level): 1 normal, 4 critical
  memory: { value: string }
  // What `ps -A -o pid= -o tty= -o command=` lists (no window by default), and what Terminal's AppleScript answers, by its
  // mode words (frente, leer, traer, cerrar, abrir: hooks/platform/macos.ts; '' by default)
  ps: { value: string }
  terminal: { value: (args: string[]) => string }
  // What xprop answers (X11 on Linux), by its arguments; null: xprop fails, as without a display (the default)
  xprop: { value: (args: string[]) => string | null }
  // While set, `claude agents` answers only once it resolves (a slow listing)
  agentsGate: { value: Promise<void> | null }
  // While true, `claude agents` fails (exit 127, as when run's timeout cuts it), after the gate if one is set
  agentsFail: { value: boolean }
  // What `claude plugin list --json` answers (none installed by default)
  plugins: { value: string }
  // What the mod asked to tell the person: the PushNotification calls' messages and $.ui.notify's texts, and what each
  // answers (by default, what a session gets with nobody away from the computer and no notifying terminal)
  pushes: string[]
  notifies: string[]
  pushAnswer: { value: any }
  notifyAnswer: { value: any }
}

export type WorldOptions = {
  id?: string
  list?: unknown[]
  store?: Record<string, unknown>
  placed?: boolean
  env?: Record<string, string>
  // The start of this session's transcript (~/.claude/projects/*/<id>.jsonl); none: there's no transcript yet
  transcript?: string
  // What uname -s answers, which picks the platform (Darwin by default)
  system?: string
  // What the plugins beneath answer to classic.SessionStart (nothing by default)
  sessionStart?: Record<string, unknown>
}

// A session with an id and a root, an in-memory folder tree, a claude that lists one session
export function world(on: On, options: WorldOptions = {}): World {
  // When each file was written (fs.list's and fs.stat's mtimeMs): by the mod, or by a test through write. One a test
  // set directly (files.set) counts as just written, whenever it's looked at
  const written = new Map<string, number>()
  const files = new (class extends Map<string, string> {
    override set(path: string, text: string) {
      written.delete(path)
      return super.set(path, text)
    }
  })()
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
  const bgError = { value: '' }
  const memory = { value: '1' }
  const ps = { value: '' }
  const terminal = { value: (_args: string[]) => '' }
  const xprop = { value: (_args: string[]): string | null => null }
  const agentsGate: { value: Promise<void> | null } = { value: null }
  const agentsFail = { value: false }
  const plugins = { value: '[]' }
  const bandLate = { value: 0 }
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const late = bandLate.value
    bandLate.value = 0
    if (late > 0) await clock.sleep(late)
    const { Box, Text } = $.ui.resolve(e)
    return band.value ? <Text>{band.value}</Text> : <Box />
  })
  const clock = mock.clock(on, { now: 1_000_000_000 })
  const env: Record<string, string> = { HOME: '/Users/x', SESSIONS_CLAUDE: '/bin/claude', SESSIONS_JOBS_DIR: '/Users/x/jobs', SESSIONS_DAEMON_LOG: '/Users/x/daemon.log', ...options.env }
  mock.env(on, env)
  // The store, in memory (readable by the tests). These overrides put the mod's keys under a namespace of their own
  // (storeNamespace): the tests read and write them without it, and storeKeys keeps every key the mod used, as it used it
  const namespace = storeNamespace(['SESSIONS_DATA_DIR', 'SESSIONS_JOBS_DIR', 'SESSIONS_DAEMON_LOG', 'SESSIONS_CLAUDE', 'SESSIONS_PLUGIN_VERSION', 'SESSIONS_PLUGIN_SINCE', 'SESSIONS_REGISTRY_DIR'].map(k => env[k]))
  const plain = (key: string) => (key.startsWith(namespace) ? key.slice(namespace.length) : key)
  const storeKeys = new Set<string>()
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  on('store.get', (_, e) => {
    storeKeys.add(e.key)
    return { value: store.get(plain(e.key)) as any }
  })
  on('store.set', (_, e) => {
    storeKeys.add(e.key)
    store.set(plain(e.key), e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    storeKeys.add(e.key)
    store.delete(plain(e.key))
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()].map(k => `${namespace}${k}`) }))
  const list = options.list ?? [{ id: id.value.slice(0, 8), sessionId: id.value, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'one' }]
  on('session.id', () => ({ value: id.value }))
  on('session.root', () => ({ value: root.value }))
  on('session.cwd', () => ({ value: cwd.value }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: usage.value }))
  on('session.version', () => ({ value: { version: '2.1.316' } as any }))
  on('session.messages', () => ({ value: [] as any }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // The classic hooks the engine raises (a test raises them with $.classic): nothing of Claude's own beneath
  on('classic.SessionStart', () => (options.sessionStart ?? {}) as any)
  on('classic.FileChanged', () => ({}) as any)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"version": "0.10.0"}' }
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    written.set(e.path, clock.now())
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || dirs.has(e.path) }))
  // A file's size and time, as fs.list and fs.stat give them: what it holds, and when it was last written (by the mod,
  // or by a test through write; one a test set directly counts as just written)
  const size = (p: string) => new TextEncoder().encode(files.get(p) ?? '').length
  on('fs.list', (_, e) => ({
    value: [...files.keys()].filter(p => p.startsWith(`${e.path}/`)).map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: size(p), mtimeMs: written.get(p) ?? clock.now(), isLink: false })),
  }))
  on('fs.stat', (_, e) => {
    if (dirs.has(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: made.get(e.path) ?? 0, isLink: false } }
    if (!files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file' as const, size: size(e.path), mtimeMs: written.get(e.path) ?? clock.now(), isLink: false } }
  })
  // A file someone else wrote (Claude, another session) at the mocked time: its time stays until it's written again
  const write = (path: string, text: string) => {
    files.set(path, text)
    written.set(path, clock.now())
  }
  const runs: string[][] = []
  const cwds: (string | undefined)[] = []
  const envs: (Record<string, string> | undefined)[] = []
  on('process.run', (_, e) => {
    const argv = e.argv
    runs.push([...argv])
    cwds.push(e.init?.cwd)
    envs.push(e.init?.env ? { ...e.init.env } : undefined)
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
    // A slow `claude agents` (after a sleep, under an endpoint scanner): it answers once the test opens the gate
    if (argv[0] === '/bin/claude' && argv[1] === 'agents') {
      const answer = () => (agentsFail.value ? { value: { exitCode: 127, stdout: '', stderr: 'timed out', isStdoutTruncated: false, isStderrTruncated: false } } : ok(JSON.stringify(list)))
      return agentsGate.value ? agentsGate.value.then(answer) : answer()
    }
    // The end of a file (the background service's log), as tail -n reads it
    if (argv[0] === 'tail') return files.has(argv.at(-1) ?? '') ? ok(files.get(argv.at(-1) ?? '')) : failed()
    if (argv[0] === 'sysctl') return ok(`${memory.value}\n`)
    // As a real ps reads -o (POSIX, which procps keeps to the letter): in `name=header` the header runs to the end of
    // that -o argument, so `-o pid=,tty=,command=` is one pid column headed ",tty=,command=", and only pids are listed
    if (argv[0] === 'ps') {
      const header = argv.find((a, i) => argv[i - 1] === '-o' && /=./.test(a))
      return ok(header ? [header.slice(header.indexOf('=') + 1), ...ps.value.split('\n').map(l => l.trim().split(/\s+/)[0])].join('\n') : ps.value)
    }
    if (argv[0] === 'osascript') return ok(terminal.value(argv.slice(2)))
    if (argv[0] === 'xprop') {
      const answer = xprop.value(argv.slice(1))
      return answer === null ? failed() : ok(answer)
    }
    if (argv[0] === '/bin/claude' && argv[1] === '--bg' && bgError.value) return { value: { exitCode: 1, stdout: '', stderr: bgError.value, isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === '/bin/claude' && argv[1] === '--version') return ok('2.1.316 (Claude Code)')
    if (argv[0] === '/bin/claude' && argv[1] === 'plugin') return ok(plugins.value)
    if (argv[0] === '/bin/sh' && String(argv[2]).includes('uname')) return ok(`${options.system ?? 'Darwin'}|`)
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
  const pushes: string[] = []
  const notifies: string[] = []
  const pushAnswer = { value: { pushSent: false, localSent: false, disabledReason: 'user_present' } as any }
  const notifyAnswer = { value: { isSent: false, reason: 'no-channel' } as any }
  on('tool.call', { tool: 'PushNotification' }, (_, e: any) => {
    pushes.push(String(e.message))
    return { result: { message: e.message, ...pushAnswer.value } } as any
  })
  on('ui.notify', (_, e) => {
    notifies.push(String(e.text))
    return { value: notifyAnswer.value }
  })
  return { files, write, opens, registered, clock, id, panes, store, storeKeys, namespace, runs, cwds, envs, dirs, made, root, cwd, toasts, usage, band, bandLate, transcript, bgError, memory, ps, terminal, xprop, agentsGate, agentsFail, plugins, pushes, notifies, pushAnswer, notifyAnswer }
}

export async function startSession($: any, w: World, isInteractive = true) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive })
  await w.clock.settle()
}
