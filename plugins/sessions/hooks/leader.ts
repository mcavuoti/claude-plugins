// The work that is the same for every session of a data folder runs in one of them, the leader: the `claude agents`
// listing that sweeps the files of sessions that crashed and checks the direct read against Claude's own list, the
// token usage (usage.py), the Remote Control pins, reopening after a memory shortage and the prune. The others only
// read what it leaves (the files, the store) when a file event or their own pass says so.
//
// Who leads (electLeader): the session the leader file (<data>/leader.json: format, pid, sessionId, at) names, while it
// rewrites it every pass and runs; else the lowest pid among the sessions that can lead. A session can lead when
// Claude's registry has it running and its heartbeat (alive/<sessionId>, every 15 s) is fresh, of this format and from
// the same process.
// A leader that ended cleanly leaves the registry at once (its file is removed: about 0.15 s later every session
// knows); one that crashed keeps its registry file until a listing sweeps it, but its heartbeat goes stale within 45 s,
// and its record two passes after its last one: then the next one takes over, finds its process gone and lists, which
// sweeps the dead one's file. Two sessions leading for a moment (each read the other's state an instant late) do no
// harm: every duty is idempotent, under the same locks as before.
//
// The listing gives the panel one thing Claude's files don't: as it lists, Claude removes the registry file of a
// session whose process is gone (crashed, or killed), and until then that session's row stays as it last was. So the
// leader lists when it starts leading, when a registered process is gone, and every LIST_SAFETY_MS whatever it found;
// not once a pass. Whether one is gone, each pass: a session whose heartbeat is fresh and from its process runs
// (provenRunning: nothing is asked); for the rest (no mod, a mod that stopped, another data folder), one
// `ps -p <pids> -o pid= -o lstart=` says which run and when each started, which tells a process from another one that
// took its number since (processGone). A crashed session's row then goes within about two minutes (its heartbeat
// stale after 45 s, the leader's next pass, the listing, the sweep's file event) where it went within one; one with no
// heartbeat here, within a pass as before.

import { FORMAT, HEARTBEAT_FRESH_MS, keyLines, parseKeyLines, type Heartbeat } from './state'

// Every session's own pass (the safety pass: everything read again, whatever the file events said), and the leader's
export const PASS_MS = 60000
// A leader record this old is a leader that stopped working (two passes missed)
export const LEADER_STALE_MS = 2 * PASS_MS
// The leader's listing, when nothing asked for one sooner: what the check of the registered processes can't see (a
// file Claude keeps for itself whose process is gone, a difference between the direct read and Claude's own list)
export const LIST_SAFETY_MS = 10 * PASS_MS

export type LeaderRecord = { format: number; pid: number; sessionId: string; at: number }
export function leaderText(r: Omit<LeaderRecord, 'format'>): string {
  return keyLines({ format: FORMAT, pid: r.pid, sessionId: r.sessionId, at: r.at })
}
export function parseLeader(text: string | null): LeaderRecord | null {
  if (!text) return null
  const k = parseKeyLines(text)
  const pid = Number(k.pid)
  const at = Number(k.at)
  if (!k.format || !(pid > 0) || !(at > 0)) return null
  return { format: Number(k.format) || 0, pid, sessionId: k.sessionId ?? '', at }
}

export type Candidate = { pid: number; sessionId: string }
// me: this session; candidates: the sessions that can lead (this one counts whether listed or not); record: the leader
// file, if any. lead: this session leads now; takeover: it starts leading in place of the one the record names (which
// crashed, or stopped working): it lists at once; leader: who leads, as this session sees it
export function electLeader(me: Candidate, candidates: readonly Candidate[], record: LeaderRecord | null, now: number): { lead: boolean; takeover: boolean; leader: number } {
  const live = candidates.some(c => c.pid === me.pid) ? [...candidates] : [...candidates, me]
  const r = record && record.format === FORMAT ? record : null
  const fresh = !!r && now - r.at < LEADER_STALE_MS
  if (r && fresh && live.some(c => c.pid === r.pid)) return { lead: r.pid === me.pid, takeover: false, leader: r.pid }
  // The recorded leader is gone, or two passes late: the lowest pid of the rest (this session keeps leading after a
  // pass of its own came late, after a sleep)
  const pool = live.filter(c => c.pid === me.pid || !r || c.pid !== r.pid)
  const lowest = pool.reduce((a, c) => (c.pid < a.pid ? c : a), me)
  const lead = lowest.pid === me.pid
  return { lead, takeover: lead && !!r && r.pid !== me.pid, leader: lowest.pid }
}

// The pass's time in this session: every PASS_MS, from an offset of its own (0-10 s, from its id) so the sessions of a
// machine don't all read at once
export function passDelay(stagger: number): number {
  return PASS_MS + (stagger % 10000)
}

// A registered session whose heartbeat here is fresh and from that very process runs, with nothing asked
export function provenRunning(h: Heartbeat | null | undefined, pid: number, now: number): boolean {
  return !!h && h.pid === pid && now - h.at <= HEARTBEAT_FRESH_MS
}

// The command that says which of these processes run and when each started; and the environment it runs in, so the
// start reads as the registry's procStart does (UTC, English)
export function processStartsArgv(pids: readonly number[]): string[] {
  return ['ps', '-p', pids.join(','), '-o', 'pid=', '-o', 'lstart=']
}
export const PROCESS_STARTS_ENV: Record<string, string> = { TZ: 'UTC', LC_ALL: 'C' }

// Its answer: by pid, the start with single spaces ("Mon Nov 9 04:32:54 2026"). A process that isn't running has no line
export function parseProcessStarts(ps: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const line of ps.split('\n')) {
    const [pid, ...rest] = line.trim().split(/\s+/)
    if (pid && /^\d+$/.test(pid)) out.set(Number(pid), rest.join(' '))
  }
  return out
}

// Whether a registered session's process is gone: it isn't running, or another process runs under its number (it
// started at another moment than the registry recorded). The second only when both are whole start times of that
// shape: a registry or a ps that writes it another way says nothing against the process
const LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}$/
export function processGone(e: { pid: number; procStart?: string }, started: ReadonlyMap<number, string>): boolean {
  const at = started.get(e.pid)
  if (at === undefined) return true
  const recorded = (e.procStart ?? '').trim().split(/\s+/).join(' ')
  return LSTART.test(recorded) && LSTART.test(at) && recorded !== at
}
