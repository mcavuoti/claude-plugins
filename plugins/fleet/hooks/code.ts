// Pure logic of the code watch (tested in tests/code.test.ts): world.json's code section (the repositories and depots
// fleet watches), the read-only commands its presets run for git and Perforce (through ssh when the code is on another
// machine) and what they print, which instance works where, the overlaps between what moved upstream and what an
// instance changed or has open, and their words: the digest's, the row's mark, /fleet status's, the brief's and the
// lints'. No `$` here.
//
// The world covers the shared documents; code has its own early warning. Each agent that changes code works isolated:
// git, its own worktree and branch (Claude Code's default for a background session in a repository); Perforce, its own
// client workspace and changelist, usually on a dev machine reached by ssh. The sweeper polls each repository's upstream
// every few minutes and, when upstream changed a file an instance changed or has open, that instance hears it at its
// next step ("main moved: src/x.c changed by … in …; you changed it too: rebase now") and its row is marked until it
// rebased or synced. It never blocks (the lightness rule): a merge conflict caught early is cheaper than one at landing.
// A third kind, command, takes two commands the project writes, for any other system.

import { clock, globRegex, type Me, type WorldConfig } from './changes'
import { cut } from './decisions'
import { porcelainPaths } from './records'
import type { Instance, RowMark } from './roster'

/** How often a repository is polled unless world.json says (minutes) */
export const DEFAULT_EVERY_MIN = 5
export const DEFAULT_UPSTREAM = 'main'
/** The upstream changes a Perforce or command repository keeps, to compare an instance's open files with: a week's, at
 * most this many */
export const KEEP_CHANGES = 300
export const KEEP_MS = 7 * 86400000
/** git log's reach: at most this many of the upstream commits an instance's branch lacks, newest first */
export const MAX_LACKING = 200
/** Changes described per p4 call */
export const DESCRIBE_BATCH = 50
/** The most files a digest line or a status line names; the rest are counted */
export const MAX_FILES = 10
/** Where an instance's git worktrees are unless its roster entry says: .claude/worktrees/<slug>, <slug>-<anything> */
export const DEFAULT_TREES = ['.claude/worktrees/{slug}', '.claude/worktrees/{slug}-*']

export type GitRepo = { name: string; kind: 'git'; path: string; upstream: string; fetch: boolean; host: string | null; everyMin: number }
export type P4Repo = { name: string; kind: 'p4'; depot: string; host: string | null; port: string | null; user: string | null; everyMin: number }
export type CommandRepo = { name: string; kind: 'command'; changed: string[]; open: string[]; everyMin: number; timeoutMs: number }
export type Repo = GitRepo | P4Repo | CommandRepo
/** off: the repositories world.json has with "off": true (a preset to fill in); problems: those it can't use, why */
export type CodeConfig = { repos: Repo[]; off: string[]; problems: string[] }

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
// What fleet puts on a command line it builds (and sends through ssh): no option where a value goes, no shell word
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/
const HOST = /^(?!-)[A-Za-z0-9._@-]{1,253}$/
const DEPOT = /^\/\/[^\s'"`$;|&<>()\\]{1,400}$/
const PORT = /^(?!-)[A-Za-z0-9._:/-]{1,200}$/
const USER = /^(?!-)[A-Za-z0-9._@-]{1,100}$/
const CLIENT = /^(?!-)[A-Za-z0-9._-]{1,200}$/

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function every(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1440, Math.max(1, v)) : DEFAULT_EVERY_MIN
}

function oneLine(s: string): string {
  return s.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim()
}

// ---- world.json's code ----

/** world.json's code: { "<name>": { "kind": "git" | "p4" | "command", … } }. A repository it can't use is left out
 * with why; the others are watched */
export function codeOf(w: WorldConfig | null): CodeConfig {
  const out: CodeConfig = { repos: [], off: [], problems: [] }
  const raw = w?.code
  if (raw === undefined || raw === null) return out
  if (!isObject(raw)) {
    out.problems.push('world.json: code is an object, a repository\'s name → { "kind": "git" | "p4" | "command", … }')
    return out
  }
  for (const [name, spec] of Object.entries(raw)) {
    const where = `world.json: code ${name}`
    if (!NAME.test(name)) out.problems.push(`${where}: a name is lowercase letters, digits and -, up to 32`)
    else if (!isObject(spec)) out.problems.push(`${where} isn't an object`)
    else if (spec.off === true) out.off.push(name)
    else {
      const r = repoOf(name, spec)
      if ('problem' in r) out.problems.push(`${where}: ${r.problem}`)
      else out.repos.push(r.repo)
    }
  }
  return out
}

