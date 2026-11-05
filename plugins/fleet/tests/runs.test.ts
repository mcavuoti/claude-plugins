import { expect, test } from 'claude-code/testing'

import { DETACHED_RECIPE, RUN_DESCRIPTION, checkDeclare, doneExit, finishedText, parseRun, parseStep, runIdOf, runLine, runNumber, type RunFile, type RunView } from '../hooks/runs'

// The run register (B16, G2): what declare takes, a done-file's exit code, a run as a line and as the news its owner
// hears: pure logic

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const OWNER = { name: 'PoC A', slug: 'poc-a', ref: 'aaaaaaaa', sessionId: 'aaaaaaaa-0000-0000-0000-000000000000' }

test('declare: what and a done-file, plain paths, a host as an ssh target, a done-file there absolute', () => {
  expect(checkDeclare({ what: 'the timing sim', done: 'runs/sim1/done' })).toEqual({ ok: true, what: 'the timing sim', item: null, host: null, dir: null, done: 'runs/sim1/done', log: null })
  expect(checkDeclare({ what: ' the sim ', item: 'B-12', host: 'dev', dir: '/scratch/x/sim1', done: '/scratch/x/sim1/done', log: '/scratch/x/sim1/log' })).toMatchObject({ ok: true, host: 'dev', item: 'B-12', what: 'the sim' })
  expect(checkDeclare({ done: 'x/done' })).toMatchObject({ ok: false, reason: expect.stringContaining('say what the run is') })
  expect(checkDeclare({ what: 'x' })).toMatchObject({ ok: false, reason: expect.stringContaining('name its done-file') })
  expect(checkDeclare({ what: 'x', done: 'a b/done' })).toMatchObject({ ok: false, reason: expect.stringContaining('done has characters') })
  expect(checkDeclare({ what: 'x', done: '/a/done', log: '$(rm x)' })).toMatchObject({ ok: false, reason: expect.stringContaining('log has characters') })
  expect(checkDeclare({ what: 'x', done: '/a/done', host: 'dev; rm' })).toMatchObject({ ok: false, reason: expect.stringContaining('host is an ssh target') })
  expect(checkDeclare({ what: 'x', done: 'sim/done', host: 'dev' })).toMatchObject({ ok: false, reason: expect.stringContaining('absolute path') })
  expect(checkDeclare({ what: 'x', done: '~/sim/done', host: 'me@dev.example.com' })).toMatchObject({ ok: true })
  expect(checkDeclare({ what: 'x', done: '/a/done', item: 'the sim item' })).toMatchObject({ ok: false, reason: expect.stringContaining('board item id') })
  expect(checkDeclare({ what: 'x'.repeat(301), done: '/a/done' })).toMatchObject({ ok: false, reason: expect.stringContaining('300 at most') })
})

test("a done-file's exit code, the files' wire format, a run's line and its news", () => {
  expect(doneExit('0\n')).toBe(0)
  expect(doneExit('exit 137\n')).toBe(137)
  expect(doneExit('')).toBe(null)
  expect(runNumber('run-12')).toBe(12)
  expect(runNumber('B-1')).toBe(0)
  // A run's id is never a record's (R-3 is a requirement's in the templates)
  expect(runNumber('R-12')).toBe(0)
  expect(parseRun(JSON.stringify({ format: 1, id: 'R-3', at: NOW, owner: OWNER, what: 'x', done: 'd' }), 1)).toBe(null)
  expect(runIdOf(' Run-03 ')).toBe('run-3')
  expect(runIdOf('R-3')).toBe(null)
  // The recipe the roles are given works on macOS too: no setsid
  expect(DETACHED_RECIPE).not.toContain('setsid')
  expect(RUN_DESCRIPTION).toContain(DETACHED_RECIPE)
  const run: RunFile = { format: 1, id: 'run-3', at: NOW - 3600000, owner: OWNER, what: 'the timing sim', item: 'B-12', host: 'dev', dir: '/scratch/x/sim1', done: '/scratch/x/sim1/done', log: '/scratch/x/sim1/log' }
  expect(parseRun(JSON.stringify(run), 1)).toEqual(run)
  expect(parseRun(JSON.stringify({ ...run, format: 2 }), 1)).toBe(null)
  expect(parseRun(JSON.stringify({ ...run, id: 'X' }), 1)).toBe(null)
  expect(parseRun('not json', 1)).toBe(null)
  expect(parseStep(JSON.stringify({ format: 1, id: 'run-3', at: NOW, exit: 0 }), 1)).toEqual({ format: 1, id: 'run-3', at: NOW, exit: 0 })
  expect(parseStep(JSON.stringify({ format: 2, id: 'run-3' }), 1)).toBe(null)
  const flying: RunView = { run, done: null, recorded: null }
  expect(runLine(flying, NOW, 0)).toBe('run-3 (PoC A, B-12): the timing sim on dev: running since 11:00 (done-file /scratch/x/sim1/done)')
  const done: RunView = { run, done: { format: 1, id: 'run-3', at: NOW - 600000, exit: 0 }, recorded: null }
  expect(runLine(done, NOW, 0)).toBe('run-3 (PoC A, B-12): the timing sim on dev: finished at 11:50 (exit 0), not recorded yet')
  expect(runLine({ ...done, recorded: { format: 1, id: 'run-3', at: NOW - 120000, result: 'results/sim1.md' } }, NOW, 0)).toBe('run-3 (PoC A, B-12): the timing sim on dev: recorded 2m ago')
  expect(finishedText(done, 0)).toBe(
    'fleet: your run run-3 for B-12 (the timing sim, on dev) finished at 11:50 (exit 0). Read its output (/scratch/x/sim1/log), land the result where it goes, and record it: mcp__fleet__run record with its id and where the result is.',
  )
})
