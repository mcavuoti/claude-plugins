import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type {
  AgentRole,
  Color,
  EndedNote,
  PaneNote,
  PanelSummary,
  RateLimit,
  Renaming,
  Row,
  Sessions,
  SessionsApi,
  SessionsMethod,
  SessionsResult,
  SessionsStatus,
  TellInFlight,
  Usage,
  UsageView,
  Watching,
} from '../types'

import {
  abbreviate,
  AGENT_ROW,
  agentFromFlags,
  agentFromTranscript,
  assignChange,
  formatUsd,
  limitsText,
  publishedSpend,
  spendOf,
  emptySectionsFile,
  groupRows,
  keepPlaces,
  NO_SECTIONS,
  parseSectionsFile,
  personAssign,
  pruneMembers,
  emptyPluginSections,
  dropSections,
  refOf,
  drawPlan,
  foldRows,
  ringKeys,
  refocusTarget,
  sectionsFileText,
  sectionsView,
  setMember,
  checkSectionSpec,
  upsertSection,
  waitingMembers,
  checkMarks,
  mergeMarks,
  NO_MARK,
  type MarkSlot,
  type RowMark,
  type SectionsFile,
  type SectionsView,
  type Action,
  actionFromAnswer,
  askRejection,
  UNSHOWN,
  reconcilePins,
  adoptAutoPins,
  keepPluginPins,
  pluginPinChange,
  pluginPinsOf,
  paneWidth,
  buildNotice,
  sparkline,
  stoppedKind,
  stopLog,
  diedWithService,
  endedShown,
  endedText,
  bringBackOptions,
  bringBackQuestion,
  bringBackResult,
  type EndedSession,
  stopReasons,
  storeNamespace,
  wakeStagger,
  afterTick,
  rowsBelow,
  shellQuote,
  isRef,
  type StopLog,
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
  orderOrphanRoot,
  ORDER_ORPHAN_MS,
  rootFrom,
  rootCandidates,
  worktreeBase,
  belongsTo,
  outsideNote,
  parseTranscriptStarts,
  type Whereabouts,
  sortRows,
  windowTargetText,
  SHOWING,
  type Showing,
  parseShowing,
  showingRuns,
  planSwitch,
  autoName,
  bgRefusal,
  checkStart,
  type StartRequest,
  debugLogName,
  reloadDecision,
  TELL_MAX_BYTES,
  tellStatusText,
  parseTellRequest,
  tellPrompt,
  tellIdIn,
  type TellState,
  addSpend,
  dayOf,
  dueWaits,
  howLong,
  inQuietHours,
  isStale,
  parseQuietHours,
  sentToday,
  spendBurst,
  median,
  usualHour,
  type SpendLedger,
  spendIsHigh,
  spendLine,
  spendText,
  waitText,
  type QuietHours,
  type SpendAlert,
  type Wait,
  FORMAT,
  NOTICE_MARKER,
  sameData,
  labelMinute,
  listSignature,
  listHolds,
  LIST_MS,
  nextSeenCheck,
  sessionTags,
  usageSummaryOf,
  type ListedFile,
  nextLabelChange,
  SESSION_TOOLS,
  TOOLS_WAIT_MS,
  type SessionTool,
  roleTools,
  modelWakesOf,
  wakeLimit,
  pickSession,
  stoppedWords,
  type ToolRow,
  toolListText,
  agentAddress,
  WOKEN_MARK_MS,
  wokenLine,
  clockText,
  sessionHome,
} from './state'
import { choosePlatform, macos, type Me, type Platform, type Run, type Shown } from './platform'
import { bellFrom, bellOfKey, bellText, classify, jobIds, listDrift, ownWatchedFolders, SessionFiles, type Listed as FileListed, WATCH_SET, watchPaths, watchSetOf, type Locations, type RegistryEntry, type RegistryNews } from './watch'
import { electLeader, LEADER_STALE_MS, leaderText, leads, parseLeader, PASS_MS, type Candidate } from './leader'

const PANE = 'sessions'

const DOT: Record<Color, string> = { red: '🔴', blue: '🔵', yellow: '🟡', green: '🟢', gray: '⚫' }
// The spend column's width, a space included ("$20.04")
const SPEND_COLUMN = 7
// Another plugin's badge after the name: a space and up to 3 columns
const BADGE_COLUMN = 4
// A child session is drawn this many columns in, under its parent
const INDENT = 2
// The helpers column: a space, ⚙ (one column) and the largest count
function helperColumn(list: readonly Row[]): number {
  const most = Math.max(0, ...list.map(f => f.helpers))
  return most > 0 ? 2 + String(most).length : 0
}
// The columns taken beside the names when any row needs them: children's indent, badges and helpers
function markColumns(list: readonly Row[]): number {
  return (list.some(f => f.depth > 0) ? INDENT : 0) + (list.some(f => f.badge) ? BADGE_COLUMN : 0) + helperColumn(list)
}
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
// The account's rate-limit windows, as this session's last response reported them (empty off a subscription), for the
// line above the prompt
const limits = atom({ plugin: 'sessions', key: 'limits' } as const, [] as RateLimit[])
// About all the project's rows, whatever is shown: the f filter, how many there are, what they spent
const summary = atom({ plugin: 'sessions', key: 'summary' } as const, { waitingOnly: false, sessions: 0, waiting: 0, unseen: 0, spent: null } as PanelSummary)
// The ccc tell request on its way to a turn (checkTells): in $.state, which a reload of the mod's code keeps
const tellInFlight = atom({ plugin: 'sessions', key: 'tellInFlight' } as const, null as TellInFlight)
// What this session's classic.SessionStart had the engine watch (watch.ts): in $.state, which a reload keeps as the
// engine keeps the watched paths; null when no SessionStart of this mod came in this session
const watching = atom({ plugin: 'sessions', key: 'watching' } as const, null as Watching)
// The line about the sessions that ended with the background service (endedText), or null: in every session's panel
const ended = atom({ plugin: 'sessions', key: 'ended' } as const, null as EndedNote)
// The folder this session works in when that's outside its project (followHere), or '': its panel says so in one line
const away = atom({ plugin: 'sessions', key: 'away' } as const, '')
// The agent this session runs as, from its last classic.SessionStart (agent_type), or where none came from Claude's files
// (roleFromFiles): in $.state, which a reload keeps, so a reload decides the same about the tools for Claude
// (offerTools); null when nothing said it in this session
const agentRole = atom({ plugin: 'sessions', key: 'agentRole' } as const, null as AgentRole)

// Every write of a value the panel or the band reads draws them again, equal or not (the engine compares nothing): so
// each one is written only when its data changed (sameData), and a refresh that finds nothing new draws nothing. The
// engine's scan wants each value named where it's read or written, hence the same comparison at every write

let claude = 'claude'
let myId = ''
let myPid = 0
// The project root: the project this session belongs to, the one it started in (settleProject), wherever it works now
// (hereNow: the folder Claude lists it in, which a worktree move and /cd change; followHere)
let myCwd = ''
let hereNow = ''
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
// When the official list was last read (0: not yet), and this project's rows as the last refresh built them, before
// any layout (what $.sessions answers from)
let listedAt = 0
let projectRows: Row[] = []
// The sections (sections.json) as the last refresh read them, and why they couldn't be read (shown as the notice)
let sectionsNow: SectionsView = NO_SECTIONS
let sectionsProblem = ''
// The agent this session runs as (`claude --agent`), read once per session id from its transcript (agentFor)
let myAgent: string | null = null
let agentFor = ''
// The f filter: on (the person's choice, shared by every session through the store key waitingOnly) and who's in it
// (waitingMembers: a snapshot, kept while the panel has the keyboard)
let waitingOnly = false
let waitingSnapshot: Set<string> | null = null
// The row selected with the arrows (the session button's key, "s:<sessionId>") and the element that has the focus now
let selectedRow: string | undefined
let currentFocus: string | undefined
// Panel width: what the content needs, capped at the width Claude gives it on its own ("the default one").
// That cap is measured by opening the panel without asking for a width, and measured again if the window size changes.
let requestedWidth = 0
let defaultWidth = 0
let defaultWindowWidth = 0
// What the panel's last draw saw, fullscreen: its width, the window's (conversation + panel + border) and the width the
// mod had asked for then (0: none). The draw only notes it, and when it differs from the one before has adjustWidth run
// from a timer: nothing is decided or written while drawing
let paneSeen: { body: number; window: number; asked: number } | null = null
// The session that was asked whether to stop: only its answer is accepted, and only for a while. fallback is the row
// that stays selected if it leaves the list: its neighbor in the list you were looking at when you pressed Stop
let pendingAsk: { sessionId: string; at: number; fallback?: string; topic: Topic; detail: string; target: Row } | undefined
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
// The plugin's options for telling the person (see "Telling the person" in state.ts): a push once a session has waited
// waitPushMinutes (0: never), none in quietHours, at most notificationsPerDay notifications of any kind a day, and the ⧗
// on rows working, or done and unseen, for staleMinutes (0: never)
let waitPushMs = 600000
let quietHours: QuietHours | null = null
let quietHoursText = ''
let notificationsPerDay = 5
let staleMs = 3600000
// The plugin's option for the tools Claude gets (mcp__sessions__list and mcp__sessions__wake, "Tools for Claude" below):
// on unless the person turned it off
let sessionTools = true
// The installed version this session's mod already tried to update itself to (once per version), and the one it
// can't, since it watches another set of paths (said once in the debug log)
let reloadTriedFor = ''
let watchRefusedFor = ''
const startProblems: string[] = []

// ---- Push (watch.ts, leader.ts) ----
// Where the watched files are; the sessions as Claude's files show them (null until the mod starts); live: the engine
// watches this session's paths (its classic.SessionStart of this WATCH_SET came, in this module or in one before it in
// this session: the watching state), else the panel reads them on a short timer (the poll); reloadedInto: this module
// came in by a reload (another module had drawn in this session before), so a missing SessionStart means the paths
// watched are an older version's and only a restart (u) or /clear brings it, unless this machine's starts find none at
// all (startSkipped: a plugin before this one sends it on past it); slowList: the files can't stand for
// `claude agents` (see SessionFiles.usable), which is then run as before, at most every 3.5 s
let locations: Locations = { registry: '', data: '', jobs: '' }
let sessionFiles: SessionFiles | null = null
let live = false
let reloadedInto = false
let slowList = false
// This session's background job (its short id), found in the registry when SessionStart asks what to watch
let ownJob: string | null = null
// Whether this session leads the machine-wide work (leader.ts), and when it last did each part of it
let leading = false
// Another session leads, as this one's last turn saw it (it lists, reads the usage and runs the shared commands)
let leaderElsewhere = false
let reconciledAt = 0
let usageRunAt = 0
let leaderWrittenAt = 0
// This session's own status from its own turn hooks, ahead of the registry (which comes 0.6 s later): it stands while
// it's newer than the registry's statusUpdatedAt, for 10 s at most
let ownHint: { status: string; at: number } | null = null

// Where the mod's commands run: the home folder (/ until it's known, or if it's missing), never the session's own
// folder. A command left to inherit the session's folder can't start once that folder is gone (a worktree the session
// left and that was then deleted), and then every command fails. A command that needs the project passes it itself
let workDir = '/'

// A command that can't be run (it doesn't exist on this computer: Linux has no osascript or ioreg, and lsof isn't
// always there) or that didn't finish in time counts as one more failure (exit code 127), instead of aborting
// everything that called it
// What ccc hands its launcher (the installed plugin's version and since when) is for the launcher alone. A claude command
// run with them would pass them on: to the background service, when that command is what starts it, and from there to
// every session the service starts, whose mod would keep its data apart (a store namespace, as a test session's). So
// every command runs with both blank, which reads as not set everywhere (the mod, launcher.py, ccc); $.process.run's env
// only sets over the session's, it can't unset
const LAUNCHER_ONLY: Record<string, string> = { SESSIONS_PLUGIN_VERSION: '', SESSIONS_PLUGIN_SINCE: '' }

async function runSafe(
  $: any,
  argv: string[],
  init?: { stdin?: string; timeoutMs?: number; cwd?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    return await $.process.run(argv, { ...init, cwd: init?.cwd || workDir, env: LAUNCHER_ONLY })
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: String(err) }
  }
}

async function run($: any, argv: string[], cwd?: string) {
  return runSafe($, argv, { cwd, timeoutMs: 15000 })
}

async function exists($: any, path: string): Promise<boolean> {
  try {
    return !!(await $.fs.exists(path))
  } catch {
    return false
  }
}

// A small file that changes now and then (pins.json, sections.json, a background session's state in the service's
// folder), read again only when it changed: one stat (its time and size) where there was an exists and a read, and the
// text kept from the last read when it didn't move. null when it isn't there; a read that fails throws
const fileCache = new Map<string, { mtimeMs: number; size: number; text: string }>()
async function readIfChanged($: any, path: string): Promise<string | null> {
  let st: any
  try {
    st = await $.fs.stat(path)
  } catch {
    fileCache.delete(path)
    return null
  }
  const held = fileCache.get(path)
  if (held && held.mtimeMs === st.mtimeMs && held.size === st.size) return held.text
  const text = String(await $.fs.read(path))
  if (fileCache.size > 200) fileCache.clear()
  fileCache.set(path, { mtimeMs: Number(st.mtimeMs), size: Number(st.size), text })
  return text
}

// The platform's commands run through runSafe, with this hook's $
function sys($: any): Run {
  return (argv, init) => runSafe($, argv, init)
}

// This session's short id, the one `claude attach` takes and the agent view shows: the official list's. It stays across
// /clear while the session id changes, so it isn't the session id's start once the session was cleared; that start is
// only the fallback until the list has this session
function myShortId(): string {
  const id = lastList.find(s => s.sessionId === myId)?.id
  return typeof id === 'string' && id ? id : myId.slice(0, 8)
}

function me(): Me {
  return { shortId: myShortId(), pid: myPid || undefined, background: lastList.find(s => s.sessionId === myId)?.kind === 'background' }
}

// Work started and not awaited: a failure (or the mod being reloaded meanwhile) is dropped quietly
function bg(work: Promise<unknown>) {
  work.catch(() => {})
}

// A timer's job runs once at a time: a tick that comes while its last run is still going is skipped. On a slow machine
// (after a sleep, under an endpoint scanner) the ticks would otherwise pile up behind each other, each starting commands
const runningJobs = new Set<string>()
function solo(name: string, job: () => Promise<unknown>): Promise<unknown> {
  if (runningJobs.has(name)) return Promise.resolve()
  runningJobs.add(name)
  return job().finally(() => runningJobs.delete(name))
}

// After a sleep every session's timers fire at once. A gap between two of this session's ticks longer than 30 s (afterTick)
// is a sleep (or a stall): the list-reading jobs then wait this session's own offset (wakeStagger: 0-10 s, from its id)
// before running, so the sessions don't all list together
let ticks = { last: 0, quietUntil: 0 }
async function justWoke($: any): Promise<boolean> {
  const t = afterTick(ticks, await $.clock.now(), wakeStagger(myId))
  ticks = { last: t.last, quietUntil: t.quietUntil }
  return t.quiet
}

// A line in the debug log only (claude --debug, or --debug-file), when the option is on
function debugLine($: any, text: string) {
  if (!debugLogs) return
  try {
    void Promise.resolve($.ui.log(`sessions: ${text}`, { to: 'debug' })).catch(() => {})
  } catch {}
}

// Data shared between sessions: the mod's official store ($.store), a JSON file managed by Claude. Keys:
// state:<id> (SessionState: what each session publishes about itself), seen:<id> (seen at), title:<id> (title from the
// first prompt), waiting:<id> (waiting since), project:<id> (the project that session belongs to, recorded at its first
// start: root, from, at; settleProject),
// restarted:<id> (restarted from its own panel at), reopened:<id> (reopen times), list (the session list claude
// agents gave: at, when the listing came back; sessions; sig, what Claude's registry and the service's folder looked
// like just before; until, when a slow or failed listing pushed the next one back; one listing at a time, under the
// <data>/list.lock folder),
// installed (installed Claude version: at, version) and plugin (the installed plugin: at, plugin), both also pendingAt,
// a session running the command right now (sharedAnswer), usageView, pinPass (last auto-pin pass),
// autoPins (AutoPins), pluginPins (PluginPins: the sessions other plugins keep pinned through $.sessions.pin),
// reopenPass (last reopen pass, and normalSince: since when memory has been normal),
// panelClosed (you closed the panel: sessions start without it until you open it again), reloaded:<id> (this
// session's mod updated itself with /reload-plugins: from, to, at, and focus, the row selected when the panel had the
// keyboard: s:<sessionId>, h:<section> or ''), waitingOnly (the f filter is on),
// marks:<source>:<sessionId> (the marks that session of that plugin set: MarkSlot in state.ts), collapsed (the
// sections the person folded, by id), needsSince:<id> (since when a plugin's mark says it needs the person: since, and
// at, when a panel last saw it so), pushed:<id> (the since of the wait the person was last pushed about), spend:<id>
// (SpendLedger in state.ts), pushCount (the notifications sent today: day, count), lastPush (the last one: at, text,
// from, and what the phone and the notification channel answered), windowsList and frontWindow (the windows listing
// and the window in front, shared by the seen check for SEEN_WINDOWS_MS and FRONT_SHARED_MS: at, windows / tty, and
// frontWindow's tags, the sessions an agent view in front shows; both also pendingAt, a session asking right now, and
// windowsList until, when a slow ps pushed the next one back; windowsList is also what a switch's own ps found, which
// the next switch by the launcher windows reads for viewers in windows that publish nothing: planSwitch),
// answer:<id> (the answer to a Stop or Restart question that session asked, when the asked session couldn't send it as
// a notice: format, sessionId, action, cameBack, at; that session's panel takes it and deletes it), personStop:<id>
// (when the person stopped that session from a panel: a plugin's wake leaves it stopped until it's started again),
// endedDismissed (the time of the background service's death the person dismissed the panel's line for: Leave them
// stopped), broughtBack (the sessions a panel is bringing back after such a death, or Claude is waking with
// mcp__sessions__wake, by sessionId: since when, for two minutes, so two panels or callers never respawn the same one),
// modelWakes (the wakes Claude asked for with mcp__sessions__wake in the last hour, for its limits: ModelWake in
// state.ts; with broughtBack under the <data>/bringback.lock folder), marks:sessions:<sessionId> (the line "woken by
// “<caller>”" on a woken session's row, a MarkSlot of the panel's own, for 15 minutes), startSkipped (a start on this
// machine found that no classic.SessionStart reaches the mod: at; deleted by the next one that reaches it).
// When a stored value changes meaning, it gets a new key: sessions on another version never misread it.
// A session started with any SESSIONS_* override (a test session) keeps every key under @<hash of the overrides>/
// (storeNamespace in state.ts): it never reads nor writes the keys of the sessions you use, nor they its
let namespaceNow: string | undefined
// The overrides set in this session's environment, by name: what keeps its data apart (none for the sessions you use)
let apartBecause: string[] = []
async function storeNamespaceOf($: any): Promise<string> {
  if (namespaceNow !== undefined) return namespaceNow
  // Each variable's name written out: the $ another plugin's call lends has only these
  const values = [
    await $.env.get('SESSIONS_DATA_DIR'),
    await $.env.get('SESSIONS_JOBS_DIR'),
    await $.env.get('SESSIONS_DAEMON_LOG'),
    await $.env.get('SESSIONS_CLAUDE'),
    await $.env.get('SESSIONS_PLUGIN_VERSION'),
    await $.env.get('SESSIONS_PLUGIN_SINCE'),
    await $.env.get('SESSIONS_REGISTRY_DIR'),
  ]
  const names = ['SESSIONS_DATA_DIR', 'SESSIONS_JOBS_DIR', 'SESSIONS_DAEMON_LOG', 'SESSIONS_CLAUDE', 'SESSIONS_PLUGIN_VERSION', 'SESSIONS_PLUGIN_SINCE', 'SESSIONS_REGISTRY_DIR']
  apartBecause = names.filter((_, i) => values[i])
  namespaceNow = storeNamespace(values)
  return namespaceNow
}

// A test session: a location override in its environment. ccc's SESSIONS_PLUGIN_VERSION/SINCE count only beside one
async function isTestSession($: any): Promise<boolean> {
  return (await storeNamespaceOf($)) !== ''
}

// /sessions status, about the overrides: a test session keeps its panel data apart; ccc's variables alone are ignored
async function apartText($: any): Promise<string> {
  await storeNamespaceOf($)
  const isLauncherOnly = (n: string) => n === 'SESSIONS_PLUGIN_VERSION' || n === 'SESSIONS_PLUGIN_SINCE'
  const launcherOnly = apartBecause.filter(isLauncherOnly)
  const locations = apartBecause.filter(n => !isLauncherOnly(n))
  if (await isTestSession($)) {
    return `This session keeps its panel data apart, as a test session: ${locations.join(', ')} ${locations.length === 1 ? 'is' : 'are'} set in its environment${launcherOnly.length ? ` (with ${launcherOnly.join(', ')})` : ''}, so the other sessions' panels don't see what it records (seen, done, its state), nor it theirs`
  }
  if (!launcherOnly.length) return ''
  return `${launcherOnly.join(', ')}: set in this session's environment and ignored (they count only beside a location override, in a test session). ccc sets them for its launcher; a background service that a launcher before sessions 0.13.6 brought up hands them on to every session it starts. Harmless now: nothing to do`
}

// Each store read reads and parses Claude's whole store file (and touches it). So a refresh reads the store's keys once
// and then only the keys that are there, what can't change for a while is kept in memory (a session's first-prompt
// title, the installed versions until their 5 minutes are up), and what only this session writes (when it last
// finished, when it was last seen) is kept as it reads and writes it (own): the 2 s seen check reads nothing between
// its checks With the engine watching this session's paths, what other sessions write in the store and say with a bell
// (watch.ts: bellOfKey: each session's record, seen and title, the marks, the shared f and c) is kept as last read,
// until that bell rings or the pass reads everything again: a file event then reads only the keys it names. On the
// short timer (nothing watched) every refresh reads them anew, as before
const storeCache = new Map<string, unknown>()
const cacheable = (key: string) => live && bellOfKey(key) !== null
function forgetStored(match: (key: string) => boolean) {
  for (const k of [...storeCache.keys()]) if (match(k)) storeCache.delete(k)
}

async function storeGet($: any, key: string): Promise<any> {
  if (cacheable(key) && storeCache.has(key)) return storeCache.get(key)
  try {
    const value = await $.store.get(`${await storeNamespaceOf($)}${key}`)
    if (cacheable(key)) storeCache.set(key, value)
    return value
  } catch {
    return undefined
  }
}

async function storeSet($: any, key: string, value: unknown): Promise<boolean> {
  try {
    await $.store.set(`${await storeNamespaceOf($)}${key}`, value)
    noteOwn(key, value)
    if (cacheable(key)) storeCache.set(key, value)
    else storeCache.delete(key)
    ringFor($, key)
    return true
  } catch {
    return false
  }
}

async function storeDelete($: any, key: string) {
  try {
    await $.store.delete(`${await storeNamespaceOf($)}${key}`)
    noteOwn(key, undefined)
    if (cacheable(key)) storeCache.set(key, undefined)
    else storeCache.delete(key)
    ringFor($, key)
  } catch {}
}

// The bell (watch.ts) a write of the store rings, so the panels that watch read it again: only a write that others draw
function ringFor($: any, key: string) {
  const name = bellOfKey(key)
  if (name) bg(ring($, name))
}

async function ring($: any, name: string) {
  const dir = await dataFolder($)
  if (!dir || !/^[A-Za-z0-9_:-]+$/.test(name)) return
  let from = myId
  try {
    from ||= String(await $.session.id())
  } catch {}
  try {
    await $.fs.write(`${dir}/bell/${name}`, bellText(from, await $.clock.now()))
  } catch {}
}

// This session's last finish (its state's `finished`) and when it was last seen (seen:<id>): only it writes either, so
// what it read or wrote last is what's there. null: not known yet (read it)
let selfSeen: { id: string; finished: number; seen: number } | null = null
function noteOwn(key: string, value: unknown) {
  if (!myId || (key !== `state:${myId}` && key !== `seen:${myId}`)) return
  if (!selfSeen || selfSeen.id !== myId) {
    selfSeen = null
    return
  }
  if (key === `seen:${myId}`) selfSeen.seen = Number(value) || 0
  else selfSeen.finished = Number((value as SessionState | undefined)?.finished) || 0
}

async function ownSeenState($: any): Promise<{ finished: number; seen: number }> {
  if (selfSeen && selfSeen.id === myId) return selfSeen
  const next = { id: myId, finished: (await readState($, myId))?.finished ?? 0, seen: await seenAt($, myId) }
  selfSeen = next
  return next
}

// The keys of this session's namespace, without it
async function storeKeys($: any): Promise<string[]> {
  try {
    const ns = await storeNamespaceOf($)
    const all: string[] = await $.store.keys()
    return ns ? all.filter(k => k.startsWith(ns)).map(k => k.slice(ns.length)) : all.filter(k => !k.startsWith('@'))
  } catch {
    return []
  }
}

async function seenAt($: any, sessionId: string): Promise<number> {
  return Number(await storeGet($, `seen:${sessionId}`)) || 0
}

async function readState($: any, sessionId: string): Promise<SessionState | null> {
  const e = await storeGet($, `state:${sessionId}`)
  return e && typeof e === 'object' ? (e as SessionState) : null
}

// Which terminal windows show each session: "claude attach <id>" viewers, agent views, and classic sessions by their pid.
// One ps at a time in a session: callers that come while one runs share it
let windowsListing: Promise<Windows> | null = null
async function windows($: any): Promise<Windows> {
  if (!windowsListing) windowsListing = listWindows($).finally(() => (windowsListing = null))
  return windowsListing
}

async function listWindows($: any): Promise<Windows> {
  // -A: every process, on macOS and on Linux (on macOS it's the same as -ax). One -o per column: a header runs to the end
  // of its -o argument (POSIX), so procps reads `-o pid=,tty=,command=` as the pid column alone
  return parseWindows((await run($, ['ps', '-A', '-o', 'pid=', '-o', 'tty=', '-o', 'command='])).stdout, platform.clientCommand)
}

// The window this session's panel was just used from (macOS: the front Terminal window, if it shows this session;
// Linux: the one whose launcher has it open). v: a listing the caller already has, for the rest of the same action
async function frontWindowShowingMe($: any, v?: Windows): Promise<string | null> {
  return platform.windowShowingMe(sys($), v ?? (await windows($)), me())
}

// The launcher (hooks/visor.sh, next to this file) runs in each window opened with ccc and opens one session after
// another there. To switch, the next one is written to that window's file (<data>/windows/<tty>) and the current
// viewer is closed. Windows the panel opens run the launcher of this very copy of the mod; `ccc` runs the enabled
// plugin's launcher through the small command the setup installs, which nothing rewrites
const LAUNCHER = `${PLUGIN_DIR}/hooks/visor.sh`

function windowFile(tty: string): string {
  return `${dataDir}/windows/${fileKey(tty)}`
}

// The shell command a new window runs (Terminal's do script, a Linux terminal's bash -c): every word in single quotes,
// so a folder named with $(…), backticks or ! runs nothing
function launcherCommand(t: WindowTarget): string {
  return `cd ${shellQuote(myCwd)} && bash ${shellQuote(LAUNCHER)} ${t.command === 'attach' ? `attach ${shellQuote(t.id)}` : 'agents'}`
}

function agentsTarget(): WindowTarget {
  return { command: 'agents', title: 'Agents', folder: myCwd }
}

