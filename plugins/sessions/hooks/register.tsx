import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Color, PaneNote, Renaming, Row, Usage, UsageView } from '../types'

import {
  abbreviate,
  type Action,
  actionFromAnswer,
  reconcilePins,
  adoptAutoPins,
  paneWidth,
  buildNotice,
  sparkline,
  closedForLowMemory,
  colorOf,
  displayWidth,
  compareVersions,
  timeSince,
  inProject,
  parseWindows,
  type Windows,
  type SessionState,
  type AutoPins,
  type Heartbeat,
  type InstalledPlugin,
  type NoticeKind,
  type WindowTarget,
  parseNotice,
  parsePins,
  parseVersion,
  parseHeartbeat,
  parseInbox,
  parsePluginList,
  shortModelName,
  RESTART_OPTIONS,
  recentReopens,
  STOP_OPTIONS,
  REMOVE_OPTIONS,
  type UsageSummary,
  realTasks,
  validateList,
  neighbor,
  remainingNeighbor,
  usageWindow,
  versionFromExecutable,
  expectsHeartbeat,
  heartbeatStatus,
  heartbeatText,
  keyLines,
  fileKey,
  orderFileText,
  rootFrom,
  sortRows,
  windowTargetText,
  autoName,
  debugLogName,
  reloadDecision,
  FORMAT,
  NOTICE_MARKER,
} from './state'
import { choosePlatform, macos, type Me, type Platform, type Run } from './platform'

const PANE = 'sessions'

const DOT: Record<Color, string> = { red: '🔴', blue: '🔵', yellow: '🟡', green: '🟢', gray: '⚫' }
// The colors for each state, from Claude's theme (they adapt to light, dark and colorblind modes)
const TINT: Record<Color, string> = { red: 'error', blue: 'suggestion', yellow: 'warning', green: 'success', gray: 'inactive' }

const rows = atom({ plugin: 'sessions', key: 'rows' } as const, [] as Row[])
const askingName = atom({ plugin: 'sessions', key: 'askingName' } as const, false)
const renaming = atom({ plugin: 'sessions', key: 'renaming' } as const, null as Renaming)
const notice = atom({ plugin: 'sessions', key: 'notice' } as const, '')
const usage = atom({ plugin: 'sessions', key: 'usage' } as const, { summary: null, note: '' } as Usage)
const usageView = atom({ plugin: 'sessions', key: 'usageView' } as const, { period: 'day', scope: 'all' } as UsageView)
// The session's short id, for the line above the prompt: empty until the mod has started in this session
const shortId = atom({ plugin: 'sessions', key: 'shortId' } as const, '')
// Why the panel isn't shown, for the line above the prompt (see paneState)
const paneNote = atom({ plugin: 'sessions', key: 'paneNote' } as const, '' as PaneNote)

let claude = 'claude'
let myId = ''
let myPid = 0
let myCwd = ''
let home = ''
// Where the mod keeps its files (heartbeats, the order file, the launcher's window files, requests, usage cache):
// ~/.claude/mods/sessions-data, or SESSIONS_DATA_DIR. Claude's background service's folder and log are read from
// ~/.claude/jobs and ~/.claude/daemon.log, or SESSIONS_JOBS_DIR and SESSIONS_DAEMON_LOG: test sessions point all three
// elsewhere, so they never touch the files of the sessions you use
let dataDir = ''
let jobsDir = ''
let daemonLog = ''
// This copy of the mod: its folder and version (from its plugin.json)
const PLUGIN_DIR = `${(import.meta as any).dir}/..`
let modVersion = ''
let lastList: any[] = []
// The row selected with the arrows (the session button's key, "s:<sessionId>") and the element that has the focus now
let selectedRow: string | undefined
let currentFocus: string | undefined
// Panel width: what the content needs, capped at the width Claude gives it on its own ("the default one").
// That cap is measured by opening the panel without asking for a width, and measured again if the window size changes.
let requestedWidth = 0
let defaultWidth = 0
let defaultWindowWidth = 0
let remeasure = false
// The session that was asked whether to stop: only its answer is accepted, and only for a while. fallback is the row
// that stays selected if it leaves the list: its neighbor in the list you were looking at when you pressed Stop
let pendingAsk: { sessionId: string; at: number; fallback?: string } | undefined
// How many times you moved the panel's focus yourself (arrows, Tab, click): so the focus isn't fought over when the
// panel takes it on its own
let personMoves = 0
// The installed Claude version (the newest one known): sessions with an older one get marked with ↑
let installedVersion = ''
// How this system's windows, processes and memory are handled: hooks/platform/macos.ts or linux.ts
let platform: Platform = macos

// Starting the mod in this session. It's started once, by whichever comes first: session.start, the first draw of the
// line above the prompt (a session draws even with no window attached), a prompt you type, or a notice from another
// session. session.start alone isn't enough: a session that got an old pre-started process can run without it, and
// then the panel, the heartbeat and /sessions never started
let starting: Promise<void> | null = null
let active = false
let startedVia = ''
let sawSessionStart = false
let renderScheduled = false
let startedAt = 0
let lastBeat = 0
// The plugin's option (the config menu): sessions the panel or ccc create write Claude's debug log to <data>/debug, and
// the mod logs its start steps to the debug log. The mod mirrors it to <data>/config for the launcher, which can't read
// plugin options
let debugLogs = false
// The installed version this session's mod already tried to update itself to (once per version)
let reloadTriedFor = ''
const startProblems: string[] = []

// A command that can't be run (it doesn't exist on this computer: Linux has no osascript or ioreg, and lsof isn't
// always there) or that didn't finish in time counts as one more failure (exit code 127), instead of aborting
// everything that called it
async function runSafe($: any, argv: string[], init?: Record<string, unknown>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    return await $.process.run(argv, init)
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: String(err) }
  }
}

async function run($: any, argv: string[], cwd?: string) {
  return runSafe($, argv, { cwd: cwd ?? myCwd, timeoutMs: 15000 })
}

// The platform's commands run through runSafe, with this hook's $
function sys($: any): Run {
  return (argv, init) => runSafe($, argv, init)
}

function me(): Me {
  return { shortId: myId.slice(0, 8), pid: myPid || undefined, background: lastList.find(s => s.sessionId === myId)?.kind === 'background' }
}

// Work started and not awaited: a failure (or the mod being reloaded meanwhile) is dropped quietly
function bg(work: Promise<unknown>) {
  work.catch(() => {})
}

// A line in the debug log only (claude --debug, or --debug-file), when the option is on
function debugLine($: any, text: string) {
  if (!debugLogs) return
  try {
    void Promise.resolve($.ui.log(`sessions: ${text}`, { to: 'debug' })).catch(() => {})
  } catch {}
}

// Data shared between sessions: the mod's official store ($.store), a JSON file managed by Claude. Keys:
// state:<id> (SessionState), seen:<id> (seen at), title:<id> (title from the first prompt), waiting:<id> (waiting since),
// restarted:<id> (restarted from its own panel at), reopened:<id> (reopen times), list (cached session list),
// installed (installed Claude version), plugin (the installed plugin), usageView, pinPass (last auto-pin pass),
// autoPins (AutoPins), reopenPass (last reopen pass, and normalSince: since when memory has been normal),
// panelClosed (you closed the panel: sessions start without it until you open it again), reloaded:<id> (this
// session's mod updated itself with /reload-plugins: from, to, at).
// When a stored value changes meaning, it gets a new key: sessions on another version never misread it
async function storeGet($: any, key: string): Promise<any> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

async function storeSet($: any, key: string, value: unknown) {
  try {
    await $.store.set(key, value)
  } catch {}
}

async function storeDelete($: any, key: string) {
  try {
    await $.store.delete(key)
  } catch {}
}

async function seenAt($: any, sessionId: string): Promise<number> {
  return Number(await storeGet($, `seen:${sessionId}`)) || 0
}

async function readState($: any, sessionId: string): Promise<SessionState | null> {
  const e = await storeGet($, `state:${sessionId}`)
  return e && typeof e === 'object' ? (e as SessionState) : null
}

// Which terminal windows show each session: "claude attach <id>" viewers, agent views, and classic sessions by their pid
async function windows($: any): Promise<Windows> {
  // -A: every process, on macOS and on Linux (on macOS it's the same as -ax)
  return parseWindows((await run($, ['ps', '-A', '-o', 'pid=,tty=,command='])).stdout)
}

// The window this session's panel was just used from (macOS: the front Terminal window, if it shows this session;
// Linux: the one whose launcher has it open)
async function frontWindowShowingMe($: any): Promise<string | null> {
  return platform.windowShowingMe(sys($), await windows($), me())
}

// The launcher (hooks/visor.sh, next to this file) runs in each window opened with ccc and opens one session after
// another there. To switch, the next one is written to that window's file (<data>/windows/<tty>) and the current
// viewer is closed. Windows the panel opens run the launcher of this very copy of the mod; `ccc` runs the enabled
// plugin's launcher through the small command the setup installs, which nothing rewrites
const LAUNCHER = `${PLUGIN_DIR}/hooks/visor.sh`

function windowFile(tty: string): string {
  return `${dataDir}/windows/${fileKey(tty)}`
}

function launcherCommand(t: WindowTarget): string {
  return `cd ${JSON.stringify(myCwd)} && bash ${JSON.stringify(LAUNCHER)} ${t.command === 'attach' ? `attach ${t.id}` : 'agents'}`
}

function agentsTarget(): WindowTarget {
  return { command: 'agents', title: 'Agents', folder: myCwd }
}

// A single window: if a viewer or the agent view (clients) is in front and the window runs the launcher, switch to the
// target in that same tab: write it the target and close the viewer; the launcher opens the next one. A window that
// wasn't opened with ccc has no launcher and can't be switched in place (false): the caller opens a new window
async function switchInPlace($: any, target: WindowTarget, front: string): Promise<boolean> {
  const v = await windows($)
  const pid = v.clients[front]
  if (!pid || !v.launchers[front] || !dataDir) return false
  try {
    await $.fs.write(windowFile(front), windowTargetText(target))
  } catch {
    return false
  }
  await run($, ['kill', '-HUP', pid])
  return true
}

async function myWindows($: any): Promise<string[]> {
  const v = await windows($)
  const short = myId.slice(0, 8)
  const list = [...(v.byId[short] ?? [])]
  const own = myPid ? v.byPid[String(myPid)] : undefined
  if (own) list.push(own)
  return list
}

// Are you looking at me? Someone at the computer (the platform can tell on macOS: screen unlocked, recent input) and a
// window in front with one of my viewers, or an agent view showing my tag. Where the front window can't be known
// (Linux), a session counts as seen only when you type in it
async function markSeenIfLooking($: any) {
  const finished = (await readState($, myId))?.finished ?? 0
  const seen = await seenAt($, myId)
  if (finished <= seen) return
  const tty = await platform.windowInFront(sys($))
  if (!tty || !(await platform.userPresent(sys($)))) return
  let looking = (await myWindows($)).includes(tty)
  if (!looking && (await windows($)).agentsViews.some(c => c.tty === tty)) {
    looking = (await platform.readWindow(sys($), tty)).includes(`⟨${myId.slice(0, 8)}⟩`)
  }
  if (looking) await storeSet($, `seen:${myId}`, await $.clock.now())
}

