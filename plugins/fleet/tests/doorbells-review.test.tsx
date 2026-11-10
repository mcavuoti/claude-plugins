import { expect, test } from 'claude-code/testing'

import { DEC, FAKE_SESSIONS, FLEET, REF, ROOT, SID, decide, fleet, row, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// Live updates (0.11.0), from a review of the branch: each test failed before its fix (an overrule after an empty
// listing, an answer already on disk at a start, live coming back after watcher misses, the status line where
// SessionStart never reaches fleet); the controls passed

const MIN = 60000

async function tick(w: World, ms = 2100) {
  for (let left = ms; left > 0; left -= MIN) {
    await w.clock.advance(Math.min(left, MIN))
    await w.clock.settle()
  }
}

async function changed($: any, path: string, event = 'change') {
  await $.classic.FileChanged({ file_path: path, event } as any)
}

async function goLive($: any, w: World) {
  const r: any = await $.classic.SessionStart({ source: 'startup' } as any)
  await tick(w, 1500)
  await changed($, `${FLEET}/bell/probe`)
  await w.clock.settle()
  return r
}

function asker($: any, on: any) {
  const w = world(on)
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  return w
}

const answer = (id: string, q: number, label: string, at: number) => JSON.stringify({ format: 1, id, q, label, origin: 'composer', session: 'TEST P', at })

const notice = (id: string, at: number) =>
  JSON.stringify({
    format: 1,
    id,
    at,
    asker: { ref: REF, sessionId: SID, name: 'TEST A', root: ROOT },
    questions: [{ question: 'Which database for the cache?', options: [{ label: 'SQLite' }, { label: 'Redis' }] }],
    judged: ['SQLite'],
    answers: [{ label: 'Redis', origin: 'composer', session: 'TEST P', at }],
    why: 'the queue runs it',
    area: 'storage',
  })

// F1. The README/status: "questions, answers and overrules reach this session by their files, in under a second".
// An overrule the person writes from his own session, 10 s after the asker's last delivery pass found overrules/ empty
test('F1 live: an overrule from another session reaches its asker on its event (claimed: under a second)', WITH_SESSIONS, async ($, on) => {
  const w = asker($, on)
  await startSession($, w)
  await goLive($, w)
  await decide($)
  await tick(w, 3000)
  // The person answers D-1 from his session: delivered on its event (works)
  w.touch(`${DEC}/answers/D-1.1.json`, answer('D-1', 1, 'SQLite', w.clock.now()))
  w.touch(`${DEC}/answers/D-1.2.json`, answer('D-1', 2, 'Never', w.clock.now()))
  await changed($, `${DEC}/answers/D-1.2.json`, 'add')
  await tick(w, 1000)
  expect(w.submits.length).toBe(1)
  await $.turn.start({ text: `The fleet plugin sent a message:\n${w.submits[0]}`, turnId: 't-1' })
  await w.clock.settle()
  await $.turn.complete({ turnId: 't-1', reason: 'answer', answer: 'ok' } as any)
  await w.clock.settle()
  await tick(w, 10000)
  // 10 s later he overrules a judge's answer to this session (a notice in overrules/, written by his session)
  w.touch(`${DEC}/overrules/D-9.json`, notice('D-9', w.clock.now()))
  await changed($, `${DEC}/overrules/D-9.json`, 'add')
  await tick(w, 3000)
  expect(w.submits.some(s => s.includes('[D-9] The person overruled'))).toBe(true)
})

// F1 control: the same overrule, with the asker's overrules/ listing not cached (no delivery pass in the last 30 s)
test('F1 control: an overrule whose folder was not listed empty in the last 30 s goes on its event', WITH_SESSIONS, async ($, on) => {
  const w = asker($, on)
  await startSession($, w)
  await goLive($, w)
  // Past the cache, and between safety passes
  await tick(w, 45000)
  w.touch(`${DEC}/overrules/D-9.json`, notice('D-9', w.clock.now()))
  await changed($, `${DEC}/overrules/D-9.json`, 'add')
  await tick(w, 3000)
  expect(w.submits.some(s => s.includes('[D-9] The person overruled'))).toBe(true)
})

// F1 measured: how long the overrule of F1 waits (on the branch it goes at the next safety pass)
test('F1 measured: the overrule of F1 goes within 3 s of its event', WITH_SESSIONS, async ($, on) => {
  const w = asker($, on)
  await startSession($, w)
  await goLive($, w)
  await decide($)
  await tick(w, 3000)
  w.touch(`${DEC}/answers/D-1.1.json`, answer('D-1', 1, 'SQLite', w.clock.now()))
  w.touch(`${DEC}/answers/D-1.2.json`, answer('D-1', 2, 'Never', w.clock.now()))
  await changed($, `${DEC}/answers/D-1.2.json`, 'add')
  await tick(w, 1000)
  await $.turn.start({ text: `The fleet plugin sent a message:\n${w.submits[0]}`, turnId: 't-1' })
  await w.clock.settle()
  await $.turn.complete({ turnId: 't-1', reason: 'answer', answer: 'ok' } as any)
  await w.clock.settle()
  await tick(w, 10000)
  const at = w.clock.now()
  w.touch(`${DEC}/overrules/D-9.json`, notice('D-9', at))
  await changed($, `${DEC}/overrules/D-9.json`, 'add')
  let waited = -1
  for (let i = 0; i < 40; i++) {
    await tick(w, 2000)
    if (w.submits.some(s => s.includes('[D-9] The person overruled'))) {
      waited = w.clock.now() - at
      break
    }
  }
  expect(waited).toBeGreaterThan(-1)
  expect(waited).toBeLessThan(3000)
})

// F2. A retired asker woken for its answer (claude respawn: a new process, idle, no prompt) finds the answer already in
// answers/: no event will announce it. The README: "an answer to a retired asker wakes it at its event"
const PAST = Date.UTC(2026, 10, 2, 11, 0, 0)
const waiting = {
  [`${DEC}/queue/D-3.json`]: JSON.stringify({ format: 1, fleet: '0.11.0', id: 'D-3', at: PAST, asker: { ref: REF, sessionId: SID, name: 'TEST A', root: ROOT }, questions: [{ question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'w' }] }),
  [`${DEC}/answers/D-3.1.json`]: JSON.stringify({ format: 1, id: 'D-3', q: 1, label: 'Yes', origin: 'composer', session: 'TEST P', at: PAST + 60000 }),
}
function woken($: any, on: any) {
  const w = world(on, { files: waiting })
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  return w
}
async function firstDelivery(w: World, from: number, upTo = 80000): Promise<number> {
  for (let t = 0; t < upTo; t += 1000) {
    if (w.submits.some(s => s.includes('[D-3] The person answered'))) return w.clock.now() - from
    await tick(w, 1000)
  }
  return -1
}

test('F2 a woken asker whose answer is already on disk gets it within a few seconds of starting (it did on 0.10.1)', WITH_SESSIONS, async ($, on) => {
  const w = woken($, on)
  const t0 = w.clock.now()
  // The process starts: its timers, then Claude's SessionStart (a respawn resumes it), the probe a second later
  await startSession($, w)
  await $.classic.SessionStart({ source: 'resume' } as any)
  await tick(w, 1500)
  await changed($, `${FLEET}/bell/probe`)
  await w.clock.settle()
  const waited = await firstDelivery(w, t0)
  expect(waited).toBeGreaterThan(-1)
  expect(waited).toBeLessThan(5000)
})

test('F2 control: the same start with the probe not (yet) back delivers at the 2 s tick', WITH_SESSIONS, async ($, on) => {
  const w = woken($, on)
  const t0 = w.clock.now()
  await startSession($, w)
  await $.classic.SessionStart({ source: 'resume' } as any)
  const waited = await firstDelivery(w, t0)
  expect(waited).toBeGreaterThan(-1)
  expect(waited).toBeLessThan(5000)
})

// F3. The rule/README: two watcher misses on events/latest turn live updates off (the timers back at their own pace).
// Then any bell (here the sweeper's bell/work, rung by another session) turns them on again
test('F3 live updates turned off by two watcher misses stay off until a new SessionStart proves the watch', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'] })
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  sessionsSay(w, { rows: {} })
  // Another session holds the lease: this one doesn't sweep
  const other = () => w.touch(`${FLEET}/state/sweeper.json`, JSON.stringify({ format: 1, sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', ref: 'bbbbbbbb', name: 'Owner B', at: w.clock.now(), remote: null }))
  other()
  await startSession($, w)
  await goLive($, w)
  await tick(w, 30000)
  expect(await fleet($, 'status')).toContain('live updates: on')
  // Two landings of another session whose events the engine never brings (live and not sweeping, the world's pass is
  // once a minute: found within two passes of the second)
  for (let i = 0; i < 2; i++) {
    other()
    w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: `x-${i}` }))
    await tick(w, 30000)
    other()
    await tick(w, 35000)
  }
  other()
  await tick(w, 60000)
  expect(w.logs.join('\n')).toContain("the engine's watcher didn't bring two landings")
  const mid = await fleet($, 'status')
  expect(mid).toContain('live updates off')
  // The sweeper (another session) rewrites work.json and rings: the event comes
  other()
  w.touch(`${FLEET}/bell/work`, JSON.stringify({ format: 1, by: 'bbbbbbbb', at: w.clock.now() }))
  await changed($, `${FLEET}/bell/work`)
  await tick(w, 1000)
  expect(await fleet($, 'status')).toContain('live updates off')
})

