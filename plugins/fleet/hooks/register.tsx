import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FleetInflight, FleetRead } from '../types'
import {
  KEEP_DAYS,
  WORLD_FORMAT,
  acceptable,
  addGlob,
  ancestorsOf,
  bashReadTarget,
  caseProbe,
  changeLine,
  changedPaths,
  clock,
  digestItems,
  digestText,
  eventName,
  gateText,
  globBase,
  globList,
  globRegex,
  hashText,
  hourFolder,
  inWorld,
  isEvent,
  newWorld,
  newer,
  oldDays,
  overwroteText,
  parseReads,
  parseWorld,
  placeable,
  relOf,
  removeGlob,
  staleOf,
  statVersion,
  verdict,
  whoText,
  windowFolders,
  worldText,
  type ChangeEvent,
  type Me,
  type ReadsFile,
  type Snapshot,
  type Who,
  type WorldConfig,
} from './changes'
import {
  ASKING_SECTION,
  CONFIG_FORMAT,
  DECIDE_DESCRIPTION,
  DECIDE_SCHEMA,
  FORMAT,
  HELP,
  REGISTER_FORMAT,
  SUBAGENT_REFUSAL,
  ago,
  answerName,
  checkDecide,
  classifyDialog,
  configText,
  dayOf,
  deliveryText,
  dialogQuestions,
  dropName,
  gitignoreText,
  heldCount,
  heldText,
  idNumber,
  isDecisionId,
  letter,
  monthBefore,
  monthOf,
  noteName,
  parseAnswerName,
  parseCommand,
  parseConfig,
  parseWire,
  progress,
  queueName,
  ticketText,
  waitingText,
  type AnswerFile,
  type AnswerItem,
  type Asker,
  type AskerView,
  type Config,
  type Delivery,
  type DropFile,
  type NoteFile,
  type Outcome,
  type QueueRecord,
  type RegisterRecord,
} from './decisions'
import {
  LEASE_MS,
  MAX_LINES,
  blindText,
  changeOf,
  checkOutcome,
  confirmedPins,
  checksKey,
  citeText,
  commitMessage,
  copyOf,
  copyReadText,
  copyWriteText,
  idOf,
  isStrict,
  landedText,
  landingKind,
  leaseState,
  needsCheck,
  ownedBy,
  parseCheckFile,
  parseLease,
  parsePin,
  parseRev,
  parseSuspects,
  pinKey,
  pinProblems,
  pinState,
  pinsOf,
  pinsText,
  porcelainPaths,
  problemKeys,
  recordsOf,
  scriptsOf,
  suspectKey,
  suspectLine,
  suspectsOf,
  worktreeFolders,
  type Check,
  type CheckFile,
  type Facts,
  type PinState,
  type ReadState,
  type Records,
  type Rev,
  type Suspect,
  type SuspectsFile,
} from './records'

// fleet, per project: a background session asks the person with mcp__fleet__decide and goes on working; the person
// answers from any session of the project with /fleet (no tokens), and the asking session's fleet hands the answer to
// its model as a prompt of its own once it's idle. And the project's shared files (the world, world.json): a thread's
// write of one that changed since it read it is refused once with who changed it and when, and the thread hears of such
// changes at its next step (changes.ts). The project's .claude/fleet/ folder holds everything (decisions.ts lists the
// files); fleet keeps no store. Other sessions are named, and their state read, only through $.sessions (calls only:
// fleet never hooks a sessions.* event nor reads its files).

// $.state survives a hot reload of this module (module variables don't): what the delivery depends on lives there
const held = atom({ plugin: 'fleet', key: 'held' } as const, 0)
const open = atom({ plugin: 'fleet', key: 'open' } as const, {} as Record<string, number>)
const inflight = atom({ plugin: 'fleet', key: 'inflight' } as const, {} as Record<string, FleetInflight>)
const stopped = atom({ plugin: 'fleet', key: 'stopped' } as const, false)
const retryAt = atom({ plugin: 'fleet', key: 'retryAt' } as const, 0)
const busy = atom({ plugin: 'fleet', key: 'busy' } as const, false)
const idleSince = atom({ plugin: 'fleet', key: 'idleSince' } as const, 0)
const listing = atom({ plugin: 'fleet', key: 'listing' } as const, [] as string[])
const section = atom({ plugin: 'fleet', key: 'section' } as const, '')
const reads = atom({ plugin: 'fleet', key: 'reads' } as const, {} as Record<string, Record<string, FleetRead>>)
const warned = atom({ plugin: 'fleet', key: 'warned' } as const, {} as Record<string, Record<string, string>>)
const flags = atom({ plugin: 'fleet', key: 'flags' } as const, 0)
const ownTold = atom({ plugin: 'fleet', key: 'ownTold' } as const, {} as Record<string, number>)

// This copy of the module: a hot reload makes a new one and drops the old one's timers and the submits it waited on
const EPOCH = Math.random().toString(36).slice(2, 10)
// How long an idle session can hold a submit from an older copy before it's taken as lost (an idle session starts a
// plugin's prompt within milliseconds, so one still pending then never ran)
const ORPHAN_IDLE_MS = 10000
const HOUR = 3600000

let located: Promise<void> | null = null
let home = ''
let version = ''
// The project: the nearest folder upwards from the session's root with .claude/fleet/config.json (never the home folder)
let root: string | null = null
let configProblem = ''
// The linked worktree this session started in, when its project is the main checkout's
let startedInTree = ''
// A background session's official short id, from Claude's CLAUDE_JOB_DIR (~/.claude/jobs/<short id>); null otherwise.
// It stays across /clear and restarts, so it names the asker of a decision
let jobRef: string | null = null
let offered = false
let whyNot = "session.start never came in this session (an old pre-started process?): restart it (u)"
let started = false
let startScheduled = false
let timersOn = false
let delivering = false
let lastPruneCheck = 0
let tmpCount = 0
const closing = new Set<string>()
// Queue files are written once: parsed ones are kept by name
const queueCache = new Map<string, QueueRecord | { otherFormat: number } | null>()

// ---- $.sessions: what this copy serves, asked once (docs/plugin-contract.md in sessions) ----

// The contract's own types, as sessions declares them (its types/index.d.ts, laid beside this plugin by Claude)
type Api = EngineInterface['sessions']
type Contract = Awaited<ReturnType<Api['contract']>>
type Current = Awaited<ReturnType<Api['current']>>
type Status = Awaited<ReturnType<Api['status']>>
type Result = Awaited<ReturnType<Api['assignSection']>>
type Method = keyof Api
const SESSIONS_API = 1
let found: Contract | null | undefined
let foundAt = 0

async function has($: any, method: Method): Promise<boolean> {
  const now = await $.clock.now()
  // A copy that didn't answer is asked again a minute later (it may have been starting)
  if (found === undefined || (found === null && now - foundAt > 60000)) {
    foundAt = now
    try {
      found = await Promise.race([$.sessions.contract(), $.clock.sleep(500).then(() => null)])
    } catch {
      found = null
    }
  }
  return !!found && found.api === SESSIONS_API && found.methods.includes(method)
}

// A $.sessions call, raced against 500 ms: null when it lost or threw
async function race<T>($: any, call: () => Promise<T>): Promise<T | null> {
  try {
    return await Promise.race([call(), $.clock.sleep(500).then(() => null)])
  } catch {
    return null
  }
}

// ---- Small helpers: files and commands ----

function bg(work: Promise<unknown>) {
  work.catch(() => {})
}

function log($: any, line: string) {
  try {
    void Promise.resolve($.ui.log(`fleet: ${line}`, { to: 'debug' })).catch(() => {})
  } catch {}
}

function fleetDir(): string {
  return `${root}/.claude/fleet`
}
function dec(sub: string): string {
  return `${root}/.claude/fleet/decisions/${sub}`
}

// Every command runs from / (it exists; every path is absolute), except a project's check script, which runs from the
// project's folder (it exists: fleet found its .claude/fleet/ there). One that can't start counts as a failure (127),
// one still running at its timeout too (124)
async function run($: any, argv: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    return await $.process.run(argv, { cwd: opts.cwd ?? '/', timeoutMs: opts.timeoutMs ?? 10000 })
  } catch (err) {
    return { exitCode: /time/i.test(String(err)) ? 124 : 127, stdout: '', stderr: String(err) }
  }
}

async function exists($: any, path: string): Promise<boolean> {
  try {
    return !!(await $.fs.exists(path))
  } catch {
    return false
  }
}