function repoOf(name: string, s: Record<string, unknown>): { repo: Repo } | { problem: string } {
  const host = typeof s.host === 'string' && s.host.trim() ? s.host.trim() : null
  if (host !== null && !HOST.test(host)) return { problem: `host "${host}" is an ssh host (a name, or user@name)` }
  if (s.kind === 'git') {
    const path = typeof s.path === 'string' && s.path.trim() ? s.path.trim().replace(/\/+$/, '') || '/' : '.'
    if (host ? !path.startsWith('/') : path.startsWith('/') || path.split('/').some(x => x === '..')) {
      return { problem: host ? 'path is the repository\'s absolute folder on its host' : 'path is a folder of the project, relative to it ("." for the project\'s own repository)' }
    }
    if (/['"`$;|&<>()\\\n]/.test(path)) return { problem: `path "${path}" has a character fleet doesn't put on a command line` }
    const upstream = typeof s.upstream === 'string' && s.upstream.trim() ? s.upstream.trim() : DEFAULT_UPSTREAM
    if (!REF.test(upstream) || upstream.endsWith('/') || upstream.endsWith('.lock')) return { problem: `upstream "${upstream}" is a branch (main) or a remote's (origin/main)` }
    return { repo: { name, kind: 'git', path, upstream, fetch: s.fetch === true, host, everyMin: every(s.everyMin) } }
  }
  if (s.kind === 'p4') {
    const depot = typeof s.depot === 'string' ? s.depot.trim() : ''
    if (!DEPOT.test(depot)) return { problem: 'depot is the depot path to watch, as //depot/project/...' }
    const port = typeof s.port === 'string' && s.port.trim() ? s.port.trim() : null
    const user = typeof s.user === 'string' && s.user.trim() ? s.user.trim() : null
    if (port !== null && !PORT.test(port)) return { problem: `port "${port}" isn't a P4PORT (host:1666, ssl:host:1666)` }
    if (user !== null && !USER.test(user)) return { problem: `user "${user}" isn't a Perforce user name` }
    return { repo: { name, kind: 'p4', depot, host, port, user, everyMin: every(s.everyMin) } }
  }
  if (s.kind === 'command') {
    const words = (v: unknown) => (Array.isArray(v) && v.length && v.every(x => typeof x === 'string' && x) ? (v as string[]) : null)
    const changed = words(s.changed)
    const open = words(s.open)
    if (!changed || !open) return { problem: 'changed and open are commands, lists of words: what changed upstream since {marker} (lines path<TAB>who<TAB>rev), and what {instance} has changed or open (lines path, or path<TAB>rev)' }
    const t = typeof s.timeoutMs === 'number' && Number.isFinite(s.timeoutMs) ? Math.min(120000, Math.max(1000, s.timeoutMs)) : 30000
    return { repo: { name, kind: 'command', changed, open, everyMin: every(s.everyMin), timeoutMs: t } }
  }
  return { problem: 'kind is "git", "p4" or "command"' }
}

/** The commands of the project a command repository runs as the person: stamped with the checks (/fleet accept
 * checks), and the scripts they name are command-level, as a check's are */
export function codeCommands(c: CodeConfig): string[][] {
  return c.repos.flatMap(r => (r.kind === 'command' ? [r.changed, r.open] : []))
}

/** Whether an instance takes part in a repository's watch: in git, any (its worktrees are found); in Perforce, one
 * whose roster entry names its client; in a command repository, one whose entry names the repository */
export function takesPart(repo: Repo, inst: Pick<Instance, 'code'>): boolean {
  if (repo.kind === 'git') return true
  const seat = inst.code[repo.name]
  return repo.kind === 'p4' ? !!seat?.client && CLIENT.test(seat.client) : !!seat
}

/** Where a repository's code is, in words */
export function repoWords(r: Repo): string {
  if (r.kind === 'git') return `git, ${r.upstream} in ${r.path}${r.host ? ` on ${r.host}` : ''}${r.fetch ? ', fetched first' : ''}`
  if (r.kind === 'p4') return `Perforce, ${r.depot}${r.host ? ` on ${r.host}` : ''}`
  return `the project's commands: ${r.changed.join(' ')}; ${r.open.join(' ')}`
}

// ---- The commands: read-only, through ssh when the code is on another machine ----

/** A word for a remote shell: as it is when it can't mean anything to sh, else in single quotes */
export function shellWord(w: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`
}

/** The command as run: here, or on the host through ssh (never a prompt: BatchMode; a bounded connect) */
export function viaHost(host: string | null, argv: readonly string[]): string[] {
  return host ? ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, '--', argv.map(shellWord).join(' ')] : [...argv]
}

/** The host an ssh target reaches, as outbound.json's hosts name it: me@dev is dev */
export function sshHost(target: string): string {
  return target.replace(/^[^@]*@/, '').toLowerCase()
}

/** git in a folder, paths printed as they are (not octal-quoted) */
export function gitArgv(r: GitRepo, dir: string, args: readonly string[]): string[] {
  return viaHost(r.host, ['git', '-C', dir, '-c', 'core.quotePath=false', ...args])
}

/** The remote a fetch reaches: upstream's first part when it names a remote's branch (origin/main), none for a local
 * branch (then git fetches its default) */
export function remoteOf(upstream: string): string | null {
  const i = upstream.indexOf('/')
  return i > 0 ? upstream.slice(0, i) : null
}

export const GIT = {
  fetch: (r: GitRepo) => ['fetch', '--quiet', ...(remoteOf(r.upstream) ? [remoteOf(r.upstream) as string] : [])],
  head: (r: GitRepo) => ['rev-parse', '--verify', '--quiet', `${r.upstream}^{commit}`],
  trees: ['worktree', 'list', '--porcelain'],
  /** The upstream commits a worktree's branch lacks, with the files each touched */
  lacking: (head: string) => ['log', `--max-count=${MAX_LACKING}`, '--name-only', '--format=%x01%H%x09%ct%x09%an', `HEAD..${head}`],
  /** What its branch changed since it left upstream */
  changed: (head: string) => ['diff', '--name-only', `${head}...HEAD`],
  /** What it changed and hasn't committed */
  status: ['status', '--porcelain=v1', '-z'],
}

/** p4 for a depot, as the host's own login has it unless world.json gives a port or a user; tagged output */
export function p4Argv(r: P4Repo, client: string | null, args: readonly string[]): string[] {
  return viaHost(r.host, ['p4', ...(r.port ? ['-p', r.port] : []), ...(r.user ? ['-u', r.user] : []), ...(client ? ['-c', client] : []), '-ztag', ...args])
}

export const P4 = {
  latest: (r: P4Repo) => ['changes', '-s', 'submitted', '-m', '1', r.depot],
  since: (r: P4Repo, marker: number) => ['changes', '-s', 'submitted', '-m', String(KEEP_CHANGES), `${r.depot}@${marker + 1},#head`],
  describe: (changes: readonly string[]) => ['describe', '-s', ...changes],
  opened: (r: P4Repo) => ['opened', r.depot],
}

/** A command repository's command with its placeholders filled ({marker}, {instance}, {slug}, {client}; '' when not
 * known) */
export function fillWords(argv: readonly string[], vars: Readonly<Record<string, string>>): string[] {
  return argv.map(w => w.replace(/\{(marker|instance|slug|client)\}/g, (_m, k: string) => vars[k] ?? ''))
}

/** A client name fleet puts on a p4 command line, or null */
export function clientOf(seat: { client: string | null } | undefined): string | null {
  return seat?.client && CLIENT.test(seat.client) ? seat.client : null
}

// ---- What they print ----

/** A path git printed in C quotes ("a\tb") as it is */
export function gitUnquote(p: string): string {
  if (!(p.length > 1 && p.startsWith('"') && p.endsWith('"'))) return p
  const bytes: number[] = []
  const s = p.slice(1, -1)
  const enc = new TextEncoder()
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string
    if (c !== '\\') {
      bytes.push(...enc.encode(c))
      continue
    }
    const n = s[++i] ?? ''
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8))
      i += 2
    } else bytes.push(({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

export type Commit = { rev: string; at: number; who: string; paths: string[] }

/** git log --name-only --format=%x01%H%x09%ct%x09%an: each commit, newest first, and the files it touched */
export function parseGitLog(stdout: string): Commit[] {
  const out: Commit[] = []
  for (const chunk of stdout.split('\x01').slice(1)) {
    const lines = chunk.split('\n')
    const [rev = '', ct = '', who = ''] = (lines[0] ?? '').split('\t')
    if (!/^[0-9a-f]{7,64}$/.test(rev)) continue
    out.push({ rev, at: (Number(ct) || 0) * 1000, who: cut(oneLine(who), 60), paths: lines.slice(1).filter(l => l.trim()).map(gitUnquote) })
  }
  return out
}

export type Tree = { path: string; head: string | null; branch: string | null }

/** git worktree list --porcelain: every working tree, the main checkout first */
export function parseWorktrees(stdout: string): Tree[] {
  const out: Tree[] = []
  let t: Tree | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      t = { path: line.slice('worktree '.length).replace(/\/+$/, ''), head: null, branch: null }
      out.push(t)
    } else if (t && line.startsWith('HEAD ')) t.head = line.slice(5).trim()
    else if (t && line.startsWith('branch ')) t.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
  }
  return out
}

/** git diff --name-only: one path a line */
export function parseNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter(l => l.trim())
    .map(gitUnquote)
}

