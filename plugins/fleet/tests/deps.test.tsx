import { test, expect } from 'claude-code/testing'
import { BAND, FLEET, ROOT, decide, fleet, sessionsSay, startSession, world, WITH_SESSIONS } from './world'

// What fleet needs (CONTRIBUTING.md, "Dependencies, not fallbacks"): sessions at its version, python3 and Claude Code.
// A missing one is said in /fleet status, the band and the commands that need it; there's no second way without it

test('everything here: /fleet status names nothing missing', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  const status = await fleet($, 'status')
  expect(status).toContain('sessions: api 1, version 0.17.0')
  expect(status).not.toContain('fleet needs')
})

test('sessions not loaded: one line says what to update, in /fleet status and the band', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  sessionsSay(w, { gone: true })
  await startSession($, w)
  expect(await fleet($, 'status')).toContain('✗ fleet needs sessions 0.17.0 or later (not answering in this session): update it (claude plugin update sessions@mcavuoti) and restart (u)')
  await w.clock.advance(61000)
  await w.clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).toContain('✗ fleet needs sessions 0.17.0 or later (not answering in this session)')
})

test('an older sessions: the same line, naming the version there', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  sessionsSay(w, { version: '0.16.3' })
  await startSession($, w)
  expect(await fleet($, 'status')).toContain('✗ fleet needs sessions 0.17.0 or later (0.16.3 here)')
})

test('python3 missing: /fleet status says so, and a .py draft is refused with it, never let through unchecked', WITH_SESSIONS, async ($, on) => {
  const checks = [{ glob: 'notes/**', argv: ['python3', 'checks/lint.py'] }]
  const w = world(on, { files: { [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], checks }), [`${ROOT}/checks/lint.py`]: 'print(1)\n' } })
  w.exec.value = argv => (argv[0] === 'python3' ? { exitCode: 127, stderr: 'python3: command not found' } : undefined)
  await startSession($, w)
  expect(await fleet($, 'status')).toContain('✗ fleet needs python3')
  const r = await decide($, { kind: 'change', path: 'checks/lint.py', summary: 'a helper', content: 'print(2)\n' })
  expect(r.deny).toBe("the draft of checks/lint.py can't be checked: fleet needs python3 (a .py draft is parsed with it, and the proofs check runs with it): install it, then restart (u). Nothing was queued.")
})

test('an older Claude Code: /fleet status names the version fleet needs', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  on('session.version', () => ({ value: { version: '2.1.300', base: '2.1.300' } as any }))
  await startSession($, w)
  expect(await fleet($, 'status')).toContain('✗ fleet needs Claude Code 2.1.319 or later (2.1.300 here): update it (claude update) and restart (u)')
})

// A passing hiccup is not a missing dependency: only a success is kept, and what failed is asked again a minute later
const checks = [{ glob: 'notes/**', argv: ['python3', 'checks/lint.py'] }]
const pyWorld = (on: any) => world(on, { files: { [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], checks }), [`${ROOT}/checks/lint.py`]: 'print(1)\n' } })
let mounts = 0
const band = async ($: any) => JSON.stringify(await (await $.ui.mount({ ...BAND, requestId: `deps-band-${++mounts}`, surface: 'terminal' })).drawn())
const pass = async (w: any, ms: number, step = 5000) => {
  for (let t = 0; t < ms; t += step) {
    await w.clock.advance(Math.min(step, ms - t))
    await w.clock.settle()
  }
}
/** The seconds from now until the band stops saying sessions is missing, looking each second up to limit; -1 if it never does */
const bandClears = async ($: any, w: any, limit: number) => {
  for (let s = 1; s <= limit; s++) {
    await pass(w, 1000)
    if (!(await band($)).includes('fleet needs sessions')) return s
  }
  return -1
}

test('python3: a probe that couldn’t finish is asked again, and the probe runs as the parse does (-I)', { ...WITH_SESSIONS, timeoutMs: 120000 }, async ($, on) => {
  const w = pyWorld(on)
  const probes: string[][] = []
  w.exec.value = argv => {
    if (argv[0] !== 'python3') return undefined
    if (argv.includes('pass') && probes.push(argv) === 1) throw new Error('command timed out')
    return { exitCode: 0 }
  }
  await startSession($, w)
  await w.clock.settle()
  expect(await fleet($, 'status')).toContain('✗ fleet needs python3')
  await pass(w, 3 * 60000)
  expect(await fleet($, 'status')).not.toContain('fleet needs python3')
  expect(await band($)).not.toContain('fleet needs python3')
  expect((await decide($, { kind: 'change', path: 'checks/lint.py', summary: 'a helper', content: 'print(2)\n' })).deny).toBeUndefined()
  expect(probes.length).toBe(2)
  expect(probes[0]).toEqual(['python3', '-I', '-c', 'pass'])
})