async function readText($: any, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function names($: any, dir: string): Promise<string[]> {
  try {
    return (await $.fs.list(dir)).map((x: any) => String(x.name))
  } catch {
    return []
  }
}

async function tmpFile($: any, text: string): Promise<string> {
  const path = dec(`tmp/${await $.clock.now()}-${EPOCH}-${++tmpCount}`)
  await $.fs.write(path, text)
  return path
}

// No-clobber: the file appears whole, or not at all when it's there already (ln refuses to replace it). So the first
// answer wins, and a register record is written once
async function publish($: any, path: string, text: string): Promise<'ok' | 'exists' | 'failed'> {
  const tmp = await tmpFile($, text)
  let r = await run($, ['ln', tmp, path])
  if (r.exitCode !== 0 && !(await exists($, path))) {
    // A register month seen for the first time
    await run($, ['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))])
    r = await run($, ['ln', tmp, path])
  }
  await run($, ['rm', '-f', tmp])
  if (r.exitCode === 0) return 'ok'
  return (await exists($, path)) ? 'exists' : 'failed'
}

// The file appears whole, over any older one
async function replace($: any, path: string, text: string): Promise<boolean> {
  const tmp = await tmpFile($, text)
  const r = await run($, ['mv', '-f', tmp, path])
  if (r.exitCode !== 0) await run($, ['rm', '-f', tmp])
  return r.exitCode === 0
}

async function remove($: any, paths: string[]) {
  if (paths.length) await run($, ['rm', '-f', ...paths])
}

function json(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`
}

function omit<T>(m: Record<string, T>, ids: readonly string[]): Record<string, T> {
  const out = { ...m }
  for (const id of ids) delete out[id]
  return out
}

// ---- Where this session stands: its project, whether it's a background session ----

// A session started in a linked git worktree belongs to the project of the main checkout: one world, one set of events
// (a worktree's own .claude/fleet/, committed with the project, would make it a project apart)
async function findRoot($: any): Promise<string | null> {
  const start = String(await $.session.root()).replace(/\/+$/, '')
  const main = await mainCheckoutOf($, start).catch(() => null)
  if (main) {
    const r = await rootAbove($, main)
    if (r) {
      startedInTree = start
      return r
    }
  }
  return rootAbove($, start)
}

async function rootAbove($: any, from: string): Promise<string | null> {
  let dir = from
  for (let i = 0; i < 32 && dir && dir !== home; i++) {
    if (await exists($, `${dir}/.claude/fleet/config.json`)) return dir
    const up = dir.slice(0, dir.lastIndexOf('/'))
    if (!up || up === dir) break
    dir = up
  }
  return null
}

// CLAUDE_JOB_DIR is set only in background sessions. A claude started from such a session's Bash inherits it, so its
// state.json must name this session (sessionId, or resumeSessionId after a /clear and a restart)
async function backgroundRef($: any): Promise<string | null> {
  const dir = await $.env.get('CLAUDE_JOB_DIR')
  if (!dir) return null
  const ref = dir.replace(/\/+$/, '').split('/').pop() || null
  const state = await readText($, `${dir}/state.json`)
  if (state !== null) {
    try {
      const s = JSON.parse(state)
      const id = String(await $.session.id())
      if (s && (s.sessionId || s.resumeSessionId) && s.sessionId !== id && s.resumeSessionId !== id) return null
    } catch {}
  }
  return ref
}

async function readConfig($: any): Promise<{ config: Config } | { problem: string }> {
  const t = await readText($, `${fleetDir()}/config.json`)
  return t === null ? { problem: "config.json can't be read" } : parseConfig(t)
}

function locate($: any): Promise<void> {
  if (!located) {
    located = (async () => {
      home = ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
      try {
        version = String(JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))?.version ?? '')
      } catch {}
      jobRef = await backgroundRef($)
      root = await findRoot($)
      if (root) {
        const c = await readConfig($)
        configProblem = 'problem' in c ? c.problem : ''
      }
    })().catch(() => {})
  }
  return located
}

// mcp__fleet__decide, only in a background session of a project with .claude/fleet/. Registered before the first
// request of turn one, which the session's launch prompt can already be waiting to send
async function offer($: any) {
  await locate($)
  if (!root) {
    whyNot = 'this project has no .claude/fleet/ (/fleet init sets it up)'
    return
  }
  if (!jobRef) {
    whyNot = "this isn't a background session: here the model asks with AskUserQuestion, and fleet records the answers"
    return
  }
  await $.tool.register({ name: 'decide', description: DECIDE_DESCRIPTION, inputSchema: DECIDE_SCHEMA as any, isDeferred: false })
  offered = true
  whyNot = ''
  log($, `decide offered (background session ${jobRef}, project ${root})`)
}

// The rest of the start, from session.start or from the first draw of the band (a session that got an old pre-started
// process can miss session.start): /fleet, and the timers when the project has fleet
async function start($: any) {
  if (started) return
  started = true
  await locate($)
  await $.command
    .register({
      name: 'fleet',
      description: 'The questions background sessions of this project are waiting on: /fleet lists them, /fleet 1a 2b answers them. /fleet help for the rest',
      argumentHint: '[1a 2b | note <n> <text> | drop <n> [why] | status | world | accept <path> | init | help]',
      immediate: true,
    })
    .catch(() => {})
  if (root) timers($)
  else {
    // Set up later from another session (/fleet init): this one joins within a minute
    const look = $.clock.every(60000, () => {
      bg(
        (async () => {
          if (root) return look.cancel()
          const r = await findRoot($)
          if (!r) return
          root = r
          worldReady = null
          look.cancel()
          timers($)
          if (jobRef && !offered) await offer($)
        })(),
      )
    })
  }
}

// Everything from timers: this can run from session.start, where sessions hasn't started yet (it runs after fleet)
function timers($: any) {
  if (timersOn || !root) return
  timersOn = true
  if (jobRef) {
    $.clock.after(0, () => bg(rebuild($)))
    $.clock.every(2000, () => bg(deliver($)))
  }
  $.clock.after(0, () => bg(startWorld($)))
  $.clock.every(2000, () => bg(worldTick($)))
  $.clock.every(10000, () => bg(beat($)))
  $.clock.after(1000, () => bg(beat($)))
}

// ---- The decisions' files ----

async function readQueue($: any, id: string): Promise<QueueRecord | { otherFormat: number } | null> {
  const t = await readText($, dec(`queue/${queueName(id)}`))
  if (t === null) return null
  const p = parseWire<QueueRecord>(t)
  return p && 'value' in p ? p.value : p
}

// Every open decision of the project, oldest first, and how many were asked by a fleet with another format
async function queueRecords($: any): Promise<{ records: QueueRecord[]; other: number }> {
  const list = (await names($, dec('queue'))).filter(n => /^D-\d+\.json$/.test(n))
  for (const n of [...queueCache.keys()]) if (!list.includes(n)) queueCache.delete(n)
  const records: QueueRecord[] = []
  let other = 0
  for (const n of list) {
    if (!queueCache.has(n)) queueCache.set(n, await readQueue($, n.slice(0, -5)))
    const r = queueCache.get(n)
    if (r && 'otherFormat' in r) other++
    else if (r) records.push(r)
  }
  records.sort((a, b) => a.at - b.at || idNumber(a.id) - idNumber(b.id))
  return { records, other }
}

async function answerNames($: any): Promise<Set<string>> {
  return new Set(await names($, dec('answers')))
}

// What the person said to each question (with the notes), and whether the decision was dropped. skew: a file from a
// fleet with another format, which nothing acts on
async function outcomesOf($: any, r: QueueRecord, present: ReadonlySet<string>) {
  const outcomes: (Outcome | null)[] = []
  let skew = false
  for (let q = 1; q <= r.questions.length; q++) {
    let o: Outcome | null = null
    if (present.has(answerName(r.id, q))) {
      const p = parseWire<AnswerFile>((await readText($, dec(`answers/${answerName(r.id, q)}`))) ?? '')
      if (p && 'value' in p) {
        const a = p.value
        o = { ...(a.label !== undefined ? { label: a.label } : { text: a.text ?? '' }), origin: a.origin, session: a.session, at: a.at }
      } else skew = true
    }
    if (o && present.has(noteName(r.id, q))) {
      const p = parseWire<NoteFile>((await readText($, dec(`answers/${noteName(r.id, q)}`))) ?? '')
      if (p && 'value' in p) o.note = p.value.text
    }
    outcomes.push(o)
  }
  let drop: DropFile | null = null
  if (present.has(dropName(r.id))) {
    const p = parseWire<DropFile>((await readText($, dec(`answers/${dropName(r.id)}`))) ?? '')
    if (p && 'value' in p) drop = p.value
    else skew = true
  }
  return { outcomes, drop, skew }
}

function answerFiles(id: string, present: ReadonlySet<string>): string[] {
  return [...present].filter(n => parseAnswerName(n)?.id === id).map(n => dec(`answers/${n}`))
}

function registerPath(id: string, month: string): string {
  return dec(`register/${month}/${id}.json`)
}

// A decision closed lately is in the register of its month (that of the asking) or the one before
async function inRegister($: any, id: string, at: number): Promise<boolean> {
  const m = monthOf(at)
  return (await exists($, registerPath(id, m))) || (await exists($, registerPath(id, monthBefore(m))))
}

// The next D-<n>: one past the highest handed out (decisions/last, the open ones, and when that's missing this month's
// and last month's register). Claimed no-clobber in queue/, so two sessions asking at once get two numbers
async function nextNumber($: any, now: number): Promise<number> {
  let n = 0
  const last = parseWire<{ last: number }>((await readText($, dec('last'))) ?? '')
  const known = !!last && 'value' in last
  if (last && 'value' in last) n = Number(last.value.last) || 0
  for (const name of await names($, dec('queue'))) n = Math.max(n, idNumber(name.replace(/\.json$/, '')))
  if (!known) {
    for (const m of [monthOf(now), monthBefore(monthOf(now))]) {
      for (const name of await names($, dec(`register/${m}`))) n = Math.max(n, idNumber(name.replace(/\.json$/, '')))
    }
  }
  return n + 1
}

async function allocate($: any, make: (id: string) => QueueRecord): Promise<QueueRecord> {
  const now = await $.clock.now()
  let n = await nextNumber($, now)
  for (let tries = 0; tries < 50; tries++, n++) {
    const id = `D-${n}`
    const record = make(id)
    const r = await publish($, dec(`queue/${queueName(id)}`), json(record))
    if (r === 'exists') continue
    if (r === 'failed') throw new Error("couldn't write the queue")
    // The number belonged to a decision already closed (decisions/last went back): give it up
    if (await inRegister($, id, now)) {
      await remove($, [dec(`queue/${queueName(id)}`)])
      continue
    }
    await replace($, dec('last'), json({ format: FORMAT, last: n }))
    return record
  }
  throw new Error('no free decision number')
}

async function sessionName($: any): Promise<string> {
  if (await has($, 'current')) {
    const c = await race<Current>($, () => $.sessions.current())
    if (c?.ready && c.name) return c.name
  }
  return jobRef ?? String(await $.session.id()).slice(0, 8)
}

async function askerNow($: any): Promise<Asker> {
  let name: string | null = null
  if (await has($, 'current')) {
    const c = await race<Current>($, () => $.sessions.current())
    if (c?.ready) name = c.name || null
  }
  return { ref: jobRef, sessionId: String(await $.session.id()), name, root: root as string }
}

// Closes a decision: its register record first (written once), then its queue and answer files. A crash between the
// steps leaves the register, and whoever finds the leftovers removes them
async function close($: any, id: string, how: { state: 'delivered' | 'abandoned'; turnId?: string; why?: string }) {
  // One close at a time per decision in this module (the turn's start and the submit's answer come together)
  if (closing.has(id)) return
  closing.add(id)
  try {
    await closeNow($, id, how)
  } finally {
    closing.delete(id)
  }
}

async function closeNow($: any, id: string, how: { state: 'delivered' | 'abandoned'; turnId?: string; why?: string }) {
  const rec = await readQueue($, id)
  if (rec && !('otherFormat' in rec)) {
    const present = await answerNames($)
    const { outcomes, drop } = await outcomesOf($, rec, present)
    const now = await $.clock.now()
    const delivered = how.state === 'delivered'
    const why = drop?.why || how.why
    const entry: RegisterRecord = {
      registerFormat: REGISTER_FORMAT,
      id,
      source: 'decide',
      fleet: rec.fleet,
      at: rec.at,
      asker: rec.asker,
      questions: rec.questions,
      ...(rec.blocks ? { blocks: rec.blocks } : {}),
      answers: outcomes,
      state: delivered ? (drop ? 'dropped' : 'delivered') : 'abandoned',
      ...(why ? { why } : {}),
      ...(delivered ? { delivered: { at: now, ...(how.turnId ? { turnId: how.turnId } : {}), how: 'submit' as const } } : {}),
      closedAt: now,
    }
    const r = await publish($, registerPath(id, monthOf(rec.at)), json(entry))
    if (r === 'failed') log($, `${id}: couldn't write its register record; its files stay`)
    else await remove($, [dec(`queue/${queueName(id)}`), ...answerFiles(id, present)])
    log($, `${id} closed: ${entry.state}${how.turnId ? ` (turn ${how.turnId})` : ''}`)
  }
  await update($, open, m => omit(m, [id]))
  await update($, inflight, m => omit(m, [id]))
  bg(beat($))
}

// After a restart (or a /clear) this session's open decisions come back from the files: those its short id asked
async function rebuild($: any) {
  if (!jobRef) return
  const back: Record<string, number> = {}
  for (const name of await names($, dec('queue'))) {
    if (!/^D-\d+\.json$/.test(name)) continue
    const r = await readQueue($, name.slice(0, -5))
    if (!r || 'otherFormat' in r || r.asker.ref !== jobRef) continue
    if (await inRegister($, r.id, r.at)) {
      await remove($, [dec(`queue/${name}`), ...answerFiles(r.id, await answerNames($))])
      continue
    }
    back[r.id] = r.questions.length
  }
  if (Object.keys(back).length) {
    await update($, open, m => ({ ...back, ...m }))
    log($, `open here: ${Object.keys(back).join(', ')}`)
  }
}

// ---- Delivery: the asking session hands its model the answers, as a prompt of fleet's own, once it's idle ----

// Every 2 s in a background session with open decisions. One submit carries every decision ready then; the record
// closes at the turn that carries its [D-<n>] (turnStarted). A submit is sent again only after a { drop }, a failure,
// or a restart; after an Esc the engine refuses them until the person types here, and so does this
async function deliver($: any) {
  if (delivering) return
  delivering = true
  try {
    const mine = await read($, open)
    const ids = Object.keys(mine)
    if (!ids.length) return
    const now = await $.clock.now()
    const isBusy = await read($, busy)
    const pending = await read($, inflight)
    // Submits an older copy of the module waited on: their answer was lost with it. Once the session has been idle a
    // while, one that started its turn shows in the transcript; one that didn't is sent again
    const orphans = Object.keys(pending).filter(id => pending[id]?.epoch !== EPOCH)
    if (orphans.length && !isBusy && now - (await read($, idleSince)) >= ORPHAN_IDLE_MS) {
      const seen = await deliveredInTranscript($, orphans)
      for (const id of orphans) {
        if (seen.has(id)) await close($, id, { state: 'delivered' })
        else await update($, inflight, m => omit(m, [id]))
      }
    }
    if (isBusy || (await read($, stopped)) || now < (await read($, retryAt))) return
    const present = await answerNames($)
    const inFlight = await read($, inflight)
    const parts: Delivery[] = []
    for (const id of ids) {
      if (inFlight[id] || !progress(id, mine[id] as number, present).complete) continue
      const rec = await readQueue($, id)
      if (!rec || 'otherFormat' in rec) {
        // Closed elsewhere (dropped or pruned while its asker looked gone), or not ours to read
        if (!rec) await update($, open, m => omit(m, [id]))
        continue
      }
      if (await inRegister($, id, rec.at)) {
        await close($, id, { state: 'delivered' })
        continue
      }
      const { outcomes, drop, skew } = await outcomesOf($, rec, present)
      if (skew) {
        log($, `${id}: an answer from a fleet with another format; restart the sessions (u)`)
        continue
      }
      parts.push({ record: rec, outcomes, drop })
    }
    if (!parts.length) return
    const sent = parts.map(p => p.record.id)
    await update($, inflight, m => ({ ...m, ...Object.fromEntries(sent.map(id => [id, { at: now, epoch: EPOCH }])) }))
    log($, `delivering ${sent.join(', ')}`)
    $.prompt.submit({ text: deliveryText(parts) }).then(
      (r: any) => bg(submitted($, sent, r)),
      (err: unknown) => bg(failed($, sent, err)),
    )
  } finally {
    delivering = false
  }
}

async function submitted($: any, ids: string[], r: any) {
  if (r && typeof r.drop === 'string') {
    await update($, inflight, m => omit(m, ids))
    // An Esc stopped the session: the engine refuses every plugin prompt until the person types, and fleet waits too
    if (/stopped|nobody has sent input/i.test(r.drop)) await update($, stopped, () => true)
    log($, `the submit of ${ids.join(', ')} was dropped: ${r.drop}`)
    return
  }
  // { text }: its turn has started, and turnStarted closes the records with the turn's id. A second later this closes
  // any it didn't get to
  await $.clock.sleep(1000)
  const still = await read($, open)
  for (const id of ids) if (still[id] !== undefined) await close($, id, { state: 'delivered' })
}

async function failed($: any, ids: string[], err: unknown) {
  await update($, inflight, m => omit(m, ids))
  const now = await $.clock.now()
  await update($, retryAt, () => now + 30000)
  log($, `the submit of ${ids.join(', ')} failed (${String(err).slice(0, 200)}); trying again in 30 s`)
}

// The turn that carries a delivery: fleet's text starts each decision with "[D-<n>] The person …"
function deliveredIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\[(D-\d+)\] The person (?:answered|dropped)/g)].map(m => m[1] as string))]
}

async function deliveredInTranscript($: any, ids: string[]): Promise<Set<string>> {
  const seen = new Set<string>()
  try {
    const messages = await $.session.messages()
    if (!Array.isArray(messages)) return seen
    for (const m of messages.slice(-200)) {
      if (m?.role !== 'user' || typeof m.text !== 'string') continue
      for (const id of deliveredIds(m.text)) if (ids.includes(id)) seen.add(id)
    }
  } catch {}
  return seen
}

async function turnStarted($: any, text: string, turnId: string) {
  await update($, busy, () => true)
  const ids = deliveredIds(text)
  if (!ids.length) return
  const mine = await read($, open)
  const pending = await read($, inflight)
  const closing = ids.filter(id => mine[id] !== undefined || pending[id])
  if (!closing.length) return
  await update($, inflight, m => omit(m, closing))
  for (const id of closing) await close($, id, { state: 'delivered', turnId })
}

// ---- Every 10 s, in every session of the project: the band's count, this session's section, the daily prune ----

async function beat($: any) {
  if (!root) return
  const { records } = await queueRecords($)
  const present = await answerNames($)
  const n = heldCount(records, present)
  if ((await read($, held)) !== n) await update($, held, () => n)
  if (jobRef) await keepSection($, records, present)
  await refreshName($)
  await scanWorld($).catch(err => log($, `world scan: ${String(err).slice(0, 200)}`))
  await maybePrune($, records)
}

// A background session that waits on the person sits in the panel's "Asking you" section (sessions' own, defined by
// fleet), and leaves it once it has its answers. Never over the person's choice: sessions refuses that, and fleet lets it
async function keepSection($: any, records: QueueRecord[], present: ReadonlySet<string>) {
  const waiting = records.some(r => r.asker.ref === jobRef && !progress(r.id, r.questions.length, present).complete)
  const want = waiting ? ASKING_SECTION : 'none'
  if ((await read($, section)) === want) return
  if (!(await has($, 'assignSection')) || !(await has($, 'defineSection'))) return
  if (waiting) {
    const d = await race<Result>($, () => $.sessions.defineSection({ source: 'fleet', spec: { id: ASKING_SECTION, title: 'Asking you' } }))
    if (!d?.ok) return
  }
  const r = await race<Result>($, () => $.sessions.assignSection({ source: 'fleet', ref: jobRef as string, section: waiting ? ASKING_SECTION : null }))
  if (r && (r.ok || r.reason === 'refused' || r.reason === 'invalid')) await update($, section, () => want)
}

// Once a day, by whichever session publishes decisions/prune/<day> first: decisions whose asker is gone from the
// session list go to the register as abandoned (with any answers); stray answer files, old tmp files and old markers go
async function maybePrune($: any, records: QueueRecord[]) {
  const now = await $.clock.now()
  if (now - lastPruneCheck < HOUR) return
  lastPruneCheck = now
  const marker = dec(`prune/${dayOf(now)}`)
  if (await exists($, marker)) return
  if (!(await has($, 'status'))) return
  const refs = [...new Set(records.filter(r => r.asker.ref && now - r.at > HOUR).map(r => r.asker.ref as string))]
  const st = refs.length ? await race<Status>($, () => $.sessions.status({ refs })) : { ready: true, rows: [] }
  if (!st?.ready) {
    // sessions hasn't read the list yet: in a minute
    lastPruneCheck = now - HOUR + 60000
    return
  }
  if ((await publish($, marker, json({ format: FORMAT, at: now }))) !== 'ok') return
  log($, `prune ${dayOf(now)}`)
  const gone = new Set(st.rows.filter((r: any) => r.state === 'gone').map((r: any) => r.ref))
  for (const r of records) {
    if (r.asker.ref && gone.has(r.asker.ref) && now - r.at > HOUR) await close($, r.id, { state: 'abandoned', why: 'its session is gone' })
  }
  const old = async (dir: string, ms: number, keep: (name: string) => boolean) => {
    let entries: any[] = []
    try {
      entries = await $.fs.list(dir)
    } catch {}
    const paths = entries.filter(x => !keep(String(x.name)) && now - Number(x.mtimeMs) > ms).map(x => `${dir}/${x.name}`)
    await remove($, paths)
  }
  const queued = new Set((await names($, dec('queue'))).map(n => n.replace(/\.json$/, '')))
  await old(dec('answers'), HOUR, n => queued.has(parseAnswerName(n)?.id ?? ''))
  await old(dec('tmp'), 24 * HOUR, () => false)
  await old(dec('prune'), 7 * 24 * HOUR, () => false)
  await pruneWorld($, now)
}

// ---- The world: the project's shared files, and "changed since you read it" (changes.ts) ----

