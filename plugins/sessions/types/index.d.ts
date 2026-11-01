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
}

// The usage block. uso.py builds the summary: totals per day and per hour, split by the session's folder; each total is
// [input, output, cache read, cache written, thinking] (thinking is part of the output)
export type Period = 'day' | 'week' | 'month'
// Field names mirror uso.py's output JSON, a wire format (a mod version still loaded in another session may run this
// same uso.py), so they stay in Spanish: hoy = today (YYYY-MM-DD), hora = current hour (YYYY-MM-DDTHH),
// dias = per-day totals, horas = per-hour totals, both keyed by session folder and then by day or hour
export type UsageSummary = {
  hoy: string
  hora: string
  dias: Record<string, Record<string, number[]>>
  horas: Record<string, Record<string, number[]>>
}
// What uso.py read (or why there's nothing), and which period and scope were chosen
export type Usage = { summary: UsageSummary | null; note: string }
// Stored under `vistaUso`: the field names (periodo = period, alcance = scope) are a wire format shared with other
// sessions, so they stay in Spanish
export type UsageView = { periodo: Period; alcance: 'all' | 'project' }
// The session whose new name is being typed (key r), or null
export type Renaming = { sessionId: string; title: string } | null

declare module 'claude-code' {
  interface PluginState {
    sessions: { rows: Row[]; askingName: boolean; renaming: Renaming; notice: string; usage: Usage; usageView: UsageView }
  }
}
