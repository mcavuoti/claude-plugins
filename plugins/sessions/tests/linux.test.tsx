import { expect, test } from 'claude-code/testing'

import { activeWindowId, clientCommand, exactTitlePattern, frontShown, linux, pickWindowShowingMe, programFromCmdline, terminalCommand, titleShows, xpropText } from '../hooks/platform/linux'
import { parseWindows } from '../hooks/state'

// The Linux platform's pure parts. They run on any system (the CI runs them on macOS and Linux)

// One window of each kind, as `ps -A -o pid= -o tty= -o command=` lists them on macOS and on Linux
const PS_MAC = [
  '  101 ttys001  bash /Users/x/.claude/plugins/cache/m/sessions/0.10.0/hooks/visor.sh attach aaaaaaaa',
  '  102 ttys001  claude attach aaaaaaaa',
  '  103 ttys002  claude agents --cwd .',
  '  104 ttys002  bash /Users/x/.claude/plugins/cache/m/sessions/0.10.0/hooks/visor.sh agents',
  '  105 ??       /Users/x/.local/share/claude/stable/claude --bg-spare /tmp/x.sock',
  '  106 ttys003  claude',
].join('\n')
const PS_LINUX = [
  ' 2001 pts/0    bash /home/x/.claude/plugins/cache/m/sessions/0.10.0/hooks/visor.sh attach aaaaaaaa',
  ' 2002 pts/0    claude attach aaaaaaaa',
  ' 2003 ?        /home/x/.local/share/claude/versions/2.1.314 --bg-spare /tmp/x.sock',
  ' 2004 pts/1    claude attach aaaaaaaa',
  ' 2005 pts/2    claude attach bbbbbbbb',
].join('\n')

test('window showing me, without asking the desktop: a viewer with a launcher first, then the newest', () => {
  // Two viewers of aaaaaaaa: the one with the launcher wins even though the other is newer
  expect(pickWindowShowingMe(parseWindows(PS_LINUX), 'aaaaaaaa')).toBe('/dev/pts/0')
  // No launcher anywhere: the newest viewer
  const bare = parseWindows(' 10 pts/4 claude attach cccccccc\n 12 pts/5 claude attach cccccccc')
  expect(pickWindowShowingMe(bare, 'cccccccc')).toBe('/dev/pts/5')
  // A regular session: its own terminal
  expect(pickWindowShowingMe(parseWindows(PS_MAC), 'zzzzzzzz', 106)).toBe('/dev/ttys003')
  // Shown nowhere: the only agent view with a launcher (it may be inside it)
  expect(pickWindowShowingMe(parseWindows(PS_MAC), 'zzzzzzzz')).toBe('/dev/ttys002')
  expect(pickWindowShowingMe(parseWindows(PS_LINUX), 'zzzzzzzz')).toBe(null)
})

test("bringing a window forward by its title: the whole title, its regular expression's characters escaped", () => {
  expect(exactTitlePattern('api')).toBe('^api$')
  const tricky = 'notes (v2) [draft].*+?{1}|^$\\'
  const pattern = exactTitlePattern(tricky)
  expect(new RegExp(pattern).test(tricky)).toBe(true)
  expect(new RegExp(pattern).test(`${tricky} - Browser`)).toBe(false)
  expect(new RegExp(exactTitlePattern('api')).test('api docs - Browser')).toBe(false)
})

test('new window: each terminal emulator takes the command its own way', () => {
  expect(terminalCommand('gnome-terminal', 'echo hi')).toEqual(['gnome-terminal', '--', 'bash', '-c', 'echo hi'])
  expect(terminalCommand('/usr/bin/wezterm', 'echo hi')).toEqual(['/usr/bin/wezterm', 'start', '--', 'bash', '-c', 'echo hi'])
  expect(terminalCommand('kitty', 'echo hi')).toEqual(['kitty', 'bash', '-c', 'echo hi'])
  expect(terminalCommand('xfce4-terminal', 'echo hi')).toEqual(['xfce4-terminal', '-x', 'bash', '-c', 'echo hi'])
  expect(terminalCommand('x-terminal-emulator', 'echo hi')).toEqual(['x-terminal-emulator', '-e', 'bash', '-c', 'echo hi'])
  expect(terminalCommand('some-unknown-term', 'echo hi')).toBe(null)
})

// A host whose glibc is too old runs claude through a loader, so ps lists the viewer as the loader's command line
const LD = '/home/x/.local/lib/glibc-compat/ld-linux-x86-64.so.2 --library-path /home/x/.local/lib/glibc-compat /home/x/.local/share/claude/versions/2.1.317'

test('a claude run through the glibc loader is read as claude: viewers and agent views are found, other programs left alone', () => {
  expect(clientCommand(`${LD} attach aaaaaaaa`)).toBe('claude attach aaaaaaaa')
  expect(clientCommand(`${LD} agents --cwd .`)).toBe('claude agents --cwd .')
  expect(clientCommand(LD)).toBe('claude')
  expect(clientCommand('claude attach aaaaaaaa')).toBe('claude attach aaaaaaaa')
  expect(clientCommand('/lib64/ld-linux-x86-64.so.2 /usr/bin/ls -l')).toBe('/lib64/ld-linux-x86-64.so.2 /usr/bin/ls -l')
  const ps = [` 301 pts/3    bash /x/hooks/visor.sh start`, ` 302 pts/3    ${LD} attach aaaaaaaa`, ` 303 pts/4    ${LD} agents --cwd .`].join('\n')
  const v = parseWindows(ps, clientCommand)
  expect(v.byId).toEqual({ aaaaaaaa: ['/dev/pts/3'] })
  expect(v.clients).toEqual({ '/dev/pts/3': '302', '/dev/pts/4': '303' })
  expect(v.agentsViews).toEqual([{ pid: '303', tty: '/dev/pts/4' }])
  expect(pickWindowShowingMe(v, 'aaaaaaaa')).toBe('/dev/pts/3')
})