// A single window: if a viewer or the agent view (clients) is in front and the window runs the launcher, switch to the
// target in that same tab: write it the target and close the viewer; the launcher opens the next one. A window that
// wasn't opened with ccc has no launcher and can't be switched in place (false): the caller opens a new window
async function switchInPlace($: any, target: WindowTarget, front: string, listed?: Windows): Promise<boolean> {
  const v = listed ?? (await windows($))
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

// The launcher windows that say what they show (<data>/windows/<tty>.showing: Showing in state.ts), read with no
// command. A file under another terminal's name than the one it names is left out
async function launcherWindows($: any): Promise<Showing[]> {
  if (!dataDir) return []
  let names: string[]
  try {
    names = (await $.fs.list(`${dataDir}/windows`)).filter((e: any) => e.kind === 'file' && String(e.name).endsWith(SHOWING)).map((e: any) => String(e.name))
  } catch {
    return []
  }
  const read = await Promise.all(
    names.map(async name => {
      try {
        const s = parseShowing(String(await $.fs.read(`${dataDir}/windows/${name}`)))
        return s && `${fileKey(s.tty)}${SHOWING}` === name ? s : null
      } catch {
        return null
      }
    }),
  )
  return read.filter((s): s is Showing => s !== null)
}

// Whether a window's launcher and its watcher still run as its .showing says (showingRuns in state.ts): one ps of those
// two processes, never of all of them. A ps that can't run (127) says nothing against it
async function launcherRuns($: any, s: Showing): Promise<boolean> {
  const r = await run($, ['ps', '-p', `${s.launcher},${s.watcher}`, '-o', 'pid=', '-o', 'tty=', '-o', 'command='])
  return r.exitCode === 127 || showingRuns(s, r.stdout)
}

// A .showing its launcher left behind goes, with what was just written for that window
async function dropShowing($: any, s: Showing) {
  debugLine($, `switch: the launcher of ${s.tty} isn't running; its ${SHOWING} file goes`)
  await runSafe($, ['rm', '-f', windowFile(s.tty), `${windowFile(s.tty)}${SHOWING}`])
}

// A switch by what the launcher windows publish (planSwitch in state.ts), with no ps of every process and no question
// to Terminal: true once done, false to go the usual way (jump). The window's file asks its watcher to end the viewer
// (end=1) and is written before the check that its launcher still runs, so the check costs the switch no time: a
// .showing left behind gets a file nobody reads, both go, and the usual way follows. A window showing the target is
// checked before it's brought forward
async function switchByLaunchers($: any, f: Row): Promise<boolean> {
  if (!f.id || !dataDir) return false
  const shown = await launcherWindows($)
  if (!shown.length) return false
  const c = await storeGet($, 'windowsList')
  const listed = c && Array.isArray(c.windows?.agentsViews) && c.windows.byId ? (c.windows as Windows) : null
  const plan = planSwitch(shown, myShortId(), f.id, listed)
  if (!plan) return false
  if (plan.kind === 'bring') {
    if (!(await launcherRuns($, plan.to))) {
      await dropShowing($, plan.to)
      return false
    }
    if (await platform.bringWindow(sys($), plan.to.tty, f.title)) return true
    // Where it can't be brought forward (Linux without wmctrl/xdotool, or Wayland) it's shown here too; else the
    // usual way tries again, and says so
    if (!platform.showHereIfCantBring) return false
  }
  const file = windowFile(plan.from.tty)
  try {
    await $.fs.write(file, windowTargetText({ command: 'attach', id: f.id, title: f.title, end: true }))
  } catch {
    return false
  }
  if (await launcherRuns($, plan.from)) return true
  await dropShowing($, plan.from)
  return false
}

// The listing the usual way took, for the next switch of every session (planSwitch reads it) and the seen check
async function shareWindows($: any, v: Windows) {
  await storeSet($, 'windowsList', { at: await $.clock.now(), windows: v })
}

// The windows showing this session: its viewers, and a regular session's own window (a background session's process
// has the background service's internal terminal, which isn't a window)
function myWindowsIn(v: Windows): string[] {
  const list = [...(v.byId[myShortId()] ?? [])]
  const own = myPid && !me().background ? v.byPid[String(myPid)] : undefined
  if (own) list.push(own)
  return list
}

async function myWindows($: any): Promise<string[]> {
  return myWindowsIn(await windows($))
}

// The windows listing and the window in front, shared by every session for the seen check: one ps then serves every
// session for SEEN_WINDOWS_MS (5 s in the first minute after a finish; which windows are open changes rarely, and
// arriving in a session marks it seen without it), and one question to Terminal for FRONT_SHARED_MS, a little under
// the fastest pace of the check. Only for that
// check: what acts on a window (closing a viewer, a switch) reads the listing right then, and a switch the usual way
// stores what it read (shareWindows); a switch by the launcher windows reads the stored one only to know whether a
// window that publishes nothing shows either session (planSwitch), never to act on a window. Like the session list:
// stamped when ps came back; a session about to list says so (`pendingAt`), and the others use the stored windows
// meanwhile; a ps that took longer than SHARED_MS pushes every session's next one back (twice its time, up to 30 s)
const SHARED_MS = 1500
const SEEN_WINDOWS_MS = 30000
const FRONT_SHARED_MS = 1900
const WINDOWS_PENDING_MS = 10000
// Two questions to Terminal at most (the front window, an agent view's text), 8 s each at most
const FRONT_PENDING_MS = 20000
const WINDOWS_BACKOFF_MAX_MS = 30000
async function sharedWindows($: any, maxAge = SEEN_WINDOWS_MS): Promise<Windows> {
  const now = await $.clock.now()
  const c = await storeGet($, 'windowsList')
  const stored = c && Array.isArray(c.windows?.agentsViews) && c.windows.byId && c.windows.byPid ? (c.windows as Windows) : null
  if (stored) {
    if (now - Number(c.at) < maxAge) return stored
    if (typeof c.until === 'number' && now < c.until) return stored
    if (typeof c.pendingAt === 'number' && now - c.pendingAt < WINDOWS_PENDING_MS) return stored
    await storeSet($, 'windowsList', { ...c, pendingAt: now })
  }
  const v = await windows($)
  const at = await $.clock.now()
  const took = at - now
  await storeSet($, 'windowsList', { at, windows: v, ...(took > SHARED_MS ? { until: at + Math.min(WINDOWS_BACKOFF_MAX_MS, 2 * took) } : {}) })
  return v
}

// The window in front ('frontWindow': at, tty, and with an agent view in front, tags: the sessions it shows by their
// ⟨id⟩ tag, sessionTags), the way the windows listing is shared: `at` is when Terminal answered; a session about to ask
// says so (`pendingAt`) and the others skip their check meanwhile (the next one is at most a pace away). The session
// that asks also reads the text of an agent view in front, so the sessions it shows don't each read it: however many
// sessions are unseen, one question to Terminal (two with an agent view in front) per FRONT_SHARED_MS. null: another
// session is asking
type Front = { tty: string | null; tags?: string[] }
async function sharedFront($: any, v: Windows): Promise<Front | null> {
  const now = await $.clock.now()
  const c = await storeGet($, 'frontWindow')
  const isView = (tty: unknown) => typeof tty === 'string' && v.agentsViews.some(a => a.tty === tty)
  const answered = !!c && typeof c.at === 'number' && (typeof c.tty === 'string' || c.tty === null) && (!isView(c.tty) || Array.isArray(c.tags))
  if (answered && now - c.at < FRONT_SHARED_MS) return { tty: c.tty, ...(Array.isArray(c.tags) ? { tags: c.tags.map(String) } : {}) }
  if (c && typeof c.pendingAt === 'number' && now >= c.pendingAt && now - c.pendingAt < FRONT_PENDING_MS) return null
  await storeSet($, 'frontWindow', { ...(c && typeof c === 'object' ? c : {}), pendingAt: now })
  const tty = await platform.windowInFront(sys($), await shownWindows($, v))
  const tags = tty && isView(tty) ? sessionTags(await platform.readWindow(sys($), tty)) : undefined
  const front: Front = { tty, ...(tags ? { tags } : {}) }
  await storeSet($, 'frontWindow', { at: await $.clock.now(), ...front })
  return front
}

// The viewers' windows, each with the name of the session it shows (its viewer titles the window with it), for a
// platform that can only tell the window in front by its title. Sessions without a name of their own are left out
async function shownWindows($: any, v: Windows): Promise<Shown[]> {
  const list = await officialList($)
  if (!Array.isArray(list)) return []
  const names = new Map<string, string>()
  for (const s of list) if (s?.id && s.name && s.name !== s.id) names.set(String(s.id), String(s.name))
  return Object.entries(v.byId).flatMap(([id, ttys]) => {
    const title = names.get(id)
    return title ? ttys.map(tty => ({ tty, id, title })) : []
  })
}

// Are you looking at me? Someone at the computer (the platform can tell on macOS: screen unlocked, recent input) and a
// window in front with one of my viewers, or an agent view showing my tag. Only while this session's last answer is
// unseen, at the pace nextSeenCheck sets (the 2 s timer does nothing between checks), and only a session shown in some
// window (one of its viewers, or an agent view) asks which window is in front: most background sessions are shown in
// none, and ask Terminal nothing, which a quit Terminal would also take as a reason to start. Where the front window
// can't be known (Linux without X11), a session counts as seen only when you type in it, use its panel or arrive there
// A session no window shows (no viewer of it, no agent view) past the first minute after its answer is checked again a
// minute later (seenQuietUntil), with a listing up to a minute old: arriving there with ccc, or from another panel
// (Enter or a click), marks it seen anyway
let seenCheckedAt = 0
let seenQuietUntil = 0
async function markSeenIfLooking($: any) {
  if (!platform.frontKnown) return
  const { finished, seen } = await ownSeenState($)
  if (finished <= seen) return
  const now = await $.clock.now()
  if (now < nextSeenCheck(finished, seenCheckedAt) || now < seenQuietUntil) return
  seenCheckedAt = now
  // In the first minute after a finish the person may well be opening a window on it: a listing at most 5 s old then;
  // a minute old once the answer is 10 minutes old, or when no window showed this session last time
  const age = now - finished
  const v = await sharedWindows($, age < 60000 ? 5000 : age >= 600000 || seenQuietUntil > 0 ? 2 * SEEN_WINDOWS_MS : SEEN_WINDOWS_MS)
  const mine = myWindowsIn(v)
  seenQuietUntil = mine.length === 0 && v.agentsViews.length === 0 && age >= 60000 ? now + 60000 : 0
  if (mine.length === 0 && v.agentsViews.length === 0) return
  const front = await sharedFront($, v)
  const tty = front?.tty
  if (!tty) return
  const looking = mine.includes(tty) || (v.agentsViews.some(c => c.tty === tty) && !!front.tags?.includes(myShortId()))
  if (looking && (await platform.userPresent(sys($)))) await storeSet($, `seen:${myId}`, await $.clock.now())
}

// The person is at this session right now (arrived from another panel, by Enter or a click, or with ccc, or pressing
// keys in its panel): what it last answered is seen, with no check
async function seenNow($: any) {
  if (!myId) return
  const { finished, seen } = await ownSeenState($)
  if (finished > seen) await storeSet($, `seen:${myId}`, await $.clock.now())
}

// The official list (claude agents --json --all), shared by every session through the store ('list': { at, sessions,
// sig?, until? }). One listing at a time: in a session, callers share the one in flight; across sessions, whoever takes
// <data>/list.lock runs it, and the others read the stored list, however old, until it lands. `at` is when the listing
// came back, never when it started; `sig`, what Claude's registry and the service's folder looked like just before it
// started (listSignature). A stored list serves while nothing it's made of moved (listHolds: up to LIST_QUIET_MS), so
// an idle machine lists about twice a minute, and a change (a session turning busy or idle, starting, ending, renamed)
// is listed at the next refresh. A listing that took longer than LIST_MS, or failed, pushes every session's next one
// back (`until`: twice its time, up to LIST_BACKOFF_MAX_MS): a slow machine (after a sleep, under an endpoint scanner
// that checks every exec) isn't flooded with more listings, each slower than the last
const LIST_BACKOFF_MAX_MS = 60000
const LIST_LOCK_STALE_MS = 30000
const LIST_WAIT_MS = 15000
type Listed = { sessions: any[]; at: number }
type Stored = Listed & { sig?: string; until?: number }
let listing: Promise<Listed | string> | null = null

async function officialList($: any, maxAge = LIST_MS): Promise<any[] | string> {
  const r = await listWithAge($, maxAge)
  return typeof r === 'string' ? r : r.sessions
}

async function storedList($: any): Promise<Stored | null> {
  const c = await storeGet($, 'list')
  return c && Array.isArray(c.sessions) && typeof c.at === 'number' ? (c as Stored) : null
}

// What the session list is made of, as Claude's files show it right now (listSignature): its registry folder
// (~/.claude/sessions, read only) and the service's job folders, one fs.list each. null when it can't tell
async function registrySignature($: any): Promise<string | null> {
  if (!home) return null
  let registry: ListedFile[]
  try {
    registry = (await $.fs.list(`${home}/.claude/sessions`)).map((f: any) => ({ name: String(f.name), mtimeMs: Number(f.mtimeMs), size: Number(f.size) }))
  } catch {
    return null
  }
  let jobs: { name: string }[] = []
  try {
    if (jobsDir) jobs = (await $.fs.list(jobsDir)).map((f: any) => ({ name: String(f.name) }))
  } catch {}
  return listSignature(registry, jobs, myPid)
}

// The list with when it was read. maxAge: how old a stored one may be (0 for one read now, as a restart's question
// wants); a caller that wants it fresh checks `at` itself, since another session's listing may be the one in flight
async function listWithAge($: any, maxAge = LIST_MS): Promise<Listed | string> {
  const direct = await directListed($, maxAge)
  if (direct) return direct
  const now = await $.clock.now()
  const c = await storedList($)
  if (listHolds(c, now, maxAge, c && maxAge >= LIST_MS && typeof c.sig === 'string' ? await registrySignature($) : null)) return c as Stored
  if (!listing) listing = fetchList($, maxAge).finally(() => (listing = null))
  return listing
}

// One try at the machine-wide lock; a lock older than LIST_LOCK_STALE_MS was left by a session cut off mid-listing
async function takeListLock($: any, lock: string): Promise<boolean> {
  if ((await runSafe($, ['mkdir', lock])).exitCode === 0) return true
  try {
    const st = await $.fs.stat(lock)
    if ((await $.clock.now()) - st.mtimeMs > LIST_LOCK_STALE_MS) {
      await runSafe($, ['rmdir', lock])
      return (await runSafe($, ['mkdir', lock])).exitCode === 0
    }
  } catch {}
  return false
}

async function fetchList($: any, maxAge: number): Promise<Listed | string> {
  const lock = dataDir ? `${dataDir}/list.lock` : ''
  const holding = lock ? await takeListLock($, lock) : false
  if (lock && !holding) {
    // Another session is listing: its list, once stored, serves here too. Until then the stored one, however old; with
    // none stored yet, wait for one a while, and only then list here without the lock
    const c = await storedList($)
    if (c) return c
    for (let waited = 0; waited < LIST_WAIT_MS; waited += 500) {
      await $.clock.sleep(500)
      const again = await storedList($)
      if (again) return again
    }
  }
  try {
    // Read again under the lock: the session that held it before may have just stored a fresh one. The signature is
    // taken before the listing starts, so a change while it runs is listed again next time
    const started = await $.clock.now()
    const sig = await registrySignature($)
    const c = await storedList($)
    if (listHolds(c, started, maxAge, sig)) return c as Stored
    const r = await run($, [claude, 'agents', '--json', '--all'])
    const list = r.exitCode !== 0 ? "Couldn't read the session list (claude agents --json)" : validateList(r.stdout)
    if (typeof list === 'string') {
      // Failed or timed out: the next listing is pushed back as after a slow one, the stored sessions and `at` kept
      const failedAt = await $.clock.now()
      const last = await storedList($)
      if (last) await storeSet($, 'list', { ...last, until: failedAt + Math.min(LIST_BACKOFF_MAX_MS, 2 * (failedAt - started)) })
      return list
    }
    const at = await $.clock.now()
    const took = at - started
    await storeSet($, 'list', { at, sessions: list, ...(sig ? { sig } : {}), ...(took > LIST_MS ? { until: at + Math.min(LIST_BACKOFF_MAX_MS, 2 * took) } : {}) })
    return { sessions: list, at }
  } finally {
    if (holding) await runSafe($, ['rmdir', lock])
  }
}

// After a start, a stop or a restart the list is out of date: the next caller reads it again (under the lock), and the
// stored sessions still serve the others meanwhile
async function invalidateList($: any) {
  if (sessionFiles) sessionFiles.syncedAt = 0
  if (!slowList && sessionFiles?.usable(myId, myPid)) return
  const c = await storedList($)
  await storeSet($, 'list', c ? { at: 0, sessions: c.sessions } : {})
}

// The list from Claude's files (watch.ts), with no command: what every caller gets while those files can stand for
// `claude agents` (SessionFiles.usable). Watched, they're as fresh as the last file event, read again only when a
// caller asks for a list younger than the panel's pace (a restart's question) and on the pass; on the short timer, read
// again when older than maxAge. null: the list is read the slow way
async function directListed($: any, maxAge: number): Promise<Listed | null> {
  if (!sessionFiles || !myId) return null
  const now = await $.clock.now()
  const limit = live && maxAge >= LIST_MS ? PASS_MS : maxAge
  if (sessionFiles.syncedAt === 0 || now - sessionFiles.syncedAt >= limit) await syncFiles($)
  const usable = sessionFiles.usable(myId, myPid)
  if (slowList !== !usable) {
    slowList = !usable
    debugLine($, slowList ? `list: the slow way (${sessionFiles.problem || "this session isn't in Claude's registry"})` : "list: from Claude's files")
    setPace($)
  }
  return usable ? { sessions: sessionFiles.list(), at: sessionFiles.syncedAt } : null
}

// Claude's files read again (watch.ts): the registry (only what moved), and the service's stopped jobs (all of them on
// a full pass; else the new ones and those whose session just left the registry). What moved, for the caller
let retrying = false
async function syncFiles($: any, full = false): Promise<RegistryNews | null> {
  if (!sessionFiles) return null
  const news = await syncRegistry($, sessionFiles)
  if (locations.jobs) {
    let names: string[] = []
    try {
      names = jobIds(await $.fs.list(locations.jobs))
    } catch {}
    for (const id of sessionFiles.jobsToCheck(names, full, news.left)) {
      const path = `${locations.jobs}/${id}/state.json`
      let st: { mtimeMs: number; size: number } | null = null
      try {
        const s = await $.fs.stat(path)
        st = { mtimeMs: Number(s.mtimeMs), size: Number(s.size) }
      } catch {}
      if (!sessionFiles.jobMoved(id, st) || !st) continue
      try {
        sessionFiles.setJob(id, st, JSON.parse(String(await $.fs.read(path))))
      } catch {}
    }
  }
  // A file cut short while Claude rewrote it: read again in a moment (not at once: a read in the same instant would
  // find it cut short again, and twice is a format the panel can't read)
  if (sessionFiles.retry && !retrying) {
    retrying = true
    $.clock.after(300, () => {
      retrying = false
      scheduleFlush($, 0, d => (d.registry = true))
    })
  }
  if (news.bridge) leaderNews.bridge = true
  if (news.ended) leaderNews.ended = true
  return news
}

// The registry read again: one listing of its folder, and only the files that moved
async function syncRegistry($: any, files: SessionFiles): Promise<RegistryNews> {
  let listed: FileListed[] | null = null
  try {
    listed = (await $.fs.list(files.locations.registry)).map((f: any) => ({ name: String(f?.name ?? ''), mtimeMs: Number(f?.mtimeMs), size: Number(f?.size) }))
  } catch {}
  const texts = new Map<string, string | null>()
  for (const name of listed ? files.toRead(listed) : []) {
    try {
      texts.set(name, String(await $.fs.read(`${files.locations.registry}/${name}`)))
    } catch {
      texts.set(name, null)
    }
  }
  return files.applyRegistry(listed, texts, await $.clock.now())
}

// ---- Push: file events, the pass, the short timer, the leader ----

// What the file events since the last read said (classify in watch.ts): read in one go a moment later (flush), so the
// events of one change come together (a turn's registry write and its bell; the engine already folds a burst of writes
// to one file into one event)
type Dirty = { registry: boolean; bells: Set<string>; inbox: boolean; tell: boolean; pins: boolean; job: boolean; rows: boolean; all: boolean }
const noDirt = (): Dirty => ({ registry: false, bells: new Set(), inbox: false, tell: false, pins: false, job: false, rows: false, all: false })
const isDirty = (d: Dirty) => d.registry || d.bells.size > 0 || d.inbox || d.tell || d.pins || d.job || d.rows || d.all
let dirty = noDirt()
let flushTimer: { cancel: () => void } | null = null
let flushing = false
// What the leader's next turn hears about: a Remote Control connection came or went, a turn ended somewhere
let leaderNews = { bridge: false, ended: false }

function fileChanged($: any, path: string, event: string) {
  const c = classify(path, locations)
  if (!c) return
  scheduleFlush($, 30, d => {
    if (c.kind === 'registry') d.registry = true
    else if (c.kind === 'bell') d.bells.add(c.name)
    else if (c.kind === 'inbox') d.inbox ||= c.id === myId && event !== 'unlink'
    // ccc tell's requests for this session (its .status files are this session's own writes)
    else if (c.kind === 'tell') d.tell ||= event !== 'unlink' && !c.file.endsWith('.status')
    else if (c.kind === 'pins') d.pins = true
    else d.job = true
  })
}

// A read already due later (a retry 300 ms out) is brought forward by an event that wants it sooner. Without the
// clock's time at hand, ms says how soon: a flush asked within less than the one pending is set again
let flushIn = 0
function scheduleFlush($: any, ms: number, mark: (d: Dirty) => void) {
  mark(dirty)
  if (flushing || (flushTimer && flushIn <= ms)) return
  flushTimer?.cancel()
  flushIn = ms
  flushTimer = $.clock.after(ms, () => {
    flushTimer = null
    bg(flush($))
  })
}

async function flush($: any) {
  if (flushing) return
  flushing = true
  try {
    for (let round = 0; round < 3 && isDirty(dirty); round++) {
      const d = dirty
      dirty = noDirt()
      if (d.inbox || d.all) bg(solo('inbox', () => checkInbox($)))
      if (d.tell || d.all) bg(solo('tells', () => checkTells($)))
      let redraw = d.rows || d.pins || d.job || d.all
      if (d.registry || d.all) {
        const problem = sessionFiles?.problem ?? ''
        const news = await syncFiles($, d.all)
        // A file the panel can't read, or one it can again: the list from claude agents, or from the files
        if ((sessionFiles?.problem ?? '') !== problem) redraw = true
        if (news?.changed.size) {
          // A session's status moved: its record is read again with it (its turn's start or end). The list other
          // plugins' calls answer from follows sessions of every folder, the rows only this project's
          for (const id of news.changed) forgetStored(k => k.endsWith(`:${id}`))
          redraw ||= [...news.changed].some(inThisProject)
          if (!redraw && sessionFiles && !slowList && sessionFiles.usable(myId, myPid)) lastList = sessionFiles.list()
          // A session came or went in another folder: the line about the sessions that ended with the background
          // service counts every folder's (a refresh does it otherwise)
          if (!redraw && news.membership) bg(solo('ended', () => readEnded($)))
        }
        // Who leads changes only when a session comes or goes; what the leader does, when a turn ends or Remote Control
        // moves (the rest waits for the pass)
        if (news && (news.membership || (leading && (news.bridge || news.ended)))) bg(solo('leader', () => leaderTurn($, 'event')))
      }
      for (const name of d.bells) {
        if (name === 'marks') forgetStored(k => k.startsWith('marks:'))
        else if (name === 'prefs') forgetStored(k => k === 'waitingOnly' || k === 'collapsed')
        else if (name === 'usage') bg(readUsage($, USAGE_FOLLOWER_MS))
        else if (name.startsWith('answer-')) {
          // The answer to this session's Stop or Restart question, left in the store
          if (name === `answer-${myId}` && pendingAsk) {
            forgetStored(k => k === `answer:${myId}`)
            bg(solo('answer', () => checkStoredAnswer($)))
          }
          continue
        } else if (name !== 'sections' && name !== 'pins') {
          // A session's own record, seen or title: read again, unless this session rang it itself
          if (name === myId && (await bellRinger($, name)) === myId) continue
          forgetStored(k => k.endsWith(`:${name}`))
          if (!inThisProject(name)) continue
        }
        redraw = true
      }
      if (redraw) await requestRefresh($)
    }
  } finally {
    flushing = false
    if (isDirty(dirty)) scheduleFlush($, 30, () => {})
  }
}

// Whether a session is drawn here: this one, one of the project's (as the list has it now), or one the list doesn't
// have yet (just started)
function inThisProject(sessionId: string): boolean {
  if (sessionId === myId || projectRows.some(f => f.sessionId === sessionId)) return true
  const s = (sessionFiles && !slowList ? sessionFiles.list() : lastList).find(x => x.sessionId === sessionId)
  return !s || belongsHere(s)
}

// Where each session of the list belongs (sessionHome in state.ts): what its own mod recorded, its heartbeat's root,
// kept once read (it never changes for a session id); else the first cwd row of its transcript, looked up once for
// each session (every new one in one command, learnHomes; one without a transcript is looked for again only once it
// runs, and then 10 minutes apart); else the folder Claude lists it in
const recordedRoots = new Map<string, string>()
const transcriptStarts = new Map<string, { cwd: string; live: boolean; at: number }>()
function whereabouts(s: any): Whereabouts {
  const id = String(s?.sessionId ?? '')
  return { recorded: recordedRoots.get(id), first: transcriptStarts.get(id)?.cwd, cwd: s?.cwd }
}

// Whether a session of the list belongs to a project (this one's by default): this session always belongs to its own
function belongsHere(s: any, root = myCwd): boolean {
  if (typeof s?.sessionId !== 'string') return false
  return (s.sessionId === myId && root === myCwd) || belongsTo(whereabouts(s), root, home)
}

// The project each session of the list belongs to, learnt from what's cheap first: the heartbeats (the files that
// changed since they were last read), then the transcripts of the sessions none of them names, with one command for all
// of them, and only for a session that hasn't been looked for (or one without a transcript that runs now: it may have
// written one since)
async function learnHomes($: any, list: readonly any[]) {
  const unknown = list.filter(s => typeof s.sessionId === 'string' && s.sessionId !== myId && !recordedRoots.has(s.sessionId))
  if (!unknown.length) return
  const beats = await readHeartbeats($, unknown.map(s => s.sessionId))
  for (const [id, h] of Object.entries(beats)) if (h.format === FORMAT && h.root.startsWith('/')) recordedRoots.set(id, h.root)
  const now = await $.clock.now()
  const ask = unknown.filter(s => {
    if (recordedRoots.has(s.sessionId)) return false
    const known = transcriptStarts.get(s.sessionId)
    if (!known) return true
    return !known.cwd && !!s.pid && (!known.live || now - known.at > 600000)
  })
  if (!ask.length || !home) return
  const found = await firstCwds($, ask.map(s => s.sessionId))
  if (found === null) return
  if (transcriptStarts.size > 2000) transcriptStarts.clear()
  for (const s of ask) transcriptStarts.set(s.sessionId, { cwd: found[s.sessionId] ?? '', live: !!s.pid, at: now })
}

// The first cwd row of each session's transcript, ~/.claude/projects/<folder>/<sessionId>.jsonl, looked for by its id in
// every folder (a folder's name can't be read back into a path, and a move takes the file to another folder), one
// command for all of them, with grep (no model, no tokens): parseTranscriptStarts. null: the command failed
const STARTS_SCRIPT = `p=$1; shift; for id in "$@"; do for f in "$p"/*/"$id".jsonl; do if [ -f "$f" ]; then printf '%s\\t' "$id"; grep -m 1 -F '"cwd":"' "$f" | head -c 65536 | tr -d '\\n'; printf '\\n'; break; fi; done; done`
async function firstCwds($: any, ids: string[]): Promise<Record<string, string> | null> {
  const safe = ids.filter(id => /^[A-Za-z0-9-]+$/.test(id))
  if (!safe.length || !home) return {}
  const r = await runSafe($, ['/bin/sh', '-c', STARTS_SCRIPT, 'sh', `${home}/.claude/projects`, ...safe])
  return r.exitCode === 0 ? parseTranscriptStarts(r.stdout) : null
}

async function bellRinger($: any, name: string): Promise<string> {
  try {
    return bellFrom(String(await $.fs.read(`${dataDir}/bell/${name}`)))
  } catch {
    return ''
  }
}

// One refresh at a time; one asked for while it runs runs once more after it (a file event never goes unread), and the
// caller waits for that one: an older refresh never lands after a newer one. The person is told of long waits
// (pushWaits) after a refresh from the mod's own timers and file events, never from an action's or a turn's hook (push
// false)
let refreshRun: Promise<void> | null = null
let refreshAgain = false
let refreshPush = false
function requestRefresh($: any, push = true): Promise<void> {
  refreshPush ||= push
  if (refreshRun) {
    refreshAgain = true
    return refreshRun
  }
  const runs = async () => {
    try {
      do {
        refreshAgain = false
        await refresh($)
        const pushing = refreshPush
        refreshPush = false
        if (pushing) await pushWaits($)
      } while (refreshAgain)
    } finally {
      refreshRun = null
    }
  }
  refreshRun = runs()
  return refreshRun
}

// The pass: every PASS_MS in every session, from an offset of its own. Everything read again, whatever the events said
// (a missed event costs at most a pass), the leader's turn, and while watched what the short timer does otherwise
async function pass($: any) {
  storeCache.clear()
  await syncFiles($, true)
  await requestRefresh($)
  await solo('leader', () => leaderTurn($, 'pass'))
  if (!live) return
  // The requests and the queues another plugin fills, as the short timer would (a missed event, or a queue whose kick
  // never came, waits a pass at most)
  quickTick($, true)
  bg(readUsage($, USAGE_FOLLOWER_MS))
  await chores($)
  bg(scheduleSeen($))
}

// What the 15 s timer did besides the heartbeat: a /clear's new id, the agent, the session's usage and spend, the
// update in place. Watched, once a pass; on the short timer, every 15 s
async function chores($: any) {
  await rebind($)
  await readAgent($)
  await publishUsage($)
  bg(notifySpend($))
  await updateInPlace($)
}

// The short timer, while the engine watches nothing for this session (no SessionStart of this WATCH_SET came: updated
// in place from an older version, or a host that never sends it), as the panel ran before: requests every 0.5 s, the
// list every 3 s, the seen check every 2 s, the chores every 15 s, the leader's turn every 20 s, the token usage every
// minute. Watched with a list that can't be read from Claude's files (slowList), only the list every 3 s
let pollTimers: { cancel: () => void }[] = []
let slowTimer: { cancel: () => void } | null = null
function setPace($: any) {
  if (!active) return
  if (!live && pollTimers.length === 0) {
    pollTimers = [
      $.clock.every(500, () => quickTick($)),
      $.clock.every(3000, () => {
        bg(pollRefresh($))
      }),
      $.clock.every(2000, () => {
        bg(
          solo('seen', async () => {
            if (await justWoke($)) return
            await markSeenIfLooking($)
          }),
        )
      }),
      $.clock.every(15000, () => {
        bg(chores($))
      }),
      $.clock.every(20000, () => {
        bg(solo('leader', () => leaderTurn($, 'tick')))
      }),
      $.clock.every(60000, () => {
        bg(readUsage($))
      }),
    ]
  }
  if (live && pollTimers.length) {
    for (const t of pollTimers) t.cancel()
    pollTimers = []
  }
  const slow = live && slowList
  if (slow && !slowTimer) {
    slowTimer = $.clock.every(3000, () => {
      bg(pollRefresh($))
    })
  }
  if (!slow && slowTimer) {
    slowTimer.cancel()
    slowTimer = null
  }
}

// The requests the short timer looks for, and the queues other plugins fill (also run at once when filled: kickQueue).
// byPass: from the pass, in a watched session
function quickTick($: any, byPass = false) {
  bg(solo('answer', () => checkStoredAnswer($)))
  bg(solo('inbox', () => checkInbox($, byPass)))
  bg(runLaunches($))
  bg(runWakes($))
  bg(runRestarts($))
  bg(solo('tells', () => checkTells($)))
}

// The list on the short timer: after a sleep this session's own offset first (justWoke); with nothing watched, what
// other sessions wrote in the store is read anew every time
async function pollRefresh($: any) {
  if (refreshRun || (await justWoke($))) return
  if (!live) storeCache.clear()
  // The poll is what reads the files: Claude's registry anew every time
  await syncFiles($)
  await requestRefresh($)
}

// A start, a wake or a restart another plugin queued ($.sessions.start, wake, restart) runs at once, from this mod's own
// timer (set at start)
let kickQueue: () => void = () => {}

// The rows' times, watched: one timer for the next moment one of them changes (nextLabelChange)
let labelTimer: { cancel: () => void } | null = null
let labelAt = 0
function scheduleLabel($: any, next: number, now: number) {
  if (!live || !Number.isFinite(next)) return
  if (labelTimer && labelAt === next) return
  labelTimer?.cancel()
  labelAt = next
  labelTimer = $.clock.after(Math.max(1000, next - now + 50), () => {
    labelTimer = null
    labelAt = 0
    bg(requestRefresh($))
  })
}

// The seen check, watched: a timer only while this session's last answer is unseen, at the check's own pace
// (nextSeenCheck): none at all once it's seen
let seenTimer: { cancel: () => void } | null = null
async function scheduleSeen($: any) {
  if (!live || !platform.frontKnown || !myId) return
  const { finished, seen } = await ownSeenState($)
  seenTimer?.cancel()
  seenTimer = null
  if (finished <= seen) return
  const due = Math.max(nextSeenCheck(finished, seenCheckedAt), seenQuietUntil)
  seenTimer = $.clock.after(Math.max(0, due - (await $.clock.now())), () => {
    seenTimer = null
    bg(
      solo('seen', async () => {
        await markSeenIfLooking($)
        await scheduleSeen($)
      }),
    )
  })
}

// ---- The leader (leader.ts) ----

// Who can lead: the sessions Claude's registry has running whose heartbeat here is fresh, of this format and process,
// and from a version that leads
async function leaderCandidates($: any, now: number): Promise<Candidate[]> {
  const running = (sessionFiles && !slowList ? sessionFiles.list() : lastList).filter(s => typeof s.sessionId === 'string' && typeof s.pid === 'number' && s.pid > 0)
  const beats = await readHeartbeats($, running.map(s => s.sessionId))
  return running
    .filter(s => {
      const h = beats[s.sessionId]
      return !!h && heartbeatStatus(h, s.pid, now) === 'ok' && leads(h.version)
    })
    .map(s => ({ pid: s.pid, sessionId: s.sessionId }))
}

// The leader's turn: who leads (electLeader), and, leading, the record rewritten and what's due. On the pass and the
// short timer's tick: the listing (a pass apart), the pins, the reopen, the prune; on a file event: the listing when it
// just took over, the pins when a Remote Control connection moved, the token usage when a turn ended (two minutes
// apart at least, and every 10 minutes)
async function leaderTurn($: any, why: 'start' | 'event' | 'pass' | 'tick') {
  if (!dataDir || !myId || !myPid) return
  const now = await $.clock.now()
  let text: string | null = null
  try {
    text = String(await $.fs.read(`${dataDir}/leader.json`))
  } catch {}
  const record = parseLeader(text)
  const e = electLeader({ pid: myPid, sessionId: myId }, await leaderCandidates($, now), record, now)
  const first = e.lead && !leading
  if (e.lead !== leading || e.takeover) debugLine($, e.lead ? `leader: this session (${why}${e.takeover ? `, in place of pid ${record?.pid}` : ''})` : `leader: pid ${e.leader}`)
  leading = e.lead
  leaderElsewhere = !e.lead
  if (!e.lead) return
  if (first || record?.pid !== myPid || now - leaderWrittenAt >= PASS_MS / 2) {
    try {
      await $.fs.write(`${dataDir}/leader.json`, leaderText({ pid: myPid, sessionId: myId, at: now }))
      leaderWrittenAt = now
    } catch {}
  }
  const news = leaderNews
  leaderNews = { bridge: false, ended: false }
  const timed = why === 'pass' || why === 'tick' || why === 'start'
  if (!slowList && sessionFiles && (e.takeover || first || (timed && now - reconciledAt >= PASS_MS - 5000))) await reconcile($)
  if (timed || news.bridge) bg(pinRemoteSessions($))
  if (timed) bg(reopenRetiredSessions($))
  if (timed) bg(prune($))
  if (live && ((news.ended && now - usageRunAt >= 120000) || now - usageRunAt >= 600000)) {
    usageRunAt = now
    bg(readUsage($, news.ended ? 120000 : 600000, true))
  }
}

// The leader's listing (claude agents --json --all), a pass apart: Claude removes the registry files of sessions whose
// process is gone as it lists (a crashed one's file stays until then), and what it lists is checked against the direct
// read, any difference said in the debug log
async function reconcile($: any) {
  reconciledAt = await $.clock.now()
  const r = await run($, [claude, 'agents', '--json', '--all'])
  if (r.exitCode !== 0) return
  const official = validateList(r.stdout)
  if (typeof official === 'string') return
  const drift = listDrift(sessionFiles?.list() ?? [], official)
  if (drift) debugLine($, `reconcile: ${drift}`)
  // The files it swept: their events come; read again in a moment all the same
  scheduleFlush($, 300, d => (d.registry = true))
}

// ---- What the engine watches (watch.ts) ----

// Where the watched files are, also before the mod has started here (SessionStart can come first)
async function locationsOf($: any): Promise<Locations> {
  if (locations.registry) return locations
  const h = (await $.env.get('HOME')) ?? ''
  return {
    registry: (await $.env.get('SESSIONS_REGISTRY_DIR')) || (h ? `${h}/.claude/sessions` : ''),
    data: (await $.env.get('SESSIONS_DATA_DIR')) || (h ? `${h}/.claude/mods/sessions-data` : ''),
    jobs: (await $.env.get('SESSIONS_JOBS_DIR')) || (h ? `${h}/.claude/jobs` : ''),
  }
}

// This session's background job, if it's one: the folder Claude names in CLAUDE_JOB_DIR, else its record in the
// registry
async function ownJobOf($: any, l: Locations, sessionId: string): Promise<string | null> {
  const dir = String((await $.env.get('CLAUDE_JOB_DIR')) ?? '').replace(/\/+$/, '')
  const named = dir.split('/').pop() ?? ''
  if (/^[A-Za-z0-9_-]+$/.test(named)) return named
  const files = sessionFiles ?? new SessionFiles(l)
  if (files.syncedAt === 0) await syncRegistry($, files)
  const own = files.entries().find(e => e.sessionId === sessionId)
  return own?.kind === 'bg' && own.jobId ? own.jobId.slice(0, 8) : null
}

// classic.SessionStart (a start, /clear, a compaction, a resume): the paths for the engine to watch, from now on in
// this session (watchPaths in watch.ts), and it's live: the short timer stops. After /clear or a resume the session's
// new id comes with it, which the mod follows at once. The mod's own folders are made first, where missing (a new data
// folder: the first session there): a folder missing when the list goes may never be watched (see watch.ts)
async function watchFor($: any, sessionId: string, source: string): Promise<string[]> {
  const l = await locationsOf($)
  if (!l.registry || !l.data) return []
  ownJob = (await ownJobOf($, l, sessionId)) ?? ownJob
  const paths = watchPaths(l, ownJob)
  const missing: string[] = []
  for (const dir of ownWatchedFolders(l)) if (!(await exists($, dir))) missing.push(dir)
  if (missing.length && (await runSafe($, ['mkdir', '-p', ...missing])).exitCode !== 0) debugLine($, `couldn't make ${missing.join(', ')}: their file events may never come`)
  const was = live
  live = true
  {
    const next = { set: WATCH_SET, sessionId, at: await $.clock.now() }
    await update($, watching, () => next)
  }
  debugLine($, `watching ${paths.length} paths (${source || 'start'}${was ? '' : ', live now'})`)
  if (active) {
    setPace($)
    if ((source === 'clear' || source === 'resume') && sessionId && sessionId !== myId) bg(rebind($))
    scheduleFlush($, 0, d => (d.all = true))
  }
  return paths
}

// The heartbeats of the sessions in a list, by sessionId (only the ones that exist and parse). The folder's listing
// gives each file's time and size: a heartbeat that didn't move since the last read isn't read again
const beatCache = new Map<string, { mtimeMs: number; size: number; beat: Heartbeat | null }>()
async function readHeartbeats($: any, ids: string[]): Promise<Record<string, Heartbeat>> {
  const out: Record<string, Heartbeat> = {}
  if (!dataDir) return out
  let files: Map<string, { mtimeMs: number; size: number }>
  try {
    files = new Map((await $.fs.list(`${dataDir}/alive`)).map((f: any) => [String(f.name), { mtimeMs: Number(f.mtimeMs), size: Number(f.size) }]))
  } catch {
    return out
  }
  for (const id of ids) {
    const f = files.get(id)
    if (!f) continue
    const held = beatCache.get(id)
    if (held && held.mtimeMs === f.mtimeMs && held.size === f.size) {
      if (held.beat) out[id] = held.beat
      continue
    }
    try {
      const h = parseHeartbeat(await $.fs.read(`${dataDir}/alive/${id}`))
      if (beatCache.size > 500) beatCache.clear()
      beatCache.set(id, { ...f, beat: h })
      if (h) out[id] = h
    } catch {}
  }
  return out
}

// This session's heartbeat (see Heartbeat in state.ts), every 15 s, with the project it belongs to (settleProject)
async function beat($: any) {
  if (!dataDir || !myId) return
  const at = await $.clock.now()
  await $.fs.write(`${dataDir}/alive/${myId}`, heartbeatText({ pid: myPid, at, version: modVersion, via: startedVia, root: myCwd }))
  lastBeat = at
}

// Every 10 minutes, the data of sessions no longer in the official list (fetched right then) is deleted: their stored
// keys, heartbeats and requests. Never that of a session created in the last 5 minutes, nor of one with a fresh
// heartbeat: the agent view's pre-started session is running and hidden from the list. The order files of folders
// that are gone go too (pruneOrders)
let lastPrune = 0
// The plugins' sections the last prune found empty
let emptyBefore = new Set<string>()
async function prune($: any) {
  const now = await $.clock.now()
  if (now - lastPrune < 600000) return
  lastPrune = now
  await pruneOrders($, now)
  // The shared list, at most 10 s old (one listing serves every session's prune: after a sleep they all come due at once)
  const list = await officialList($, 10000)
  // A listing that lacks this very session (short, or empty) isn't trusted with deleting anything
  if (typeof list === 'string' || !list.some(s => s.sessionId === myId)) return
  const alive = new Set(list.map(s => String(s.sessionId)))
  const ids = new Set<string>()
  const keys = await storeKeys($)
  for (const k of keys) {
    const m = k.match(/^(state|seen|title|waiting|restarted|reopened|needsSince|pushed|spend|personStop|project):(.+)$/)
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
  // ccc tell folders of background sessions no longer in the list
  try {
    const shorts = new Set(list.map(s => String(s.id ?? '')))
    const gone = (await $.fs.list(`${dataDir}/tell`)).map((f: any) => String(f.name)).filter((n: string) => isRef(n) && !n.startsWith('sid:') && !shorts.has(n))
    if (gone.length) await runSafe($, ['rm', '-rf', ...gone.map((n: string) => `${dataDir}/tell/${n}`)])
  } catch {}
  // Section members of sessions no longer in the list (a regular one's stays while its heartbeat is fresh), and the
  // plugins' sections that this pass and the one before found empty (one just defined, waiting for its first member,
  // stays: it was found empty once at most)
  const sections = await readSectionsFile($)
  if ('problem' in sections) return
  const refs = new Set(list.map(refOf))
  const sids = Object.keys(sections.file.members).filter(r => r.startsWith('sid:') && !refs.has(r))
  const sidBeats = await readHeartbeats($, sids.map(r => r.slice(4)))
  // A background session missing from the listing whose heartbeat is fresh keeps its member too (its short id is the
  // start of its first session id, which names its heartbeat until a /clear)
  const shorts = Object.keys(sections.file.members).filter(r => !r.startsWith('sid:') && !refs.has(r))
  const shortBeats = await readHeartbeats($, files.filter(f => shorts.some(s => f.startsWith(s))))
  const keep = (ref: string) => {
    const h = ref.startsWith('sid:') ? sidBeats[ref.slice(4)] : undefined
    const fresh = Object.entries(shortBeats).some(([id, b]) => !ref.startsWith('sid:') && id.startsWith(ref) && now - b.at < 120000)
    return refs.has(ref) || (!!h && now - h.at < 120000) || fresh
  }
  const wasEmpty = emptyBefore
  const empty = emptyPluginSections(pruneMembers(sections.file, keep))
  emptyBefore = new Set(empty)
  if (!Object.keys(sections.file.members).some(r => !keep(r)) && !empty.some(id => wasEmpty.has(id))) return
  await changeSections($, file => {
    const pruned = pruneMembers(file, keep)
    const drop = emptyPluginSections(pruned).filter(id => wasEmpty.has(id))
    for (const id of drop) emptyBefore.delete(id)
    return { file: dropSections(pruned, drop) }
  })
}

// The order files (<data>/order/<root as a file name>) of projects whose folder is gone: of the files no panel rewrote
// for a while, the root each names (orderOrphanRoot) is looked for once a prune, and the file goes if it isn't there.
// Never one whose folder is there, nor on a read or a look that fails
async function pruneOrders($: any, now: number) {
  let files: any[] = []
  try {
    files = await $.fs.list(`${dataDir}/order`)
  } catch {
    return
  }
  const gone: string[] = []
  for (const f of files) {
    const path = `${dataDir}/order/${String(f.name)}`
    if (f.kind !== 'file' || !(now - Number(f.mtimeMs) >= ORDER_ORPHAN_MS)) continue
    try {
      const root = orderOrphanRoot(String(f.name), Number(f.mtimeMs), String(await $.fs.read(path)), now)
      if (root && (await $.fs.exists(root)) === false) gone.push(path)
    } catch {}
  }
  if (gone.length === 0) return
  debugLine($, `prune: ${gone.length === 1 ? 'an order file' : `${gone.length} order files`} of a folder that's gone`)
  await runSafe($, ['rm', '-f', ...gone])
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
// It needs a python3 that runs without bothering the person (platform.pythonUsable: on a Mac without the developer
// tools, /usr/bin/python3 pops up a prompt to install them)
const USAGE_READER = `${(import.meta as any).dir}/usage.py`
let python: string | null | undefined
async function usablePython($: any): Promise<string | null> {
  if (python !== undefined) return python
  const r = await runSafe($, ['/bin/sh', '-lc', 'command -v python3'])
  const path = r.exitCode === 0 ? r.stdout.trim() : ''
  if (!path || !(await platform.pythonUsable(sys($), path))) return (python = null)
  return (python = path)
}

// Every session with the panel open wants the same totals once a minute: usage.py leaves what it answered in
// <data>/usage/summary.json (touched on every run, rewritten only when it changed), and a session finding one from the
// last USAGE_SHARED_MS reads it instead of running usage.py. The panel's value is rewritten only when the totals
// changed Watched, the leader alone runs usage.py (after a turn ended somewhere, two minutes apart at least, and every
// 10 minutes: leaderTurn) and rings the usage bell when the totals changed; the others read its summary then, and run
// usage.py themselves only when it's older than USAGE_FOLLOWER_MS (no leader kept it)
const USAGE_SHARED_MS = 50000
const USAGE_FOLLOWER_MS = 900000
async function sharedUsage($: any, maxAge: number): Promise<UsageSummary | null> {
  try {
    const path = `${dataDir}/usage/summary.json`
    const st = await $.fs.stat(path)
    if ((await $.clock.now()) - Number(st.mtimeMs) > maxAge) return null
    return usageSummaryOf(JSON.parse(String(await $.fs.read(path))))
  } catch {
    return null
  }
}

// The usage block's totals: the summary in <data>/usage if it's at most maxAge old, else usage.py run here. Only with
// the panel open, unless always (the leader's run)
let readingUsage = false
async function readUsage($: any, maxAge = USAGE_SHARED_MS, always = false) {
  if (readingUsage || !home || !dataDir) return
  if (!always && !(await $.ui.panes()).some((p: any) => p.id === PANE)) return
  readingUsage = true
  try {
    const before = await read($, usage)
    let next: Usage
    const shared = await sharedUsage($, maxAge)
    const py = shared ? null : await usablePython($)
    if (shared) next = { summary: shared, note: '' }
    else if (!py) next = { summary: null, note: 'Token usage needs python3' }
    else {
      const r = await runSafe($, [py, USAGE_READER, `${home}/.claude/projects`, `${dataDir}/usage`, `${dataDir}/alive`], { timeoutMs: 120000 })
      let summary: UsageSummary | null = null
      try {
        if (r.exitCode === 0) summary = usageSummaryOf(JSON.parse(r.stdout))
      } catch {}
      next = summary ? { summary, note: '' } : { summary: before.summary, note: before.summary ? '' : "Couldn't read token usage" }
      // New totals: the other panels read them
      if (summary && !sameData(before.summary, summary)) bg(ring($, 'usage'))
    }
    if (!sameData(await read($, usage), next)) await update($, usage, () => next)
  } finally {
    readingUsage = false
  }
}

// The chosen period and scope are remembered (and apply to all sessions)
async function chooseUsageView($: any, choice: Partial<UsageView>) {
  const next = { ...(await read($, usageView)), ...choice }
  if (!sameData(await read($, usageView), next)) await update($, usageView, () => next)
  await storeSet($, 'usageView', next)
}

// What `claude --version` and `claude plugin list --json` say, shared by every session through the store for
// INSTALLED_MS ('installed': at, version; 'plugin': at, plugin), like the windows listing: `at` is when the command came
// back; a session about to run one says so (`pendingAt`), and the others use the stored answer meanwhile, however old
// (none stored: what they'd answer without one). One that failed keeps the answer it had, stamped when it failed, so
// it's tried again INSTALLED_MS later, not at every refresh of every session. While another session leads (leader.ts:
// as this session last saw it, a sleep in between or not) only the leader runs them, at its own refresh, a pass apart
// at most, and the others read what it stored, unless nothing is or it's INSTALLED_ORPHAN_MS old (a leader that doesn't
// keep it: one of another version, or one with a store of its own). In this session, callers share the run in flight.
// What was read stays good here until its INSTALLED_MS are up, with no store read meanwhile
const INSTALLED_MS = 300000
const INSTALLED_PENDING_MS = 30000
const INSTALLED_ORPHAN_MS = 3 * INSTALLED_MS
type Answer = { at?: number; pendingAt?: number; [field: string]: unknown }
const answering = new Map<string, Promise<Answer | null>>()
async function sharedAnswer($: any, key: 'installed' | 'plugin', ask: () => Promise<Record<string, unknown> | null>): Promise<Answer | null> {
  const now = await $.clock.now()
  const c = await storeGet($, key)
  const stored: Answer | null = c && typeof c === 'object' ? (c as Answer) : null
  const at = typeof stored?.at === 'number' ? stored.at : null
  const age = at === null || now < at ? Infinity : now - at
  if (age < INSTALLED_MS) return stored
  const pendingAt = typeof stored?.pendingAt === 'number' ? stored.pendingAt : null
  if (pendingAt !== null && now >= pendingAt && now - pendingAt < INSTALLED_PENDING_MS) return stored
  if (leaderElsewhere && age < INSTALLED_ORPHAN_MS) return stored
  let inFlight = answering.get(key)
  if (!inFlight) {
    inFlight = (async () => {
      await storeSet($, key, { ...(stored ?? {}), pendingAt: now })
      const got = await ask()
      const back = await $.clock.now()
      const kept: Answer = { ...(stored ?? {}), at: back }
      delete kept.pendingAt
      const next = got ? { at: back, ...got } : kept
      await storeSet($, key, next)
      return next
    })().finally(() => answering.delete(key))
    answering.set(key, inFlight)
  }
  return inFlight
}

let installedHeld: { at: number; version: string } | null = null
async function readInstalledVersion($: any): Promise<string> {
  const now = await $.clock.now()
  if (installedHeld && now - installedHeld.at < INSTALLED_MS && now >= installedHeld.at) return installedHeld.version
  const c = await sharedAnswer($, 'installed', async () => {
    const r = await run($, [claude, '--version'])
    const version = r.exitCode === 0 ? parseVersion(r.stdout) : null
    return version ? { version } : null
  })
  const version = typeof c?.version === 'string' ? c.version : ''
  if (typeof c?.at === 'number' && now - c.at < INSTALLED_MS) installedHeld = { at: c.at, version }
  return version
}

// The installed plugin (`claude plugin list --json`), shared as above: which version of the mod sessions start with,
// and since when, to tell which sessions should have a heartbeat. SESSIONS_PLUGIN_VERSION and SESSIONS_PLUGIN_SINCE
// (ms) stand in for it in a test session only (a location override beside them); elsewhere they're ccc's, handed on by
// a background service, and stale after the next update, so the real one is read
let pluginHeld: { at: number; plugin: InstalledPlugin | null } | null = null
async function installedPlugin($: any): Promise<InstalledPlugin | null> {
  const version = (await isTestSession($)) ? await $.env.get('SESSIONS_PLUGIN_VERSION') : ''
  if (version) return { path: '', version, since: Number(await $.env.get('SESSIONS_PLUGIN_SINCE')) || 0 }
  const now = await $.clock.now()
  if (pluginHeld && now - pluginHeld.at < INSTALLED_MS && now >= pluginHeld.at) return pluginHeld.plugin
  const c = await sharedAnswer($, 'plugin', async () => {
    const r = await run($, [claude, 'plugin', 'list', '--json'])
    return r.exitCode === 0 ? { plugin: parsePluginList(r.stdout) } : null
  })
  const plugin = (c?.plugin as InstalledPlugin | null | undefined) ?? null
  if (typeof c?.at === 'number' && now - c.at < INSTALLED_MS) pluginHeld = { at: c.at, plugin }
  return plugin
}

// The pinned sessions: the ones the background service doesn't close for being idle. It's the file Ctrl+T writes in
// `claude agents` (there's no command to pin) and the service re-reads it every time it decides
function pinsPath(): string {
  return `${jobsDir}/pins.json`
}

async function pinsFromFile($: any, fresh = false): Promise<string[] | null> {
  try {
    if (fresh) {
      if (!(await $.fs.exists(pinsPath()))) return []
      return parsePins(await $.fs.read(pinsPath()))
    }
    const text = await readIfChanged($, pinsPath())
    return text === null ? [] : parsePins(text)
  } catch {
    return null
  }
}

// The same lock Claude takes to change pins.json: a pins.json.lock folder (sections.json uses one the same way). If it
// was left behind by a process that got cut off, after 5 s it's considered stale and removed (as Claude does). If it
// can't be taken within about 2 s (tries × 50 ms), this pass does nothing: false
async function withLock($: any, file: string, body: () => Promise<void>, tries = 40): Promise<boolean> {
  const lock = `${file}.lock`
  for (let i = 0; i < tries; i++) {
    if ((await runSafe($, ['mkdir', lock])).exitCode === 0) {
      try {
        await body()
      } finally {
        await runSafe($, ['rmdir', lock])
      }
      return true
    }
    try {
      const st = await $.fs.stat(lock)
      if ((await $.clock.now()) - st.mtimeMs > 5000) await runSafe($, ['rmdir', lock])
    } catch {}
    await $.clock.sleep(50)
  }
  return false
}

// The mod's data folder, also before the mod has started here (another plugin can call $.sessions first): worked out
// from the environment each time until the start sets it
async function dataFolder($: any): Promise<string> {
  if (dataDir) return dataDir
  const h = (await $.env.get('HOME')) ?? ''
  return (await $.env.get('SESSIONS_DATA_DIR')) || (h ? `${h}/.claude/mods/sessions-data` : '')
}

// sections.json (see SECTIONS_FORMAT in state.ts): missing is empty; one that can't be read, or from a newer sessions,
// is a problem and is never rewritten. Read again only when it changed, except under its lock (fresh)
async function readSectionsFile($: any, fresh = false): Promise<{ file: SectionsFile } | { problem: string }> {
  const dir = await dataFolder($)
  if (!dir) return { file: emptySectionsFile() }
  const path = `${dir}/sections.json`
  try {
    if (fresh) {
      if (!(await exists($, path))) return { file: emptySectionsFile() }
      return parseSectionsFile(await $.fs.read(path))
    }
    const text = await readIfChanged($, path)
    return text === null ? { file: emptySectionsFile() } : parseSectionsFile(text)
  } catch {
    return { problem: "Couldn't read sections.json" }
  }
}

// Changes sections.json under its lock, written whole to a separate file that then replaces it. change answers the new
// file, or the answer to give without writing. Another plugin's call waits for the lock briefly (tries) and answers busy
async function changeSections(
  $: any,
  change: (file: SectionsFile) => { file: SectionsFile } | { result: SessionsResult },
  tries = 40,
): Promise<SessionsResult> {
  const dir = await dataFolder($)
  if (!dir) return { ok: false, reason: 'not-ready', detail: 'no home folder to keep sections in' }
  const path = `${dir}/sections.json`
  let result: SessionsResult = { ok: false, reason: 'busy', detail: 'another session is changing sections.json: try again' }
  await runSafe($, ['mkdir', '-p', dir])
  await withLock(
    $,
    path,
    async () => {
      const current = await readSectionsFile($, true)
      if ('problem' in current) {
        result = { ok: false, reason: 'refused', detail: current.problem }
        return
      }
      const next = change(current.file)
      if ('result' in next) {
        result = next.result
        return
      }
      const temporary = `${path}.sessions-${myPid || 'mod'}-${await $.clock.now()}.tmp`
      await $.fs.write(temporary, sectionsFileText(next.file))
      if ((await runSafe($, ['mv', '-f', temporary, path])).exitCode !== 0) {
        await runSafe($, ['rm', '-f', temporary])
        result = { ok: false, reason: 'busy', detail: "couldn't write sections.json: try again" }
        return
      }
      sectionsNow = sectionsView(next.file)
      result = { ok: true }
    },
    tries,
  )
  if (result.ok) await ring($, 'sections')
  return result
}

// Whether a background session has Remote Control: the service records its connection in the session's state
// (bridgeSessionId) while it's on, also during a relaunch, and deletes it when it's turned off. null if it couldn't be read
async function hasRemoteControl($: any, id: string): Promise<boolean | null> {
  try {
    const text = await readIfChanged($, `${jobsDir}/${id}/state.json`)
    if (text === null) return null
    const e = JSON.parse(text)
    return typeof e?.bridgeSessionId === 'string' && e.bridgeSessionId !== ''
  } catch {
    return null
  }
}

// pins.json written the way Claude writes it: the list indented by 2, in a separate file that then replaces the original;
// unpinning also deletes the position the session had among the pinned ones, as Claude does. Under the pins lock
async function writePins($: any, file: string, pins: readonly string[], unpinned: readonly string[]): Promise<boolean> {
  const temporary = `${file}.sessions-${myPid || 'mod'}-${await $.clock.now()}.tmp`
  await $.fs.write(temporary, JSON.stringify(pins, null, 2))
  if ((await runSafe($, ['mv', '-f', temporary, file])).exitCode !== 0) {
    await runSafe($, ['rm', '-f', temporary])
    return false
  }
  for (const id of unpinned) await runSafe($, ['rm', '-f', `${jobsDir}/${id}/order`])
  return true
}

// Background sessions with Remote Control get pinned automatically, so the service doesn't close them after 8 idle
// hours while you drive them from your phone; when their Remote Control is turned off they get unpinned (only the ones
// the mod pinned: reconcilePins). Across all folders. Only the leader does it (leader.ts): every pass, and when a
// Remote Control connection came or went in the registry. What's to change is worked out first from the files as they
// are; only a pass with something to pin, unpin or record takes the pins lock and works it out again under it (an idle
// machine runs no command for it)
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
    // A listing that lacks this very session (short, or empty) isn't trusted with unpinning anything
    if (typeof list === 'string' || !list.some(s => s.sessionId === myId)) return
    const remote: Record<string, boolean | null> = {}
    for (const s of list) {
      if (s.kind !== 'background' || typeof s.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s.id)) continue
      remote[s.id] = await hasRemoteControl($, s.id)
    }
    const file = pinsPath()
    const pinsNow = await pinsFromFile($)
    if (!pinsNow) return
    const recordNow = await storeGet($, 'autoPins')
    if (recordNow && Array.isArray(recordNow.ids) && Array.isArray(recordNow.released)) {
      const kept: AutoPins = { ids: recordNow.ids, released: recordNow.released }
      const r = reconcilePins(pinsNow, remote, kept)
      const pluginNow = pluginPinsOf(await storeGet($, 'pluginPins'))
      const k = keepPluginPins(r, pluginNow, new Set(Object.keys(remote)))
      if (sameData(k.pins, pinsNow) && sameData(r.auto, kept) && sameData(k.plugin, pluginNow)) return
    }
    await withLock($, file, async () => {
      const pins = await pinsFromFile($, true)
      if (!pins) return
      // With no record of what the mod pinned (a new store, or a lost one), it's rebuilt from what's there: the pinned
      // sessions with Remote Control on count as the mod's (adoptAutoPins)
      const previous = await storeGet($, 'autoPins')
      const recorded = !!previous && Array.isArray(previous.ids) && Array.isArray(previous.released)
      const auto: AutoPins = recorded ? { ids: previous.ids, released: previous.released } : adoptAutoPins(pins, remote)
      const r = reconcilePins(pins, remote, auto)
      // A session another plugin keeps pinned ($.sessions.pin) stays pinned when its Remote Control goes off
      const pluginBefore = pluginPinsOf(await storeGet($, 'pluginPins'))
      const k = keepPluginPins(r, pluginBefore, new Set(Object.keys(remote)))
      if (JSON.stringify(k.pins) !== JSON.stringify(pins)) {
        if (!(await writePins($, file, k.pins, k.toUnpin))) return
      }
      if (!recorded || JSON.stringify(r.auto) !== JSON.stringify(auto)) await storeSet($, 'autoPins', r.auto)
      if (JSON.stringify(k.plugin) !== JSON.stringify(pluginBefore)) await storeSet($, 'pluginPins', k.plugin)
    })
  } finally {
    pinning = false
  }
}

