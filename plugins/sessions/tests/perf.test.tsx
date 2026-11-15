import { expect, test } from 'claude-code/testing'

import { createMeter, WINDOW_GRACE_MS } from '../hooks/debug/meter'
import { handInFile, parseHandInFile, parseWindow, perfSeconds, windowText } from '../hooks/debug/window'
import { bellText } from '../hooks/watch'
import { COMMAND, DATA, ROOT, SID, startSession, world, type World } from './world'

// /sessions debug perf in a session: the meter (off until a window opens, counting inside it, handing in at its close),
// the window file the sessions tell each other with, and the command from the window's opening to the report's files.
// The report itself (labels, text, "looks off") is in debug.test.tsx; the sampler in dev/sessions/test-sampler.sh

const BRAVO = 'bbbbbbbb-0000-0000-0000-000000000000'
const WINDOW = `${DATA}/reports/window`
const REPORT = 'r-0a1b2c'
const PYTHON = '/opt/x/bin/python3'

function list(): any[] {
  return [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'alpha' },
    { id: 'bbbbbbbb', sessionId: BRAVO, cwd: ROOT, kind: 'background', status: 'busy', pid: 4243, name: 'bravo' },
  ]
}

// A clock a test moves by hand, for the meter
function hand(at = 1000) {
  const c = { at }
  return { c, now: () => c.at }
}

test('the meter: off it counts nothing; a window counts from zero, by action and in all, and its close hands in once', () => {
  const { c, now } = hand()
  const m = createMeter({ refresh: { drivers: ['peer'], grows: ['sessions'] }, beat: { drivers: ['clock'] } }, 500, now)
  expect(m.on).toBe(false)
  // Off: an action just runs, and nothing is kept
  expect(m.run('refresh', () => 7)).toBe(7)
  m.work('read')
  m.tick('beat')
  expect(m.close(REPORT, {}, {})).toBe(null)

  m.open(REPORT, 61000, { list: { grows: ['sessions'], now: [2, null] } })
  expect(m.on).toBe(true)
  expect(m.report()).toBe(REPORT)
  m.run('refresh', () => {
    m.work('read', 3)
    m.bytes(2048, 0)
    m.failed('read')
    c.at += 4
  })
  m.run('refresh', () => {
    m.work('read')
    c.at += 10
  })
  m.tick('beat')
  m.run('beat', () => {
    m.work('write')
    m.bytes(0, 64)
    m.sent('heartbeat')
    m.started('mv')
  })
  // Outside any action: in the totals only
  m.work('store')
  c.at = 61000
  const h = m.close(REPORT, { list: { grows: ['sessions'], now: [3, null] } }, { live: 'own-watch', leads: false })!
  expect(h).toMatchObject({ format: 1, loadedAt: 500, from: 1000, to: 61000, facts: { live: 'own-watch', leads: false } })
  expect(h.partial).toBe(undefined)
  expect(h.actions.refresh).toEqual({ drivers: ['peer'], grows: ['sessions'], runs: 2, ms: 14, slowest: 10, mostWork: 3, work: { read: 4 }, failed: { read: 1 }, sent: {}, started: {}, bytesRead: 2048, bytesWritten: 0 })
  expect(h.actions.beat).toMatchObject({ drivers: ['clock'], grows: [], runs: 2, ms: 0, work: { write: 1 }, sent: { heartbeat: 1 }, started: { mv: 1 }, bytesWritten: 64 })
  expect(h.totals).toEqual({ work: { read: 4, write: 1, store: 1 }, failed: { read: 1 }, sent: { heartbeat: 1 }, started: { mv: 1 }, bytesRead: 2048, bytesWritten: 64 })
  expect(h.holdings).toEqual({ list: { grows: ['sessions'], open: [2, null], close: [3, null] } })
  // Handed in: off, with nothing left for a second close
  expect(m.on).toBe(false)
  expect(m.close(REPORT, {}, {})).toBe(null)
})

test("the meter: an action inside another has its time taken off the outer one's, an async one lasts until it settles, and another report's close is nothing", async () => {
  const { c, now } = hand()
  const m = createMeter({}, 500, now)
  m.open(REPORT, 61000, {})
  await m.run('events', async () => {
    c.at += 2
    await m.run('refresh', async () => {
      m.work('read')
      c.at += 5
    })
    c.at += 1
  })
  expect(m.close('r-ffffff', {}, {})).toBe(null)
  const h = m.close(REPORT, {}, {})!
  // An action nobody declared is still counted, with no driver
  expect(h.actions.events).toMatchObject({ drivers: [], runs: 1, ms: 3, mostWork: 0 })
  expect(h.actions.refresh).toMatchObject({ runs: 1, ms: 5, mostWork: 1, work: { read: 1 } })
})

