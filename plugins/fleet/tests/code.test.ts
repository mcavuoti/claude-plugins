import { expect, test } from 'claude-code/testing'

import {
  GIT,
  P4,
  changedFiles,
  codeContext,
  codeDigest,
  codeLints,
  codeMark,
  codeOf,
  codeStatusLines,
  commandChanges,
  commitChanges,
  depotChanges,
  depotRel,
  fillWords,
  gitArgv,
  gitUnquote,
  hitsOf,
  keepChanges,
  mergeOverlaps,
  overlapKey,
  p4Argv,
  p4Changes,
  p4Files,
  p4Opened,
  parseGitLog,
  parseOpen,
  parseUpstream,
  parseWorktrees,
  parseZtag,
  shellWord,
  sshHost,
  takesPart,
  treeOwners,
  type Overlap,
  type Repo,
} from '../hooks/code'
import { instancesOf, markRow, type Roster } from '../hooks/roster'

// The code watch's pure logic: world.json's code, the commands git and p4 are run with (through ssh to a host), what
// they print (shaped as real git 2.50 and a p4 server print it), which instance works where, the overlaps and their
// words

const ME = { sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', offsetMin: 0 }
const AT = Date.UTC(2026, 10, 2, 14, 2, 0)
const P = '/Users/x/proj'
const SHA = '436d16c0d7b5a1f3e2c4b6a8d0e2f4a6b8c0d2e4'

function repo(spec: Record<string, unknown>, name = 'repo'): Repo {
  const c = codeOf({ worldFormat: 1, paths: [], code: { [name]: spec } })
  if (!c.repos[0]) throw new Error(c.problems.join('; '))
  return c.repos[0]
}

test("world.json's code: git, Perforce and command repositories, their defaults, the ones off and the ones it can't use", () => {
  expect(codeOf({ worldFormat: 1, paths: [] })).toEqual({ repos: [], off: [], problems: [] })
  expect(repo({ kind: 'git' })).toEqual({ name: 'repo', kind: 'git', path: '.', upstream: 'main', fetch: false, host: null, everyMin: 5 })
  expect(repo({ kind: 'git', path: 'code/', upstream: 'origin/main', fetch: true, everyMin: 0 })).toMatchObject({ path: 'code', upstream: 'origin/main', fetch: true, everyMin: 1 })
  expect(repo({ kind: 'p4', host: 'dev.example.invalid', depot: '//depot/project/...', port: 'ssl:p4.example.invalid:1666' })).toEqual({ name: 'repo', kind: 'p4', depot: '//depot/project/...', host: 'dev.example.invalid', port: 'ssl:p4.example.invalid:1666', user: null, everyMin: 5 })
  expect(repo({ kind: 'command', changed: ['bash', 'tools/up.sh', '{marker}'], open: ['bash', 'tools/open.sh', '{instance}'] })).toMatchObject({ kind: 'command', timeoutMs: 30000 })
  const c = codeOf({
    worldFormat: 1,
    paths: [],
    code: {
      depot: { off: true, kind: 'p4' },
      Bad: { kind: 'git' },
      dash: { kind: 'git', upstream: '--output=/tmp/x' },
      up: { kind: 'git', path: '../elsewhere' },
      abs: { kind: 'git', path: '/srv/repo' },
      remote: { kind: 'git', host: 'dev', path: 'relative' },
      nodepot: { kind: 'p4', depot: 'depot/project' },
      half: { kind: 'command', changed: ['x'] },
      what: { kind: 'svn' },
      host: { kind: 'p4', host: '-oProxyCommand=x', depot: '//depot/...' },
    },
  })
  expect(c.repos).toEqual([])
  expect(c.off).toEqual(['depot'])
  expect(c.problems).toEqual([
    'world.json: code Bad: a name is lowercase letters, digits and -, up to 32',
    'world.json: code dash: upstream "--output=/tmp/x" is a branch (main) or a remote\'s (origin/main)',
    'world.json: code up: path is a folder of the project, relative to it ("." for the project\'s own repository)',
    'world.json: code abs: path is a folder of the project, relative to it ("." for the project\'s own repository)',
    "world.json: code remote: path is the repository's absolute folder on its host",
    'world.json: code nodepot: depot is the depot path to watch, as //depot/project/...',
    'world.json: code half: changed and open are commands, lists of words: what changed upstream since {marker} (lines path<TAB>who<TAB>rev), and what {instance} has changed or open (lines path, or path<TAB>rev)',
    'world.json: code what: kind is "git", "p4" or "command"',
    'world.json: code host: host "-oProxyCommand=x" is an ssh host (a name, or user@name)',
  ])
  expect(codeOf({ worldFormat: 1, paths: [], code: [] }).problems[0]).toContain('code is an object')
})

test('the commands: read-only, and through ssh with each word quoted for the remote shell when the code is on a host', () => {
  const g = repo({ kind: 'git', upstream: 'origin/main', fetch: true }) as Extract<Repo, { kind: 'git' }>
  expect(gitArgv(g, P, GIT.head(g))).toEqual(['git', '-C', P, '-c', 'core.quotePath=false', 'rev-parse', '--verify', '--quiet', 'origin/main^{commit}'])
  expect(GIT.fetch(g)).toEqual(['fetch', '--quiet', 'origin'])
  expect(GIT.fetch({ ...g, upstream: 'main' })).toEqual(['fetch', '--quiet'])
  expect(GIT.lacking(SHA)).toEqual(['log', '--max-count=200', '--name-only', '--format=%x01%H%x09%ct%x09%an', `HEAD..${SHA}`])
  expect(GIT.changed(SHA)).toEqual(['diff', '--name-only', `${SHA}...HEAD`])
  const remote = repo({ kind: 'git', host: 'dev', path: '/srv/code' }) as Extract<Repo, { kind: 'git' }>
  expect(gitArgv(remote, '/srv/code', GIT.head(remote))).toEqual(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'dev', '--', "git -C /srv/code -c core.quotePath=false rev-parse --verify --quiet 'main^{commit}'"])
  const p = repo({ kind: 'p4', host: 'dev.example.invalid', depot: '//depot/project/...', user: 'me' }) as Extract<Repo, { kind: 'p4' }>
  // # would start a comment in the remote shell: the range goes quoted
  expect(p4Argv(p, null, P4.since(p, 1233))).toEqual(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'dev.example.invalid', '--', "p4 -u me -ztag changes -s submitted -m 300 '//depot/project/...@1234,#head'"])
  expect(p4Argv({ ...p, host: null }, 'project-area-a', P4.opened(p))).toEqual(['p4', '-u', 'me', '-c', 'project-area-a', '-ztag', 'opened', '//depot/project/...'])
  expect(P4.describe(['1234', '1235'])).toEqual(['describe', '-s', '1234', '1235'])
  expect(shellWord("it's")).toBe(`'it'\\''s'`)
  expect([sshHost('me@Dev.example.invalid'), sshHost('dev')]).toEqual(['dev.example.invalid', 'dev'])
  expect(fillWords(['tools/up.sh', '--since={marker}', '{instance}', '{slug}', '{client}', '{other}'], { marker: '41', instance: 'Area A', slug: 'area-a' })).toEqual(['tools/up.sh', '--since=41', 'Area A', 'area-a', '', '{other}'])
})

