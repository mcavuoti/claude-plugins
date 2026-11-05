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
  proofLines,
  proofProblem,
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
import { behindGroups, behindLine, bodyHashOf, confirmedBy, defaultKindOf, editorialText, elsewhereText, keptAt, movesOf, ownSuspectLines, parseConfirmation, quoteSources, suspectKey, withFix, type Suspect } from '../hooks/records'

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
      "- R-1@1: R-1 is at v2 now (a revision at 14:02 by TEST R). Read req/R-1.md, decide whether your work still holds, then cite R-1@2, or say in your record why v1 still holds (files of yours you aren't rewriting: once checked, mcp__fleet__confirm with of R-1 clears their flags with no new version).",
      "- R-2@1: you haven't read R-2 in this conversation. Read req/R-2.md first.",
      'A read is the Read tool or a plain cat of the file. Then write again. If what changed contradicts your task, ask the person with mcp__fleet__decide.',
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
  // A long message is cut for the model, never through an emoji (a lone surrogate the API would refuse)
  const long = checkOutcome(paths, { exitCode: 1, stdout: `${'x'.repeat(299)}😀 and more\n`, stderr: '' })?.get('board/B-1.md') ?? ''
  expect(long).toBe(`${'x'.repeat(299)}…`)
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

test("proofs: which records must carry one (world.json's paths, or their kind: line), and what a valid-looking one is", () => {
  const r = recs({ paths: ['findings/**', 'req/**'], proofs: { paths: ['findings/**'], kinds: ['Finding', 'result'] } })
  expect(r.proofs?.kinds).toEqual(['finding', 'result'])
  const F = (lines: string) => `---\n${lines}\n---\nF-3: the claim\n`
  // Under the proofs' paths, whatever its kind; elsewhere, by its kind: line
  expect(proofProblem('F-3: a claim, no front matter\n', 'findings/F-3.md', r)).toBe('a record that must carry a proof with no proof: run: and sha: (the command, and the sha256 of its output), or source: and quote: (where, and the exact text)')
  expect(proofProblem(F('kind: note'), 'req/R-1.md', r)).toBeNull()
  expect(proofProblem(F('kind: result'), 'req/R-1.md', r)).toBe('a result with no proof: run: and sha: (the command, and the sha256 of its output), or source: and quote: (where, and the exact text)')
  expect(proofProblem(F(`kind: result\nrun: printf 'x'\nsha: 2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881`), 'req/R-1.md', r)).toBeNull()
  expect(proofProblem(F('kind: result\nrun: make sim\nsha: sha256:2D711642B726'), 'req/R-1.md', r)).toBeNull()
  expect(proofProblem(F('kind: result\nrun: make sim\nsha: pending'), 'req/R-1.md', r)).toBe("a result, but its sha: isn't the sha256 of the run's output (12 to 64 hex digits)")
  expect(proofProblem(F('kind: result\nrun: make sim'), 'req/R-1.md', r)).toBe('a result, with run: but no sha: after it (the sha256 of its output)')
  expect(proofProblem(F('kind: finding\nsource: https://example.invalid/paper\nquote: "the FIFO must hold 64 entries"'), 'findings/F-3.md', r)).toBeNull()
  expect(proofProblem(F('kind: finding\nsource: docs/spec.md\nquote: yes'), 'findings/F-3.md', r)).toBe('a finding, but its quote: is too short to prove anything (10 characters at least)')
  expect(proofProblem(F('kind: finding\nsource: docs/spec.md'), 'findings/F-3.md', r)).toBe('a finding, with source: but no quote: after it (the exact text it rests on)')
  // A second pair after a bad first one proves it; past 4 MiB (no text) it isn't looked at; no proofs, nothing
  expect(proofProblem(F('kind: finding\nsource: a\nquote: no\nsource: docs/spec.md\nquote: "the exact text it rests on"'), 'findings/F-3.md', r)).toBeNull()
  expect(proofProblem(null, 'findings/F-3.md', r)).toBeNull()
  expect(proofProblem(F('kind: result'), 'req/R-1.md', recs())).toBeNull()
  // Quotes come off only when the same one opens and closes the value
  expect(proofLines("---\nrun: printf 'x'\nquote: 'a: b'\n---\n")).toEqual([
    ['run', "printf 'x'"],
    ['quote', 'a: b'],
  ])
  expect(recordsOf({ worldFormat: 1, paths: [], proofs: { paths: ['/abs/**'] } }, false)).toEqual({ problem: 'world.json: proofs path "/abs/**" must be relative to the project folder' })
  expect(recordsOf({ worldFormat: 1, paths: [], proofs: { kinds: ['two words'] } }, false)).toEqual({ problem: "world.json: proofs kinds are words (finding, result), as a record's kind: line names them" })
  expect(recordsOf({ worldFormat: 1, paths: [], proofs: [] }, false)).toEqual({ problem: 'world.json: proofs is an object: { "paths": [globs], "kinds": ["finding", "result"] }' })
})

