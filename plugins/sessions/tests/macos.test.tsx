import { expect, test } from 'claude-code/testing'

import { idleSeconds, parseFront, screenLocked, TERMINAL } from '../hooks/platform/macos'

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
