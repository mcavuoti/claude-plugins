import { expect, test } from 'claude-code/testing'
import { BAND, DEC, FLEET, ROOT, fleet, row, sessionsSay, startSession, WITH_SESSIONS, world } from './world'
import { PROJECT } from './up.test'

// Fleet's own watch (0.14.0): where no SessionStart was proved, a child process (the command sessions' watchCommand
// builds) follows fleet's paths, and its lines run what classic.FileChanged runs

type Watcher = { argv: string[]; pid: string; ended: boolean; say: (line: string) => void; end: (code: number | null, stderr?: string, signal?: string | null) => void }
function watchers(on: any) {
  const all: Watcher[] = []
  on('process.spawn', async function* (_: any, e: any) {
    const queue: { stream: 'stdout' | 'stderr'; text: string }[] = []
    let result = null as { code: number | null; signal: string | null } | null
    let wake = () => {}
    const me: Watcher = {
      argv: [...e.argv],
      pid: '',
      ended: false,
      say: line => {
        if (line.startsWith('ready\t')) me.pid = line.split('\t')[2] ?? ''
        queue.push({ stream: 'stdout', text: `${line}\n` })
        wake()
      },
      end: (code, stderr = '', signal = null) => {
        if (stderr) queue.push({ stream: 'stderr', text: stderr })
        result = { code, signal }
        wake()
      },
    }
    all.push(me)
    for (;;) {
      while (queue.length) yield queue.shift()!
      if (result) break
      await new Promise<void>(resolve => (wake = resolve))
    }
    me.ended = true
    return { value: result! }
  })
  return all
}

const SECOND = 1000
const MIN = 60 * SECOND
const settle = async (w: any, ms: number) => {
  await w.clock.advance(ms)
  await w.clock.settle()
}
const liveLine = async ($: any) => (await fleet($, 'status')).split('\n').find((l: string) => l.startsWith('live updates')) ?? ''

async function started($: any, on: any, how = 'kqueue') {
  const all = watchers(on)
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  const w = world(on, { background: true })
  sessionsSay(w, { watch: how } as any)
  await startSession($, w)
  return { all, w }
}

test('with no SessionStart, fleet runs its own watch over the paths SessionStart would hand, and its ready makes the session live', WITH_SESSIONS, async ($, on) => {
  const { all, w } = await started($, on)
  expect(all).toEqual([])
  expect(await liveLine($)).toContain("live updates off: SessionStart hasn't reached fleet in this session")
  await settle(w, 11 * SECOND)
  expect(all.length).toBe(1)
  const paths = all[0]!.argv.slice(3)
  expect(paths).toEqual([`${FLEET}/events/latest`, `${DEC}/queue`, `${DEC}/answers`, `${DEC}/overrules`, `${FLEET}/bell`])
  // Made before it watches them
  expect(w.dirs.has(`${FLEET}/bell`)).toBe(true)
  expect(await liveLine($)).toContain('live updates off')
  all[0]!.say('ready\tkqueue\t4242\t5')
  await settle(w, SECOND)
  expect(await liveLine($)).toBe("live updates: on (fleet's own watch: kqueue; questions, answers and overrules reach this session by their files, in under a second)")
})

test("the own watch's lines run what Claude's events run: a question in the queue reaches the band at once, not on the 10 s beat", WITH_SESSIONS, async ($, on) => {
  const all = watchers(on)
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT } })
  sessionsSay(w, { watch: 'kqueue', rows: { ccccccc1: row('ccccccc1', 'Owner C', 'idle') } } as any)
  await startSession($, w)
  await settle(w, 11 * SECOND)
  all[0]!.say('ready\tkqueue\t4242\t5')
  await settle(w, 15 * SECOND)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('for you')
  const at = w.clock.now()
  w.touch(`${DEC}/queue/D-5.json`, JSON.stringify({ format: 1, fleet: '0.14.0', id: 'D-5', at, asker: { ref: 'ccccccc1', sessionId: 'cccccccc-0000-0000-0000-000000000000', name: 'Owner C', root: ROOT }, questions: [{ question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }] }] }))
  all[0]!.say(`add\t${DEC}/queue/D-5.json`)
  await settle(w, 1000)
  expect(JSON.stringify(await ui.drawn())).toContain('? 1 for you · /fleet')
  await ui.unmount()
})