test("the checks' stamp covers the code watch's commands too; with none, it is as before", () => {
  const c = recs({ checks: [{ glob: 'board/**', argv: ['python3', 'checks/board.py'] }] })
  const scripts = new Map([['checks/board.py', 'h1']])
  expect(checksKey(c.checks, scripts, [])).toBe(checksKey(c.checks, scripts))
  expect(checksKey(c.checks, scripts, [['bash', 'tools/up.sh', '{marker}']])).not.toBe(checksKey(c.checks, scripts))
})

test("G27: pins are read from everything but the change line, and only an id's highest version counts", () => {
  const r = recs()
  const text = '---\nchange: "revision: R-1@2 to R-1@4, F-7@2 dropped"\nrelies_on: [R-1@4]\n---\nWas R-1@2, now R-1@4; see R-2@3\n'
  expect(pinsOf(text, r)).toEqual([
    { id: 'R-1', rev: 4 },
    { id: 'R-2', rev: 3 },
  ])
  // With no front matter, the change line among the first lines is left out too
  expect(pinsOf('change: editorial: was F-7@2\nCites F-7@3.\n', r)).toEqual([{ id: 'F-7', rev: 3 }])
})

test('G19 and 11a: a landing that only moves pin numbers or its change line is editorial; a path with defaultKind editorial needs no change line', () => {
  const r = recs({ defaultKind: { 'board/**': 'editorial' } })
  const v1 = '---\nchange: "revision: first"\n---\nRests on R-1@2 and R-2@3.\n'
  const repin = '---\nchange: "revision: re-pinned to R-1@4"\n---\nRests on R-1@4 and R-2@3.\n'
  const real = '---\nchange: "revision: the rate is lower"\n---\nRests on R-1@4 and R-2@3, at a lower rate.\n'
  expect(bodyHashOf(repin, r)).toBe(bodyHashOf(v1, r))
  expect(bodyHashOf(real, r)).not.toBe(bodyHashOf(v1, r))
  const prev = rev(3, 'revision', { changeHash: changeOf(v1, 'change')?.hash ?? null, bodyHash: bodyHashOf(v1, r) })
  expect(landingKind(changeOf(repin, 'change'), prev, false, { bodyHash: bodyHashOf(repin, r) })).toBe('editorial')
  expect(landingKind(changeOf(real, 'change'), prev, false, { bodyHash: bodyHashOf(real, r) })).toBe('revision')
  // A retraction stays one, whatever its body
  expect(landingKind({ kind: 'retraction', hash: 'hx' }, prev, false, { bodyHash: bodyHashOf(v1, r) })).toBe('retraction')
  expect(defaultKindOf('board/B-1.md', r)).toBe('editorial')
  expect(defaultKindOf('req/R-1.md', r)).toBe(null)
  expect(landingKind(null, prev, false, { defaultKind: defaultKindOf('board/B-1.md', r) })).toBe('editorial')
  expect(landingKind(null, prev, false, { defaultKind: defaultKindOf('req/R-1.md', r) })).toBe('revision')
  for (const [bad, why] of [
    [['board/**'], 'defaultKind is an object'],
    [{ 'board/**': 'addition' }, 'is "editorial" or "revision"'],
    [{ '/abs/**': 'editorial' }, 'defaultKind "/abs/**"'],
  ] as const) {
    const x = recordsOf({ worldFormat: 1, paths: ['board/**'], defaultKind: bad }, false)
    expect('problem' in x ? x.problem : '').toContain(why)
  }
})