// Pinned sessions with Remote Control that the background service closed for lack of memory (it closes them even when
// pinned, if memory pressure stays critical) are reopened automatically once memory has been normal for 3 minutes
// straight, with the same conversation and the same Remote Control address. One per pass, and each one at most 3 times
// in 2 h (if memory fills up again right away, it doesn't insist). The reason for the closure comes from the service's
// log: one you stopped, unpinned (Ctrl+T) or that closed for another reason isn't reopened. Only the leader does it
// (leader.ts), every pass (every 20 s on the short timer), under a lock (<data>/reopen.lock): two sessions that both
// took the lead for a moment would both respawn the same session, the second cutting the first restart short
// With no pinned background session lacking a process there's nothing it could reopen: no pass at all then (no memory
// reading, no lock). Memory counts as normal since the first pass that found it so, among passes no more than two and
// a half minutes apart (one that comes after a longer gap starts the count again)
const NORMAL_BEFORE_REOPEN = 180000
let reopening = false
async function reopenRetiredSessions($: any) {
  if (reopening || !daemonLog || !dataDir) return
  const first = await storeGet($, 'reopenPass')
  if (first && (await $.clock.now()) - first.at < 15000) return
  const pinned = new Set((await pinsFromFile($)) ?? [])
  if (pinned.size === 0) return
  const list = await officialList($)
  if (typeof list === 'string' || !list.some(s => s.kind === 'background' && !s.pid && pinned.has(s.id))) return
  reopening = true
  try {
    await withLock($, `${dataDir}/reopen`, () => reopenPass($), 10)
  } finally {
    reopening = false
  }
}

async function reopenPass($: any) {
  // Read again under the lock: the session that held it may have just made the pass
  const now = await $.clock.now()
  const c = await storeGet($, 'reopenPass')
  if (c && now - c.at < 15000) return
  const normal = await platform.memoryNormal(sys($))
  const counting = typeof c?.normalSince === 'number' && now - Number(c.at) <= 150000
  const normalSince = normal ? (counting ? c.normalSince : now) : undefined
  await storeSet($, 'reopenPass', { at: now, normalSince })
  if (normalSince === undefined || now - normalSince < NORMAL_BEFORE_REOPEN) return
  const r = await daemonLogTail($)
  if (r === null) return
  const closed = stopReasons(r)
  if (!Object.values(closed).some(c => c.why === 'low-memory')) return
  const pinned = new Set((await pinsFromFile($)) ?? [])
  const list = await officialList($)
  if (typeof list === 'string') return
  for (const s of list) {
    const c = typeof s.id === 'string' ? closed[s.id] : undefined
    const when = c?.why === 'low-memory' ? c.at : undefined
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
    await invalidateList($)
    return
  }
}

// Why stopped sessions stopped, from the background service's log (stopLog), read right then. A log that can't be read
// says nothing: no session reads as ended by itself (stoppedKind fails closed)
let parsedLog: { text: string; log: StopLog } | null = null
async function stopLogNow($: any): Promise<StopLog> {
  const none: StopLog = { reasons: {}, started: {}, deaths: [] }
  if (!daemonLog) return none
  const text = await daemonLogTail($)
  if (text === null) return none
  // The same tail as last time (the log didn't move): parsed once
  if (parsedLog?.text === text) return parsedLog.log
  parsedLog = { text, log: stopLog(text) }
  return parsedLog.log
}

// The end of the background service's log (its last 4000 lines), read with tail only when the log changed (its time
// and size) since the last read here: $.sessions.status and the reopen pass ask for it often, and it rarely moves.
// null when it can't be read
let logTail: { mtimeMs: number; size: number; text: string } | null = null
async function daemonLogTail($: any): Promise<string | null> {
  let st: any = null
  try {
    st = await $.fs.stat(daemonLog)
  } catch {}
  if (st && logTail && logTail.mtimeMs === Number(st.mtimeMs) && logTail.size === Number(st.size)) return logTail.text
  const r = await runSafe($, ['tail', '-n', '4000', daemonLog])
  if (r.exitCode !== 0) {
    logTail = null
    return null
  }
  logTail = st ? { mtimeMs: Number(st.mtimeMs), size: Number(st.size), text: r.stdout } : null
  return r.stdout
}

// Why a background session of the list with no process is stopped (stoppedKind): the log, read once by the caller; the
// person's stop this mod remembers (a claude stop the log shows is remembered too, the first time it's seen, so it
// outlives the log's tail); when it last ran (its last start in the log, or its mod's last heartbeat)
async function stoppedOf($: any, s: any, log: StopLog): Promise<'person' | 'idle' | 'memory' | 'ended' | 'unknown'> {
  const reason = typeof s.id === 'string' ? log.reasons[s.id] : undefined
  let personAt = await storeGet($, `personStop:${s.sessionId}`)
  if (reason?.why === 'stopped' && typeof personAt !== 'number') {
    personAt = reason.at
    await storeSet($, `personStop:${s.sessionId}`, reason.at)
  }
  const beatAt = (await readHeartbeats($, [s.sessionId]))[s.sessionId]?.at
  const runs = [typeof s.id === 'string' ? log.started[s.id] : undefined, beatAt].filter((t): t is number => typeof t === 'number' && t > 0)
  return stoppedKind(reason, personAt, runs.length ? Math.max(...runs) : undefined, log.deaths)
}

// ---- The sessions that ended with the background service ----

// The background sessions of every folder that ended with Claude's background service and are still stopped
// (diedWithService: the service's log found workers dead after they last ran, with nothing of their own since and no
// stop of the person's). From a list as it is (no command), the service's log (read again only when it changed), each
// one's last heartbeat and the person's stops from a panel (personStop, read only for the sessions the store has one
// for: keys, one read of the store's keys). No stopped background session, or a log with no death, reads nothing more
async function endedSessions($: any, list: readonly any[], keys: ReadonlySet<string>): Promise<EndedSession[]> {
  const stopped = list.filter(s => s.kind === 'background' && !s.pid && typeof s.id === 'string' && typeof s.sessionId === 'string' && s.sessionId !== myId)
  if (stopped.length === 0 || !daemonLog) return []
  const log = await stopLogNow($)
  if (log.deaths.length === 0) return []
  const beats = await readHeartbeats($, stopped.map(s => s.sessionId))
  const out: EndedSession[] = []
  for (const s of stopped) {
    const personAt = keys.has(`personStop:${s.sessionId}`) ? await storeGet($, `personStop:${s.sessionId}`) : undefined
    const runs = [log.started[s.id], beats[s.sessionId]?.at].filter((t): t is number => typeof t === 'number' && t > 0)
    const at = diedWithService(log.reasons[s.id], personAt, runs.length ? Math.max(...runs) : undefined, log.deaths)
    if (at === undefined) continue
    out.push({ sessionId: s.sessionId, id: s.id, name: s.name && s.name !== s.id ? String(s.name) : s.id, cwd: typeof s.cwd === 'string' ? s.cwd : '', at })
  }
  return out
}

// The panel's line about them (endedText), the same in every session's panel: worked out again at each refresh, and
// when a session came or went in any folder (the line counts every folder's). Those of the death the person dismissed
// the line for, and of the ones before it, are left out (endedDismissed)
async function readEnded($: any, keys?: ReadonlySet<string>) {
  const k = keys ?? new Set(await storeKeys($))
  const all = await endedSessions($, lastList, k)
  const shown = all.length ? endedShown(all, k.has('endedDismissed') ? await storeGet($, 'endedDismissed') : undefined) : []
  const line = endedText(shown, await $.clock.now())
  const next: EndedNote = line ? { ...line, count: shown.length } : null
  if (!sameData(await read($, ended), next)) await update($, ended, () => next)
}

