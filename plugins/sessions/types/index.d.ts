export type Color = 'red' | 'blue' | 'yellow' | 'green' | 'gray'

export type Row = {
  sessionId: string
  id: string | null
  title: string
  color: Color
  time: string
  model: string
  context: string
  current: boolean
  background: boolean
  // Runs an older Claude version than the installed one (u updates it)
  outdated: boolean
  // Pinned: the background service doesn't close it for being idle (with Remote Control, the mod pins it on its own)
  pinned: boolean
  // Its mod isn't running: it should have a heartbeat and has none (u restarts it; nothing is sent to it)
  noPanel: boolean
  // Its mod runs another version of the shared formats: it needs a restart to talk to this one (nothing is sent to it)
  otherFormat: boolean
  // Its mod answers: notices can be sent to it (the arrival focus, the Stop and Restart questions, the rename)
  reachable: boolean
  // How other plugins name it (SessionsRef): its short id, or sid:<sessionId> for a regular session
  ref: string
  // The section it's drawn in ('' for none) and that section's title
  section: string
  sectionTitle: string
  // What it has cost so far in US dollars at list price, on an API account (null on a subscription, or not known yet)
  usd: number | null
}

// One rate-limit window of the account, as a session's last response reported it (five_hour, seven_day, …)
export type RateLimit = { kind: string; percent: number }

// The usage block. usage.py builds the summary: totals per day and per hour, split by the session's folder; each total
// is [input, output, cache read, cache written, thinking] (thinking is part of the output)
export type Period = 'day' | 'week' | 'month'
// today = YYYY-MM-DD, hour = the current hour (YYYY-MM-DDTHH), days and hours: totals keyed by folder, then by day or hour
export type UsageSummary = {
  today: string
  hour: string
  days: Record<string, Record<string, number[]>>
  hours: Record<string, Record<string, number[]>>
}
// What usage.py read (or why there's nothing), and which period and scope were chosen
export type Usage = { summary: UsageSummary | null; note: string }
// Stored under `usageView` (shared by every session)
export type UsageView = { period: Period; scope: 'all' | 'project' }
// The session whose new name is being typed (key r), or null
export type Renaming = { sessionId: string; title: string } | null
// Why the panel isn't shown, for the line above the prompt: closed by you, or waiting for a wider window
export type PaneNote = '' | 'closed' | 'narrow'

// ---- The API for other plugins: $.sessions, contract api 1 ----
// What other plugins call. Everything above, and PluginState below, is this plugin's own and not part of it.
// The rules for changing it are in docs/plugin-contract.md: within an api, changes only add (methods, optional input
// fields, output fields); a removal or a change of meaning raises SessionsApi in the same commit as its callers.

/** The contract's number: raised only when a method is removed or renamed, or changes meaning or shape */
export type SessionsApi = 1
/** A session: its official short id from `claude agents` (it stays across /clear), or `sid:<sessionId>` for a regular
 * (non-background) session, which has none */
export type SessionsRef = string
/** What a method that changes something answers. busy: another session held the lock (try again on a later tick);
 * refused: not allowed (someone else's section, or the person's choice); invalid: bad input; not-ready: sessions can't
 * work here yet (no home folder) */
export type SessionsResult = { ok: true } | { ok: false; reason: 'busy' | 'refused' | 'invalid' | 'not-ready'; detail?: string }
export type SessionsContract = {
  api: SessionsApi
  /** sessions' version (its plugin.json) */
  version: string
  /** sessions' wire format (FORMAT), for information */
  format: number
  /** The methods this copy serves: call only these */
  methods: SessionsMethod[]
}
/** This session, from memory (no command, no lock) */
export type SessionsCurrent = {
  /** false until sessions has started in this session and read the official list once */
  ready: boolean
  /** From the official list (never derived from the session id); null until ready */
  ref: SessionsRef | null
  sessionId: string
  /** The name as the panel shows it */
  name: string
  /** The project root the panel uses */
  root: string
  background: boolean
  /** The agent the session runs as (`claude --agent <name>`), from its transcript's first row; null for none */
  agent: string | null
}
/** working: in a turn; waiting: for the person (a permission, a question); idle; stopped: no process; gone: not in the
 * official list */
export type SessionsState = 'working' | 'waiting' | 'idle' | 'stopped' | 'gone'
/** Another session, from the panel's last refresh (every 3 s) */
export type SessionsStatus = {
  ref: SessionsRef
  sessionId: string | null
  name: string | null
  state: SessionsState
  /** Its sessions mod: running, not running, or running another wire format (it needs a restart) */
  panel: 'ok' | 'none' | 'other-format'
  /** The project root its own panel uses, when it published one */
  root: string | null
  background: boolean
  agent: string | null
}
/** A section a plugin defines: id `<plugin>:<name>` (`me:` and `sessions:` are reserved), a title (up to 60
 * characters, cut to fit when drawn) and an order (ascending; the person's sections default to 100, a plugin's to 200) */
export type SessionsSectionSpec = { id: string; title: string; order?: number }
/** owner: 'person' for the person's own (`me:<slug>`), else the plugin that defined it */
export type SessionsSection = { id: string; title: string; order: number; owner: string }
/** by: 'person', or the plugin that assigned it */
export type SessionsMember = { section: string; by: string }
export type Sessions = {
  contract: () => Promise<SessionsContract>
  current: () => Promise<SessionsCurrent>
  /** The sessions named by ref (a ref not in the list comes back `gone`) and by exact name (every session with it, in any
   * project), in that order, once each. Before ready: `{ ready: false, rows: [] }` */
  status: (input: { refs?: SessionsRef[]; names?: string[] }) => Promise<{ ready: boolean; rows: SessionsStatus[] }>
  /** Every section and member. Rejects when sections.json is from a newer sessions (restart the session) */
  sections: () => Promise<{ sections: SessionsSection[]; members: Record<SessionsRef, SessionsMember> }>
  /** Creates or updates one of the caller's own sections (`<source>:<name>`) */
  defineSection: (input: { source: string; spec: SessionsSectionSpec }) => Promise<SessionsResult>
  /** Puts a session in one of the caller's own sections, or takes it out of one (null). Never over the person's choice,
   * nor another plugin's */
  assignSection: (input: { source: string; ref: SessionsRef; section: string | null }) => Promise<SessionsResult>
}
export type SessionsMethod = keyof Sessions

declare module 'claude-code' {
  interface EngineInterface {
    sessions: Sessions
  }
  interface PluginState {
    sessions: {
      rows: Row[]
      askingName: boolean
      renaming: Renaming
      notice: string
      usage: Usage
      usageView: UsageView
      paneNote: PaneNote
      shortId: string
      limits: RateLimit[]
    }
  }
}