test('B23: the suspects only behind moves group by the move; a real flag stands apart; files no session wrote are nobody to tell', () => {
  const stale = (path: string, owner: string | null, of = 'R-1', now = 4) => ({ path, id: null, owner: owner === null ? null : { ...R, name: owner }, reasons: [{ why: 'stale', pin: `${of}@2`, of, now, moved: { rev: now, kind: 'revision', at: AT, by: R, hash: 'h' } }] }) as unknown as Suspect
  const ahead = { path: 'notes/c.md', id: null, owner: R, reasons: [{ why: 'ahead', pin: 'R-1@99', of: 'R-1', now: 4 }] } as unknown as Suspect
  const list = [stale('notes/a.md', 'TEST A'), stale('notes/b.md', 'TEST B'), stale('notes/d.md', 'TEST A'), stale('notes/e.md', 'TEST A', 'R-2', 3), ahead]
  expect(movesOf(ahead)).toBe(null)
  expect(movesOf(list[0] as Suspect)).toEqual([{ move: 'R-1@4', at: AT }])
  const groups = behindGroups(list, s => s.owner?.name ?? '')
  expect(groups).toEqual([
    { move: 'R-1@4', at: AT, files: 3, owners: { 'TEST A': 2, 'TEST B': 1 }, nobody: [] },
    { move: 'R-2@3', at: AT, files: 1, owners: { 'TEST A': 1 }, nobody: [] },
  ])
  expect(behindLine(groups[0] as any, ME)).toBe('3 file(s) behind R-1@4 (14:02), owners told: TEST A 2, TEST B 1')
  // Written outside fleet: nobody is told, and the line says so (or names the janitor who is)
  const orphans = behindGroups([...list, stale('notes/f.md', null), stale('notes/g.md', null)], s => s.owner?.name ?? null)
  expect(orphans[0]).toMatchObject({ move: 'R-1@4', files: 5, nobody: ['notes/f.md', 'notes/g.md'] })
  expect(behindLine(orphans[0] as any, ME)).toBe('5 file(s) behind R-1@4 (14:02), owners told: TEST A 2, TEST B 1; nobody to tell: 2 (notes/f.md, notes/g.md)')
  expect(behindLine(orphans[0] as any, ME, 'Janitor')).toBe('5 file(s) behind R-1@4 (14:02), owners told: TEST A 2, TEST B 1; no writer to tell, so Janitor is told: 2 (notes/f.md, notes/g.md)')
  expect(behindLine(behindGroups([stale('notes/f.md', null)], () => null)[0] as any, ME)).toBe('1 file(s) behind R-1@4 (14:02), nobody to tell: 1 (notes/f.md)')
})

test("G19: an owner's files only behind one move are one digest line, with the way to confirm them", () => {
  const stale = (path: string, now = 4) => ({ path, id: null, owner: R, reasons: [{ why: 'stale', pin: 'R-1@2', of: 'R-1', now, moved: { rev: 4, kind: 'revision', at: AT, by: R, hash: 'h' } }] }) as unknown as Suspect
  const blind = { path: 'notes/z.md', id: null, owner: R, reasons: [{ why: 'blind', pin: 'R-2@1', of: 'R-2', detail: 'unread' }] } as unknown as Suspect
  const lines = ownSuspectLines([stale('notes/a.md'), stale('notes/b.md'), blind], ME)
  expect(lines).toEqual([
    { line: '- notes/z.md landed blind citing R-2@1, R-2 unread', keys: [suspectKey(blind)] },
    {
      line: '- 2 file(s) behind R-1@4 (a revision at 14:02 by TEST R): notes/a.md, notes/b.md. Read R-1, then re-pin them, or once checked say they still hold with mcp__fleet__confirm (of: R-1), with no new version',
      keys: [suspectKey(stale('notes/a.md')), suspectKey(stale('notes/b.md'))],
    },
  ])
  // One file alone keeps its own line
  expect(ownSuspectLines([stale('notes/a.md')], ME)[0]?.line).toBe('- notes/a.md cites R-1@2, and R-1 is at v4 (a revision at 14:02 by TEST R)')
  // An editorial version since the move isn't news: the same key
  expect(suspectKey(stale('notes/a.md', 5))).toBe(suspectKey(stale('notes/a.md', 4)))
})