test('python3: a child killed by a signal at the probe (it reads as exit 1) isn’t "missing" either', { ...WITH_SESSIONS, timeoutMs: 120000 }, async ($, on) => {
  const w = pyWorld(on)
  let probes = 0
  w.exec.value = argv => {
    if (argv[0] !== 'python3') return undefined
    if (argv.includes('pass') && ++probes === 1) return { exitCode: 1, stderr: '' }
    return { exitCode: 0 }
  }
  await startSession($, w)
  await pass(w, 3 * 60000)
  expect(await fleet($, 'status')).not.toContain('fleet needs python3')
})

test('python3 really missing: asked once a minute, and still said', { ...WITH_SESSIONS, timeoutMs: 120000 }, async ($, on) => {
  const w = pyWorld(on)
  let probes = 0
  w.exec.value = argv => {
    if (argv[0] !== 'python3') return undefined
    if (argv.includes('pass')) probes++
    return { exitCode: 127, stderr: 'python3: command not found' }
  }
  await startSession($, w)
  await w.clock.settle()
  const first = probes
  await pass(w, 3 * 60000)
  expect(probes - first).toBe(3)
  expect(await fleet($, 'status')).toContain('✗ fleet needs python3')
})

test('python3 here, its parse couldn’t start: the model is told to file it again, not that its Python is wrong', WITH_SESSIONS, async ($, on) => {
  const w = pyWorld(on)
  w.exec.value = argv => {
    if (argv[0] !== 'python3' || argv.includes('pass')) return undefined
    if (argv.includes('-I')) throw new Error('EAGAIN: resource temporarily unavailable, posix_spawn')
    return { exitCode: 0 }
  }
  await startSession($, w)
  const deny = String((await decide($, { kind: 'change', path: 'checks/lint.py', summary: 'a helper', content: 'print(2)\n' })).deny)
  expect(deny).toContain("couldn't run python3 just now: file it again. Nothing was queued.")
  expect(deny).not.toContain("doesn't parse as Python")
  expect(deny).not.toContain('install')
})

test('sessions answers 30 s after the start: the band clears on the next minute’s check', { ...WITH_SESSIONS, timeoutMs: 180000 }, async ($, on) => {
  const w = world(on)
  sessionsSay(w, { gone: true })
  await startSession($, w)
  await pass(w, 2000, 1000)
  expect(await band($)).toContain('fleet needs sessions')
  await pass(w, 28000, 1000)
  sessionsSay(w, {})
  const cleared = await bandClears($, w, 95)
  expect(cleared).toBeGreaterThan(0)
  expect(cleared).toBeLessThanOrEqual(35)
})

test('sessions answers well after a minute: fleet recovers by itself, with no restart', { ...WITH_SESSIONS, timeoutMs: 180000 }, async ($, on) => {
  const w = world(on)
  sessionsSay(w, { gone: true })
  await startSession($, w)
  await pass(w, 90000)
  expect(await band($)).toContain('fleet needs sessions')
  expect(await fleet($, 'status')).toContain('✗ fleet needs sessions 0.17.0 or later (not answering in this session)')
  sessionsSay(w, {})
  const cleared = await bandClears($, w, 65)
  expect(cleared).toBeGreaterThan(0)
  expect(await fleet($, 'status')).toContain('sessions: api 1, version 0.17.0')
})

test('a contract answered with an empty version is asked again, like one that didn’t answer', { ...WITH_SESSIONS, timeoutMs: 120000 }, async ($, on) => {
  const w = world(on)
  sessionsSay(w, { version: '' })
  await startSession($, w)
  await pass(w, 2000, 1000)
  expect(await fleet($, 'status')).toContain('✗ fleet needs sessions 0.17.0 or later (an older version here)')
  sessionsSay(w, {})
  await pass(w, 2 * 60000)
  expect(await fleet($, 'status')).not.toContain('fleet needs sessions')
})
