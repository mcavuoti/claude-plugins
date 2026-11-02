import { expect, test } from 'claude-code/testing'

import { alertMessage, alertsDue, channelKey, channelScript, inQuiet, mcpSendArgs, parseQuiet, personOf, type Alert } from '../hooks/channel'
import type { Roster } from '../hooks/roster'

// The person channel's pure parts: roster.json's person, the channel and its one recipient, quiet hours, the alerts'
// caps (so many a day, one per key a day, quiet hours but a budget's), and the message

const roster = (person: Record<string, unknown>): Roster => ({ rosterFormat: 1, roles: {}, instances: [], person })

test("roster.json's person: the terminal unless a channel says otherwise; an MCP send goes to his own address only", () => {
  expect(personOf(null)).toEqual({ person: { addresses: [], principals: [], quiet: null, perDay: 5, waitingMin: 30, checkMin: 60, channel: { kind: 'terminal' } }, problem: null })
  expect(personOf(roster({ address: 'Me@Example.invalid', channel: { kind: 'push' }, perDay: 3 }))).toMatchObject({ person: { addresses: ['me@example.invalid'], perDay: 3, channel: { kind: 'push' } }, problem: null })
  const mcp = personOf(roster({ addresses: ['me@example.invalid'], channel: { kind: 'mcp', server: 'mailbox', tool: 'send_message', to: 'me@example.invalid', args: { importance: 'low' } } }))
  expect(mcp).toEqual({ person: expect.objectContaining({ channel: { kind: 'mcp', server: 'mailbox', tool: 'send_message', to: 'me@example.invalid', toField: 'to', textField: 'body', subjectField: null, args: { importance: 'low' } } }), problem: null })
  // Anyone else: refused (the channel falls back to the terminal, and the problem is said)
  expect(personOf(roster({ addresses: ['me@example.invalid'], channel: { kind: 'mcp', server: 'mailbox', tool: 'send_message', to: 'team@example.invalid' } }))).toMatchObject({ person: { channel: { kind: 'terminal' } }, problem: "roster.json: person.channel.to (team@example.invalid) isn't one of person.addresses: fleet sends only to the person" })
  expect(personOf(roster({ addresses: ['me@example.invalid'], channel: { kind: 'mcp', server: 'm', tool: 't', to: 'me@example.invalid', args: { cc: 'x@example.invalid' } } })).problem).toBe('roster.json: person.channel.args names a recipient (cc): fleet fills only to, with person.channel.to')
  expect(personOf(roster({ channel: { kind: 'command', argv: ['bash', '.claude/fleet/alert.sh'] } }))).toMatchObject({ person: { channel: { kind: 'command', argv: ['bash', '.claude/fleet/alert.sh'] } }, problem: null })
  expect(personOf(roster({ channel: { kind: 'pigeon' } })).problem).toBe('roster.json: person.channel.kind "pigeon" isn\'t push, mcp, command or terminal')
  expect(personOf(roster({ quietHours: 'late' })).problem).toContain("isn't a range of hours")
})

test('the MCP send: the roster’s arguments, the person’s address, the text', () => {
  const c = personOf(roster({ addresses: ['me@example.invalid'], channel: { kind: 'mcp', server: 'm', tool: 't', to: 'me@example.invalid', textField: 'message', subjectField: 'subject', args: { format: 'plain' } } })).person.channel
  if (c.kind !== 'mcp') throw new Error('not mcp')
  expect(mcpSendArgs(c, 'D-3 waits', 'fleet: proj')).toEqual({ format: 'plain', to: 'me@example.invalid', message: 'D-3 waits', subject: 'fleet: proj' })
})

test('the command channel: its script is command-level, and its stamp covers the command and the script', () => {
  const c = { kind: 'command' as const, argv: ['bash', './scripts/alert.sh', '--quiet'] }
  expect(channelScript(c)).toBe('scripts/alert.sh')
  expect(channelScript({ kind: 'command', argv: ['/usr/local/bin/notify'] })).toBe(null)
  expect(channelKey(c, 'h1')).not.toBe(channelKey(c, 'h2'))
  expect(channelKey({ kind: 'push' }, null)).toBe('')
})

test('quiet hours: across midnight or not', () => {
  const q = parseQuiet('22-7')
  expect(q).toEqual({ from: 1320, to: 420 })
  expect([inQuiet(q, 23 * 60), inQuiet(q, 3 * 60), inQuiet(q, 12 * 60)]).toEqual([true, true, false])
  expect(parseQuiet('12:30-14:00')).toEqual({ from: 750, to: 840 })
  expect(inQuiet(parseQuiet('12:30-14:00'), 13 * 60)).toBe(true)
  expect([parseQuiet('7-7'), parseQuiet(''), parseQuiet(3)]).toEqual([null, null, null])
})

test('the alerts: one per key a day, so many messages a day, quiet hours but a budget; one message for all due', () => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  const a = (key: string, kind: Alert['kind'] = 'waiting'): Alert => ({ key, kind, text: key })
  const p = { format: 1, now, day: '2026-11-02', perDay: 2, quiet: false }
  const first = alertsDue([a('waiting:D-1'), a('check:x')], null, p)
  expect(first.send.map(x => x.key)).toEqual(['waiting:D-1', 'check:x'])
  expect(first.file).toMatchObject({ day: '2026-11-02', count: 1, sent: { 'waiting:D-1': now, 'check:x': now } })
  // The same keys again: nothing; a new one: sent, the day's second message
  expect(alertsDue([a('waiting:D-1')], first.file, { ...p, now: now + 60000 }).send).toEqual([])
  const second = alertsDue([a('waiting:D-1'), a('nofleet:Tester')], first.file, { ...p, now: now + 60000 })
  expect(second.send.map(x => x.key)).toEqual(['nofleet:Tester'])
  // The cap: the rest wait, counted
  const third = alertsDue([a('waiting:D-2')], second.file, { ...p, now: now + 120000 })
  expect(third.send).toEqual([])
  expect(third.file.held).toBe(1)
  // Quiet hours: only a budget's goes
  const quiet = alertsDue([a('waiting:D-3'), a('budget:x:2026-11-02', 'budget')], null, { ...p, quiet: true })
  expect(quiet.send.map(x => x.key)).toEqual(['budget:x:2026-11-02'])
  expect(quiet.waiting.map(x => x.key)).toEqual(['waiting:D-3'])
  // A day later the key may go again, and the count starts over
  expect(alertsDue([a('waiting:D-1')], second.file, { ...p, now: now + 25 * 3600000, day: '2026-11-03' }).send.length).toBe(1)
})

test('the message: the project, the alerts, where to look; long lists folded', () => {
  expect(alertMessage('proj', [{ key: 'a', kind: 'waiting', text: 'D-1 (change, from Requirements) has waited 35m' }])).toBe('fleet · proj: D-1 (change, from Requirements) has waited 35m · /fleet or /fleet brief in any session of the project')
  const many = Array.from({ length: 40 }, (_, k) => ({ key: `k${k}`, kind: 'waiting' as const, text: `D-${k} has waited a long while for you` }))
  const m = alertMessage('proj', many)
  expect(m.length).toBeLessThan(700)
  expect(m).toMatch(/and \d+ more · \/fleet/)
})