/** What a worktree changed: its branch's files since it left upstream, and what it hasn't committed */
export function changedFiles(diff: string, status: string): string[] {
  return [...new Set([...parseNames(diff), ...porcelainPaths(status).map(p => p.path)])].sort()
}

/** p4 -ztag: one record per blank-line-separated block, "... key value" a line (a value's continuation lines dropped) */
export function parseZtag(stdout: string): Record<string, string>[] {
  const out: Record<string, string>[] = []
  let r: Record<string, string> | null = null
  for (const line of stdout.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^\.\.\. (\S+)(?: (.*))?$/.exec(line)
    if (m) {
      const k = m[1] as string
      // A second "change" (or depotFile with no index) starts a record of its own when no blank line came between
      if (r && k in r && (k === 'change' || k === 'depotFile')) {
        out.push(r)
        r = null
      }
      const rec: Record<string, string> = r ?? {}
      rec[k] = m[2] ?? ''
      r = rec
    } else if (!line.trim() && r) {
      out.push(r)
      r = null
    }
  }
  if (r) out.push(r)
  return out
}

/** p4 changes -ztag: each change's number, who submitted it from which client, when */
export function p4Changes(records: readonly Record<string, string>[]): { change: number; user: string; client: string; at: number }[] {
  return records
    .filter(r => /^\d+$/.test(r.change ?? ''))
    .map(r => ({ change: Number(r.change), user: cut(oneLine(r.user ?? ''), 60), client: cut(oneLine(r.client ?? ''), 100), at: (Number(r.time) || 0) * 1000 }))
    .sort((a, b) => a.change - b.change)
}

