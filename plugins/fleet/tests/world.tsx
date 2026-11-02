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
export const GOLDEN = ['contract', 'current', 'status', 'sections', 'defineSection', 'assignSection', 'start', 'wake', 'setMarks']
// Where the tests' templates are (FLEET_TEMPLATES_DIR), and the blank one every test has
export const TEMPLATES = '/fake/templates'
export const BLANK = {
  'template.json': JSON.stringify({ templateFormat: 1, description: 'nothing but fleet', folders: [] }),
  'fleet/world.json': JSON.stringify({ worldFormat: 1, paths: ['notes/**', 'docs/**'] }),
  'fleet/roster.json': JSON.stringify({ rosterFormat: 1, sections: [], roles: {}, instances: [] }),
}

/** A stand-in for sessions with the contract's own type (tsc checks it against plugins/sessions/types/index.d.ts).
 * It answers from FAKE ({ current, rows, named }) and appends each call that changes something to FAKE_LOG. Inline
 * plugins close over nothing of the test file, so it spells its paths out */
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
        contract: async () => ({ api: 1, version: '0.13.0', format: 2, methods: ['contract', 'current', 'status', 'sections', 'defineSection', 'assignSection', 'start', 'wake', 'setMarks'] }),
        current: async () => (await world()).current ?? { ready: false, ref: null, sessionId: '', name: '', root: '', background: false, agent: null },
        status: async input => {
          const w = await world()
          if (!w.rows) return { ready: false, rows: [] }
          const refs = input.refs ?? []
          const byName = (input.names ?? []).flatMap((n: string) => Object.values(w.rows as Record<string, any>).filter(r => r.name === n))
          return { ready: true, rows: [...refs.map(ref => w.rows[ref] ?? { ref, sessionId: null, name: null, state: 'gone', panel: 'none', root: null, background: false, agent: null }), ...byName] }
        },
        start: async input => {
          await note({ start: input })
          return { ok: true, queued: true }
        },
        wake: async input => {
          await note({ wake: input })
          return { ok: true, state: 'queued' }
        },
        // With sessions' own limits (its checkMarks): one row past them refuses the whole call
        setMarks: async input => {
          for (const m of Object.values(input.rows ?? {})) {
            const badge = m?.badge ?? ''
            const cols = Array.from(badge).reduce((n, c) => n + (/\p{Extended_Pictographic}/u.test(c) ? 2 : 1), 0)
            if (cols > 3 || /\p{Cc}/u.test(badge)) return { ok: false, reason: 'invalid', detail: 'a badge is up to 3 columns' }
            const line = (m?.line ?? '').trim().replace(/\s+/g, ' ')
            if (Array.from(line).length > 60 || /\p{Cc}/u.test(line)) return { ok: false, reason: 'invalid', detail: 'a status line is up to 60 characters on one line' }
          }
          await note({ setMarks: input })
          return { ok: true }
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

// The options of a test that loads the stand-in for sessions. 30 s rather than the kit's 5 s: these tests move the
// mocked clock through many ticks, which takes longer than 5 s of real time on a slow or busy machine (the CI runners)
export const WITH_SESSIONS = { plugins: [FAKE_SESSIONS], timeoutMs: 30000 }

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
  // Every prompt that entered, with the context hooks attached on the way down
  prompts: { text: string; context: readonly string[] }[]
  // What a Bash command does to the files (the stand-in for the shell); a promise keeps the command running until it
  // settles. One run with run_in_background returns at once with a task id (bash-1, bash-2…)
  bash: { value: (command: string) => void | Promise<void> }
  // Runs as the engine's Write or Edit starts, after fleet's gate (another session landing just then)
  beforeTool: { value: (tool: string) => void }
  // Writes a file as another program would (an editor, a script, another session): bumps its time, or sets the one
  // given (a copy that keeps its source's time: rsync -a, cp -p)
  touch: (path: string, text: string, mtimeMs?: number) => void
  // Files whose reads fail for now (too many open files, a hiccup), though they're there
  unreadable: Set<string>
  // Any other command fleet runs (git, a check script, the person's channel): its answer, or undefined for "unknown
  // command"; stdin: what fleet wrote to it
  exec: { value: (argv: string[], cwd: string, stdin?: string) => { exitCode: number; stdout?: string; stderr?: string } | undefined }
}