// A single query every 3.5 s for all sessions: the first one that finds it stale refreshes it
async function officialList($: any): Promise<any[] | string> {
  const now = await $.clock.now()
  const c = await storeGet($, 'list')
  if (c && now - c.at < 3500 && Array.isArray(c.sessions)) return c.sessions
  const r = await run($, [claude, 'agents', '--json', '--all'])
  if (r.exitCode !== 0) return "Couldn't read the session list (claude agents --json)"
  const list = validateList(r.stdout)
  if (typeof list === 'string') return list
  await storeSet($, 'list', { at: now, sessions: list })
  return list
}

// The heartbeats of the sessions in a list, by sessionId (only the ones that exist and parse)
async function readHeartbeats($: any, ids: string[]): Promise<Record<string, Heartbeat>> {
  const out: Record<string, Heartbeat> = {}
  if (!dataDir) return out
  let names: Set<string>
  try {
    names = new Set((await $.fs.list(`${dataDir}/alive`)).map((f: any) => String(f.name)))
  } catch {
    return out
  }
  for (const id of ids) {
    if (!names.has(id)) continue
    try {
      const h = parseHeartbeat(await $.fs.read(`${dataDir}/alive/${id}`))
      if (h) out[id] = h
    } catch {}
  }
  return out
}

// This session's heartbeat (see Heartbeat in state.ts), every 15 s
async function beat($: any) {
  if (!dataDir || !myId) return
  const at = await $.clock.now()
  await $.fs.write(`${dataDir}/alive/${myId}`, heartbeatText({ pid: myPid, at, version: modVersion, via: startedVia }))
  lastBeat = at
}

// Every 10 minutes, the data of sessions no longer in the official list (fetched right then) is deleted: their stored
// keys, heartbeats and requests. Never that of a session created in the last 5 minutes, nor of one with a fresh
// heartbeat: the agent view's pre-started session is running and hidden from the list
let lastPrune = 0
async function prune($: any) {
  const now = await $.clock.now()
  if (now - lastPrune < 600000) return
  lastPrune = now
  const r = await run($, [claude, 'agents', '--json', '--all'])
  const list = r.exitCode === 0 ? validateList(r.stdout) : 'failed'
  if (typeof list === 'string') return
  const alive = new Set(list.map(s => String(s.sessionId)))
  const ids = new Set<string>()
  let keys: string[] = []
  try {
    keys = await $.store.keys()
  } catch {}
  for (const k of keys) {
    const m = k.match(/^(state|seen|title|waiting|restarted|reopened):(.+)$/)
    if (m?.[2] && !alive.has(m[2])) ids.add(m[2])
  }
  let files: string[] = []
  try {
    files = (await $.fs.list(`${dataDir}/alive`)).map((f: any) => String(f.name))
  } catch {}
  for (const f of files) if (!alive.has(f)) ids.add(f)
  const beats = await readHeartbeats($, [...ids])
  for (const id of ids) {
    if (id === myId) continue
    const created = (await readState($, id))?.created ?? 0
    if (now - created < 300000) continue
    const h = beats[id]
    if (h && now - h.at < 120000) continue
    for (const k of keys.filter(k => k.endsWith(`:${id}`))) await storeDelete($, k)
    await runSafe($, ['rm', '-f', `${dataDir}/alive/${id}`, `${dataDir}/inbox/${id}`])
  }
}

// The version of a session whose own mod doesn't record it (no mod, or one that never started): the program its
// process runs. A process's program doesn't change, so it's cached by pid
const versionByPid: Record<string, string> = {}
async function processVersion($: any, pid: number): Promise<string> {
  const key = String(pid)
  if (key in versionByPid) return versionByPid[key] ?? ''
  const v = versionFromExecutable(await platform.processProgram(sys($), key)) ?? ''
  versionByPid[key] = v
  return v
}

// Tokens spent: usage.py (next to this file) reads them from the conversation logs; it reads only what's new since the
// previous run (its cache is in <data>/usage) and several sessions can run it at once.
// It needs python3: on a Mac without the developer tools, /usr/bin/python3 pops up a prompt to install them, so there
// that one isn't used without them (on Linux /usr/bin/python3 is the usual one)
const USAGE_READER = `${(import.meta as any).dir}/usage.py`
let python: string | null | undefined
async function usablePython($: any): Promise<string | null> {
  if (python !== undefined) return python
  const r = await runSafe($, ['/bin/sh', '-lc', 'command -v python3'])
  const path = r.exitCode === 0 ? r.stdout.trim() : ''
  if (!path) return (python = null)
  const mac = (await runSafe($, ['uname', '-s'])).stdout.trim() === 'Darwin'
  if (mac && path === '/usr/bin/python3' && (await runSafe($, ['xcode-select', '-p'])).exitCode !== 0) return (python = null)
  return (python = path)
}

let readingUsage = false
async function readUsage($: any) {
  if (readingUsage || !home || !dataDir) return
  if (!(await $.ui.panes()).some((p: any) => p.id === PANE)) return
  readingUsage = true
  try {
    const py = await usablePython($)
    if (!py) {
      await update($, usage, () => ({ summary: null, note: 'Token usage needs python3' }))
      return
    }
    const r = await runSafe($, [py, USAGE_READER, `${home}/.claude/projects`, `${dataDir}/usage`], { timeoutMs: 120000 })
    let summary: UsageSummary | null = null
    try {
      const d = JSON.parse(r.stdout)
      if (r.exitCode === 0 && d?.format === FORMAT && typeof d?.today === 'string' && typeof d?.hour === 'string' && d.days && d.hours) summary = d
    } catch {}
    await update($, usage, previous => (summary ? { summary, note: '' } : { summary: previous.summary, note: previous.summary ? '' : "Couldn't read token usage" }))
  } finally {
    readingUsage = false
  }
}

// The chosen period and scope are remembered (and apply to all sessions)
async function chooseUsageView($: any, change: Partial<UsageView>) {
  const next = { ...(await read($, usageView)), ...change }
  await update($, usageView, () => next)
  await storeSet($, 'usageView', next)
}

// What `claude --version` says, once every 5 minutes for all sessions (shared through the store)
async function readInstalledVersion($: any): Promise<string> {
  const now = await $.clock.now()
  const c = await storeGet($, 'installed')
  if (c && now - c.at < 300000 && typeof c.version === 'string') return c.version
  const r = await run($, [claude, '--version'])
  const v = r.exitCode === 0 ? parseVersion(r.stdout) : null
  if (v) await storeSet($, 'installed', { at: now, version: v })
  return v ?? (typeof c?.version === 'string' ? c.version : '')
}

// The installed plugin (`claude plugin list --json`), once every 5 minutes for all sessions: which version of the mod
// sessions start with, and since when, to tell which sessions should have a heartbeat. SESSIONS_PLUGIN_VERSION and
// SESSIONS_PLUGIN_SINCE (ms) stand in for it in tests
async function installedPlugin($: any): Promise<InstalledPlugin | null> {
  const version = await $.env.get('SESSIONS_PLUGIN_VERSION')
  if (version) return { path: '', version, since: Number(await $.env.get('SESSIONS_PLUGIN_SINCE')) || 0 }
  const now = await $.clock.now()
  const c = await storeGet($, 'plugin')
  if (c && now - c.at < 300000) return c.plugin ?? null
  const r = await run($, [claude, 'plugin', 'list', '--json'])
  if (r.exitCode !== 0) return c?.plugin ?? null
  const plugin = parsePluginList(r.stdout)
  await storeSet($, 'plugin', { at: now, plugin })
  return plugin
}

// The pinned sessions: the ones the background service doesn't close for being idle. It's the file Ctrl+T writes in
// `claude agents` (there's no command to pin) and the service re-reads it every time it decides
function pinsPath(): string {
  return `${jobsDir}/pins.json`
}

async function pinsFromFile($: any): Promise<string[] | null> {
  try {
    if (!(await $.fs.exists(pinsPath()))) return []
    return parsePins(await $.fs.read(pinsPath()))
  } catch {
    return null
  }
}

// The same lock Claude takes to change pins.json: a pins.json.lock folder. If it was left behind by a process that got
// cut off, after 5 s it's considered stale and removed (as Claude does). If it can't be taken within about 2 s, this
// pass does nothing
async function withLock($: any, file: string, body: () => Promise<void>) {
  const lock = `${file}.lock`
  for (let i = 0; i < 40; i++) {
    if ((await runSafe($, ['mkdir', lock])).exitCode === 0) {
      try {
        await body()
      } finally {
        await runSafe($, ['rmdir', lock])
      }
      return
    }
    try {
      const st = await $.fs.stat(lock)
      if ((await $.clock.now()) - st.mtimeMs > 5000) await runSafe($, ['rmdir', lock])
    } catch {}
    await $.clock.sleep(50)
  }
}

// Whether a background session has Remote Control: the service records its connection in the session's state
// (bridgeSessionId) while it's on, also during a relaunch, and deletes it when it's turned off. null if it couldn't be read
async function hasRemoteControl($: any, id: string): Promise<boolean | null> {
  try {
    const e = JSON.parse(await $.fs.read(`${jobsDir}/${id}/state.json`))
    return typeof e?.bridgeSessionId === 'string' && e.bridgeSessionId !== ''
  } catch {
    return null
  }
}

// Background sessions with Remote Control get pinned automatically, so the service doesn't close them after 8 idle
// hours while you drive them from your phone; when their Remote Control is turned off they get unpinned (only the ones
// the mod pinned: reconcilePins). Across all folders. Only one session does it every 20 s, the first one that finds the
// previous pass stale
let pinning = false
async function pinRemoteSessions($: any) {
  if (pinning || !jobsDir) return
  const now = await $.clock.now()
  const c = await storeGet($, 'pinPass')
  if (c && now - c.at < 15000) return
  await storeSet($, 'pinPass', { at: now })
  pinning = true
  try {
    const list = await officialList($)
    if (typeof list === 'string') return
    const remote: Record<string, boolean | null> = {}
    for (const s of list) {
      if (s.kind !== 'background' || typeof s.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s.id)) continue
      remote[s.id] = await hasRemoteControl($, s.id)
    }
    const file = pinsPath()
    await withLock($, file, async () => {
      const pins = await pinsFromFile($)
      if (!pins) return
      // With no record of what the mod pinned (a new store, or a lost one), it's rebuilt from what's there: the pinned
      // sessions with Remote Control on count as the mod's (adoptAutoPins)
      const previous = await storeGet($, 'autoPins')
      const recorded = !!previous && Array.isArray(previous.ids) && Array.isArray(previous.released)
      const auto: AutoPins = recorded ? { ids: previous.ids, released: previous.released } : adoptAutoPins(pins, remote)
      const r = reconcilePins(pins, remote, auto)
      if (r.toPin.length || r.toUnpin.length) {
        // The way Claude writes it: the list indented by 2, in a separate file that then replaces the original
        const temporary = `${file}.sessions-${myPid || 'mod'}.tmp`
        await $.fs.write(temporary, JSON.stringify(r.pins, null, 2))
        if ((await runSafe($, ['mv', '-f', temporary, file])).exitCode !== 0) {
          await runSafe($, ['rm', '-f', temporary])
          return
        }
        // When unpinning, Claude also deletes the position it had among the pinned ones
        for (const id of r.toUnpin) await runSafe($, ['rm', '-f', `${jobsDir}/${id}/order`])
      }
      if (!recorded || JSON.stringify(r.auto) !== JSON.stringify(auto)) await storeSet($, 'autoPins', r.auto)
    })
  } finally {
    pinning = false
  }
}

