---
paths:
  - "plugins/*/hooks/platform/**"
---

# Platform code: edit each file from its own system

The files in `hooks/platform/` hold what differs by operating system. `macos.ts` can only be run and tried on macOS, `linux.ts` only on Linux, and `types.ts` is the contract both implement.

- Before editing, check which system you're on (`uname -s`). Edit `macos.ts` only on macOS and `linux.ts` only on Linux.
- If a change to the contract (`types.ts`) forces you to touch the other system's file, make the smallest change that keeps it working, don't change its behavior otherwise, write `needs a check on <macOS|Linux>` in the commit message, and tell the user it has to be tried on that system.
- Shared code (`register.tsx`, `state.ts`) reaches the system only through `platform.*`. Don't add operating system checks (`uname`, `process.platform`, `osascript`, `/proc`…) to shared files: put them in a platform file, behind the contract.
- Put pure helpers (parsing command output, building command lines) in the platform file and test them in `tests/macos.test.tsx` or `tests/linux.test.tsx`: those tests run on both systems.
- Try changes for real on the system you're on, in test sessions (`dev/sessions/hidden-terminal.py`). On a Mac, test sessions with `SESSIONS_PORTABLE=1` in their `--settings` env exercise much of `linux.ts` (not wmctrl/xdotool, terminal emulators or `/proc`). Switching Terminal.app windows on macOS needs real windows: ask the user to try it.
- The GitHub check (validation, tests, script syntax, setup) runs on both systems on every push; it must pass. After window-related changes, the real Linux check is `dev/sessions/linux-checklist.md`.