test('a line on an overrule drops its folder memory and runs delivery; a line on events/latest pulls the landing', WITH_SESSIONS, async ($, on) => {
  const { all, w } = await started($, on)
  await settle(w, 11 * SECOND)
  all[0]!.say('ready\tkqueue\t4242\t5')
  await settle(w, SECOND)
  // No error, and it stays live with a line of each kind
  all[0]!.say(`change\t${FLEET}/events/latest`)
  all[0]!.say(`add\t${DEC}/overrules/D-1.json`)
  all[0]!.say(`unlink\t${DEC}/answers/D-2.json`)
  all[0]!.say(`change\t${FLEET}/bell/budget`)
  await settle(w, SECOND)
  expect(await liveLine($)).toContain("fleet's own watch: kqueue")
})

test('when it ends the session is back on its timers, status says why, and it starts again after 1, then 5 minutes', WITH_SESSIONS, async ($, on) => {
  const { all, w } = await started($, on, 'inotify')
  await settle(w, 11 * SECOND)
  all[0]!.say('ready\tinotify\t4242\t5')
  await settle(w, SECOND)
  expect(await liveLine($)).toContain("fleet's own watch: inotify")
  all[0]!.end(1, 'inotify watch limit reached\n')
  await settle(w, SECOND)
  const off = await liveLine($)
  expect(off).toContain('live updates off')
  expect(off).toContain("fleet's own watch isn't running (exited with code 1: inotify watch limit reached), and it tries again in 1 min")
  await settle(w, 30 * SECOND)
  expect(all.length).toBe(1)
  await settle(w, 40 * SECOND)
  expect(all.length).toBe(2)
  all[1]!.end(1)
  await settle(w, SECOND)
  expect(await liveLine($)).toContain('tries again in 5 min')
  await settle(w, 4 * MIN)
  expect(all.length).toBe(2)
  await settle(w, 2 * MIN)
  expect(all.length).toBe(3)
  all[2]!.say('ready\tinotify\t4343\t5')
  await settle(w, SECOND)
  expect(await liveLine($)).toContain("fleet's own watch: inotify")
})

test('sessions that can build no watcher: fleet stays on its timers, says why, and spawns nothing', WITH_SESSIONS, async ($, on) => {
  const all = watchers(on)
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  const w = world(on, { background: true })
  await startSession($, w)
  await settle(w, 11 * SECOND)
  expect(all).toEqual([])
  const off = await liveLine($)
  expect(off).toContain("SessionStart hasn't reached fleet")
  expect(off).toContain("fleet's own watch isn't running (no python3 here), and it tries again in 1 min")
})

test('a session whose SessionStart was proved never spawns it', WITH_SESSIONS, async ($, on) => {
  const all = watchers(on)
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  const w = world(on, { background: true })
  sessionsSay(w, { watch: 'kqueue' } as any)
  await startSession($, w)
  const r: any = await $.classic.SessionStart({ source: 'startup' } as any)
  expect(r.watchPaths).toContain(`${DEC}/queue`)
  await settle(w, 1500)
  await $.classic.FileChanged({ file_path: `${FLEET}/bell/probe`, event: 'change' } as any)
  await settle(w, 30 * SECOND)
  expect(all).toEqual([])
  expect(await liveLine($)).toBe('live updates: on (questions, answers and overrules reach this session by their files, in under a second)')
})

test("a SessionStart that isn't proved within 10 s: the own watch runs; a later SessionStart ends it", WITH_SESSIONS, async ($, on) => {
  const all = watchers(on)
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  const w = world(on, { background: true })
  sessionsSay(w, { watch: 'kqueue' } as any)
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup' } as any)
  await settle(w, 11 * SECOND)
  expect(all.length).toBe(1)
  all[0]!.say('ready\tkqueue\t4242\t5')
  await settle(w, SECOND)
  expect(await liveLine($)).toContain("fleet's own watch: kqueue")
  // A bell through the own watch isn't Claude's proof: nothing says Claude watches
  all[0]!.say(`change\t${FLEET}/bell/probe`)
  await settle(w, SECOND)
  expect(await liveLine($)).toContain("fleet's own watch: kqueue")
  await $.classic.SessionStart({ source: 'clear' } as any)
  await w.clock.settle()
  expect(w.runs.some((r: string[]) => r[0] === 'kill' && r[1] === '4242')).toBe(true)
})