// Pinned sessions with Remote Control that the background service closed for lack of memory (it closes them even when
// pinned, if memory pressure stays critical) are reopened automatically once memory has been normal for 3 minutes
// straight, with the same conversation and the same Remote Control address. One per pass, and each one at most 3 times
// in 2 h (if memory fills up again right away, it doesn't insist). The reason for the closure comes from the service's
// log: one you stopped, unpinned (Ctrl+T) or that closed for another reason isn't reopened. Only one session does it
// every 20 s, the first one that finds the previous pass stale
const NORMAL_BEFORE_REOPEN = 180000
let reopening = false
async function reopenRetiredSessions($: any) {
  if (reopening || !daemonLog) return
  const now = await $.clock.now()
  const c = await storeGet($, 'reopenPass')
  if (c && now - c.at < 15000) return
  reopening = true
  try {
    const normal = await platform.memoryNormal(sys($))
    const normalSince = normal ? (typeof c?.normalSince === 'number' ? c.normalSince : now) : undefined
    await storeSet($, 'reopenPass', { at: now, normalSince })
    if (normalSince === undefined || now - normalSince < NORMAL_BEFORE_REOPEN) return
    const r = await runSafe($, ['tail', '-n', '4000', daemonLog])
    if (r.exitCode !== 0) return
    const closed = closedForLowMemory(r.stdout)
    if (Object.keys(closed).length === 0) return
    const pinned = new Set((await pinsFromFile($)) ?? [])
    const list = await officialList($)
    if (typeof list === 'string') return
    for (const s of list) {
      const when = typeof s.id === 'string' ? closed[s.id] : undefined
      if (!when || s.pid || s.kind !== 'background' || !pinned.has(s.id)) continue
      // Memory has to have been normal since after the closure (if no pass saw it, since the closure)
      if (now - Math.max(when, normalSince) < NORMAL_BEFORE_REOPEN) continue
      if (!(await hasRemoteControl($, s.id))) continue
      const previous = recentReopens(await storeGet($, `reopened:${s.sessionId}`), now)
      if (previous.length >= 3) continue
      await storeSet($, `reopened:${s.sessionId}`, [...previous, now])
      const name = s.name && s.name !== s.id ? s.name : s.id
      const done = await run($, [claude, 'respawn', s.id])
      $.ui.toast(done.exitCode === 0 ? `Reopened “${name}”: Claude had closed it for lack of memory` : `Couldn't reopen “${name}”`)
      await storeSet($, 'list', {})
      return
    }
  } finally {
    reopening = false
  }
}

// The order file the launcher reads (see orderFileText): written when the rows change, and every 20 s so it stays fresh
let lastOrder = ''
let lastOrderAt = 0
async function writeOrder($: any, list: Row[], now: number) {
  if (!dataDir || !myCwd) return
  const body = orderFileText(myCwd, sortRows(list), 0)
  if (body === lastOrder && now - lastOrderAt < 20000) return
  try {
    await $.fs.write(`${dataDir}/order/${fileKey(myCwd)}`, orderFileText(myCwd, sortRows(list), now))
    lastOrder = body
    lastOrderAt = now
  } catch {}
}

async function refresh($: any) {
  const list = await officialList($)
  if (typeof list === 'string') {
    await update($, notice, () => list)
    return
  }
  lastList = list
  const own = list.find(s => s.sessionId === myId)
  if (own?.pid) myPid = own.pid
  const pinned = new Set((await pinsFromFile($)) ?? [])
  const now = await $.clock.now()
  const project = list.filter(s => typeof s.cwd === 'string' && inProject(s.cwd, myCwd, home) && typeof s.sessionId === 'string')
  const beats = await readHeartbeats($, project.map(s => s.sessionId))
  const plugin = await installedPlugin($)
  const fresh: Row[] = []
  // Each session's version, to mark afterwards the ones with an older one than the installed version
  const versions: Record<string, string> = {}
  let newest = await readInstalledVersion($)
  for (const s of project) {
    const e = await readState($, s.sessionId)
    const seen = await seenAt($, s.sessionId)
    const unnamed = !s.name || s.name === s.id
    const ownTitle = String((await storeGet($, `title:${s.sessionId}`)) ?? '')
    // Since when it's been waiting for you: the panel records it the first time it sees it "waiting"
    let waitingSince = Number(await storeGet($, `waiting:${s.sessionId}`)) || undefined
    if (s.status === 'waiting' && !waitingSince) {
      waitingSince = now
      await storeSet($, `waiting:${s.sessionId}`, now)
    } else if (s.status !== 'waiting' && waitingSince) {
      await storeDelete($, `waiting:${s.sessionId}`)
    }
    const { color, since } = colorOf(s, e, seen, waitingSince)
    // A stopped session doesn't run any version: it opens with the installed one
    const version = color === 'gray' ? '' : e?.version || (s.pid ? await processVersion($, s.pid) : '')
    if (version) {
      versions[s.sessionId] = version
      if (compareVersions(version, newest) > 0) newest = version
    }
    const current = s.sessionId === myId
    const hb = heartbeatStatus(beats[s.sessionId] ?? null, s.pid, now)
    fresh.push({
      sessionId: s.sessionId,
      id: s.id ?? null,
      title: unnamed ? ownTitle || s.id || s.sessionId.slice(0, 8) : s.name,
      color,
      time: since ? timeSince(since, now) : '',
      model: e?.model ?? '',
      context: typeof e?.context === 'number' ? `${Math.round(e.context)}%` : '',
      current,
      background: s.kind === 'background',
      outdated: false,
      pinned: s.kind === 'background' && typeof s.id === 'string' && pinned.has(s.id),
      noPanel: !current && color !== 'gray' && hb === 'missing' && expectsHeartbeat(s, plugin, now),
      otherFormat: !current && color !== 'gray' && hb === 'other-format',
      reachable: current || (color !== 'gray' && hb === 'ok'),
    })
  }
  installedVersion = newest
  // ↑ also when a session runs an older version of this mod than the installed one (its heartbeat says which)
  const modInstalled = plugin?.version ?? ''
  for (const f of fresh) {
    const v = versions[f.sessionId]
    const mod = f.current ? modVersion : (beats[f.sessionId]?.version ?? '')
    f.outdated = (!!v && compareVersions(v, installedVersion) < 0) || (!!mod && !!modInstalled && compareVersions(mod, modInstalled) < 0)
  }
  const sorted = sortRows(fresh)
  await writeOrder($, sorted, now)
  // Claude tracks the panel's focus by position, not by session: if rows move while you're in the panel, the highlight
  // would jump to another session. With the keyboard in the panel the rows stay in place (new ones go at the end); on
  // leaving they're sorted again. If one left the list, the focus goes back to its session (or the one next to it)
  const focused = !!(await $.ui.panes()).find((p: any) => p.id === PANE)?.isFocused
  const before = (await read($, rows)).map(f => f.sessionId)
  const shown = focused
    ? [...sorted].sort((a, b) => {
        const place = (f: Row) => {
          const i = before.indexOf(f.sessionId)
          return i < 0 ? Number.MAX_SAFE_INTEGER : i
        }
        return place(a) - place(b)
      })
    : sorted
  await update($, rows, () => shown)
  const after = shown.map(f => f.sessionId)
  if (focused && currentFocus?.startsWith('s:') && before.some(id => !after.includes(id))) {
    const id = currentFocus.slice(2)
    bg(focusSession($, after.includes(id) ? id : remainingNeighbor(before, id, after)))
  }
  await update($, notice, () => '')
  await paneState($)
  await adjustWidth($)
  await prune($)
}

// The panel stays closed once you close it yourself (its close mark or key, or /sessions): what you chose wins over
// the mod opening it at start or on arrival. /sessions, or the line above the prompt's button, opens it again
async function closedByYou($: any): Promise<boolean> {
  return (await storeGet($, 'panelClosed')) === true
}

async function openByYou($: any) {
  await storeDelete($, 'panelClosed')
  await $.ui.open({ id: PANE, title: 'Sessions', focus: true, columns: requestedWidth || undefined })
  await paneState($)
}

// What the line above the prompt says about the panel: closed (by you, or gone), or waiting undrawn for a wider window
// (opened unasked, Claude draws it from 144 columns)
async function paneState($: any) {
  let note: PaneNote = ''
  try {
    const pane = (await $.ui.panes()).find((p: any) => p.id === PANE)
    note = !pane ? 'closed' : pane.isPlaced === false ? 'narrow' : ''
  } catch {}
  if (note !== (await read($, paneNote))) await update($, paneNote, () => note)
}

// When leaving a session, its panel releases the keyboard: when you come back, the text box receives you
async function releaseFocus($: any) {
  const pane = (await $.ui.panes()).find((p: any) => p.id === PANE)
  if (!pane?.isFocused) return
  await $.ui.close({ id: PANE })
  await $.ui.open({ id: PANE, title: 'Sessions', columns: requestedWidth || undefined })
}

// Asks Claude for the docked panel's width (it's a request: if the person dragged it, their width wins).
// Never reopens a panel the person closed.
async function adjustWidth($: any) {
  if (!(await $.ui.panes()).some((p: any) => p.id === PANE)) return
  if (remeasure) {
    // The window changed: reopen without asking for a width to measure "the default one" again (the render records it)
    // and adjust right away
    remeasure = false
    requestedWidth = 0
    const before = defaultWindowWidth
    await $.ui.open({ id: PANE, title: 'Sessions' })
    for (let i = 0; i < 10 && defaultWindowWidth === before; i++) await $.clock.sleep(100)
  }
  if (defaultWidth === 0) return
  const width = paneWidth((await read($, rows)).map(f => f.title), defaultWidth)
  if (width === requestedWidth) return
  requestedWidth = width
  await $.ui.open({ id: PANE, title: 'Sessions', columns: width })
}

// You arrived from another session's panel, or with ccc: the panel takes the keyboard, on the session next to this one,
// so you can keep going through them
async function focusPanel($: any) {
  // A panel you closed stays closed: you land on the prompt, and the line above it says how to open it
  if (await closedByYou($)) return
  const list = await read($, rows)
  const i = list.findIndex(f => f.current)
  const find = (from: number, step: number) => {
    for (let k = from; k >= 0 && k < list.length; k += step) if (!list[k]?.current) return list[k]
    return undefined
  }
  await takeKeyboard($, (find(i + 1, 1) ?? find(i - 1, -1))?.sessionId)
}

// The panel takes the keyboard, on a session. Claude gives the panel the keyboard a moment after it's requested, on the
// row that was selected in the previous render, so the focus is moved to the chosen row afterwards. It works with no
// window attached too: the keyboard is the panel's when the window attaches
async function takeKeyboard($: any, sessionId: string | undefined) {
  if (sessionId) selectedRow = `s:${sessionId}`
  await $.ui.open({ id: PANE, title: 'Sessions', focus: true, columns: requestedWidth || undefined })
  if (sessionId) await focusSession($, sessionId)
}

async function focusSession($: any, sessionId: string | undefined) {
  if (sessionId) await focusElement($, `s:${sessionId}`)
}

// Moves the panel's focus (it already has the keyboard or is about to) to an element: a session or a field. While
// Claude is settling the focus it rejects another change ("the focus moved meanwhile"), so it retries a bit. The
// ui.focus hook doesn't hear about changes the mod itself requests: they're recorded here. If you moved with the arrows
// meanwhile, the focus isn't fought over.
// A field that appears with autoFocus does NOT take the focus if the panel already had the keyboard: the focus goes by
// position and lands on whatever is in that spot now (a row, and what you were typing went somewhere else). That's
// why it's moved here
async function focusElement($: any, key: string) {
  const moves = personMoves
  for (let i = 0; i < 15; i++) {
    if (personMoves !== moves) return
    let panes: any[] = []
    try {
      panes = await $.ui.panes()
    } catch {
      return
    }
    if (panes.find((p: any) => p.id === PANE)?.isFocused) {
      let r: any
      try {
        r = await $.ui.focus({ requestId: PANE, key })
      } catch (err) {
        r = { deny: String(err) }
      }
      if (personMoves !== moves) return
      if (!r?.deny) {
        currentFocus = key
        if (key.startsWith('s:')) selectedRow = key
        return
      }
    }
    await $.clock.sleep(100)
  }
}

