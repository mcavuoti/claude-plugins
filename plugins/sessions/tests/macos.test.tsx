import { expect, test } from 'claude-code/testing'

import { idleSeconds, macos, parseAsn, parseBundle, parseFront, screenLocked, TERMINAL, TERMINAL_TIMEOUT_MS } from '../hooks/platform/macos'

// The macOS platform's pure parts: reading what AppleScript and ioreg answer. They run on any system (the CI runs them on
// macOS and Linux); driving Terminal.app itself can only be tried on a Mac

test('front window: only when Terminal is the frontmost app', () => {
  expect(parseFront('true /dev/ttys004')).toBe('/dev/ttys004')
  expect(parseFront('false /dev/ttys004\n')).toBe(null)
  expect(parseFront('no')).toBe(null)
  expect(parseFront('')).toBe(null)
})

test("Terminal's script: a Terminal that isn't running is never started, and Stop closes a window only when that tab is its only one", () => {
  const lines = TERMINAL.split('\n').map(l => l.trim())
  const guard = lines.indexOf('if application "Terminal" is not running then return ""')
  expect(guard).toBeGreaterThan(0)
  expect(guard).toBeLessThan(lines.indexOf('tell application "Terminal"'))
  const close = lines.slice(lines.indexOf('if modo is "cerrar" then'))
  expect(close.slice(0, 5)).toEqual(['if modo is "cerrar" then', 'if (count of tabs of w) > 1 then return "solapas"', 'if busy of tab i of w then return "ocupada"', 'close w', 'return "ok"'])
})

test('presence: locked screen and seconds since the last input, from ioreg', () => {
  expect(screenLocked('+-o Root  <class IORegistryEntry>\n    "IOConsoleLocked" = Yes')).toBe(true)
  expect(screenLocked('    "IOConsoleLocked" = No')).toBe(false)
  expect(idleSeconds('    | |   "HIDIdleTime" = 125000000000')).toBe(125)
  expect(idleSeconds('nothing here')).toBe(null)
})

test('the app in front, from lsappinfo: the ASN, then its bundle id', () => {
  expect(parseAsn('ASN:0x0-0xe00e:\n')).toBe('ASN:0x0-0xe00e:')
  expect(parseAsn('')).toBe(null)
  expect(parseBundle('[ NULL ]  ASN:0x0-0x2002: (in front) \n    bundleID="com.apple.loginwindow"\n    bundle path=[ NULL ] ')).toBe('com.apple.loginwindow')
  expect(parseBundle('    bundleID=[ NULL ] ')).toBe(null)
})

// A run that answers from a table by the command's first two words, and keeps what ran
function fake(answers: Record<string, string | null>) {
  const ran: string[] = []
  const run = async (argv: string[]) => {
    const key = `${argv[0]} ${argv[0] === 'osascript' ? argv[2] : argv[1]}`
    ran.push(key)
    const out = answers[key]
    return out === null || out === undefined ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: out, stderr: '' }
  }
  return { run, ran }
}
const NO_WINDOWS = { byId: {}, byPid: {}, agentsViews: [], clients: {}, launchers: {} }

test("windowInFront: no Apple Event to Terminal unless it's the app in front and someone is at the computer", async () => {
  const other = fake({ 'lsappinfo front': 'ASN:0x0-0x7a1:', 'lsappinfo info': 'bundleID="com.example.Editor"' })
  expect(await macos.windowInFront(other.run, [])).toBe(null)
  expect(other.ran).toEqual(['lsappinfo front', 'lsappinfo info'])
  // The same app again: its bundle is known, one lsappinfo
  other.ran.length = 0
  expect(await macos.windowInFront(other.run, [])).toBe(null)
  expect(other.ran).toEqual(['lsappinfo front'])
  const away = fake({ 'lsappinfo front': 'ASN:0x0-0x7a2:', 'lsappinfo info': 'bundleID="com.apple.Terminal"', 'ioreg -c': '"HIDIdleTime" = 300000000000' })
  expect(await macos.windowInFront(away.run, [])).toBe(null)
  expect(away.ran).toEqual(['lsappinfo front', 'lsappinfo info', 'ioreg -c'])
  const here = fake({ 'lsappinfo front': 'ASN:0x0-0x7a2:', 'ioreg -c': '"HIDIdleTime" = 1000000000', 'osascript frente': 'true /dev/ttys004' })
  expect(await macos.windowInFront(here.run, [])).toBe('/dev/ttys004')
  expect(here.ran).toEqual(['lsappinfo front', 'ioreg -c', 'osascript frente'])
  // lsappinfo can't tell: the lock is asked too
  const locked = fake({ 'lsappinfo front': null, 'ioreg -n': '"IOConsoleLocked" = Yes', 'osascript frente': 'true /dev/ttys004' })
  expect(await macos.windowInFront(locked.run, [])).toBe(null)
  expect(locked.ran).toEqual(['lsappinfo front', 'ioreg -n'])
})

test("Terminal's script reads no tab's text; a question is cut off within seconds, which window is in front within 3", async () => {
  expect(TERMINAL).not.toContain('contents')
  expect(TERMINAL).not.toContain('history')
  expect(TERMINAL_TIMEOUT_MS.frente).toBe(3000)
  // An agent view in front is taken as showing the session whose panel was just used: nothing reads it
  const view = fake({ 'osascript frente': 'true /dev/ttys004' })
  expect(await macos.windowShowingMe(view.run, { ...NO_WINDOWS, agentsViews: [{ pid: '1', tty: '/dev/ttys004' }] }, { shortId: 'aaaaaaaa', background: true })).toBe('/dev/ttys004')
  expect(await macos.windowShowingMe(view.run, NO_WINDOWS, { shortId: 'aaaaaaaa', background: true })).toBe(null)
  expect(view.ran).toEqual(['osascript frente', 'osascript frente'])
})