test('what git prints: the commits a branch lacks with their files, the worktrees, what a worktree changed', () => {
  const log = `\x01${SHA}\t1793628120\tTEST Integrator\n\nsrc/x.c\nsrc/y.c\n\x01aaaaaaa1111111111111111111111111111111111\t1793620000\tTEST Someone\n\n"src/a\\tb.c"\n"src/\\303\\251t\\303\\251.c"\n`
  expect(parseGitLog(log)).toEqual([
    { rev: SHA, at: 1793628120000, who: 'TEST Integrator', paths: ['src/x.c', 'src/y.c'] },
    { rev: 'aaaaaaa1111111111111111111111111111111111', at: 1793620000000, who: 'TEST Someone', paths: ['src/a\tb.c', 'src/été.c'] },
  ])
  expect(gitUnquote('plain/path')).toBe('plain/path')
  const trees = `worktree ${P}\nHEAD ${SHA}\nbranch refs/heads/main\n\nworktree ${P}/.claude/worktrees/area-a-1\nHEAD ${SHA}\nbranch refs/heads/area-a-1\n\nworktree ${P}/.claude/worktrees/detached\nHEAD ${SHA}\ndetached\n\n`
  expect(parseWorktrees(trees)).toEqual([
    { path: P, head: SHA, branch: 'main' },
    { path: `${P}/.claude/worktrees/area-a-1`, head: SHA, branch: 'area-a-1' },
    { path: `${P}/.claude/worktrees/detached`, head: SHA, branch: null },
  ])
  // A rename's source changed too; untracked files count
  expect(changedFiles('src/x.c\n', ' M src/y.c\0R  src/new.c\0src/old.c\0?? notes/n.md\0')).toEqual(['notes/n.md', 'src/new.c', 'src/old.c', 'src/x.c', 'src/y.c'])
})

