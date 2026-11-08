// Linux (and any system other than macOS; SESSIONS_PORTABLE=1 tries it on a Mac): there's no portable way to type into a
// window, so windows are found from processes and switched through the launcher only, which every terminal has. Which
// window is in front is read with xprop (X11 only), by its title; windows are brought forward with wmctrl or xdotool
// (X11 only) and opened with the first terminal emulator found; a process's program and folder come from /proc, memory
// from /proc/meminfo.
// Only fully testable on Linux: edit this file from there (see CONTRIBUTING.md).
import type { Windows } from '../state'
import type { Platform, Shown } from './types'

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

// xdotool's --name takes an extended regular expression: one that matches exactly this title, its special characters
// escaped
export function exactTitlePattern(title: string): string {
  return `^${title.replace(/[.[\]()*+?{}|^$\\]/g, '\\$&')}$`
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

// A host whose glibc is too old for the claude binary runs it through a loader (`ld-linux… [--library-path DIR]
// …/claude/versions/X.Y.Z <args>`), so ps lists a viewer or agent view as that line and never as `claude <args>`. This
// reads such a line as `claude <args>`; any other command is returned as it is
export function clientCommand(command: string): string {
  const m = command.match(/^\S*\/ld-linux[^\s/]*\s+(?:--library-path\s+\S+\s+)?\S*\/claude\/versions\/\d+\.\d+\.\d+(?:\s+(.*))?$/)
  return m ? (m[1] ? `claude ${m[1]}` : 'claude') : command
}

// The program a loader runs, from its NUL-separated /proc/<pid>/cmdline: the argument that is a claude version's
// path; '' if it names none (/proc/<pid>/exe is the loader itself there)
export function programFromCmdline(cmdline: string): string {
  return cmdline.split('\0').find(arg => /\/claude\/versions\/\d+\.\d+\.\d+$/.test(arg)) ?? ''
}

// The window in front, as `xprop -root _NET_ACTIVE_WINDOW` answers it ("… window id # 0x2e52d4b, 0x0"); null for none
export function activeWindowId(answer: string): string | null {
  const id = answer.match(/window id # (0x[0-9a-f]+)/i)?.[1]
  return id && Number(id) !== 0 ? id : null
}

// A text property, as `xprop -id <window> _NET_WM_NAME` answers it (`NAME(UTF8_STRING) = "…"`), in UTF-8: xprop escapes
// `"` and `\`, and under a locale that isn't UTF-8 writes each byte past ASCII as an octal escape (\342\227\220).
// null if the window has no such property
export function xpropText(answer: string): string | null {
  const quoted = answer.match(/^[^=\n]*= "(.*)"\s*$/m)?.[1]
  if (quoted === undefined) return null
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (const [, octal, escaped, plain] of quoted.matchAll(/\\([0-7]{1,3})|\\(.)|([^\\]+)/gsu)) {
    if (octal) bytes.push(parseInt(octal, 8) & 0xff)
    else bytes.push(...encoder.encode(escaped ?? plain ?? ''))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

// Whether a window's title shows a session: its viewer titles the window with Claude's title, a status mark and the
// session's name ("✳ name"), which terminals show as is or inside their own words ("Terminal - ✳ name", "✳ name –
// Konsole"). The whole name, then: after the start or a mark and a space, and before the end or a separator
export function titleShows(title: string, name: string): boolean {
  if (!name) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^\\p{L}\\p{N}\\s] )${escaped}(?:$| [-\u2013\u2014|:] )`, 'u').test(title)
}

// The terminal of the window in front, from its title: a window of the one session whose whole name the title shows (the
// longest name, when one holds another); null when it shows none, or two sessions share that name
export function frontShown(title: string, shown: Shown[]): string | null {
  const matches = shown.filter(s => titleShows(title, s.title))
  const longest = Math.max(0, ...matches.map(s => s.title.length))
  const best = matches.filter(s => s.title.length === longest)
  return best.length > 0 && new Set(best.map(s => s.id)).size === 1 ? (best[0]?.tty ?? null) : null
}

export const linux: Platform = {
  name: 'linux',

  async windowShowingMe(_run, v, me) {
    // A background session's own process has a terminal too (the background service's internal one, not a window):
    // only a regular session's own terminal counts
    return pickWindowShowingMe(v, me.shortId, !me.background && me.pid ? me.pid : undefined)
  },

  // The window in front, by its title, with xprop (X11). Without X11 or xprop (Wayland, no display) it answers none,
  // and a session counts as seen only when you type in it
  frontKnown: true,
  async windowInFront(run, shown) {
    if (shown.length === 0) return null
    const root = await run(['xprop', '-root', '_NET_ACTIVE_WINDOW'], { timeoutMs: 3000 })
    const id = root.exitCode === 0 ? activeWindowId(root.stdout) : null
    if (!id) return null
    const name = await run(['xprop', '-id', id, '_NET_WM_NAME'], { timeoutMs: 3000 })
    const title = name.exitCode === 0 ? xpropText(name.stdout) : null
    return title ? frontShown(title, shown) : null
  },
  async userPresent() {
    return true
  },

  async readWindow() {
    return ''
  },

  // By title (the launcher titles each window with its session's name), with wmctrl, else xdotool; X11 only. The whole
  // title, never a part of it: a session named "api" mustn't bring up a browser whose title holds the word
  async bringWindow(run, _tty, title) {
    if ((await run(['wmctrl', '-F', '-a', title])).exitCode === 0) return true
    return (await run(['xdotool', 'search', '--name', exactTitlePattern(title), 'windowactivate'])).exitCode === 0
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

  clientCommand,

  async processProgram(run, pid) {
    const r = await run(['/bin/sh', '-c', 'printf "n%s" "$(readlink "/proc/$1/exe")"', 'sh', pid])
    if (r.exitCode !== 0) return ''
    if (!/\/ld-linux[^/]*$/.test(r.stdout)) return r.stdout
    // Run through a loader: the program is on its command line
    const program = programFromCmdline((await run(['cat', `/proc/${pid}/cmdline`])).stdout)
    return program ? `n${program}` : r.stdout
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

  // /usr/bin/python3 is the usual one here: no stub asks for anything first
  async pythonUsable() {
    return true
  },

  fileWatch: 'inotify',

  text: {
    switchNeedsWindow: 'To switch, open this session with ccc (the launcher lets the panel switch that window)',
    agentsNeedsWindow: 'To open the agent view, open this session with ccc (the launcher lets the panel switch that window)',
    regularUnreachable: title => `“${title}” runs in its own window, which this panel can't bring forward here: switch to it there`,
    cantOpen: title => `Couldn't open a window for “${title}”: open a terminal and run ccc there`,
    cantOpenAgents: "Couldn't open the agent view here: open a terminal and run ccc",
    cantBring: 'windows can only be brought forward on X11 with wmctrl or xdotool',
  },
}
