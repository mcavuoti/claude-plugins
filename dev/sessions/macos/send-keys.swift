// Real macOS key events posted straight to one process (for testing in real Terminal windows).
// Build: swiftc send-keys.swift -o send-keys   (needs Accessibility permission for the terminal running it)
// Usage: send-keys <pid> key <keycode> [ctrl]   |   send-keys <pid> text "abc"
import ApplicationServices
import Foundation

let args = CommandLine.arguments
let pid = pid_t(Int32(args[1])!)
let source = CGEventSource(stateID: .hidSystemState)
func post(_ event: CGEvent) { event.postToPid(pid); usleep(40000) }
switch args[2] {
case "key":
  let code = CGKeyCode(Int(args[3])!)
  let flags: CGEventFlags = args.count > 4 && args[4] == "ctrl" ? .maskControl : []
  let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)!; down.flags = flags; post(down)
  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)!; up.flags = flags; post(up)
case "text":
  for scalar in args[3].unicodeScalars {
    var chars = [UniChar(scalar.value)]
    let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)!
    down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars); post(down)
    let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)!
    up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars); post(up)
  }
default: break
}