test('what p4 -ztag prints: changes, the files of each, a client\'s open files; a description over two lines', () => {
  const changes = parseZtag('... change 1235\n... time 1793620800\n... user jdoe\n... client jdoe-ws\n... status submitted\n... desc a fix\nover two lines\n\n... change 1234\n... time 1793617200\n... user areab\n... client project-area-b\n... desc b\n\n')
  expect(p4Changes(changes)).toEqual([
    { change: 1234, user: 'areab', client: 'project-area-b', at: 1793617200000 },
    { change: 1235, user: 'jdoe', client: 'jdoe-ws', at: 1793620800000 },
  ])
  const described = parseZtag('... change 1235\n... user jdoe\n... depotFile0 //depot/project/src/x.c\n... action0 edit\n... rev0 7\n... depotFile1 //depot/project/src/new file.c\n... action1 add\n... rev1 1\n')
  expect([...p4Files(described)]).toEqual([[1235, [{ path: '//depot/project/src/x.c', rev: 7 }, { path: '//depot/project/src/new file.c', rev: 1 }]]])
  // Two records with no blank line between them still come apart
  const opened = parseZtag('... depotFile //depot/project/src/x.c\n... rev 6\n... action edit\n... depotFile //depot/project/src/n.c\n... rev none\n... action add\n')
  expect([...p4Opened(opened)]).toEqual([
    ['//depot/project/src/x.c', '6'],
    ['//depot/project/src/n.c', '0'],
  ])
  expect(depotRel('//depot/project/...', '//depot/project/src/x.c')).toBe('src/x.c')
  expect(depotRel('//depot/project/...', '//depot/other/x.c')).toBe('//depot/other/x.c')
})

test('a command repository: path<TAB>who<TAB>rev lines (one with no path only moves the marker), and the open list', () => {
  const lines = parseUpstream('src/x.c\tTEST B\t41\nsrc/y.c\tTEST B\t41\n\t\t42\nno-rev line\n')
  expect(lines).toEqual([
    { path: 'src/x.c', who: 'TEST B', rev: '41' },
    { path: 'src/y.c', who: 'TEST B', rev: '41' },
    { path: '', who: '', rev: '42' },
  ])
  expect(commandChanges(lines, AT)).toEqual([
    { rev: '41', who: 'TEST B', at: AT, files: [{ path: 'src/x.c' }, { path: 'src/y.c' }] },
    { rev: '42', who: '', at: AT, files: [] },
  ])
  expect([...parseOpen('src/x.c\nsrc/y.c\t41\n\n')]).toEqual([
    ['src/x.c', null],
    ['src/y.c', '41'],
  ])
})