// The window of an agent view that's showing a session right now (its ⟨id⟩ tag is on screen), except the front one
async function agentsViewShowing($: any, v: { agentsViews: { pid: string; tty: string }[] }, sessionId: string, except: string): Promise<string | undefined> {
  const tag = `⟨${sessionId.slice(0, 8)}⟩`
  for (const c of v.agentsViews) {
    if (c.tty === except) continue
    if ((await platform.readWindow(sys($), c.tty)).includes(tag)) return c.tty
  }
  return undefined
}

// A notice to another session's mod (see buildNotice), only if it answers: its heartbeat says it runs and speaks this
// format. Anything else would reach that session's model as text
async function sendNotice($: any, f: Row, kind: NoticeKind, data: Record<string, unknown> = {}): Promise<boolean> {
  if (!f.reachable || f.current) return false
  try {
    await $.session.send({ to: { sessionId: f.sessionId }, text: buildNotice(kind, data) })
    return true
  } catch {
    return false
  }
}

// Switches the front window to another session. With notifyFocus set to false, the target doesn't take the keyboard
// with its panel (when it's about to show a question, or when it'll do so itself afterwards)
async function jump($: any, f: Row, notifyFocus = true): Promise<boolean> {
  if (f.current) return false
  // If the jump was made with the keyboard in the panel, the target session receives you with the focus on its panel.
  // When leaving, this session's panel releases the keyboard
  const fromKeyboard = notifyFocus && !!(await $.ui.panes()).find((p: any) => p.id === PANE)?.isFocused
  const notifyAndRelease = async () => {
    if (fromKeyboard) await sendNotice($, f, 'focus')
    await releaseFocus($)
  }
  // A regular session lives in its own window: bring that one forward, whichever is in front. If it runs where the
  // panel can't reach (another terminal app, tmux, an editor), say so instead of doing nothing
  if (!f.background) {
    const s = lastList.find(x => x.sessionId === f.sessionId)
    const tty = s?.pid ? (await windows($)).byPid[String(s.pid)] : undefined
    if (!tty || !(await platform.bringWindow(sys($), tty, f.title))) {
      $.ui.toast(platform.text.regularUnreachable(f.title))
      return false
    }
    await notifyAndRelease()
    return true
  }
  const front = await frontWindowShowingMe($)
  if (!front) {
    $.ui.toast(platform.text.switchNeedsWindow)
    return false
  }
  await notifyAndRelease()
  const v = await windows($)
  // If it's already open in another window, bring that one: never the same session in two windows. Look among the
  // viewers (claude attach <id>) and among the agent views, which don't say which session they show: read their
  // screen looking for its tag
  const target = (f.id ? v.byId[f.id]?.find(t => t !== front) : undefined) ?? (await agentsViewShowing($, v, f.sessionId, front))
  if (target) {
    if (await platform.bringWindow(sys($), target, f.title)) return true
    // Where it can't be brought forward (Linux without wmctrl/xdotool, or Wayland), show it in this window too
    if (!platform.showHereIfCantBring) {
      $.ui.toast(`Couldn't bring the window showing “${f.title}”`)
      return false
    }
  }
  if (!f.id) {
    $.ui.toast(`Can't find the window for “${f.title}”`)
    return false
  }
  if (await switchInPlace($, { command: 'attach', id: f.id, title: f.title }, front)) return true
  // This window can't switch (it wasn't opened with ccc): open another one next to it, same size and position, with
  // the launcher
  const opened = await platform.openWindow(sys($), front, `${DOT[f.color]} ${f.title}`, launcherCommand({ command: 'attach', id: f.id, title: f.title }))
  $.ui.toast(opened ? `Opened “${f.title}” in a new window: this one wasn't opened with ccc, so it can't switch` : platform.text.cantOpen(f.title))
  return opened
}

// What's being asked: stop a running session, remove a stopped one from the list, or restart one. The values are sent
// to other sessions (the topic field of the ask notice)
type Topic = 'stop' | 'remove' | 'restart'

// The question, with Claude's dialog. Cancel, Esc or hand-typed text do nothing
async function askDialog($: any, title: string, topic: Topic, detail = ''): Promise<Action | null> {
  const extra = detail ? ` ${detail}` : ''
  const question =
    topic === 'remove'
      ? `Remove “${title}” from the list? The conversation is kept.`
      : topic === 'restart'
        ? `Restart “${title}”?${extra} It reloads MCP servers, plugins and settings; the conversation is kept.`
        : `Stop “${title}”?${extra} The conversation is kept either way.`
  const options = topic === 'remove' ? REMOVE_OPTIONS : topic === 'restart' ? RESTART_OPTIONS : STOP_OPTIONS
  try {
    return actionFromAnswer(await $.ui.ask(question, { options, header: 'Sessions' }))
  } catch {
    return null
  }
}

// Does what was chosen to another session. Stop and Remove: stops it and/or removes it from the list, and closes the
// windows that showed it (never one showing this session; with closeWindows false, none: that's when the window you're
// in still shows that session). Restart: claude respawn, the same session with its conversation in a process running
// the installed version; the windows with a launcher that showed it reopen it on their own
async function perform($: any, f: Row, action: Action, closeWindows = true) {
  if (!f.id) return
  if (action === 'restart') {
    const v = await windows($)
    for (const tty of v.byId[f.id] ?? []) {
      if (!v.launchers[tty] || !dataDir) continue
      try {
        await $.fs.write(windowFile(tty), windowTargetText({ command: 'attach', id: f.id, title: f.title }))
      } catch {}
    }
    const r = await run($, [claude, 'respawn', f.id])
    if (r.exitCode !== 0) {
      $.ui.toast(`Couldn't restart “${f.title}”`)
    } else {
      // The ↑ mark goes away right away, without waiting for the new session to record its version
      const e = await readState($, f.sessionId)
      if (e && installedVersion) await storeSet($, `state:${f.sessionId}`, { ...e, version: installedVersion })
      $.ui.toast(`“${f.title}” restarted${f.outdated && installedVersion ? ` on Claude ${installedVersion}` : ''}`)
    }
    await storeSet($, 'list', {})
    await refresh($)
    return
  }
  const before = action === 'rm' ? [] : ((await windows($)).byId[f.id] ?? [])
  if (action !== 'rm') {
    const r = await run($, [claude, 'stop', f.id])
    if (r.exitCode !== 0) {
      $.ui.toast(`Couldn't stop “${f.title}”`)
      return
    }
  }
  if (action !== 'stop') {
    const r = await run($, [claude, 'rm', f.id])
    if (r.exitCode !== 0) $.ui.toast(`Couldn't remove “${f.title}” from the list`)
  }
  await storeSet($, 'list', {})
  await refresh($)
  if (closeWindows && before.length) {
    await $.clock.sleep(1500)
    const mine = await myWindows($)
    for (const tty of before.filter(t => !mine.includes(t))) await platform.closeWindow(sys($), tty)
  }
}

// After an action from the panel, the keyboard goes back to the panel, on the same row (or the one next to it if it
// left the list)
async function focusRow($: any, sessionId: string, fallback: string | undefined) {
  const ids = (await read($, rows)).map(f => f.sessionId)
  await takeKeyboard($, ids.includes(sessionId) ? sessionId : fallback && ids.includes(fallback) ? fallback : ids[0])
}

// The tasks a session has running in the background even while it's idle (artifact watches don't count).
// The background service records them in its state; if the file isn't there or changed shape, it's unknown (null)
async function backgroundTasks($: any, id: string): Promise<{ count: number; kinds: string[] } | null> {
  if (!jobsDir) return null
  try {
    return realTasks(JSON.parse(await $.fs.read(`${jobsDir}/${id}/state.json`))?.inFlight)
  } catch {
    return null
  }
}

// What gets added to the question: whether it's busy (Restart cuts what it's doing) and whether it has background tasks
// (they get cut too). A background terminal task already shows it as busy; watching an artifact's comments doesn't
async function detailFor($: any, f: Row, topic: Topic): Promise<string> {
  if (topic === 'remove' || !f.id) return ''
  const busy = f.color === 'blue' || f.color === 'red'
  const bg = await backgroundTasks($, f.id)
  const n = bg?.count ?? 0
  const verb = topic === 'restart' ? 'restarting it now' : 'stopping it'
  const tasks = n > 0 ? `${n === 1 ? '1 task' : `${n} tasks`} in the background${bg?.kinds.length ? ` (${bg.kinds.join(', ')})` : ''}` : ''
  const version = topic === 'restart' && f.outdated && installedVersion ? ` It also moves to Claude ${installedVersion}.` : ''
  const panel = topic === 'restart' && f.noPanel ? " Its panel isn't running: a restart starts it." : ''
  if (busy && tasks) return `It's busy, with ${tasks}: ${verb} cuts them.${version}${panel}`
  if (tasks) return `It has ${tasks}: ${verb} cuts ${n === 1 ? 'it' : 'them'}.${version}${panel}`
  if (busy && topic === 'restart') return `It's busy: ${verb} cuts what it's doing.${version}${panel}`
  return `${version}${panel}`.trim()
}

// Stop or Restart from the panel. The question shows up in the session being acted on: the window goes to that
// session, you answer there and the window comes back here with the keyboard in the panel. This session does what was
// chosen (that one can't stop or restart itself and then hand the window back to you). If going there isn't a good
// idea (stopped, already waiting for you, its mod doesn't answer, no Terminal window in front), it's asked here.
async function decide($: any, f: Row, topic: Topic) {
  if (!f.id) return
  const detail = await detailFor($, f, topic)
  const ids = (await read($, rows)).filter(x => !x.current).map(x => x.sessionId)
  const fallback = neighbor(ids, f.sessionId)
  // If that session is already waiting for you (a permission, a question), this question would queue up behind that one
  // and on arriving you'd answer its own by mistake: so it's asked here.
  // First go there, then send the question: if going failed, no question is left waiting where nobody sees it
  const askThere = topic !== 'remove' && f.color !== 'red' && f.reachable
  if (askThere && (await frontWindowShowingMe($)) && (await jump($, f, false))) {
    pendingAsk = { sessionId: f.sessionId, at: await $.clock.now(), fallback }
    if (!(await sendNotice($, f, 'ask', { from: myId, topic, detail }))) {
      pendingAsk = undefined
      $.ui.toast(`Couldn't ask “${f.title}”; nothing was changed`)
    }
    return
  }
  const action = await askDialog($, f.title, topic, detail)
  if (action) await perform($, f, action)
  await focusRow($, f.sessionId, fallback)
}

// In the session being acted on: the question shows up here; once answered, the window goes back to the session it was
// asked from and the answer is handed to it so it does it
async function answerQuestion($: any, from: string, topic: Topic, detail: string) {
  const own = (await read($, rows)).find(f => f.current)
  const action = await askDialog($, own?.title ?? 'this session', topic, detail)
  const origin = (await read($, rows)).find(f => f.sessionId === from)
  const cameBack = origin ? await jump($, origin, false) : false
  if (origin) await sendNotice($, origin, 'answer', { sessionId: myId, action: action ?? 'cancel', cameBack })
}