/** p4 describe -s -ztag: each change's files and the revision each came to */
export function p4Files(records: readonly Record<string, string>[]): Map<number, { path: string; rev: number }[]> {
  const out = new Map<number, { path: string; rev: number }[]>()
  for (const r of records) {
    if (!/^\d+$/.test(r.change ?? '')) continue
    const files: { path: string; rev: number }[] = []
    for (let i = 0; r[`depotFile${i}`] !== undefined; i++) files.push({ path: r[`depotFile${i}`] as string, rev: Number(r[`rev${i}`]) || 0 })
    out.set(Number(r.change), files)
  }
  return out
}

/** p4 opened -ztag: the files a client has open, and the revision it opened each at (an add has none: 0) */
export function p4Opened(records: readonly Record<string, string>[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of records) if (r.depotFile) out.set(r.depotFile, String(Number(r.rev) || 0))
  return out
}

/** A depot path as the person reads it: below the depot path watched (//depot/project/src/x.c → src/x.c) */
export function depotRel(depot: string, path: string): string {
  const base = depot.replace(/\.\.\.$/, '').replace(/\*.*$/, '')
  return base && path.startsWith(base) && path.length > base.length ? path.slice(base.length) : path
}

/** A command repository's "changed": path<TAB>who<TAB>rev, oldest first (a line with no path only moves the marker) */
export function parseUpstream(stdout: string): { path: string; who: string; rev: string }[] {
  const out: { path: string; who: string; rev: string }[] = []
  for (const line of stdout.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) continue
    const [path = '', who = '', rev = ''] = line.split('\t')
    if (!rev.trim()) continue
    out.push({ path: path.trim(), who: cut(oneLine(who), 60), rev: cut(oneLine(rev), 80) })
  }
  return out
}

/** A command repository's "open": path, or path<TAB>the upstream revision its copy is at */
export function parseOpen(stdout: string): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const line of stdout.replace(/\r\n/g, '\n').split('\n')) {
    const [path = '', rev = ''] = line.split('\t')
    if (path.trim()) out.set(path.trim(), rev.trim() ? cut(oneLine(rev), 80) : null)
  }
  return out
}

// ---- Upstream's changes, and an instance's work ----

/** One change upstream: its revision (a commit, a change number), who made it from which client, when, and the files it
 * touched (with the revision each came to, when the system numbers them: Perforce) */
export type UpChange = { rev: string; who: string; client?: string; at: number; files: { path: string; rev?: number }[] }

/** The changes kept: the new ones over the old, a week's at most and KEEP_CHANGES, newest last */
export function keepChanges(had: readonly UpChange[], fresh: readonly UpChange[], now: number): UpChange[] {
  const by = new Map<string, UpChange>()
  for (const c of [...had, ...fresh]) by.set(c.rev, c)
  return [...by.values()]
    .filter(c => !c.at || now - c.at < KEEP_MS)
    .sort((a, b) => a.at - b.at || a.rev.localeCompare(b.rev, undefined, { numeric: true }))
    .slice(-KEEP_CHANGES)
}