test('the overlaps: what upstream changed that an instance changed or has open and hasn\'t caught up with; never its own', () => {
  const git = commitChanges([
    { rev: SHA, at: AT, who: 'TEST Integrator', paths: ['src/x.c', 'src/y.c'] },
    { rev: 'b'.repeat(40), at: AT - 1000, who: 'TEST Integrator', paths: ['src/x.c'] },
    { rev: 'c'.repeat(40), at: AT, who: 'Area A', paths: ['src/z.c'] },
  ])
  const ids = { name: 'Area A', slug: 'area-a', client: null }
  // The newest change of each file; a commit under its own name isn't news to it
  expect(hitsOf('git', git, { where: '.claude/worktrees/area-a-1', files: new Map([['src/x.c', null], ['src/z.c', null]]) }, ids)).toEqual([{ path: 'src/x.c', rev: SHA, who: 'TEST Integrator', at: AT, where: '.claude/worktrees/area-a-1' }])
  const depot = depotChanges(
    [
      { change: 1234, user: 'areab', client: 'project-area-b', at: AT - 1000 },
      { change: 1235, user: 'jdoe', client: 'jdoe-ws', at: AT },
      { change: 1236, user: 'me', client: 'project-area-a', at: AT },
    ],
    new Map([
      [1234, [{ path: '//d/src/z.c', rev: 4 }]],
      [1235, [{ path: '//d/src/x.c', rev: 7 }]],
      [1236, [{ path: '//d/src/y.c', rev: 2 }]],
    ]),
  )
  const opened = new Map<string, string | null>([
    ['//d/src/x.c', '6'],
    ['//d/src/z.c', '4'],
    ['//d/src/y.c', '1'],
  ])
  // x.c opened at #6 under #7: an overlap; z.c at #4 synced already; y.c its own client's change
  expect(hitsOf('p4', depot, { where: 'project-area-a', files: opened }, { name: 'Area A', slug: 'area-a', client: 'project-area-a' })).toEqual([{ path: '//d/src/x.c', rev: '1235', who: 'jdoe', client: 'jdoe-ws', at: AT, where: 'project-area-a' }])
  const cmd = commandChanges([{ path: 'src/x.c', who: 'TEST B', rev: '41' }, { path: 'src/y.c', who: 'TEST B', rev: 'f00' }, { path: 'src/z.c', who: 'area-a', rev: '43' }], AT)
  const open = new Map<string, string | null>([
    ['src/x.c', '41'],
    ['src/y.c', null],
    ['src/z.c', null],
  ])
  expect(hitsOf('command', cmd, { where: 'Area A', files: open }, ids).map(h => h.path)).toEqual(['src/y.c'])
  expect(hitsOf('command', cmd, { where: 'Area A', files: new Map([['src/x.c', '40']]) }, ids).map(h => h.path)).toEqual(['src/x.c'])
})

test('which instance works in each worktree: its roster entry, then its session\'s folder, then its default place', () => {
  const t = (p: string) => ({ path: `${P}/${p}`, head: SHA, branch: null })
  const trees = [{ path: P, head: SHA, branch: 'main' }, t('.claude/worktrees/area-a-1'), t('.claude/worktrees/area-a-2'), t('.claude/worktrees/area-a-2-3'), t('.claude/worktrees/elsewhere'), t('.claude/worktrees/agent-1234'), t('wt/review')]
  const seats = [
    { slug: 'area-a', name: 'Area A', trees: [], cwd: null },
    { slug: 'area-a-2', name: 'Area A 2', trees: [], cwd: null },
    { slug: 'reviewer', name: 'Reviewer', trees: ['wt/*'], cwd: null },
    { slug: 'integrator', name: 'Integrator', trees: [], cwd: `${P}/.claude/worktrees/agent-1234/src` },
    { slug: 'chief', name: 'Chief', trees: [], cwd: P },
  ]
  expect([...treeOwners(trees, seats, P, false, false)]).toEqual([
    [`${P}/.claude/worktrees/area-a-1`, 'area-a'],
    [`${P}/.claude/worktrees/area-a-2`, 'area-a-2'],
    [`${P}/.claude/worktrees/area-a-2-3`, 'area-a-2'],
    [`${P}/.claude/worktrees/agent-1234`, 'integrator'],
    [`${P}/wt/review`, 'reviewer'],
  ])
  // The main checkout only when an entry names it; a remote repository has no session folders
  expect([...treeOwners(trees, [{ slug: 'integrator', name: 'Integrator', trees: ['.'], cwd: null }], P, false, false)]).toEqual([[P, 'integrator']])
  expect([...treeOwners(trees, [{ slug: 'integrator', name: 'Integrator', trees: [], cwd: `${P}/.claude/worktrees/agent-1234` }], P, false, true)]).toEqual([])
})

