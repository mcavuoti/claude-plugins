import type { EngineInterface, On } from 'claude-code'
import { mock } from 'claude-code/testing'

// The world fleet sees in the tests, with the engine's own test kit: every hook here stands for the engine (files,
// commands, the clock, the environment, the prompt). The project lives in memory; nothing touches the disk.

export const SID = 'aaaaaaaa-0000-0000-0000-000000000000'
export const REF = 'aaaaaaaa'
export const HOME = '/Users/x'
export const ROOT = '/Users/x/proj'
export const FLEET = `${ROOT}/.claude/fleet`
export const DEC = `${FLEET}/decisions`
export const JOB = `${HOME}/.claude/jobs/${REF}`
// What the stand-in for sessions answers (FAKE_SESSIONS reads it on every call) and where it writes what it was asked
export const FAKE = '/fake/sessions.json'
export const FAKE_LOG = '/fake/sessions.log'
export const BAND = { plugin: 'fleet', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
export const COMPOSER = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

// The golden list of what sessions api 1 serves (plugins/sessions/tests/contract.test.tsx has the same one)
export const GOLDEN = ['contract', 'current', 'status', 'sections', 'defineSection', 'assignSection']

/** A stand-in for sessions with the contract's own type (tsc checks it against plugins/sessions/types/index.d.ts).
 * It answers from FAKE ({ current, rows }) and appends each section call to FAKE_LOG. Inline plugins close over
 * nothing of the test file, so it spells its paths out */
export const FAKE_SESSIONS = {
  name: 'sessions',
  register(on: On) {
    on('engine.create', async (_, e, next) => {
      const $ = await next(e)
      const world = async () => {
        try {
          return JSON.parse(await $.fs.read('/fake/sessions.json'))
        } catch {
          return {}
        }
      }
      const note = async (line: unknown) => {
        let before = ''
        try {
          before = await $.fs.read('/fake/sessions.log')
        } catch {}
        await $.fs.write('/fake/sessions.log', `${before}${JSON.stringify(line)}\n`)
      }
      const api: EngineInterface['sessions'] = {
        contract: async () => ({ api: 1, version: '0.11.0', format: 1, methods: ['contract', 'current', 'status', 'sections', 'defineSection', 'assignSection'] }),
        current: async () => (await world()).current ?? { ready: false, ref: null, sessionId: '', name: '', root: '', background: false, agent: null },
        status: async input => {
          const w = await world()
          if (!w.rows) return { ready: false, rows: [] }
          const refs = input.refs ?? []
          return { ready: true, rows: refs.map(ref => w.rows[ref] ?? { ref, sessionId: null, name: null, state: 'gone', panel: 'none', root: null, background: false, agent: null }) }
        },
        sections: async () => ({ sections: [], members: {} }),
        defineSection: async input => {
          await note({ defineSection: input })
          return { ok: true }
        },
        assignSection: async input => {
          await note({ assignSection: input })
          return (await world()).refuseSections ? { ok: false, reason: 'refused', detail: 'the person placed it' } : { ok: true }
        },
      }
      return { ...$, sessions: api }
    })
  },
}

export type World = {
  files: Map<string, string>
  dirs: Set<string>
  clock: ReturnType<typeof mock.clock>
  id: { value: string }
  root: { value: string }
  tools: any[]
  commands: string[]
  runs: string[][]
  // Every prompt fleet submitted, and how the next one is answered (by default its turn starts at once)
  submits: string[]
  answerSubmit: { value: (text: string) => unknown }
  logs: string[]
  messages: { value: unknown[] }
  // What the engine draws beneath fleet above the prompt
  band: { value: string }
}

export type WorldOptions = {
  // Background session (CLAUDE_JOB_DIR set): the default
  background?: boolean
  // The project already has .claude/fleet/
  fleet?: boolean
  env?: Record<string, string>
  files?: Record<string, string>
}

function parentsOf(path: string): string[] {
  const out: string[] = []
  let p = path
  while (p.lastIndexOf('/') > 0) {
    p = p.slice(0, p.lastIndexOf('/'))
    out.push(p)
  }
  out.push('/')
  return out
}

export function world(on: On, options: WorldOptions = {}): World {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 2, 12, 0, 0) })
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  // When each file was last written (fs.list's mtimeMs)
  const mtimes = new Map<string, number>()
  const dirs = new Set<string>(['/', '/Users', HOME, ROOT, JOB, `${HOME}/.claude`, `${HOME}/.claude/jobs`])
  const addFile = (path: string, text: string) => {
    files.set(path, text)
    mtimes.set(path, clock.now())
    for (const d of parentsOf(path)) dirs.add(d)
  }
  for (const [p, t] of files) addFile(p, t)
  if (options.fleet !== false) {
    addFile(`${FLEET}/config.json`, '{ "configFormat": 1, "template": "blank", "commitRegister": false }\n')
    for (const d of ['queue', 'answers', 'register', 'tmp', 'prune']) dirs.add(`${DEC}/${d}`)
  }
  const id = { value: SID }
  const root = { value: ROOT }
  if (options.background !== false) addFile(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, state: 'idle' }))
  const tools: any[] = []
  const commands: string[] = []
  const runs: string[][] = []
  const submits: string[] = []
  const answerSubmit = { value: (text: string): unknown => ({ text }) }
  const logs: string[] = []
  const messages = { value: [] as unknown[] }
  const band = { value: '' }
  const env: Record<string, string> = { HOME, ...(options.background !== false ? { CLAUDE_JOB_DIR: JOB } : {}), ...options.env }
  mock.env(on, env)
  on('session.id', () => ({ value: id.value }))
  on('session.root', () => ({ value: root.value }))
  on('session.cwd', () => ({ value: root.value }))
  on('session.messages', () => ({ value: messages.value as any }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"version": "0.1.0"}' }
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    addFile(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || dirs.has(e.path) }))
  on('fs.list', (_, e) => {
    if (!dirs.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const prefix = `${e.path}/`
    const entries = [...files.keys()]
      .filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(p => ({ name: p.slice(prefix.length), kind: 'file' as const, size: 1, mtimeMs: mtimes.get(p) ?? 0, isLink: false }))
    return { value: entries }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const ok = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const failed = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.init?.cwd !== '/') return failed('fleet runs every command from /')
    const [cmd, ...args] = argv
    if (cmd === 'ln') {
      const [from = '', to = ''] = args
      if (files.has(to)) return failed('File exists')
      if (!dirs.has(to.slice(0, to.lastIndexOf('/')))) return failed('No such file or directory')
      const text = files.get(from)
      if (text === undefined) return failed('No such file')
      addFile(to, text)
      return ok
    }
    if (cmd === 'mv') {
      const [from = '', to = ''] = args.filter(a => a !== '-f')
      const text = files.get(from)
      if (text === undefined) return failed('No such file')
      files.delete(from)
      addFile(to, text)
      return ok
    }
    if (cmd === 'rm') {
      for (const p of args.filter(a => a !== '-f')) files.delete(p)
      return ok
    }
    if (cmd === 'mkdir') {
      for (const p of args.filter(a => a !== '-p')) for (const d of [p, ...parentsOf(p)]) dirs.add(d)
      return ok
    }
    return failed(`unknown command ${cmd}`)
  })
  on('tool.register', (_, e) => {
    tools.push(e)
    return { value: { tool: `mcp__fleet__${e.name}` } }
  })
  on('command.register', (_, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('prompt.submit', (_, e) => {
    // What fleet submits (the person's own prompts in a test just enter)
    if (e.origin?.kind !== 'plugin') return { text: e.text }
    submits.push(e.text)
    return answerSubmit.value(e.text) as any
  })
  on('ui.log', (_, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return band.value ? <Text>{band.value}</Text> : <Box />
  })
  return { files, dirs, clock, id, root, tools, commands, runs, submits, answerSubmit, logs, messages, band }
}

export async function startSession($: any, w: World, isInteractive = true) {
  await $.session.start({ cwd: w.root.value, surface: 'terminal', isInteractive })
  await w.clock.settle()
}

export async function fleet($: any, args: string, origin: unknown = COMPOSER.origin): Promise<string> {
  const r: any = await $.command.run({ command: 'fleet', args, origin, presentation: COMPOSER.presentation })
  return String(r.text ?? '')
}

export const TWO_QUESTIONS = {
  questions: [
    {
      question: 'Which database for the cache?',
      options: [{ label: 'SQLite', description: 'one file, no server' }, { label: 'Redis' }],
      recommended: 'Redis',
      why: 'the queue already runs it',
    },
    { question: 'Should entries expire?', header: 'Expiry', options: [{ label: 'After a day' }, { label: 'Never' }], recommended: 'a', why: 'stale data hurts more than misses' },
  ],
  blocks: 'the cache layer',
}

export async function decide($: any, input: unknown = TWO_QUESTIONS, extra: Record<string, unknown> = {}): Promise<any> {
  return $.tool.call({ tool: 'mcp__fleet__decide', ...(input as object), ...extra } as any)
}

export function json(w: World, path: string): any {
  const t = w.files.get(path)
  return t === undefined ? undefined : JSON.parse(t)
}

export function under(w: World, dir: string): string[] {
  return [...w.files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1)).sort()
}

// The fake sessions' answers: this session as current, and the others by ref
export function sessionsSay(w: World, say: { current?: unknown; rows?: Record<string, unknown>; refuseSections?: boolean }) {
  w.files.set(FAKE, JSON.stringify(say))
}

export function row(ref: string, name: string, state: string) {
  return { ref, sessionId: null, name, state, panel: 'ok', root: ROOT, background: true, agent: null }
}