test("the meter: a window whose close never comes ends at the first count past its end, and a module loaded inside the window says so", () => {
  const { c, now } = hand()
  const m = createMeter({}, 500, now)
  m.open(REPORT, 61000, {})
  m.work('read')
  c.at = 61000 + WINDOW_GRACE_MS + 1
  m.work('read')
  expect(m.on).toBe(false)
  expect(m.close(REPORT, {}, {})).toBe(null)
  // Loaded after the window opened elsewhere (a reload): what it hands in covers part of it
  const late = createMeter({}, 2000, now)
  c.at = 1500
  late.open(REPORT, 9_000_000, {})
  expect(late.close(REPORT, {}, {})!.partial).toBe('reloaded')
})

test('the window file: its text and back, and what is no window (empty, another format, a made-up id)', () => {
  const text = windowText({ report: REPORT, profile: 'perf', open: true, until: 61000 }, 1000, SID)
  expect(parseWindow(text)).toEqual({ report: REPORT, profile: 'perf', open: true, until: 61000 })
  expect(parseWindow(windowText({ report: REPORT, profile: 'perf', open: false, until: 61000 }, 1000, SID))?.open).toBe(false)
  expect(parseWindow('')).toBe(null)
  expect(parseWindow(text.replace(/^format=\d+/, 'format=999'))).toBe(null)
  expect(parseWindow(text.replace(REPORT, '../x'))).toBe(null)
  expect(handInFile(SID, 'fleet')).toBe(`${SID}.fleet.json`)
  expect(handInFile('../x', 'fleet')).toBe(null)
  expect(handInFile(SID, 'Fleet')).toBe(null)
  expect(parseHandInFile(`${SID}.fleet.json`)).toEqual({ sessionId: SID, plugin: 'fleet' })
  expect(parseHandInFile('sampler.json')).toBe(null)
  expect(perfSeconds(undefined)).toBe(60)
  expect(perfSeconds('300')).toBe(300)
  expect(perfSeconds('4')).toBe(null)
  expect(perfSeconds('601')).toBe(null)
  expect(perfSeconds('1m')).toBe(null)
})

// Another session opens or closes a window: the file, and the bell that says so
async function ring($: any, w: World, open: boolean, until: number, report = REPORT) {
  w.write(WINDOW, windowText({ report, profile: 'perf', open, until }, w.clock.now(), BRAVO))
  w.write(`${DATA}/bell/debug`, bellText(BRAVO, w.clock.now()))
  await $.classic.FileChanged({ file_path: `${DATA}/bell/debug`, event: 'change' } as any)
  await w.clock.advance(100)
}

const reportFiles = (w: World) => [...w.files.keys()].filter(p => p.startsWith(`${DATA}/reports/`) || p === `${DATA}/bell/debug`)

test('with no window ever opened, a session keeps and writes nothing for debug, however long it runs', async ($, on) => {
  const w = world(on, { list: list() })
  await startSession($, w)
  await w.clock.advance(60000)
  expect(reportFiles(w)).toEqual([])
})

test("a window another session opens: this one counts its own work until the close, and hands it in once, in the report's folder", async ($, on) => {
  const w = world(on, { list: list() })
  await startSession($, w)
  await w.clock.advance(5000)
  const handIn = `${DATA}/reports/${REPORT}/${SID}.sessions.json`
  const until = w.clock.now() + 60000
  await ring($, w, true, until)
  expect(w.files.has(handIn)).toBe(false)
  // 31 s: the heartbeat's timer fires twice, and each beat is a write the others can see
  await w.clock.advance(31000)
  await ring($, w, false, until)
  const h = JSON.parse(w.files.get(handIn)!)
  expect(h.format).toBe(1)
  expect(h.actions['timer.heartbeat']).toMatchObject({ drivers: ['clock'], runs: 2 })
  expect(h.actions.heartbeat).toMatchObject({ runs: 2, work: { write: 2 }, sent: { heartbeat: 2 } })
  expect(h.totals.sent.heartbeat).toBe(2)
  expect(h.totals.work.write).toBeGreaterThanOrEqual(2)
  expect(h.facts).toMatchObject({ start: 'came', leads: true, looking: true })
  expect(h.holdings.list.close[0]).toBe(2)
  // The close heard again (its own bell, a second event): nothing is written twice
  w.files.delete(handIn)
  await ring($, w, false, until)
  expect(w.files.has(handIn)).toBe(false)
  // And the counting is over: an hour more adds no file
  await w.clock.advance(60000)
  expect(w.files.has(handIn)).toBe(false)
})

test('a window whose end has already passed when its bell is heard is not joined', async ($, on) => {
  const w = world(on, { list: list() })
  await startSession($, w)
  await w.clock.advance(5000)
  const until = w.clock.now() - 1000
  await ring($, w, true, until)
  await w.clock.advance(20000)
  await ring($, w, false, until)
  expect(w.files.has(`${DATA}/reports/${REPORT}/${SID}.sessions.json`)).toBe(false)
})