test('a role\'s code seats and its instance\'s add up, {slug} filled; who takes part in which repository', () => {
  const r: Roster = {
    rosterFormat: 1,
    roles: { poc: { code: { depot: { client: 'project-{slug}' }, repo: { worktree: 'wt/{slug}-*' } } }, chief: {} },
    instances: [
      { name: 'PoC A', role: 'poc' },
      { name: 'PoC B', role: 'poc', code: { depot: { client: 'mine' }, cmd: {} } },
      { name: 'Chief', role: 'chief' },
    ],
  }
  const [a, b, chief] = instancesOf(r)
  expect(a?.code).toEqual({ depot: { worktrees: [], client: 'project-poc-a' }, repo: { worktrees: ['wt/poc-a-*'], client: null } })
  expect(b?.code).toEqual({ depot: { worktrees: [], client: 'mine' }, repo: { worktrees: ['wt/poc-b-*'], client: null }, cmd: { worktrees: [], client: null } })
  const depot = repo({ kind: 'p4', depot: '//depot/...' }, 'depot')
  const cmd = repo({ kind: 'command', changed: ['x'], open: ['y'] }, 'cmd')
  expect([a, b, chief].map(i => takesPart(depot, i as any))).toEqual([true, true, false])
  expect([a, b, chief].map(i => takesPart(cmd, i as any))).toEqual([false, true, false])
  expect(takesPart(repo({ kind: 'git' }), chief as any)).toBe(true)
  expect(codeContext(codeOf({ worldFormat: 1, paths: [], code: { depot: { kind: 'p4', depot: '//depot/...' } } }), chief as any)).toBeNull()
  expect(codeContext(codeOf({ worldFormat: 1, paths: [], code: { depot: { kind: 'p4', depot: '//depot/...' } } }), a as any)).toContain('//depot/... (Perforce, your client project-poc-a)')
})

const OV = (o: Partial<Overlap>): Overlap => ({ slug: 'area-a', name: 'Area A', repo: 'repo', kind: 'git', upstream: 'main', path: 'src/x.c', rev: SHA, who: 'TEST Integrator', at: AT, where: '.claude/worktrees/area-a-1', since: AT, ...o })

test("the overlaps kept after a poll: since when each one stood, an instance's not looked at kept, a repository dropped", () => {
  const had = [OV({}), OV({ path: 'src/y.c' }), OV({ slug: 'area-b', name: 'Area B' }), OV({ repo: 'depot', kind: 'p4' }), OV({ repo: 'gone' })]
  const fresh = [{ ...OV({}), since: undefined } as unknown as Omit<Overlap, 'since'>, { ...OV({ path: 'src/w.c' }), since: undefined } as unknown as Omit<Overlap, 'since'>]
  const out = mergeOverlaps(had, 'repo', fresh, new Set(['area-b']), new Set(['repo', 'depot']), AT + 60000)
  expect(out.map(o => `${o.slug} ${o.repo} ${o.path} ${o.since - AT}`)).toEqual(['area-a depot src/x.c 0', 'area-a repo src/w.c 60000', 'area-a repo src/x.c 0', 'area-b repo src/x.c 0'])
  expect(overlapKey(OV({}))).toBe(`repo|src/x.c|${SHA}`)
})

