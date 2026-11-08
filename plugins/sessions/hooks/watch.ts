// What the panel learns by watching files instead of asking `claude agents` every few seconds.
//
// Each session's classic.SessionStart hands the engine the paths to watch (watchPaths); the engine raises
// classic.FileChanged about 0.6 s after one of them changes (0.15 s for a removal), in background sessions too, and
// keeps that list across a hot reload of the mod, until the next SessionStart (a start, /clear, a compaction, a resume)
// replaces it. A reload never raises SessionStart: a module that came in by a reload watches what the module before it
// asked for, so the set of paths has a version of its own (WATCH_SET), which an update in place never crosses
// (reloadDecision), and a module that finds no SessionStart of its own set behind it reads on a short timer instead.
//
// The paths (watchPaths):
// - Claude's registry of running sessions (~/.claude/sessions, or SESSIONS_REGISTRY_DIR): one <pid>.json per running
//   session, rewritten in place by Claude when its status, name, id (/clear) or Remote Control changes, and removed
//   when it ends (a crashed one stays until a `claude agents` listing sweeps it). The .key files beside them are no
//   session.
// - <data>/bell: one small file per thing that changed outside Claude's files, rewritten by whoever changed it (see
//   bellText): a session's own record in the store (bell/<sessionId>: its state, seen and title), the marks other
//   plugins set (bell/marks), the shared choices f and c (bell/prefs), sections.json (bell/sections), pins.json
//   (bell/pins) and the token usage summary (bell/usage). A bell carries no data: it says what to read again.
// - <data>/inbox (ccc's requests: inbox/<sessionId>) and <data>/tell (ccc tell's: tell/<short id>/).
// - The background service's pins.json, and this session's own state in the service's folder when it's a background
//   session (its tasks, its Remote Control). Never the service's whole folder: it holds hundreds of folders, and a
//   watched folder is watched to every depth.
//
// A path that's missing when the list goes is watched only in the simplest case. The engine (chokidar) then waits on
// its parent folder for that name, and the waits on one parent share one read of it: when the parent changes, only one
// of them reads it. So one missing name under a folder that exists is watched once it's made; of several missing under
// one parent only one ever is (in 0.14.0 a new data folder's bell, inbox and tell: the first session there never heard
// of its inbox); and one whose parent is missing too waits for the wrong name and never is. A SessionStart that hands
// the same list again (a /clear, a compaction) leaves the watch as it is: what was missed stays missed until the session
// restarts. So the mod's own folders (ownWatchedFolders) are made before the list goes, and the pass looks for an
// inbox request no event announced (checkInbox). Claude's paths aren't made by the mod: the registry is there while a
// session runs; a missing pins.json is the one name waited for in the service's folder (watched once the service or the
// mod writes it; with that folder missing too, only the pass reads it); so is a background session's own state.json in
// its job's folder, which the service makes before the session starts.
//
// The list itself is read from those files (directList): the same list `claude agents --json --all` prints, as far as
// the panel uses it. Only the elected leader (leader.ts) still runs that command, once a pass: it sweeps the files of
// sessions that crashed, which no file event reports.

import { parseKeyLines, keyLines, FORMAT } from './state'

// The version of the set of paths a session watches: raised whenever a version of the mod watches a new kind of path
// (a reload into it would leave the new kind unwatched until the next SessionStart). A copy's own number is read from
// this line of its file (watchSetOf), so an older copy without this file is set 0
export const WATCH_SET = 1

// The watch set of a copy of the mod, from its hooks/watch.ts (this file): 0 when it has none
export function watchSetOf(source: string | null): number {
  const m = (source ?? '').match(/^export const WATCH_SET = (\d+)$/m)
  return m ? Number(m[1]) : 0
}

export type Locations = { registry: string; data: string; jobs: string }

// The mod's own folders among the watched paths: made, where missing, before the list goes to the engine
export function ownWatchedFolders(l: Locations): string[] {
  return [`${l.data}/bell`, `${l.data}/inbox`, `${l.data}/tell`]
}