// Back in this session: do what was chosen over there (only if it's the answer to the question that was sent)
async function receiveAnswer($: any, data: Record<string, unknown>) {
  const now = await $.clock.now()
  if (!pendingAsk || pendingAsk.sessionId !== data.sessionId || now - pendingAsk.at > 600000) return
  const { fallback } = pendingAsk
  pendingAsk = undefined
  const f = (await read($, rows)).find(x => x.sessionId === data.sessionId)
  const action = data.action
  // If the window couldn't come back here, it still shows that session: it isn't closed
  if (f && (action === 'stop' || action === 'stop-rm' || action === 'restart')) await perform($, f, action, data.cameBack === true)
  await focusRow($, String(data.sessionId), fallback)
}

// The session selected with the arrows (for s, u and r), yours too; if there isn't one or it can't be used, say so
async function selectedSession($: any, purpose: 'stop' | 'restart'): Promise<Row | undefined> {
  const f = (await read($, rows)).find(x => `s:${x.sessionId}` === selectedRow)
  if (!f) {
    $.ui.toast('Select a session with ↑↓ first')
    return undefined
  }
  // Stopping the session you're looking from leaves you without a window: it's done from another one's panel
  if (f.current && purpose === 'stop') {
    $.ui.toast("To stop the session you're in, use another session's panel")
    return undefined
  }
  if (!f.id) {
    const which = f.current ? 'This session' : `“${f.title}”`
    $.ui.toast(purpose === 'stop' ? `${which} isn't a background session: close it with /exit` : `${which} isn't a background session: /exit and run claude -c`)
    return undefined
  }
  return f
}

// The s key: stops the selected session (or removes it from the list if it was already stopped), with its question
async function stopSelected($: any) {
  const f = await selectedSession($, 'stop')
  if (f) await decide($, f, f.color === 'gray' ? 'remove' : 'stop')
}

// The u key: restarts the selected session, this one too: a new process with the same conversation, which re-reads the
// MCP servers, plugins and settings, and moves to the installed Claude version. It always asks. If the other one is in
// the middle of something (working, waiting for you or with background tasks), the question goes to that session, like
// Stop, so you see what you'd cut; if it's idle, or its mod doesn't answer, it's asked here
async function restartSelected($: any) {
  const f = await selectedSession($, 'restart')
  if (!f) return
  if (f.color === 'gray') {
    $.ui.toast(`“${f.title}” is stopped: Enter opens it with the latest settings`)
    return
  }
  if (f.current) {
    await restartSelf($, f)
    return
  }
  // The panel's color can be a few seconds old: what it's doing is asked now, to the official list
  const status = await statusNow($, f.sessionId)
  if (status === undefined || status === null) {
    $.ui.toast(`“${f.title}” isn't running: Enter opens it with the latest settings`)
    return
  }
  if (status !== 'idle') {
    await decide($, { ...f, color: status === 'waiting' ? 'red' : 'blue' }, 'restart')
    return
  }
  // Idle, but with background tasks (or no way to know): ask over there, because restarting it cuts them
  const bg = await backgroundTasks($, f.id as string)
  if (!bg || bg.count > 0) {
    await decide($, f, 'restart')
    return
  }
  const action = await askDialog($, f.title, 'restart', await detailFor($, f, 'restart'))
  if (action === 'restart') await perform($, f, 'restart')
  await focusRow($, f.sessionId, undefined)
}

// Restart this very session. Its process ends, so first the windows showing it with a launcher (opened with ccc) are
// told to reopen it: the viewers close and the launchers reopen it with the new process. A window without a launcher
// doesn't come back by itself: the question says so
async function restartSelf($: any, f: Row) {
  const id = f.id
  if (!id) return
  const v = await windows($)
  const returning = (v.byId[id] ?? []).filter(tty => v.launchers[tty])
  const front = await frontWindowShowingMe($)
  const stranded = !!front && !returning.includes(front)
  const extra = stranded ? " This window wasn't opened with ccc, so it won't reopen by itself: run ccc here afterwards." : ''
  const action = await askDialog($, f.title, 'restart', `${await detailFor($, f, 'restart')}${extra}`.trim())
  if (action !== 'restart') {
    await focusRow($, f.sessionId, undefined)
    return
  }
  // The ↑ mark goes away right away, and the new process announces on startup that it was restarted
  const e = await readState($, myId)
  if (e && installedVersion) await storeSet($, `state:${myId}`, { ...e, version: installedVersion })
  await storeSet($, `restarted:${myId}`, await $.clock.now())
  for (const tty of returning) {
    try {
      await $.fs.write(windowFile(tty), windowTargetText({ command: 'attach', id, title: f.title }))
    } catch {}
  }
  // claude respawn ends this process. Run as a child of this session, it went away with it before starting it again
  // (the session was left stopped): so it's run detached, in its own process session (fork + setsid, with perl, which
  // is on macOS and on Linux), and it carries on alone once this one is gone
  await runSafe($, [
    'perl',
    '-MPOSIX',
    '-e',
    'fork and exit; POSIX::setsid(); fork and exit; open STDIN, "<", "/dev/null"; open STDOUT, ">", "/dev/null"; open STDERR, ">", "/dev/null"; exec @ARGV or exit 1',
    claude,
    'respawn',
    id,
  ])
  // If this session is still here after 15 s, it wasn't restarted: the launchers mustn't reopen it when you close the
  // viewer, and you're told
  await $.clock.sleep(15000)
  for (const tty of returning) await runSafe($, ['rm', '-f', windowFile(tty)])
  await storeDelete($, `restarted:${myId}`)
  $.ui.toast(`Couldn't restart “${f.title}”`)
}

// What a session is doing right now (busy, waiting, idle; null if it isn't running), bypassing the shared list cache
async function statusNow($: any, sessionId: string): Promise<string | null | undefined> {
  const r = await run($, [claude, 'agents', '--json', '--all'])
  if (r.exitCode !== 0) return 'busy'
  const list = validateList(r.stdout)
  // If it can't be known, it's treated as busy: ask before cutting anything
  if (typeof list === 'string') return 'busy'
  const s = list.find(x => x.sessionId === sessionId)
  return s ? (s.status ?? null) : undefined
}

// One random hex digit, for automatic names
function hexDigit(): string {
  const b = new Uint8Array(1)
  crypto.getRandomValues(b)
  return ((b[0] ?? 0) % 16).toString(16)
}

async function createSession($: any, name: string) {
  await update($, askingName, () => false)
  // Enter without a name: an automatic one after the folder, like the names Claude gives regular sessions
  // ("myapp-1f"), not used by another session of the project
  const taken = lastList.filter(x => typeof x.cwd === 'string' && inProject(x.cwd, myCwd, home)).flatMap(x => [x.name, x.id].filter(Boolean))
  const clean = name.trim() || autoName(myCwd, taken, hexDigit)
  const since = (await $.clock.now()) - 5000
  const debug = debugLogs && dataDir ? ['--debug-file', `${dataDir}/debug/${debugLogName(clean)}`] : []
  const r = await run($, [claude, '--bg', '-n', clean, ...debug])
  if (r.exitCode !== 0) {
    $.ui.toast(`Couldn't create “${clean}”`)
    return
  }
  // Without parsing the output text: the new session is looked up in the official list (JSON), by name and start time
  for (let attempt = 0; attempt < 6; attempt++) {
    await refresh($)
    const s = lastList
      .filter(x => x.name === clean && x.cwd === myCwd && (x.startedAt ?? 0) >= since)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
    const f = s && (await read($, rows)).find(x => x.sessionId === s.sessionId)
    if (f) {
      await jump($, f)
      return
    }
    await $.clock.sleep(500)
  }
  $.ui.toast(`Created “${clean}” but can't find it in the list`)
}

// While the New or Rename field is open you stay in it: Enter does it (an empty field cancels) and Esc cancels. Tab
// and the arrows keep the focus in the field (the ui.focus hook). Esc is Claude's own key for leaving the pane and the
// mod gets no event for it, so a short watcher closes the field as soon as the pane loses the keyboard; otherwise the
// field stayed open, the next visit to the pane landed in it, and every key (r included) was typed into it
async function closeFields($: any) {
  await update($, askingName, () => false)
  await update($, renaming, () => null)
}

let fieldWatch = 0
async function watchField($: any) {
  const mine = ++fieldWatch
  // Up to about 12 minutes; a newer watcher (the field opened again) replaces this one
  for (let i = 0; i < 2400 && mine === fieldWatch; i++) {
    try {
      await $.clock.sleep(300)
    } catch {
      return
    }
    if (mine !== fieldWatch) return
    if (!(await read($, askingName)) && !(await read($, renaming))) return
    let focused = true
    try {
      focused = !!(await $.ui.panes()).find((p: any) => p.id === PANE)?.isFocused
    } catch {
      return
    }
    if (!focused) {
      await closeFields($)
      return
    }
  }
}

// The r key: asks for the new name of the session selected with the arrows in a field (if there's no other session in
// the list, this one's). The field starts empty: with the current name prefilled, whatever you typed was appended to
// the end
async function toggleRename($: any) {
  if (await read($, renaming)) {
    await update($, renaming, () => null)
    return
  }
  const list = await read($, rows)
  const f = list.find(x => `s:${x.sessionId}` === selectedRow) ?? (list.every(x => x.current) ? list.find(x => x.current) : undefined)
  if (!f) {
    $.ui.toast('Select a session with ↑↓ first (to rename this one, use /rename)')
    return
  }
  if (f.color === 'gray') {
    $.ui.toast(`“${f.title}” is stopped: open it and use /rename there`)
    return
  }
  await update($, askingName, () => false)
  await update($, renaming, () => ({ sessionId: f.sessionId, title: f.title }))
  bg(focusElement($, 'rename-input'))
  bg(watchField($))
}

// The n key: opens the field for the new session's name and moves the focus to it
async function toggleNew($: any) {
  await update($, renaming, () => null)
  const open = !(await read($, askingName))
  await update($, askingName, () => open)
  if (open) {
    bg(focusElement($, 'name'))
    bg(watchField($))
  }
}

// With Enter in the field, the session is renamed with its own /rename, the official one: it changes the name in every
// session's list, in claude agents and on the phone. This one, directly; another one, by asking its mod with a notice
// (it runs it when it finishes what it's doing)
async function rename($: any, text: string) {
  const r = await read($, renaming)
  await update($, renaming, () => null)
  // The focus goes back to the renamed session's row (the field that had it is gone)
  if (r && r.sessionId !== myId) bg(focusSession($, r.sessionId))
  const name = text.trim().replace(/\s+/g, ' ').slice(0, 80)
  if (!r || !name || name === r.title) return
  try {
    if (r.sessionId === myId) {
      await $.command.run({ command: 'rename', args: name })
      return
    }
    const f = (await read($, rows)).find(x => x.sessionId === r.sessionId)
    if (f && (await sendNotice($, f, 'rename', { name }))) {
      $.ui.toast(`Renaming “${r.title}” to “${name}”…`)
    } else {
      $.ui.toast(`“${r.title}” doesn't answer (its panel isn't running, or runs another version): use /rename there`)
    }
  } catch {
    $.ui.toast(`Couldn't rename “${r.title}”`)
  }
}