test("a loader's process runs the program named on its command line, not the loader", () => {
  const cmdline = ['/home/x/.local/lib/glibc-compat/ld-linux-x86-64.so.2', '--library-path', '/home/x/.local/lib/glibc-compat', '/home/x/.local/share/claude/versions/2.1.317', 'attach', 'aaaaaaaa'].join('\0')
  expect(programFromCmdline(cmdline)).toBe('/home/x/.local/share/claude/versions/2.1.317')
  expect(programFromCmdline('claude\0attach\0aaaaaaaa')).toBe('')
})

// What xprop answers about the window in front (X11): its id on the root window, then its title. Under a C locale (no
// UTF-8 one on some hosts) xprop writes each byte past ASCII as an octal escape
test('the window in front, from xprop: its id, and its title in UTF-8 whatever the locale', () => {
  expect(activeWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x2e52d4b, 0x0\n')).toBe('0x2e52d4b')
  expect(activeWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x2e52d4b\n')).toBe('0x2e52d4b')
  expect(activeWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0\n')).toBe(null)
  expect(activeWindowId('_NET_ACTIVE_WINDOW:  no such atom on any window.\n')).toBe(null)
  expect(xpropText('_NET_WM_NAME(UTF8_STRING) = "Terminal - \\342\\227\\220 Alpha Main"\n')).toBe('Terminal - \u25d0 Alpha Main')
  expect(xpropText('_NET_WM_NAME(UTF8_STRING) = "Terminal - \u25d0 Alpha Main"\n')).toBe('Terminal - \u25d0 Alpha Main')
  expect(xpropText('_NET_WM_NAME(UTF8_STRING) = "say \\"hi\\" \\\\ bye"\n')).toBe('say "hi" \\ bye')
  expect(xpropText('_NET_WM_NAME:  not found.\n')).toBe(null)
})

// How terminals title a window whose tab shows a session: Claude's title (a status mark, then the session's name), as is
// or inside the terminal's own words
test("a window title shows a session when it holds the session's whole name, after Claude's status mark", () => {
  expect(titleShows('Terminal - \u25d0 Alpha Main', 'Alpha Main')).toBe(true)
  expect(titleShows('Terminal - Alpha Main', 'Alpha Main')).toBe(true)
  expect(titleShows('\u2733 Alpha Main', 'Alpha Main')).toBe(true)
  expect(titleShows('Alpha Main', 'Alpha Main')).toBe(true)
  expect(titleShows('\u2733 Alpha Main \u2013 Konsole', 'Alpha Main')).toBe(true)
  expect(titleShows('Terminal - x@host:/repos/x', 'x')).toBe(false)
  expect(titleShows('\u2733 api v2', 'api')).toBe(false)
  expect(titleShows('\u2733 api v2', 'v2')).toBe(false)
  expect(titleShows('\u2733 notes (v2).*', 'notes (v2).*')).toBe(true)
  expect(titleShows('Terminal - \u25d0 Alpha Main', '')).toBe(false)
})

test('the window in front: the terminal of the one session its title shows, none when two sessions could be it', () => {
  const shown = [
    { tty: '/dev/pts/1', id: 'aaaaaaaa', title: 'api' },
    { tty: '/dev/pts/2', id: 'bbbbbbbb', title: 'api v2' },
    { tty: '/dev/pts/3', id: 'bbbbbbbb', title: 'api v2' },
  ]
  expect(frontShown('Terminal - \u2733 api', shown)).toBe('/dev/pts/1')
  expect(['/dev/pts/2', '/dev/pts/3']).toContain(frontShown('Terminal - \u2733 api v2', shown))
  expect(frontShown('Terminal - x@host:~', shown)).toBe(null)
  expect(frontShown('Terminal - \u2733 api', [...shown, { tty: '/dev/pts/4', id: 'cccccccc', title: 'api' }])).toBe(null)
})

test('linux.windowInFront asks xprop only with a viewer on screen, and answers none without X11', async () => {
  const shown = [{ tty: '/dev/pts/1', id: 'aaaaaaaa', title: 'alpha' }]
  const runs: string[][] = []
  const x11 = async (argv: string[]) => {
    runs.push(argv)
    if (argv.join(' ') === 'xprop -root _NET_ACTIVE_WINDOW') return { exitCode: 0, stdout: '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1, 0x0\n', stderr: '' }
    if (argv.join(' ') === 'xprop -id 0x1 _NET_WM_NAME') return { exitCode: 0, stdout: '_NET_WM_NAME(UTF8_STRING) = "Terminal - \\342\\234\\263 alpha"\n', stderr: '' }
    return { exitCode: 1, stdout: '', stderr: '' }
  }
  expect(linux.frontKnown).toBe(true)
  expect(await linux.windowInFront(x11, shown)).toBe('/dev/pts/1')
  expect(await linux.windowInFront(x11, [])).toBe(null)
  expect(runs).toHaveLength(2)
  const none = async () => ({ exitCode: 1, stdout: '', stderr: 'xprop: unable to open display' })
  expect(await linux.windowInFront(none, shown)).toBe(null)
})