// The b key, on that line: a question (how many, from which folders), then they're brought back one at a time,
// BRING_BACK_STAGGER_MS apart, through the restart path (claude respawn; a window with a launcher that showed one is
// told to reopen it). Each one is looked at again just before (stillEnded): one the person stopped since, one that runs
// again, one gone from the list or that another panel is bringing back is skipped, and never one that didn't end with
// the service. Leave them stopped dismisses the line for that death (endedDismissed): the next death shows it again
const BRING_BACK_STAGGER_MS = 3000
const BROUGHT_BACK_MS = 120000
let bringingBack = false
async function bringBack($: any) {
  if (bringingBack) return
  bringingBack = true
  try {
    const list = await officialList($, 2000)
    if (typeof list === 'string') {
      $.ui.toast(list)
      return
    }
    const keys = new Set(await storeKeys($))
    const found = endedShown(await endedSessions($, list, keys), keys.has('endedDismissed') ? await storeGet($, 'endedDismissed') : undefined)
    if (found.length === 0) {
      $.ui.toast('Nothing to bring back: those sessions run again, or were stopped or removed')
      await readEnded($)
      return
    }
    const { bring, leave, options } = bringBackOptions(found.length)
    let answer = ''
    try {
      answer = await $.ui.ask(bringBackQuestion(found, await $.clock.now(), home), { options, header: 'Sessions' })
    } catch (err) {
      if (askRejection(err) === 'unshown') {
        $.ui.toast(`Couldn't show the question in this session (its agent may have no AskUserQuestion): nothing was changed`)
        return
      }
    }
    // The keyboard back to the panel, on the row that was selected (as after s and u), whatever the answer
    await focusRow($, selectedRow?.startsWith('s:') ? selectedRow.slice(2) : '', undefined)
    if (answer === leave) {
      await storeSet($, 'endedDismissed', Math.max(...found.map(s => s.at)))
      await readEnded($)
      return
    }
    if (answer !== bring) return
    if (found.length > 1) $.ui.toast(`Bringing back ${found.length} sessions, one at a time…`)
    let done = 0
    let skipped = 0
    let failed = 0
    for (const s of found) {
      if (done + failed > 0) await $.clock.sleep(BRING_BACK_STAGGER_MS)
      const skip = await stillEnded($, s)
      if (skip) {
        skipped++
        debugLine($, `bring back “${s.name}”: skipped, ${skip}`)
        continue
      }
      const ok = await respawnWithWindows($, s.id, s.name)
      debugLine($, `bring back “${s.name}”: ${ok ? 'restarted' : 'failed'}`)
      if (ok) done++
      else failed++
      await invalidateList($)
    }
    $.ui.toast(bringBackResult(done, skipped, failed))
    await requestRefresh($, false)
  } finally {
    bringingBack = false
  }
}

// The claims on sessions being brought back (the store's broughtBack: by sessionId, since when) that still hold: a
// panel's b, or a wake Claude asked for (mcp__sessions__wake), for BROUGHT_BACK_MS
function heldClaims(claims: unknown, at: number): Record<string, number> {
  const held: Record<string, number> = {}
  for (const [k, v] of Object.entries(claims && typeof claims === 'object' ? claims : {})) if (typeof v === 'number' && at - v < BROUGHT_BACK_MS) held[k] = v
  return held
}

// Whether a session to bring back still ended with the service, right before its respawn: '' if so, and then it's
// claimed (broughtBack, under the <data>/bringback.lock folder, so another panel bringing it back too, or Claude waking
// it, skips it); else why not
async function stillEnded($: any, s: EndedSession): Promise<string> {
  if (!dataDir) return 'no data folder'
  let why = 'another panel holds the lock'
  await withLock($, `${dataDir}/bringback`, async () => {
    const list = await officialList($, 2000)
    if (typeof list === 'string') {
      why = "the session list can't be read"
      return
    }
    const now = list.find(x => x.sessionId === s.sessionId)
    if (!now || now.id !== s.id) {
      why = 'gone from the list'
      return
    }
    if (now.pid) {
      why = 'it runs again'
      return
    }
    const at = await $.clock.now()
    const held = heldClaims(await storeGet($, 'broughtBack'), at)
    if (held[s.sessionId] !== undefined) {
      why = 'another panel is bringing it back'
      return
    }
    if ((await endedSessions($, [now], new Set(await storeKeys($)))).length === 0) {
      why = 'it no longer reads as ended with the service (stopped by you, or it ran since)'
      return
    }
    await storeSet($, 'broughtBack', { ...held, [s.sessionId]: at })
    why = ''
  })
  return why
}

// Whether a session can be woken (another plugin's wake, ccc tell): running already, or stopped and wakeable. A
// background session the service retired for being idle is woken, one that ended by itself (a crash, or the machine or
// the service restarted under it: on the log's evidence), and one it closed for lack of memory once memory is normal
// again. Never a regular session (it lives in its own window), nor one closed for lack of memory while memory is short;
// one the person stopped, or one with no evidence of why it stopped, only when the caller acts on the person's own
// command (force: wake's input, 0.15.1)
type WakeVerdict = { state: 'running' } | { state: 'refused'; detail: string } | { state: 'wake'; id: string; name: string; why: string }
async function wakeVerdict($: any, ref: string, force = false): Promise<WakeVerdict> {
  const s = lastList.find(x => refOf(x) === ref)
  if (!s) return { state: 'refused', detail: `${ref} isn't in the session list` }
  const name = String(projectRows.find(f => f.sessionId === s.sessionId)?.title ?? (s.name || s.id || ref))
  if (s.kind !== 'background' || typeof s.id !== 'string') return { state: 'refused', detail: `“${name}” is a regular session: it lives in its own window` }
  if (s.pid) return { state: 'running' }
  const why = await stoppedOf($, s, await stopLogNow($))
  if (why === 'person' && !force) return { state: 'refused', detail: `“${name}” was stopped by you: Enter or u restarts it` }
  if (why === 'unknown' && !force) return { state: 'refused', detail: `nothing says why “${name}” stopped (not a crash or a restart the service's log shows): Enter or u restarts it` }
  if (why === 'memory' && (await platform.memoryNormal(sys($))) !== true) return { state: 'refused', detail: `Claude closed “${name}” for lack of memory, and memory is still short` }
  return { state: 'wake', id: s.id, name, why }
}

// The sessions other plugins asked to wake ($.sessions.wake), from this mod's own 0.5 s timer: claude respawn, if
// they're still stopped
let wakes: { id: string; name: string; reason: string }[] = []
let waking = false
async function runWakes($: any) {
  if (waking || wakes.length === 0) return
  waking = true
  try {
    for (let w = wakes.shift(); w; w = wakes.shift()) {
      const list = await officialList($, 2000)
      if (Array.isArray(list) && list.some(s => s.id === w.id && s.pid)) continue
      const done = await run($, [claude, 'respawn', w.id])
      debugLine($, `wake “${w.name}” (${w.reason || 'no reason given'}): ${done.exitCode === 0 ? 'restarted' : 'failed'}`)
      if (done.exitCode !== 0) $.ui.toast(`Couldn't wake “${w.name}”`)
      await invalidateList($)
    }
  } finally {
    waking = false
  }
}

// ---- Tools for Claude: mcp__sessions__list and mcp__sessions__wake ----
// Two deferred tools for the model of every interactive session (the sessionTools option), answered here and never by
// the engine: the project's other sessions, and waking a stopped one so SendMessage can reach it (SendMessage to a
// stopped session fails at once, and isn't kept for it). A wake starts no turn there: only the message that follows
// does. They answer the main conversation only, and refuse in place of the question an ask rule wants (a hook that
// answers a call never puts it to the person). A wake goes by wakeVerdict's rules ($.sessions.wake's) and more: a
// session of this project other than this one, never while memory is short, at most so many wakes per caller and per
// session (WAKE_LIMITS in state.ts, the store's modelWakes), claimed under <data>/bringback.lock (broughtBack, with the
// panel's b) so two callers never restart one session twice; then the wake queue ($.sessions.wake's), and the answer
// once it runs: the name to SendMessage to, from ListAgents. Their input stays as it is ({} and { session }): other
// plugins code against it, and refuse a wake with a hook of their own: on tool.call (it stands before these only in a
// plugin that depends on sessions) or on tool.check (heard whatever the order: toolGate asks it first). See
// docs/plugin-contract.md
const LIST_TOOL = 'mcp__sessions__list'
const WAKE_TOOL = 'mcp__sessions__wake'
const TOOL_SPECS: Record<SessionTool, { name: string; description: string; inputSchema: Record<string, unknown>; isDeferred: true }> = {
  list: {
    name: 'list',
    description:
      "Lists this project's other Claude sessions: each one's name as ListAgents and SendMessage know it, its short id, whether it's working, idle, waiting for the person or stopped (and why), whether mcp__sessions__wake can bring it back, and the agent it runs as. SendMessage reaches only running sessions: a message to a stopped one fails at once. Spends no tokens beyond this result.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    isDeferred: true,
  },
  wake: {
    name: 'wake',
    description:
      "Brings back a stopped background session of this project so SendMessage can reach it: one the background service retired for being idle, or that ended with a crash or a restart. Never one the person stopped, a regular session, or one of another project. session: its name or short id, as mcp__sessions__list shows it. The wake itself starts no turn there; it waits until the session runs (a few seconds) and answers the name to SendMessage to. Main conversation only.",
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: "The session's name or short id, as mcp__sessions__list shows it" } },
      required: ['session'],
      additionalProperties: false,
    },
    isDeferred: true,
  },
}
// How long a wake waits for the session to run before answering (a restart takes about a second)
const WAKE_WAIT_MS = 5000
// What the start registered, or why not, for /sessions status
let toolsOffered = ''
// classic.SessionStart, which says the agent, is raised beside session.start, not inside it (checked on 2.1.319: it
// settled after session.start's whole chain): its hook notes the agent here at once (roleSeen), and session.start
// waits for it while the mod's own start runs (startDone), ROLE_WAIT_MS at most. Where none comes, that start ends the
// wait, a moment later: a reload (which raises none; offerAfterReload), or a host where a plugin that runs before this
// one sends SessionStart on past it (a managed or built-in one: nothing this mod can change). There the role comes from
// Claude's files instead (roleFromFiles), and the machine remembers, once ROLE_SKIP_CHECK_MS on, that no SessionStart
// came (the store's startSkipped): its next starts take the files at once, with no wait. The next SessionStart that
// reaches the mod forgets it
const ROLE_WAIT_MS = 1000
// How long Claude's files may take to say the role before the start goes on without it (taken as no agent)
const ROLE_FILES_MS = 500
const ROLE_SKIP_CHECK_MS = 10000
const START_SKIPPED = 'startSkipped'
let roleSeen: AgentRole = null
let roleKnown: () => void = () => {}
const roleCame = new Promise<void>(resolve => (roleKnown = resolve))
let startDone = false
// The start's first step is done: this session's id, and whether this module came in by a reload (reloadedInto)
let idKnown: () => void = () => {}
const idCame = new Promise<void>(resolve => (idKnown = resolve))
// This machine's starts find no SessionStart (START_SKIPPED, as read at this start or noted by it)
let startSkipped = false
// Where the role came from when no SessionStart said it ('' when one did, or a reload found it in $.state)
let roleFrom = ''

// A promise raced against the clock: its value, or null when it fails or takes longer than ms
function within<T>($: any, work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work.catch(() => null), $.clock.sleep(ms).then(() => null)])
}

// The agent file of the agent this session runs as: <folder>/.claude/agents/<name>.md from the folder the session
// started in up to the home folder, then ~/.claude/agents/<name>.md. null: none (a plugin's agent, --agents JSON)
async function agentFile($: any, agent: string, cwd: string): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agent)) return null
  const h = String((await $.env.get('HOME')) ?? '')
  const folders: string[] = []
  for (let d = cwd, i = 0; d.startsWith('/') && d !== '/' && d !== h && i < 12; d = d.replace(/\/[^/]*$/, ''), i++) folders.push(`${d}/.claude/agents`)
  if (h) folders.push(`${h}/.claude/agents`)
  for (const f of folders) {
    try {
      return String(await $.fs.read(`${f}/${agent}.md`))
    } catch {}
  }
  return null
}

// Why the panel isn't live and the role came from Claude's files, in a session that started with no SessionStart
const SKIPPED_START =
  "no SessionStart reached the mod in this session: a plugin that runs before sessions (such as a managed or built-in one) sent it on past it, which a restart doesn't change (Claude names that plugin in a line as the session starts)"
const toolNames = (tools: readonly SessionTool[]) => tools.map(t => `mcp__sessions__${t}`).join(', ')

// Registers the tools; true once they all are, false when that took longer than ms (they still come)
async function registerTools($: any, tools: readonly SessionTool[], ms: number): Promise<boolean> {
  return (await within($, Promise.all(tools.map(t => $.tool.register(TOOL_SPECS[t]))), ms)) !== null
}

// The agent this session runs as where no classic.SessionStart said it, from what Claude keeps on disk: this session's
// entry in Claude's registry of running sessions (its `agent`, there from the start, absent with none: checked on
// 2.1.319), and a background session's job record (`--agent <name>` among the respawnFlags its restarts replay). An
// agent either one names wins: taking an agent session for a plain one is what could hold its start 8 s. null: neither
// was found
async function roleFromFiles($: any): Promise<{ role: { agent: string | null }; from: string } | null> {
  const sessionId = String(await $.session.id())
  const l = await locationsOf($)
  let entry: RegistryEntry | undefined
  if (l.registry && sessionId) {
    const files = new SessionFiles(l)
    await syncRegistry($, files)
    entry = files.entries().find(e => e.sessionId === sessionId)
  }
  // The job's folder: the one Claude names in CLAUDE_JOB_DIR when it's this session's (a session started from another
  // one's shell inherits that one's), else the registry's job id in the service's folder
  const named = String((await $.env.get('CLAUDE_JOB_DIR')) ?? '').replace(/\/+$/, '')
  const short = entry?.kind === 'bg' && entry.jobId ? entry.jobId.slice(0, 8) : ''
  const jobDir = !entry ? named : !short ? '' : named.split('/').pop() === short ? named : l.jobs ? `${l.jobs}/${short}` : ''
  let flags: unknown[] | null = null
  if (jobDir.startsWith('/')) {
    try {
      const f = JSON.parse(String(await $.fs.read(`${jobDir}/state.json`)))?.respawnFlags
      if (Array.isArray(f)) flags = f
    } catch {}
  }
  const jobAgent = flags ? agentFromFlags(flags) : null
  if (jobAgent) return { role: { agent: jobAgent }, from: "its background job's flags" }
  if (entry) return { role: { agent: entry.agent ?? null }, from: "Claude's registry of sessions" }
  if (flags) return { role: { agent: null }, from: "its background job's flags" }
  return null
}

// A start that no SessionStart reached: once it's clear none is coming (ROLE_SKIP_CHECK_MS), this machine remembers
// (START_SKIPPED), so its next starts don't wait for one
async function noteSkippedStart($: any) {
  if (startSkipped) return
  await $.clock.sleep(ROLE_SKIP_CHECK_MS)
  if (roleSeen || startSkipped) return
  if (await storeSet($, START_SKIPPED, { at: await $.clock.now() })) startSkipped = true
  debugLine($, `no SessionStart came in ${ROLE_SKIP_CHECK_MS / 1000} s: this machine's next starts don't wait for one`)
}

// A SessionStart of a process's start reached the mod: this machine's starts wait for one again
async function forgetSkippedStart($: any) {
  if ((await storeGet($, START_SKIPPED)) != null) {
    await storeDelete($, START_SKIPPED)
    debugLine($, 'a SessionStart came: the next starts wait for one again')
  }
  startSkipped = false
}

// At session.start, after the plugins beneath, once the agent is known (classic.SessionStart, waited for a moment, or
// at once where it never comes, Claude's files; a reload finds it in $.state): the tools this session's agent can see,
// registered before the first request and awaited for a moment only. An agent whose tools: line doesn't name them gets
// none (registering them would hold each start and restart 8 s); one whose file isn't found, a short wait. Where
// nothing says the agent in time, they're registered without holding the start: a plain session sees them from its
// next request, and an agent session never shows them, which holds nothing either. A reload registers them again,
// which changes nothing
async function offerTools($: any, cwd: string) {
  if (!sessionTools) {
    toolsOffered = 'off (the sessionTools option)'
    return
  }
  let role = roleSeen ?? (await read($, agentRole))
  if (role === null) startSkipped ||= (await storeGet($, START_SKIPPED)) != null
  if (role === null && starting && !startDone) {
    await Promise.race([roleCame, startSkipped ? idCame : $.clock.sleep(ROLE_WAIT_MS), starting].map(w => w.catch(() => {})))
    role = roleSeen ?? (await read($, agentRole))
  }
  if (role === null) {
    await Promise.race([idCame, $.clock.sleep(ROLE_WAIT_MS)])
    if (reloadedInto) {
      toolsOffered = 'not offered: no SessionStart reached the mod in this session (updated in place from an older version); a restart (u) offers them'
      bg(offerAfterReload($, cwd))
      return
    }
    // A fresh start that no SessionStart reached (yet): the role from Claude's files, recorded for a reload as one from
    // SessionStart is
    bg(noteSkippedStart($))
    const found = await within($, roleFromFiles($), ROLE_FILES_MS)
    debugLine($, `no SessionStart at the start: ${found ? `${found.role.agent ? `agent ${found.role.agent}` : 'no agent'}, from ${found.from}` : "Claude's files didn't say the agent in time"}`)
    role = roleSeen ?? found?.role ?? null
    if (!roleSeen && found) {
      roleFrom = found.from
      try {
        if (!sameData(await read($, agentRole), found.role)) await update($, agentRole, () => found.role)
      } catch {}
    }
    if (role === null) {
      toolsOffered = `${toolNames(SESSION_TOOLS)} (taken as no agent, since no SessionStart reached the mod and Claude's files didn't say in time: from the next request on)`
      bg(registerTools($, SESSION_TOOLS, 10000).then(done => debugLine($, `tools for Claude: ${toolsOffered}${done ? '' : ', still registering after 10 s'}`)))
      return
    }
  }
  const plan = role.agent ? roleTools(await agentFile($, role.agent, cwd)) : { tools: [...SESSION_TOOLS], waitMs: TOOLS_WAIT_MS, why: 'no agent' }
  const from = roleFrom ? `from ${roleFrom}, since no SessionStart reached the mod` : ''
  toolsOffered = plan.tools.length
    ? `${toolNames(plan.tools)} (${role.agent ? `agent ${role.agent}: ` : ''}${plan.why}${from ? `; ${from}` : ''})`
    : `not offered: agent ${role.agent}, ${plan.why}${from ? ` (${from})` : ''}`
  if (!plan.tools.length) {
    debugLine($, `tools for Claude: ${toolsOffered}`)
    return
  }
  const done = await registerTools($, plan.tools, plan.waitMs)
  debugLine($, `tools for Claude: ${toolsOffered}${done ? '' : `, still registering after ${plan.waitMs} ms`}`)
}

// A module that came in by an update in place where none before it recorded the agent (0.15.1 and before: no
// SessionStart in this module's life, no agentRole) learns it from Claude's files (roleFromFiles), else from the
// session's transcript (readAgent, a few beats at most), in the background: session.start isn't held. With no agent the
// tools are registered then, which a plain session sees from its next request, and that's recorded (agentRole) for
// later reloads; an agent session gets none until it restarts (a registration not awaited at session.start never shows
// in one, and one it doesn't list would hold its starts 8 s), and nothing is recorded: each reload decides the same
// until then
async function offerAfterReload($: any, cwd: string) {
  await (starting ?? Promise.resolve()).catch(() => {})
  if (!reloadedInto || !sessionTools || roleSeen) {
    debugLine($, `tools for Claude: ${toolsOffered}`)
    return
  }
  let found = await within($, roleFromFiles($), 5000)
  if (!found) {
    for (let i = 0; i < 5 && agentFor !== myId; i++) {
      await readAgent($)
      if (agentFor !== myId) await $.clock.sleep(1000)
    }
    if (agentFor === myId) found = { role: { agent: myAgent }, from: 'its transcript' }
  }
  if (!found || roleSeen) {
    debugLine($, `tools for Claude: ${toolsOffered} (neither Claude's files nor the transcript could say which agent it runs as)`)
    return
  }
  const agent = found.role.agent
  if (agent) {
    const plan = roleTools(await agentFile($, agent, cwd))
    toolsOffered = plan.tools.length
      ? `not offered: agent ${agent}, and this session was updated in place from a version without them; a restart (u) offers them`
      : `not offered: agent ${agent}, ${plan.why}`
    debugLine($, `tools for Claude: ${toolsOffered}`)
    return
  }
  const role: AgentRole = { agent: null }
  try {
    if (!sameData(await read($, agentRole), role)) await update($, agentRole, () => role)
  } catch {}
  toolsOffered = `${toolNames(SESSION_TOOLS)} (no agent, as ${found.from} says; offered after an update in place, from the next request on)`
  const done = await registerTools($, SESSION_TOOLS, 10000)
  debugLine($, `tools for Claude: ${toolsOffered}${done ? '' : ', still registering after 10 s'}`)
}

// Claude's own name for a session (what ListAgents and SendMessage use), '' when it has none; and its title in the panel
function claudeName(s: any): string {
  return typeof s?.name === 'string' && s.name && s.name !== s.id ? s.name : ''
}
function panelTitle(s: any): string {
  return String(projectRows.find(f => f.sessionId === s.sessionId)?.title ?? (claudeName(s) || s.id || String(s.sessionId).slice(0, 8)))
}
function toolName(s: any): string {
  return claudeName(s) || panelTitle(s)
}

// The guards both tools share: the option, the main conversation only, an ask rule (refused, since the call is never put
// to the person), and a panel that has read the list. '' when the call goes on
async function toolGate($: any, e: any, tool: string, input: Record<string, unknown>): Promise<string> {
  if (!sessionTools) return `${tool} is turned off in the sessions plugin's options (sessionTools)`
  if (e.agentId !== undefined) return `${tool} answers only the main conversation, not a subagent or a teammate`
  const c: any = await within($, Promise.resolve($.tool.check({ tool, input })), 1000)
  if (!c) return `couldn't check the permission rules for ${tool}: try again in a few seconds`
  if (c.decision === 'ask' && typeof c.rule === 'string' && c.rule) {
    return `a permission rule (${c.rule}) asks the person before ${tool} runs, and this tool can't put that question to them, so nothing was done: ask the person to do it, or to change that rule`
  }
  if (c.decision === 'deny') return `refused by a permission check${c.reason ? `: ${String(c.reason).slice(0, 200)}` : ''}`
  if (!ready()) return "the sessions panel hasn't read the session list in this session yet: try again in a few seconds"
  return ''
}

// mcp__sessions__wake's rules, for a session of the list: wakeVerdict's ($.sessions.wake's), for a session of this
// project other than this one, and none while memory is short (short: platform.memoryNormal, when the caller has it),
// worded for the model
async function modelWakeVerdict($: any, s: any, short?: boolean): Promise<WakeVerdict> {
  const name = toolName(s)
  if (s.sessionId === myId) return { state: 'refused', detail: `“${name}” is this very session` }
  if (!belongsHere(s)) return { state: 'refused', detail: `“${name}” belongs to another project (${sessionHome(whereabouts(s)) || 'not known'}): mcp__sessions__wake wakes only this project's sessions` }
  const v = await wakeVerdict($, refOf(s))
  if (v.state === 'refused' && s.kind === 'background' && !s.pid) {
    const kind = await stoppedOf($, s, await stopLogNow($))
    if (kind === 'person') return { state: 'refused', detail: `“${name}” was stopped by the person: only they restart it (Enter or u in the panel)` }
    if (kind === 'unknown') return { state: 'refused', detail: `nothing says why “${name}” stopped (no idle retirement, crash or restart in the background service's log): only the person restarts it (Enter or u in the panel)` }
  }
  if (v.state === 'wake' && (short ?? (await platform.memoryNormal(sys($))) === false)) return { state: 'refused', detail: "memory is short on this computer, and no session is woken until it's normal again" }
  return v
}

// Why a stopped background session stopped, and when when the log or the person's stop says: "retired for being idle
// 2 h ago"
async function stoppedNow($: any, s: any, log: StopLog): Promise<{ kind: 'person' | 'idle' | 'memory' | 'ended' | 'unknown'; at?: number }> {
  const kind = await stoppedOf($, s, log)
  let at = typeof s.id === 'string' ? log.reasons[s.id]?.at : undefined
  if (kind === 'person' && !at) {
    const p = await storeGet($, `personStop:${s.sessionId}`)
    if (typeof p === 'number') at = p
  }
  return at ? { kind, at } : { kind }
}
async function stoppedText($: any, s: any, now: number): Promise<string> {
  const why = await stoppedNow($, s, await stopLogNow($))
  return `${stoppedWords(why.kind)}${why.at && why.at <= now ? ` ${howLong(now - why.at)} ago` : ''}`
}

// A wake limit, in words: whose, and when it can be asked again
function limitText(l: NonNullable<ReturnType<typeof wakeLimit>>, name: string, now: number): string {
  const when = `${clockText(new Date(l.until), new Date(now))} (in ${howLong(Math.max(60000, l.until - now))})`
  return l.who === 'caller'
    ? `this session already asked for ${l.count} wakes in the last ${howLong(l.ms)}: it can wake one again at ${when}`
    : `“${name}” was woken ${l.count} times in the last hour (it may fail to start): it can be woken again at ${when}`
}

// The list as Claude's files show it now (read again when older than 2 s), with the panel refreshed from it: the
// projects (learnHomes) and wakeVerdict go by the same list
async function freshList($: any): Promise<any[]> {
  await officialList($, 2000)
  await requestRefresh($, false)
  return lastList
}