async function openAgentsView($: any) {
  const front = await frontWindowShowingMe($)
  if (!front) {
    $.ui.toast(platform.text.agentsNeedsWindow)
    return
  }
  await releaseFocus($)
  const v = await windows($)
  for (const c of v.agentsViews) {
    // An agent view for this folder: if it's the window you're in, there's nothing to do; else bring it forward
    if ((await platform.processCwd(sys($), c.pid)) !== myCwd) continue
    if (c.tty === front || (await platform.bringWindow(sys($), c.tty, 'Agents'))) return
  }
  if (await switchInPlace($, agentsTarget(), front)) return
  if (!(await platform.openWindow(sys($), front, 'Agents', launcherCommand(agentsTarget())))) {
    $.ui.toast(platform.text.cantOpenAgents)
  }
}

// The project root (rootFrom): the nearest folder upwards with AGENTS.md or CLAUDE.md, else where the session started
async function projectRoot($: any): Promise<string> {
  const root = String(await $.session.root())
  let markers: readonly any[] = []
  try {
    markers = await $.fs.ancestors({ names: ['AGENTS.md', 'CLAUDE.md'] })
  } catch {}
  return rootFrom(root, markers.map(m => String(m.dir)))
}

function truncate(text: string, width: number): string {
  const chars = Array.from(text)
  return chars.length <= width ? text : `${chars.slice(0, Math.max(1, width - 1)).join('')}…`
}

// Each session publishes its model and the % of context used (the same as the status line), only if they changed
async function publishUsage($: any) {
  let model = ''
  let context: number | undefined
  let version = ''
  try {
    model = shortModelName(String(await $.session.model()))
    context = (await $.session.usage())?.context?.percent
    version = String((await $.session.version())?.version ?? '')
  } catch {
    return
  }
  const previous = (await readState($, myId)) ?? {}
  if (previous.model === model && previous.context === context && previous.version === version) return
  await storeSet($, `state:${myId}`, { ...previous, created: previous.created ?? (await $.clock.now()), model, context, version })
}

// After restarting with u from its own panel, the notice is shown when the window reconnects: at startup nobody is
// looking yet, and the session.attach event doesn't arrive for a claude attach (only for the phone, the app or VS
// Code). The window is detected by its processes: a claude attach of this session. It waits up to 30 s
async function notifyWhenBack($: any) {
  const list = await officialList($)
  const id = typeof list === 'string' ? undefined : list.find(s => s.sessionId === myId)?.id
  if (!id) return
  for (let i = 0; i < 60; i++) {
    if (((await windows($)).byId[id] ?? []).length > 0) {
      await $.clock.sleep(1500)
      $.ui.toast('Restarted: MCP servers, plugins and settings reloaded')
      return
    }
    await $.clock.sleep(500)
  }
}

async function markTurnStart($: any) {
  const previous = (await readState($, myId)) ?? {}
  await storeSet($, `state:${myId}`, { ...previous, turnStarted: await $.clock.now() })
}

async function recordTitle($: any) {
  if (await storeGet($, `title:${myId}`)) return
  const first = (await $.session.messages()).find((m: any) => m.role === 'user' && m.text?.trim())
  if (first) await storeSet($, `title:${myId}`, first.text.trim().split('\n')[0].slice(0, 50))
}

// A request from the launcher in this session's inbox (see InboxRequest): consumed once, then acted on
let checkingInbox = false
async function checkInbox($: any) {
  if (checkingInbox || !dataDir || !myId) return
  const path = `${dataDir}/inbox/${myId}`
  checkingInbox = true
  try {
    if (!(await $.fs.exists(path))) return
    let text = ''
    try {
      text = await $.fs.read(path)
    } catch {}
    await runSafe($, ['rm', '-f', path])
    const r = parseInbox(text)
    if (!r) return
    const answer = async (result: 'ok' | 'failed', reason = '') => {
      if (!r.reply.startsWith(`${dataDir}/replies/`)) return
      try {
        await $.fs.write(r.reply, keyLines({ format: FORMAT, result, reason }))
      } catch {}
    }
    if (r.format !== FORMAT) {
      $.ui.toast('ccc runs another version of the sessions mod than this session: restart it (u, or claude respawn)')
      await answer('failed', 'another version')
      return
    }
    if ((await $.clock.now()) - r.at > 30000) return
    debugLine($, `inbox: ${r.action}`)
    if (r.action === 'focus') {
      await focusPanel($)
    } else if (r.action === 'bring') {
      const ok = !!r.tty && (await platform.bringWindow(sys($), r.tty, r.title))
      await answer(ok ? 'ok' : 'failed', ok ? '' : platform.text.cantBring)
    }
  } finally {
    checkingInbox = false
  }
}

// /clear starts a new conversation in the same session: its id changes (the short id that claude attach takes doesn't)
// and no session.start comes. /resume can do the same. The mod keeps going with the new id: the session's own record
// moves over (minus what belonged to the old conversation), and so do its heartbeat and its inbox
async function rebind($: any) {
  let id = ''
  try {
    id = String(await $.session.id())
  } catch {
    return
  }
  if (!id || !myId || id === myId) return
  const old = myId
  myId = id
  debugLine($, `rebind: ${old} → ${id}`)
  await update($, shortId, () => id.slice(0, 8))
  const previous = await readState($, old)
  const existing = await readState($, id)
  const now = await $.clock.now()
  await storeSet($, `state:${id}`, existing ?? { created: previous?.created ?? now, model: previous?.model, context: undefined, version: previous?.version })
  const seen = await storeGet($, `seen:${old}`)
  if (seen && !(await storeGet($, `seen:${id}`))) await storeSet($, `seen:${id}`, seen)
  for (const k of ['state', 'seen', 'title', 'waiting', 'restarted']) await storeDelete($, `${k}:${old}`)
  await runSafe($, ['rm', '-f', `${dataDir}/alive/${old}`, `${dataDir}/inbox/${old}`])
  try {
    await beat($)
  } catch {}
  await storeSet($, 'list', {})
  bg(refresh($))
}

// A newer version of this mod is installed: update this session's in place with /reload-plugins, when that cuts
// nothing (reloadDecision). The new copy says so when it starts ("Panel updated"). /reload-plugins reloads every
// plugin of the session; a Claude update, settings and MCP servers still need u (a restart). If the update doesn't
// take, the ↑ mark stays and u is the way
async function updateInPlace($: any) {
  if (!active || !myId) return
  const plugin = await installedPlugin($)
  const own = lastList.find(s => s.sessionId === myId)
  const quick = reloadDecision({
    running: modVersion,
    runningDir: PLUGIN_DIR.replace(/\/hooks\/\.\.$/, ''),
    installed: plugin,
    triedFor: reloadTriedFor,
    status: 'idle',
    tasks: 0,
    paneFocused: false,
    fieldOpen: false,
  })
  if (quick !== 'reload' || !plugin) return
  const panes = await $.ui.panes()
  const tasks = own?.id ? ((await backgroundTasks($, own.id))?.count ?? null) : 0
  const decision = reloadDecision({
    running: modVersion,
    runningDir: PLUGIN_DIR.replace(/\/hooks\/\.\.$/, ''),
    installed: plugin,
    triedFor: reloadTriedFor,
    status: await statusNow($, myId),
    tasks,
    paneFocused: !!panes.find((p: any) => p.id === PANE)?.isFocused,
    fieldOpen: (await read($, askingName)) || !!(await read($, renaming)),
  })
  if (decision !== 'reload') return
  reloadTriedFor = plugin.version
  await storeSet($, `reloaded:${myId}`, { from: modVersion, to: plugin.version, at: await $.clock.now() })
  debugLine($, `updating in place: ${modVersion} → ${plugin.version}`)
  try {
    await $.command.run({ command: 'reload-plugins' })
  } catch {}
}

// The new copy, after updating in place: say so (only if it really is the new version)
async function announceUpdate($: any) {
  const r = await storeGet($, `reloaded:${myId}`)
  if (!r || typeof r !== 'object') return
  if ((await $.clock.now()) - Number(r.at) > 120000) {
    await storeDelete($, `reloaded:${myId}`)
    return
  }
  if (r.to !== modVersion) return
  await storeDelete($, `reloaded:${myId}`)
  $.ui.toast(`Panel updated to ${modVersion}`)
}

// /sessions status: whether and how the mod started here, who this session is, which copy of the mod runs, and which
// sessions of the project have no running panel
async function statusText($: any): Promise<string> {
  const now = await $.clock.now()
  const ago = (t: number) => (t ? `${Math.max(0, Math.round((now - t) / 1000))} s ago` : 'never')
  const dir = PLUGIN_DIR.replace(/\/hooks\/\.\.$/, '')
  const plugin = await installedPlugin($)
  const copy = plugin?.path && plugin.path === dir ? `installed (${plugin.version})` : `folder copy: ${dir}${plugin?.version ? ` (installed: ${plugin.version})` : ''}`
  const rowsNow = await read($, rows)
  const silent = rowsNow.filter(f => f.noPanel || f.otherFormat).map(f => `${f.title} (${f.noPanel ? 'no heartbeat' : 'another version'})`)
  const lines = [
    `sessions ${modVersion || '?'} · ${copy}`,
    `Running here: started ${ago(startedAt)} by ${startedVia || 'nothing'}${startedVia !== 'session.start' ? (sawSessionStart ? ' (session.start came later)' : ' (session.start never came)') : ''}`,
    `Session: ${myId} · project: ${myCwd}`,
    `Heartbeat: ${lastBeat ? `written ${ago(lastBeat)}` : 'not written'} (${dataDir}/alive)`,
    silent.length ? `No panel running in: ${silent.join(', ')}` : 'Every session of the project that should run a panel does',
  ]
  if (startProblems.length) lines.push(`Start problems: ${startProblems.join('; ')}`)
  return lines.join('\n')
}

// Starts the mod in this session, once (see `starting`). The steps that can fail go one by one, each on its own, so one
// that fails doesn't take the rest with it, and in order of need: who this session is, where its files are, its
// record and its heartbeat, the timers, the panel, and /sessions last
function ensureStarted($: any, via: string): Promise<void> {
  if (!starting) {
    startedVia = via
    starting = start($)
  }
  return starting
}

