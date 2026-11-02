import { expect, test } from 'claude-code/testing'

import { DEC, FLEET, ROOT, fleet, json, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

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
