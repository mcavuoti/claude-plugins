import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FleetInflight } from '../types'
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

// fleet, per project: a background session asks the person with mcp__fleet__decide and goes on working; the person
// answers from any session of the project with /fleet (no tokens), and the asking session's fleet hands the answer to
// its model as a prompt of its own once it's idle. The project's .claude/fleet/ folder holds everything (decisions.ts
// lists the files); fleet keeps no store. Other sessions are named, and their state read, only through $.sessions
// (calls only: fleet never hooks a sessions.* event nor reads its files).

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

// Every command runs from / (it exists; every path is absolute), and one that can't start counts as a failure
async function run($: any, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    return await $.process.run(argv, { cwd: '/', timeoutMs: 10000 })
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: String(err) }
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

async function findRoot($: any): Promise<string | null> {
  let dir = String(await $.session.root()).replace(/\/+$/, '')
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
      argumentHint: '[1a 2b | note <n> <text> | drop <n> [why] | status | init | help]',
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
  }
  lines.push(`formats: files ${FORMAT}, register ${REGISTER_FORMAT}, config ${CONFIG_FORMAT}`)
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
  const made = await run($, ['mkdir', '-p', ...['queue', 'answers', 'register', 'tmp', 'prune'].map(d => `${dir}/decisions/${d}`)])
  if (made.exitCode !== 0) return `couldn't create ${dir}: ${made.stderr.trim()}`
  if (before !== configText(config)) await $.fs.write(`${dir}/config.json`, configText(config))
  await $.fs.write(`${dir}/.gitignore`, gitignoreText(config.commitRegister))
  const fresh = root === null
  root = here
  configProblem = ''
  timers($)
  if (jobRef && !offered) await offer($).catch(() => {})
  log($, `init ${dir}`)
  return [
    `${fresh ? 'Set up' : 'Up to date'} in ${dir}/ (template blank).`,
    "Background sessions of this project get mcp__fleet__decide: they ask you without stopping, and the answer reaches them when they're idle.",
    'Their questions show with /fleet in any session of the project, and as "? n for you · /fleet" above the prompt.',
    config.commitRegister
      ? 'The register (decisions/register/) is committed with the project; the rest of decisions/ stays out of git.'
      : 'decisions/ stays out of git (.claude/fleet/.gitignore); /fleet init --commit-register commits the register.',
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

  // A /clear keeps this process and its $.state; the open decisions are read again from the files all the same
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && timersOn && jobRef) $.clock.after(500, () => bg(rebuild($)))
    return next(e)
  })

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
    return r
  })

  // The person typed here: after an Esc, fleet may submit again
  on('prompt.submit', async ($, e, next) => {
    if ((e.origin?.kind === 'composer' || e.origin?.kind === 'bridge') && timersOn) {
      bg((async () => ((await read($, stopped)) ? update($, stopped, () => false) : null))())
    }
    return next(e)
  })

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

  // Above the prompt: how many questions wait for the person in this project, with whatever is drawn there after it.
  // Its first draw starts fleet when session.start didn't come (a draw only draws: the start runs from a timer)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!started && !startScheduled) {
      startScheduled = true
      $.clock.after(0, () => bg(start($)))
    }
    const beneath = await next(e)
    if (e.props.hasSurvey) return beneath
    const n = await read($, held)
    if (n <= 0) return beneath
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color="warning">{`? ${n} for you · /fleet`}</Text>
        {beneath}
      </Box>
    )
  })
}
