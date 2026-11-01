import { expect, test } from 'claude-code/testing'

import { pickWindowShowingMe, terminalCommand } from '../hooks/platform/linux'
import { parseWindows } from '../hooks/state'

// The Linux platform's pure parts. They run on any system (the CI runs them on macOS and Linux)

// One window of each kind, as `ps -A -o pid=,tty=,command=` lists them on macOS and on Linux
const PS_MAC = [
  '  101 ttys001  bash /Users/x/.claude/mods/sessions-bin/visor.sh attach aaaaaaaa',
  '  102 ttys001  claude attach aaaaaaaa',
  '  103 ttys002  claude agents --cwd .',
  '  104 ttys002  bash /Users/x/.claude/mods/sessions-bin/visor.sh agents',
  '  105 ??       /Users/x/.local/share/claude/stable/claude --bg-spare /tmp/x.sock',
  '  106 ttys003  claude',
].join('\n')
const PS_LINUX = [
  ' 2001 pts/0    bash /home/x/.claude/mods/sessions-bin/visor.sh attach aaaaaaaa',
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

test('new window: each terminal emulator takes the command its own way', () => {
  expect(terminalCommand('gnome-terminal', 'echo hi')).toEqual(['gnome-terminal', '--', 'bash', '-c', 'echo hi'])
  expect(terminalCommand('/usr/bin/wezterm', 'echo hi')).toEqual(['/usr/bin/wezterm', 'start', '--', 'bash', '-c', 'echo hi'])
  expect(terminalCommand('kitty', 'echo hi')).toEqual(['kitty', 'bash', '-c', 'echo hi'])
  expect(terminalCommand('xfce4-terminal', 'echo hi')).toEqual(['xfce4-terminal', '-x', 'bash', '-c', 'echo hi'])
  expect(terminalCommand('x-terminal-emulator', 'echo hi')).toEqual(['x-terminal-emulator', '-e', 'bash', '-c', 'echo hi'])
  expect(terminalCommand('some-unknown-term', 'echo hi')).toBe(null)
})
