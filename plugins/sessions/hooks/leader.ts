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
// and its record two passes after its last one: then the next one takes over and lists at once, which sweeps the dead
// one's file. Two sessions leading for a moment (each read the other's state an instant late) do no harm: every duty is
// idempotent, under the same locks as before.

import { FORMAT, keyLines, parseKeyLines } from './state'

// Every session's own pass (the safety pass: everything read again, whatever the file events said), and the leader's
export const PASS_MS = 60000
// A leader record this old is a leader that stopped working (two passes missed)
export const LEADER_STALE_MS = 2 * PASS_MS

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
