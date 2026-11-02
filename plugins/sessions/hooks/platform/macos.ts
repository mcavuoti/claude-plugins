// macOS: windows are Terminal.app windows, driven through AppleScript (which window is in front, bring one forward,
// read its text, type into it, open or close one), plus ioreg (presence), lsof (a process's program and folder) and
// sysctl (memory pressure). Only testable on a Mac: edit this file from one (see CONTRIBUTING.md).
import type { Platform, Run } from './types'

// Terminal.app via AppleScript: which window is in front, bring one forward, open a new one, read a screen.
// The script's mode words (the first argument) are Spanish: "frente" = which window is in front, "leer" = read a tab's
// contents, "traer" = bring a tab's window forward, "cerrar" = close the window, only when that tab is its only one
// (answers "solapas" = it has other tabs, which stay as they are, or "ocupada" = busy, if the tab is running something),
// "abrir" = open a new window with the same bounds. A Terminal that isn't running is never launched: every mode answers
// "" then (a command inside the tell block would start it, and it would open a window)
export const TERMINAL = `on run argv
  set modo to item 1 of argv
  if application "Terminal" is not running then return ""
  tell application "Terminal"
    if modo is "frente" then
      if (count of windows) is 0 then return "no"
      return (frontmost as text) & " " & (tty of selected tab of front window)
    end if
    repeat with w in windows
      set wid to id of w
      repeat with i from 1 to count of tabs of w
        if tty of tab i of w is (item 2 of argv) then
          if modo is "leer" then return contents of tab i of window id wid
          if modo is "traer" then
            set selected of tab i of w to true
            set index of w to 1
            activate
            return "ok"
          end if
          if modo is "cerrar" then
            if (count of tabs of w) > 1 then return "solapas"
            if busy of tab i of w then return "ocupada"
            close w
            return "ok"
          end if
          if modo is "abrir" then
            set limites to bounds of w
            set t to do script (item 4 of argv)
            set custom title of t to (item 3 of argv)
            set title displays custom title of t to true
            set nueva to (first window whose selected tab is t)
            set bounds of nueva to limites
            set index of nueva to 1
            activate
            return tty of t
          end if
        end if
      end repeat
    end repeat
  end tell
  return ""
end run`

async function terminal(run: Run, args: string[]): Promise<string> {
  const r = await run(['osascript', '-', ...args], { stdin: TERMINAL, timeoutMs: 8000 })
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

// "frente" answers "<is Terminal the frontmost app> <tty of the front window's selected tab>" ("no" without windows):
// the tty, only if Terminal is in front
export function parseFront(answer: string): string | null {
  const [frontmost, tty] = answer.trim().split(' ')
  return frontmost === 'true' && tty ? tty : null
}

// ioreg: the screen is locked ("IOConsoleLocked" = Yes), and the seconds since the last keyboard or mouse input
// ("HIDIdleTime", in nanoseconds); null if it isn't there
export function screenLocked(rootRegistry: string): boolean {
  return /"IOConsoleLocked" = Yes/.test(rootRegistry)
}
export function idleSeconds(hidRegistry: string): number | null {
  const m = hidRegistry.match(/"HIDIdleTime" = (\d+)/)
  return m ? Number(m[1]) / 1e9 : null
}

// lsof -Fn: the line "n<path>" of the field asked for
function lsofPath(text: string): string {
  return text.split('\n').find(l => l.startsWith('n'))?.slice(1) ?? ''
}

export const macos: Platform = {
  name: 'macos',

  // The front Terminal window, only if it's one showing this session: one of its viewers (or its own window, for a
  // regular session), or an agent view showing its ⟨id⟩ tag on screen
  async windowShowingMe(run, v, me) {
    const front = parseFront(await terminal(run, ['frente']))
    if (!front) return null
    const mine = [...(v.byId[me.shortId] ?? []), ...(me.pid && v.byPid[String(me.pid)] ? [v.byPid[String(me.pid)]] : [])]
    if (mine.includes(front)) return front
    if (v.agentsViews.some(c => c.tty === front) && (await terminal(run, ['leer', front])).includes(`⟨${me.shortId}⟩`)) return front
    return null
  },

  frontKnown: true,

  async windowInFront(run) {
    return parseFront(await terminal(run, ['frente']))
  },

  // Screen unlocked and keyboard or mouse used in the last 2 minutes
  async userPresent(run) {
    if (screenLocked((await run(['ioreg', '-n', 'Root', '-d1'], { timeoutMs: 15000 })).stdout)) return false
    const idle = idleSeconds((await run(['ioreg', '-c', 'IOHIDSystem', '-d', '4', '-r'], { timeoutMs: 15000 })).stdout)
    return idle === null || idle < 120
  },

  async readWindow(run, tty) {
    return terminal(run, ['leer', tty])
  },

  async bringWindow(run, tty) {
    return (await terminal(run, ['traer', tty])) === 'ok'
  },

  showHereIfCantBring: false,

  // A new window next to the current one, with its size and position
  async openWindow(run, front, title, command) {
    return !!(await terminal(run, ['abrir', front, title, command]))
  },

  async closeWindow(run, tty) {
    await terminal(run, ['cerrar', tty])
  },

  async processProgram(run, pid) {
    const r = await run(['lsof', '-a', '-p', pid, '-d', 'txt', '-Fn'], { timeoutMs: 15000 })
    return r.exitCode === 0 ? r.stdout : ''
  },

  async processCwd(run, pid) {
    return lsofPath((await run(['lsof', '-a', '-p', pid, '-d', 'cwd', '-Fn'], { timeoutMs: 15000 })).stdout)
  },

  // The system memory pressure level, what the background service looks at: 1 normal, 2 warning, 4 critical
  async memoryNormal(run) {
    const r = await run(['sysctl', '-n', 'kern.memorystatus_vm_pressure_level'])
    const level = Number(r.stdout.trim())
    return r.exitCode === 0 && level > 0 ? level === 1 : null
  },

  text: {
    switchNeedsWindow: 'To switch, use the panel from the Terminal window showing this session',
    agentsNeedsWindow: 'To open the agent view, use the panel from the Terminal window showing this session',
    regularUnreachable: title => `“${title}” isn't in a Terminal window this panel can reach (another app or tmux): switch to it there`,
    cantOpen: title => `Couldn't open a window for “${title}”`,
    cantOpenAgents: "Couldn't open the agent view",
    cantBring: "Terminal didn't bring that window forward",
  },
}