// What a session asks the engine to watch: its own background job's state only when it's one (ownJob: its short id)
export function watchPaths(l: Locations, ownJob: string | null): string[] {
  const out = [l.registry, ...ownWatchedFolders(l)]
  if (l.jobs) out.push(`${l.jobs}/pins.json`)
  if (l.jobs && ownJob && /^[A-Za-z0-9_-]+$/.test(ownJob)) out.push(`${l.jobs}/${ownJob}/state.json`)
  return out
}

// What a changed path means. null: none of the panel's
export type Change =
  | { kind: 'registry'; file: string }
  | { kind: 'bell'; name: string }
  | { kind: 'inbox'; id: string }
  | { kind: 'tell'; ref: string; file: string }
  | { kind: 'pins' }
  | { kind: 'job'; id: string }
export function classify(path: string, l: Locations): Change | null {
  const under = (dir: string) => (dir && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null)
  const reg = under(l.registry)
  if (reg !== null) return /^\d+\.json$/.test(reg) ? { kind: 'registry', file: reg } : null
  const bell = under(`${l.data}/bell`)
  // A bell's name has no dot: a writer's temporary file beside it (name.tmp-<pid>) is none
  if (bell !== null) return /^[A-Za-z0-9_:-]+$/.test(bell) ? { kind: 'bell', name: bell } : null
  const inbox = under(`${l.data}/inbox`)
  if (inbox !== null) return inbox && !inbox.includes('/') ? { kind: 'inbox', id: inbox } : null
  const tell = under(`${l.data}/tell`)
  if (tell !== null) {
    const [ref = '', file = ''] = tell.split('/')
    return ref && file ? { kind: 'tell', ref, file } : null
  }
  if (l.jobs && path === `${l.jobs}/pins.json`) return { kind: 'pins' }
  const job = under(l.jobs)
  if (job !== null) {
    const m = job.match(/^([A-Za-z0-9_-]+)\/state\.json$/)
    return m?.[1] ? { kind: 'job', id: m[1] } : null
  }
  return null
}

// A bell (<data>/bell/<name>): who rang it and when. The time makes every ring a change of the file, even when its size
// stays the same
export function bellText(from: string, at: number): string {
  return keyLines({ format: FORMAT, from, at })
}
export function bellFrom(text: string): string {
  return parseKeyLines(text).from ?? ''
}

// Which bell a write of the store rings: a session's own keys that other panels draw (its record, when it was seen, its
// title) ring that session's bell; the answer a session left for another one, answer-<that one>; the shared choices,
// prefs; the marks, marks
export function bellOfKey(key: string): string | null {
  const m = key.match(/^(state|seen|title|answer):(.+)$/)
  if (m?.[1] === 'answer' && m[2]) return `answer-${m[2]}`
  if (m?.[2]) return m[2]
  if (key === 'waitingOnly' || key === 'collapsed') return 'prefs'
  if (key.startsWith('marks:')) return 'marks'
  return null
}

// One running session as Claude's registry file holds it: the fields the panel reads (the rest is Claude's own)
export type RegistryEntry = {
  pid: number
  sessionId: string
  cwd: string
  kind: string
  status?: string
  statusUpdatedAt?: number
  name?: string
  jobId?: string
  startedAt?: number
  bridgeSessionId?: string | null
  // The agent the session runs as (claude --agent <name>, or the agent setting): there from its start (checked on
  // 2.1.319), absent with none
  agent?: string
}

// The statuses Claude writes there. shell: the turn ended with a background shell command still running (claude agents
// lists it as busy)
export const REGISTRY_STATUS = ['idle', 'busy', 'waiting', 'shell']

