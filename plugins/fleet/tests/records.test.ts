import { expect, test } from 'claude-code/testing'

import { hashText } from '../hooks/changes'
import {
  changeOf,
  checkOutcome,
  confirmedPins,
  checksKey,
  commitMessage,
  copyOf,
  idOf,
  isStrict,
  landedText,
  landingKind,
  leaseState,
  needsCheck,
  ownedBy,
  pinProblems,
  pinState,
  pinsOf,
  pinsText,
  porcelainPaths,
  problemKeys,
  recordsOf,
  scriptsOf,
  suspectLine,
  suspectsOf,
  worktreeFolders,
  type Records,
  type Rev,
} from '../hooks/records'

const ME = { sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', offsetMin: 0 }
const AT = Date.UTC(2026, 10, 2, 14, 2, 0)
const R = { sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', agentId: null, ref: 'bbbbbbbb', name: 'TEST R' }

function recs(extra: Record<string, unknown> = {}): Records {
  const r = recordsOf({ worldFormat: 1, paths: ['req/**', 'board/**'], ...extra }, false)
  if (!('records' in r)) throw new Error(r.problem)
  return r.records
}

function rev(n: number, kind: Rev['kind'] = 'revision', over: Partial<Rev> = {}): Rev {
  return { format: 1, id: 'R-1', path: 'req/R-1.md', rev: n, hash: `h${n}`, kind, changeHash: null, at: AT, by: R, via: 'tool', pins: [], ...over }
}

test('world.json: ids by default, idPattern, strict, checks and commits; what is wrong is named', () => {
  const r = recs()
  expect(r.strict).toBe(null)
  expect(r.checks).toEqual([])
  expect(r.commitEveryMin).toBe(null)
  expect(r.changeKey).toBe('change')
  expect((recordsOf({ worldFormat: 1, paths: [], idPattern: '^(R)' }, false) as any).problem).toContain('no groups')
  expect((recordsOf({ worldFormat: 1, paths: [], idPattern: '*R' }, false) as any).problem).toContain("isn't a valid pattern")
  expect(isStrict(recs({ strict: true }), 'board/B-1.md')).toBe(true)
  const some = recs({ strict: ['board/**'] })
  expect([isStrict(some, 'board/B-1.md'), isStrict(some, 'req/R-1.md')]).toEqual([true, false])
  expect(isStrict(recs({ strict: false }), 'board/B-1.md')).toBe(false)
  const c = recs({ checks: [{ glob: 'board/**', argv: ['python3', 'checks/board.py'] }, { name: 'links', glob: '**/*.md', argv: ['checks/links.sh'], when: 'sweep', everyMin: 30 }], commit: { everyMin: 60 } })
  expect(c.checks.map(x => [x.name, x.when, x.everyMin, x.timeoutMs])).toEqual([
    ['board.py', 'land', 10, 20000],
    ['links', 'sweep', 30, 20000],
  ])
  expect(c.commitEveryMin).toBe(60)
  expect((recordsOf({ worldFormat: 1, paths: [], checks: [{ glob: 'x/**', argv: [] }] }, false) as any).problem).toContain('argv')
  expect((recordsOf({ worldFormat: 1, paths: [], checks: [{ glob: '/x', argv: ['a'] }] }, false) as any).problem).toContain('relative')
  expect(scriptsOf(c.checks)).toEqual(['checks/board.py', 'checks/links.sh', 'python3'])
  // R8: a script named with no slash, by an absolute path inside the project, or behind make and npm run
  const r8 = recs({ checks: [{ glob: 'a/**', argv: ['python3', 'check.py'] }, { glob: 'b/**', argv: ['bash', '/Users/x/proj/tools/lint.sh', '--fix'] }, { glob: 'c/**', argv: ['make', 'lint'] }, { glob: 'd/**', argv: ['npm', 'run', 'check'] }, { glob: 'e/**', argv: ['bash', '/elsewhere/x.sh', '../up.sh'] }] })
  expect(scriptsOf(r8.checks, ['/Users/x/proj'])).toEqual(['GNUmakefile', 'Makefile', 'bash', 'check', 'check.py', 'lint', 'make', 'makefile', 'npm', 'package.json', 'python3', 'run', 'tools/lint.sh'])
  expect(checksKey(c.checks, new Map([['checks/board.py', 'h1']]))).not.toBe(checksKey(c.checks, new Map([['checks/board.py', 'h2']])))
})

test('a record is a shared file whose name starts with an id; pins are ID@n anywhere in its text', () => {
  const r = recs()
  expect(idOf('req/R-12.md', r)).toBe('R-12')
  expect(idOf('req/R-12-max-rate.md', r)).toBe('R-12')
  expect(idOf('req/R-123.md', r)).toBe('R-123')
  expect(idOf('notes/plan.md', r)).toBe(null)
  expect(idOf('docs/README.md', r)).toBe(null)
  expect(idOf('board/ADR-0007 notes.md', r)).toBe('ADR-0007')
  const text = '---\nrelies_on: [R-12@4, F-40@2]\n---\nAs R-12@4 says, and see ADR-7@1; not xR-1@2, nor R-3@0, nor someone@example.com\n'
  expect(pinsOf(text, r)).toEqual([
    { id: 'ADR-7', rev: 1 },
    { id: 'F-40', rev: 2 },
    { id: 'R-12', rev: 4 },
  ])
  const own = recs({ idPattern: 'REQ[0-9]+' })
  expect(idOf('req/REQ12.md', own)).toBe('REQ12')
  expect(pinsOf('cites REQ12@3 and R-1@1', own)).toEqual([{ id: 'REQ12', rev: 3 }])
})

test('the kind of a landing: the change line when it was rewritten, else a revision; new is an addition, gone a retraction', () => {
  const ed = changeOf('---\nid: R-1\nchange: "editorial: typo"\n---\nbody\n', 'change')
  expect(ed?.kind).toBe('editorial')
  expect(changeOf('change: rewrote the intro\n', 'change')?.kind).toBe(null)
  expect(changeOf('no line here\n', 'change')).toBe(null)
  expect(changeOf('---\ntitle: x\n---\nchange: editorial: not in the front matter\n', 'change')).toBe(null)
  const prev = rev(3, 'revision', { changeHash: hashText('revision: earlier') })
  expect(landingKind(ed, prev, false)).toBe('editorial')
  expect(landingKind({ kind: 'editorial', hash: hashText('revision: earlier') }, prev, false)).toBe('revision')
  expect(landingKind(null, prev, false)).toBe('revision')
  expect(landingKind(null, null, false)).toBe('addition')
  expect(landingKind(ed, prev, true)).toBe('retraction')
})

test('a pin is stale only when a revision or retraction landed after it; a version not there yet, and no record, are named', () => {
  const revs = [rev(1, 'addition'), rev(2, 'editorial'), rev(3, 'revision'), rev(4, 'editorial')]
  expect(pinState({ id: 'R-1', rev: 3 }, revs)).toMatchObject({ state: 'current', now: 4 })
  expect(pinState({ id: 'R-1', rev: 2 }, revs)).toMatchObject({ state: 'stale', now: 4, moved: { rev: 3 } })
  expect(pinState({ id: 'R-1', rev: 9 }, revs)).toMatchObject({ state: 'ahead', now: 4 })
  expect(pinState({ id: 'R-9', rev: 1 }, [])).toMatchObject({ state: 'unknown' })
})

test('the gate asks for a read: a stale pin not read as it is, a new pin never read; a current pin the file had needs nothing', () => {
  const states = { 'R-1': [rev(1, 'addition'), rev(2)], 'R-2': [rev(1, 'addition', { id: 'R-2' })], 'R-3': [rev(1, 'addition', { id: 'R-3' })] } as Record<string, Rev[]>
  const st = (p: { id: string; rev: number }) => pinState(p, states[p.id])
  const pins = [
    { id: 'R-1', rev: 1 },
    { id: 'R-2', rev: 1 },
    { id: 'R-3', rev: 1 },
    { id: 'R-9', rev: 1 },
  ]
  const reads: Record<string, 'current' | 'older' | 'never'> = { 'R-1': 'older', 'R-2': 'never', 'R-3': 'never' }
  const problems = pinProblems(pins, new Set(['R-3@1']), st, id => reads[id] ?? 'never', id => `req/${id}.md`)
  expect(problems.map(p => [p.pin.id, p.why])).toEqual([
    ['R-1', 'stale'],
    ['R-2', 'unread'],
  ])
  expect(problemKeys(problems)).toEqual(['R-1@1:stale:2', 'R-2@1:unread:1'])
  // After a read of R-1 as it is now, its stale pin passes, and the landing confirms it (until R-1 moves again)
  expect(pinProblems(pins.slice(0, 1), new Set(), st, () => 'current', () => null)).toEqual([])
  expect(confirmedPins(pins.map(st), id => (id === 'R-1' ? 'current' : 'never'))).toEqual(['R-1@1>2'])
  const text = pinsText(problems, ME, true)
  expect(text).toBe(
    [
      'fleet: this write cites records you need to read first (this write was not made):',
      '- R-1@1: R-1 is at v2 now (a revision at 14:02 by TEST R). Read req/R-1.md, decide whether your work still holds, then cite R-1@2, or say in your record why v1 still holds.',
      "- R-2@1: you haven't read R-2 in this conversation. Read req/R-2.md first.",
      'Then write again. If what changed contradicts your task, ask the person with mcp__fleet__decide.',
    ].join('\n'),
  )
  expect(landedText('board/B-1.md', 'B-1', 3, [{ id: 'R-9', rev: 1 }], [])).toBe('fleet: board/B-1.md is now B-1@3; it cites R-9@1, which no shared file is (a record\'s file name starts with its id).')
})

test('suspects: a stale pin, a blind landing, a pin of no record; and whatever cites a suspect record, transitively', () => {
  const revs = { 'R-1': [rev(1, 'addition'), rev(2)], 'B-1': [rev(1, 'addition', { id: 'B-1' })], 'B-2': [rev(1, 'addition', { id: 'B-2' })], 'P-1': [rev(1, 'addition', { id: 'P-1' })] } as Record<string, Rev[]>
  const W = { sessionId: 'cccccccc-0000-0000-0000-000000000000', agentId: null, ref: 'cccccccc', name: 'TEST W' }
  const list = suspectsOf(
    [
      { path: 'board/B-1.md', id: 'B-1', pins: ['R-1@1'], owner: W },
      { path: 'board/B-2.md', id: 'B-2', pins: ['R-1@2'], owner: W, blind: ['R-1@2:unread'] },
      { path: 'docs/P-1.md', id: 'P-1', pins: ['B-1@1'], owner: null },
      { path: 'notes/summary.md', id: null, pins: ['P-1@1', 'X-1@1'], owner: null },
      { path: 'notes/fine.md', id: null, pins: ['R-1@2'], owner: null },
      { path: 'notes/kept.md', id: null, pins: ['R-1@1'], owner: null, confirmed: ['R-1@1>2'] },
      { path: 'notes/kept-before.md', id: null, pins: ['R-1@1'], owner: null, confirmed: ['R-1@1>1'] },
    ],
    p => pinState(p, revs[p.id]),
  )
  expect(list.map(s => [s.path, s.reasons.map(r => r.why), s.via ?? []])).toEqual([
    ['board/B-1.md', ['stale'], []],
    ['board/B-2.md', ['blind'], []],
    ['docs/P-1.md', [], ['B-1']],
    ['notes/kept-before.md', ['stale'], []],
    ['notes/summary.md', ['unknown'], []],
  ])
  expect(suspectLine(list[0]!, ME)).toBe('board/B-1.md (B-1) cites R-1@1, and R-1 is at v2 (a revision at 14:02 by TEST R)')
  expect(suspectLine(list[1]!, ME)).toBe('board/B-2.md (B-2) landed blind citing R-1@2, R-1 unread')
  expect(suspectLine(list[2]!, ME)).toBe('docs/P-1.md cites B-1, which is suspect')
  expect(ownedBy(W, { sessionId: W.sessionId, ref: null })).toBe(true)
  expect(ownedBy({ ...W, sessionId: 'dddddddd-0000-0000-0000-000000000000' }, { sessionId: 'x', ref: 'cccccccc' })).toBe(true)
  expect(ownedBy({ ...W, person: true }, { sessionId: W.sessionId, ref: 'cccccccc' })).toBe(false)
  expect(ownedBy(null, { sessionId: W.sessionId, ref: null })).toBe(false)
})

test('a check run: exit 0 passes all; lines naming a file fail it; no file named fails them all; a command not found is no result', () => {
  const paths = ['board/B-1.md', 'board/B-2.md']
  expect([...(checkOutcome(paths, { exitCode: 0, stdout: 'all good', stderr: '' }) ?? [])]).toEqual([
    ['board/B-1.md', null],
    ['board/B-2.md', null],
  ])
  expect([...(checkOutcome(paths, { exitCode: 1, stdout: 'board/B-2.md:3: missing status\n./board/B-2.md: no owner\n', stderr: '' }) ?? [])]).toEqual([
    ['board/B-1.md', null],
    ['board/B-2.md', '3: missing status; no owner'],
  ])
  expect([...(checkOutcome(paths, { exitCode: 2, stdout: '', stderr: 'schema error\n' }) ?? [])]).toEqual([
    ['board/B-1.md', 'schema error'],
    ['board/B-2.md', 'schema error'],
  ])
  expect(checkOutcome(paths, { exitCode: 127, stdout: '', stderr: 'not found' })).toBe(null)
  const c = recs({ checks: [{ glob: 'board/**', argv: ['checks/board.sh'] }] }).checks[0]!
  expect(needsCheck(undefined, c, 'h1')).toBe(true)
  const file = { format: 1, path: 'board/B-1.md', hash: 'h1', owner: null, results: { 'board.sh': { key: c.key, ok: false, message: 'x', at: AT } } }
  expect(needsCheck(file, c, 'h1')).toBe(false)
  expect(needsCheck(file, c, 'h2')).toBe(true)
  expect(needsCheck({ ...file, results: { 'board.sh': { ...file.results['board.sh'], key: 'other' } } }, c, 'h1')).toBe(true)
})

test('the lease, the commit message, git status -z, worktree folders and copies', () => {
  const lease = { format: 1, sessionId: 'a', ref: null, name: null, at: AT }
  expect(leaseState(null, 'a', AT)).toBe('free')
  expect(leaseState(lease, 'a', AT + 1000)).toBe('mine')
  expect(leaseState(lease, 'b', AT + 1000)).toBe('held')
  expect(leaseState(lease, 'b', AT + 91000)).toBe('free')
  expect(commitMessage(AT, 60)).toBe('fleet: world 2026-11-02 15:02')
  expect(porcelainPaths(' M notes/a.md\0?? notes/new.md\0R  notes/b.md\0notes/old.md\0')).toEqual([
    { xy: ' M', path: 'notes/a.md' },
    { xy: '??', path: 'notes/new.md' },
    { xy: 'R ', path: 'notes/b.md' },
    { xy: 'R ', path: 'notes/old.md' },
  ])
  expect(worktreeFolders('worktree /Users/x/proj\nHEAD abc\nbranch refs/heads/main\n\nworktree /Users/x/proj/.claude/worktrees/w1\nHEAD def\n')).toEqual(['/Users/x/proj', '/Users/x/proj/.claude/worktrees/w1'])
  const linked = ['/Users/x/proj/.claude/worktrees/w1', '/Users/x/proj-wt']
  expect(copyOf('/Users/x/proj/.claude/worktrees/w1/notes/plan.md', linked, '', false)).toEqual({ tree: '/Users/x/proj/.claude/worktrees/w1', rel: 'notes/plan.md' })
  expect(copyOf('/Users/x/proj-wt/sub/notes/plan.md', linked, 'sub', false)).toEqual({ tree: '/Users/x/proj-wt', rel: 'notes/plan.md' })
  expect(copyOf('/Users/x/proj-wt/other/plan.md', linked, 'sub', false)).toEqual({ tree: '/Users/x/proj-wt', rel: '' })
  expect(copyOf('/Users/x/proj/notes/plan.md', linked, '', false)).toBe(null)
  expect(copyOf('/Users/x/PROJ-WT/notes/plan.md', linked, '', true)).toEqual({ tree: '/Users/x/proj-wt', rel: 'notes/plan.md' })
})