async function start($: any) {
  try {
    startedAt = await $.clock.now()
  } catch {}
  const step = async (name: string, body: () => Promise<unknown>) => {
    try {
      await body()
      debugLine($, `start (${startedVia}): ${name}`)
    } catch (err) {
      startProblems.push(`${name}: ${String(err).slice(0, 200)}`)
      debugLine($, `start (${startedVia}): ${name} failed: ${String(err).slice(0, 200)}`)
    }
  }
  await step('session id', async () => {
    myId = String(await $.session.id())
    await update($, shortId, () => myId.slice(0, 8))
  })
  await step('folders', async () => {
    home = (await $.env.get('HOME')) ?? ''
    dataDir = (await $.env.get('SESSIONS_DATA_DIR')) || (home ? `${home}/.claude/mods/sessions-data` : '')
    jobsDir = (await $.env.get('SESSIONS_JOBS_DIR')) || (home ? `${home}/.claude/jobs` : '')
    daemonLog = (await $.env.get('SESSIONS_DAEMON_LOG')) || (home ? `${home}/.claude/daemon.log` : '')
    if (dataDir) {
      const sub = ['alive', 'order', 'inbox', 'windows', 'replies', 'debug', 'usage'].map(d => `${dataDir}/${d}`)
      await runSafe($, ['mkdir', '-p', ...sub])
    }
    myCwd = await projectRoot($)
  })
  await step('settings for the launcher', async () => {
    if (!dataDir) return
    const text = keyLines({ format: FORMAT, debug: debugLogs ? 1 : 0 })
    let current = ''
    try {
      current = await $.fs.read(`${dataDir}/config`)
    } catch {}
    if (current !== text) await $.fs.write(`${dataDir}/config`, text)
  })
  await step('claude and platform', async () => {
    const fixed = await $.env.get('SESSIONS_CLAUDE')
    const which = fixed ? { exitCode: 0, stdout: fixed } : await runSafe($, ['/bin/sh', '-lc', 'command -v claude'])
    if (which.exitCode === 0 && which.stdout.trim()) claude = which.stdout.trim()
    platform = await choosePlatform(sys($))
    try {
      modVersion = String(JSON.parse(await $.fs.read(`${PLUGIN_DIR}/.claude-plugin/plugin.json`))?.version ?? '')
    } catch {}
  })
  await step('state', async () => {
    const e = (await readState($, myId)) ?? {}
    await storeSet($, `state:${myId}`, { ...e, created: e.created ?? (await $.clock.now()) })
  })
  await step('heartbeat', () => beat($))
  await step('update notice', () => announceUpdate($))
  await step('timers', async () => {
    // If this session was restarted from its own panel (u), announce that it's back
    const restartedAt = Number(await storeGet($, `restarted:${myId}`)) || 0
    if (restartedAt) {
      await storeDelete($, `restarted:${myId}`)
      if ((await $.clock.now()) - restartedAt < 120000) bg(notifyWhenBack($))
    }
    // A New or Rename field left open before a reload or a restart would come back stuck in the pane: start closed
    await closeFields($)
    const view = await storeGet($, 'usageView')
    if (view && ['day', 'week', 'month'].includes(view.period) && ['all', 'project'].includes(view.scope)) {
      await update($, usageView, () => ({ period: view.period, scope: view.scope }))
    }
    $.clock.every(500, () => {
      bg(checkInbox($))
    })
    $.clock.every(3000, () => {
      bg(refresh($))
    })
    $.clock.every(2000, () => {
      bg(markSeenIfLooking($))
    })
    $.clock.every(15000, () => {
      void (async () => {
        await rebind($)
        await beat($).catch(() => {})
        await publishUsage($)
        await updateInPlace($)
      })().catch(() => {})
    })
    $.clock.every(60000, () => {
      bg(readUsage($))
    })
    $.clock.every(20000, () => {
      bg(pinRemoteSessions($))
      bg(reopenRetiredSessions($))
    })
    active = true
    bg(refresh($))
    void recordTitle($).catch(() => {})
    bg(publishUsage($))
    bg(pinRemoteSessions($))
  })
  await step('panel', async () => {
    if (!(await closedByYou($))) {
      await $.ui.open({ id: PANE, title: 'Sessions', columns: requestedWidth || undefined })
      bg(readUsage($))
    }
    await paneState($)
  })
  await step('command', () =>
    $.command.register({
      name: 'sessions',
      description: 'Sessions panel: open, focus or close. /sessions status: is the mod running here. /sessions setup: status line, shortcuts and the ccc command',
      argumentHint: '[status | setup [--dry-run] [--force-statusline] [--macos-launcher] [--shell=bash|zsh|fish]]',
      immediate: true,
    }),
  )
}

