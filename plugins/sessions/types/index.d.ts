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
}

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

declare module 'claude-code' {
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
    }
  }
}
