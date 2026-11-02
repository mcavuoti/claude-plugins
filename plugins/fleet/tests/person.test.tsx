import { expect, test } from 'claude-code/testing'

import { hashText } from '../hooks/changes'
import { DEC, FLEET, HOME, ROOT, fleet, json, sessionsSay, startSession, under, world, type World, WITH_SESSIONS } from './world'

// The person channel from the mod's side: the sweeper sends what waits for him and the closed list of alerts through
// his channel, within its caps (a command he stamped gets the text on its standard input; a push goes through
// PushNotification); and the model's own PushNotification is refused in the project's background sessions

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

const queued = (id: string, at: number) => JSON.stringify({ format: 1, fleet: '0.5.0', id, at, asker: { ref: 'bbbbbbbb', sessionId: 'bbbbbbbb-1', name: 'Owner B', root: ROOT }, questions: [{ question: 'Which store?', options: [{ label: 'A' }, { label: 'B' }], recommended: 'A', why: 'simpler' }] })

function project(on: any, person: Record<string, unknown>, extra: Record<string, string> = {}) {
  return world(on, {
    background: false,
    worldPaths: ['notes/**'],
    files: {
      [`${FLEET}/roster.json`]: JSON.stringify({ rosterFormat: 1, roles: {}, instances: [], person }),
      [`${DEC}/queue/D-1.json`]: queued('D-1', NOW - 40 * 60000),
      [`${DEC}/queue/D-2.json`]: queued('D-2', NOW - 5 * 60000),
      ...extra,
    },
  })
}

test('a command channel: nothing until the person stamps it; then the alerts due, once each, on its standard input', WITH_SESSIONS, async ($, on) => {
  const w = project(on, { addresses: ['me@example.invalid'], channel: { kind: 'command', argv: ['bash', '.claude/fleet/alert.sh'] }, perDay: 2 }, { [`${FLEET}/alert.sh`]: '#!/bin/bash\ncat >> /tmp/x/alerts.txt\n' })
  const ran: { argv: string[]; cwd: string; stdin?: string }[] = []
  w.exec.value = (argv, cwd, stdin) => {
    if (argv[1] !== '.claude/fleet/alert.sh') return undefined
    ran.push({ argv, cwd, stdin })
    return { exitCode: 0 }
  }
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  for (let i = 0; i < 40; i++) await tick(w)
  expect(ran).toEqual([])
  const status = await fleet($, 'status')
  expect(status).toContain('person: me@example.invalid; channel command (bash .claude/fleet/alert.sh, the text on its standard input): not stamped, so nothing is sent: /fleet accept channel')
  expect(await fleet($, 'accept channel', { kind: 'plugin', name: 'other' })).toContain('Only the person stamps the command channel')
  expect(await fleet($, 'accept channel')).toContain('Stamped: bash .claude/fleet/alert.sh.')
  for (let i = 0; i < 31; i++) await tick(w)
  // D-1 has waited 40 min (past waitingMin, 30); D-2 not yet
  expect(ran.length).toBe(1)
  expect(ran[0]?.cwd).toBe(ROOT)
  expect(ran[0]?.stdin).toMatch(/^fleet · proj: 1 decision\(s\) have waited over 30m \(the oldest, D-1 from Owner B, 4\dm\) · \/fleet or \/fleet brief in any session of the project\n$/)
  expect(json(w, `${FLEET}/state/alerts.json`)).toMatchObject({ format: 1, day: '2026-11-02', count: 1, last: { answer: 'command: ran' } })
  // The next minutes: nothing new for D-1; D-2 waits its 30 min too, but decisions waiting long are one digest per six
  // hours (sessions pushes each asker of its own, from its ?n mark): nothing new yet
  for (let i = 0; i < 31; i++) await tick(w)
  expect(ran.length).toBe(1)
  for (let i = 0; i < 31 * 24; i++) await tick(w)
  expect(ran.length).toBe(1)
  expect(await fleet($, 'status')).toContain('alerts: 1 of 2 sent today')
  // The script is the person's: changed, it isn't run until he stamps it again
  w.touch(`${FLEET}/alert.sh`, '#!/bin/bash\ncurl -d @- https://example.invalid\n')
  expect(await fleet($, 'status')).toContain('not stamped, so nothing is sent')
})

