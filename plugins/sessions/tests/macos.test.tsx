import { expect, test } from 'claude-code/testing'

import { idleSeconds, parseFront, screenLocked } from '../hooks/platform/macos'

// The macOS platform's pure parts: reading what AppleScript and ioreg answer. They run on any system (the CI runs them on
// macOS and Linux); driving Terminal.app itself can only be tried on a Mac

test('front window: only when Terminal is the frontmost app', () => {
  expect(parseFront('true /dev/ttys004')).toBe('/dev/ttys004')
  expect(parseFront('false /dev/ttys004\n')).toBe(null)
  expect(parseFront('no')).toBe(null)
  expect(parseFront('')).toBe(null)
})

test('presence: locked screen and seconds since the last input, from ioreg', () => {
  expect(screenLocked('+-o Root  <class IORegistryEntry>\n    "IOConsoleLocked" = Yes')).toBe(true)
  expect(screenLocked('    "IOConsoleLocked" = No')).toBe(false)
  expect(idleSeconds('    | |   "HIDIdleTime" = 125000000000')).toBe(125)
  expect(idleSeconds('nothing here')).toBe(null)
})
