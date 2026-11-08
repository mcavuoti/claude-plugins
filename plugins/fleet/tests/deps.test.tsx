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