test('a push channel: fleet’s own PushNotification from the sweeper passes; the model’s is refused in a background session', WITH_SESSIONS, async ($, on) => {
  const pushed: string[] = []
  on('tool.call', { tool: 'PushNotification' }, (_: any, e: any) => {
    pushed.push(e.message)
    return { result: { pushSent: true } } as any
  })
  const w = project(on, { channel: { kind: 'push' } })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  for (let i = 0; i < 40; i++) await tick(w)
  expect(pushed.length).toBe(1)
  expect(pushed[0]).toMatch(/^fleet · proj: 1 decision\(s\) have waited over 30m \(the oldest, D-1 from Owner B, 4\dm\) · \/fleet or \/fleet brief in any session of the project$/)
  expect(json(w, `${FLEET}/state/alerts.json`).last).toMatchObject({ answer: 'push: sent' })
  // In this (the person's own) session the model's own push isn't fleet's to refuse
  const r: any = await $.tool.call({ tool: 'PushNotification', message: 'hi', status: 'proactive' } as any)
  expect(r.deny).toBe(undefined)
})

test('a push that never left (no Remote Control): the alert stays due, the next try backs off, and status says why', WITH_SESSIONS, async ($, on) => {
  const pushed: string[] = []
  on('tool.call', { tool: 'PushNotification' }, (_: any, e: any) => {
    pushed.push(e.message)
    return { result: { pushSent: false, localSent: false, disabledReason: 'Remote Control is off' } } as any
  })
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${FLEET}/roster.json`]: JSON.stringify({ rosterFormat: 1, roles: {}, instances: [], person: { channel: { kind: 'push' } } }), [`${DEC}/queue/D-1.json`]: queued('D-1', NOW - 40 * 60000) } })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  for (let i = 0; i < 40; i++) await tick(w)
  expect(pushed.length).toBe(1)
  const a = json(w, `${FLEET}/state/alerts.json`)
  expect(a).toMatchObject({ count: 1, failures: 1, problem: "alerts aren't reaching you: the sweeper (aaaaaaaa) has no Remote Control", last: { answer: 'push: not sent (Remote Control is off)' } })
  expect(a.sent).toEqual({})
  const status = await fleet($, 'status')
  expect(status).toContain("  alerts aren't reaching you: the sweeper (aaaaaaaa) has no Remote Control")
  expect(status).toContain('sweeper: this session (no Remote Control: a push alert doesn’t reach your phone)')
  // Not every minute: 15 minutes later, then an hour
  for (let i = 0; i < 10; i++) await tick(w, 60000)
  expect(pushed.length).toBe(1)
  for (let i = 0; i < 6; i++) await tick(w, 60000)
  expect(pushed.length).toBe(2)
  expect(json(w, `${FLEET}/state/alerts.json`)).toMatchObject({ count: 2, failures: 2 })
  for (let i = 0; i < 30; i++) await tick(w, 60000)
  expect(pushed.length).toBe(2)
})

test('a session with Remote Control takes the sweeper over from one without it', WITH_SESSIONS, async ($, on) => {
  const other = { format: 1, sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', ref: 'bbbbbbbb', name: 'Owner B', at: NOW, remote: false }
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${FLEET}/state/sweeper.json`]: JSON.stringify(other) } })
  w.files.set(`${HOME}/.claude/jobs/aaaaaaaa/state.json`, JSON.stringify({ sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', state: 'idle', bridgeSessionId: 'session_x' }))
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  for (let i = 0; i < 3; i++) await tick(w)
  expect(json(w, `${FLEET}/state/sweeper.json`)).toMatchObject({ sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', remote: true })
  expect(w.logs.some(l => l.includes('sweeper: taking it over from Owner B (this session has Remote Control)'))).toBe(true)
  expect(await fleet($, 'status')).toContain('sweeper: this session (Remote Control: a push reaches your phone)')
})

test("the model's own PushNotification in a background session of the project is refused", WITH_SESSIONS, async ($, on) => {
  const pushed: string[] = []
  on('tool.call', { tool: 'PushNotification' }, (_: any, e: any) => {
    pushed.push(e.message)
    return { result: { pushSent: true } } as any
  })
  const w = world(on, { worldPaths: ['notes/**'] })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  const r: any = await $.tool.call({ tool: 'PushNotification', message: 'look at me', status: 'proactive' } as any)
  expect(r.deny).toContain('in this project only fleet notifies the person')
  expect(pushed).toEqual([])
  expect(w.logs.some(l => l.includes("refused: the model's PushNotification"))).toBe(true)
})

test('an MCP channel sends to the person’s own address only; one naming anyone else sends nothing', WITH_SESSIONS, async ($, on) => {
  const calls: any[] = []
  on('mcp.call', (_: any, e: any) => {
    calls.push(e)
    return { value: { content: [{ type: 'text', text: 'queued' }], isError: false } }
  })
  const w = project(on, { addresses: ['me@example.invalid'], channel: { kind: 'mcp', server: 'mailbox', tool: 'send_message', to: 'me@example.invalid', subjectField: 'subject' } })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  for (let i = 0; i < 40; i++) await tick(w)
  expect(calls.length).toBe(1)
  expect(calls[0]).toMatchObject({ server: 'mailbox', tool: 'send_message', args: { to: 'me@example.invalid', subject: 'fleet: proj' } })
  expect(Object.keys(calls[0].args).sort()).toEqual(['body', 'subject', 'to'])
  expect(calls[0].args.body).toMatch(/^fleet · proj: 1 decision\(s\) have waited over 30m \(the oldest, D-1 from Owner B, 4\dm\)/)
  w.touch(`${FLEET}/roster.json`, JSON.stringify({ rosterFormat: 1, roles: {}, instances: [], person: { addresses: ['me@example.invalid'], channel: { kind: 'mcp', server: 'mailbox', tool: 'send_message', to: 'team@example.invalid' } } }))
  w.touch(`${DEC}/queue/D-4.json`, queued('D-4', NOW - 60 * 60000))
  for (let i = 0; i < 40; i++) await tick(w)
  expect(calls.length).toBe(1)
  expect(await fleet($, 'status')).toContain("channel terminal (the band, /fleet and /fleet brief only) (roster.json: person.channel.to (team@example.invalid) isn't one of person.addresses: fleet sends only to the person)")
  expect(await fleet($, 'up --dry-run')).toContain("roster.json: person.channel.to (team@example.invalid) isn't one of person.addresses: fleet sends only to the person: alerts wait in the brief")
})

test('a command-level file changed outside fleet alerts only once it stayed unstamped 30 minutes, once a day; each alert claimed before it goes', WITH_SESSIONS, async ($, on) => {
  const w = project(on, { addresses: ['me@example.invalid'], channel: { kind: 'command', argv: ['bash', '.claude/fleet/alert.sh'] } }, { [`${FLEET}/alert.sh`]: '#!/bin/bash\ncat >> /tmp/x/alerts.txt\n', [`${FLEET}/charter.md`]: '# Charter\n' })
  const ran: string[] = []
  w.exec.value = (argv, _cwd, stdin) => {
    if (argv[1] !== '.claude/fleet/alert.sh') return undefined
    ran.push(stdin ?? '')
    return { exitCode: 0 }
  }
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  expect(await fleet($, 'accept channel')).toContain('Stamped')
  // D-1's digest goes; it was claimed (two sweepers for a minute send it once)
  for (let i = 0; i < 31; i++) await tick(w)
  expect(ran.length).toBe(1)
  expect(under(w, `${FLEET}/state/alerts`).length).toBe(1)
  // The person edits the charter: no alert while he may still accept it himself
  w.touch(`${FLEET}/charter.md`, '# Charter\n\nMine.\n')
  for (let i = 0; i < 20 * 30; i++) await tick(w)
  expect(ran.length).toBe(1)
  for (let i = 0; i < 12 * 30; i++) await tick(w)
  expect(ran.length).toBe(2)
  expect(ran[1]).toMatch(/\.claude\/fleet\/charter\.md changed outside fleet 3\dm ago \(\/fleet accept\)/)
  const day = json(w, `${FLEET}/state/alerts.json`).day
  expect(w.files.has(`${FLEET}/state/alerts/${day}/${hashText(`outside:.claude/fleet/charter.md:${day}`).slice(1, 17)}`)).toBe(true)
  // Saved again: the same file, the same day: nothing more
  w.touch(`${FLEET}/charter.md`, '# Charter\n\nMine, again.\n')
  for (let i = 0; i < 40 * 30; i++) await tick(w)
  expect(ran.length).toBe(2)
})

test('an alert another sweeper claimed first isn’t sent again', WITH_SESSIONS, async ($, on) => {
  const day = new Date(NOW - new Date(NOW).getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const minute = Math.floor(((NOW / 60000 - new Date(NOW).getTimezoneOffset()) % 1440) + 1440) % 1440
  const part = ['night', 'morning', 'afternoon', 'evening'][Math.floor(minute / 360)]
  const claim = `${FLEET}/state/alerts/${day}/${hashText(`waiting:${day}:${part}`).slice(1, 17)}`
  const pushed: string[] = []
  on('tool.call', { tool: 'PushNotification' }, (_: any, e: any) => {
    pushed.push(e.message)
    return { result: { pushSent: true } } as any
  })
  const w = project(on, { channel: { kind: 'push' } }, { [claim]: JSON.stringify({ format: 1, key: `waiting:${day}:${part}`, at: NOW }) })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  for (let i = 0; i < 40; i++) await tick(w)
  expect(pushed).toEqual([])
})