/** A command repository's lines as changes: one per revision, seen now */
export function commandChanges(lines: readonly { path: string; who: string; rev: string }[], now: number): UpChange[] {
  const by = new Map<string, UpChange>()
  for (const l of lines) {
    const c = by.get(l.rev) ?? { rev: l.rev, who: l.who, at: now, files: [] }
    if (l.path && !c.files.some(f => f.path === l.path)) c.files.push({ path: l.path })
    by.set(l.rev, c)
  }
  return [...by.values()]
}

/** What an instance works on in one repository: where (its worktree, its client), and the files it changed or has open,
 * with the revision its copy of each is at when the system says (Perforce: the one it opened; a command's second
 * column) */
export type Work = { where: string; files: ReadonlyMap<string, string | null> }
/** Who an instance is, to tell its own upstream changes: its name, its file name, its client */
export type Ids = { name: string; slug: string; client: string | null }
export type Hit = { path: string; rev: string; who: string; client?: string; at: number; where: string }

function isOwn(c: UpChange, ids: Ids): boolean {
  const who = c.who.trim().toLowerCase()
  if (who && (who === ids.name.toLowerCase() || who === ids.slug)) return true
  return !!c.client && !!ids.client && c.client.toLowerCase() === ids.client.toLowerCase()
}

/** Whether an instance's copy of a file has an upstream change already: git's changes given are those its branch lacks
 * (never); Perforce, when the revision it opened is the change's or later; a command's, when its second column says so
 * (the same revision, or a later number) */
function caughtUp(kind: Repo['kind'], mine: string | null, c: UpChange, fileRev: number | undefined): boolean {
  if (kind === 'git' || mine === null) return false
  if (kind === 'p4') return Number(mine) >= (fileRev ?? Infinity)
  return /^\d+$/.test(mine) && /^\d+$/.test(c.rev) ? Number(mine) >= Number(c.rev) : mine === c.rev
}

/** The files upstream changed that an instance changed or has open too and hasn't caught up with: the newest change of
 * each. Never its own change (by its name, its file name or its client) */