export const register: Register = (on, options) => {
  debugLogs = options?.debugLogs === true
  // In a non-interactive run (claude -p) the mod does nothing. The start isn't awaited before next(e): a step that hangs
  // mustn't hold the session up
  on('session.start', async ($, e, next) => {
    if (e.isInteractive) {
      sawSessionStart = true
      bg(ensureStarted($, 'session.start'))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear (and /resume) keep this process and change the session's id: follow it
    if (active && (e.reason === 'clear' || e.reason === 'resume')) {
      $.clock.after(300, () => {
        void (async () => {
          for (let i = 0; i < 10; i++) {
            await rebind($)
            if (String(await $.session.id()) === myId) return
            await $.clock.sleep(500)
          }
        })().catch(() => {})
      })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (active) await markTurnStart($)
    return next(e)
  })

  // A turn triggered by another session (SendMessage) doesn't go through turn.start. Notices from another session's
  // panel are intercepted here: they aren't queued, aren't shown and the model doesn't read them
  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'peer' && e.origin.plugin === 'sessions' && e.text.includes(NOTICE_MARKER)) {
      bg(ensureStarted($, 'notice'))
      const n = parseNotice(e.text)
      if (!n || n.format !== FORMAT) {
        $.ui.toast('A session running another version of the sessions mod sent this one a notice: restart them (u)')
        return { consumed: 'sessions: a notice in another format' }
      }
      const d = n.data
      if (n.kind === 'focus') {
        if (active) bg(focusPanel($))
        return { consumed: 'sessions: focus the panel after a switch' }
      }
      if (n.kind === 'ask') {
        const from = String(d.from ?? '')
        const detail = typeof d.detail === 'string' ? d.detail.slice(0, 300) : ''
        if (active && from) bg(answerQuestion($, from, d.topic === 'restart' ? 'restart' : 'stop', detail))
        return { consumed: 'sessions: ask here about stopping or restarting this session' }
      }
      if (n.kind === 'answer') {
        if (active) bg(receiveAnswer($, d))
        return { consumed: 'sessions: the answer to a stop question' }
      }
      if (n.kind === 'rename') {
        const name = typeof d.name === 'string' ? d.name.trim().slice(0, 80) : ''
        if (active && name) void $.command.run({ command: 'rename', args: name }).catch(() => {})
        return { consumed: "sessions: rename this session from another session's panel" }
      }
      return { consumed: 'sessions: an unknown notice' }
    }
    if (active) await markTurnStart($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (active && e.agentId === undefined) {
      const answer = String(e.answer ?? '').trim()
      const line =
        answer
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)
          .at(-1) ?? ''
      const state: SessionState = {
        ...((await readState($, myId)) ?? {}),
        finished: await $.clock.now(),
        reason: e.reason,
        answer: line.slice(0, 70),
        question: line.endsWith('?'),
      }
      await storeSet($, `state:${myId}`, state)
      void recordTitle($).catch(() => {})
      bg(publishUsage($))
    }
    return r
  })

  // Typing in the box (or from the phone) counts as having seen the session; a message from another session doesn't
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'composer' || e.origin?.kind === 'bridge') {
      bg(ensureStarted($, 'prompt'))
      if (active) await storeSet($, `seen:${myId}`, await $.clock.now())
    }
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async ($, e) => {
    // /sessions setup: the one-time setup (setup/setup.sh) for what a plugin can't configure by itself. Only its own
    // options are passed on, as separate arguments (no shell in between)
    const words = String(e.args ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (words[0] === 'status') return { text: await statusText($) }
    if (words[0] === 'setup') {
      const allowed = /^--(dry-run|force-statusline|macos-launcher|statusline|keys|alias|all|help|shell=(bash|zsh|fish))$/
      const bad = words.slice(1).filter(w => !allowed.test(w))
      if (bad.length) return { text: `Unknown option: ${bad.join(' ')} (see /sessions setup --help)` }
      const r = await runSafe($, ['bash', `${PLUGIN_DIR}/setup/setup.sh`, ...words.slice(1)], { timeoutMs: 60000 })
      return { text: (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim() || `setup exited with code ${r.exitCode}` }
    }
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane?.isFocused) {
      await storeSet($, 'panelClosed', true)
      await $.ui.close({ id: PANE })
      await paneState($)
      return { text: '' }
    }
    await openByYou($)
    bg(readUsage($))
    return { text: '' }
  })

  // You closed the panel (its close mark or key): it stays closed in every session that starts, until you open it again.
  // The mod's own closes (to release the keyboard, to measure its width) don't count
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE && e.origin.kind === 'person') {
      await storeSet($, 'panelClosed', true)
      await update($, paneNote, () => 'closed')
    }
    return r
  })

  // The arrows (and Tab) only go through the sessions: they skip the [stop] buttons and don't leave the list towards the
  // buttons below or the panel's markers; those are reached with their key (n, a, s) or with the mouse
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person') {
      const r = await next(e)
      if (!r.deny && e.element) {
        currentFocus = e.element
        // On entering the panel the focus lands on a session by itself: if none was selected (or the selected one is
        // gone), that one stays, so s stops it without moving the arrows
        const selected = (await read($, rows)).some(f => `s:${f.sessionId}` === selectedRow)
        if (e.element.startsWith('s:') && !selected) selectedRow = e.element
      }
      return r
    }
    personMoves++
    // With the New or Rename field open, Tab and the arrows stay in it (Enter or Esc get you out)
    const field = (await read($, askingName)) ? 'name' : (await read($, renaming)) ? 'rename-input' : null
    if (field) return e.element === field ? next(e) : next({ ...e, element: field })
    const list = await read($, rows)
    const sessions = list.map(f => `s:${f.sessionId}`)
    if (sessions.length === 0) return next(e)
    let target = e.element
    if (!target?.startsWith('s:')) {
      const k = currentFocus ? sessions.indexOf(currentFocus) : -1
      if (k < 0) {
        // You just entered the panel (or came from a button below): the first arrow goes to the first session
        target = sessions[0]
      } else if (target?.startsWith('x:')) {
        // The selected session's [stop] comes after it (going down); the one above's, before it (going up)
        const down = target.slice(2) === (currentFocus as string).slice(2)
        target = sessions[Math.max(0, Math.min(sessions.length - 1, k + (down ? 1 : -1)))]
      } else {
        // The buttons below, the name field or a panel marker (also when Claude wraps around): don't leave the list.
        // Put the focus back on the selected session instead of doing nothing: if it ended up somewhere else (a field
        // that closed and shifted the positions), the arrows bring it back instead of getting stuck
        return next({ ...e, element: currentFocus as string })
      }
    }
    if (target === currentFocus) return {}
    const r = target === e.element ? await next(e) : await next({ ...e, element: target })
    if (!r.deny && target) {
      currentFocus = target
      if (target.startsWith('s:')) selectedRow = target
    }
    return r
  })

  // The line above the prompt: how many sessions wait for you (red) or have something unseen (yellow), why the panel
  // isn't shown (with a button that opens it: shift+→ then Enter, or a click), and this session's short id. One row.
  // Its first draw starts the mod when nothing else did (a session draws even with no window attached; a draw only
  // draws, so the start runs from a timer)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    if (!starting && !renderScheduled) {
      renderScheduled = true
      $.clock.after(0, () => {
        bg(ensureStarted($, 'first draw'))
      })
    }
    const others = (await read($, rows)).filter(f => !f.current)
    const reds = others.filter(f => f.color === 'red').length
    const yellows = others.filter(f => f.color === 'yellow').length
    const id = await read($, shortId)
    const note = await read($, paneNote)
    const why = note === 'closed' ? 'panel closed · /sessions to open' : note === 'narrow' ? 'panel hidden: window too narrow · /sessions to show' : ''
    const counts = (
      <Text dimColor>
        {reds > 0 && <Text color={TINT.red}>● </Text>}
        {reds > 0 && `${reds}  `}
        {yellows > 0 && <Text color={TINT.yellow}>● </Text>}
        {yellows > 0 && `${yellows}  `}
        {reds + yellows > 0 && !why && '/sessions  '}
      </Text>
    )
    if (!why || e.surface !== 'terminal') {
      return (
        <Text dimColor>
          {counts}
          {why && `${why}  `}⟨{id}⟩
        </Text>
      )
    }
    return (
      <Box flexDirection="row">
        {counts}
        <Button key="show-panel" plain dimColor label={why} onPress={() => { bg(openByYou($)) }} />
        <Text dimColor>{`  ⟨${id}⟩`}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
    const list = await read($, rows)
    const asking = await read($, askingName)
    const renamingRow = await read($, renaming)
    const note = await read($, notice)
    // Jumping and creating only make sense in Terminal; on the phone, VS Code or the app the list is read-only
    const inTerminal = e.surface === 'terminal'
    // One line per session. If it still doesn't fit, Claude uses ↑↓ to scroll instead of moving the focus: say so
    const height = (e.viewport?.rows ?? 40) - 6
    // Window width = conversation (viewport.columns) + panel + border. With no requested width, the panel has "the
    // default one": it's recorded as the cap. If the window changes later, adjustWidth measures it again (it runs on
    // every refresh, every 3 s)
    if (e.viewport?.isFullscreen && e.viewport.columns && e.props.bodyColumns) {
      const windowWidth = e.viewport.columns + e.props.bodyColumns + 1
      if (requestedWidth === 0) {
        defaultWidth = e.props.bodyColumns
        defaultWindowWidth = windowWidth
      } else if (windowWidth !== defaultWindowWidth) {
        remeasure = true
      }
    }
    const marks = list.some(f => f.noPanel || f.otherFormat)
    const overflows = list.length + 6 + (note !== '' ? 1 : 0) > height
    // The usage block (4 lines and one of spacing) goes at the bottom of the panel, only with the panel docked at the
    // side and if it fits without making the list overflow. To keep it at the bottom, the panel takes its full height
    // and a flexible spacer pushes the block down
    const view = await read($, usageView)
    const usageData = await read($, usage)
    const bodyRows: number | undefined = e.props.scroll?.bodyRows
    const room = bodyRows ?? height
    const showUsage =
      inTerminal &&
      e.props.placement === 'dock' &&
      list.length + 6 + (note !== '' ? 1 : 0) + (list.some(f => f.outdated) ? 1 : 0) + (list.some(f => f.pinned) ? 1 : 0) + (marks ? 1 : 0) + 5 <= room
    const help = e.props.isFocused ? (overflows ? 'Tab Next · ↑↓ Scroll · Enter Switch · Esc Back' : '↑↓ Select · Enter Switch · ← Back') : 'shift+→ to use the panel'
    // Columns: [▌][● ][name…][↑][◆][ model  ctx  time]; in narrow panels the model is left out
    // Rows use only the width they need: in the box above the prompt (small windows or not fullscreen) the panel takes
    // the whole screen, and without this the model and time would end up far away from the name
    const total = Math.min(e.props.bodyColumns ?? 48, paneWidth(list.map(f => f.title), e.props.bodyColumns ?? 48)) - 1
    const showModel = total >= 44
    const infoWidth = showModel ? 20 : 10
    const nameWidth = Math.max(8, total - 4 - infoWidth)
    const padRight = (t: string, w: number) => t + ' '.repeat(Math.max(0, w - displayWidth(t)))
    const padLeft = (t: string, w: number) => ' '.repeat(Math.max(0, w - displayWidth(t))) + t
    const info = (f: Row) => `${showModel ? `  ${padRight(f.model, 9)}` : ''} ${padLeft(f.context, 4)} ${padLeft(f.time, 4)}`
    const name = (f: Row) => padRight(truncate(f.title, nameWidth), nameWidth)
    // ↑: runs an older Claude version than the installed one; !: its panel isn't running there, or runs another version
    // (u restarts it). Both take the first space after the name
    const mark = (f: Row) =>
      f.noPanel || f.otherFormat ? <Text color={TINT.yellow}>!</Text> : <Text color="claude">{f.outdated ? '↑' : ' '}</Text>
    // On entering the panel (ctrl+x tab) the focus goes to a session: the last selected one, or the first
    const jumpable = list.filter(f => !f.current)
    const initial = (list.find(f => `s:${f.sessionId}` === selectedRow) ?? jumpable[0] ?? list[0])?.sessionId
    return (
      <Box flexDirection="column" height={showUsage && bodyRows ? bodyRows : undefined}>
        {/* A single line of actions at the top: the letters are buttons (key or click), followed by the keyboard help */}
        {inTerminal && (
          <Box flexDirection="row" flexWrap="wrap">
            <Button key="stop" plain dimColor hotkey="s" label="Stop" onPress={() => { bg(stopSelected($)) }} />
            <Text dimColor> · </Text>
            <Button key="restart" plain dimColor hotkey="u" label="Restart" onPress={() => { bg(restartSelected($)) }} />
            <Text dimColor> · </Text>
            <Button key="rename" plain dimColor hotkey="r" label="Rename" onPress={() => { bg(toggleRename($)) }} />
            <Text dimColor> · </Text>
            <Button key="new" plain dimColor hotkey="n" label="New" onPress={() => toggleNew($)} />
            <Text dimColor> · </Text>
            <Button key="agents" plain dimColor hotkey="a" label="Agents" onPress={() => { bg(openAgentsView($)) }} />
            <Text dimColor>{` · ${help}`}</Text>
          </Box>
        )}
        <Text> </Text>
        {note !== '' && <Text color="warning">{note}</Text>}
        {list.length === 0 && <Text dimColor>No other sessions in this folder.</Text>}
        {list.map(f => {
          // The session you're in: the theme's soft background and a bar in Claude's color. It's selected with the
          // arrows like the others (for u and r, even if it's the only one in the list); Enter there doesn't jump anywhere
          if (f.current) {
            return (
              <Box key={`row:${f.sessionId}`} flexDirection="row" backgroundColor="userMessageBackground">
                <Text color="claude">▌</Text>
                <Text color={TINT[f.color]}>●</Text>
                <Text> </Text>
                {inTerminal ? (
                  <Button
                    key={`s:${f.sessionId}`}
                    plain
                    autoFocus={f.sessionId === initial && !asking && !renamingRow ? true : undefined}
                    label={name(f)}
                    onPress={() => $.ui.toast("You're in this session")}
                  />
                ) : (
                  <Text bold>{name(f)}</Text>
                )}
                {mark(f)}
                <Text>{f.pinned ? '◆' : ' '}</Text>
                <Text dimColor>{padRight(info(f), total - 4 - nameWidth).slice(1)}</Text>
              </Box>
            )
          }
          return (
            <Box key={`row:${f.sessionId}`} flexDirection="row">
              <Text> </Text>
              <Text color={TINT[f.color]}>●</Text>
              <Text> </Text>
              {inTerminal ? (
                <Button
                  key={`s:${f.sessionId}`}
                  plain
                  autoFocus={f.sessionId === initial && !asking && !renamingRow ? true : undefined}
                  label={name(f)}
                  onPress={() => { bg(jump($, f)) }}
                />
              ) : (
                <Text>{name(f)}</Text>
              )}
              {/* ◆: pinned, the background service doesn't close it for being idle */}
              {mark(f)}
              <Text>{f.pinned ? '◆' : ' '}</Text>
              <Text dimColor>{info(f).slice(1)}</Text>
            </Box>
          )
        })}
        {/* The New and Rename fields go below the rows: above them, opening or closing shifted the rows by one, and since
            Claude tracks the focus by position, what you typed landed on another row or the focus ended up on d: Day */}
        {inTerminal && Input && asking && (
          <Input key="name" label="Name" placeholder="session name, or Enter for one after the folder (Esc cancels)" autoFocus onSubmit={(v: string) => { void createSession($, v).catch(() => {}) }} />
        )}
        {inTerminal && Input && renamingRow && !asking && (
          <Input
            key="rename-input"
            label={`Rename “${truncate(renamingRow.title, 24)}”`}
            placeholder="new name (Esc cancels)"
            autoFocus
            onSubmit={(v: string) => { bg(rename($, v)) }}
          />
        )}
        <Text> </Text>
        <Text dimColor>
          <Text color={TINT.red}>●</Text> Attention  <Text color={TINT.blue}>●</Text> Working  <Text color={TINT.yellow}>●</Text> Done  <Text color={TINT.green}>●</Text> Idle  <Text color={TINT.gray}>●</Text> Stopped
        </Text>
        {list.some(f => f.outdated) && (
          <Text dimColor>
            <Text color="claude">↑</Text>
            {' A newer Claude or panel is installed · u: Restart'}
          </Text>
        )}
        {marks && (
          <Text dimColor>
            <Text color={TINT.yellow}>!</Text>
            {' Panel not running there · u: Restart'}
          </Text>
        )}
        {list.some(f => f.pinned) && <Text dimColor>◆ Pinned (auto with Remote Control)</Text>}
        {/* Tokens spent: period (d, w, m) and scope (p: all of Claude or this project); bars per hour or per day */}
        {showUsage && <Box flexGrow={1} minHeight={1} />}
        {showUsage && (
          <Box flexDirection="row" flexWrap="wrap">
            <Button key="usage-day" plain dimColor={view.period !== 'day' ? true : undefined} hotkey="d" label="Day" onPress={() => { bg(chooseUsageView($, { period: 'day' })) }} />
            <Text dimColor> · </Text>
            <Button key="usage-week" plain dimColor={view.period !== 'week' ? true : undefined} hotkey="w" label="Week" onPress={() => { bg(chooseUsageView($, { period: 'week' })) }} />
            <Text dimColor> · </Text>
            <Button key="usage-month" plain dimColor={view.period !== 'month' ? true : undefined} hotkey="m" label="Month" onPress={() => { bg(chooseUsageView($, { period: 'month' })) }} />
            <Text dimColor> · </Text>
            <Button
              key="usage-scope"
              plain
              hotkey="p"
              label={view.scope === 'all' ? 'All' : 'Project'}
              onPress={() => { bg(chooseUsageView($, { scope: view.scope === 'all' ? 'project' : 'all' })) }}
            />
          </Box>
        )}
        {showUsage && !usageData.summary && <Text dimColor>{usageData.note || 'Reading token usage…'}</Text>}
        {showUsage &&
          usageData.summary &&
          (() => {
            const includes = view.scope === 'all' ? () => true : (cwd: string) => inProject(cwd, myCwd, home)
            const w = usageWindow(usageData.summary, view.period, includes)
            const [input = 0, output = 0, cacheRead = 0, cacheWritten = 0, thinking = 0] = w.totals
            const sumLabel = abbreviate(input + output + cacheRead + cacheWritten)
            const barsWidth = Math.max(4, total - displayWidth(sumLabel) - 2)
            return (
              <Box flexDirection="column">
                <Text>
                  <Text color="claude">{padRight(sparkline(w.bars, barsWidth), barsWidth)}</Text>
                  <Text>{`  ${sumLabel}`}</Text>
                </Text>
                {/* in is all the input: the new part and what comes from the cache (Claude re-reads the conversation on
                    every response, almost all of it from the cache, so the new part is few tokens per response) */}
                <Text dimColor>{`in ${abbreviate(input + cacheRead + cacheWritten)}${input + cacheRead + cacheWritten > 0 ? ` (${Math.round((cacheRead / (input + cacheRead + cacheWritten)) * 100)}% cached)` : ''} · out ${abbreviate(output)}${thinking ? ` (think ${abbreviate(thinking)})` : ''}`}</Text>
                {/* written: what's new at each step (messages, command results, files) plus what gets stored again when
                    the cache expired; uncached: the little that comes in without going through the cache */}
                <Text dimColor>{`cache ${abbreviate(cacheRead)} read · ${abbreviate(cacheWritten)} written · ${abbreviate(input)} uncached`}</Text>
              </Box>
            )
          })()}
      </Box>
    )
  })
}