// world.json's globs (null: no world.json, or one this fleet can't use: worldProblem says why), the project's real
// folder and whether its volume ignores case. Module state: a hot reload reads them again
let world: { globs: string[]; res: RegExp[]; mtimeMs: number } | null = null
let worldProblem = ''
let worldReady: Promise<void> | null = null
let realRoot = ''
let insensitive = false
// The events of the trailing window seen so far (name → when seen), the newest per world path, and how many came from
// a fleet with another format
const seen = new Map<string, number>()
const latest = new Map<string, ChangeEvent>()
// The last landings of the window, newest last, for /fleet status
const recent: ChangeEvent[] = []
let otherEvents = 0
let latestMark = -1
let pulling: Promise<void> | null = null
let pullAgain = false
let eventCount = 0
// The world as this session's scan last saw it (with the pins each file cites), and the changes nobody's event
// explains yet (recorded as outside changes when they stay so for a scan)
type Known = { mtimeMs: number; size: number; v: string | null; pins?: string[] }
const known = new Map<string, Known>()
const unexplained = new Map<string, { v: string | null; since: number }>()
let baselined = false
let worldStarted = false
let tooBig = false
let bashRunning = 0
let readsTimer = false
// This session as other sessions' digests name it, from $.sessions every 10 s
let myName: string | null = null
let myRef: string | null = null
// A world past this many files isn't scanned after each command (the scan every 10 s still runs)
const MAX_WORLD_FILES = 5000
const MiB4 = 4 * 1024 * 1024
// What world.json says of records (records.ts); null with nothing to say, or when it's wrong (recordsProblem says why,
// and the rest of the world stays on)
let records: Records | null = null
let recordsProblem = ''
// Each record's versions, as read from state/revs/<id>/ (its folder's time says when to look again)
const revCache = new Map<string, { revs: Map<number, Rev>; mtime: number; at: number }>()
// The world's records by id, from what the scans saw (the first file of an id wins; status names the others)
const idIndex = new Map<string, string>()
const twins = new Map<string, string[]>()
// The linked git worktrees of the project's repository (their real folders), and where the project sits in it
const trees = { at: 0, linked: [] as string[], sub: '', git: true, forced: 0 }

function eventsDir(sub = ''): string {
  return `${root}/.claude/fleet/events${sub ? `/${sub}` : ''}`
}
function stateDir(sub = ''): string {
  return `${root}/.claude/fleet/state${sub ? `/${sub}` : ''}`
}
function revDir(id: string): string {
  return stateDir(`revs/${id}`)
}

function pinsFrom(text: string | null): string[] {
  return records && text ? pinsOf(text, records).map(pinKey) : []
}

function setKnown(rel: string, k: Known) {
  known.set(rel, k)
  const id = records ? idOf(rel, records) : null
  if (!id) return
  const at = idIndex.get(id)
  if (at === undefined) idIndex.set(id, rel)
  else if (at !== rel && !(twins.get(id) ?? []).includes(rel)) twins.set(id, [...(twins.get(id) ?? []), rel])
}

function dropKnown(rel: string) {
  known.delete(rel)
  const id = records ? idOf(rel, records) : null
  if (id && (idIndex.get(id) === rel || twins.has(id))) indexIds()
}

function indexIds() {
  idIndex.clear()
  twins.clear()
  if (!records) return
  for (const rel of [...known.keys()].sort()) {
    const id = idOf(rel, records)
    if (!id) continue
    if (!idIndex.has(id)) idIndex.set(id, rel)
    else twins.set(id, [...(twins.get(id) ?? []), rel])
  }
}
function readsPath(sessionId: string): string {
  return `${root}/.claude/fleet/reads/${sessionId}.json`
}

/** The world is on in a session that started fleet (not claude -p), in a project whose world.json has globs */
function worldOn(): boolean {
  return started && !!root && !!realRoot && !!world && world.globs.length > 0
}

function ensureWorld($: any): Promise<void> {
  if (!worldReady) {
    worldReady = (async () => {
      await locate($)
      if (root) await locateWorld($)
    })().catch(() => {})
  }
  return worldReady
}

async function locateWorld($: any) {
  if (!realRoot) {
    try {
      realRoot = String((await $.fs.stat(root as string, { resolve: true })).realPath ?? '').replace(/\/+$/, '')
    } catch {}
    if (!realRoot) return
    // A volume that ignores case answers the project folder spelled in another case with the folder itself (C12: on
    // APFS the real path has the disk's case; on ext4 the other spelling isn't there)
    const probe = caseProbe(realRoot)
    if (probe) {
      try {
        insensitive = (await $.fs.stat(probe, { resolve: true })).realPath === realRoot
      } catch {
        insensitive = false
      }
    }
  }
  await loadWorld($)
}

// world.json, read again when its modification time moves
async function loadWorld($: any) {
  const path = `${fleetDir()}/world.json`
  let st: any
  try {
    st = await $.fs.stat(path)
  } catch {
    world = null
    worldProblem = ''
    return
  }
  if (world && st.mtimeMs === world.mtimeMs) return
  const t = await readText($, path)
  const p = t === null ? { problem: "world.json can't be read" } : parseWorld(t)
  const before = world?.globs.join('\n')
  if ('problem' in p) {
    if (worldProblem !== p.problem) log($, p.problem)
    world = null
    worldProblem = p.problem
    return
  }
  worldProblem = ''
  world = { globs: p.world.paths, res: p.world.paths.map(g => globRegex(g, insensitive)), mtimeMs: st.mtimeMs }
  const r = recordsOf(p.world, insensitive)
  const idBefore = records?.id.source
  records = 'records' in r ? r.records : null
  if ('problem' in r && recordsProblem !== r.problem) log($, r.problem)
  recordsProblem = 'problem' in r ? r.problem : ''
  if (before !== world.globs.join('\n')) {
    // Other globs: what's in the world now is the new baseline, not a change
    known.clear()
    unexplained.clear()
    baselined = false
    tooBig = false
    log($, `world: ${world.globs.join(', ') || 'no globs'}`)
  }
  if (idBefore !== records?.id.source) {
    // Other ids: the pins of the files are read again at the next scan
    indexIds()
    if (baselined) baselined = false
  }
}

// Where a path lands: an existing one at its real path, a new one at its nearest existing folder's real path plus the
// rest (C12: a missing file or folder can't be stat'ed). null: it can't be placed, and fleet lets it be
async function place($: any, path: string): Promise<string | null> {
  if (!placeable(path)) return null
  try {
    const s = await $.fs.stat(path, { resolve: true })
    if (s.realPath) return String(s.realPath)
  } catch {}
  for (const { dir, rest } of ancestorsOf(path)) {
    let s: any
    try {
      s = await $.fs.stat(dir, { resolve: true })
    } catch {
      continue
    }
    return s.realPath ? `${String(s.realPath).replace(/\/+$/, '')}/${rest}` : null
  }
  return null
}

/** A world file a tool names: its path relative to the project, and where it is; copy: the linked worktree it's a copy
 * in (the shared one is the main checkout's, at <realRoot>/<rel>). Null for anything else */
type Placed = { rel: string; abs: string; copy?: string }
async function worldFile($: any, path: unknown): Promise<Placed | null> {
  if (typeof path !== 'string' || !path) return null
  await ensureWorld($)
  if (!worldOn()) return null
  const given = path.startsWith('/') ? path : `${String(await $.session.cwd()).replace(/\/+$/, '')}/${path}`
  const abs = await place($, given)
  if (!abs) return null
  const res = (world as { res: RegExp[] }).res
  if (abs.includes('/.claude/worktrees/')) await refreshTrees($, true)
  const c = copyOf(abs, trees.linked, trees.sub, insensitive)
  if (c) return c.rel && inWorld(c.rel, res) ? { rel: c.rel, abs, copy: c.tree } : null
  const rel = relOf(abs, realRoot, insensitive)
  return rel !== null && inWorld(rel, res) ? { rel, abs } : null
}

/** A file's version: the hash of its text, or its size and time past 4 MiB; null when it isn't there. With the text
 * (null past 4 MiB), which the pins are read from */
async function versionOf($: any, abs: string): Promise<{ v: string | null; mtimeMs: number; size: number; text: string | null }> {
  let st: any
  try {
    st = await $.fs.stat(abs)
  } catch {
    return { v: null, mtimeMs: 0, size: 0, text: null }
  }
  if (st.kind !== 'file') return { v: null, mtimeMs: 0, size: 0, text: null }
  const size = Number(st.size)
  const mtimeMs = Number(st.mtimeMs)
  if (size > MiB4) return { v: statVersion(size, mtimeMs), mtimeMs, size, text: null }
  const t = await readText($, abs)
  return { v: t === null ? statVersion(size, mtimeMs) : hashText(t), mtimeMs, size, text: t }
}

// ---- Git: the repository the project is in, its linked worktrees ----

/** The repository a folder is in: its working tree's top, its git folder, and the folder shared by every worktree
 * (the main checkout's .git). Null outside git */
