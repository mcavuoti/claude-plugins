// Linux (and any system other than macOS; SESSIONS_PORTABLE=1 tries it on a Mac): there's no portable way to ask the
// desktop which window is in front or to type into one, so windows are found from processes and switched through the
// launcher only, which every terminal has. Windows are brought forward with wmctrl or xdotool (X11 only) and opened with
// the first terminal emulator found; a process's program and folder come from /proc, memory from /proc/meminfo.
// Only fully testable on Linux: edit this file from there (see CONTRIBUTING.md).
import type { Windows } from '../state'
import type { Platform } from './types'

// Without asking the desktop which window is in front (Linux: no portable way, and none at all on Wayland), the window
// this session is shown in, which is where its panel was just used: a viewer of this session, preferring one that runs
// the launcher (only those can switch in place) and, among several, the newest client (the highest pid). Else the
// session's own terminal, if it's a regular session (pass myPid only then: a background session's process has the
// service's internal terminal, which isn't a window). Else, if there's exactly one agent view with a launcher, that one
// (the session may be open inside it; with several, there's no telling which). null if none
export function pickWindowShowingMe(v: Windows, myShortId: string, myPid?: number): string | null {
  const viewers = v.byId[myShortId] ?? []
  const newest = (ttys: string[]) => [...ttys].sort((a, b) => Number(v.clients[b] ?? 0) - Number(v.clients[a] ?? 0))[0] ?? null
  const withLauncher = viewers.filter(t => v.launchers[t])
  if (withLauncher.length) return newest(withLauncher)
  if (viewers.length) return newest(viewers)
  const own = myPid ? v.byPid[String(myPid)] : undefined
  if (own) return own
  const views = v.agentsViews.filter(c => v.launchers[c.tty])
  return views.length === 1 ? (views[0]?.tty ?? null) : null
}

// The command that opens a new window of a given terminal emulator running a shell command, for the terminals found on
// Linux desktops. Each one takes the command its own way; null for one it doesn't know
export function terminalCommand(terminal: string, shellCommand: string): string[] | null {
  const run = ['bash', '-c', shellCommand]
  switch (terminal.split('/').pop()) {
    case 'gnome-terminal':
    case 'kgx':
    case 'ptyxis':
    case 'wezterm':
      return terminal.endsWith('wezterm') ? [terminal, 'start', '--', ...run] : [terminal, '--', ...run]
    case 'xfce4-terminal':
      return [terminal, '-x', ...run]
    case 'kitty':
    case 'foot':
      return [terminal, ...run]
    case 'x-terminal-emulator':
    case 'konsole':
    case 'alacritty':
    case 'tilix':
    case 'terminator':
    case 'xterm':
    case 'urxvt':
    case 'st':
      return [terminal, '-e', ...run]
    default:
      return null
  }
}

// The terminals tried to open a new window, in order: $TERMINAL (if it's one of the known ones), the Debian/Ubuntu
// default (x-terminal-emulator), then the common ones
export const LINUX_TERMINALS = [
  'x-terminal-emulator',
  'gnome-terminal',
  'kgx',
  'ptyxis',
  'konsole',
  'xfce4-terminal',
  'kitty',
  'alacritty',
  'wezterm',
  'foot',
  'tilix',
  'terminator',
  'xterm',
]

export const linux: Platform = {
  name: 'linux',

  async windowShowingMe(_run, v, me) {
    // A background session's own process has a terminal too (the background service's internal one, not a window):
    // only a regular session's own terminal counts
    return pickWindowShowingMe(v, me.shortId, !me.background && me.pid ? me.pid : undefined)
  },

  // There's no telling which window is in front, so a session counts as seen only when you type in it
  async windowInFront() {
    return null
  },
  async userPresent() {
    return true
  },

  async readWindow() {
    return ''
  },

  // By title (the launcher titles each window with its session's name), with wmctrl, else xdotool; X11 only
  async bringWindow(run, _tty, title) {
    if ((await run(['wmctrl', '-a', title])).exitCode === 0) return true
    return (await run(['xdotool', 'search', '--name', title, 'windowactivate'])).exitCode === 0
  },

  // Without a way to bring it forward (no wmctrl/xdotool, or Wayland), the session shows in the current window too
  showHereIfCantBring: true,

  // $TERMINAL if it's a known one, else the first terminal emulator found; detached, since some stay in the foreground
  // until their window closes. Needs a graphical session (DISPLAY or WAYLAND_DISPLAY)
  async openWindow(run, _front, _title, command) {
    const env = (await run(['/bin/sh', '-c', 'printf "%s|%s|%s" "${DISPLAY:-}" "${WAYLAND_DISPLAY:-}" "${TERMINAL:-}"'])).stdout.split('|')
    const [display, wayland, preferred] = env
    if (!display && !wayland) return false
    for (const name of [preferred ?? '', ...LINUX_TERMINALS].filter(Boolean)) {
      const argv = terminalCommand(name, command)
      const program = argv?.[0]
      if (!argv || !program) continue
      if ((await run(['/bin/sh', '-c', 'command -v "$1" >/dev/null', 'sh', program])).exitCode !== 0) continue
      return (await run(['/bin/sh', '-c', 'nohup "$@" >/dev/null 2>&1 &', 'sh', ...argv])).exitCode === 0
    }
    return false
  },

  // Nothing to close: a viewer ends with its session and the launcher leaves the plain shell
  async closeWindow() {},

  async processProgram(run, pid) {
    const r = await run(['/bin/sh', '-c', 'printf "n%s" "$(readlink "/proc/$1/exe")"', 'sh', pid])
    return r.exitCode === 0 ? r.stdout : ''
  },

  async processCwd(run, pid) {
    const r = await run(['readlink', `/proc/${pid}/cwd`])
    return r.exitCode === 0 ? r.stdout.trim() : ''
  },

  // More than 1.5 GB available (the background service closes sessions with less than 1 GB free)
  async memoryNormal(run) {
    const m = (await run(['cat', '/proc/meminfo'])).stdout.match(/^MemAvailable:\s+(\d+) kB/m)
    return m ? Number(m[1]) > 1.5 * 1024 * 1024 : null
  },

  text: {
    switchNeedsWindow: 'To switch, open this session with ccc (the launcher lets the panel switch that window)',
    agentsNeedsWindow: 'To open the agent view, open this session with ccc (the launcher lets the panel switch that window)',
    regularUnreachable: title => `“${title}” runs in its own window, which this panel can't bring forward here: switch to it there`,
    cantOpen: title => `Couldn't open a window for “${title}”: open a terminal and run ccc there`,
    cantOpenAgents: "Couldn't open the agent view here: open a terminal and run ccc",
    cantBring: 'windows can only be brought forward on X11 with wmctrl or xdotool',
  },
}