// A registry file read: a session; one Claude keeps for itself (a pre-started spare, a parked job: `claude agents`
// leaves them out); or a problem (a file cut short while Claude rewrites it in place, or a format this doesn't know)
export function parseRegistry(text: string): { entry: RegistryEntry } | { skip: string } | { problem: string } {
  let d: any
  try {
    d = JSON.parse(text)
  } catch {
    return { problem: 'not JSON' }
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { problem: 'not an object' }
  if (d.spare === true) return { skip: 'spare' }
  if (typeof d.parkedJobId === 'string' && d.parkedJobId) return { skip: 'parked' }
  if (typeof d.sessionId !== 'string' || !d.sessionId) return { problem: 'no sessionId' }
  if (typeof d.cwd !== 'string') return { problem: 'no cwd' }
  if (typeof d.pid !== 'number' || !(d.pid > 0)) return { problem: 'no pid' }
  if (d.status !== undefined && d.status !== null && !REGISTRY_STATUS.includes(d.status)) return { problem: `status ${String(d.status).slice(0, 20)}` }
  const entry: RegistryEntry = { pid: d.pid, sessionId: d.sessionId, cwd: d.cwd, kind: typeof d.kind === 'string' ? d.kind : '' }
  if (typeof d.status === 'string') entry.status = d.status
  if (typeof d.statusUpdatedAt === 'number') entry.statusUpdatedAt = d.statusUpdatedAt
  if (typeof d.name === 'string') entry.name = d.name
  if (typeof d.jobId === 'string' && d.jobId) entry.jobId = d.jobId
  if (typeof d.startedAt === 'number') entry.startedAt = d.startedAt
  if (typeof d.bridgeSessionId === 'string' || d.bridgeSessionId === null) entry.bridgeSessionId = d.bridgeSessionId
  if (typeof d.agent === 'string' && d.agent) entry.agent = d.agent
  return { entry }
}

// A background session's short id: the first 8 characters of its job id (its folder in the service's)
export function shortOf(e: RegistryEntry): string | undefined {
  return e.kind === 'bg' && e.jobId ? e.jobId.slice(0, 8) : undefined
}

// The session list as `claude agents --json --all` prints it, from the registry's running sessions and the service's
// stopped ones (a job folder whose session isn't running: its state.json, with sessionId and cwd): id (a background
// session's short id), sessionId, cwd, kind (background or interactive), pid, status (idle, waiting, or busy for
// anything else, shell included), name, startedAt; and statusUpdatedAt, which only this list has
export function directList(entries: readonly RegistryEntry[], stopped: ReadonlyMap<string, any>): any[] {
  const out: any[] = []
  const running = new Set<string>()
  for (const r of entries) {
    const id = shortOf(r)
    if (id) running.add(id)
    const s: any = { sessionId: r.sessionId, cwd: r.cwd, kind: r.kind === 'bg' ? 'background' : 'interactive', pid: r.pid }
    if (id) s.id = id
    s.status = r.status === 'idle' || r.status === 'waiting' ? r.status : 'busy'
    if (r.name !== undefined) s.name = r.name
    if (r.startedAt !== undefined) s.startedAt = r.startedAt
    if (r.statusUpdatedAt !== undefined) s.statusUpdatedAt = r.statusUpdatedAt
    out.push(s)
  }
  for (const [id, j] of stopped) {
    if (running.has(id) || !j || typeof j.sessionId !== 'string' || typeof j.cwd !== 'string') continue
    const s: any = { id, sessionId: j.sessionId, cwd: j.cwd, kind: 'background' }
    if (typeof j.name === 'string') s.name = j.name
    if (typeof j.state === 'string') s.state = j.state
    out.push(s)
  }
  return out
}

// What of a session the panel's rows are made of: a change of anything else (Claude's own fields) draws nothing
export function rowKey(s: any): string {
  return JSON.stringify([s.sessionId, s.id ?? null, s.pid ?? null, s.status ?? null, s.name ?? null, s.cwd ?? null, s.kind ?? null])
}

export type RegistryNews = { changed: Set<string>; moved: boolean; ok: boolean; left: Set<string>; bridge: boolean; ended: boolean; membership: boolean }

// The sessions as the files show them, kept in memory and read again only where a file moved (its time or size, from
// one listing of the folder). It reads nothing itself (the mod's hooks module does, with its own $): toRead says which
// files to read, applyRegistry takes what they held. A registry file that can't be parsed is a file Claude is rewriting
// in place: the session as it was read before stands, and the file is read again on the next sync; twice in a row, and
// the list is read the slow way (`claude agents`) until it parses again
type Held = { mtimeMs: number; size: number; entry?: RegistryEntry; skip?: string; misses: number }
export type Listed = { name: string; mtimeMs: number; size: number }
export class SessionFiles {
  registry = new Map<string, Held>()
  jobs = new Map<string, { mtimeMs: number; size: number; state: any }>()
  // When the files were last read, whether they can be trusted (problem: why not), whether a file is to be read again
  syncedAt = 0
  problem = ''
  retry = false
  private cached: any[] | null = null

  constructor(public locations: Locations) {}

  // The registry files to read, from a listing of its folder: the ones that are new, moved, or cut short last time
  toRead(listed: readonly Listed[]): string[] {
    return listed
      .filter(f => /^\d+\.json$/.test(f.name))
      .filter(f => {
        const held = this.registry.get(f.name)
        return !held || held.mtimeMs !== f.mtimeMs || held.size !== f.size || held.misses > 0
      })
      .map(f => f.name)
  }

  // The registry as a listing of its folder (null: it can't be read) and the files read from it (null: gone meanwhile)
  // show it. Answers the session ids whose row could have changed (appeared, went, or a field the rows use moved),
  // whether anything moved at all, the short ids of background sessions that left it (stopped, or crashed and swept),
  // whether a Remote Control connection came or went, whether a turn ended somewhere (a session went from working or
  // waiting to idle), and whether a session came or went (membership: who can lead may have changed)
  applyRegistry(listed: readonly Listed[] | null, texts: ReadonlyMap<string, string | null>, now: number): RegistryNews {
    const changed = new Set<string>()
    const left = new Set<string>()
    let bridge = false
    let ended = false
    let membership = false
    this.syncedAt = now
    if (!listed) {
      this.problem = "Claude's registry folder can't be read"
      return { changed, moved: false, ok: false, left, bridge, ended, membership }
    }
    const seen = new Set<string>()
    let moved = false
    let bad = ''
    this.retry = false
    for (const f of listed) {
      if (!/^\d+\.json$/.test(f.name)) continue
      seen.add(f.name)
      const text = texts.get(f.name)
      // Not read (it didn't move), or gone between the listing and the read: the next listing says so
      if (text === undefined || text === null) continue
      const held = this.registry.get(f.name)
      const p = parseRegistry(text)
      if ('problem' in p) {
        const misses = (held?.misses ?? 0) + 1
        this.registry.set(f.name, { mtimeMs: -1, size: -1, entry: held?.entry, skip: held?.skip, misses })
        this.retry = true
        if (misses >= 2) bad = `${f.name}: ${p.problem}`
        continue
      }
      moved = true
      const before = held?.entry
      const entry = 'entry' in p ? p.entry : undefined
      this.registry.set(f.name, { mtimeMs: f.mtimeMs, size: f.size, entry, skip: 'skip' in p ? p.skip : undefined, misses: 0 })
      if (before && (!entry || before.sessionId !== entry.sessionId)) changed.add(before.sessionId)
      if (entry && (!before || rowKey(directList([before], new Map())[0]) !== rowKey(directList([entry], new Map())[0]))) changed.add(entry.sessionId)
      if ((before?.bridgeSessionId || null) !== (entry?.bridgeSessionId || null)) bridge = true
      if (before && entry && before.status !== 'idle' && entry.status === 'idle') ended = true
      if (!before !== !entry || (before && entry && (before.pid !== entry.pid || before.sessionId !== entry.sessionId))) membership = true
      const short = before ? shortOf(before) : undefined
      if (short && (!entry || shortOf(entry) !== short)) left.add(short)
    }
    for (const [name, held] of [...this.registry]) {
      if (seen.has(name)) continue
      this.registry.delete(name)
      moved = true
      if (!held.entry) continue
      membership = true
      changed.add(held.entry.sessionId)
      const short = shortOf(held.entry)
      if (short) left.add(short)
      if (held.entry.bridgeSessionId) bridge = true
      if (held.entry.status !== 'idle') ended = true
    }
    if (moved) this.cached = null
    this.problem = bad ? `a file of Claude's registry isn't what this panel reads (${bad})` : ''
    return { changed, moved, ok: !bad, left, bridge, ended, membership }
  }

  // The service's job folders whose session isn't running: the ids whose state.json to look at (one stat each): a
  // folder that's new, one `also` names (its session just left the registry), every one on a full pass. A folder gone
  // from the listing is forgotten
  jobsToCheck(names: readonly string[], full: boolean, also: ReadonlySet<string> = new Set()): string[] {
    const keep = new Set(names)
    for (const id of [...this.jobs.keys()]) {
      if (keep.has(id)) continue
      this.jobs.delete(id)
      this.cached = null
    }
    const running = new Set(this.entries().map(shortOf).filter(Boolean) as string[])
    return names.filter(id => (also.has(id) || !running.has(id)) && (!this.jobs.has(id) || full || also.has(id)))
  }

  // A job's state.json as its stat shows it (null: there's none): whether to read it (it's new or it moved)
  jobMoved(id: string, st: { mtimeMs: number; size: number } | null): boolean {
    const held = this.jobs.get(id)
    if (!st) {
      if (held) {
        this.jobs.delete(id)
        this.cached = null
      }
      return false
    }
    return !held || held.mtimeMs !== st.mtimeMs || held.size !== st.size
  }

  setJob(id: string, st: { mtimeMs: number; size: number }, state: any) {
    this.jobs.set(id, { mtimeMs: st.mtimeMs, size: st.size, state })
    this.cached = null
  }

  entries(): RegistryEntry[] {
    return [...this.registry.values()].map(h => h.entry).filter((e): e is RegistryEntry => !!e)
  }

  list(): any[] {
    if (!this.cached) {
      const stopped = new Map<string, any>()
      for (const [id, j] of this.jobs) stopped.set(id, j.state)
      this.cached = directList(this.entries(), stopped)
    }
    return this.cached
  }

  // The list can stand for `claude agents` only when every file parsed and this very session is in it (by its id, or by
  // its process right after a /clear, before the mod follows the new id)
  usable(sessionId: string, pid: number): boolean {
    return !this.problem && this.syncedAt > 0 && this.entries().some(e => e.sessionId === sessionId || (pid > 0 && e.pid === pid))
  }
}

// How the direct read differs from `claude agents`'s list (the leader's check, for the debug log): counts only, '' when
// they agree on every session and its status. A running session only the direct read has is one that crashed: the
// listing just swept its file
export function listDrift(mine: readonly any[], official: readonly any[]): string {
  const theirs = new Map(official.map(s => [String(s.sessionId), s]))
  const ours = new Map(mine.map(s => [String(s.sessionId), s]))
  let onlyHere = 0
  let onlyThere = 0
  let moved = 0
  for (const [id, s] of ours) {
    const o = theirs.get(id)
    if (!o) onlyHere++
    else if ((s.pid ?? null) !== (o.pid ?? null) || (s.pid && (s.status ?? null) !== (o.status ?? null))) moved++
  }
  for (const id of theirs.keys()) if (!ours.has(id)) onlyThere++
  return [
    onlyHere ? `${onlyHere} only in Claude's files (crashed: swept now)` : '',
    onlyThere ? `${onlyThere} only in claude agents` : '',
    moved ? `${moved} with another process or status` : '',
  ]
    .filter(Boolean)
    .join(', ')
}

// The job folders in a listing of the service's folder (a folder's entry; a listing that gives the files under it, as
// the tests' does, names it by its first part)
export function jobIds(listed: readonly { name: string }[]): string[] {
  return [...new Set(listed.map(f => String(f?.name ?? '').split('/')[0] ?? ''))].filter(n => /^[A-Za-z0-9_-]+$/.test(n))
}