// F4 (text). A managed plugin that sends classic.SessionStart on past fleet: /fleet status says "u or /clear turns
// them on", but neither can (no SessionStart ever reaches fleet in this session)
const SKIPPER = {
  name: 'skipper',
  tier: 'prepend' as const,
  register(on: any) {
    on('classic.SessionStart', ($: any, e: any, next: any) => next.to(e, 'builtin'))
  },
}
test('F4 with SessionStart skipped by a managed plugin, status does not promise that /clear turns live updates on', { plugins: [SKIPPER, FAKE_SESSIONS], timeoutMs: 30000 }, async ($, on) => {
  const w = asker($, on)
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup' } as any)
  await tick(w, 3000)
  await $.session.end({ reason: 'clear', sessionId: SID } as any)
  await $.classic.SessionStart({ source: 'clear' } as any)
  await tick(w, 3000)
  await changed($, `${FLEET}/bell/probe`)
  await tick(w, 1000)
  const st = await fleet($, 'status')
  // Still off after the /clear (right: nothing reached fleet), and the line says /clear turns them on without saying
  // that SessionStart never reached fleet here (the instance's classic line says it only with a roster)
  const line = st.split('\n').find(l => l.startsWith('live updates')) ?? ''
  expect(line).toContain('live updates off')
  expect(line).toContain('SessionStart')
})

// F1 swept: an idle live asker, an overrule from another session at each offset of a minute (no other activity)
for (let offset = 0; offset < 60000; offset += 7500) {
  test(`F1 sweep: overrule at +${offset / 1000} s in steady state`, WITH_SESSIONS, async ($, on) => {
    const w = asker($, on)
    await startSession($, w)
    await goLive($, w)
    await tick(w, 3 * MIN + offset)
    const at = w.clock.now()
    w.touch(`${DEC}/overrules/D-9.json`, notice('D-9', at))
    await changed($, `${DEC}/overrules/D-9.json`, 'add')
    let waited = -1
    for (let i = 0; i < 70; i++) {
      await tick(w, 1000)
      if (w.submits.some(s => s.includes('[D-9] The person overruled'))) {
        waited = w.clock.now() - at
        break
      }
    }
    expect(waited).toBeGreaterThan(-1)
    expect(waited).toBeLessThan(3000)
  })
}
