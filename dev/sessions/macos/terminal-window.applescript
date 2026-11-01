-- Real Terminal.app windows for testing: open one running a command, read a window's text, close a window.
-- Usage: osascript terminal-window.applescript open <title> <command>   → prints the new tab's tty
--        osascript terminal-window.applescript read <tty>
--        osascript terminal-window.applescript close <tty>             (only if the tab isn't busy)
on run argv
  set mode to item 1 of argv
  tell application "Terminal"
    if mode is "open" then
      set t to do script (item 3 of argv)
      set custom title of t to (item 2 of argv)
      set title displays custom title of t to true
      set w to (first window whose selected tab is t)
      set bounds of w to {120, 80, 1880, 900}
      set index of w to 1
      activate
      return tty of t
    else if mode is "read" then
      repeat with wid in (id of every window as list)
        try
          set w to window id (contents of wid)
          if tty of selected tab of w is (item 2 of argv) then return contents of selected tab of w
        end try
      end repeat
    else if mode is "close" then
      repeat with wid in (id of every window as list)
        try
          set w to window id (contents of wid)
          if tty of selected tab of w is (item 2 of argv) and not (busy of selected tab of w) then close w
        end try
      end repeat
    end if
  end tell
end run
