// macOS: windows are Terminal.app windows, driven through AppleScript (which window is in front, bring one forward,
// open or close one), plus lsappinfo (the app in front), ioreg (presence), lsof (a process's program and folder) and
// sysctl (memory pressure). Only testable on a Mac: edit this file from one (see CONTRIBUTING.md).
import type { Platform, Run } from './types'

// Terminal.app via AppleScript: which window is in front, bring one forward, open a new one. Each run is an Apple Event
// to Terminal, which Terminal serves on threads of its own: the seen check asks only with someone at the computer and
// Terminal the app in front (windowInFront), and nothing reads a tab's text.
// The script's mode words (the first argument) are Spanish: "frente" = which window is in front, "traer" = bring a
// tab's window forward, "cerrar" = close the window, only when that tab is its only one
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
      repeat with i from 1 to count of tabs of w
        if tty of tab i of w is (item 2 of argv) then
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

// How long a question may take before osascript is cut off: which window is in front is a property read (31 ms or so),
// bringing a window forward or closing one a little more, opening one waits for Terminal to make it. Cutting osascript
// off doesn't end what Terminal does with the event, it only stops waiting: the seen check backs off on a slow answer
export const TERMINAL_TIMEOUT_MS: Record<string, number> = { frente: 3000, traer: 5000, cerrar: 5000, abrir: 8000 }

async function terminal(run: Run, args: string[]): Promise<string> {
  const r = await run(['osascript', '-', ...args], { stdin: TERMINAL, timeoutMs: TERMINAL_TIMEOUT_MS[args[0] ?? ''] ?? 5000 })
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

// The app in front, from the system's list of apps, with no Apple Event: lsappinfo gives the front app's ASN, then that
// ASN's bundle id, which is kept (an ASN names one launch of one app), so an app already met costs no second command.
// With the screen locked the app in front is the login window. null: lsappinfo couldn't tell
const TERMINAL_APP = 'com.apple.Terminal'
const bundles = new Map<string, string>()
export function parseAsn(text: string): string | null {
  return text.match(/ASN:0x[0-9a-f]+-0x[0-9a-f]+:/i)?.[0] ?? null
}
export function parseBundle(text: string): string | null {
  return text.match(/bundleID="([^"]+)"/)?.[1] ?? null
}
async function frontApp(run: Run): Promise<string | null> {
  const front = await run(['lsappinfo', 'front'], { timeoutMs: 3000 })
  const asn = front.exitCode === 0 ? parseAsn(front.stdout) : null
  if (!asn) return null
  const known = bundles.get(asn)
  if (known) return known
  const info = await run(['lsappinfo', 'info', '-only', 'bundleid', asn], { timeoutMs: 3000 })
  const id = info.exitCode === 0 ? parseBundle(info.stdout) : null
  if (!id) return null
  if (bundles.size >= 100) bundles.clear()
  bundles.set(asn, id)
  return id
}

// Someone at the computer: keyboard or mouse used in the last PRESENT_IDLE_S (5 minutes: reading a session without
// touching anything for a while still counts), and the screen unlocked (asked only where the
// app in front couldn't be told: a locked screen puts the login window there)
const PRESENT_IDLE_S = 300
async function present(run: Run, checkLock: boolean): Promise<boolean> {
  if (checkLock && screenLocked((await run(['ioreg', '-n', 'Root', '-d1'], { timeoutMs: 3000 })).stdout)) return false
  const idle = idleSeconds((await run(['ioreg', '-c', 'IOHIDSystem', '-d', '4', '-r'], { timeoutMs: 3000 })).stdout)
  return idle === null || idle < PRESENT_IDLE_S
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
  // regular session), or an agent view: the panel was just used from the window in front, so an agent view there shows
  // this session (its text isn't read)
  async windowShowingMe(run, v, me) {
    const front = parseFront(await terminal(run, ['frente']))
    if (!front) return null
    const mine = [...(v.byId[me.shortId] ?? []), ...(me.pid && v.byPid[String(me.pid)] ? [v.byPid[String(me.pid)]] : [])]
    return mine.includes(front) || v.agentsViews.some(c => c.tty === front) ? front : null
  },

  frontKnown: true,

  // Terminal is asked only when someone could be looking at it: the app in front is Terminal (or can't be told) and
  // someone is at the computer, both found with no Apple Event. Away, or in another app, nothing is asked of Terminal
  async windowInFront(run) {
    const app = await frontApp(run)
    if (app !== null && app !== TERMINAL_APP) return null
    if (!(await present(run, app === null))) return null
    return parseFront(await terminal(run, ['frente']))
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

  // Nothing runs through a loader here: ps lists claude as it is
  clientCommand: command => command,

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

  // /usr/bin/python3 without the developer tools is a stub that pops up a prompt to install them
  async pythonUsable(run, path) {
    return path !== '/usr/bin/python3' || (await run(['xcode-select', '-p'])).exitCode === 0
  },

  fileWatch: 'kqueue',

  text: {
    switchNeedsWindow: 'To switch, use the panel from the Terminal window showing this session',
    agentsNeedsWindow: 'To open the agent view, use the panel from the Terminal window showing this session',
    regularUnreachable: title => `“${title}” isn't in a Terminal window this panel can reach (another app or tmux): switch to it there`,
    cantOpen: title => `Couldn't open a window for “${title}”`,
    cantOpenAgents: "Couldn't open the agent view",
    cantBring: "Terminal didn't bring that window forward",
  },
}
