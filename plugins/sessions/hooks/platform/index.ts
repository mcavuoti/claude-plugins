// Picks the platform when a session starts: macOS on a Mac, the Linux implementation anywhere else.
// SESSIONS_PORTABLE=1 (in a test session's --settings env) uses the Linux one on a Mac, to try it there.
import { linux } from './linux'
import { macos } from './macos'
import type { Platform, Run } from './types'

export type { Me, Platform, Run, Shown } from './types'
export { linux, macos }

export async function choosePlatform(run: Run): Promise<Platform> {
  const r = await run(['/bin/sh', '-c', 'printf "%s|%s" "$(uname -s)" "${SESSIONS_PORTABLE:-}"'])
  const [system, forced] = r.stdout.split('|')
  return forced === '1' || (system !== '' && system !== 'Darwin') ? linux : macos
}