export function hitsOf(kind: Repo['kind'], changes: readonly UpChange[], work: Work, ids: Ids): Hit[] {
  const best = new Map<string, Hit>()
  for (const c of changes) {
    if (isOwn(c, ids)) continue
    for (const f of c.files) {
      if (!work.files.has(f.path) || caughtUp(kind, work.files.get(f.path) ?? null, c, f.rev)) continue
      const had = best.get(f.path)
      if (!had || c.at > had.at || (c.at === had.at && Number(c.rev) > Number(had.rev))) best.set(f.path, { path: f.path, rev: c.rev, who: c.who, ...(c.client ? { client: c.client } : {}), at: c.at, where: work.where })
    }
  }
  return [...best.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** A git worktree's lacking commits as changes */
export function commitChanges(commits: readonly Commit[]): UpChange[] {
  return commits.map(c => ({ rev: c.rev, who: c.who, at: c.at, files: c.paths.map(path => ({ path })) }))
}

/** A Perforce poll's changes, from p4 changes and p4 describe */
export function depotChanges(changes: ReturnType<typeof p4Changes>, files: ReadonlyMap<number, { path: string; rev: number }[]>): UpChange[] {
  return changes.map(c => ({ rev: String(c.change), who: c.user, client: c.client, at: c.at, files: files.get(c.change) ?? [] }))
}

// ---- Which instance works in which git worktree ----

/** An instance's place in a git repository: the worktrees its roster entry names (paths or globs, filled), and the
 * folder its session runs in (its heartbeat's), when known */
export type Seat = { slug: string; name: string; trees: readonly string[]; cwd: string | null }

/** Which instance works in each linked worktree (by its folder): one its roster entry names, else the one whose session
 * runs in it, else the one whose default place it is (.claude/worktrees/<slug>, then the longest slug of
 * <slug>-<anything>). The main checkout only when an entry names it. base: where relative globs start (the project's
 * folder; the repository's on its host) */
export function treeOwners(trees: readonly Tree[], seats: readonly Seat[], base: string, insensitive: boolean, remote: boolean): Map<string, string> {
  const out = new Map<string, string>()
  const abs = (g: string) => {
    const rel = g.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    return g.startsWith('/') ? g : rel === '.' || !rel ? base.replace(/\/+$/, '') : `${base.replace(/\/+$/, '')}/${rel}`
  }
  const match = (g: string, path: string) => globRegex(abs(g).replace(/\/+$/, ''), insensitive).test(path)
  const fold = (s: string) => (insensitive ? s.toLowerCase() : s)
  for (const [i, t] of trees.entries()) {
    const own = seats.find(s => s.trees.some(g => match(g, t.path)))
    if (own) {
      out.set(t.path, own.slug)
      continue
    }
    if (i === 0) continue
    const inIt = remote ? undefined : seats.find(s => s.cwd && (fold(s.cwd) === fold(t.path) || fold(s.cwd).startsWith(`${fold(t.path)}/`)))
    if (inIt) {
      out.set(t.path, inIt.slug)
      continue
    }
    const exact = seats.find(s => !s.trees.length && match((DEFAULT_TREES[0] as string).replace('{slug}', s.slug), t.path))
    const prefix = seats.filter(s => !s.trees.length && match((DEFAULT_TREES[1] as string).replace('{slug}', s.slug), t.path)).sort((a, b) => b.slug.length - a.slug.length)[0]
    const d = exact ?? prefix
    if (d) out.set(t.path, d.slug)
  }
  return out
}

// ---- The overlaps, kept by the sweeper in <project>/.claude/fleet/state/code.json ----

export type Overlap = Hit & { slug: string; name: string; repo: string; kind: Repo['kind']; upstream: string; since: number }
/** One repository as the sweeper last polled it: its marker (git: upstream's commit; Perforce: the last change seen; a
 * command's: the last revision it printed), the changes kept (Perforce, command), which instances it watched and where,
 * and what went wrong */
export type RepoState = { kind: Repo['kind']; marker: string | null; polledAt: number; ok: boolean; problem?: string; failures?: number; changes?: UpChange[]; seats?: Record<string, string> }
/** state/code.json, written by the sweeper (the last write wins) */
export type CodeState = { format: number; at: number; by: string; repos: Record<string, RepoState>; overlaps: Overlap[] }

export function parseCodeState(text: string | null, format: number): CodeState | null {
  if (text === null) return null
  try {
    const v = JSON.parse(text)
    return v && v.format === format && isObject(v.repos) && Array.isArray(v.overlaps) ? (v as CodeState) : null
  } catch {
    return null
  }
}

/** What the instance hears once: one key per file and change */
export function overlapKey(o: Pick<Overlap, 'repo' | 'path' | 'rev'>): string {
  return `${o.repo}|${o.path}|${o.rev}`
}

/** One repository's overlaps after a poll: the fresh ones (keeping since when each one stood), the old ones of the
 * instances it couldn't look at this time (kept: nothing says they're resolved), and the other repositories' as they
 * were. Repositories no longer watched lose theirs */
export function mergeOverlaps(had: readonly Overlap[], repo: string, fresh: readonly Omit<Overlap, 'since'>[], unseen: ReadonlySet<string>, watched: ReadonlySet<string>, now: number): Overlap[] {
  const since = new Map(had.filter(o => o.repo === repo).map(o => [`${o.slug}|${overlapKey(o)}`, o.since]))
  const by = new Map<string, Overlap>()
  for (const o of had) if (watched.has(o.repo) && (o.repo !== repo || unseen.has(o.slug))) by.set(`${o.slug}|${overlapKey(o)}`, o)
  for (const o of fresh) by.set(`${o.slug}|${overlapKey(o)}`, { ...o, since: since.get(`${o.slug}|${overlapKey(o)}`) ?? now })
  return [...by.values()].sort((a, b) => a.slug.localeCompare(b.slug) || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path))
}

// ---- Words ----

/** What moved, as the instance reads it: git's upstream branch, the depot path, a command repository's name */
export function upstreamName(o: Pick<Overlap, 'kind' | 'upstream' | 'repo'>): string {
  return o.kind === 'command' ? o.repo : o.upstream
}

function revText(o: Pick<Overlap, 'kind' | 'rev'>): string {
  return o.kind === 'git' ? o.rev.slice(0, 7) : o.kind === 'p4' ? `change ${o.rev}` : o.rev
}

function at(o: Pick<Overlap, 'at'>, me: Me): string {
  return o.at ? ` at ${clock(o.at, me.offsetMin)}` : ''
}

const LAND = 'then run the tests before you land'

/** The digest's lines for one instance's overlaps not told yet, a paragraph per repository. Never a commit's message
 * or a file's content: paths, who, which revision, when */
export function codeDigest(overlaps: readonly Overlap[], me: Me): string[] {
  const out: string[] = []
  for (const repo of [...new Set(overlaps.map(o => o.repo))].sort()) {
    const mine = overlaps.filter(o => o.repo === repo)
    const first = mine[0] as Overlap
    const up = upstreamName(first)
    const shown = mine.slice(0, MAX_FILES)
    const more = mine.length > shown.length ? [`- and ${mine.length - shown.length} more: ${mine.slice(MAX_FILES).map(o => o.path).join(', ')}`] : []
    if (first.kind === 'git') {
      const how = `rebase now (git -C ${first.where} rebase ${up})`
      if (mine.length === 1) out.push(`fleet: ${up} moved: ${first.path} changed by ${first.who || 'someone'} in ${revText(first)}${at(first, me)}; you changed it too (in ${first.where}): ${how}, ${LAND}. Nothing is held.`)
      else out.push([`fleet: ${up} moved under files you changed (nothing is held; ${how}, ${LAND}):`, ...shown.map(o => `- ${o.path}: changed by ${o.who || 'someone'} in ${revText(o)}${at(o, me)}${o.where !== first.where ? ` (yours in ${o.where})` : ''}`), ...more].join('\n'))
    } else if (first.kind === 'p4') {
      if (mine.length === 1) out.push(`fleet: you have ${first.path} open (client ${first.where}); ${first.who || 'someone'} submitted it in ${revText(first)}${at(first, me)}: p4 sync and resolve now, ${LAND}. Nothing is held.`)
      else out.push([`fleet: others submitted files you have open in ${up} (nothing is held; p4 sync and resolve now, ${LAND}):`, ...shown.map(o => `- ${o.path}: ${o.who || 'someone'} submitted it in ${revText(o)}${at(o, me)} (client ${o.where})`), ...more].join('\n'))
    } else if (mine.length === 1) out.push(`fleet: ${up} moved: ${first.path} changed by ${first.who || 'someone'} in ${revText(first)}${at(first, me)}; you have it changed or open too: bring your copy up to date now (rebase or sync), ${LAND}. Nothing is held.`)
    else out.push([`fleet: ${up} moved under files you have changed or open (nothing is held; bring your copy up to date now, ${LAND}):`, ...shown.map(o => `- ${o.path}: changed by ${o.who || 'someone'} in ${revText(o)}${at(o, me)}`), ...more].join('\n'))
  }
  return out
}

/** An instance's row while overlaps stand: ↻n, the files; it doesn't need the person (the instance rebases) */
export function codeMark(overlaps: readonly Overlap[]): RowMark | null {
  const n = new Set(overlaps.map(o => `${o.repo}|${o.path}`)).size
  if (!n) return null
  const ups = [...new Set(overlaps.map(upstreamName))]
  const sync = overlaps.every(o => o.kind === 'p4') ? 'sync' : overlaps.every(o => o.kind === 'git') ? 'rebase' : 'rebase or sync'
  return { badge: `↻${Math.min(99, n)}`, tint: 'warning', line: `${ups.length === 1 ? ups[0] : 'upstream'} moved under ${n} of its file${n === 1 ? '' : 's'}: ${sync}` }
}

function filesOf(list: readonly Overlap[]): string {
  const paths = [...new Set(list.map(o => o.path))]
  return `${paths.slice(0, 4).join(', ')}${paths.length > 4 ? ` and ${paths.length - 4} more` : ''}`
}

/** The brief's lines (under what's blocked or stale): per instance and repository, what moved under it */
export function codeBriefLines(overlaps: readonly Overlap[], me: Me): string[] {
  const out: string[] = []
  const groups = new Map<string, Overlap[]>()
  for (const o of overlaps) groups.set(`${o.name}\u0000${o.repo}`, [...(groups.get(`${o.name}\u0000${o.repo}`) ?? []), o])
  for (const list of groups.values()) {
    const o = list.reduce((a, b) => (b.at > a.at ? b : a))
    out.push(`${o.name}: ${upstreamName(o)} moved under ${filesOf(list)} (${revText(o)} by ${o.who || 'someone'}${at(o, me)}), since ${clock(Math.min(...list.map(x => x.since)), me.offsetMin)}: it hears it at its next step (${o.kind === 'p4' ? 'p4 sync and resolve' : o.kind === 'git' ? 'rebase' : 'bring its copy up to date'})`)
  }
  return out
}

/** /fleet status's lines: each repository, its last poll and what it watches; the overlaps standing */
export function codeStatusLines(c: CodeConfig, st: CodeState | null, me: Me, now: number, names: (slug: string) => string): string[] {
  const out: string[] = []
  for (const r of c.repos) {
    const s = st?.repos[r.name]
    const marker = s?.marker ? (r.kind === 'git' ? `at ${s.marker.slice(0, 7)}` : r.kind === 'p4' ? `at change ${s.marker}` : `at ${s.marker}`) : 'no marker yet'
    const seats = Object.entries(s?.seats ?? {})
    const when = s ? `polled at ${clock(s.polledAt, me.offsetMin)}, ${marker}` : 'not polled yet (the sweeper polls it)'
    out.push(`code: ${r.name} (${repoWords(r)}), every ${r.everyMin} min: ${when}${seats.length ? `; watching ${seats.slice(0, 8).map(([slug, where]) => `${names(slug)} (${where})`).join(', ')}${seats.length > 8 ? ` and ${seats.length - 8} more` : ''}` : s ? '; watching nobody' : ''}`)
    if (s && !s.ok && s.problem) out.push(`  its last poll failed${s.failures && s.failures > 1 ? ` (${s.failures} in a row)` : ''}: ${s.problem}; tried again at ${clock(s.polledAt + r.everyMin * 60000, me.offsetMin)}`)
    else if (s?.problem) out.push(`  ${s.problem}`)
  }
  if (c.off.length) out.push(`code: off in world.json ("off": true): ${c.off.join(', ')}`)
  for (const p of c.problems) out.push(`code: ${p}`)
  const list = (st?.overlaps ?? []).filter(o => c.repos.some(r => r.name === o.repo))
  if (c.repos.length) out.push(list.length ? 'code overlaps (nothing is held; each instance hears its own once, and its row is marked ↻ until it rebases or syncs):' : 'code overlaps: none')
  for (const o of list.slice(0, 20)) out.push(`  ${o.name}: ${upstreamName(o)} moved under ${o.path} (${revText(o)} by ${o.who || 'someone'}${at(o, me)}), in ${o.where}, since ${clock(o.since, me.offsetMin)}${now - o.since > 86400000 ? ' (over a day)' : ''}`)
  if (list.length > 20) out.push(`  and ${list.length - 20} more (.claude/fleet/state/code.json)`)
  return out
}

/** /fleet up --dry-run's warnings: what keeps a repository from being watched, or someone from being watched in it */
export function codeLints(c: CodeConfig, instances: readonly Instance[], hostAllowed: (host: string) => boolean, stamped: boolean): string[] {
  const out = [...c.problems]
  for (const r of c.repos) {
    const host = r.kind === 'command' ? null : r.host
    if (host && !hostAllowed(host)) out.push(`world.json's code ${r.name} is on ${host}: fleet reaches a host over ssh only when outbound.json lists it as yours ("hosts"), so it isn't watched until then`)
    if (r.kind !== 'git' && !instances.some(i => takesPart(r, i))) {
      out.push(r.kind === 'p4' ? `world.json's code ${r.name}: no instance names its client workspace (roster.json "code": { "${r.name}": { "client": "…" } } on a role or an instance), so nobody is watched in it` : `world.json's code ${r.name}: no instance names it (roster.json "code": { "${r.name}": {} } on a role or an instance), so nobody is watched in it`)
    }
  }
  const cmds = c.repos.filter(r => r.kind === 'command').map(r => r.name)
  if (cmds.length && !stamped) out.push(`world.json's code ${cmds.join(', ')} ${cmds.length === 1 ? 'runs' : 'run'} the project's own commands as you, so fleet runs them only once you stamp them: /fleet accept checks`)
  const known = new Set([...c.repos.map(r => r.name), ...c.off])
  for (const i of instances) {
    for (const [repo, seat] of Object.entries(i.code)) {
      if (!known.has(repo)) out.push(`"${i.name}": roster.json's code names ${repo}, which world.json's code doesn't have`)
      else if (seat.client && !CLIENT.test(seat.client)) out.push(`"${i.name}": its client "${seat.client}" for ${repo} isn't a Perforce client name (letters, digits, . _ -)`)
    }
  }
  return out
}

/** What an instance reads at its start, when it takes part in a watch */
export function codeContext(c: CodeConfig, inst: Pick<Instance, 'code'>): string | null {
  const mine = c.repos.filter(r => takesPart(r, inst))
  if (!mine.length) return null
  const what = mine.map(r => (r.kind === 'git' ? `${r.upstream} (git)` : r.kind === 'p4' ? `${r.depot} (Perforce${clientOf(inst.code[r.name]) ? `, your client ${clientOf(inst.code[r.name])}` : ''})` : r.name)).join(', ')
  return `fleet watches this project's code upstream: ${what}. When upstream changes a file you changed or have open, fleet tells you at your next step; then rebase (or p4 sync and resolve) at once, and run the tests before you land. Work only in your own worktree and branch (or client workspace), never in another's.`
}
