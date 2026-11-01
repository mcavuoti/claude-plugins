// What each operating system provides so the shared panel (register.tsx) can work with windows, processes and memory.
// One implementation per system: macos.ts drives Terminal.app through AppleScript; linux.ts uses processes and the
// launcher only, which every terminal has. Each can only be tested on its own system, so edit macos.ts from a Mac and
// linux.ts from Linux; a change to this contract updates both in the same commit (see CONTRIBUTING.md at the repo root).
import type { Windows } from '../state'

// Runs a command; never rejects (a command that can't start counts as exit code 127)
export type Run = (
  argv: string[],
  init?: { stdin?: string; timeoutMs?: number; cwd?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

// This session, for finding its window: the first 8 characters of its id (what `claude attach` takes), its process,
// and whether it's a background session (whose process has the background service's internal terminal, not a window)
export type Me = { shortId: string; pid?: number; background: boolean }

export type Platform = {
  name: 'macos' | 'linux'
  // The window this session's panel was just used from (its terminal, "/dev/…"), or null
  windowShowingMe(run: Run, v: Windows, me: Me): Promise<string | null>
  // The window in front right now, for marking a session as seen; null where that can't be known
  windowInFront(run: Run): Promise<string | null>
  // Whether someone is at the computer (screen unlocked, recent input); true where that can't be known
  userPresent(run: Run): Promise<boolean>
  // A window's visible text, used to tell which session an agent view shows; '' where windows can't be read
  readWindow(run: Run, tty: string): Promise<string>
  // Brings a window forward: by its terminal, or by its title where only titles can be matched
  bringWindow(run: Run, tty: string, title: string): Promise<boolean>
  // When the window showing the target session can't be brought forward: show the target in the current window too
  // (true), or give up with a notice (false)
  showHereIfCantBring: boolean
  // Opens a new window running a shell command (sized like `front` where possible); false if it couldn't
  openWindow(run: Run, front: string, title: string, command: string): Promise<boolean>
  // Closes a window that isn't busy; a no-op where windows end by themselves (the launcher leaves a plain shell)
  closeWindow(run: Run, tty: string): Promise<void>
  // A process's program, as lines "n<path>" (lsof -Fn style; the shared code looks for .../claude/versions/X.Y.Z)
  processProgram(run: Run, pid: string): Promise<string>
  // A process's working folder ('' if unknown)
  processCwd(run: Run, pid: string): Promise<string>
  // Whether memory is normal, with the signal Claude's background service uses to close sessions; null if unknown
  memoryNormal(run: Run): Promise<boolean | null>
  // Notices whose advice depends on how windows work on this system
  text: {
    switchNeedsWindow: string
    agentsNeedsWindow: string
    regularUnreachable: (title: string) => string
    cantOpen: (title: string) => string
    cantOpenAgents: string
    // Why ccc couldn't bring a window forward (it opens the session in its own window instead)
    cantBring: string
  }
}