test('G19: a confirmation clears the stale pins of its record in the files it names, while each file is at the version checked and until the record is revised again (an editorial version spends nothing)', () => {
  const c = parseConfirmation(JSON.stringify({ format: 1, at: AT, by: R, of: 'R-1', rev: 4, paths: ['notes/a.md', 7], versions: { 'notes/a.md': 'ha', 'notes/x.md': 3 } }))
  expect(c?.paths).toEqual(['notes/a.md'])
  expect(c?.versions).toEqual({ 'notes/a.md': 'ha' })
  expect(parseConfirmation('{"format":1}')).toBe(null)
  const confs = [c as NonNullable<typeof c>]
  expect(confirmedBy('notes/a.md', 'ha', ['R-1@2', 'R-2@3'], confs)).toEqual(['R-1@2>4'])
  // Edited since it was checked: its own check is needed
  expect(confirmedBy('notes/a.md', 'hb', ['R-1@2'], confs)).toEqual([])
  expect(confirmedBy('notes/b.md', 'ha', ['R-1@2'], confs)).toEqual([])
  const files = [{ path: 'notes/a.md', id: null, pins: ['R-1@2'], owner: R, confirmed: confirmedBy('notes/a.md', 'ha', ['R-1@2'], confs) }]
  const at = (...revs: Rev[]) => (p: { id: string; rev: number }) => pinState(p, revs)
  expect(suspectsOf(files, at(rev(2), rev(4)))).toEqual([])
  expect(suspectsOf(files, at(rev(2), rev(4), rev(5, 'editorial')))).toEqual([])
  expect(suspectsOf(files, at(rev(2), rev(4), rev(5, 'editorial'), rev(6))).map(s => s.path)).toEqual(['notes/a.md'])
  // A pin its writer kept after reading the record (the gate's confirmed) holds the same way
  const kept = [{ path: 'notes/k.md', id: null, pins: ['R-1@2'], owner: R, confirmed: ['R-1@2>4'] }]
  expect(keptAt(['R-1@2>4'], 'R-1@2', pinState({ id: 'R-1', rev: 2 }, [rev(2), rev(4), rev(5, 'editorial')]))).toBe(true)
  expect(suspectsOf(kept, at(rev(2), rev(4), rev(5, 'editorial')))).toEqual([])
  expect(suspectsOf(kept, at(rev(2), rev(4), rev(5)))).toHaveLength(1)
  expect(editorialText('B-1', 3, 'change')).toBe('fleet: this is B-1@3 (cite it so). An edit of it is editorial unless its change: line says "revision: …" (what it says changed): only then does fleet tell whoever cites it.')
})

test("B24, G20, quotes: a version's author corrected; an Edit's note for pins it left; the sources a record's proofs quote", () => {
  const blind = rev(4, 'revision', { via: 'bash', suspect: ['R-9@1:unread'] })
  const fixed = withFix(blind, { format: 1, at: AT, by: { ...R, name: 'TEST T' }, via: 'tool', confirmed: ['R-2@1>2'] })
  expect(fixed).toMatchObject({ rev: 4, via: 'tool', by: { name: 'TEST T' }, confirmed: ['R-2@1>2'] })
  expect(fixed.suspect).toBe(undefined)
  const p = { pin: { id: 'F-7', rev: 2 }, why: 'stale' as const, state: { pin: { id: 'F-7', rev: 2 }, state: 'stale' as const, now: 3, moved: rev(3) }, path: 'findings/F-7.md' }
  expect(elsewhereText('notes/plan.md', [p])).toBe('fleet: notes/plan.md still cites F-7@2 (F-7 is at v3), outside what you edited. It stays flagged to you until that\'s checked: read what it cites, then re-pin it, or say it holds with mcp__fleet__confirm.')
  expect(pinsText([p], ME, false)).toContain('A read is the Read tool or a plain cat of the file. Then write again.')
  expect(quoteSources('---\nkind: finding\nsource: notes/sheet.md:12\nquote: "x"\nsource: https://example.invalid/a\nquote: "y"\nsource: ./notes/b.md\n---\n')).toEqual(['notes/sheet.md:12', 'notes/sheet.md', 'notes/b.md'])
})