// The session this call names, among the list's sessions of this project other than this one, or the refusal
async function sessionNamed($: any, asked: string): Promise<{ s: any } | { deny: string }> {
  const list = await freshList($)
  const pickable = (s: any) => ({ s, sessionId: String(s.sessionId), id: typeof s.id === 'string' ? s.id : null, name: claudeName(s), title: panelTitle(s) })
  const mine = list.filter(s => typeof s?.sessionId === 'string' && s.sessionId !== myId && belongsHere(s)).map(pickable)
  const named = (p: { name: string; title: string; id: string | null }) => `“${p.name || p.title}” (${p.id ?? 'regular session'})`
  const pick = pickSession(mine, asked)
  if ('found' in pick) return { s: pick.found.s }
  if ('many' in pick) return { deny: `Several sessions of this project match “${asked}”: ${pick.many.map(named).join(', ')}. Call again with the short id.` }
  const self = list.find(s => s?.sessionId === myId)
  if (self && 'found' in pickSession([pickable(self)], asked)) return { deny: `“${toolName(self)}” is this very session.` }
  const elsewhere = pickSession(list.filter(s => typeof s?.sessionId === 'string' && !belongsHere(s)).map(pickable), asked)
  if (!('none' in elsewhere)) return { deny: `“${asked}” belongs to another project: mcp__sessions__wake wakes only this project's sessions.` }
  const some = mine.slice(0, 12).map(named)
  return { deny: `No session of this project is called “${asked}”.${some.length ? ` This project's other sessions: ${some.join(', ')}.` : ' This project has no other sessions.'}` }
}

// Where SendMessage reaches a session that runs: "<name> [<ref>]" from ListAgents (raced against a second; never a
// question to the person: only when the permission check allows it without one; no row of it reaches the model), else
// its name alone
async function sendAddress($: any, name: string): Promise<string> {
  const c: any = await within($, Promise.resolve($.tool.check({ tool: 'ListAgents', input: {} })), 500)
  if (c?.decision !== 'allow') return name
  const r: any = await within($, Promise.resolve($.tool.call({ tool: 'ListAgents' } as any)), 1000)
  const sections = Array.isArray(r?.result?.sections) ? r.result.sections : []
  return agentAddress(
    sections.flatMap((x: any) => (Array.isArray(x?.rows) ? x.rows : [])),
    name,
  )
}

// The claim on a wake, under <data>/bringback.lock with the panel's b: the session still stopped (a list read now), no
// other claim on it (broughtBack), within the limits (modelWakes); then both recorded. why: '' when claimed (at: the
// claim's time), 'running' when it runs by now, else why not
async function claimWake($: any, s: any, name: string): Promise<{ why: string; at: number }> {
  if (!dataDir) return { why: 'the sessions panel has no data folder in this session', at: 0 }
  let why = 'another session holds the wake lock: try again in a few seconds'
  let claimed = 0
  await withLock(
    $,
    `${dataDir}/bringback`,
    async () => {
      const list = await officialList($, 0)
      if (typeof list === 'string') {
        why = `${list}: try again in a few seconds`
        return
      }
      const now = list.find(x => x.sessionId === s.sessionId)
      if (!now || now.id !== s.id) {
        why = `“${name}” left the session list`
        return
      }
      if (now.pid) {
        why = 'running'
        return
      }
      const at = await $.clock.now()
      const held = heldClaims(await storeGet($, 'broughtBack'), at)
      if (held[s.sessionId] !== undefined) {
        why = `another session or panel is bringing “${name}” back right now: call mcp__sessions__list in a minute`
        return
      }
      const log = modelWakesOf(await storeGet($, 'modelWakes'), at)
      const limit = wakeLimit(log, myId, s.sessionId, at)
      if (limit) {
        why = limitText(limit, name, at)
        return
      }
      await storeSet($, 'modelWakes', [...log, { at, by: myId, target: s.sessionId }])
      await storeSet($, 'broughtBack', { ...held, [s.sessionId]: at })
      why = ''
      claimed = at
    },
    20,
  )
  return { why, at: claimed }
}

// Once the woken session runs, this wake's claim goes (a later wake finds it running; one after it stops again needn't
// wait the claim's two minutes): only this wake's own, under the lock (left to expire when the lock isn't taken)
async function releaseClaim($: any, sessionId: string, at: number) {
  if (!dataDir || !at) return
  await withLock(
    $,
    `${dataDir}/bringback`,
    async () => {
      const held = heldClaims(await storeGet($, 'broughtBack'), await $.clock.now())
      if (held[sessionId] !== at) return
      delete held[sessionId]
      await storeSet($, 'broughtBack', held)
    },
    10,
  )
}

// Whether the session runs within ms, by the list read again every 250 ms
async function runsWithin($: any, sessionId: string, ms: number): Promise<boolean> {
  const until = (await $.clock.now()) + ms
  for (;;) {
    await $.clock.sleep(250)
    const list = await officialList($, 0)
    if (Array.isArray(list) && list.some(x => x.sessionId === sessionId && x.pid)) return true
    if ((await $.clock.now()) >= until) return false
  }
}

// "woken by “<caller>”" under the woken session's row, in every panel, for WOKEN_MARK_MS: a mark of the panel's own
async function markWoken($: any, s: any, by: string) {
  const now = await $.clock.now()
  await storeSet($, `marks:sessions:${s.sessionId}`, { at: now, until: now + WOKEN_MARK_MS, rows: { [refOf(s)]: { line: wokenLine(by), tint: 'suggestion' } } })
  forgetStored(k => k.startsWith('marks:'))
}

async function listTool($: any, e: any): Promise<{ result: string } | { deny: string }> {
  const gate = await toolGate($, e, LIST_TOOL, {})
  if (gate) return { deny: gate }
  const list = await freshList($)
  const others = list.filter(s => typeof s?.sessionId === 'string' && s.sessionId !== myId && belongsHere(s))
  const now = await $.clock.now()
  const log = await stopLogNow($)
  const short = others.some(s => !s.pid) ? (await platform.memoryNormal(sys($))) === false : false
  const wakeLog = modelWakesOf(await storeGet($, 'modelWakes'), now)
  const rows: ToolRow[] = []
  for (const s of others) {
    const running = !!s.pid
    const state = !running ? 'stopped' : s.status === 'busy' ? 'working' : s.status === 'waiting' ? 'waiting' : 'idle'
    const stop = !running && s.kind === 'background' ? await stoppedNow($, s, log) : null
    let wake = running ? 'it runs' : ''
    if (!running) {
      const v = await modelWakeVerdict($, s, short)
      const limit = v.state === 'wake' ? wakeLimit(wakeLog, myId, s.sessionId, now) : null
      wake = v.state === 'refused' ? v.detail : limit ? limitText(limit, toolName(s), now) : ''
    }
    const agent = (await readState($, s.sessionId))?.agent
    rows.push({
      sessionId: s.sessionId,
      id: typeof s.id === 'string' ? s.id : null,
      name: claudeName(s),
      title: panelTitle(s),
      state,
      ...(stop ? { stopped: stop.kind, ...(stop.at ? { stoppedAt: stop.at } : {}) } : {}),
      wake,
      agent: typeof agent === 'string' && agent ? agent : null,
    })
  }
  return { result: toolListText(rows, myCwd, now) }
}

async function wakeTool($: any, e: any): Promise<{ result: string } | { deny: string }> {
  const asked = typeof e.session === 'string' ? e.session.trim().slice(0, 200) : ''
  const refuse = (text: string) => {
    debugLine($, `${WAKE_TOOL} “${asked}”: refused, ${text}`)
    return { deny: text }
  }
  const gate = await toolGate($, e, WAKE_TOOL, { session: asked })
  if (gate) return refuse(gate)
  if (!asked) return refuse("session: the name or short id of a session of this project, as mcp__sessions__list shows it")
  const found = await sessionNamed($, asked)
  if ('deny' in found) return refuse(found.deny)
  const s = found.s
  const name = toolName(s)
  const v = await modelWakeVerdict($, s)
  if (v.state === 'refused') return refuse(`Not woken: ${v.detail}.`)
  const ref = ' (the [ref] changes at each restart)'
  if (v.state === 'running') return { result: `“${name}” already runs: SendMessage to "${await sendAddress($, claudeName(s) || name)}"${ref}.` }
  const why = await stoppedText($, s, await $.clock.now())
  const claim = await claimWake($, s, name)
  if (claim.why === 'running') return { result: `“${name}” already runs: SendMessage to "${await sendAddress($, claudeName(s) || name)}"${ref}.` }
  if (claim.why) return refuse(`Not woken: ${claim.why}.`)
  // The wake queue $.sessions.wake fills, run from this mod's own timer: claude respawn, if it's still stopped then
  const me = toolName(lastList.find(x => x.sessionId === myId) ?? { sessionId: myId, id: myShortId() })
  if (!wakes.some(w => w.id === v.id)) wakes.push({ id: v.id, name: v.name, reason: `${WAKE_TOOL}, from this session's Claude` })
  kickQueue()
  await markWoken($, s, me)
  debugLine($, `${WAKE_TOOL} “${name}” (${why}): asked`)
  const runs = await runsWithin($, s.sessionId, WAKE_WAIT_MS)
  bg(requestRefresh($, false))
  if (!runs) {
    $.ui.toast(`Asked “${name}” to restart, for this session's Claude`)
    return { result: `Restart of “${name}” asked (it was ${why}), and it isn't running yet: call mcp__sessions__list in a few seconds, then SendMessage to it.` }
  }
  await releaseClaim($, s.sessionId, claim.at)
  $.ui.toast(`Woke “${name}” for this session's Claude`)
  return { result: `Woke “${name}” (${why}). It runs now: SendMessage to "${await sendAddress($, claudeName(s) || name)}"${ref}.` }
}

// The sessions other plugins asked to restart ($.sessions.restart), from this mod's own timer (at once when asked:
// kickQueue): claude respawn of a running background session once it's idle with no background task (what u checks
// too), this very session through respawnSelf. One working or waiting for the person by then is dropped, said in the
// debug log: its caller asks again once it's idle. While that can't be known yet (Claude's files can't stand for the
// list and no list was read in the last few seconds: another session's listing still running, a back-off, a listing
// that failed), or it has background tasks (or they can't be read), it waits, tried again every RESTART_RETRY_MS on a
// timer of its own (the short timer and the pass run the queue too), up to RESTART_WAIT_MS after the last ask; then
// it's dropped, said in the debug log
const RESTART_RETRY_MS = 2000
const RESTART_WAIT_MS = 300000
type QueuedRestart = { id: string; sessionId: string; name: string; reason: string; until: number; next: number; waiting?: string }
let restarts: QueuedRestart[] = []
let restarting = false
let restartTimer: { cancel: () => void } | null = null
async function runRestarts($: any) {
  if (restarting || restarts.length === 0) return
  restarting = true
  try {
    for (const r of [...restarts]) {
      const now = await $.clock.now()
      if (now < r.next) continue
      const why = r.reason || 'no reason given'
      const drop = (text: string) => {
        restarts = restarts.filter(x => x !== r)
        debugLine($, `restart “${r.name}” (${why}): ${text}`)
      }
      const wait = (text: string) => {
        if (now >= r.until) return drop(`dropped: ${text} after ${howLong(RESTART_WAIT_MS)} of trying`)
        r.next = now + RESTART_RETRY_MS
        if (r.waiting !== text) debugLine($, `restart “${r.name}” (${why}): waiting, ${text}`)
        r.waiting = text
      }
      const status = await restartStatus($, r.sessionId)
      if (status === 'unknown') {
        wait("what it's doing can't be read yet")
        continue
      }
      if (status !== 'idle') {
        drop(`not now, it's ${status === undefined ? 'gone from the list' : status === null ? 'stopped' : status}`)
        continue
      }
      const tasks = await backgroundTasks($, r.id)
      if (!tasks || tasks.count > 0) {
        wait(tasks ? `it has ${tasks.count === 1 ? '1 task' : `${tasks.count} tasks`} in the background` : "its background tasks can't be read")
        continue
      }
      restarts = restarts.filter(x => x !== r)
      if (r.sessionId === myId) {
        debugLine($, `restart of this session, “${r.name}” (${why})`)
        await respawnSelf($, r.id, r.name)
        continue
      }
      const ok = await respawnWithWindows($, r.id, r.name)
      debugLine($, `restart “${r.name}” (${why}): ${ok ? 'restarted' : 'failed'}`)
      if (!ok) $.ui.toast(`Couldn't restart “${r.name}”`)
      await invalidateList($)
    }
  } finally {
    restarting = false
    if (restarts.length && !restartTimer) {
      restartTimer = $.clock.after(RESTART_RETRY_MS, () => {
        restartTimer = null
        bg(runRestarts($))
      })
    }
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

// The marks other plugins set ($.sessions.setMarks, MarkSlot in state.ts), merged per row: read on every refresh, by
// every session. An expired one is deleted by whichever session finds it
let marksNow: Record<string, RowMark> = {}
let markSources: { source: string; rows: number; until: number }[] = []
async function readMarks($: any, now: number, all: readonly string[]) {
  const keys = all.filter(k => k.startsWith('marks:'))
  const slots: MarkSlot[] = []
  const sources: typeof markSources = []
  for (const k of keys) {
    const v = await storeGet($, k)
    if (!v || typeof v !== 'object' || !(Number(v.until) > now)) {
      await storeDelete($, k)
      continue
    }
    const marked = v.rows && typeof v.rows === 'object' ? v.rows : {}
    slots.push({ at: Number(v.at) || 0, until: Number(v.until), rows: marked })
    sources.push({ source: k.split(':')[1] ?? '', rows: Object.keys(marked).length, until: Number(v.until) })
  }
  marksNow = mergeMarks(slots, now)
  markSources = sources
}

// ---- Telling the person ("Telling the person" in state.ts) ----

// Notifies the person: PushNotification first (Claude sends it to the phone when the session has Remote Control and
// the person isn't at the computer, and says why not otherwise), else $.ui.notify, their own notification channel
// (their Notification hooks run too). Only from this mod's timers: the tool's result comes back to this call, and no
// row of it reaches the conversation (checked in a test session: the model never sees it). What each answered
async function tellPerson($: any, text: string): Promise<{ phone: string; notification: string }> {
  let phone: string
  try {
    const r: any = await Promise.race([$.tool.call({ tool: 'PushNotification', message: text, status: 'proactive' }), $.clock.sleep(10000).then(() => null)])
    if (!r) phone = 'no answer in 10 s'
    else if (r.deny) phone = `refused: ${String(r.deny).slice(0, 100)}`
    else if (r.result?.pushSent === true) phone = 'sent'
    else if (r.result?.localSent === true) phone = 'shown on this computer'
    else phone = `not sent (${String(r.result?.disabledReason ?? (r.isError ? r.text : 'no reason given')).slice(0, 100)})`
  } catch (err) {
    phone = `unavailable (${String(err).slice(0, 100)})`
  }
  if (phone === 'sent' || phone === 'shown on this computer') return { phone, notification: '' }
  let notification: string
  try {
    const n: any = await $.ui.notify(text, { title: 'Sessions' })
    notification = n?.isSent ? `sent (${n.channel})` : `not sent (${n?.reason ?? 'no reason given'})`
  } catch (err) {
    notification = `refused (${String(err).slice(0, 100)})`
  }
  return { phone, notification }
}

// One notification, when the quiet hours and the cap a day allow it. claim runs under the push lock (<data>/push.lock,
// which every session takes) and says whether it's still to be sent, recording it as sent so that no other session
// sends it too; the day's count (the store's pushCount, { day, count }) goes up with it. What it said and what each
// channel answered is kept in lastPush, for /sessions status. Whether it was sent
async function notifyOnce($: any, claim: () => Promise<boolean>, text: () => string): Promise<boolean> {
  if (!dataDir || notificationsPerDay <= 0) return false
  const now = await $.clock.now()
  if (inQuietHours(quietHours, new Date(now))) return false
  const day = dayOf(new Date(now))
  let go = false
  await withLock(
    $,
    `${dataDir}/push`,
    async () => {
      const count = sentToday(await storeGet($, 'pushCount'), day)
      if (count >= notificationsPerDay || !(await claim())) return
      await storeSet($, 'pushCount', { day, count: count + 1 })
      go = true
    },
    10,
  )
  if (!go) return false
  const message = text()
  const r = await tellPerson($, message)
  await storeSet($, 'lastPush', { at: now, text: message, from: myShortId(), ...r })
  debugLine($, `notified: ${message} · phone ${r.phone}${r.notification ? `, notification ${r.notification}` : ''}`)
  return true
}

// The project's sessions waiting for the person, as the last refresh found them
let waitsNow: Wait[] = []

// A push once a session of the project has waited for the person waitPushMinutes, once per wait (pushed:<sessionId>
// holds the since of the wait pushed), whichever session of the project gets there first: one with Remote Control right
// away (its push can reach the phone), the others a minute later (PUSH_GRACE_MS). Several due at once go in one push
let pushingWaits = false
async function pushWaits($: any) {
  if (pushingWaits || !(waitPushMs > 0) || waitsNow.length === 0) return
  pushingWaits = true
  try {
    const now = await $.clock.now()
    const waits = waitsNow
    const pushed = async () => {
      const out: Record<string, number> = {}
      for (const w of waits) out[w.sessionId] = Number(await storeGet($, `pushed:${w.sessionId}`)) || 0
      return out
    }
    const before = await pushed()
    if (dueWaits(waits, before, now, waitPushMs, true).length === 0) return
    const own = lastList.find(s => s.sessionId === myId)
    const first = own?.kind === 'background' && typeof own.id === 'string' && (await hasRemoteControl($, own.id)) === true
    if (dueWaits(waits, before, now, waitPushMs, first).length === 0) return
    let due: Wait[] = []
    await notifyOnce(
      $,
      async () => {
        due = dueWaits(waits, await pushed(), now, waitPushMs, first)
        for (const w of due) await storeSet($, `pushed:${w.sessionId}`, w.since)
        return due.length > 0
      },
      () => waitText(due, now),
    )
  } finally {
    pushingWaits = false
  }
}

// This session's spend against its own usual hour (SpendLedger in state.ts), on every beat. The ledger is kept in the
// store, spend:<sessionId>, written with each sample (every 5 minutes); what it answers goes into the session's record
// (spendAlert: every panel draws its line) while the spend runs high
let ledger: unknown = undefined
let ledgerFor = ''
async function watchSpend($: any, usd: number | undefined, windows: RateLimit[], previous: SessionState, now: number): Promise<SpendAlert | undefined> {
  if (ledgerFor !== myId) {
    ledger = await storeGet($, `spend:${myId}`)
    ledgerFor = myId
  }
  const next = addSpend(ledger, usd, windows, now)
  ledger = next.ledger
  if (next.sampled) await storeSet($, `spend:${myId}`, next.ledger)
  const b = spendBurst(next.ledger, now, projectUsual)
  const was = previous.spendAlert
  if (!b || !spendIsHigh(b, !!was)) return undefined
  const cents = (x: number) => Math.round(x * 100) / 100
  const since = was?.since ?? now
  return { since, hour: cents(b.hour), usual: cents(b.usual), rise: b.rise === null ? null : Math.round(b.rise), kind: next.ledger.kind, notified: was?.notified === true || since === spendNotified, basis: b.basis }
}

// The median of the usual hours the project's other sessions published (SessionState.usualHour), as the last refresh
// read them: a session with no usual hour of its own yet (fewer than three active hours) is judged by it (null: none)
let projectUsual: number | null = null

// The person hears once while this session's spend runs high: it's marked as notified in its record (and here, in case
// a write of the record raced it)
let notifyingSpend = false
let spendNotified = 0
async function notifySpend($: any) {
  if (notifyingSpend) return
  notifyingSpend = true
  try {
    const e = await readState($, myId)
    const alert = e?.spendAlert
    if (!e || !alert || alert.notified || alert.since === spendNotified) return
    const own = lastList.find(s => s.sessionId === myId)
    const name = projectRows.find(f => f.current)?.title ?? String(own?.name || own?.id || myShortId())
    if (!(await notifyOnce($, async () => true, () => spendText(name, alert, spendOf(e).mode)))) return
    spendNotified = alert.since
    const now = (await readState($, myId)) ?? e
    if (now.spendAlert?.since === alert.since) await storeSet($, `state:${myId}`, { ...now, spendAlert: { ...now.spendAlert, notified: true } })
  } finally {
    notifyingSpend = false
  }
}

// The panel's rows, from the session list and what each session published. Every value the panel draws is written only
// when it changed (sameData), and the rows' times are reckoned at the minute (labelMinute): a refresh that finds
// nothing new draws nothing, and an idle panel is drawn about once a minute, for its times
async function refresh($: any) {
  const list = await officialList($)
  if (typeof list === 'string') {
    if (!sameData(await read($, notice), list)) await update($, notice, () => list)
    return
  }
  lastList = list
  listedAt = await $.clock.now()
  const own = list.find(s => s.sessionId === myId)
  if (own?.pid) myPid = own.pid
  {
    const next = myShortId()
    if (!sameData(await read($, shortId), next)) await update($, shortId, () => next)
  }
  await followHere($)
  await learnHomes($, list)
  const pinned = new Set((await pinsFromFile($)) ?? [])
  const now = await $.clock.now()
  const minute = labelMinute(now)
  // One read of the store's keys, and then only the keys that are there: most rows have no title, wait or needs record
  const keys = new Set(await storeKeys($))
  await readMarks($, now, [...keys])
  // The project's sessions, each in the project it started in wherever it is now (belongsHere), and this one always
  // (its status from its own turn hooks while they're ahead of the registry)
  const project = list.filter(s => belongsHere(s)).map(s => (s.sessionId === myId ? withOwnHint(s, now) : s))
  const sinces: { since?: number; staleFrom?: number }[] = []
  const beats = await readHeartbeats($, project.map(s => s.sessionId))
  const plugin = await installedPlugin($)
  const fresh: Row[] = []
  const waits: Wait[] = []
  // Each session's version, to mark afterwards the ones with an older one than the installed version
  const versions: Record<string, string> = {}
  let newest = await readInstalledVersion($)
  // The usual hours the project's other sessions published, for a session with none of its own yet
  const usuals: number[] = []
  for (const s of project) {
    const e = keys.has(`state:${s.sessionId}`) ? await readState($, s.sessionId) : null
    if (s.sessionId !== myId && typeof e?.usualHour === 'number' && e.usualHour > 0) usuals.push(e.usualHour)
    const seen = keys.has(`seen:${s.sessionId}`) ? await seenAt($, s.sessionId) : 0
    if (s.sessionId === myId) selfSeen = { id: myId, finished: e?.finished ?? 0, seen }
    const unnamed = !s.name || s.name === s.id
    const ownTitle = unnamed && keys.has(`title:${s.sessionId}`) ? String((await storeGet($, `title:${s.sessionId}`)) ?? '') : ''
    // Since when it's been waiting for you: the panel records it the first time it sees it "waiting"
    let waitingSince = keys.has(`waiting:${s.sessionId}`) ? Number(await storeGet($, `waiting:${s.sessionId}`)) || undefined : undefined
    if (s.status === 'waiting' && !waitingSince) {
      waitingSince = now
      await storeSet($, `waiting:${s.sessionId}`, now)
    } else if (s.status !== 'waiting' && waitingSince) {
      await storeDelete($, `waiting:${s.sessionId}`)
    }
    const { color, since } = colorOf(s, e, seen, waitingSince)
    const staling = staleMs > 0 && since && (color === 'blue' || (color === 'yellow' && s.kind === 'background'))
    sinces.push({ since, staleFrom: staling && since ? since + staleMs : undefined })
    // A stopped session doesn't run any version: it opens with the installed one
    const version = color === 'gray' ? '' : e?.version || (s.pid ? await processVersion($, s.pid) : '')
    if (version) {
      versions[s.sessionId] = version
      if (compareVersions(version, newest) > 0) newest = version
    }
    const current = s.sessionId === myId
    const hb = heartbeatStatus(beats[s.sessionId] ?? null, s.pid, now)
    const spend = spendOf(e)
    const marked = marksNow[refOf(s)] ?? NO_MARK
    // What a running background session has going on beside its turn: its subagents and background tasks, as the
    // background service counts them (artifact watches aside)
    const helpers = s.kind === 'background' && s.pid && typeof s.id === 'string' ? ((await backgroundTasks($, s.id))?.count ?? 0) : 0
    const title = unnamed ? ownTitle || s.id || s.sessionId.slice(0, 8) : s.name
    // Since when it waits for the person (red, or marked as needing them), for the push when that runs long. A mark has
    // no start of its own: the panels record it as needsSince:<sessionId>, { since, at }, kept fresh by every refresh
    // that sees it (a pass apart at least, watched), and a record no panel kept fresh for two and a half minutes is a
    // wait that ended
    let needsSince: number | undefined
    if (marked.needsPerson && color !== 'gray') {
      const n = keys.has(`needsSince:${s.sessionId}`) ? await storeGet($, `needsSince:${s.sessionId}`) : undefined
      const kept = n && now - Number(n.at) < 150000 && Number(n.since) > 0 ? Number(n.since) : undefined
      needsSince = kept ?? now
      if (!kept || now - Number(n.at) > 20000) await storeSet($, `needsSince:${s.sessionId}`, { since: needsSince, at: now })
    }
    const waitFrom = Math.min(color === 'red' && waitingSince ? waitingSince : Infinity, needsSince ?? Infinity)
    if (Number.isFinite(waitFrom)) waits.push({ sessionId: s.sessionId, title, since: waitFrom })
    // Running high (its own mod says so, SpendAlert): a line under the row, before another plugin's
    const hot = e?.spendAlert && color !== 'gray' ? spendLine(e.spendAlert, spend.mode) : ''
    fresh.push({
      sessionId: s.sessionId,
      id: s.id ?? null,
      title,
      color,
      time: since ? timeSince(since, minute) : '',
      model: e?.model ?? '',
      context: typeof e?.context === 'number' ? `${Math.round(e.context)}%` : '',
      current,
      background: s.kind === 'background',
      outdated: false,
      pinned: s.kind === 'background' && typeof s.id === 'string' && pinned.has(s.id),
      noPanel: !current && color !== 'gray' && hb === 'missing' && expectsHeartbeat(s, plugin, now),
      otherFormat: !current && color !== 'gray' && hb === 'other-format',
      reachable: current || (color !== 'gray' && hb === 'ok'),
      ref: refOf(s),
      section: '',
      sectionTitle: '',
      // What it spent so far, from what it published itself: only for a running session on an API account
      usd: color !== 'gray' && spend.mode === 'api' ? spend.usd : null,
      ...marked,
      ...(hot ? { line: marked.line ? `${hot} · ${marked.line}` : hot, tint: 'warning' as const } : {}),
      depth: 0,
      folded: false,
      helpers,
      stale: isStale({ color, background: s.kind === 'background' }, since, minute, staleMs),
    })
  }
  waitsNow = waits
  projectUsual = median(usuals)
  installedVersion = newest
  // ↑ also when a session runs an older version of this mod than the installed one (its heartbeat says which)
  const modInstalled = plugin?.version ?? ''
  for (const f of fresh) {
    const v = versions[f.sessionId]
    const mod = f.current ? modVersion : (beats[f.sessionId]?.version ?? '')
    f.outdated = (!!v && compareVersions(v, installedVersion) < 0) || (!!mod && !!modInstalled && compareVersions(mod, modInstalled) < 0)
  }
  // The launcher opens the first row of the project's order: waiting, done, working, idle, whatever the sections
  await writeOrder($, fresh, now)
  projectRows = fresh
  const sections = await readSectionsFile($)
  sectionsNow = 'problem' in sections ? NO_SECTIONS : sectionsView(sections.file)
  sectionsProblem = 'problem' in sections ? sections.problem : ''
  const focused = !!(await $.ui.panes()).find((p: any) => p.id === PANE)?.isFocused
  // The filter and the folds changed in another session apply here too, once the panel doesn't have the keyboard
  if (!focused) {
    waitingOnly = keys.has('waitingOnly') && (await storeGet($, 'waitingOnly')) === true
    collapsed = keys.has('collapsed') ? await readCollapsed($) : new Set()
  }
  await layout($, focused)
  // Every folder's sessions that ended with the background service, for the panel's line
  await readEnded($, keys)
  {
    const next = noticeText()
    if (!sameData(await read($, notice), next)) await update($, notice, () => next)
  }
  await paneState($)
  // Watched, nothing moves the rows' times but the clock: one timer for the next one that changes
  scheduleLabel($, nextLabelChange(sinces, now), now)
}

// What the panel's notice line says: why the list isn't live or isn't read from Claude's files, and a sections.json
// that can't be read
function noticeText(): string {
  const parts: string[] = []
  // Not where no SessionStart reaches the mod at all: there neither helps, and /sessions status says why
  if (!live && reloadedInto && !startSkipped) parts.push('Live updates off: this session was updated in place; u restarts it, or /clear')
  if (slowList && sessionFiles?.problem) parts.push("List read the slow way: Claude's registry changed format")
  if (sectionsProblem) parts.push(sectionsProblem)
  return parts.join(' · ')
}

// This session's row with the status its own turn hooks gave it, while that's newer than what the registry says (the
// registry's statusUpdatedAt; a list without it, `claude agents`'s, for 10 s)
function withOwnHint(s: any, now: number): any {
  const h = ownHint
  if (!h || now - h.at > 10000 || !s.pid) return s
  if (typeof s.statusUpdatedAt === 'number' && s.statusUpdatedAt >= h.at) return s
  return s.status === h.status ? s : { ...s, status: h.status }
}

// The rows as the panel shows them: grouped in sections, children under their parents (groupRows), only the ones
// waiting for you with the f filter on, and the folded sections' rows hidden behind one line (foldRows). Claude tracks
// the panel's focus by position, not by session: if rows move while you're in the panel, the highlight would jump to
// another session. So with the keyboard in the panel nothing moves, sections, their members, parents, folds and the
// filter's included (keepPlaces: new rows go at the end); on leaving, the layout is applied. reflow: the person asked
// for something right now: 'filter' (f) lays the panel out anew; 'fold' (c) folds or unfolds a section with every row
// kept where it was (the pending sort waits until they leave the panel). The caller of a reflow puts the focus where
// it goes. Otherwise, if what the arrows go through moved (a row or a fold line left the list, or shifted), the focus
// goes back to its element (or the one next to it), since Claude keeps the position, not the element
async function layout($: any, focused: boolean, reflow: '' | 'fold' | 'filter' = '') {
  const shownBefore = await read($, rows)
  const frozen = focused && reflow !== 'filter'
  waitingSnapshot = waitingMembers(projectRows, waitingSnapshot, waitingOnly, frozen)
  const members = waitingSnapshot
  // Filtered first: a child whose parent isn't shown is drawn as any row
  const grouped = groupRows(members ? projectRows.filter(f => members.has(f.sessionId)) : projectRows, sectionsNow)
  const kept = keepPlaces(foldRows(grouped, collapsed, !!members), shownBefore, frozen)
  // A fold the person made: the rows stay put, and only the folds are taken anew, over the sections as they're drawn
  const shown = reflow === 'fold' ? foldRows(kept, collapsed, !!members) : kept
  // The width the panel asks for follows what its rows hold (names, spend, marks): worked out again when they changed
  if (!sameData(shownBefore, shown)) {
    await update($, rows, () => shown)
    bg(adjustWidth($))
  }
  const spends = projectRows.filter(f => f.usd !== null)
  const others = projectRows.filter(f => !f.current)
  const next: PanelSummary = {
    waitingOnly,
    sessions: projectRows.length,
    waiting: others.filter(f => f.color === 'red').length,
    unseen: others.filter(f => f.color === 'yellow').length,
    spent: spends.length ? spends.reduce((sum, f) => sum + (f.usd ?? 0), 0) : null,
  }
  if (!sameData(await read($, summary), next)) await update($, summary, () => next)
  if (!focused || reflow) return
  const target = refocusTarget(ringKeys(shownBefore), ringKeys(shown), currentFocus)
  if (target) bg(focusElement($, target))
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
  if (!sameData(await read($, paneNote), note)) await update($, paneNote, () => note)
}

// When leaving a session, its panel releases the keyboard: when you come back, the text box receives you
async function releaseFocus($: any) {
  const pane = (await $.ui.panes()).find((p: any) => p.id === PANE)
  if (!pane?.isFocused) return
  await $.ui.close({ id: PANE })
  await $.ui.open({ id: PANE, title: 'Sessions', columns: requestedWidth || undefined })
}

// Asks Claude for the docked panel's width (it's a request: if the person dragged it, their width wins), from what the
// panel's last draw saw (paneSeen): run when that changed, and when the rows changed. A draw with no width asked is
// Claude's own width for the window, the cap; a window whose width changed is measured again by opening the panel
// without asking for one, whose draw comes back here. Never reopens a panel the person closed.
async function adjustWidth($: any) {
  if (!(await $.ui.panes()).some((p: any) => p.id === PANE)) return
  const seen = paneSeen
  if (seen && seen.asked === 0) {
    defaultWidth = seen.body
    defaultWindowWidth = seen.window
  } else if (seen && defaultWindowWidth && seen.window !== defaultWindowWidth) {
    requestedWidth = 0
    defaultWindowWidth = seen.window
    await $.ui.open({ id: PANE, title: 'Sessions' })
    return
  }
  if (defaultWidth === 0) return
  const shown = await read($, rows)
  const width = paneWidth(shown.map(f => f.title), defaultWidth, (shown.some(f => f.usd !== null) ? SPEND_COLUMN : 0) + markColumns(shown))
  if (width === requestedWidth) return
  requestedWidth = width
  await $.ui.open({ id: PANE, title: 'Sessions', columns: width })
}

// You arrived from another session's panel, or with ccc: the panel takes the keyboard, on the session next to this one,
// so you can keep going through them. You're looking at this session: what it answered is seen
async function focusPanel($: any) {
  bg(seenNow($))
  // A panel you closed stays closed: you land on the prompt, and the line above it says how to open it
  if (await closedByYou($)) return
  const list = (await read($, rows)).filter(f => !f.folded)
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
// Claude is settling the focus it rejects another change ("the focus moved meanwhile"), so it retries a bit (every
// 50 ms, for 1.5 s at most: the sooner it lands, the less the highlight shows on the row it came in on). The
// ui.focus hook doesn't hear about changes the mod itself requests: they're recorded here. If you moved with the arrows
// meanwhile, the focus isn't fought over.
// A field that appears with autoFocus does NOT take the focus if the panel already had the keyboard: the focus goes by
// position and lands on whatever is in that spot now (a row, and what you were typing went somewhere else). That's
// why it's moved here
async function focusElement($: any, key: string) {
  const moves = personMoves
  for (let i = 0; i < 30; i++) {
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
        if (key.startsWith('s:') || key.startsWith('h:')) selectedRow = key
        return
      }
    }
    await $.clock.sleep(50)
  }
}

// The window of an agent view that's showing a session right now (its ⟨id⟩ tag is on screen), except the front one
async function agentsViewShowing($: any, v: { agentsViews: { pid: string; tty: string }[] }, f: Row, except: string): Promise<string | undefined> {
  const tag = `⟨${f.id ?? f.sessionId.slice(0, 8)}⟩`
  for (const c of v.agentsViews) {
    if (c.tty === except) continue
    if ((await platform.readWindow(sys($), c.tty)).includes(tag)) return c.tty
  }
  return undefined
}

// A notice to another session's mod (see buildNotice), only if it answers: its heartbeat says it runs and speaks this
// format. Anything else would reach that session's model as text. '' once it reached that session's queue, else why
// not: Claude sends it only from a session whose agent has the SendMessage tool (a fleet instance's role may leave it
// out), and says so in its answer rather than throwing
async function noticeTo($: any, f: Row, kind: NoticeKind, data: Record<string, unknown> = {}): Promise<string> {
  if (f.current) return 'it is this session'
  if (!f.reachable) return "its panel isn't running, or runs another version"
  try {
    const r = await $.session.send({ to: { sessionId: f.sessionId }, text: buildNotice(kind, data) })
    return r && r.isDelivered === false ? String(r.reason || 'it was not delivered').slice(0, 200) : ''
  } catch (err) {
    return String(err).slice(0, 200)
  }
}

async function sendNotice($: any, f: Row, kind: NoticeKind, data: Record<string, unknown> = {}): Promise<boolean> {
  return (await noticeTo($, f, kind, data)) === ''
}

// Whether this session can send notices: Claude sends them through the SendMessage tool, which an agent can leave out
// of its tools (then $.session.send answers not delivered). When it can't be told, it's taken that it can
async function canMessage($: any): Promise<boolean> {
  try {
    const tools: any[] = await $.tool.list()
    return !Array.isArray(tools) || tools.some(t => t?.name === 'SendMessage')
  } catch {
    return true
  }
}

// The other session of a Stop or Restart question, whatever this panel shows (the f filter, or a session of another
// project root): the project's rows, else the official list, else what the notice carries about it
function peerRow(sessionId: string, carried: Record<string, unknown> = {}): Row {
  const shown = projectRows.find(f => f.sessionId === sessionId && !f.current)
  if (shown) return shown
  const s = lastList.find(x => x.sessionId === sessionId)
  const id = typeof s?.id === 'string' && s.id ? s.id : typeof carried.id === 'string' && /^[0-9a-f]{8}$/.test(carried.id) ? carried.id : null
  const title = String((typeof s?.name === 'string' && s.name) || (typeof carried.title === 'string' && carried.title) || id || sessionId.slice(0, 8)).slice(0, 80)
  const background = s ? s.kind === 'background' : carried.background !== false
  return {
    sessionId,
    id,
    title,
    color: 'green',
    time: '',
    model: '',
    context: '',
    current: false,
    background,
    outdated: false,
    pinned: false,
    noPanel: false,
    otherFormat: false,
    // It sent this session a notice of this format, or this session sent it one: its mod answers
    reachable: true,
    ref: '',
    section: '',
    sectionTitle: '',
    usd: null,
    badge: '',
    tint: '',
    line: '',
    needsPerson: false,
    depth: 0,
    folded: false,
    helpers: 0,
    stale: false,
  }
}

// Switches the front window to another session. With notifyFocus set to false, the target isn't told you arrived
// (when it's about to show a question, or when it'll take the keyboard itself afterwards). From a window opened with
// ccc, by what its launcher publishes (switchByLaunchers: one file, no ps of every process, no question to Terminal);
// else one ps serves the whole switch (which window is this one, which shows the target, the viewer to close). Nothing
// waits before the viewer is told to end or closed: the notice that tells the target you arrived and this panel's
// release of the keyboard go once the window went (the target takes the keyboard with no window attached too, and
// gets it when the window attaches)
async function jump($: any, f: Row, notifyFocus = true): Promise<boolean> {
  if (f.current) return false
  // If the jump was made with the keyboard in the panel (Enter), the target session receives you with the focus on its
  // panel ('focus'); made without it (a click on the row), the keyboard stays where it is and the target only marks
  // what it answered seen ('seen'). Either way you're looking at it now. When leaving, this session's panel releases
  // the keyboard
  const fromKeyboard = notifyFocus && !!(await $.ui.panes()).find((p: any) => p.id === PANE)?.isFocused
  const gone = (): true => {
    bg(
      (async () => {
        if (notifyFocus) await sendNotice($, f, fromKeyboard ? 'focus' : 'seen')
        await releaseFocus($)
      })(),
    )
    return true
  }
  // A background session, from a window opened with ccc: by what the launcher windows publish, when that's certain
  if (f.background && (await switchByLaunchers($, f))) return gone()
  const v = await windows($)
  bg(shareWindows($, v))
  // A regular session lives in its own window: bring that one forward, whichever is in front. If it runs where the
  // panel can't reach (another terminal app, tmux, an editor), say so instead of doing nothing
  if (!f.background) {
    const s = lastList.find(x => x.sessionId === f.sessionId)
    const tty = s?.pid ? v.byPid[String(s.pid)] : undefined
    if (!tty || !(await platform.bringWindow(sys($), tty, f.title))) {
      $.ui.toast(platform.text.regularUnreachable(f.title))
      return false
    }
    return gone()
  }
  const front = await frontWindowShowingMe($, v)
  if (!front) {
    $.ui.toast(platform.text.switchNeedsWindow)
    return false
  }
  // If it's already open in another window, bring that one: never the same session in two windows. Look among the
  // viewers (claude attach <id>) and among the agent views, which don't say which session they show: read their
  // screen looking for its tag
  const target = (f.id ? v.byId[f.id]?.find(t => t !== front) : undefined) ?? (await agentsViewShowing($, v, f, front))
  if (target) {
    if (await platform.bringWindow(sys($), target, f.title)) return gone()
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
  if (await switchInPlace($, { command: 'attach', id: f.id, title: f.title }, front, v)) return gone()
  // This window can't switch (it wasn't opened with ccc): open another one next to it, same size and position, with
  // the launcher
  const opened = await platform.openWindow(sys($), front, `${DOT[f.color]} ${f.title}`, launcherCommand({ command: 'attach', id: f.id, title: f.title }))
  $.ui.toast(opened ? `Opened “${f.title}” in a new window: this one wasn't opened with ccc, so it can't switch` : platform.text.cantOpen(f.title))
  return opened ? gone() : false
}

// What's being asked: stop a running session, remove a stopped one from the list, or restart one. The values are sent
// to other sessions (the topic field of the ask notice)
type Topic = 'stop' | 'remove' | 'restart'

// The question, with Claude's dialog. Cancel, Esc or hand-typed text do nothing. unshown: the dialog never showed (a
// session whose agent leaves AskUserQuestion out of its tools can't show one: askRejection)
async function askQuestion($: any, title: string, topic: Topic, detail = ''): Promise<{ action: Action | null; unshown: boolean }> {
  const extra = detail ? ` ${detail}` : ''
  const question =
    topic === 'remove'
      ? `Remove “${title}” from the list? The conversation is kept.`
      : topic === 'restart'
        ? `Restart “${title}”?${extra} It reloads MCP servers, plugins and settings; the conversation is kept.`
        : `Stop “${title}”?${extra} The conversation is kept either way.`
  const options = topic === 'remove' ? REMOVE_OPTIONS : topic === 'restart' ? RESTART_OPTIONS : STOP_OPTIONS
  try {
    return { action: actionFromAnswer(await $.ui.ask(question, { options, header: 'Sessions' })), unshown: false }
  } catch (err) {
    return { action: null, unshown: askRejection(err) === 'unshown' }
  }
}

// The question asked in this session's own window: when it can't be shown here either, you're told, so a key never
// does nothing silently
async function askDialog($: any, title: string, topic: Topic, detail = ''): Promise<Action | null> {
  const r = await askQuestion($, title, topic, detail)
  if (r.unshown) $.ui.toast(`Couldn't show the question in this session (its agent may have no AskUserQuestion): nothing was changed`)
  return r.action
}

// claude respawn of another session: the windows with a launcher (opened with ccc) that show it are told to reopen it,
// so their viewers come back to it once its new process runs. False if the respawn failed (its window files go: left
// behind, a later close would reattach instead of leaving the shell)
async function respawnWithWindows($: any, id: string, title: string): Promise<boolean> {
  const v = await windows($)
  const written: string[] = []
  for (const tty of v.byId[id] ?? []) {
    if (!v.launchers[tty] || !dataDir) continue
    try {
      await $.fs.write(windowFile(tty), windowTargetText({ command: 'attach', id, title }))
      written.push(windowFile(tty))
    } catch {}
  }
  const r = await run($, [claude, 'respawn', id])
  if (r.exitCode !== 0 && written.length) await runSafe($, ['rm', '-f', ...written])
  return r.exitCode === 0
}

// Does what was chosen to another session. Stop and Remove: stops it and/or removes it from the list, and closes the
// windows that showed it (never one showing this session; with closeWindows false, none: that's when the window you're
// in still shows that session). Restart: claude respawn, the same session with its conversation in a process running
// the installed version; the windows with a launcher that showed it reopen it on their own
async function perform($: any, f: Row, action: Action, closeWindows = true) {
  if (!f.id) return
  if (action === 'restart') {
    if (!(await respawnWithWindows($, f.id, f.title))) {
      $.ui.toast(`Couldn't restart “${f.title}”`)
    } else {
      // The ↑ mark goes away right away, without waiting for the new session to record its version
      const e = await readState($, f.sessionId)
      if (e && installedVersion) await storeSet($, `state:${f.sessionId}`, { ...e, version: installedVersion })
      $.ui.toast(`“${f.title}” restarted${f.outdated && installedVersion ? ` on Claude ${installedVersion}` : ''}`)
    }
    await invalidateList($)
    await requestRefresh($, false)
    return
  }
  const before = action === 'rm' ? [] : ((await windows($)).byId[f.id] ?? [])
  if (action !== 'rm') {
    const r = await run($, [claude, 'stop', f.id])
    if (r.exitCode !== 0) {
      $.ui.toast(`Couldn't stop “${f.title}”`)
      return
    }
    // The person stopped it: a plugin's wake leaves it stopped (stoppedKind), even once the service's log no longer has it
    await storeSet($, `personStop:${f.sessionId}`, await $.clock.now())
  }
  if (action !== 'stop') {
    const r = await run($, [claude, 'rm', f.id])
    if (r.exitCode !== 0) $.ui.toast(`Couldn't remove “${f.title}” from the list`)
  }
  await invalidateList($)
  await requestRefresh($, false)
  if (closeWindows && before.length) {
    await $.clock.sleep(1500)
    const mine = await myWindows($)
    for (const tty of before.filter(t => !mine.includes(t))) await platform.closeWindow(sys($), tty)
  }
}

// After an action from the panel, the keyboard goes back to the panel, on the same row (or the one next to it if it
// left the list)
async function focusRow($: any, sessionId: string, fallback: string | undefined) {
  const ids = (await read($, rows)).filter(f => !f.folded).map(f => f.sessionId)
  await takeKeyboard($, ids.includes(sessionId) ? sessionId : fallback && ids.includes(fallback) ? fallback : ids[0])
}

// The tasks a session has running in the background even while it's idle (artifact watches don't count).
// The background service records them in its state; if the file isn't there or changed shape, it's unknown (null)
async function backgroundTasks($: any, id: string): Promise<{ count: number; kinds: string[] } | null> {
  if (!jobsDir) return null
  try {
    const text = await readIfChanged($, `${jobsDir}/${id}/state.json`)
    return text === null ? null : realTasks(JSON.parse(text)?.inFlight)
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
  // A session that can't send notices (its agent has no SendMessage) asks here: the question couldn't go there
  const askThere = topic !== 'remove' && f.color !== 'red' && f.reachable && (await canMessage($))
  const front = askThere ? await frontWindowShowingMe($) : null
  if (askThere && front && (await jump($, f, false))) {
    pendingAsk = { sessionId: f.sessionId, at: await $.clock.now(), fallback, topic, detail, target: f }
    // What that session needs to come back here and answer, even when its panel doesn't show this one (its f filter,
    // or another project root)
    const own = projectRows.find(x => x.current)
    const why = await noticeTo($, f, 'ask', { from: myId, topic, detail, id: myShortId(), title: own?.title ?? '', background: me().background })
    if (why) {
      pendingAsk = undefined
      await comeBack($, front, f)
      $.ui.toast(`Couldn't ask “${f.title}” (${why}); nothing was changed`)
    }
    return
  }
  const action = await askDialog($, f.title, topic, detail)
  if (action) await perform($, f, action)
  await focusRow($, f.sessionId, fallback)
}

// The window went to f, but the question couldn't follow it there: this session back in that window
async function comeBack($: any, front: string, f: Row) {
  const title = projectRows.find(x => x.current)?.title ?? myShortId()
  const v = await windows($)
  if (me().background && f.id && (v.byId[f.id] ?? []).includes(front) && (await switchInPlace($, { command: 'attach', id: myShortId(), title }, front))) return
  await platform.bringWindow(sys($), front, title)
}

// In the session being acted on: the question shows up here; once answered, the window goes back to the session it was
// asked from and the answer is handed to it so it does it. If it can't be shown here (unshown), the window goes back
// all the same and that session asks in its own window. The answer goes as a notice; a session whose agent has no
// SendMessage can't send one, so it leaves the answer in the store (answer:<id>), where that session's panel looks
async function answerQuestion($: any, data: Record<string, unknown>) {
  const from = String(data.from ?? '')
  const topic: Topic = data.topic === 'restart' ? 'restart' : 'stop'
  const detail = typeof data.detail === 'string' ? data.detail.slice(0, 300) : ''
  const own = projectRows.find(f => f.current)
  const asked = await askQuestion($, own?.title ?? 'this session', topic, detail)
  const origin = peerRow(from, data)
  const action = asked.unshown ? UNSHOWN : (asked.action ?? 'cancel')
  const cameBack = await jump($, origin, false)
  const why = await noticeTo($, origin, 'answer', { sessionId: myId, action, cameBack })
  const handed = !why || (await storeSet($, `answer:${from}`, { format: FORMAT, sessionId: myId, action, cameBack, at: await $.clock.now() }))
  if (!handed) $.ui.toast(`Couldn't hand the answer to “${origin.title}” (${why}): nothing was changed, go back to it`)
  else if (asked.unshown && !cameBack) $.ui.toast(`Couldn't show the question here: go back to “${origin.title}”, which asks it`)
}

// The answer a session that couldn't send notices left in the store for this one (answerQuestion), while a question
// of this one waits
async function checkStoredAnswer($: any) {
  if (!pendingAsk) return
  const a = await storeGet($, `answer:${myId}`)
  if (!a || typeof a !== 'object') return
  await storeDelete($, `answer:${myId}`)
  if (Number(a.format) !== FORMAT || !(Number(a.at) >= pendingAsk.at)) return
  await receiveAnswer($, a)
}

// Back in this session: do what was chosen over there (only if it's the answer to the question that was sent). If the
// question couldn't be shown there, it's asked here
async function receiveAnswer($: any, data: Record<string, unknown>) {
  const now = await $.clock.now()
  if (!pendingAsk || pendingAsk.sessionId !== data.sessionId || now - pendingAsk.at > 600000) return
  const { fallback, topic, detail, target } = pendingAsk
  pendingAsk = undefined
  // The row as it is now, or as it was when it was asked (this panel may not show it any more: the f filter)
  const f = projectRows.find(x => x.sessionId === data.sessionId && !x.current) ?? target
  const action = data.action === UNSHOWN ? await askDialog($, f.title, topic, detail) : data.action
  // If the window couldn't come back here, it still shows that session: it isn't closed
  if (action === 'stop' || action === 'stop-rm' || action === 'restart') await perform($, f, action, data.cameBack === true)
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
  await respawnSelf($, id, f.title)
}

// The restart itself, also for another plugin's $.sessions.restart of this session (from the mod's own timer, with no
// question: its caller checked the windows first)
async function respawnSelf($: any, id: string, title: string) {
  const v = await windows($)
  const returning = (v.byId[id] ?? []).filter(tty => v.launchers[tty])
  // The ↑ mark goes away right away, and the new process announces on startup that it was restarted
  const e = await readState($, myId)
  if (e && installedVersion) await storeSet($, `state:${myId}`, { ...e, version: installedVersion })
  await storeSet($, `restarted:${myId}`, await $.clock.now())
  for (const tty of returning) {
    try {
      await $.fs.write(windowFile(tty), windowTargetText({ command: 'attach', id, title }))
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
  $.ui.toast(`Couldn't restart “${title}”`)
}

// What a session is doing right now (busy, waiting, idle; null if it isn't running): a list read now (through the lock:
// another session's listing in flight serves too, once it lands). If it can't be known, it's treated as busy: ask
// before cutting anything
async function statusNow($: any, sessionId: string): Promise<string | null | undefined> {
  const asked = await $.clock.now()
  const r = await listWithAge($, 0)
  if (typeof r === 'string') return 'busy'
  // Only a list from about now: an old one (another session held the lock and nothing newer landed) says nothing
  if (r.at < asked - 5000) return 'busy'
  const list = r.sessions
  const s = list.find(x => x.sessionId === sessionId)
  return s ? (s.status ?? null) : undefined
}

// What a session is doing, for a queued restart: from Claude's files read now, while they can stand for the list
// (directListed); else from a list read in the last RESTART_FRESH_MS, whoever read it (another session's listing serves
// once it lands), else one read now (through the lock), unless a back-off holds. 'unknown' when there's none that fresh
// yet (another session holds the lock, a back-off, the listing failed): the restart waits
const RESTART_FRESH_MS = 5000
async function restartStatus($: any, sessionId: string): Promise<string | null | undefined> {
  const direct = await directListed($, 0)
  if (direct) {
    const s = direct.sessions.find(x => x.sessionId === sessionId)
    return s ? (s.status ?? null) : undefined
  }
  const now = await $.clock.now()
  const stored = await storedList($)
  let fresh: Listed | null = stored && now - stored.at < RESTART_FRESH_MS ? stored : null
  if (!fresh) {
    if (stored && typeof stored.until === 'number' && now < stored.until) return 'unknown'
    const r = await listWithAge($, 0)
    if (typeof r === 'string' || r.at < now - RESTART_FRESH_MS) return 'unknown'
    fresh = r
  }
  const s = fresh.sessions.find(x => x.sessionId === sessionId)
  return s ? (s.status ?? null) : undefined
}

// One random hex digit, for automatic names
function hexDigit(): string {
  const b = new Uint8Array(1)
  crypto.getRandomValues(b)
  return ((b[0] ?? 0) % 16).toString(16)
}

// Starts a background session in a folder (claude --bg, with its agent and settings file if any), writing Claude's
// debug log when the option is on. '' when it started, else why not
async function launch($: any, l: StartRequest): Promise<string> {
  const debug = debugLogs && dataDir ? ['--debug-file', `${dataDir}/debug/${debugLogName(l.name)}`] : []
  const agent = l.agent ? ['--agent', l.agent] : []
  const settings = l.settings ? ['--settings', l.settings] : []
  const r = await runSafe($, [claude, '--bg', ...agent, ...settings, '-n', l.name, ...debug], { cwd: l.cwd, timeoutMs: 60000 })
  return r.exitCode === 0 ? '' : bgRefusal(`${r.stderr}\n${r.stdout}`, l.cwd)
}

// The sessions other plugins asked to start ($.sessions.start), one at a time from this mod's own 0.5 s timer: a
// method runs inside its caller's hook, and claude --bg can take seconds. Each name is checked once more against the
// official list, read right then. What didn't start is said in this session, where the call came from
let launches: (StartRequest & { root: string })[] = []
let launching = false
async function runLaunches($: any) {
  if (launching || launches.length === 0) return
  launching = true
  try {
    for (let l = launches.shift(); l; l = launches.shift()) {
      const list = await officialList($, 2000)
      const taken = Array.isArray(list) && list.some(s => s.name === l.name && belongsHere(s, l.root))
      const refusal = taken ? `a session named “${l.name}” is already in ${l.root}` : await launch($, l)
      debugLine($, `start “${l.name}” in ${l.cwd}: ${refusal || 'started'}`)
      if (refusal) $.ui.toast(`Couldn't start “${l.name}”: ${refusal}`)
      else await invalidateList($)
    }
  } finally {
    launching = false
  }
}

async function createSession($: any, name: string) {
  // The new session starts in the project root, the one this session started in, and only if it's still there
  const taken = lastList.filter(x => belongsHere(x)).flatMap(x => [x.name, x.id].filter(Boolean))
  // A name the project already has would make a second session with it (ccc <name> then opens either): the field
  // stays open for another one
  const typed = name.trim()
  if (typed && taken.includes(typed)) {
    $.ui.toast(`“${typed}” is already a session of this project: type another name (Esc cancels)`)
    bg(focusElement($, 'name'))
    return
  }
  if (!sameData(await read($, askingName), false)) await update($, askingName, () => false)
  if (!myCwd || !(await exists($, myCwd))) {
    $.ui.toast(`Can't create a session: this session's folder no longer exists${myCwd ? ` (${myCwd})` : ''}`)
    return
  }
  // Enter without a name: an automatic one after the folder, like the names Claude gives regular sessions
  // ("myapp-1f"), not used by another session of the project
  const clean = typed || autoName(myCwd, taken, hexDigit)
  const since = (await $.clock.now()) - 5000
  const refusal = await launch($, { name: clean, cwd: myCwd })
  if (refusal) {
    $.ui.toast(`Couldn't create “${clean}”: ${refusal}`)
    return
  }
  // Without parsing the output text: the new session is looked up in the official list (JSON), by name and start time
  for (let attempt = 0; attempt < 6; attempt++) {
    await requestRefresh($, false)
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
  if (!sameData(await read($, askingName), false)) await update($, askingName, () => false)
  if (!sameData(await read($, renaming), null)) await update($, renaming, () => null)
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
    if (!sameData(await read($, renaming), null)) await update($, renaming, () => null)
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
  if (!sameData(await read($, askingName), false)) await update($, askingName, () => false)
  {
    const next = { sessionId: f.sessionId, title: f.title }
    if (!sameData(await read($, renaming), next)) await update($, renaming, () => next)
  }
  bg(focusElement($, 'rename-input'))
  bg(watchField($))
}

// The n key: opens the field for the new session's name and moves the focus to it
async function toggleNew($: any) {
  if (!sameData(await read($, renaming), null)) await update($, renaming, () => null)
  const open = !(await read($, askingName))
  if (!sameData(await read($, askingName), open)) await update($, askingName, () => open)
  if (open) {
    bg(focusElement($, 'name'))
    bg(watchField($))
  }
}

// The f key: only the sessions waiting for you, or all of them again. It's the person's choice, so it's remembered for
// every session (you can hop through the waiting ones with Enter) and it lays the panel out again right away, sections
// included: f twice takes a fresh snapshot of who's waiting without leaving the panel. The focus stays on the selected
// session if it's still shown, else on the first one
async function toggleWaiting($: any) {
  waitingOnly = !waitingOnly
  waitingSnapshot = null
  await storeSet($, 'waitingOnly', waitingOnly)
  await layout($, true, 'filter')
  const list = await read($, rows)
  const keep = list.find(f => `s:${f.sessionId}` === selectedRow) ?? list.find(f => !f.current) ?? list[0]
  if (keep) bg(focusSession($, keep.sessionId))
}

// Folded sections (foldRows): the person's choice, remembered for every session in the store (collapsed)
let collapsed = new Set<string>()
async function readCollapsed($: any): Promise<Set<string>> {
  const stored = await storeGet($, 'collapsed')
  return new Set(Array.isArray(stored) ? stored.filter((x: unknown): x is string => typeof x === 'string') : [])
}

async function setFolded($: any, section: string, folded: boolean) {
  if (folded) collapsed.add(section)
  else collapsed.delete(section)
  await storeSet($, 'collapsed', [...collapsed])
  await layout($, true, 'fold')
}

// The c key: folds the selected session's section into one line (a button: Enter unfolds it), or unfolds the folded
// section selected. It's laid out again right away, the person asked for it, and the focus goes to that line or to the
// section's first session. Other sessions' panels take it when they don't have the keyboard
async function toggleFold($: any) {
  const key = selectedRow
  if (key?.startsWith('h:')) {
    await unfold($, key.slice(2))
    return
  }
  const list = await read($, rows)
  const f = list.find(x => `s:${x.sessionId}` === key)
  if (!f) {
    $.ui.toast('Select a session with ↑↓ first')
    return
  }
  if (waitingOnly) {
    $.ui.toast('Nothing folds while f shows only the sessions waiting for you')
    return
  }
  if (!drawPlan(list).some(it => it.kind === 'header' && it.section === f.section)) {
    $.ui.toast(`“${f.title}” isn't in a section with a title: only those fold`)
    return
  }
  await setFolded($, f.section, true)
  bg(focusElement($, `h:${f.section}`))
}

async function unfold($: any, section: string) {
  await setFolded($, section, false)
  const first = (await read($, rows)).find(f => f.section === section && !f.folded)
  if (first) bg(focusSession($, first.sessionId))
}

// With Enter in the field, the session is renamed with its own /rename, the official one: it changes the name in every
// session's list, in claude agents and on the phone. This one, directly; another one, by asking its mod with a notice
// (it runs it when it finishes what it's doing)
async function rename($: any, text: string) {
  const r = await read($, renaming)
  if (!sameData(await read($, renaming), null)) await update($, renaming, () => null)
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
    const why = f ? await noticeTo($, f, 'rename', { name }) : "it isn't in the list"
    if (!why) {
      $.ui.toast(`Renaming “${r.title}” to “${name}”…`)
    } else {
      $.ui.toast(`Couldn't rename “${r.title}” from here (${why}): use /rename there`)
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

// The project this session belongs to (sessionHome in state.ts), settled at the mod's start: its record in the store,
// project:<sessionId> (root; from, the folder it was worked out from; at), kept across restarts (claude respawn keeps
// the session id) and carried over by /clear and /resume (rebind). With none, this is its first start: the project is
// worked out from where it started (rootOf), the first cwd row of its transcript when it has one already (a session
// restarted or reloaded into this version after it moved: Claude starts it again where it was), else
// $.session.root(), and recorded. It's published in the heartbeat (root), where the other panels and ccc read it
async function settleProject($: any) {
  if (!myId) return
  const kept = await storeGet($, `project:${myId}`)
  if (typeof kept?.root === 'string' && kept.root.startsWith('/')) {
    myCwd = kept.root
    return
  }
  let from = (await firstCwds($, [myId]))?.[myId] ?? ''
  for (const ask of [() => $.session.root(), () => $.session.cwd()]) {
    if (from.startsWith('/')) break
    try {
      from = String(await ask())
    } catch {}
  }
  if (!from.startsWith('/')) return
  myCwd = await rootOf($, from)
  debugLine($, `project: ${myCwd} (where it started: ${from})`)
  await storeSet($, `project:${myId}`, { root: myCwd, from, at: await $.clock.now() })
}

// Where the session works now: $.session.root(), which a worktree move (EnterWorktree, ExitWorktree), /cd and a host's
// directory change move (a cd in a shell command doesn't), else the folder Claude lists it in; read on every refresh.
// Its project stays the one it started in (myCwd), and when it works outside it its own panel says so in one line
// (away, drawn with outsideNote). That folder can be gone (a worktree removed under it, or after it left): nothing
// runs there, as every command the mod runs starts from the home folder (runSafe)
async function followHere($: any) {
  if (!myCwd) await settleProject($)
  let folder = ''
  try {
    folder = String(await $.session.root())
  } catch {}
  if (!folder.startsWith('/')) {
    const listed = lastList.find(s => s.sessionId === myId)?.cwd
    folder = typeof listed === 'string' ? listed : ''
  }
  hereNow = folder
  const next = folder && myCwd && !inProject(folder, myCwd, home) ? folder : ''
  if (!sameData(await read($, away), next)) await update($, away, () => next)
}

// The project root of a folder (rootFrom), with the AGENTS.md and CLAUDE.md markers looked for on disk (from the
// project a worktree belongs to: worktreeBase)
async function rootOf($: any, folder: string): Promise<string> {
  const markers: string[] = []
  for (const dir of rootCandidates(worktreeBase(folder))) {
    if ((await exists($, `${dir}/AGENTS.md`)) || (await exists($, `${dir}/CLAUDE.md`))) markers.push(dir)
  }
  return rootFrom(folder, markers)
}

function truncate(text: string, width: number): string {
  const chars = Array.from(text)
  return chars.length <= width ? text : `${chars.slice(0, Math.max(1, width - 1)).join('')}…`
}

// The agent this session runs as: its transcript's agent-setting rows (agentFromTranscript), from
// ~/.claude/projects/<folder>/<sessionId>.jsonl, with grep (no model, no tokens). Once per session id (until the
// transcript exists, on every beat). After /clear the new transcript doesn't name the agent: rebind carries a known one
// over
async function readAgent($: any) {
  if (!myId || !home || agentFor === myId) return
  const script = 'for f in "$1"/*/"$2".jsonl; do if [ -f "$f" ]; then grep -e "^$3" "$f" | tail -n 3; exit 0; fi; done; exit 1'
  const r = await runSafe($, ['/bin/sh', '-c', script, 'sh', `${home}/.claude/projects`, myId, AGENT_ROW])
  if (r.exitCode !== 0) return
  agentFor = myId
  myAgent = agentFromTranscript(r.stdout)
}

// Each session publishes its model and the % of context used (the same as the status line), the agent it runs as, its
// project root and what it spends (its cost and the account's windows, as the status line has them), only if they
// changed
async function publishUsage($: any) {
  let model = ''
  let context: number | undefined
  let version = ''
  let spend: ReturnType<typeof publishedSpend> = { limits: [] }
  try {
    model = shortModelName(String(await $.session.model()))
    const u = await $.session.usage()
    context = u?.context?.percent
    spend = publishedSpend(u)
    version = String((await $.session.version())?.version ?? '')
  } catch {
    return
  }
  if (!sameData(await read($, limits), spend.limits)) await update($, limits, () => spend.limits)
  const agent = agentFor === myId ? myAgent : undefined
  const root = myCwd
  const previous = (await readState($, myId)) ?? {}
  const now = await $.clock.now()
  const spendAlert = await watchSpend($, spend.usd, spend.limits, previous, now)
  const own = ledgerFor === myId && ledger ? usualHour(ledger as SpendLedger, now) : null
  const usual = own === null ? undefined : Math.round(own * 100) / 100
  const same =
    previous.model === model &&
    previous.context === context &&
    previous.version === version &&
    previous.agent === agent &&
    previous.root === root &&
    previous.usd === spend.usd &&
    JSON.stringify(previous.limits ?? []) === JSON.stringify(spend.limits) &&
    JSON.stringify(previous.spendAlert) === JSON.stringify(spendAlert) &&
    previous.usualHour === usual
  if (!same) await storeSet($, `state:${myId}`, { ...previous, created: previous.created ?? now, model, context, version, agent, root, usd: spend.usd, limits: spend.limits, spendAlert, usualHour: usual })
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

// This session's own row, from its own turn hooks: drawn at once (the registry says the same 0.6 s later, withOwnHint)
async function ownStatus($: any, status: 'busy' | 'idle') {
  ownHint = { status, at: await $.clock.now() }
  scheduleFlush($, 0, d => (d.rows = true))
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

// A request from the launcher in this session's inbox (see InboxRequest): consumed once, then acted on.
// One with a reply is acted on only while ccc still waits for the answer (REPLY_WAIT_MS, ask_helpers in launcher.py):
// later it would bring a window or wake a session for nobody, and its answer would stay in replies/ for good.
// One the pass finds, written a while after this session's watch began (INBOX_EVENT_MS: its event comes in about 0.7
// s), came with no file event: the inbox isn't watched (a folder missed when the watch began, or removed since), and
// the engine won't watch it again in this process. From then on the inbox is read every 0.5 s (inboxTimer), so the
// next request is answered within ccc's wait
const REPLY_WAIT_MS = 3000
const INBOX_EVENT_MS = 2000
let inboxTimer: { cancel: () => void } | null = null
let checkingInbox = false
async function checkInbox($: any, byPass = false) {
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
    const answer = async (result: 'ok' | 'failed', reason = '', state?: string) => {
      if (!r.reply.startsWith(`${dataDir}/replies/`)) return
      try {
        await $.fs.write(r.reply, keyLines({ format: FORMAT, result, state, reason }))
      } catch {}
    }
    if (r.format !== FORMAT) {
      $.ui.toast('ccc runs another version of the sessions mod than this session: restart it (u, or claude respawn)')
      await answer('failed', 'another version')
      return
    }
    const now = await $.clock.now()
    const since = (await read($, watching))?.at
    if (byPass && live && !inboxTimer && since && r.at > since + 1000 && now - r.at > INBOX_EVENT_MS) {
      inboxTimer = $.clock.every(500, () => {
        bg(solo('inbox', () => checkInbox($)))
      })
      debugLine($, `inbox: a request from ${Math.round((now - r.at) / 1000)} s ago came with no file event: the inbox is read every 0.5 s from now on`)
    }
    if (now - r.at > 30000) return
    if (r.reply && now - r.at > REPLY_WAIT_MS) {
      debugLine($, `inbox: ${r.action} from ${Math.round((now - r.at) / 1000)} s ago, after ccc stopped waiting: dropped`)
      return
    }
    debugLine($, `inbox: ${r.action}`)
    if (r.action === 'focus') {
      await focusPanel($)
    } else if (r.action === 'bring') {
      const ok = !!r.tty && (await platform.bringWindow(sys($), r.tty, r.title))
      await answer(ok ? 'ok' : 'failed', ok ? '' : platform.text.cantBring)
    } else if (r.action === 'wake') {
      // ccc tell for a stopped session: woken here, by the rules of $.sessions.wake, since its own mod isn't running
      const v: WakeVerdict = ready() && isRef(r.ref) ? await wakeVerdict($, r.ref) : { state: 'refused', detail: "this session's panel hasn't read the session list yet" }
      if (v.state === 'running') await answer('ok', '', 'running')
      else if (v.state === 'refused') await answer('failed', v.detail, 'refused')
      else {
        const done = await run($, [claude, 'respawn', v.id])
        debugLine($, `wake “${v.name}” for ccc tell: ${done.exitCode === 0 ? 'restarted' : 'failed'}`)
        await invalidateList($)
        await answer(done.exitCode === 0 ? 'ok' : 'failed', done.exitCode === 0 ? `woke “${v.name}”` : `couldn't wake “${v.name}”`, done.exitCode === 0 ? 'queued' : 'refused')
      }
    }
  } finally {
    checkingInbox = false
  }
}

// ccc tell (see TELL_MAX_BYTES in state.ts): the requests in this session's <data>/tell/<ref>/, one turn at a time, from
// the 0.5 s timer. Only a background session the person opted in (/sessions tell on) takes them. Each one is submitted
// with $.prompt.submit, which waits for the session to be idle and resolves when its turn starts (delivered; turn.start
// says so too, after a reload). Refused by the engine (the person stopped the session with Esc, and plugin prompts wait
// for them), it's held until the person types in the session again.
// The request on its way is kept in $.state (tellInFlight), which a reload of the mod's code keeps: its turn may still
// come, so it isn't submitted again, nor is the next one while it's out. A request taken and not on its way (the
// session restarted before its turn, or the call was lost: still taken a minute after the session went idle) goes back
// in line; one whose submit failed goes back once, and is refused the second time
let telling = false
let lastTellPrune = 0
const tellFailures = new Map<string, number>()
// Since when the official list has shown this session idle, as checkTells saw it
let idleSince: number | undefined
function tellDir(): string {
  const own = lastList.find(s => s.sessionId === myId)
  return dataDir && own?.kind === 'background' && typeof own.id === 'string' && isRef(own.id) ? `${dataDir}/tell/${own.id}` : ''
}

async function tellStatus($: any, dir: string, id: string, state: TellState, reason = '') {
  try {
    await $.fs.write(`${dir}/${id}.status`, tellStatusText(state, reason, await $.clock.now()))
  } catch {}
}

async function checkTells($: any) {
  const dir = tellDir()
  if (telling || !dir || !active) return
  let entries: any[] = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return
  }
  const names = entries.map(f => String(f.name))
  const now = await $.clock.now()
  telling = true
  try {
    // A request a module before a reload submitted: left to its turn while the session works; idle a minute later with
    // it still taken, that call was lost
    const flying = await read($, tellInFlight)
    const idle = lastList.find(s => s.sessionId === myId)?.status === 'idle'
    idleSince = idle ? (idleSince ?? now) : undefined
    if (flying && names.includes(`${flying.id}.taken`)) {
      if (idleSince === undefined || now - idleSince < 60000 || now - flying.at < 60000) return
      debugLine($, `ccc tell ${flying.id}: still taken a minute after the session went idle, so its call was lost`)
    }
    if (flying) await update($, tellInFlight, () => null)
    // Taken and not on its way: back in line (the next tick takes them in order)
    const strays = names.filter(n => /^\d+-\d+\.taken$/.test(n))
    for (const n of strays) {
      const id = n.slice(0, -6)
      if ((await runSafe($, ['mv', '-f', `${dir}/${n}`, `${dir}/${id}.req`])).exitCode === 0) {
        await tellStatus($, dir, id, 'queued', 'taken but not delivered (the session restarted before its turn, or the call was lost): it goes again when the session is idle')
        debugLine($, `ccc tell ${id}: back in line`)
      }
    }
    if (strays.length) return
    const next = names.filter(n => /^\d+-\d+\.req$/.test(n)).sort()[0]
    if (!next) {
      // What scripts didn't read within a day goes
      if (now - lastTellPrune < 600000) return
      lastTellPrune = now
      const old = entries.filter(f => /\.status$/.test(String(f.name)) && now - Number(f.mtimeMs) > 86400000).map(f => `${dir}/${f.name}`)
      if (old.length) await runSafe($, ['rm', '-f', ...old])
      return
    }
    await tellOne($, dir, names, next)
  } finally {
    telling = false
  }
}

async function tellOne($: any, dir: string, names: string[], next: string) {
  const id = next.slice(0, -4)
  const refuse = async (reason: string) => {
    await tellStatus($, dir, id, 'refused', reason)
    await runSafe($, ['rm', '-f', `${dir}/${next}`, `${dir}/${id}.taken`, `${dir}/${id}.txt`])
    debugLine($, `ccc tell ${id}: refused (${reason})`)
  }
  let req: ReturnType<typeof parseTellRequest> = null
  let text = ''
  try {
    req = parseTellRequest(await $.fs.read(`${dir}/${next}`))
    text = await $.fs.read(`${dir}/${id}.txt`)
  } catch {}
  if (!req || req.format !== FORMAT) return refuse('written by another version of the sessions mod: restart the sessions (u)')
  if (!names.includes('allow')) return refuse("this session doesn't take text from ccc tell: /sessions tell on in it")
  if (!text.trim()) return refuse('no text')
  if (new TextEncoder().encode(text).length > TELL_MAX_BYTES) return refuse('longer than 4 KB')
  // On its way before it's taken: a reload in between finds it in $.state, and its file still in line
  const at = await $.clock.now()
  {
    const next = { id, at }
    if (!sameData(await read($, tellInFlight), next)) await update($, tellInFlight, () => next)
  }
  if ((await runSafe($, ['mv', '-f', `${dir}/${next}`, `${dir}/${id}.taken`])).exitCode !== 0) {
    if (!sameData(await read($, tellInFlight), null)) await update($, tellInFlight, () => null)
    return
  }
  debugLine($, `ccc tell ${id} from ${req.from}: submitted`)
  let r: any
  try {
    r = await $.prompt.submit({ text: tellPrompt(id, req.from, text) })
  } catch (err) {
    if (!sameData(await read($, tellInFlight), null)) await update($, tellInFlight, () => null)
    const failures = (tellFailures.get(id) ?? 0) + 1
    tellFailures.set(id, failures)
    if (failures > 1) return refuse(`couldn't be submitted: ${String(err).slice(0, 120)}`)
    if ((await runSafe($, ['mv', '-f', `${dir}/${id}.taken`, `${dir}/${id}.req`])).exitCode === 0) await tellStatus($, dir, id, 'queued', "its submit failed once: it's tried again")
    debugLine($, `ccc tell ${id}: submit failed (${String(err).slice(0, 120)}), tried again`)
    return
  }
  if (r?.drop) {
    if (!sameData(await read($, tellInFlight), null)) await update($, tellInFlight, () => null)
    await runSafe($, ['mv', '-f', `${dir}/${id}.taken`, `${dir}/${id}.held`])
    await tellStatus($, dir, id, 'held', `${r.drop}: it goes once the person types in the session`)
    debugLine($, `ccc tell ${id}: held (${r.drop})`)
    return
  }
  await tellDelivered($, id)
}

// A request's turn started (its $.prompt.submit resolved, or turn.start carried it): delivered, once
async function tellDelivered($: any, id: string) {
  if ((await read($, tellInFlight))?.id === id) await update($, tellInFlight, () => null)
  tellFailures.delete(id)
  const dir = tellDir()
  if (!dir || !(await exists($, `${dir}/${id}.taken`))) return
  await runSafe($, ['rm', '-f', `${dir}/${id}.taken`, `${dir}/${id}.txt`])
  await tellStatus($, dir, id, 'delivered')
  debugLine($, `ccc tell ${id}: delivered`)
}

// The person typed in the session: the requests held since an Esc go again (behind what they typed)
async function rearmTells($: any) {
  const dir = tellDir()
  if (!dir) return
  let names: string[] = []
  try {
    names = (await $.fs.list(dir)).map((f: any) => String(f.name)).filter((n: string) => /^\d+-\d+\.held$/.test(n))
  } catch {
    return
  }
  for (const n of names) {
    const id = n.slice(0, -5)
    if ((await runSafe($, ['mv', '-f', `${dir}/${n}`, `${dir}/${id}.req`])).exitCode === 0) await tellStatus($, dir, id, 'queued', 'held after an Esc; the person typed, so it goes when the session is idle')
  }
}

// /sessions tell on|off: whether ccc tell may hand this session text (the person's switch, per session; it stays across
// restarts and /clear)
async function tellCommand($: any, word: string): Promise<string> {
  const own = lastList.find(s => s.sessionId === myId)
  if (!active || !own) return "The panel hasn't read the session list yet: try again in a few seconds"
  const dir = tellDir()
  if (!dir) return "Only a background session takes text from ccc tell: this one is a regular session (you're at it)"
  const allow = `${dir}/allow`
  const name = projectRows.find(f => f.current)?.title ?? String(own.name ?? own.id)
  const how = `ccc tell ${JSON.stringify(name)} "<text>" (or its id, ${own.id}) hands this session text from any script, as a turn of its own when it's idle (4 KB at most; the model reads it as sent by the sessions plugin, not by you). Have scripts send pointers ("new mail, id …"), not outside text`
  if (word === 'on') {
    await runSafe($, ['mkdir', '-p', dir])
    await $.fs.write(allow, keyLines({ format: FORMAT, at: await $.clock.now() }))
    return `On. ${how}. /sessions tell off turns it off`
  }
  if (word === 'off') {
    await runSafe($, ['rm', '-f', allow])
    return 'Off: ccc tell no longer reaches this session (requests already waiting are refused)'
  }
  const on = await exists($, allow)
  return on ? `On. ${how}. /sessions tell off turns it off` : `Off. /sessions tell on turns it on: then ${how}`
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
  // The short id stays what the official list says (myShortId): the refresh below sets it. The process runs as the same
  // agent, but the new conversation's transcript doesn't say so (no agent-setting row after /clear): a known agent
  // carries over; with none, the new transcript is read
  if (agentFor === old && myAgent) agentFor = id
  const previous = await readState($, old)
  const existing = await readState($, id)
  const now = await $.clock.now()
  await storeSet($, `state:${id}`, existing ?? { created: previous?.created ?? now, model: previous?.model, context: undefined, version: previous?.version, agent: previous?.agent, root: previous?.root })
  // The project the session belongs to is the process's, the one it started in: the record moves over
  const project = await storeGet($, `project:${old}`)
  if (project) await storeSet($, `project:${id}`, project)
  else if (myCwd) await storeSet($, `project:${id}`, { root: myCwd, from: myCwd, at: now })
  const seen = await storeGet($, `seen:${old}`)
  if (seen && !(await storeGet($, `seen:${id}`))) await storeSet($, `seen:${id}`, seen)
  // What it spends an hour is the process's, whatever the conversation: its ledger carries over
  if (ledgerFor === old) ledgerFor = id
  const spent = await storeGet($, `spend:${old}`)
  if (spent && !(await storeGet($, `spend:${id}`))) await storeSet($, `spend:${id}`, spent)
  for (const k of ['state', 'seen', 'title', 'waiting', 'restarted', 'needsSince', 'pushed', 'spend', 'project']) await storeDelete($, `${k}:${old}`)
  await runSafe($, ['rm', '-f', `${dataDir}/alive/${old}`, `${dataDir}/inbox/${old}`])
  // A regular session is named by its session id in sections.json (sid:<id>): its section moves to the new id. A
  // background one keeps its short id, and its section
  const sections = await readSectionsFile($)
  const member = 'problem' in sections ? undefined : sectionsView(sections.file).members[`sid:${old}`]
  if (member) await changeSections($, file => ({ file: setMember(setMember(file, `sid:${old}`, null), `sid:${id}`, member) }))
  try {
    await beat($)
  } catch {}
  await invalidateList($)
  bg(requestRefresh($))
}

// Starts, wakes and restarts other plugins asked for, queued or running in this module: a reload now would drop them
// after they were told queued
function queuedHere(): boolean {
  return launching || waking || restarting || launches.length > 0 || wakes.length > 0 || restarts.length > 0
}

// A newer version of this mod is installed: update this session's in place with /reload-plugins, when that cuts
// nothing (reloadDecision). The new copy says so when it starts ("Panel updated"), and if the panel had the keyboard it
// takes it back, on the same row (keyboardBack): the person sees a flicker at most. /reload-plugins reloads every
// plugin of the session; a Claude update, settings and MCP servers still need u (a restart). If the update doesn't
// take, the ↑ mark stays and u is the way
async function updateInPlace($: any) {
  if (!active || !myId) return
  if (queuedHere()) return
  const plugin = await installedPlugin($)
  const own = lastList.find(s => s.sessionId === myId)
  const quick = reloadDecision({
    running: modVersion,
    runningDir: PLUGIN_DIR.replace(/\/hooks\/\.\.$/, ''),
    installed: plugin,
    triedFor: reloadTriedFor,
    status: 'idle',
    tasks: 0,
    fieldOpen: false,
  })
  if (quick !== 'reload' || !plugin) return
  // Not idle in the last list (working, waiting, not in it): no reload now, and no list read just to see that (one
  // every 15 s from each busy session would keep the list's lock taken)
  if (own?.status !== 'idle') return
  const tasks = own?.id ? ((await backgroundTasks($, own.id))?.count ?? null) : 0
  let installedSource: string | null = null
  try {
    installedSource = String(await $.fs.read(`${plugin.path}/hooks/watch.ts`))
  } catch {}
  const decision = reloadDecision({
    running: modVersion,
    runningDir: PLUGIN_DIR.replace(/\/hooks\/\.\.$/, ''),
    installed: plugin,
    triedFor: reloadTriedFor,
    status: await statusNow($, myId),
    tasks,
    fieldOpen: (await read($, askingName)) || !!(await read($, renaming)),
    // A copy that watches other paths can't be reloaded into (the ↑ mark stays, and u restarts it)
    watchSet: WATCH_SET,
    installedWatchSet: watchSetOf(installedSource),
  })
  if (decision === 'no' && watchSetOf(installedSource) !== WATCH_SET && watchRefusedFor !== plugin.version) {
    watchRefusedFor = plugin.version
    debugLine($, `not updating in place to ${plugin.version}: it watches another set of paths (u restarts it)`)
  }
  // Again: the checks above take seconds (a list read now), and a start, wake or restart may have been queued meanwhile
  if (decision !== 'reload' || queuedHere()) return
  reloadTriedFor = plugin.version
  // Whether the panel has the keyboard right now, and on which row: the new copy gives it back there
  const focused = !!(await $.ui.panes()).find((p: any) => p.id === PANE)?.isFocused
  await storeSet($, `reloaded:${myId}`, { from: modVersion, to: plugin.version, at: await $.clock.now(), ...(focused ? { focus: selectedRow ?? '' } : {}) })
  debugLine($, `updating in place: ${modVersion} → ${plugin.version}`)
  try {
    await $.command.run({ command: 'reload-plugins' })
  } catch {}
}

// The new copy, after updating in place: say so (only if it really is the new version), and hand the start the row the
// panel had the keyboard on, if it had it (once: a later start finds no focus in the record)
async function announceUpdate($: any): Promise<string | undefined> {
  const r = await storeGet($, `reloaded:${myId}`)
  if (!r || typeof r !== 'object') return undefined
  if ((await $.clock.now()) - Number(r.at) > 120000) {
    await storeDelete($, `reloaded:${myId}`)
    return undefined
  }
  const focus = typeof r.focus === 'string' ? r.focus : undefined
  if (r.to !== modVersion) {
    if (focus !== undefined) await storeSet($, `reloaded:${myId}`, { from: r.from, to: r.to, at: r.at })
    return focus
  }
  await storeDelete($, `reloaded:${myId}`)
  $.ui.toast(`Panel updated to ${modVersion}`)
  return focus
}

// After an update in place made while the panel had the keyboard (updateInPlace): the panel takes it back, on the row
// that was selected (key: s:<sessionId> or h:<section>), or wherever Claude lands it if that row is gone or none was.
// The rows are the old copy's ($.state stays across a reload; with none yet, it waits a little for the start's first
// read); a panel you closed stays closed
async function keyboardBack($: any, key: string) {
  if (await closedByYou($)) return
  let around = ringKeys(await read($, rows))
  for (let i = 0; around.length === 0 && i < 30; i++) {
    await $.clock.sleep(100)
    around = ringKeys(await read($, rows))
  }
  const target = around.includes(key) ? key : undefined
  debugLine($, `update in place: the keyboard back to the panel${target ? `, on ${target}` : ''}`)
  if (target?.startsWith('s:')) return takeKeyboard($, target.slice(2))
  if (target) selectedRow = target
  await takeKeyboard($, undefined)
  if (target) await focusElement($, target)
}

// /sessions status, about telling the person: the options as they apply, today's count, the last notification any
// session sent and what each channel answered, and this session's spend against its usual hour
async function notificationsText($: any, now: number): Promise<string> {
  const when = waitPushMs > 0 ? `a push once a session waits ${howLong(waitPushMs)}` : 'no push for waiting sessions (waitPushMinutes 0)'
  const quiet = quietHours ? `, none ${quietHoursText}` : quietHoursText ? `, quiet hours “${quietHoursText}” not understood (write them as 22-7)` : ''
  const count = `${sentToday(await storeGet($, 'pushCount'), dayOf(new Date(now)))} of ${notificationsPerDay} today`
  const last = await storeGet($, 'lastPush')
  const lastText =
    last && typeof last === 'object'
      ? ` · last, ${howLong(now - Number(last.at))} ago from ${String(last.from)}: ${String(last.text)} (phone: ${String(last.phone)}${last.notification ? `; notification: ${String(last.notification)}` : ''})`
      : ''
  const lines = [`Notifications: ${when}${quiet}, ${count}${lastText}`]
  const burst = ledgerFor === myId && ledger ? spendBurst(ledger as SpendLedger, now, projectUsual) : null
  const usual = burst?.basis === 'project' ? `the project's sessions usually ${formatUsd(burst.usual)} (it has too few active hours of its own yet)` : `usually ${formatUsd(burst?.usual ?? 0)}`
  lines.push(`Spend: ${burst ? `this session spent ${formatUsd(burst.hour)} in the last hour at list price, ${usual}` : "not enough history yet to judge this session's spend against its usual hour"}`)
  lines.push(staleMs > 0 ? `⧗ on rows working, or done and unseen, for ${howLong(staleMs)}` : 'No ⧗ on rows (staleMinutes 0)')
  return lines.join('\n')
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
    `Session: ${myId} · project: ${myCwd} (where it started)${hereNow && myCwd && !inProject(hereNow, myCwd, home) ? ` · working in ${hereNow}, outside it` : ''}`,
    `Heartbeat: ${lastBeat ? `written ${ago(lastBeat)}` : 'not written'} (${dataDir}/alive)`,
    silent.length ? `No panel running in: ${silent.join(', ')}` : 'Every session of the project that should run a panel does',
    `For other plugins: $.sessions api ${SESSIONS_API} · ${Object.keys(METHODS).join(', ')} (${ready() ? 'ready' : 'not ready yet'})`,
    `Tools for Claude: ${toolsOffered || (sessionTools ? 'not offered yet (they are at session.start)' : 'off (the sessionTools option)')}`,
    sectionsProblem ? `Sections: ${sectionsProblem}` : `Sections: ${sectionsNow.sections.length} (${dataDir}/sections.json)${myAgent ? ` · runs as agent ${myAgent}` : ''}`,
    markSources.length
      ? `Marks: ${markSources.map(m => `${m.source} (${m.rows === 1 ? '1 row' : `${m.rows} rows`}, ${Math.max(0, Math.ceil((m.until - now) / 60000))} min left)`).join(', ')}`
      : 'Marks: none',
    await notificationsText($, now),
    await liveText($, now),
  ]
  const apart = await apartText($)
  if (apart) lines.push(apart)
  if (startProblems.length) lines.push(`Start problems: ${startProblems.join('; ')}`)
  return lines.join('\n')
}

// /sessions status, about how the panel learns what changed: watched files or the short timer, where the list comes
// from, and who does the machine-wide work
async function liveText($: any, now: number): Promise<string> {
  const w = await read($, watching)
  const how = live
    ? `Live: the engine watches Claude's registry and the panel's files (set ${WATCH_SET}${w ? `, since ${Math.max(0, Math.round((now - w.at) / 1000))} s ago` : ''})${inboxTimer ? ', but not the inbox (a request came with no file event): read every 0.5 s' : ''}`
    : roleSeen
      ? "Not live: its SessionStart came but had no folders to hand Claude to watch (no home folder?); it reads the files every 3 s"
      : reloadedInto && !startSkipped
        ? 'Not live: this session was updated in place from a version that watched other files; it reads them every 3 s until it restarts (u) or is cleared (/clear)'
        : `Not live: ${SKIPPED_START}. Claude watches files for a mod only when its SessionStart asks, so the panel reads them every 3 s`
  const list = slowList ? `the list from claude agents (${sessionFiles?.problem || "this session isn't in Claude's registry"})` : "the list from Claude's files"
  let record: ReturnType<typeof parseLeader> = null
  try {
    record = parseLeader(String(await $.fs.read(`${dataDir}/leader.json`)))
  } catch {}
  const leader = leading ? 'this session leads the machine-wide work' : record ? `pid ${record.pid} leads the machine-wide work (${Math.max(0, Math.round((now - record.at) / 1000))} s ago${now - record.at >= LEADER_STALE_MS ? ', late' : ''})` : 'no session leads yet'
  return `${how} · ${list} · ${leader}`
}

// /sessions section <title>: puts this session in a section of the person's (made if needed); "-" takes it out; nothing,
// says which one it's in. The person's choice wins over any plugin's
async function sectionCommand($: any, title: string): Promise<string> {
  const own = lastList.find(s => s.sessionId === myId)
  if (!active || !own) return "The panel hasn't read the session list yet: try again in a few seconds"
  const ref = refOf(own)
  if (!title) {
    const m = sectionsNow.members[ref]
    const s = m && sectionsNow.sections.find(x => x.id === m.section)
    return `${s ? `This session is in “${s.title}”${m.by === 'person' ? '' : ` (put there by ${m.by})`}` : "This session isn't in a section"}. /sessions section <title> puts it in one of yours, /sessions section - takes it out, /sessions sections lists them`
  }
  let said = ''
  const r = await changeSections($, file => {
    const p = personAssign(file, ref, title === '-' ? null : title)
    if ('problem' in p) {
      said = p.problem
      return { result: { ok: false, reason: 'invalid', detail: p.problem } }
    }
    said = p.section ? `This session is in “${p.section.title}” now` : 'This session is in no section now'
    return { file: p.file }
  })
  if (!r.ok) return r.reason === 'busy' ? 'Another session is changing the sections: try again' : (r.detail ?? said)
  bg(requestRefresh($, false))
  return said
}

// /sessions sections: every section, who made it and how many sessions it holds (in any project)
async function sectionsList($: any): Promise<string> {
  const file = await readSectionsFile($)
  if ('problem' in file) return file.problem
  const view = sectionsView(file.file)
  const own = lastList.find(s => s.sessionId === myId)
  const mine = own ? view.members[refOf(own)] : undefined
  const count = (id: string) => Object.values(view.members).filter(m => m.section === id).length
  const lines = [...view.sections]
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    .map(s => `${s.id === mine?.section ? '▌' : ' '} ${s.title} · ${count(s.id) === 1 ? '1 session' : `${count(s.id)} sessions`}${s.owner === 'person' ? '' : ` (${s.owner})`}`)
  return [lines.length ? 'Sections:' : 'No sections yet.', ...lines, '/sessions section <title> puts this session in one of yours (made if needed); /sessions section - takes it out'].join('\n')
}

// ---- $.sessions: what other plugins call (types/index.d.ts, docs/plugin-contract.md) ----
// Each method takes one plain-data argument and answers from memory or from sections.json. A method's calls run in the
// calling plugin's hook (Claude lends it that hook's context), so none submits a prompt, asks or moves the focus, every
// path is absolute and every command runs from a folder that exists (runSafe). They work before the mod has started
// here: current and status answer ready: false, and the section methods find the data folder from the environment
const SESSIONS_API: SessionsApi = 1
// The methods this copy serves: a key missing from Sessions, or one too many, fails the type check
const METHODS = { contract: 1, current: 1, status: 1, sections: 1, defineSection: 1, assignSection: 1, start: 1, wake: 1, setMarks: 1, pin: 1, restart: 1 } satisfies Record<SessionsMethod, 1>
// How long another plugin's call waits for the sections lock before answering busy (6 × 50 ms)
const CALL_LOCK_TRIES = 6

function ready(): boolean {
  return active && !!myId && listedAt > 0
}

let versionRead = ''
async function ownVersion($: any): Promise<string> {
  if (modVersion) return modVersion
  if (!versionRead) {
    try {
      versionRead = String(JSON.parse(await $.fs.read(`${PLUGIN_DIR}/.claude-plugin/plugin.json`))?.version ?? '')
    } catch {}
  }
  return versionRead
}

// A session of the official list as another plugin sees it. reasons: the service log's stop reasons, read once by the
// caller when a row it answers is stopped
async function statusOf($: any, s: any, now: number, reasons: () => Promise<StopLog>): Promise<SessionsStatus> {
  const e = await readState($, s.sessionId)
  const mine = s.sessionId === myId
  const hb = mine ? 'ok' : s.pid ? heartbeatStatus((await readHeartbeats($, [s.sessionId]))[s.sessionId] ?? null, s.pid, now) : 'missing'
  const shown = projectRows.find(f => f.sessionId === s.sessionId)?.title
  const state = s.status === 'busy' ? 'working' : s.status === 'waiting' ? 'waiting' : s.status === 'idle' ? 'idle' : 'stopped'
  return {
    ref: refOf(s),
    sessionId: s.sessionId,
    name: shown ?? (typeof s.name === 'string' && s.name ? s.name : null),
    state,
    panel: hb === 'ok' ? 'ok' : hb === 'other-format' ? 'other-format' : 'none',
    // The project it belongs to as its own mod recorded it (its heartbeat), else as its panel published it
    root: mine ? myCwd : (recordedRoots.get(s.sessionId) ?? (typeof e?.root === 'string' ? e.root : null)),
    background: s.kind === 'background',
    agent: mine ? (agentFor === myId ? myAgent : null) : typeof e?.agent === 'string' ? e.agent : null,
    ...(state === 'stopped' && s.kind === 'background' && !s.pid ? { stopped: await stoppedOf($, s, await reasons()) } : {}),
  }
}

function sessionsApi($: any): Sessions {
  return {
    contract: async () => ({ api: SESSIONS_API, version: await ownVersion($), format: FORMAT, methods: Object.keys(METHODS) as SessionsMethod[] }),
    current: async () => {
      const own = ready() ? lastList.find(s => s.sessionId === myId) : undefined
      return {
        ready: ready(),
        ref: own ? refOf(own) : null,
        sessionId: myId,
        name: projectRows.find(f => f.current)?.title ?? String(own?.name ?? ''),
        root: myCwd,
        background: own?.kind === 'background',
        agent: agentFor === myId ? myAgent : null,
      }
    },
    status: async input => {
      if (!ready()) return { ready: false, rows: [] }
      const strings = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string').slice(0, 200) : [])
      const now = await $.clock.now()
      const out: SessionsStatus[] = []
      const done = new Set<string>()
      // The service's log is read once, and only when a row is stopped
      let log: StopLog | null = null
      const reasons = async () => (log ??= await stopLogNow($))
      for (const ref of strings(input?.refs)) {
        const s = lastList.find(x => refOf(x) === ref)
        if (done.has(s?.sessionId ?? `gone:${ref}`)) continue
        done.add(s?.sessionId ?? `gone:${ref}`)
        out.push(s ? await statusOf($, s, now, reasons) : { ref, sessionId: null, name: null, state: 'gone', panel: 'none', root: null, background: false, agent: null })
      }
      for (const name of strings(input?.names)) {
        for (const s of lastList.filter(x => x.name === name && !done.has(x.sessionId))) {
          done.add(s.sessionId)
          out.push(await statusOf($, s, now, reasons))
        }
      }
      return { ready: true, rows: out }
    },
    sections: async () => {
      const file = await readSectionsFile($)
      if ('problem' in file) throw new Error(file.problem)
      return sectionsView(file.file)
    },
    defineSection: async input => {
      const v = checkSectionSpec(input?.source, input?.spec)
      if (!v.ok) return v
      return changeSections(
        $,
        file => {
          const s = sectionsView(file).sections.find(x => x.id === v.section.id)
          if (s && s.title === v.section.title && s.order === v.section.order && s.owner === v.section.owner) return { result: { ok: true } }
          return { file: upsertSection(file, v.section) }
        },
        CALL_LOCK_TRIES,
      )
    },
    assignSection: async input => changeSections($, file => assignChange(file, input?.source, input?.ref, input?.section, input?.parent), CALL_LOCK_TRIES),
    start: async input => {
      const v = checkStart(input)
      if (!v.ok) return v
      const l = v.request
      if (!ready()) return { ok: false, reason: 'not-ready', detail: "sessions hasn't read the session list in this session yet: try again in a few seconds" }
      if (l.cwd === home) return { ok: false, reason: 'refused', detail: bgRefusal('trusted one session at a time', l.cwd) }
      let folder = false
      try {
        folder = (await $.fs.stat(l.cwd)).kind === 'dir'
      } catch {}
      if (!folder) return { ok: false, reason: 'invalid', detail: `${l.cwd} isn't a folder` }
      if (l.settings && !(await exists($, l.settings))) return { ok: false, reason: 'invalid', detail: `${l.settings} doesn't exist` }
      const root = await rootOf($, l.cwd)
      // Each session in the project it belongs to (belongsHere), a queued one in the folder it will start in
      const taken = lastList.some(s => s.name === l.name && belongsHere(s, root)) || launches.some(x => x.name === l.name && inProject(x.cwd, root, home))
      if (taken) return { ok: false, reason: 'refused', detail: `a session named “${l.name}” is already in ${root}` }
      launches.push({ ...l, root })
      kickQueue()
      return { ok: true, queued: true }
    },
    wake: async input => {
      const ref = input?.ref
      if (!isRef(ref)) return { ok: false, reason: 'invalid', detail: 'ref is a short id or sid:<sessionId>' }
      if (!ready()) return { ok: false, reason: 'not-ready', detail: "sessions hasn't read the session list in this session yet: try again in a few seconds" }
      // force (0.15.1): the caller acts on the person's own command, so a stop of the person's (or one nothing explains)
      // doesn't keep the session away
      const force = input?.force === true
      const v = await wakeVerdict($, ref, force)
      if (v.state === 'running') return { ok: true, state: 'running' }
      if (v.state === 'refused') return { ok: false, reason: 'refused', detail: v.detail, state: 'refused' }
      let reason = typeof input?.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ').slice(0, 120) : ''
      if (force && (v.why === 'person' || v.why === 'unknown')) reason = `forced, ${v.why === 'person' ? 'stopped by the person' : 'nothing says why it stopped'}${reason ? `: ${reason}` : ''}`
      if (!wakes.some(w => w.id === v.id)) wakes.push({ id: v.id, name: v.name, reason })
      kickQueue()
      return { ok: true, state: 'queued' }
    },
    setMarks: async input => {
      const v = checkMarks(input)
      if (!v.ok) return v
      let sid = myId
      try {
        sid ||= String(await $.session.id())
      } catch {}
      if (!sid) return { ok: false, reason: 'not-ready', detail: "this session's id isn't known yet: try again in a moment" }
      const key = `${await storeNamespaceOf($)}marks:${v.source}:${sid}`
      try {
        const now = await $.clock.now()
        if (Object.keys(v.rows).length === 0) await $.store.delete(key)
        else await $.store.set(key, { at: now, until: now + v.ttlMs, rows: v.rows })
      } catch (err) {
        return { ok: false, reason: 'busy', detail: `couldn't write the marks: ${String(err).slice(0, 120)}` }
      }
      // The panels read the marks again: this one at once, the others when the bell's event comes
      forgetStored(k => k.startsWith('marks:'))
      await ring($, 'marks')
      return Object.keys(v.rejected).length ? { ok: true, rejected: v.rejected } : { ok: true }
    },
    pin: async input => {
      const ref = input?.ref
      if (!isRef(ref)) return { ok: false, reason: 'invalid', detail: 'ref is a short id or sid:<sessionId>' }
      if (typeof input?.pinned !== 'boolean') return { ok: false, reason: 'invalid', detail: 'pinned is true or false' }
      if (!ready() || !jobsDir) return { ok: false, reason: 'not-ready', detail: "sessions hasn't read the session list in this session yet: try again in a few seconds" }
      const s = lastList.find(x => refOf(x) === ref)
      if (!s) return { ok: false, reason: 'refused', detail: `${ref} isn't in the session list` }
      const name = String(projectRows.find(f => f.sessionId === s.sessionId)?.title ?? (s.name || s.id || ref))
      if (s.kind !== 'background' || typeof s.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s.id)) return { ok: false, reason: 'refused', detail: `“${name}” is a regular session: only a background session is pinned` }
      const id = s.id
      const pinned = input.pinned
      const reason = typeof input?.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ').slice(0, 120) : ''
      const file = pinsPath()
      let result: SessionsResult = { ok: false, reason: 'busy', detail: 'another session is changing pins.json: try again' }
      await withLock(
        $,
        file,
        async () => {
          const pins = await pinsFromFile($)
          if (!pins) {
            result = { ok: false, reason: 'refused', detail: "pins.json couldn't be read as a list of ids: left as it is" }
            return
          }
          const plugin = pluginPinsOf(await storeGet($, 'pluginPins'))
          const autoIds = (await storeGet($, 'autoPins'))?.ids
          const c = pluginPinChange(pins, plugin, Array.isArray(autoIds) ? autoIds : [], id, pinned)
          if (c.changed && !(await writePins($, file, c.pins, pinned ? [] : [id]))) {
            result = { ok: false, reason: 'busy', detail: "couldn't write pins.json: try again" }
            return
          }
          await storeSet($, 'pluginPins', c.plugin)
          debugLine($, `${pinned ? 'pin' : 'unpin'} “${name}” (${reason || 'no reason given'}): ${c.refused ?? (c.changed ? 'done' : 'nothing to change')}`)
          result = c.refused ? { ok: false, reason: 'refused', detail: `“${name}”: ${c.refused}` } : { ok: true }
        },
        CALL_LOCK_TRIES,
      )
      return result
    },
    restart: async input => {
      const ref = input?.ref
      if (!isRef(ref)) return { ok: false, reason: 'invalid', detail: 'ref is a short id or sid:<sessionId>' }
      if (!ready()) return { ok: false, reason: 'not-ready', detail: "sessions hasn't read the session list in this session yet: try again in a few seconds" }
      const refused = (detail: string) => ({ ok: false as const, reason: 'refused' as const, detail, state: 'refused' as const })
      const s = lastList.find(x => refOf(x) === ref)
      if (!s) return refused(`${ref} isn't in the session list`)
      const name = String(projectRows.find(f => f.sessionId === s.sessionId)?.title ?? (s.name || s.id || ref))
      if (s.kind !== 'background' || typeof s.id !== 'string') return refused(`“${name}” is a regular session: it lives in its own window (/exit and claude -c)`)
      if (!s.pid) return refused(`“${name}” isn't running: $.sessions.wake brings back a stopped one`)
      if (s.status === 'busy') return refused(`“${name}” is working: ask again once it's idle`)
      if (s.status === 'waiting') return refused(`“${name}” is waiting for the person: ask again once it's idle`)
      // This very session: the windows showing it must come back by themselves (opened with ccc), since no question is
      // asked; one opened another way would be left at the shell
      if (s.sessionId === myId) {
        const v = await windows($)
        const stranded = (v.byId[s.id] ?? []).filter(tty => !v.launchers[tty])
        if (stranded.length) return refused(`a window that wasn't opened with ccc shows “${name}” (${stranded.join(', ')}): it wouldn't come back by itself after the restart; u in the panel restarts it`)
      }
      const reason = typeof input?.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ').slice(0, 120) : ''
      // Asked again while it waits: it waits RESTART_WAIT_MS from now
      const until = (await $.clock.now()) + RESTART_WAIT_MS
      const queued = restarts.find(r => r.id === s.id)
      if (queued) queued.until = until
      else restarts.push({ id: s.id, sessionId: s.sessionId, name, reason, until, next: 0 })
      kickQueue()
      return { ok: true, state: 'queued' as const }
    },
  }
}

// Starts the mod in this session, once (see `starting`). The steps that can fail go one by one, each on its own, so one
// that fails doesn't take the rest with it, and in order of need: who this session is, where its files are, its
// record and its heartbeat, the timers, the panel, and /sessions last
function ensureStarted($: any, via: string): Promise<void> {
  if (!starting) {
    startedVia = via
    starting = start($).finally(() => (startDone = true))
  }
  return starting
}

// The first draw starts the mod from a timer it sets (a draw only draws), with that draw's $, and the timer can fire
// before the draw has settled (the band's own reads, or the plugins beneath it, still answering). Until it has, the
// engine refuses every $.state write made with that $ ("made while ui.render is being dispatched"), so the start's
// first write is tried again 10 ms apart until it's taken, for 2 s at most; any other failure ends the wait. Once the
// draw has settled no later write meets it
async function afterDraw($: any, write: () => Promise<unknown>) {
  for (let tries = 1; ; tries++) {
    try {
      await write()
      return
    } catch (err) {
      if (tries >= 200 || !/while ui\.render is being dispatched/.test(String(err))) throw err
      await $.clock.sleep(10)
    }
  }
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
    // Another module drew in this session before this one: this one came in by a reload, and watches what that one
    // asked
    const before = await read($, shortId)
    reloadedInto = before !== ''
    live ||= (await read($, watching))?.set === WATCH_SET
    // The start's first write: started by the first draw, it waits for that draw to settle (afterDraw), and is written
    // even when it's the same, so that nothing after it writes before
    const next = myId.slice(0, 8)
    if (startedVia === 'first draw') await afterDraw($, () => $.state.set({ plugin: 'sessions', key: 'shortId' }, next))
    else if (!sameData(before, next)) await update($, shortId, () => next)
  })
  idKnown()
  // Came in by a reload with nothing watched: whether this machine's starts find no SessionStart at all (then neither a
  // restart nor /clear makes it live), for what /sessions status and the panel say
  if (reloadedInto && !live) startSkipped = (await storeGet($, START_SKIPPED)) != null
  await step('folders', async () => {
    home = (await $.env.get('HOME')) ?? ''
    dataDir = (await $.env.get('SESSIONS_DATA_DIR')) || (home ? `${home}/.claude/mods/sessions-data` : '')
    jobsDir = (await $.env.get('SESSIONS_JOBS_DIR')) || (home ? `${home}/.claude/jobs` : '')
    daemonLog = (await $.env.get('SESSIONS_DAEMON_LOG')) || (home ? `${home}/.claude/daemon.log` : '')
    locations = await locationsOf($)
    if (locations.registry) sessionFiles = new SessionFiles(locations)
    if (home && (await exists($, home))) workDir = home
    if (dataDir) {
      const sub = ['alive', 'order', 'inbox', 'windows', 'replies', 'debug', 'usage', 'tell'].map(d => `${dataDir}/${d}`)
      await runSafe($, ['mkdir', '-p', ...sub])
    }
    await settleProject($)
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
  await step('heartbeat', async () => {
    await beat($)
    // Here: the other panels read this session's record and heartbeat
    await ring($, myId)
  })
  let keyboardTo: string | undefined
  await step('update notice', async () => {
    keyboardTo = await announceUpdate($)
  })
  await step('timers', async () => {
    // If this session was restarted from its own panel (u), announce that it's back
    const restartedAt = Number(await storeGet($, `restarted:${myId}`)) || 0
    if (restartedAt) {
      await storeDelete($, `restarted:${myId}`)
      if ((await $.clock.now()) - restartedAt < 120000) bg(notifyWhenBack($))
    }
    // A New or Rename field left open before a reload or a restart would come back stuck in the pane: start closed
    await closeFields($)
    waitingOnly = (await storeGet($, 'waitingOnly')) === true
    collapsed = await readCollapsed($)
    const view = await storeGet($, 'usageView')
    if (view && ['day', 'week', 'month'].includes(view.period) && ['all', 'project'].includes(view.scope)) {
      {
        const next = { period: view.period, scope: view.scope }
        if (!sameData(await read($, usageView), next)) await update($, usageView, () => next)
      }
    }
    // The person is told (pushWaits, notifySpend) from the mod's own timers and file events only, never from a hook of
    // a turn. Watched, the timers are the heartbeat, the pass (from this session's own offset), the rows' times and the
    // seen check while something is unseen; with nothing watched, the short timer too (setPace)
    kickQueue = () => {
      $.clock.after(0, () => quickTick($))
    }
    $.clock.every(15000, () => {
      bg(beat($))
    })
    $.clock.after(wakeStagger(myId), () => {
      bg(solo('pass', () => pass($)))
      $.clock.every(PASS_MS, () => {
        bg(solo('pass', () => pass($)))
      })
    })
    active = true
    setPace($)
    bg(
      (async () => {
        await syncFiles($, true)
        await requestRefresh($)
        await solo('leader', () => leaderTurn($, 'start'))
        if (live) {
          bg(solo('inbox', () => checkInbox($)))
          bg(solo('tells', () => checkTells($)))
          bg(scheduleSeen($))
        }
      })(),
    )
    void recordTitle($).catch(() => {})
    bg(readAgent($).then(() => publishUsage($)))
    // Running again: a stop of the person's from before no longer keeps a plugin's wake away from it
    if (myId) bg(storeDelete($, `personStop:${myId}`))
  })
  await step('panel', async () => {
    if (!(await closedByYou($))) {
      await $.ui.open({ id: PANE, title: 'Sessions', columns: requestedWidth || undefined })
      bg(readUsage($, live ? USAGE_FOLLOWER_MS : USAGE_SHARED_MS))
    }
    await paneState($)
    // Only into a module that came in by a reload: a session restarted meanwhile (a new process) starts as any other
    if (keyboardTo !== undefined && reloadedInto) bg(keyboardBack($, keyboardTo))
  })
  await step('command', () =>
    $.command.register({
      name: 'sessions',
      description:
        'Sessions panel: open, focus or close. /sessions section <title>: put this session in a section (- takes it out); /sessions sections: list them. /sessions tell on|off: let scripts hand this session text with ccc tell. /sessions status: is the mod running here. /sessions setup: status line, shortcuts and the ccc command',
      argumentHint: '[section <title> | section - | sections | tell on|off | status | setup [--dry-run] [--force-statusline] [--macos-launcher] [--shell=bash|zsh|fish]]',
      immediate: true,
    }),
  )
}

export const register: Register = (on, options) => {
  debugLogs = options?.debugLogs === true
  const minutes = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * 60000 : fallback)
  waitPushMs = minutes(options?.waitPushMinutes, 600000)
  staleMs = minutes(options?.staleMinutes, 3600000)
  quietHoursText = typeof options?.quietHours === 'string' ? options.quietHours.trim() : ''
  quietHours = parseQuietHours(quietHoursText)
  notificationsPerDay = typeof options?.notificationsPerDay === 'number' && Number.isFinite(options.notificationsPerDay) ? Math.max(0, Math.floor(options.notificationsPerDay)) : 5
  sessionTools = options?.sessionTools !== false
  // $.sessions for other plugins (sessionsApi). Nothing else happens here: a throw at this step unloads the whole mod.
  // Claude doesn't let the $ built here be handed to a function, so the methods get the few calls they make (files,
  // commands, the clock, the environment, the store) through closures over it
  on('engine.create', async (_, e, next) => {
    const $ = await next(e)
    const calls = {
      // Only what dataFolder and storeNamespaceOf read (Claude wants each variable's name written out)
      env: {
        get: (key: string) =>
          key === 'HOME'
            ? $.env.get('HOME')
            : key === 'SESSIONS_DATA_DIR'
              ? $.env.get('SESSIONS_DATA_DIR')
              : key === 'SESSIONS_JOBS_DIR'
                ? $.env.get('SESSIONS_JOBS_DIR')
                : key === 'SESSIONS_DAEMON_LOG'
                  ? $.env.get('SESSIONS_DAEMON_LOG')
                  : key === 'SESSIONS_CLAUDE'
                    ? $.env.get('SESSIONS_CLAUDE')
                    : key === 'SESSIONS_PLUGIN_VERSION'
                      ? $.env.get('SESSIONS_PLUGIN_VERSION')
                      : key === 'SESSIONS_PLUGIN_SINCE'
                        ? $.env.get('SESSIONS_PLUGIN_SINCE')
                        : key === 'SESSIONS_REGISTRY_DIR'
                          ? $.env.get('SESSIONS_REGISTRY_DIR')
                          : Promise.resolve(undefined),
      },
      fs: {
        read: (path: string) => $.fs.read(path),
        write: (path: string, text: string) => $.fs.write(path, text),
        exists: (path: string) => $.fs.exists(path),
        stat: (path: string) => $.fs.stat(path),
        list: (path: string) => $.fs.list(path),
      },
      process: { run: (argv: string[], init?: { stdin?: string; timeoutMs?: number; cwd?: string; env?: Record<string, string> }) => $.process.run(argv, init) },
      clock: { now: () => $.clock.now(), sleep: (ms: number) => $.clock.sleep(ms) },
      store: {
        get: (key: string) => $.store.get(key),
        set: (key: string, value: unknown) => $.store.set(key, value as any),
        delete: (key: string) => $.store.delete(key),
        keys: () => $.store.keys(),
      },
      session: { id: () => $.session.id() },
    }
    return { ...$, sessions: sessionsApi(calls) }
  })
  // In a non-interactive run (claude -p) the mod does nothing. The start isn't awaited before next(e): a step that hangs
  // mustn't hold the session up. After the plugins beneath, and once classic.SessionStart said the agent, the tools for
  // Claude are registered, awaited for a moment at most (offerTools)
  on('session.start', async ($, e, next) => {
    if (e.isInteractive) {
      sawSessionStart = true
      bg(ensureStarted($, 'session.start'))
    }
    const r = await next(e)
    if (e.isInteractive) {
      try {
        await offerTools($, String(e.cwd ?? ''))
      } catch {}
    }
    return r
  })

  // The paths the engine watches for this session (watch.ts), handed over with what the plugins beneath ask (fleet's
  // own, for one); and what changed in them: noted, read a moment later (flush), and passed on, since every plugin's
  // hook hears every watched path
  on('classic.SessionStart', async ($, e, next) => {
    // The agent this session runs as, for the tools for Claude (offerTools, at session.start), noted at once and kept in
    // $.state for a reload
    const role: AgentRole = { agent: typeof e.agent_type === 'string' && e.agent_type ? e.agent_type : null }
    const first = roleSeen === null
    roleSeen = role
    roleKnown()
    if (roleFrom && first && role.agent !== (await read($, agentRole))?.agent) debugLine($, `SessionStart came late, with ${role.agent ? `agent ${role.agent}` : 'no agent'}: the tools went by ${roleFrom}`)
    roleFrom = ''
    try {
      if (!sameData(await read($, agentRole), role)) await update($, agentRole, () => role)
    } catch {}
    // A process's own start: this machine's starts wait for SessionStart again (START_SKIPPED), once per module
    if (first && (e.source === 'startup' || e.source === 'resume')) bg(forgetSkippedStart($))
    const r = await next(e)
    try {
      const paths = await watchFor($, String(e.session_id ?? ''), String(e.source ?? ''))
      return paths.length ? { ...r, watchPaths: [...(r?.watchPaths ?? []), ...paths] } : r
    } catch {
      return r
    }
  }).catch(($, e, next) => next(e))
  // The tools for Claude (offerTools): answered here, never by the engine. A plugin that depends on sessions has its
  // own tool.call hooks on them run before these (Claude registers a plugin's hooks before those of the plugins it
  // depends on), and can refuse a call with { deny }; any plugin can with a tool.check hook (docs/plugin-contract.md)
  on('tool.call', { tool: 'mcp__sessions__list' }, async ($, e) => listTool($, e)).catch(() => ({ result: `${LIST_TOOL} failed inside the sessions plugin: try again in a few seconds` }))
  on('tool.call', { tool: 'mcp__sessions__wake' }, async ($, e) => wakeTool($, e)).catch(() => ({
    result: `${WAKE_TOOL} failed inside the sessions plugin, and the session may or may not be restarting: call ${LIST_TOOL} in a few seconds to see whether it runs`,
  }))
  on('classic.FileChanged', async ($, e, next) => {
    if (active && locations.registry) fileChanged($, String(e.file_path ?? ''), String(e.event ?? ''))
    return next(e)
  }).catch(($, e, next) => next(e))

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

  // The main loop's turns only: a subagent's run inside a turn starts no new one (the working time and ⧗ count from
  // the main turn), and nothing here holds the run up
  on('turn.start', async ($, e, next) => {
    if (active && e.agentId === undefined) {
      bg(ownStatus($, 'busy'))
      bg(markTurnStart($))
      // A ccc tell request's turn: delivered (also when the call that submitted it was lost to a reload)
      const id = tellIdIn(String(e.text ?? ''))
      if (id) bg(tellDelivered($, id))
    }
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
      // You arrived by a click in another session's panel: you're looking at this one; the keyboard stays where it is
      if (n.kind === 'seen') {
        if (active) bg(seenNow($))
        return { consumed: 'sessions: seen after a switch by click' }
      }
      if (n.kind === 'ask') {
        if (active && d.from) bg(answerQuestion($, d))
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
    if (active) bg(markTurnStart($))
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
      bg(ownStatus($, 'idle'))
      void recordTitle($).catch(() => {})
      bg(publishUsage($))
      // Watched: what's due at a turn's end, which the short timer would find (the seen check while it's unseen, ccc
      // tell's next request), from a timer of the mod's own: a request is submitted only from there
      if (live) {
        bg(scheduleSeen($))
        $.clock.after(0, () => {
          bg(solo('tells', () => checkTells($)))
        })
      }
    }
    return r
  })

  // Typing in the box (or from the phone) counts as having seen the session; a message from another session doesn't
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'composer' || e.origin?.kind === 'bridge') {
      bg(ensureStarted($, 'prompt'))
      if (active) {
        await storeSet($, `seen:${myId}`, await $.clock.now())
        bg(rearmTells($))
      }
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
    if (words[0] === 'section') return { text: await sectionCommand($, words.slice(1).join(' ')) }
    if (words[0] === 'sections') return { text: await sectionsList($) }
    if (words[0] === 'tell') return { text: await tellCommand($, words[1] ?? '') }
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
      if (!sameData(await read($, paneNote), 'closed')) await update($, paneNote, () => 'closed')
    }
    return r
  })

  // The arrows (and Tab) only go through the sessions and the folded sections' lines: they don't leave the list towards
  // the buttons above and below or the panel's markers; those are reached with their key (n, a, s) or with the mouse
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
    // Keys in this session's panel: the person is at this session
    bg(seenNow($))
    // With the New or Rename field open, Tab and the arrows stay in it (Enter or Esc get you out)
    const field = (await read($, askingName)) ? 'name' : (await read($, renaming)) ? 'rename-input' : null
    if (field) return e.element === field ? next(e) : next({ ...e, element: field })
    // The sessions and the folded sections' lines, in the order they're drawn
    const ring = ringKeys(await read($, rows))
    if (ring.length === 0) return next(e)
    let target = e.element
    if (!target || !ring.includes(target)) {
      // You just entered the panel (or came from a button below): the first arrow goes to the first session
      if (!currentFocus || !ring.includes(currentFocus)) target = ring[0]
      // The buttons above and below, the name field or a panel marker (also when Claude wraps around): don't leave the
      // list. Put the focus back on the selected session instead of doing nothing: if it ended up somewhere else (a
      // field that closed and shifted the positions), the arrows bring it back instead of getting stuck
      else return next({ ...e, element: currentFocus })
    }
    if (target === currentFocus) return {}
    const r = target === e.element ? await next(e) : await next({ ...e, element: target })
    if (!r.deny && target) {
      currentFocus = target
      selectedRow = target
    }
    return r
  })

  // The line above the prompt: how many sessions wait for you (red) or have something unseen (yellow), why the panel
  // isn't shown (with a button that opens it: shift+→ then Enter, or a click), the account's windows on a subscription,
  // and this session's short id. One row, with whatever other mods (and Claude) draw there after it: the band is
  // shared. Its first draw starts the mod when nothing else did (a session draws even with no window attached; a draw
  // only draws, so the start runs from a timer, and its first write waits for the draw to settle: afterDraw)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    if (!starting && !renderScheduled) {
      renderScheduled = true
      $.clock.after(0, () => {
        bg(ensureStarted($, 'first draw'))
      })
    }
    const beneath = await next(e)
    // A survey holds the band: it goes first
    if (e.props.hasSurvey) return beneath
    const about = await read($, summary)
    const reds = about.waiting
    const yellows = about.unseen
    const id = await read($, shortId)
    const note = await read($, paneNote)
    const why = note === 'closed' ? 'panel closed · /sessions to open' : note === 'narrow' ? 'panel hidden: window too narrow · /sessions to show' : ''
    // On a subscription, each of the account's windows once ("7d 43%"); off one (an API key) the panel shows the cost
    const account = limitsText(await read($, limits))
    // A session whose data is kept apart (a test session, or one a background service handed ccc's variables): its
    // seen and state never reach the other panels, so it says so where it can't go unnoticed
    const apart = (await storeNamespaceOf($)) ? 'data apart: /sessions status' : ''
    const counts = (
      <Text dimColor>
        {reds > 0 && <Text color={TINT.red}>● </Text>}
        {reds > 0 && `${reds}  `}
        {yellows > 0 && <Text color={TINT.yellow}>● </Text>}
        {yellows > 0 && `${yellows}  `}
        {reds + yellows > 0 && !why && '/sessions  '}
      </Text>
    )
    const own =
      !why || e.surface !== 'terminal' ? (
        <Text dimColor>
          {counts}
          {why && `${why}  `}
          {account && `${account}  `}⟨{id}⟩
          {apart && <Text color={TINT.yellow}>{`  ${apart}`}</Text>}
        </Text>
      ) : (
        <Box flexDirection="row">
          {counts}
          <Button key="show-panel" plain dimColor label={why} onPress={() => { bg(openByYou($)) }} />
          <Text dimColor>{`  ${account ? `${account}  ` : ''}⟨${id}⟩`}</Text>
          {apart && <Text color={TINT.yellow}>{`  ${apart}`}</Text>}
        </Box>
      )
    return (
      <Box flexDirection="column">
        {own}
        {beneath}
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
    // default one", the cap. What this draw saw is noted, and a change has adjustWidth work the width out again
    if (e.viewport?.isFullscreen && e.viewport.columns && e.props.bodyColumns) {
      const seen = { body: e.props.bodyColumns, window: e.viewport.columns + e.props.bodyColumns + 1, asked: requestedWidth }
      if (!paneSeen || seen.body !== paneSeen.body || seen.window !== paneSeen.window || seen.asked !== paneSeen.asked) {
        paneSeen = seen
        $.clock.after(0, () => {
          bg(adjustWidth($))
        })
      }
    }
    const marks = list.some(f => f.noPanel || f.otherFormat)
    const about = await read($, summary)
    // On an API account each row says what its session cost so far, and a line the project's total (list price)
    const spends = about.spent !== null
    // What's drawn, top to bottom (drawPlan): a section's title above its first row, when two or more groups have rows
    // (plain Text, which the focus ring skips), a folded section's one line (a button that unfolds it) instead of its
    // rows, and the rows, each with its status line under it. The f filter's line ("Waiting for you · 3 of 17") goes
    // above them, as Text too
    const plan = drawPlan(list)
    const shownRows = list.filter(f => !f.folded)
    // The line about the sessions of every folder that ended with the background service, under the legend: one line,
    // more where the panel is narrower than it (it wraps between words)
    const endedNote = await read($, ended)
    const endedLine = endedNote ? `${endedNote.text}${inTerminal ? ` · b: ${endedNote.action}` : ''}` : ''
    // Where this session works when that's outside its project (one line under the legend): it stays in the project it
    // started in, and in every panel of it, wherever it goes
    const awayFolder = await read($, away)
    const endedRows = (endedLine ? Math.ceil((displayWidth(endedLine) + 4) / Math.max(20, (e.props.bodyColumns ?? 48) - 1)) : 0) + (awayFolder ? 1 : 0)
    // While the list doesn't fit, the status lines of rows that don't need you are left out (their badges stay), so more
    // sessions fit; a row that waits for you, or that a plugin marked as needing you, keeps its line
    const crowded = plan.length + shownRows.filter(f => f.line).length + (about.waitingOnly ? 1 : 0) + 6 + (note !== '' ? 1 : 0) + endedRows > height
    const keepsLine = (f: Row) => !!f.line && (!crowded || f.color === 'red' || f.needsPerson === true)
    const lines = plan.length + shownRows.filter(keepsLine).length + (about.waitingOnly ? 1 : 0)
    const overflows = lines + 6 + (note !== '' ? 1 : 0) + endedRows > height
    // The usage block (4 lines and one of spacing) goes at the bottom of the panel, only with the panel docked at the
    // side and if it fits without making the list overflow. To keep it at the bottom, the panel takes its full height
    // and a flexible spacer pushes the block down
    const view = await read($, usageView)
    const bodyRows: number | undefined = e.props.scroll?.bodyRows
    const room = bodyRows ?? height
    const showUsage =
      inTerminal &&
      e.props.placement === 'dock' &&
      lines + 6 + (note !== '' ? 1 : 0) + endedRows + (list.some(f => f.outdated) ? 1 : 0) + (list.some(f => f.pinned) ? 1 : 0) + (marks ? 1 : 0) + (spends ? 1 : 0) + (list.some(f => f.helpers > 0) ? 1 : 0) + (list.some(f => f.stale) ? 1 : 0) + 5 <= room
    // Read only while the block is shown: a new reading of the token usage doesn't draw a panel that doesn't show it
    const usageData = showUsage ? await read($, usage) : null
    const help = e.props.isFocused ? (overflows ? 'Tab Next · ↑↓ Scroll · Enter Switch · Esc Back' : '↑↓ Select · Enter Switch · ← Back') : 'shift+→ to use the panel'
    // How many sessions (or folded sections) don't fit below: said at the top, where it's always in view, so a running
    // session past the bottom edge isn't taken for a missing one
    const above = (inTerminal ? 1 : 0) + 1 + 1 + (note !== '' ? 1 : 0) + (about.waitingOnly ? 1 : 0)
    const below = overflows
      ? rowsBelow(
          plan.map(it => (it.kind === 'header' ? { lines: 1, counts: false } : it.kind === 'fold' ? { lines: 1, counts: true } : { lines: keepsLine(it.row) ? 2 : 1, counts: true })),
          room,
          above,
        )
      : 0
    // Columns: [▌][● ][name…][↑][◆][ model  ctx  time][ spend]; in narrow panels the model is left out
    // Rows use only the width they need: in the box above the prompt (small windows or not fullscreen) the panel takes
    // the whole screen, and without this the model and time would end up far away from the name
    const spendWidth = spends ? SPEND_COLUMN : 0
    const marksWidth = markColumns(list)
    const total = Math.min(e.props.bodyColumns ?? 48, paneWidth(list.map(f => f.title), e.props.bodyColumns ?? 48, spendWidth + marksWidth)) - 1
    const showModel = total >= 44
    const infoWidth = (showModel ? 20 : 10) + spendWidth
    const nameWidth = Math.max(8, total - 4 - infoWidth - marksWidth)
    const badgeWidth = list.some(f => f.badge) ? BADGE_COLUMN : 0
    const indentWidth = list.some(f => f.depth > 0) ? INDENT : 0
    const helperWidth = helperColumn(list)
    const padRight = (t: string, w: number) => t + ' '.repeat(Math.max(0, w - displayWidth(t)))
    const padLeft = (t: string, w: number) => ' '.repeat(Math.max(0, w - displayWidth(t))) + t
    // ⧗ before the time: working, or done and unseen, for staleMinutes or longer (it takes a column the time leaves free)
    const info = (f: Row) =>
      `${showModel ? `  ${padRight(f.model, 9)}` : ''} ${padLeft(f.context, 4)} ${padLeft(`${f.stale ? '⧗' : ''}${f.time}`, 4)}${spends ? ` ${padLeft(f.usd === null ? '' : formatUsd(f.usd), SPEND_COLUMN - 1)}` : ''}`
    // A child's name starts INDENT columns in; the others take those columns
    const name = (f: Row) => {
      const width = nameWidth + (f.depth > 0 ? 0 : indentWidth)
      return padRight(truncate(f.title, width), width)
    }
    // ↑: runs an older Claude version than the installed one; !: its panel isn't running there, or runs another version
    // (u restarts it). Both take the first space after the name
    const mark = (f: Row) =>
      f.noPanel || f.otherFormat ? <Text color={TINT.yellow}>!</Text> : <Text color="claude">{f.outdated ? '↑' : ' '}</Text>
    // Another plugin's badge (up to 3 columns), in its tint or dim; its status line goes under the row, indented to the name
    const badge = (f: Row) => (badgeWidth ? <Text color={f.tint || undefined} dimColor={f.tint ? undefined : true}>{padRight(f.badge ? ` ${f.badge}` : '', badgeWidth)}</Text> : null)
    // ⚙n: what the session runs in the background (⚙ takes one column: padded by hand, not by displayWidth)
    const helpers = (f: Row) => (helperWidth ? <Text dimColor>{(f.helpers > 0 ? ` ⚙${f.helpers}` : '').padEnd(helperWidth)}</Text> : null)
    const statusLine = (f: Row) =>
      keepsLine(f) ? (
        <Text key={`l:${f.sessionId}`} color={f.tint || undefined} dimColor={f.tint ? undefined : true}>
          {truncate(`${' '.repeat(3 + (f.depth > 0 ? INDENT : 0))}${f.line}`, total)}
        </Text>
      ) : null
    // On entering the panel (ctrl+x tab) the focus goes to a session, or a folded section's line: the last selected one,
    // or the first session
    const fields = asking || !!renamingRow
    const foldSelected = plan.some(it => it.kind === 'fold' && `h:${it.section}` === selectedRow)
    const jumpable = shownRows.filter(f => !f.current)
    const initial = foldSelected ? undefined : (shownRows.find(f => `s:${f.sessionId}` === selectedRow) ?? jumpable[0] ?? shownRows[0])?.sessionId
    // A row: [▌ or space][indent][●][ ][name][↑ or !][◆][badge][⚙n][model ctx time][spend]. The session you're in: the theme's
    // soft background and a bar in Claude's color. It's selected with the arrows like the others (for u and r, even if
    // it's the only one in the list); Enter there doesn't jump anywhere
    const row = (f: Row) => [
      <Box key={`row:${f.sessionId}`} flexDirection="row" backgroundColor={f.current ? 'userMessageBackground' : undefined}>
        {f.current ? <Text color="claude">▌</Text> : <Text> </Text>}
        {f.depth > 0 && <Text>{' '.repeat(INDENT)}</Text>}
        <Text color={TINT[f.color]}>●</Text>
        <Text> </Text>
        {inTerminal ? (
          <Button
            key={`s:${f.sessionId}`}
            plain
            autoFocus={f.sessionId === initial && !fields ? true : undefined}
            label={name(f)}
            onPress={() => (f.current ? $.ui.toast("You're in this session") : bg(jump($, f)))}
          />
        ) : (
          <Text bold={f.current ? true : undefined}>{name(f)}</Text>
        )}
        {/* ◆: pinned, the background service doesn't close it for being idle */}
        {mark(f)}
        <Text>{f.pinned ? '◆' : ' '}</Text>
        {badge(f)}
        {helpers(f)}
        <Text dimColor>{f.current ? padRight(info(f), total - 4 - nameWidth - marksWidth).slice(1) : info(f).slice(1)}</Text>
      </Box>,
      statusLine(f),
    ]
    // A folded section: one line with its title, how many sessions it holds and how many wait for you. In the terminal
    // it's a button (Enter, or c, unfolds it)
    const fold = (it: { section: string; title: string; count: number; waiting: number }) => {
      const label = truncate(`▸ ${it.title} · ${it.count}${it.waiting ? ` · ${it.waiting} waiting for you` : ''}`, total - 1)
      return inTerminal ? (
        <Box key={`fold:${it.section}`} flexDirection="row">
          <Text> </Text>
          <Button key={`h:${it.section}`} plain dimColor autoFocus={foldSelected && selectedRow === `h:${it.section}` && !fields ? true : undefined} label={label} onPress={() => { bg(unfold($, it.section)) }} />
        </Box>
      ) : (
        <Text key={`h:${it.section}`} dimColor>{` ${label}`}</Text>
      )
    }
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
            <Text dimColor> · </Text>
            {/* f: only the sessions waiting for you (drawn bright while it's on) */}
            <Button key="waiting" plain dimColor={about.waitingOnly ? undefined : true} hotkey="f" label="Waiting" onPress={() => { bg(toggleWaiting($)) }} />
            <Text dimColor> · </Text>
            {/* c: fold the selected session's section into one line, or unfold the one selected */}
            <Button key="fold" plain dimColor hotkey="c" label="Collapse" onPress={() => { bg(toggleFold($)) }} />
            <Text dimColor>{` · ${help}`}</Text>
          </Box>
        )}
        <Text> </Text>
        {below > 0 && (
          <Text dimColor>{truncate(`↓ ${below} more below · ${e.props.isFocused ? '↑↓ scroll' : 'shift+→, then ↑↓'}`, total)}</Text>
        )}
        {note !== '' && <Text color="warning">{note}</Text>}
        {about.waitingOnly && <Text dimColor>{truncate(`Waiting for you · ${list.length} of ${about.sessions}${inTerminal ? ' · f: all' : ''}`, total)}</Text>}
        {list.length === 0 && <Text dimColor>{about.waitingOnly ? 'Nobody is waiting for you.' : 'No other sessions in this folder.'}</Text>}
        {plan.flatMap(it =>
          it.kind === 'header' ? [<Text key={`t:${it.section}`} dimColor>{` ${truncate(it.title, total - 1)}`}</Text>] : it.kind === 'fold' ? [fold(it)] : row(it.row),
        )}
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
        {awayFolder !== '' && <Text key="away" dimColor>{outsideNote(awayFolder, myCwd, home, total)}</Text>}
        {/* Sessions of any folder that ended with the background service: b asks, then brings them back. Under the
            legend, after every row and field: a line that comes and goes there moves nothing the arrows go through.
            A word each, so a panel narrower than the line wraps it between words with the key flowing after them */}
        {endedNote && (
          <Box flexDirection="row" flexWrap="wrap">
            {(inTerminal ? `${endedNote.text} ·` : endedNote.text).split(' ').map((word, i) => (
              <Text key={`ended:${i}`} color="warning">{`${word} `}</Text>
            ))}
            {inTerminal && <Button key="bring-back" plain hotkey="b" label={endedNote.action} onPress={() => { bg(bringBack($)) }} />}
          </Box>
        )}
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
        {helperWidth > 0 && <Text dimColor>⚙ Running in the background: subagents, shells</Text>}
        {list.some(f => f.stale) && <Text dimColor>{truncate(`⧗ Working, or done and unseen, for ${howLong(staleMs)} or more`, total)}</Text>}
        {about.spent !== null && <Text dimColor>{truncate(`${formatUsd(about.spent)} est. spent here so far (list price)`, total)}</Text>}
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
        {showUsage && !usageData?.summary && <Text dimColor>{usageData?.note || 'Reading token usage…'}</Text>}
        {showUsage &&
          usageData?.summary &&
          (() => {
            // usage.py counts each response in the folder its session belongs to (sessionHome's rule), and this session's
            // project is the one it started in: a session's tokens stay in its project wherever it worked
            const includes = view.scope === 'all' ? () => true : (folder: string) => inProject(folder, myCwd, home)
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