async function gitOf($: any, dir: string): Promise<{ top: string; gitDir: string; common: string } | null> {
  const r = await run($, ['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])
  if (r.exitCode !== 0) return null
  const [top, gitDir, common] = r.stdout.trim().split('\n')
  return top && gitDir && common ? { top, gitDir, common } : null
}

/** The same folder in the main checkout, when dir is in a linked worktree of a repository; null otherwise */
async function mainCheckoutOf($: any, dir: string): Promise<string | null> {
  const g = await gitOf($, dir)
  if (!g || g.gitDir === g.common || !g.common.endsWith('/.git')) return null
  let real = dir
  try {
    real = String((await $.fs.stat(dir, { resolve: true })).realPath ?? dir).replace(/\/+$/, '')
  } catch {}
  if (real !== g.top && !real.startsWith(`${g.top}/`)) return null
  return `${g.common.slice(0, -'/.git'.length)}${real.slice(g.top.length)}`
}

// The linked worktrees, every minute (every 10 minutes outside git), and at once when a path names one fleet doesn't
// know yet (at most every 5 s)
async function refreshTrees($: any, force = false) {
  const now = await $.clock.now()
  if (force ? now - trees.forced < 5000 : now - trees.at < (trees.git ? 60000 : 600000)) return
  trees.at = now
  if (force) trees.forced = now
  const g = await gitOf($, realRoot)
  if (!g) {
    trees.git = false
    trees.linked = []
    return
  }
  trees.git = true
  const main = g.common.endsWith('/.git') ? g.common.slice(0, -'/.git'.length) : g.top
  trees.sub = realRoot.startsWith(`${main}/`) ? realRoot.slice(main.length + 1) : ''
  const l = await run($, ['git', '-C', realRoot, 'worktree', 'list', '--porcelain'])
  const linked: string[] = []
  for (const f of l.exitCode === 0 ? worktreeFolders(l.stdout).slice(1) : []) {
    try {
      linked.push(String((await $.fs.stat(f, { resolve: true })).realPath ?? f).replace(/\/+$/, ''))
    } catch {}
  }
  trees.linked = linked
}

async function meNow($: any): Promise<Me> {
  const now = await $.clock.now()
  return { sessionId: String(await $.session.id()), offsetMin: -new Date(now).getTimezoneOffset() }
}

async function whoAmI($: any, thread: string): Promise<Who> {
  // The name comes from sessions once it has read the list: early in a session, ask again
  if (!myName) await refreshName($)
  return { sessionId: String(await $.session.id()), agentId: thread === 'main' ? null : thread, ref: myRef ?? jobRef, name: myName }
}

function threadOf(e: any): string {
  return typeof e.agentId === 'string' && e.agentId ? e.agentId : 'main'
}

async function refreshName($: any) {
  if (!(await has($, 'current'))) return
  const c = await race<Current>($, () => $.sessions.current())
  if (c?.ready) {
    myName = c.name || null
    myRef = c.ref
  }
}

// ---- Events ----

// The event files of the trailing window not seen yet (the current hour and the one before; 25 hours at the start)
function pullEvents($: any, hours = 2): Promise<void> {
  // One at a time; a call that comes while one runs gets one more after it (its trigger may name a file the running
  // one listed too early to see)
  if (pulling) {
    pullAgain = true
    return pulling
  }
  pulling = (async () => {
    const now = await $.clock.now()
    for (const folder of windowFolders(now, hours)) {
      const dir = eventsDir(folder)
      for (const name of await names($, dir)) {
        if (!name.endsWith('.json') || seen.has(name)) continue
        const t = await readText($, `${dir}/${name}`)
        if (t === null) continue
        let v: any
        try {
          v = JSON.parse(t)
        } catch {
          continue
        }
        seen.set(name, now)
        if (!isEvent(v)) {
          if (v && v.format !== FORMAT) otherEvents++
          continue
        }
        if (newer(latest.get(v.path), v)) {
          latest.set(v.path, v)
          // What this session knows of the file follows the landing at once (its scan settles the rest), so the suspects
          // reckoned next see it
          const k = known.get(v.path)
          if (k && v.to !== null && k.v !== v.to) known.set(v.path, { ...k, v: v.to, pins: v.pins ?? (v.id ? [] : k.pins) })
        }
        remember(v)
        sweep.dirty = true
        if (v.id) forget(v.id)
      }
    }
    for (const [name, at] of seen) if (now - at > 3 * HOUR) seen.delete(name)
  })()
    .catch(() => {})
    .finally(() => {
      pulling = null
      if (pullAgain) {
        pullAgain = false
        bg(pullEvents($))
      }
    })
  return pulling
}

function remember(e: ChangeEvent) {
  recent.push(e)
  recent.sort((a, b) => a.at - b.at)
  if (recent.length > 50) recent.splice(0, recent.length - 50)
}

// events/latest moved (another session landed something): read the new events. Every 2 s, at each tool step, and on
// the engine's FileChanged for it
async function eventsTick($: any) {
  if (!worldOn()) return
  let m = 0
  try {
    m = Number((await $.fs.stat(`${eventsDir()}/latest`)).mtimeMs)
  } catch {
    return
  }
  if (m === latestMark) return
  latestMark = m
  await pullEvents($)
}

// One landing: published once under a name of its own in the current hour's folder, then events/latest rewritten so
// every session's watcher fires
async function writeEvent($: any, ev: Omit<ChangeEvent, 'format' | 'at'> & { at?: number }): Promise<ChangeEvent | null> {
  const sid8 = String(await $.session.id()).slice(0, 8)
  for (let tries = 0; tries < 5; tries++) {
    const now = await $.clock.now()
    const e: ChangeEvent = { format: FORMAT, ...ev, at: ev.at ?? now }
    const name = eventName(now, sid8, ++eventCount)
    const r = await publish($, `${eventsDir(hourFolder(now))}/${name}`, json(e))
    if (r === 'exists') continue
    if (r === 'failed') {
      log($, `couldn't write the event of ${e.path}`)
      return null
    }
    seen.set(name, now)
    if (newer(latest.get(e.path), e)) latest.set(e.path, e)
    remember(e)
    try {
      await $.fs.write(`${eventsDir()}/latest`, json({ format: FORMAT, last: name }))
    } catch {}
    log($, `${e.path}: ${e.via}${e.tool ? ` (${e.tool})` : ''}${e.blind ? ', landed blind' : ''}${e.overwrote ? ', over a change' : ''}`)
    return e
  }
  return null
}

// ---- What each thread read ----

async function setRead($: any, thread: string, rel: string, v: string | null, rev?: number) {
  const now = await $.clock.now()
  await update($, reads, m => {
    const mine = { ...(m[thread] ?? {}) }
    if (v === null) delete mine[rel]
    else mine[rel] = { v, at: now, told: v, ...(rev ? { rev } : {}) }
    return { ...m, [thread]: mine }
  })
  await update($, warned, m => (m[thread]?.[rel] === undefined ? m : { ...m, [thread]: omit(m[thread] as Record<string, string>, [rel]) }))
  saveReadsSoon($)
}

// A read of a world file: this thread read that version. A record's read says which version it is, so the model can
// cite it. A worktree's copy counts as a read of the shared file when it's the same; when it differs, the model hears
// so once
async function noteRead($: any, thread: string, path: unknown): Promise<string[]> {
  const w = await worldFile($, path)
  if (!w) return []
  const main = `${realRoot}/${w.rel}`
  const f = await versionOf($, main)
  if (w.copy) {
    const c = await versionOf($, w.abs)
    if (c.v === null) return []
    if (c.v !== f.v) {
      const key = `copy-read:${w.rel}`
      if ((await read($, warned))[thread]?.[key] === c.v) return []
      await update($, warned, m => ({ ...m, [thread]: { ...(m[thread] ?? {}), [key]: c.v as string } }))
      return [copyReadText(String(path), w.rel, main)]
    }
  }
  if (f.v === null) return []
  const id = records ? idOf(w.rel, records) : null
  let rev: number | undefined
  if (id) {
    const revs = await revsFor($, id, { rel: w.rel, v: f.v, text: f.text })
    const last = revs[revs.length - 1]
    if (last && last.hash === f.v) rev = last.rev
  }
  await setRead($, thread, w.rel, f.v, rev)
  return id && rev ? [citeText(id, rev)] : []
}

// reads/<sessionId>.json, a second after a change (for /fleet status in other sessions, and after a restart)
function saveReadsSoon($: any) {
  if (readsTimer) return
  readsTimer = true
  $.clock.after(1000, () =>
    bg(
      (async () => {
        readsTimer = false
        await saveReads($)
      })(),
    ),
  )
}

async function saveReads($: any) {
  if (!worldOn()) return
  const sessionId = String(await $.session.id())
  const file: ReadsFile = { format: FORMAT, sessionId, ref: myRef ?? jobRef, name: myName, at: await $.clock.now(), threads: await read($, reads) }
  if (!(await replace($, readsPath(sessionId), json(file)))) {
    await run($, ['mkdir', '-p', `${fleetDir()}/reads`])
    await replace($, readsPath(sessionId), json(file))
  }
}

// A helper that finished takes its reads with it; a /clear starts a conversation that read nothing
async function dropThread($: any, thread: string) {
  await update($, reads, m => (m[thread] ? omit(m, [thread]) : m))
  await update($, warned, m => (m[thread] ? omit(m, [thread]) : m))
  saveReadsSoon($)
}

async function clearReads($: any, oldSessionId: string) {
  await update($, reads, () => ({}))
  await update($, warned, () => ({}))
  // The new conversation doesn't remember what it was told about the files it wrote: it hears it again
  await update($, ownTold, () => ({}))
  if (root && oldSessionId) await remove($, [readsPath(oldSessionId)])
}

// ---- The digest: at a thread's next step (a tool result's context, C2) or with the next prompt ----

/** The digest lines for one thread, and what marks them told (called once they're on their way): the world files it
 * read that changed since, and for the main thread the files this session wrote last that are flagged */
async function digestFor($: any, thread: string): Promise<{ lines: string[]; told: () => Promise<void> }> {
  const none = { lines: [], told: async () => {} }
  if (!worldOn()) return none
  await eventsTick($)
  const mine = (await read($, reads))[thread]
  const me = await meNow($)
  const items = mine && latest.size ? digestItems(mine, latest, me) : []
  let own: { lines: string[]; keys: string[] } = { lines: [], keys: [] }
  if (thread === 'main') {
    await loadFlags($)
    own = await ownLines($)
  }
  if (!items.length && !own.lines.length) return none
  return {
    lines: [...(items.length ? [digestText(items, me)] : []), ...own.lines],
    told: async () => {
      if (items.length) {
        await update($, reads, m => {
          const t = { ...(m[thread] ?? {}) }
          for (const i of items) if (t[i.path] && i.event.to !== null) t[i.path] = { ...(t[i.path] as FleetRead), told: i.event.to }
          return { ...m, [thread]: t }
        })
        log($, `digest to ${thread}: ${items.map(i => i.path).join(', ')}`)
        saveReadsSoon($)
      }
      if (own.keys.length) {
        const at = me.sessionId ? await $.clock.now() : 0
        await update($, ownTold, m => {
          const kept = Object.fromEntries(Object.entries(m).filter(([, t]) => at - t < 24 * HOUR))
          return { ...kept, ...Object.fromEntries(own.keys.map(k => [k, at])) }
        })
        log($, `flags to ${thread}: ${own.keys.map(k => k.split('|')[1]).join(', ')}`)
      }
    },
  }
}

/** A tool's result with the digest (and any other lines) for the model, when it can carry them */
async function withLines($: any, r: any, thread: string, extra: string[] = []): Promise<any> {
  if (!r || r.deny !== undefined || r.isError) return r
  const d = await digestFor($, thread)
  const lines = [...extra, ...d.lines]
  if (!lines.length) return r
  await d.told()
  return { ...r, context: [...(r.context ?? []), ...lines] }
}

// ---- Records: versions, pins (records.ts) ----

function sortedRevs(c: { revs: Map<number, Rev> }): Rev[] {
  return [...c.revs.values()].sort((a, b) => a.rev - b.rev)
}

/** A record's versions, oldest first: state/revs/<id>/, listed again when the folder's time moved (looked at once a
 * second at most) */
async function revsOf($: any, id: string): Promise<Rev[]> {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.')) return []
  const now = await $.clock.now()
  let c = revCache.get(id)
  if (c && now - c.at < 1000) return sortedRevs(c)
  let m = -1
  try {
    m = Number((await $.fs.stat(revDir(id))).mtimeMs)
  } catch {}
  if (!c) {
    c = { revs: new Map(), mtime: -2, at: 0 }
    revCache.set(id, c)
  }
  c.at = now
  if (m !== c.mtime) {
    c.mtime = m
    if (m === -1) c.revs.clear()
    for (const n of m === -1 ? [] : await names($, revDir(id))) {
      const k = Number(n.replace(/\.json$/, ''))
      if (!/^\d+\.json$/.test(n) || c.revs.has(k)) continue
      const r = parseRev((await readText($, `${revDir(id)}/${n}`)) ?? '')
      if (r) c.revs.set(k, r)
    }
  }
  return sortedRevs(c)
}

function forget(id: string) {
  const c = revCache.get(id)
  if (c) c.at = 0
}

/** A record fleet never saw a version of gets its first, the one there now (no landing: its owner is nobody) */
async function ensureBase($: any, id: string, rel: string, v: string, pins: string[], changeHash: string | null) {
  if ((await revsOf($, id)).length) return
  const entry: Rev = { format: FORMAT, id, path: rel, rev: 1, hash: v, kind: 'addition', changeHash, at: await $.clock.now(), by: null, via: 'base', pins }
  await publish($, `${revDir(id)}/1.json`, json(entry))
  forget(id)
}

/** A record's versions, its first allocated when it has none (from what's there now, or what the caller read) */
async function revsFor($: any, id: string, have?: { rel: string; v: string | null; text: string | null }): Promise<Rev[]> {
  const revs = await revsOf($, id)
  if (revs.length || !records) return revs
  const rel = have?.rel ?? idIndex.get(id)
  if (!rel) return revs
  const f = have ?? (await versionOf($, `${realRoot}/${rel}`))
  if (f.v === null) return revs
  await ensureBase($, id, rel, f.v, pinsFrom(f.text), f.text === null ? null : (changeOf(f.text, records.changeKey)?.hash ?? null))
  return revsOf($, id)
}

/** A landing of a world file: a record gets its next version (no-clobber: on a name taken, the one after), with the
 * kind its change line names; the event carries it, and the pins the file cites now */
async function landRecord($: any, rel: string, after: { v: string | null; text: string | null }, via: ChangeEvent['via'], by: Who | null, marks: { suspect?: string[]; confirmed?: string[] } = {}): Promise<Partial<ChangeEvent>> {
  const pins = pinsFrom(after.text)
  const suspect = marks.suspect ?? []
  const confirmed = marks.confirmed ?? []
  const extra: Partial<ChangeEvent> = { ...(pins.length ? { pins } : {}), ...(suspect.length ? { suspect } : {}), ...(confirmed.length ? { confirmed } : {}) }
  const id = records ? idOf(rel, records) : null
  if (!records || !id) return extra
  const revs = await revsOf($, id)
  const prev = revs[revs.length - 1] ?? null
  if (prev && prev.hash === after.v) return { id, rev: prev.rev, ...extra }
  const change = after.text === null ? null : changeOf(after.text, records.changeKey)
  const kind = landingKind(change, prev, after.v === null)
  const at = await $.clock.now()
  for (let n = (prev?.rev ?? 0) + 1, tries = 0; tries < 20; tries++, n++) {
    const entry: Rev = { format: FORMAT, id, path: rel, rev: n, hash: after.v, kind, changeHash: change?.hash ?? null, at, by, via, pins, ...(suspect.length ? { suspect } : {}), ...(confirmed.length ? { confirmed } : {}) }
    const r = await publish($, `${revDir(id)}/${n}.json`, json(entry))
    if (r === 'ok') {
      forget(id)
      sweep.dirty = true
      return { id, rev: n, kind, ...extra }
    }
    if (r === 'failed') break
  }
  log($, `${rel}: couldn't give ${id} a version (${revDir(id)})`)
  return { id, ...extra }
}

type PinCheck = { problems: ReturnType<typeof pinProblems>; keys: string[]; states: PinState[]; confirmed: string[] }

/** The pins of a text a thread is about to land, against the pins the file cited before: the problems to tell
 * (records.ts pinProblems), and every pin's state */
async function checkPins($: any, thread: string, text: string, before: ReadonlySet<string>): Promise<PinCheck | null> {
  if (!records) return null
  const pins = pinsOf(text, records)
  if (!pins.length) return null
  const states = new Map<string, PinState>()
  for (const p of pins) states.set(pinKey(p), pinState(p, await revsFor($, p.id)))
  const mine = (await read($, reads))[thread] ?? {}
  const readStates = new Map<string, ReadState>()
  for (const p of pins) {
    if (readStates.has(p.id)) continue
    const rel = idIndex.get(p.id)
    const r = rel ? mine[rel] : undefined
    if (!rel || !r) {
      readStates.set(p.id, 'never')
      continue
    }
    // The version there now, read only for a pin that needs it
    const st = states.get(pinKey(p)) as PinState
    const now = st.state === 'stale' || st.state === 'ahead' ? (await versionOf($, `${realRoot}/${rel}`)).v : r.v
    readStates.set(p.id, r.v === now ? 'current' : 'older')
  }
  const readOf = (id: string): ReadState => readStates.get(id) ?? 'never'
  const problems = pinProblems(pins, before, p => states.get(pinKey(p)) as PinState, readOf, id => idIndex.get(id) ?? null)
  return { problems, keys: problemKeys(problems), states: [...states.values()], confirmed: confirmedPins([...states.values()], readOf) }
}

/** What a Write or Edit leaves in the file (null: it can't be told, or the edit won't apply) */
function resultOf(e: any, current: string | null): string | null {
  if (e.tool === 'Write') return typeof e.content === 'string' ? e.content : null
  if (e.tool !== 'Edit' || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null
  if (current === null || !e.old_string || !current.includes(e.old_string)) return null
  return e.replace_all ? current.split(e.old_string).join(e.new_string) : current.replace(e.old_string, () => e.new_string)
}

// ---- The gate: a Write, Edit or NotebookEdit of a world file this thread didn't read as it is now, or whose pins it
// didn't read as they are ----

async function gate($: any, e: any, next: any) {
  const w = await worldFile($, e.file_path ?? e.notebook_path)
  if (!w) return next(e)
  const thread = threadOf(e)
  if (w.copy) return copyGate($, e, next, w, thread)
  const cur = await versionOf($, w.abs)
  const mine = (await read($, reads))[thread]?.[w.rel]
  const told = (await read($, warned))[thread] ?? {}
  // Under strict, nothing passes on a second try: only a read clears it
  const strict = isStrict(records, w.rel)
  const v = verdict(mine, cur.v, strict ? undefined : told[w.rel])
  // The pins of what the write leaves: a stale one, or a new one of a record this thread never read, is told once
  const text = resultOf(e, cur.text)
  const pins = text === null ? null : await checkPins($, thread, text, new Set(pinsFrom(cur.text)))
  const said = new Set((told[`pins:${w.rel}`] ?? '').split('\n').filter(Boolean))
  const fresh = pins ? pins.keys.filter(k => strict || !said.has(k)) : []
  if (v !== 'pass' || fresh.length) {
    const me = await meNow($)
    const texts: string[] = []
    if (v !== 'pass') {
      await pullEvents($)
      const last = latest.get(w.rel)
      await update($, warned, m => ({ ...m, [thread]: { ...(m[thread] ?? {}), [w.rel]: cur.v as string } }))
      if (mine && cur.v) await update($, reads, m => ({ ...m, [thread]: { ...(m[thread] ?? {}), [w.rel]: { ...mine, told: cur.v as string } } }))
      texts.push(gateText(v, w.rel, last && last.to === cur.v ? last : null, cur.mtimeMs, me))
    }
    if (fresh.length && pins) {
      await update($, warned, m => ({ ...m, [thread]: { ...(m[thread] ?? {}), [`pins:${w.rel}`]: [...new Set([...said, ...pins.keys])].join('\n') } }))
      texts.push(pinsText(pins.problems, me, offered && thread === 'main'))
    }
    const why = [v !== 'pass' ? v : '', fresh.length && pins ? `pins ${pins.problems.map(p => `${pinKey(p.pin)} ${p.why}`).join(', ')}` : ''].filter(Boolean).join('; ')
    log($, `refused once: ${e.tool} of ${w.rel} by ${thread} (${why})${strict ? ', strict' : ''}`)
    return { deny: texts.join('\n\n') }
  }
  // A record fleet never saw a version of: the one there now is its first
  const id = records ? idOf(w.rel, records) : null
  if (id && cur.v !== null) await revsFor($, id, { rel: w.rel, v: cur.v, text: cur.text })
  const r = await next(e)
  if (!r || r.deny !== undefined || r.isError) return r
  const extra: string[] = []
  try {
    const after = await versionOf($, w.abs)
    // The race: what the tool replaced, against the version validated here (another landing came in meanwhile)
    const original = r.result?.originalFile ?? r.result?.original_file
    const replaced = typeof original === 'string' ? hashText(original) : null
    const raced = replaced !== null && cur.v !== null && cur.v.startsWith('h') && replaced !== cur.v
    await pullEvents($)
    const before = latest.get(w.rel)
    const by = await whoAmI($, thread)
    const fields = await landRecord($, w.rel, after, 'tool', by, { confirmed: pins?.confirmed ?? [] })
    await writeEvent($, { path: w.rel, from: replaced ?? cur.v, to: after.v, via: 'tool', tool: String(e.tool), blind: false, by, ...(raced ? { overwrote: true } : {}), ...fields })
    setKnown(w.rel, { mtimeMs: after.mtimeMs, size: after.size, v: after.v, pins: fields.pins ?? [] })
    unexplained.delete(w.rel)
    await setRead($, thread, w.rel, after.v, fields.rev)
    if (raced && before && before.to === replaced && before.by?.sessionId !== String(await $.session.id())) {
      extra.push(overwroteText(w.rel, before, await meNow($), e.tool === 'Write' ? 'write' : 'edit'))
    }
    const states = pins?.states ?? []
    const landed = landedText(w.rel, fields.id ?? null, fields.rev ?? null, states.filter(s => s.state === 'unknown').map(s => s.pin), states.filter(s => s.state === 'ahead'))
    if (landed) extra.push(landed)
    scheduleChecks($, [w.rel])
  } catch (err) {
    log($, `after ${e.tool} of ${w.rel}: ${String(err).slice(0, 200)}`)
  }
  return withLines($, r, thread, extra)
}

// A write of a worktree's copy of a shared file: told once that the shared one is the main checkout's (a session
// isolated in its worktree can't write that one: it keeps its change in the worktree, or reports it). Nothing lands
async function copyGate($: any, e: any, next: any, w: Placed, thread: string) {
  const key = `copy:${w.rel}`
  const cur = await versionOf($, w.abs)
  const now = cur.v ?? 'new'
  if ((await read($, warned))[thread]?.[key] !== now) {
    await update($, warned, m => ({ ...m, [thread]: { ...(m[thread] ?? {}), [key]: now } }))
    log($, `refused once: ${e.tool} of a worktree copy of ${w.rel} by ${thread} (${w.copy})`)
    return { deny: copyWriteText(String(e.file_path ?? e.notebook_path), w.rel, `${realRoot}/${w.rel}`) }
  }
  const r = await next(e)
  if (r && r.deny === undefined && !r.isError) log($, `${w.rel}: written in the worktree ${w.copy} only`)
  return r
}

// ---- Bash: what it read, and what it wrote that the gate didn't see (found by comparing the world before and after) ----

// The world's files with their size and time: the folders the globs start from, walked down (not into .git, nor
// fleet's own folder); undefined past MAX_WORLD_FILES
async function snapshot($: any): Promise<Snapshot | undefined> {
  if (!world) return new Map()
  const res = world.res
  const bases = [...new Set(world.globs.map(globBase))]
  const deep = world.globs.some(g => globBase(g) === '' && g.includes('/'))
  const out: Snapshot = new Map()
  let count = 0
  // Never into a linked worktree: what's there is a copy, not the world
  const inside = trees.linked.map(t => relOf(t, realRoot, insensitive)).filter((x): x is string => x !== null)
  const descend = (p: string) => {
    if (p === '.git' || p === '.claude/fleet' || p.endsWith('/.git') || p.endsWith('/node_modules') || p === 'node_modules') return false
    if (p === '.claude/worktrees' || inside.includes(p)) return false
    return deep || bases.some(b => b !== '' && (p === b || p.startsWith(`${b}/`) || b.startsWith(`${p}/`)))
  }
  const walk = async (rel: string, depth: number): Promise<boolean> => {
    if (depth > 16) return true
    let entries: any[] = []
    try {
      entries = await $.fs.list(rel ? `${realRoot}/${rel}` : realRoot)
    } catch {
      return true
    }
    for (const x of entries) {
      const p = rel ? `${rel}/${x.name}` : String(x.name)
      if (x.kind === 'dir') {
        if (descend(p) && !(await walk(p, depth + 1))) return false
      } else if (x.kind === 'file' && inWorld(p, res)) {
        out.set(p, { mtimeMs: Number(x.mtimeMs), size: Number(x.size) })
        if (++count > MAX_WORLD_FILES) return false
      }
    }
    return true
  }
  if (!(await walk('', 0))) {
    if (!tooBig) log($, `the world has more than ${MAX_WORLD_FILES} files: no scan after each command (world.json can narrow it)`)
    tooBig = true
    return undefined
  }
  return out
}

function knownSnapshot(): Snapshot {
  return new Map([...known].map(([p, k]) => [p, { mtimeMs: k.mtimeMs, size: k.size }]))
}

// After a Bash command: every world file it changed is a landing of this thread, marked blind (it didn't go through
// the gate: decision 3c flags it, never blocks). One whose newest change was someone else's after this thread read it
// gets a line for the model; so does one whose pins this thread hadn't read as they are, and it's marked suspect
async function afterBash($: any, thread: string, before: Snapshot, startedAt: number): Promise<string[]> {
  const after = await snapshot($)
  if (!after) return []
  const changed = changedPaths(before, after)
  if (!changed.length) return []
  await pullEvents($)
  const sessionId = String(await $.session.id())
  const out: string[] = []
  const landed: string[] = []
  for (const rel of changed) {
    const s = after.get(rel)
    const f = s ? await versionOf($, `${realRoot}/${rel}`) : { v: null, text: null }
    const v = f.v
    const last = latest.get(rel)
    const k = known.get(rel)
    const settle = () => {
      if (s) setKnown(rel, { ...s, v, pins: pinsFrom(f.text) })
      else dropKnown(rel)
      unexplained.delete(rel)
    }
    // Someone's landing during the command, or only its time moved
    if ((last && last.to === v && last.at >= startedAt - 1000) || (k && k.v === v && v !== null)) {
      settle()
      continue
    }
    const mine = (await read($, reads))[thread]?.[rel]
    // The pins of what the command left, as the gate would have checked them (it isn't held: it's marked)
    const pc = f.text === null ? null : await checkPins($, thread, f.text, new Set(k?.pins ?? []))
    const suspect = pc ? pc.problems.map(p => `${pinKey(p.pin)}:${p.why}`) : []
    const id = records ? idOf(rel, records) : null
    if (id && k?.v) await ensureBase($, id, rel, k.v, k.pins ?? [], null)
    const by = await whoAmI($, thread)
    const fields = await landRecord($, rel, f, 'bash', by, { suspect, confirmed: pc?.confirmed ?? [] })
    await writeEvent($, { path: rel, from: last && last.to !== v ? last.to : (k?.v ?? null), to: v, via: 'bash', tool: 'Bash', blind: true, by, ...fields })
    settle()
    await setRead($, thread, rel, v, fields.rev)
    if (last && last.by?.sessionId !== sessionId && last.to !== mine?.v) out.push(overwroteText(rel, last, await meNow($), 'command'))
    if (pc?.problems.length) {
      out.push(blindText(rel, pc.problems, await meNow($)))
      log($, `${rel}: landed blind citing ${suspect.join(', ')}: suspect`)
    }
    if (v !== null) landed.push(rel)
  }
  scheduleChecks($, landed)
  return out
}

async function bashHook($: any, e: any, next: any) {
  await ensureWorld($)
  if (!worldOn()) return next(e)
  const thread = threadOf(e)
  let before: Snapshot | undefined
  if (!tooBig) {
    try {
      before = await snapshot($)
    } catch {}
  }
  const startedAt = await $.clock.now()
  bashRunning++
  let r: any
  try {
    r = await next(e)
  } finally {
    bashRunning--
  }
  const extra: string[] = []
  try {
    if (before) extra.push(...(await afterBash($, thread, before, startedAt)))
    const target = bashReadTarget(String(e.command ?? ''))
    if (target && r && !r.isError && r.deny === undefined) extra.push(...(await noteRead($, thread, target)))
  } catch (err) {
    log($, `after a Bash command: ${String(err).slice(0, 200)}`)
  }
  return withLines($, r, thread, extra)
}

// ---- Outside changes: every 10 s, the world against what this session last saw ----

// A change nobody's event explains, still so a scan later, is recorded as outside fleet (an editor, a script, a session
// without fleet), claimed no-clobber so that one session of the project records it
async function scanWorld($: any) {
  if (!worldOn() || bashRunning > 0) return
  const snap = await snapshot($)
  if (!snap) return
  const now = await $.clock.now()
  if (!baselined) {
    known.clear()
    for (const [rel, s] of snap) {
      const f = await versionOf($, `${realRoot}/${rel}`)
      known.set(rel, { ...s, v: f.v, pins: pinsFrom(f.text) })
    }
    indexIds()
    baselined = true
    sweep.dirty = true
    return
  }
  const changed = changedPaths(knownSnapshot(), snap)
  if (!changed.length) return
  await pullEvents($)
  for (const rel of changed) {
    const s = snap.get(rel)
    const f = s ? await versionOf($, `${realRoot}/${rel}`) : { v: null, text: null }
    const v = f.v
    const k = known.get(rel)
    const last = latest.get(rel)
    const settle = () => {
      if (s) setKnown(rel, { ...s, v, pins: pinsFrom(f.text) })
      else dropKnown(rel)
      unexplained.delete(rel)
    }
    if ((k && k.v === v) || (last && last.to === v)) {
      settle()
      continue
    }
    const u = unexplained.get(rel)
    if (!u || u.v !== v) {
      unexplained.set(rel, { v, since: now })
      continue
    }
    if (now - u.since < 4000) continue
    const at = Math.floor(s?.mtimeMs ?? now)
    const claim = `${eventsDir('claims')}/${hashText(`${rel}\n${v ?? 'removed'}\n${Math.floor(s?.mtimeMs ?? k?.mtimeMs ?? 0)}`).slice(1)}`
    if ((await publish($, claim, json({ format: FORMAT, path: rel, at: now }))) === 'ok') {
      const id = records ? idOf(rel, records) : null
      if (id && k?.v) await ensureBase($, id, rel, k.v, k.pins ?? [], null)
      const fields = await landRecord($, rel, f, 'outside', null)
      await writeEvent($, { at: s ? at : now, path: rel, from: last && last.to !== v ? last.to : (k?.v ?? null), to: v, via: 'outside', blind: true, by: null, ...fields })
    }
    settle()
  }
}

// At the start, from the timers: the world, this session's reads after a restart, the events of the last day
async function startWorld($: any) {
  await ensureWorld($)
  if (!world || worldStarted) return
  worldStarted = true
  await run($, ['mkdir', '-p', eventsDir(), `${fleetDir()}/reads`])
  if (!(await exists($, `${eventsDir()}/latest`))) {
    try {
      await $.fs.write(`${eventsDir()}/latest`, json({ format: FORMAT, last: '' }))
    } catch {}
  }
  if (!Object.keys(await read($, reads)).length) {
    const t = await readText($, readsPath(String(await $.session.id())))
    const p = t === null ? null : parseReads(t)
    if (p && 'threads' in p && p.threads.main) await update($, reads, () => ({ main: p.threads.main as Record<string, FleetRead> }))
  }
  await refreshName($)
  await pullEvents($, 25)
  // fleet's own state (versions, suspects, check results, the sweeper's lease) stays out of git whatever .gitignore says
  await run($, ['mkdir', '-p', stateDir('revs'), stateDir('checks')])
  if (!(await exists($, stateDir('.gitignore')))) {
    try {
      await $.fs.write(stateDir('.gitignore'), '# fleet’s own state: versions, suspects, check results, the sweeper\n*\n')
    } catch {}
  }
  await refreshTrees($)
  await lease($)
}

async function worldTick($: any) {
  if (!root) return
  if (!realRoot) {
    // Set up after this session started (/fleet init here or in another session)
    worldReady = null
    await ensureWorld($)
    if (!realRoot) return
  }
  await loadWorld($)
  if (world && !worldStarted) await startWorld($)
  await eventsTick($)
  if (!worldOn()) return
  await lease($)
  await sweepTick($)
  await loadFlags($)
  await refreshTrees($)
}

// ---- The sweeper: one session of the project, elected by a lease, every 60 s (and soon after each landing) ----

const sweep = { holding: false, takenAt: 0, leaseAt: 0, lastSweep: 0, running: false, dirty: false, lastRun: {} as Record<string, number>, commitNote: '', suspectsKey: '' }

// The lease, <project>/.claude/fleet/state/sweeper.json: whoever holds it rewrites it every 20 s; one older than 90 s
// (or none) is taken by writing it, and the taker sweeps once it still finds itself there 2 s later (two that took it
// at once: the last write wins, and the other backs off). Replaced with mv, no lock: a minute of two sweepers is harmless
async function lease($: any) {
  const now = await $.clock.now()
  const due = sweep.holding ? 20000 : sweep.takenAt ? 2000 : 10000
  if (now - sweep.leaseAt < due) return
  sweep.leaseAt = now
  const sessionId = String(await $.session.id())
  const st = leaseState(parseLease(await readText($, stateDir('sweeper.json'))), sessionId, now)
  if (st === 'held') {
    if (sweep.holding) log($, 'sweeper: another session took it')
    sweep.holding = false
    sweep.takenAt = 0
    return
  }
  if (st === 'mine' && !sweep.holding && (!sweep.takenAt || now - sweep.takenAt >= 2000)) {
    sweep.holding = true
    sweep.takenAt = 0
    sweep.dirty = true
    log($, 'sweeper: this session')
  } else if (st === 'free') sweep.takenAt = now
  if (!(await replace($, stateDir('sweeper.json'), json({ format: FORMAT, sessionId, ref: myRef ?? jobRef, name: myName, at: now })))) {
    await run($, ['mkdir', '-p', stateDir()])
  }
}

async function releaseLease($: any) {
  if (!sweep.holding || !root) return
  sweep.holding = false
  const l = parseLease(await readText($, stateDir('sweeper.json')))
  if (l && l.sessionId === String(await $.session.id())) await remove($, [stateDir('sweeper.json')])
}

// Every 2 s: a full sweep every 60 s, and the suspects again soon after a landing anywhere in the project
async function sweepTick($: any) {
  if (!sweep.holding || sweep.running || !baselined) return
  const now = await $.clock.now()
  const full = now - sweep.lastSweep >= 60000
  if (!full && !sweep.dirty) return
  sweep.running = true
  try {
    await computeSuspects($)
    if (full) {
      sweep.lastSweep = now
      await sweepChecks($)
      await maybeCommit($)
    }
  } catch (err) {
    log($, `sweep: ${String(err).slice(0, 200)}`)
  } finally {
    sweep.running = false
  }
}

// Suspects (records.ts suspectsOf) over every world file this session's scans know, written to
// <project>/.claude/fleet/state/suspects.json when they change. A record seen for the first time gets its first version
async function computeSuspects($: any) {
  sweep.dirty = false
  if (!records) return
  const facts: Facts[] = []
  for (const [rel, k] of [...known].sort((a, b) => a[0].localeCompare(b[0]))) {
    const id = idOf(rel, records)
    let owner: Who | null = null
    let blind: string[] | undefined
    let confirmed: string[] | undefined
    if (id && idIndex.get(id) === rel) {
      let revs = await revsOf($, id)
      if (!revs.length && k.v !== null) {
        await ensureBase($, id, rel, k.v, k.pins ?? [], null)
        revs = await revsOf($, id)
      }
      const last = revs[revs.length - 1]
      owner = last?.by ?? null
      if (last && last.hash === k.v) ({ suspect: blind, confirmed } = last)
    } else {
      const e = latest.get(rel)
      owner = e?.by ?? null
      if (e && e.to === k.v) ({ suspect: blind, confirmed } = e)
    }
    if (k.pins?.length || blind?.length) facts.push({ path: rel, id, pins: k.pins ?? [], owner, ...(blind ? { blind } : {}), ...(confirmed ? { confirmed } : {}) })
  }
  const cited = new Map<string, Rev[]>()
  for (const id of new Set(facts.flatMap(f => f.pins.map(p => parsePin(p)?.id ?? '')))) if (id) cited.set(id, await revsFor($, id))
  const list = suspectsOf(facts, p => pinState(p, cited.get(p.id)))
  const key = list.map(suspectKey).join('\n')
  if (key === sweep.suspectsKey && (await exists($, stateDir('suspects.json')))) return
  const file: SuspectsFile = { format: FORMAT, at: await $.clock.now(), by: String(await $.session.id()), suspects: list }
  if (await replace($, stateDir('suspects.json'), json(file))) {
    if (key !== sweep.suspectsKey) log($, `suspects: ${list.filter(s => s.reasons.length).map(s => s.path).join(', ') || 'none'}`)
    sweep.suspectsKey = key
  }
}

// ---- What every session reads of the sweeper's work: the suspects, the check results; the band counts them ----

const flagged = { suspectsMtime: -1, suspects: null as SuspectsFile | null, checksMtime: -1, checks: new Map<string, { mtime: number; file: CheckFile }>(), at: 0 }

async function loadFlags($: any) {
  let m = -1
  try {
    m = Number((await $.fs.stat(stateDir('suspects.json'))).mtimeMs)
  } catch {}
  if (m !== flagged.suspectsMtime) {
    flagged.suspectsMtime = m
    flagged.suspects = m === -1 ? null : parseSuspects((await readText($, stateDir('suspects.json'))) ?? '')
  }
  let c = -1
  try {
    c = Number((await $.fs.stat(stateDir('checks'))).mtimeMs)
  } catch {}
  if (c !== flagged.checksMtime) {
    flagged.checksMtime = c
    let entries: any[] = []
    try {
      entries = await $.fs.list(stateDir('checks'))
    } catch {}
    const present = new Set<string>()
    for (const x of entries) {
      const name = String(x.name)
      if (!name.endsWith('.json')) continue
      present.add(name)
      const had = flagged.checks.get(name)
      if (had && had.mtime === Number(x.mtimeMs)) continue
      const f = parseCheckFile((await readText($, stateDir(`checks/${name}`))) ?? '')
      if (f) flagged.checks.set(name, { mtime: Number(x.mtimeMs), file: f })
    }
    for (const name of [...flagged.checks.keys()]) if (!present.has(name)) flagged.checks.delete(name)
  }
  const n = new Set([...directSuspects().map(s => s.path), ...failing().map(f => f.path)]).size
  if ((await read($, flags)) !== n) await update($, flags, () => n)
}

function directSuspects(): Suspect[] {
  return (flagged.suspects?.suspects ?? []).filter(s => s.reasons.length > 0)
}

/** Files whose last check results, on the version there now, failed */
function failing(): { path: string; owner: Who | null; check: string; message: string; hash: string | null }[] {
  const out: { path: string; owner: Who | null; check: string; message: string; hash: string | null }[] = []
  for (const { file } of flagged.checks.values()) {
    const k = known.get(file.path)
    if (!k || k.v !== file.hash) continue
    for (const [check, r] of Object.entries(file.results)) if (!r.ok) out.push({ path: file.path, owner: file.owner, check, message: r.message ?? 'failed', hash: file.hash })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.check.localeCompare(b.check))
}

/** The digest's part for the files this session wrote last: suspects and failed checks, each told once */
async function ownLines($: any): Promise<{ lines: string[]; keys: string[] }> {
  const me = { sessionId: String(await $.session.id()), ref: myRef ?? jobRef }
  const told = await read($, ownTold)
  const items: { key: string; line: string }[] = []
  const words = await meNow($)
  for (const s of directSuspects()) {
    if (!ownedBy(s.owner, me)) continue
    const key = `s|${suspectKey(s)}`
    if (!told[key]) items.push({ key, line: `- ${suspectLine(s, words)}` })
  }
  for (const f of failing()) {
    if (!ownedBy(f.owner, me)) continue
    const key = `c|${f.path}|${f.check}|${f.hash}`
    if (!told[key]) items.push({ key, line: `- ${f.path} failed the check ${f.check}: ${f.message}` })
  }
  if (!items.length) return { lines: [], keys: [] }
  const shown = items.slice(0, MAX_LINES)
  const text = [
    `fleet: shared files you wrote last are flagged (nothing is held; fix them when you can: read what they cite, then update them, or say why they still hold):`,
    ...shown.map(i => i.line),
    ...(items.length > shown.length ? [`- and ${items.length - shown.length} more: /fleet status in any session lists them`] : []),
  ].join('\n')
  return { lines: [text], keys: items.map(i => i.key) }
}

// ---- Check scripts: the project's own, run on landing and by the sweeper, stamped by the person ----

const checkState = { stampAt: 0, stamp: { ok: false, key: '' }, errors: new Map<string, string>() }

// A check runs only while its definitions and scripts are the ones the person stamped (/fleet accept checks): fleet
// runs them as the person, in every session of the project, with no permission prompt
async function checksStamp($: any, fresh = false): Promise<{ ok: boolean; key: string }> {
  const now = await $.clock.now()
  if (!fresh && now - checkState.stampAt < 10000) return checkState.stamp
  checkState.stampAt = now
  if (!records?.checks.length) return (checkState.stamp = { ok: false, key: '' })
  const scripts = new Map<string, string | null>()
  for (const s of scriptsOf(records.checks)) scripts.set(s, (await versionOf($, `${realRoot}/${s}`)).v)
  const key = checksKey(records.checks, scripts)
  let stamped = ''
  try {
    const v = JSON.parse((await readText($, stateDir('checks-stamp.json'))) ?? '')
    if (v && v.format === FORMAT && typeof v.key === 'string') stamped = v.key
  } catch {}
  return (checkState.stamp = { ok: stamped === key, key })
}

function checkPath(rel: string): string {
  return stateDir(`checks/${hashText(rel).slice(1)}.json`)
}

async function ownerOf($: any, rel: string): Promise<Who | null> {
  const id = records ? idOf(rel, records) : null
  if (id) {
    const revs = await revsOf($, id)
    return revs[revs.length - 1]?.by ?? null
  }
  return latest.get(rel)?.by ?? null
}

// One run of a check on some files, from the project's folder: the files are its last arguments. Each file's result
// is stamped with the version checked, so an unchanged file isn't checked again
async function runCheck($: any, check: Check, rels: string[]) {
  const versions = new Map<string, string | null>()
  for (const rel of rels) versions.set(rel, (await versionOf($, `${realRoot}/${rel}`)).v)
  const r = await run($, [...check.argv, ...rels], { cwd: realRoot, timeoutMs: check.timeoutMs })
  const out = r.exitCode === 124 ? null : checkOutcome(rels, r)
  if (!out) {
    const why = r.exitCode === 124 ? `timed out after ${Math.round(check.timeoutMs / 1000)} s` : (r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 200) || `exit ${r.exitCode}`
    checkState.errors.set(check.name, why)
    log($, `check ${check.name} couldn't run: ${why}`)
    return
  }
  checkState.errors.delete(check.name)
  const now = await $.clock.now()
  for (const [rel, message] of out) {
    const path = checkPath(rel)
    const had = parseCheckFile((await readText($, path)) ?? '')
    const hash = versions.get(rel) ?? null
    const results = had && had.hash === hash ? { ...had.results } : {}
    results[check.name] = { key: check.key, ok: message === null, ...(message !== null ? { message } : {}), at: now }
    const file: CheckFile = { format: FORMAT, path: rel, hash, owner: await ownerOf($, rel), results }
    await replace($, path, json(file))
  }
  const bad = [...out].filter(([, m]) => m !== null).map(([p]) => p)
  log($, `check ${check.name} on ${rels.length} file(s)${bad.length ? `: failed ${bad.join(', ')}` : ': passed'}`)
}

// After a landing in this session: the stamped checks that run on landing, on the files it landed (in the background:
// the landing isn't held, and the owner hears a failure at its next step)
function scheduleChecks($: any, rels: string[]) {
  if (!rels.length || !records?.checks.some(c => c.when === 'land')) return
  $.clock.after(0, () =>
    bg(
      (async () => {
        if (!(await checksStamp($)).ok) return
        for (const c of (records as Records).checks) {
          if (c.when !== 'land') continue
          const mine = rels.filter(r => c.re.test(r))
          if (mine.length) await runCheck($, c, mine)
        }
        await loadFlags($)
      })(),
    ),
  )
}

// The sweeper's part: every check on the files whose results are out of date (changed since, or never checked):
// landing checks each minute (to catch what Bash or an editor wrote), sweep checks every everyMin minutes
async function sweepChecks($: any) {
  if (!records?.checks.length || !(await checksStamp($)).ok) return
  await loadFlags($)
  const byPath = new Map([...flagged.checks.values()].map(x => [x.file.path, x.file]))
  const now = await $.clock.now()
  for (const c of records.checks) {
    if (c.when === 'sweep' && now - (sweep.lastRun[c.name] ?? 0) < c.everyMin * 60000) continue
    sweep.lastRun[c.name] = now
    const due = [...known].filter(([rel, k]) => k.v !== null && c.re.test(rel) && needsCheck(byPath.get(rel), c, k.v)).map(([rel]) => rel)
    for (let i = 0; i < due.length; i += 50) await runCheck($, c, due.slice(i, i + 50))
  }
}

// ---- The world commit (world.json commit.everyMin, off by default): only world paths, never in a worktree ----

async function maybeCommit($: any) {
  const every = records?.commitEveryMin
  if (!every || !world) return
  const now = await $.clock.now()
  let last: any = null
  try {
    last = JSON.parse((await readText($, stateDir('commit.json'))) ?? '')
  } catch {}
  if (last && last.format === FORMAT && now - Number(last.at || 0) < every * 60000) return
  const note = async (n: string) => {
    if (n !== sweep.commitNote) log($, `world commit: ${n}`)
    sweep.commitNote = n
  }
  const g = await gitOf($, realRoot)
  if (!g) return note('not a git repository')
  if (g.gitDir !== g.common) return note('the project is a linked worktree: fleet commits only in the main checkout')
  if (await exists($, `${g.common}/index.lock`)) return note('git is busy (index.lock): next minute')
  if ((await run($, ['git', '-C', realRoot, 'var', 'GIT_COMMITTER_IDENT'])).exitCode !== 0) return note('git has no user.name and user.email here')
  const bases = [...new Set(world.globs.map(globBase))].map(b => (b ? `${realRoot}/${b}` : realRoot))
  const st = await run($, ['git', '-C', realRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...bases], { timeoutMs: 30000 })
  if (st.exitCode !== 0) return note(`git status failed: ${st.stderr.trim().slice(0, 200)}`)
  const top = g.top.replace(/\/+$/, '')
  const prefix = realRoot === top ? '' : realRoot.startsWith(`${top}/`) ? `${realRoot.slice(top.length + 1)}/` : null
  if (prefix === null) return note("the project's folder isn't in its repository's working tree")
  const res = world.res
  const files = [...new Set(porcelainPaths(st.stdout).map(x => x.path))]
    .filter(p => p.startsWith(prefix))
    .map(p => p.slice(prefix.length))
    .filter(rel => inWorld(rel, res) && rel !== '.claude/worktrees' && !rel.startsWith('.claude/worktrees/'))
    .slice(0, 1000)
  if (!files.length) return note('nothing to commit')
  const abs = files.map(f => `${realRoot}/${f}`)
  const add = await run($, ['git', '-C', realRoot, 'add', '-A', '--', ...abs], { timeoutMs: 30000 })
  const msg = commitMessage(now, -new Date(now).getTimezoneOffset())
  // --only: the commit takes these paths as they are, and leaves whatever else the person staged staged
  const c = add.exitCode === 0 ? await run($, ['git', '-C', realRoot, 'commit', '-q', '--only', '-m', msg, '--', ...abs], { timeoutMs: 60000 }) : add
  const ok = c.exitCode === 0
  await replace($, stateDir('commit.json'), json({ format: FORMAT, at: ok ? now : Number(last?.at || 0), tried: now, ok, files: files.length, ...(ok ? {} : { error: (c.stderr || c.stdout).trim().slice(0, 300) }) }))
  return note(ok ? `${msg} (${files.length} file(s))` : `failed: ${(c.stderr || c.stdout).trim().slice(0, 200)}`)
}

// The daily prune's part: event days and outside claims older than KEEP_DAYS, reads files not written since
async function pruneWorld($: any, now: number) {
  const days = oldDays(await names($, eventsDir()), now)
  if (days.length) await run($, ['rm', '-rf', ...days.map(d => eventsDir(d))])
  const old = async (dir: string) => {
    let entries: any[] = []
    try {
      entries = await $.fs.list(dir)
    } catch {}
    await remove($, entries.filter(x => x.kind === 'file' && now - Number(x.mtimeMs) > KEEP_DAYS * 24 * HOUR).map(x => `${dir}/${x.name}`))
  }
  await old(eventsDir('claims'))
  await old(`${fleetDir()}/reads`)
}

// ---- /fleet world, /fleet accept, and the world's part of /fleet status ----

async function readWorldFile($: any): Promise<{ world: WorldConfig } | { problem: string } | null> {
  const t = await readText($, `${fleetDir()}/world.json`)
  return t === null ? null : parseWorld(t)
}

async function worldCommand($: any, action: 'list' | 'add' | 'remove', glob: string, origin: string): Promise<string> {
  await ensureWorld($)
  const p = await readWorldFile($)
  if (p && 'problem' in p) return p.problem
  if (action === 'list') {
    if (!p) return 'No world.json here: /fleet world add <glob> starts one (for example /fleet world add notes/**), or /fleet init writes the default.'
    const snap = p.world.paths.length ? await snapshot($) : new Map()
    return [
      `The world (shared files) of ${root}: ${p.world.paths.length ? globList(p.world.paths) : 'no globs'}`,
      snap ? `${snap.size} file${snap.size === 1 ? '' : 's'} in it now.` : `more than ${MAX_WORLD_FILES} files in it: world.json can narrow it.`,
      '/fleet world add <glob> and /fleet world remove <glob> change it (globs relative to the project: ** any folders, * within a name).',
    ].join('\n')
  }
  if (origin !== 'composer') return `Only the person changes the world, typing /fleet world at a terminal (this came from ${origin || 'somewhere else'})`
  let w = p ? p.world : { ...newWorld(), paths: [] }
  let g = glob
  if (action === 'add' && !/[*?{]/.test(g)) {
    try {
      if ((await $.fs.stat(`${root}/${g.replace(/\/+$/, '')}`)).kind === 'dir') g = `${g.replace(/\/+$/, '')}/**`
    } catch {}
  }
  const changed = action === 'add' ? addGlob(w, g) : removeGlob(w, g)
  if ('problem' in changed) return changed.problem
  w = changed.world
  await $.fs.write(`${fleetDir()}/world.json`, worldText(w))
  world = null
  await loadWorld($)
  return `${action === 'add' ? 'Added' : 'Removed'} ${globList(['added' in changed ? String(changed.added) : g])}. The world is now: ${w.paths.length ? globList(w.paths) : 'nothing'} (world.json). Every session of the project follows within 2 s.`
}

// The person stamps a change made outside fleet (his editor, a script) as his: sessions that read an older version
// hear it as his change. Alone, it lists the changes still unattributed
async function acceptCommand($: any, path: string, origin: string): Promise<string> {
  await ensureWorld($)
  if (!worldOn()) return worldProblem || 'This project has no world (world.json): /fleet world add <glob> starts one.'
  await pullEvents($)
  const me = await meNow($)
  if (path === 'checks') return stampChecks($, origin)
  if (!path) {
    const out: string[] = []
    for (const e of [...latest.values()].filter(x => x.via === 'outside').sort((a, b) => b.at - a.at)) {
      if ((await versionOf($, `${realRoot}/${e.path}`)).v === e.to) out.push(`  ${e.path}: ${changeLine(e, me)} · /fleet accept ${e.path}`)
    }
    return out.length ? ['Changes made outside fleet, not stamped as yours yet:', ...out].join('\n') : 'No change made outside fleet waits to be stamped.'
  }
  if (origin !== 'composer') return `Only the person stamps a change as his, typing /fleet accept at a terminal (this came from ${origin || 'somewhere else'})`
  const w = await worldFile($, path.startsWith('/') ? path : `${realRoot}/${path}`)
  if (!w) return `${path} isn't a shared file of this project (the world: ${globList(world?.globs ?? [])})`
  const cur = await versionOf($, w.abs)
  const last = latest.get(w.rel) ?? null
  const a = acceptable(last, cur.v)
  if (a === 'missing') return `${w.rel} isn't there`
  if (a === 'already') return `${w.rel}: its current version is yours already`
  if (typeof a === 'object') return `${w.rel}: its current version is from ${whoText(a.by, me)} at ${clock(a.by.at, me.offsetMin)}: nothing to stamp`
  const at = Math.max(Math.floor(cur.mtimeMs), (last?.at ?? 0) + 1)
  const from = last && last.via === 'outside' ? last.from : (last?.to ?? null)
  const by: Who = { ...(await whoAmI($, 'main')), person: true }
  // A record whose change no landing recorded yet gets its version now, as the person's
  const id = records ? idOf(w.rel, records) : null
  const k = known.get(w.rel)
  if (id && k?.v && k.v !== cur.v) await ensureBase($, id, w.rel, k.v, k.pins ?? [], null)
  const fields = await landRecord($, w.rel, cur, 'accept', by)
  const ev = await writeEvent($, { at, path: w.rel, from, to: cur.v, via: 'accept', blind: false, by, ...fields })
  if (!ev) return `couldn't record it (${eventsDir()})`
  setKnown(w.rel, { mtimeMs: cur.mtimeMs, size: cur.size, v: cur.v, pins: fields.pins ?? [] })
  unexplained.delete(w.rel)
  return `${w.rel}: its current version (changed at ${clock(cur.mtimeMs, me.offsetMin)}) is recorded as yours${fields.id && fields.rev ? ` (${fields.id}@${fields.rev})` : ''}. Sessions that read an older version hear it as your change.`
}

// The person stamps the project's checks (world.json's checks and the scripts they name, as they are now): fleet runs
// them, in every session of the project, only while they stay as stamped
async function stampChecks($: any, origin: string): Promise<string> {
  if (!records?.checks.length) return recordsProblem || 'world.json lists no checks ("checks": [{ "glob": …, "argv": [...] }]): nothing to stamp'
  const st = await checksStamp($, true)
  const list = records.checks.map(c => `${c.name} (${c.argv.join(' ')}, on ${c.glob}, ${c.when === 'land' ? 'at each landing' : `every ${c.everyMin} min`})`)
  if (st.ok) return `The checks are stamped as they are: ${list.join('; ')}`
  if (origin !== 'composer') return `Only the person stamps the checks, typing /fleet accept checks at a terminal (this came from ${origin || 'somewhere else'})`
  if (!(await replace($, stateDir('checks-stamp.json'), json({ format: FORMAT, key: st.key, at: await $.clock.now() })))) {
    await run($, ['mkdir', '-p', stateDir()])
    if (!(await replace($, stateDir('checks-stamp.json'), json({ format: FORMAT, key: st.key, at: await $.clock.now() })))) return `couldn't stamp them (${stateDir()})`
  }
  checkState.stampAt = 0
  checkState.errors.clear()
  log($, `checks stamped: ${records.checks.map(c => c.name).join(', ')}`)
  return [
    `Stamped: ${list.join('; ')}.`,
    'fleet runs them as you, in every session of the project, until world.json\'s checks or a script they name changes (then /fleet accept checks again). A failure goes to whoever wrote the file last, at its next step, and shows in /fleet status; nothing is held.',
  ].join('\n')
}

async function worldStatus($: any): Promise<string[]> {
  if (!root) return []
  await ensureWorld($)
  if (worldProblem) return [`world: ${worldProblem}`]
  if (!world) return ['world: none (no world.json): /fleet world add <glob> starts one']
  if (!world.globs.length) return ['world: no globs in world.json (/fleet world add <glob>)']
  if (!started) return [`world: ${globList(world.globs)} (not followed in this session: it isn't interactive)`]
  await pullEvents($)
  const me = await meNow($)
  const lines = [`world: ${globList(world.globs)} (world.json)${tooBig ? `, more than ${MAX_WORLD_FILES} files: no scan after each command` : ''}`]
  const last = recent.slice(-8).reverse()
  lines.push(last.length ? 'recent changes (newest first):' : 'recent changes: none in the last day')
  for (const e of last) lines.push(`  ${e.path}: ${changeLine(e, me)}${e.overwrote ? ', on top of a change it had not seen' : ''}`)
  if (recent.length > 8) lines.push(`  and ${recent.length - 8} before them (${eventsDir()})`)
  // Who is behind: every session's reads file (this one's from memory), against each file's version now
  const versions = new Map<string, string | null>()
  const current = async (rel: string) => {
    if (!versions.has(rel)) versions.set(rel, (await versionOf($, `${realRoot}/${rel}`)).v)
    return versions.get(rel)
  }
  const sessionId = String(await $.session.id())
  const sessions: { name: string; threads: Record<string, Record<string, FleetRead>> }[] = [{ name: 'this session', threads: await read($, reads) }]
  let other = 0
  const now = await $.clock.now()
  for (const name of await names($, `${fleetDir()}/reads`)) {
    if (!name.endsWith('.json') || name === `${sessionId}.json`) continue
    const p = parseReads((await readText($, `${fleetDir()}/reads/${name}`)) ?? '')
    if (!p) continue
    if ('otherFormat' in p) {
      other++
      continue
    }
    if (now - p.at > 24 * HOUR) continue
    sessions.push({ name: p.name || p.ref || p.sessionId.slice(0, 8), threads: p.threads })
  }
  const behind: string[] = []
  for (const s of sessions) {
    for (const rel of new Set(Object.values(s.threads).flatMap(t => Object.keys(t)))) await current(rel)
    const stale = staleOf(s.threads, rel => versions.get(rel))
    for (const x of stale) {
      const e = latest.get(x.path)
      behind.push(`  ${s.name}${x.thread === 'main' ? '' : ` (helper ${x.thread.slice(0, 8)})`}: ${x.path}${e && e.to === versions.get(x.path) ? `, ${changeLine(e, me)}` : ''}`)
    }
  }
  lines.push(behind.length ? 'behind (read a version that has changed since):' : 'behind: nobody (every session read the current version of what it read)', ...behind)
  const outside: string[] = []
  for (const e of latest.values()) if (e.via === 'outside' && (await current(e.path)) === e.to) outside.push(e.path)
  if (outside.length) lines.push(`not stamped: ${outside.join(', ')} changed outside fleet: /fleet accept <path> stamps the change as yours`)
  if (other || otherEvents) lines.push(`${other + otherEvents} file(s) from a fleet with another format: restart the sessions (u)`)
  lines.push(...(await recordsStatus($, me)))
  return lines
}

// Records, suspects, checks, the sweeper, world commits and worktrees, for /fleet status
async function recordsStatus($: any, me: Me): Promise<string[]> {
  const lines: string[] = []
  if (recordsProblem) lines.push(`records: ${recordsProblem}`)
  if (!records) return lines
  await loadFlags($)
  const ids = [...idIndex.keys()].sort()
  lines.push(
    ids.length
      ? `records: ${ids.length} (${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''}), cited as ID@n; a version per landing${records.strict ? `, strict on ${records.strict === 'all' ? 'every shared file' : 'some'}` : ''}`
      : 'records: none yet (a shared file whose name starts with an id, like R-12.md, is a record)',
  )
  for (const [id, more] of twins) lines.push(`  ${id} names more than one file: ${[idIndex.get(id), ...more].join(', ')} (the first counts)`)
  const all = flagged.suspects?.suspects ?? []
  const direct = all.filter(s => s.reasons.length)
  const indirect = all.filter(s => !s.reasons.length)
  const who = (s: Suspect) => (s.owner ? ` · last written by ${s.owner.person ? 'the person' : ownedBy(s.owner, { sessionId: me.sessionId, ref: myRef ?? jobRef }) ? 'this session' : s.owner.name || s.owner.ref || s.owner.sessionId?.slice(0, 8)}` : '')
  lines.push(direct.length ? 'suspect (flags, nothing is held):' : 'suspect: none')
  for (const s of direct.slice(0, 20)) lines.push(`  ${suspectLine(s, me)}${who(s)}`)
  if (indirect.length) lines.push(`indirectly suspect: ${indirect.map(s => `${s.path} (cites ${(s.via ?? []).join(', ')})`).join('; ')}`)
  if (records.checks.length) {
    const st = await checksStamp($)
    lines.push(`checks: ${records.checks.map(c => `${c.name} (${c.when === 'land' ? 'at landing' : `every ${c.everyMin} min`})`).join(', ')}${st.ok ? '' : ': not stamped, so not run: /fleet accept checks runs them'}`)
    for (const [name, why] of checkState.errors) lines.push(`  ${name} couldn't run: ${why}`)
    const bad = failing()
    lines.push(bad.length ? 'failing a check:' : 'failing a check: nothing')
    for (const f of bad.slice(0, 20)) lines.push(`  ${f.path}: ${f.check}: ${f.message}`)
  }
  const l = parseLease(await readText($, stateDir('sweeper.json')))
  const now = await $.clock.now()
  lines.push(
    sweep.holding
      ? `sweeper: this session${sweep.lastSweep ? `, last sweep at ${clock(sweep.lastSweep, me.offsetMin)}` : ''}`
      : l && now - l.at <= LEASE_MS
        ? `sweeper: ${l.name || l.ref || l.sessionId.slice(0, 8)}`
        : 'sweeper: none yet (one is elected within a minute)',
  )
  if (records.commitEveryMin) {
    let c: any = null
    try {
      c = JSON.parse((await readText($, stateDir('commit.json'))) ?? '')
    } catch {}
    const lastAt = c && Number(c.at) ? `last at ${clock(Number(c.at), me.offsetMin)}` : 'none yet'
    lines.push(`world commits: every ${records.commitEveryMin} min, only the shared files; ${lastAt}${c && c.ok === false && c.error ? `; the last try failed: ${c.error}` : ''}${sweep.holding && sweep.commitNote ? ` (${sweep.commitNote})` : ''}`)
  } else lines.push('world commits: off (world.json "commit": { "everyMin": 60 } turns them on)')
  if (startedInTree) lines.push(`worktree: this session started in ${startedInTree}; its project is the main checkout's, ${root}`)
  if (trees.linked.length) lines.push(`worktrees: ${trees.linked.length} linked (${trees.linked.slice(0, 4).join(', ')}): their copies of shared files are not the world`)
  return lines
}

// ---- /fleet ----

async function askerViews($: any, records: QueueRecord[]): Promise<(r: QueueRecord) => AskerView> {
  const refs = [...new Set(records.map(r => r.asker.ref).filter((x): x is string => !!x))]
  const rows = new Map<string, any>()
  if (refs.length && (await has($, 'status'))) {
    const st = await race<Status>($, () => $.sessions.status({ refs }))
    for (const row of st?.ready ? st.rows : []) rows.set(row.ref, row)
  }
  return r => {
    const row = r.asker.ref ? rows.get(r.asker.ref) : undefined
    const name = row?.name || r.asker.name || r.asker.ref || `(a session in ${r.asker.root})`
    return { name, state: row ? String(row.state) : null }
  }
}

async function listCommand($: any): Promise<string> {
  const { records, other } = await queueRecords($)
  const present = await answerNames($)
  const view = await askerViews($, records)
  const now = await $.clock.now()
  const keys: string[] = []
  const shown: string[] = []
  const waiting: string[] = []
  for (const r of records) {
    const p = progress(r.id, r.questions.length, present)
    if (p.complete) {
      waiting.push(waitingText(r, view(r), p.dropped))
      continue
    }
    for (let q = 1; q <= r.questions.length; q++) {
      if (p.answered[q - 1]) continue
      keys.push(`${r.id}.${q}`)
      shown.push(heldText(keys.length, r, q, view(r), now))
    }
  }
  await update($, listing, () => keys)
  const out: string[] = []
  if (keys.length) {
    out.push(`${keys.length} question${keys.length === 1 ? '' : 's'} for you · answer with /fleet 1a${keys.length > 1 ? ' 2b' : ''} · /fleet help`, '', shown.join('\n\n'))
  } else out.push('Nothing is waiting for you in this project.')
  if (waiting.length) out.push('', 'Answered, not delivered yet:', ...waiting)
  if (other) out.push('', `${other} decision${other === 1 ? ' was' : 's were'} asked by a fleet with another format: restart the sessions (u)`)
  bg(beat($))
  return out.join('\n')
}

// The number in the last listing shown here, as its decision and question
async function itemOf($: any, n: number): Promise<{ id: string; q: number } | null> {
  const key = (await read($, listing))[n - 1]
  if (!key) return null
  const [id = '', q = '0'] = key.split('.')
  return { id, q: Number(q) }
}

// What became of a decision that's no longer open, from the register (this month's or last month's)
async function closedText($: any, id: string, q?: number): Promise<string> {
  const now = await $.clock.now()
  for (const m of [monthOf(now), monthBefore(monthOf(now))]) {
    const t = await readText($, registerPath(id, m))
    if (t === null) continue
    try {
      const r = JSON.parse(t) as RegisterRecord
      const how = r.state === 'delivered' ? `delivered ${ago(now - (r.delivered?.at ?? r.closedAt))} ago` : r.state
      const a = q ? r.answers[q - 1] : null
      const question = q ? (r.questions[q - 1] as { options: { label: string }[] } | undefined) : undefined
      if (!a || !question) return `${id} is closed (${how})`
      const what = a.label !== undefined ? `${letter(question.options.findIndex(o => o.label === a.label))}) ${a.label}` : `"${a.text ?? ''}"`
      return `already answered${a.session ? ` in ${a.session}` : ''}: ${what} (${how})`
    } catch {}
  }
  return `${id} is closed already`
}

async function answerCommand($: any, items: AnswerItem[], origin: string): Promise<string> {
  if (!(await read($, listing)).length) return 'Run /fleet first: the numbers are the ones its list shows.'
  const now = await $.clock.now()
  const here = await sessionName($)
  const lines: string[] = []
  const touched = new Map<string, QueueRecord>()
  for (const it of items) {
    const item = await itemOf($, it.n)
    if (!item) {
      lines.push(`${it.n}: not in the last list (/fleet shows it again)`)
      continue
    }
    const rec = await readQueue($, item.id)
    if (!rec) {
      lines.push(`${it.n}: ${await closedText($, item.id, item.q)}`)
      continue
    }
    if ('otherFormat' in rec) {
      lines.push(`${it.n}: ${item.id} was asked by a fleet with another format: restart that session (u), then answer`)
      continue
    }
    const question = rec.questions[item.q - 1]
    if (!question) continue
    if (await exists($, dec(`answers/${dropName(item.id)}`))) {
      lines.push(`${it.n}: ${item.id} was dropped`)
      continue
    }
    let chosen: { label: string } | { text: string }
    if (it.letter !== undefined) {
      const o = question.options['abcd'.indexOf(it.letter)]
      if (!o) {
        lines.push(`${it.n}: "${question.question}" has no option ${it.letter}`)
        continue
      }
      chosen = { label: o.label }
    } else chosen = { text: it.text ?? '' }
    const file: AnswerFile = { format: FORMAT, id: item.id, q: item.q, ...chosen, origin, session: here, at: now }
    const path = dec(`answers/${answerName(item.id, item.q)}`)
    const r = await publish($, path, json(file))
    if (r === 'exists') {
      const before = parseWire<AnswerFile>((await readText($, path)) ?? '')
      const b = before && 'value' in before ? before.value : null
      const what = b ? (b.label !== undefined ? `${letter(question.options.findIndex(o => o.label === b.label))}) ${b.label}` : `"${b.text}"`) : 'by another fleet'
      lines.push(`${it.n}: already answered${b ? ` ${ago(now - b.at)} ago in ${b.session}` : ''}: ${what}`)
      continue
    }
    if (r === 'failed') {
      lines.push(`${it.n}: couldn't save the answer (${path})`)
      continue
    }
    const said = 'label' in chosen ? `${it.letter}) ${chosen.label}` : `"${chosen.text}"`
    lines.push(`${it.n}: ${question.question} → ${said}`)
    touched.set(item.id, rec)
  }
  const present = await answerNames($)
  const view = await askerViews($, [...touched.values()])
  for (const [id, rec] of touched) {
    const p = progress(id, rec.questions.length, present)
    const left = p.answered.filter(a => !a).length
    lines.push(left ? `${id}: ${left} more question${left === 1 ? '' : 's'} to go` : `${id} goes to ${view(rec).name} when it's idle`)
  }
  bg(beat($))
  return lines.join('\n')
}

async function noteCommand($: any, n: number, text: string, origin: string): Promise<string> {
  const item = await itemOf($, n)
  if (!item) return `${n} isn't in the last list: /fleet shows it again`
  const rec = await readQueue($, item.id)
  if (!rec) return closedText($, item.id)
  if ('otherFormat' in rec) return `${item.id} was asked by a fleet with another format: restart that session (u)`
  const note: NoteFile = { format: FORMAT, id: item.id, q: item.q, text, origin, at: await $.clock.now() }
  if (!(await replace($, dec(`answers/${noteName(item.id, item.q)}`), json(note)))) return "couldn't save the note"
  return `Note on ${n} saved: it goes with the answer`
}

async function dropCommand($: any, target: string, why: string, origin: string): Promise<string> {
  let id = target
  if (!isDecisionId(id)) {
    const item = await itemOf($, Number(target))
    if (!item) return `${target} isn't in the last list: /fleet shows it again`
    id = item.id
  }
  const rec = await readQueue($, id)
  if (!rec) return closedText($, id)
  if ('otherFormat' in rec) return `${id} was asked by a fleet with another format: restart that session (u)`
  const file: DropFile = { format: FORMAT, id, ...(why ? { why } : {}), origin, session: await sessionName($), at: await $.clock.now() }
  const r = await publish($, dec(`answers/${dropName(id)}`), json(file))
  if (r === 'exists') return `${id} was dropped already`
  if (r === 'failed') return `couldn't drop ${id}`
  const v = (await askerViews($, [rec]))(rec)
  bg(beat($))
  if (v.state === 'gone') {
    await close($, id, { state: 'abandoned', why: why || 'dropped: its session is gone' })
    return `${id} dropped and closed: its session is gone`
  }
  return `${id} dropped: ${v.name} is told when it's idle`
}

async function statusCommand($: any): Promise<string> {
  const lines = [`version ${version || '?'}${root ? ` · project ${root}` : ' · this project has no .claude/fleet/ (/fleet init sets it up)'}`]
  if (configProblem) lines.push(configProblem)
  lines.push(offered ? `decide: offered here (background session ${jobRef})` : `decide: not offered here: ${whyNot}`)
  const c = (await has($, 'contract')) ? found : null
  lines.push(
    c
      ? `sessions: api ${c.api}, version ${c.version}: names, states and the "Asking you" section`
      : found && found.api !== SESSIONS_API
        ? `sessions: api ${found.api}, and this fleet calls api ${SESSIONS_API}: update both and restart (u)`
        : "sessions: not answering: no names, states or sections (it's needed: restart, u)",
  )
  if (root) {
    const { records, other } = await queueRecords($)
    const present = await answerNames($)
    const waiting = records.filter(r => progress(r.id, r.questions.length, present).complete).length
    lines.push(`project: ${heldCount(records, present)} question(s) for you, ${waiting} decision(s) answered and not delivered yet${other ? `, ${other} from a fleet with another format` : ''}`)
    if (jobRef) {
      const mine = Object.keys(await read($, open))
      const pending = Object.keys(await read($, inflight))
      lines.push(`asked here: ${mine.length ? mine.join(', ') : 'nothing open'}${pending.length ? ` · being delivered: ${pending.join(', ')}` : ''}`)
      if (await read($, stopped)) lines.push('delivery: waiting for you to type something here (an Esc stopped this session)')
    }
    lines.push(...(await worldStatus($)))
  }
  lines.push(`formats: files ${FORMAT}, register ${REGISTER_FORMAT}, config ${CONFIG_FORMAT}, world ${WORLD_FORMAT}`)
  return lines.join('\n')
}

async function initCommand($: any, template: string, commitRegister: boolean): Promise<string> {
  if (template !== 'blank') return `fleet ${version} has one template, blank: /fleet init`
  const here = String(await $.session.root()).replace(/\/+$/, '')
  if (root && root !== here) return `Already set up for this folder, in ${root}/.claude/fleet/`
  if (here === home || !here) return "Not in your home folder: start a session in the project's folder and run /fleet init there"
  const dir = `${here}/.claude/fleet`
  let config: Config = { configFormat: CONFIG_FORMAT, template: 'blank', commitRegister: false }
  const before = await readText($, `${dir}/config.json`)
  if (before !== null) {
    const p = parseConfig(before)
    if ('problem' in p) return p.problem
    config = p.config
  }
  if (commitRegister) config = { ...config, commitRegister: true }
  const made = await run($, ['mkdir', '-p', ...['queue', 'answers', 'register', 'tmp', 'prune'].map(d => `${dir}/decisions/${d}`), `${dir}/events`, `${dir}/reads`])
  if (made.exitCode !== 0) return `couldn't create ${dir}: ${made.stderr.trim()}`
  if (before !== configText(config)) await $.fs.write(`${dir}/config.json`, configText(config))
  await $.fs.write(`${dir}/.gitignore`, gitignoreText(config.commitRegister))
  // The world: written once with the default globs, then the person's (/fleet world add, remove)
  const worldBefore = await readText($, `${dir}/world.json`)
  const parsed = worldBefore === null ? null : parseWorld(worldBefore)
  if (worldBefore === null) await $.fs.write(`${dir}/world.json`, worldText(newWorld()))
  const globs = parsed && 'world' in parsed ? parsed.world.paths : worldBefore === null ? newWorld().paths : []
  const fresh = root === null
  root = here
  configProblem = ''
  if (fresh) worldReady = null
  timers($)
  if (jobRef && !offered) await offer($).catch(() => {})
  if (!jobRef) whyNot = "this isn't a background session: here the model asks with AskUserQuestion, and fleet records the answers"
  log($, `init ${dir}`)
  return [
    `${fresh ? 'Set up' : 'Up to date'} in ${dir}/ (template blank).`,
    "Background sessions of this project get mcp__fleet__decide: they ask you without stopping, and the answer reaches them when they're idle.",
    'Their questions show with /fleet in any session of the project, and as "? n for you · /fleet" above the prompt.',
    parsed && 'problem' in parsed
      ? parsed.problem
      : `Shared files (world.json): ${globs.length ? globList(globs) : 'none'}. A session's write of one that changed since it read it is refused once with who changed it, and it hears of such changes at its next step. /fleet world changes the list.`,
    config.commitRegister
      ? 'The register (decisions/register/) is committed with the project; the rest of decisions/, events/, reads/ and state/ stay out of git.'
      : 'decisions/, events/, reads/ and state/ stay out of git (.claude/fleet/.gitignore); /fleet init --commit-register commits the register.',
    'Sessions already running join within a minute; one that was running before fleet was enabled needs a restart (u).',
  ].join('\n')
}

async function fleetCommand($: any, e: any): Promise<string> {
  const c = parseCommand(String(e.args ?? ''))
  await locate($)
  if (c.kind === 'help') return HELP
  if (c.kind === 'bad') return `${c.reason}\n\n${HELP}`
  if (c.kind === 'status') return statusCommand($)
  if (c.kind === 'init') return initCommand($, c.template, c.commitRegister)
  if (!root) return `Not set up in this project: /fleet init sets it up in ${await $.session.root()}`
  if (c.kind === 'list') return listCommand($)
  // The world and accept are the person's own too, like answers (below): typed at a terminal
  if (c.kind === 'world') return worldCommand($, c.action, c.glob, String(e.origin?.kind ?? ''))
  if (c.kind === 'accept') return acceptCommand($, c.path, String(e.origin?.kind ?? ''))
  // Answers, notes and drops are the person's own: typed at a terminal (the model can't run a plugin's command, and
  // another plugin's $.command.run reads as plugin).
  // TODO(G7): accept 'bridge' (Remote Control from the phone) once it's checked that a command typed there runs here
  // and reads origin bridge
  const kind = String(e.origin?.kind ?? '')
  if (kind !== 'composer') {
    return kind === 'bridge'
      ? "Answers typed over Remote Control aren't taken yet (not tried): answer from a terminal session of the project"
      : `Only the person answers, typing /fleet at a terminal (this came from ${kind || 'somewhere else'})`
  }
  if (c.kind === 'answer') return answerCommand($, c.items, kind)
  if (c.kind === 'note') return noteCommand($, c.n, c.text, kind)
  return dropCommand($, c.target, c.why, kind)
}

// ---- AskUserQuestion: what the person answered in a dialog goes to the register too ----

async function recordDialog($: any, e: any, r: any, askedAt: number) {
  await locate($)
  if (!root) return
  const questions = dialogQuestions(e)
  if (!questions.length) return
  const { answers, state, why } = classifyDialog(questions, r)
  const id = `ask-${String(e.tool_use_id ?? askedAt).replace(/[^A-Za-z0-9_-]/g, '')}`
  const entry: RegisterRecord = {
    registerFormat: REGISTER_FORMAT,
    id,
    source: 'dialog',
    fleet: version,
    at: askedAt,
    asker: await askerNow($),
    questions,
    answers,
    state,
    ...(why ? { why } : {}),
    closedAt: await $.clock.now(),
  }
  const p = await publish($, registerPath(id, monthOf(askedAt)), json(entry))
  log($, `dialog ${id}: ${state}${why ? ` (${why})` : ''}${p === 'failed' ? "; couldn't write it" : ''}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    found = undefined
    const r = await next(e)
    if (!e.isInteractive) return r
    // decide has to be in the first request of turn one: awaited here, but never for more than about a second
    await Promise.race([offer($).catch(() => {}), $.clock.sleep(1000)])
    bg(start($))
    return r
  })

  // A /clear keeps this process and its $.state; the open decisions are read again from the files all the same, and the
  // new conversation has read nothing of the world. A session that ends for good gives up the sweeper's lease
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && timersOn && jobRef) $.clock.after(500, () => bg(rebuild($)))
    if (e.reason === 'clear') bg(clearReads($, String(e.sessionId ?? '')))
    else await Promise.race([releaseLease($).catch(() => {}), $.clock.sleep(500)])
    return next(e)
  })

  // The engine's own watcher (C9, Q6-bg: it fires in a background session with no viewer, after /clear and compaction)
  // on events/latest, so a landing reaches every session in under a second; the 2 s tick is the fallback
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    try {
      await ensureWorld($)
      if (!root) return r
      return { ...r, watchPaths: [...(r?.watchPaths ?? []), `${eventsDir()}/latest`] }
    } catch {
      return r
    }
  }).catch(($, e, next) => next(e))

  on('classic.FileChanged', async ($, e, next) => {
    if (root && String(e.file_path).endsWith('/.claude/fleet/events/latest')) bg(eventsTick($))
    return next(e)
  }).catch(($, e, next) => next(e))

  // The world's three hooks (changes.ts). They fail open: a fleet that errs lets the tool run as if it weren't there
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const r: any = await next(e)
    if (!r || r.isError || r.deny !== undefined) return r
    await ensureWorld($)
    if (!worldOn()) return r
    const thread = threadOf(e)
    return withLines($, r, thread, await noteRead($, thread, e.file_path))
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ['Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => gate($, e, next)).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => bashHook($, e, next)).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && timersOn) bg(turnStarted($, e.text, e.turnId))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && timersOn) {
      bg(
        (async () => {
          await update($, busy, () => false)
          const now = await $.clock.now()
          await update($, idleSince, () => now)
        })(),
      )
    }
    // A helper that finished takes its reads of the world with it
    if (typeof e.agentId === 'string' && e.agentId) bg(dropThread($, e.agentId))
    return r
  })

  // The person typed here: after an Esc, fleet may submit again. And a prompt that starts a turn carries the main
  // thread's digest (prompt.submit's context is in the turn's first request; an append there would not be)
  on('prompt.submit', async ($, e, next) => {
    if ((e.origin?.kind === 'composer' || e.origin?.kind === 'bridge') && timersOn) {
      bg((async () => ((await read($, stopped)) ? update($, stopped, () => false) : null))())
    }
    if (e.command || !worldOn()) return next(e)
    const d = await digestFor($, 'main')
    if (!d.lines.length) return next(e)
    const r = await next({ ...e, context: [...(e.context ?? []), ...d.lines] })
    if (r && r.drop === undefined) bg(d.told())
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__fleet__decide' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT_REFUSAL }
    await locate($)
    if (!root) return { deny: "fleet isn't set up in this project any more: ask the person in plain text" }
    const checked = checkDecide(e)
    if (!checked.ok) return { deny: `${checked.reason}. Nothing was queued: call mcp__fleet__decide again with that fixed.` }
    const asker = await askerNow($)
    const now = await $.clock.now()
    const record = await allocate($, id => ({
      format: FORMAT,
      fleet: version,
      id,
      at: now,
      asker,
      questions: checked.questions,
      ...(checked.blocks ? { blocks: checked.blocks } : {}),
    }))
    await update($, open, m => ({ ...m, [record.id]: record.questions.length }))
    log($, `${record.id} queued: ${record.questions.length} question(s)`)
    bg(beat($))
    return { result: ticketText(record.id) }
  }).catch(() => ({ result: "fleet couldn't queue this question: ask the person in plain text" }))

  // The model's own AskUserQuestion only: another plugin's $.ui.ask goes by untouched. It only watches: the dialog is
  // the usual one, and what it returns goes back unchanged
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (next.origin.plugin !== 'engine') return next(e)
    let askedAt = 0
    try {
      askedAt = await $.clock.now()
    } catch {}
    const r = await next(e)
    bg(recordDialog($, e, r, askedAt))
    return r
  })

  on('command.run', { command: 'fleet' }, async ($, e) => {
    try {
      return { text: await fleetCommand($, e) }
    } catch (err) {
      return { text: `fleet: ${String(err).slice(0, 300)}` }
    }
  })

  // Above the prompt: how many questions wait for the person in this project, and how many shared files are flagged
  // (suspect, or failing a check), with whatever is drawn there after it. Its first draw starts fleet when
  // session.start didn't come (a draw only draws: the start runs from a timer)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!started && !startScheduled) {
      startScheduled = true
      $.clock.after(0, () => bg(start($)))
    }
    const beneath = await next(e)
    if (e.props.hasSurvey) return beneath
    const n = await read($, held)
    const f = await read($, flags)
    if (n <= 0 && f <= 0) return beneath
    const parts = [...(n > 0 ? [`? ${n} for you`] : []), ...(f > 0 ? [`!! ${f} flagged`] : []), n > 0 ? '/fleet' : '/fleet status']
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color="warning">{parts.join(' · ')}</Text>
        {beneath}
      </Box>
    )
  })
}