export type WorldOptions = {
  // Background session (CLAUDE_JOB_DIR set): the default
  background?: boolean
  // The project already has .claude/fleet/
  fleet?: boolean
  // world.json's globs, when the project has one (fleet only)
  worldPaths?: string[]
  // The volume ignores case (the real path has the disk's case, as on APFS)
  insensitive?: boolean
  // Symbolic links: link path → where it leads (absolute)
  links?: Record<string, string>
  env?: Record<string, string>
  files?: Record<string, string>
  // Templates besides blank: name → path inside the template → text
  templates?: Record<string, Record<string, string>>
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
  // When each file was last written (fs.list's mtimeMs); a folder's time is a counter that moves when an entry in it
  // comes or goes (fleet only compares a folder's times)
  const mtimes = new Map<string, number>()
  const dirTimes = new Map<string, number>()
  let dirTick = 0
  const moved = (path: string) => dirTimes.set(path.slice(0, path.lastIndexOf('/')) || '/', ++dirTick)
  const dirs = new Set<string>(['/', '/Users', HOME, ROOT, JOB, `${HOME}/.claude`, `${HOME}/.claude/jobs`])
  const addFile = (path: string, text: string) => {
    if (!files.has(path)) moved(path)
    files.set(path, text)
    mtimes.set(path, clock.now())
    for (const d of parentsOf(path)) dirs.add(d)
  }
  for (const [p, t] of files) addFile(p, t)
  for (const [name, tree] of Object.entries({ blank: BLANK, ...options.templates })) {
    for (const [p, t] of Object.entries(tree)) addFile(`${TEMPLATES}/${name}/${p}`, t)
  }
  if (options.fleet !== false) {
    addFile(`${FLEET}/config.json`, '{ "configFormat": 1, "template": "blank", "commitRegister": false }\n')
    for (const d of ['queue', 'answers', 'register', 'tmp', 'prune']) dirs.add(`${DEC}/${d}`)
    if (options.worldPaths) addFile(`${FLEET}/world.json`, JSON.stringify({ worldFormat: 1, paths: options.worldPaths }))
  }
  // Where a path lands: . and .. folded, links followed, and on a volume that ignores case the disk's own spelling
  const links = options.links ?? {}
  const real = (path: string): string | undefined => {
    const out: string[] = []
    for (const s of path.split('/')) {
      if (s === '' || s === '.') continue
      if (s === '..') out.pop()
      else out.push(s)
    }
    let p = `/${out.join('/')}`
    for (const [link, to] of Object.entries(links)) if (p === link || p.startsWith(`${link}/`)) p = to + p.slice(link.length)
    if (files.has(p) || dirs.has(p)) return p
    if (options.insensitive) return [...files.keys(), ...dirs].find(x => x.toLowerCase() === p.toLowerCase())
    return undefined
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
  const env: Record<string, string> = { HOME, FLEET_TEMPLATES_DIR: TEMPLATES, ...(options.background !== false ? { CLAUDE_JOB_DIR: JOB } : {}), ...options.env }
  mock.env(on, env)
  on('session.id', () => ({ value: id.value }))
  on('session.root', () => ({ value: root.value }))
  on('session.cwd', () => ({ value: root.value }))
  on('session.messages', () => ({ value: messages.value as any }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const unreadable = new Set<string>()
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"version": "0.1.0"}' }
    if (unreadable.has(e.path)) throw new Error(`EMFILE: too many open files, open '${e.path}'`)
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
    const prefix = e.path === '/' ? '/' : `${e.path}/`
    const below = (p: string) => p.startsWith(prefix) && p.length > prefix.length && !p.slice(prefix.length).includes('/')
    const entries = [
      ...[...files.keys()].filter(below).map(p => ({ name: p.slice(prefix.length), kind: 'file' as const, size: (files.get(p) as string).length, mtimeMs: mtimes.get(p) ?? 0, isLink: false })),
      ...[...dirs].filter(below).map(p => ({ name: p.slice(prefix.length), kind: 'dir' as const, size: 0, mtimeMs: dirTimes.get(p) ?? 0, isLink: false })),
    ]
    return { value: entries }
  })
  on('fs.stat', (_, e) => {
    const p = real(e.path)
    if (p === undefined) throw new Error(`ENOENT: ${e.path}`)
    const file = files.get(p)
    const stat = file !== undefined ? { kind: 'file' as const, size: file.length, mtimeMs: mtimes.get(p) ?? 0, isLink: false } : { kind: 'dir' as const, size: 0, mtimeMs: dirTimes.get(p) ?? 0, isLink: false }
    return { value: e.resolve ? { ...stat, realPath: p } : stat }
  })
  const exec = { value: (_argv: string[], _cwd: string, _stdin?: string): { exitCode: number; stdout?: string; stderr?: string } | undefined => undefined }
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const ok = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const failed = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    const other = exec.value(argv, String(e.init?.cwd ?? ''), e.init?.stdin)
    if (other) return { value: { stdout: '', stderr: '', ...other, isStdoutTruncated: false, isStderrTruncated: false } }
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
      moved(from)
      moved(to)
      addFile(to, text)
      return ok
    }
    if (cmd === 'rm') {
      const recursive = args.some(a => /^-\w*r/.test(a))
      for (const p of args.filter(a => !a.startsWith('-'))) {
        if (files.delete(p)) moved(p)
        if (!recursive) continue
        for (const f of [...files.keys()]) if (f.startsWith(`${p}/`)) files.delete(f)
        for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d)
      }
      return ok
    }
    if (cmd === 'mkdir') {
      for (const p of args.filter(a => a !== '-p')) for (const d of [p, ...parentsOf(p)]) dirs.add(d)
      return ok
    }
    // fleet's batch of no-clobber links (publishAll): sh -c '<loop>' sh tmp1 dest1 tmp2 dest2 …, each destination's
    // folder made first, one line per pair
    if (cmd === 'sh' && args[0] === '-c' && String(args[1]).includes('ln "$t" "$d"')) {
      const pairs = args.slice(3)
      const lines: string[] = []
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const t = pairs[i] as string
        const d = pairs[i + 1] as string
        const text = files.get(t)
        if (files.has(d)) lines.push(`exists ${d}`)
        else if (text === undefined) lines.push(`failed ${d}`)
        else {
          addFile(d, text)
          lines.push(`ok ${d}`)
        }
        if (files.delete(t)) moved(t)
      }
      return { value: { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
  const prompts: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_, e) => {
    // What fleet submits (the person's own prompts in a test just enter)
    if (e.origin?.kind !== 'plugin') {
      prompts.push({ text: e.text, context: e.context ?? [] })
      return { text: e.text, context: e.context ?? [] }
    }
    submits.push(e.text)
    return answerSubmit.value(e.text) as any
  })
  // The engine's file tools and shell, beneath fleet's hooks
  const bash = { value: (_command: string): void | Promise<void> => {} }
  let tasks = 0
  const beforeTool = { value: (_tool: string): void => {} }
  // A write's time: the clock's, a little later than the write before it (two writes in one test tick still differ)
  let bump = 0
  const touch = (path: string, text: string, mtimeMs?: number) => {
    addFile(path, text)
    mtimes.set(path, mtimeMs ?? clock.now() + ++bump / 1000)
  }
  on('tool.call', { tool: 'Read' }, (_, e) => {
    const text = files.get(real(e.file_path) ?? e.file_path)
    if (text === undefined) return { isError: true, result: undefined, text: `File does not exist: ${e.file_path}` }
    const lines = text.split('\n').length
    return { result: { type: 'text', file: { filePath: e.file_path, content: text, numLines: lines, startLine: 1, totalLines: lines } }, text }
  })
  on('tool.call', { tool: 'Write' }, (_, e) => {
    beforeTool.value('Write')
    const path = real(e.file_path) ?? e.file_path
    const before = files.get(path)
    touch(path, e.content)
    return { result: { type: before === undefined ? 'create' : 'update', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: before ?? null }, text: `The file ${e.file_path} has been updated successfully.` }
  })
  on('tool.call', { tool: 'Edit' }, (_, e) => {
    beforeTool.value('Edit')
    const path = real(e.file_path) ?? e.file_path
    const before = files.get(path)
    if (before === undefined || !before.includes(e.old_string)) return { isError: true, result: undefined, text: 'String to replace not found in file.' }
    touch(path, before.replace(e.old_string, e.new_string))
    return {
      result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: before, structuredPatch: [], userModified: false, replaceAll: false },
      text: `The file ${e.file_path} has been updated successfully.`,
    }
  })
  on('tool.call', { tool: 'Bash' }, async (_, e) => {
    if (e.run_in_background) {
      void bash.value(e.command)
      return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `bash-${++tasks}` }, text: '' }
    }
    await bash.value(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
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
  return { files, dirs, clock, id, root, tools, commands, runs, submits, answerSubmit, logs, messages, band, prompts, bash, beforeTool, touch, unreadable, exec }
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