test('the words: what the instance hears (never a commit message), its row\'s mark, the brief, the status, the lints', () => {
  expect(codeDigest([OV({})], ME)).toEqual([`fleet: main moved: src/x.c changed by TEST Integrator in 436d16c at 14:02; you changed it too (in .claude/worktrees/area-a-1): rebase now (git -C .claude/worktrees/area-a-1 rebase main), then run the tests before you land. Nothing is held.`])
  expect(codeDigest([OV({}), OV({ path: 'src/y.c' })], ME)[0]).toBe(
    'fleet: main moved under files you changed (nothing is held; rebase now (git -C .claude/worktrees/area-a-1 rebase main), then run the tests before you land):\n- src/x.c: changed by TEST Integrator in 436d16c at 14:02\n- src/y.c: changed by TEST Integrator in 436d16c at 14:02',
  )
  const p4 = OV({ repo: 'depot', kind: 'p4', upstream: '//depot/project/...', rev: '1235', who: 'jdoe', where: 'project-area-a' })
  expect(codeDigest([p4], ME)).toEqual(['fleet: you have src/x.c open (client project-area-a); jdoe submitted it in change 1235 at 14:02: p4 sync and resolve now, then run the tests before you land. Nothing is held.'])
  const cmd = OV({ repo: 'tools', kind: 'command', upstream: 'tools', rev: '41', who: 'TEST B' })
  expect(codeDigest([cmd], ME)[0]).toContain('fleet: tools moved: src/x.c changed by TEST B in 41 at 14:02; you have it changed or open too')
  const m = codeMark([OV({}), OV({ path: 'src/y.c' }), OV({ path: 'src/y.c', rev: 'b'.repeat(40) })])
  expect(m).toEqual({ badge: '↻2', tint: 'warning', line: 'main moved under 2 of its files: rebase' })
  expect(markRow(m as any)).toEqual(m)
  expect(codeMark([p4])?.line).toBe('//depot/project/... moved under 1 of its file: sync')
  expect(codeMark([])).toBeNull()
  const c = codeOf({ worldFormat: 1, paths: [], code: { repo: { kind: 'git' }, depot: { kind: 'p4', host: 'dev', depot: '//depot/...' }, x: { off: true } } })
  const status = codeStatusLines(c, { format: 1, at: AT, by: 's', repos: { repo: { kind: 'git', marker: SHA, polledAt: AT, ok: true, seats: { 'area-a': '.claude/worktrees/area-a-1' } }, depot: { kind: 'p4', marker: null, polledAt: AT, ok: false, problem: 'ssh: no route', failures: 2 } }, overlaps: [OV({})] }, ME, AT, s => (s === 'area-a' ? 'Area A' : s))
  expect(status).toEqual([
    'code: repo (git, main in .), every 5 min: polled at 14:02, at 436d16c; watching Area A (.claude/worktrees/area-a-1)',
    'code: depot (Perforce, //depot/... on dev), every 5 min: polled at 14:02, no marker yet; watching nobody',
    '  its last poll failed (2 in a row): ssh: no route; tried again at 14:12 (fleet waits longer after each failure, up to 30 min)',
    'code: off in world.json ("off": true): x',
    'code overlaps (nothing is held; each instance hears its own once, and its row is marked ↻ until it rebases or syncs):',
    `  Area A: main moved under src/x.c (436d16c by TEST Integrator at 14:02), in .claude/worktrees/area-a-1, since 14:02`,
  ])
  const r: Roster = { rosterFormat: 1, roles: { owner: {} }, instances: [{ name: 'Area A', role: 'owner', code: { nope: {}, depot: { client: 'bad client' } } }] }
  const lints = codeLints(codeOf({ worldFormat: 1, paths: [], code: { depot: { kind: 'p4', host: 'dev', depot: '//depot/...' }, cmd: { kind: 'command', changed: ['a'], open: ['b'] } } }), instancesOf(r), h => h === 'other', false)
  expect(lints).toEqual([
    "world.json's code depot is on dev: fleet reaches a host over ssh only when outbound.json lists it as yours (\"hosts\"), so it isn't watched until then",
    'world.json\'s code depot: no instance names its client workspace (roster.json "code": { "depot": { "client": "…" } } on a role or an instance), so nobody is watched in it',
    'world.json\'s code cmd: no instance names it (roster.json "code": { "cmd": {} } on a role or an instance), so nobody is watched in it',
    "world.json's code cmd runs the project's own commands as you, so fleet runs them only once you stamp them: /fleet accept checks",
    `"Area A": roster.json's code names nope, which world.json's code doesn't have`,
    `"Area A": its client "bad client" for depot isn't a Perforce client name (letters, digits, . _ -)`,
  ])
})

test('the changes a depot keeps: a week of them at most, the newest last', () => {
  const c = (rev: string, at: number) => ({ rev, who: 'x', at, files: [] })
  const kept = keepChanges([c('1', AT - 8 * 86400000), c('2', AT - 1000)], [c('3', AT), c('2', AT - 500)], AT)
  expect(kept.map(x => `${x.rev}@${AT - x.at}`)).toEqual(['2@500', '3@0'])
})