// What sampler.py would write for the two sessions, in round numbers
function sampled(pids: string[]) {
  const one = { cpuMs: 100, childCpuMs: 0, memoryMB: [200, 200], memoryKind: 'footprint', peakMB: 250, pssMB: null, wakeups: { idle: 60, interrupt: 30 }, threads: 20, gone: false, started: {}, helpers: {}, transcriptMB: 10 }
  return {
    format: 1,
    how: 'libproc',
    seconds: 5,
    samples: 10,
    machine: { cores: 8, memoryMB: 16384, freeMB: [4000, 4000], swapUsedMB: [0, 0], pressure: [1, 1], pressureKind: 'level', battery: false },
    processes: Object.fromEntries(pids.map(pid => [pid, one])),
    other: { cpuMs: 1000, largestMs: 500, over20: 0 },
    roles: { terminal: null, service: null },
    unavailable: ['pss', 'terminal', 'service'],
  }
}

async function sessions($: any, args: string): Promise<string> {
  const r: any = await $.command.run({ command: 'sessions', args, ...COMMAND })
  return String(r.text)
}

test('/sessions debug perf: the window opens, the sampler runs for it, the window closes, and the report is written with labels only; show prints it again', async ($, on) => {
  let w: World
  const samplerRuns: string[][] = []
  w = world(on, {
    list: list(),
    python: PYTHON,
    onRun: argv => {
      if (argv[0] === PYTHON && String(argv[1]).endsWith('/debug/sampler.py')) {
        samplerRuns.push([...argv])
        w.write(argv[argv.indexOf('--out') + 1]!, JSON.stringify(sampled(['4242', '4243'])))
      }
    },
  })
  await startSession($, w)
  await w.clock.advance(5000)
  const asked = sessions($, 'debug perf 5')
  for (let i = 0; i < 12; i++) await w.clock.advance(1000)
  const text = await asked
  // The sampler was told how to read this system, for how long, which processes, and which programs it may name
  expect(samplerRuns.length).toBe(1)
  const argv = samplerRuns[0]!
  expect(argv.slice(2, 7)).toEqual(['perf', '--how', 'libproc', '--seconds', '5'])
  expect(argv[argv.indexOf('--sessions') + 1]).toBe(`4242:${SID},4243:${BRAVO}`)
  expect(argv[argv.indexOf('--programs') + 1]).toContain('git')
  const report = String(argv[argv.indexOf('--out') + 1]).split('/').slice(-2)[0]!
  expect(report).toMatch(/^r-[0-9a-f]{6}$/)
  // The window was opened, then closed, with the debug bell
  expect(parseWindow(w.files.get(WINDOW)!)).toMatchObject({ report, open: false })
  expect(w.files.has(`${DATA}/bell/debug`)).toBe(true)
  // The report: labels in the file that may leave, names only in the key and on screen
  const file = w.files.get(`${DATA}/reports/${report}.json`)!
  const plain = w.files.get(`${DATA}/reports/${report}.txt`)!
  const key = w.files.get(`${DATA}/reports/${report}.key.json`)!
  for (const leak of ['alpha', 'bravo', ROOT, SID, BRAVO, 'myapp']) {
    expect(file).not.toContain(leak)
    expect(plain).not.toContain(leak)
  }
  expect(key).toContain('alpha')
  expect(key).toContain(ROOT)
  const parsed = JSON.parse(file)
  expect(parsed).toMatchObject({ format: 1, report, profile: 'perf', seconds: 5 })
  expect(parsed.sessions.length).toBe(2)
  // This session's own part was counted and handed in; the other session runs no mod here, so it has none
  const mine = parsed.sessions.find((x: any) => x.meters.sessions)
  expect(mine.meters.sessions.project.shared.heartbeats).toBeGreaterThanOrEqual(1)
  expect(text).toContain(`${DATA}/reports/${report}.json`)
  expect(text).toContain('Key (stays here)')
  expect(w.files.get(`${DATA}/reports/last`)).toBe(report)
  expect(await sessions($, 'debug show')).toBe(text)
  expect(w.toasts.some(t => t.includes('report is ready'))).toBe(true)
})

test('/sessions debug: what it says with no python, a bad length, another session measuring, and no report yet', async ($, on) => {
  const w = world(on, { list: list() })
  await startSession($, w)
  await w.clock.advance(5000)
  expect(await sessions($, 'debug')).toContain('/sessions debug perf [seconds]')
  expect(await sessions($, 'debug show')).toContain('No report yet')
  expect(await sessions($, 'debug perf 2')).toContain("isn't a length")
  expect(await sessions($, 'debug perf')).toContain("python3 isn't usable")
  expect(reportFiles(w)).toEqual([])
})

test('/sessions debug perf while another session measures: refused, one at a time on a machine', async ($, on) => {
  const w = world(on, { list: list(), python: PYTHON })
  await startSession($, w)
  await w.clock.advance(5000)
  await ring($, w, true, w.clock.now() + 60000)
  expect(await sessions($, 'debug perf')).toContain('Another session is measuring')
})
