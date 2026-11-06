import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { DEC, FLEET, ROOT, decide, fleet, json, startSession, world, type World } from './world'

// What an asker takes back or replaces (decide kind withdraw, supersedes), what fleet checks in a draft before it's
// queued (a .py that doesn't parse), and what a ready post must be to go out: word for word its file as it is now,
// refused once when a file the thread read changed since. And an answer reaching a busy asker at its next step

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

const Q = { question: 'Which color for the band?', options: ['Amber', 'Red'], recommended: 'Amber', why: 'calm' }
const B = { sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', agentId: null, ref: 'bbbbbbbb', name: 'TEST B' }

let n = 0
function landByB(w: World, path: string, text: string) {
  const before = w.files.get(path)
  w.touch(path, text)
  const at = w.clock.now()
  const name = `${at}-bbbbbbbb-${++n}.json`
  const event = { format: 1, at, path: path.slice(ROOT.length + 1), from: before === undefined ? null : hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: B }
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify(event))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}

test('withdraw: the asker takes back its own open decision: off the queue, no judge in the register, kept as withdrawn; never one the person answered, nor another session’s', async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'] })
  await startSession($, w)
  expect((await decide($, { questions: [Q] })).result).toContain('Queued as D-1')
  await w.clock.settle()
  expect((await decide($, { kind: 'withdraw', id: 'D-1' })).deny).toBe('why: say in one line why you withdraw D-1 (the register keeps it). Nothing was changed.')
  expect((await decide($, { kind: 'withdraw', id: 'x' })).deny).toBe('id: your own open decision to withdraw, as D-<n>. Nothing was changed.')
  const r = await decide($, { kind: 'withdraw', id: 'd-1', why: 'the tests settled it' })
  expect(r.result).toBe('D-1 is withdrawn: it left the person\'s queue, and the register keeps it as withdrawn ("the tests settled it"). No answer comes for it.')
  expect(w.files.has(`${DEC}/queue/D-1.json`)).toBe(false)
  expect(w.files.has(`${DEC}/judge/D-1.json`)).toBe(false)
  const reg = json(w, `${DEC}/register/2026-11/D-1.json`)
  expect(reg).toMatchObject({ state: 'withdrawn', why: 'the tests settled it', answers: [null] })
  expect(reg.judge).toBe(undefined)
  expect(await fleet($, '')).not.toContain('Which color')
  expect((await decide($, { kind: 'withdraw', id: 'D-1', why: 'again' })).result).toBe('D-1 is closed already: nothing to withdraw.')
  // One the person answered, even in part: never withdrawn
  await decide($, { questions: [Q, { ...Q, question: 'Which font?' }] })
  await fleet($, '')
  await fleet($, '1a')
  expect((await decide($, { kind: 'withdraw', id: 'D-2', why: 'x' })).deny).toBe("the person has answered D-2 already in part: it reaches you as usual, and an answer of theirs isn't withdrawn. Nothing was changed.")
  // Another session's
  w.touch(`${DEC}/queue/D-7.json`, JSON.stringify({ format: 1, fleet: '0.8.0', id: 'D-7', at: w.clock.now(), asker: { ref: 'bbbbbbbb', sessionId: B.sessionId, name: 'TEST B', root: ROOT }, questions: [Q] }))
  expect((await decide($, { kind: 'withdraw', id: 'D-7', why: 'x' })).deny).toBe('D-7 was asked by another session (TEST B): only its asker withdraws it. Nothing was changed.')
  // One the person is sending or applying right now (claimed, its answer not written yet): never withdrawn, nor by supersedes
  const id = /Queued as (D-\d+)/.exec((await decide($, { questions: [{ ...Q, question: 'Which size?' }] })).result)?.[1] as string
  w.touch(`${DEC}/applied/${id}.json`, JSON.stringify({ format: 1, id, at: w.clock.now(), session: 'TEST', origin: 'composer' }))
  expect((await decide($, { kind: 'withdraw', id, why: 'x' })).deny).toBe(`the person is sending or applying ${id} right now: its outcome reaches you as usual, and it isn't withdrawn. Nothing was changed.`)
  expect((await decide($, { questions: [{ ...Q, question: 'Which size, small or large?' }], supersedes: id })).result).toContain(`${id} stays as it is (the person is sending or applying ${id} right now`)
  expect(w.files.has(`${DEC}/queue/${id}.json`)).toBe(true)
})

test('supersedes: the decision it replaces is withdrawn when it’s the asker’s own and unanswered; otherwise both stay and /fleet says which replaces which; two open changes to one file are marked', async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${FLEET}/charter.md`]: '# Charter\n' } })
  await startSession($, w)
  expect((await decide($, { questions: [Q], supersedes: 'D-x' })).deny).toBe('supersedes: your own open decision this one replaces, as D-<n> (or a list of them, up to 8). Nothing was queued.')
  await decide($, { questions: [{ ...Q, question: 'Which color for the warning band?' }] })
  const b = await decide($, { questions: [{ ...Q, question: 'Which color for the warning band, amber or red?' }], supersedes: 'D-1' })
  expect(b.result).toContain('Queued as D-2')
  expect(b.result).toContain(' D-1, which it replaces, is withdrawn.')
  expect(json(w, `${DEC}/register/2026-11/D-1.json`)).toMatchObject({ state: 'withdrawn', why: 'replaced by D-2' })
  expect(json(w, `${DEC}/queue/D-2.json`).supersedes).toBe('D-1')
  expect(await fleet($, '')).toContain('\n   replaces D-1')
  // One the person answered in part stays: the list says the new one replaces it, still open
  await decide($, { questions: [Q, { ...Q, question: 'Which font?' }] })
  await fleet($, '')
  await fleet($, '2a')
  const c = await decide($, { questions: [{ ...Q, question: 'Which font and color?' }], supersedes: 'D-3' })
  expect(c.result).toContain("D-3 stays as it is (the person has answered D-3 already in part: it reaches you as usual, and an answer of theirs isn't withdrawn); the person sees that D-4 replaces it.")
  expect(await fleet($, '')).toContain('   replaces D-3 (still open)')
  // Two open changes to the same file: each says the other is open
  await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'one', content: '# Charter\n\nOne.\n' })
  await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'two', content: '# Charter\n\nTwo.\n', supersedes: 'D-5' })
  const list = await fleet($, '')
  expect(list).toContain('Change .claude/fleet/charter.md: "two"')
  expect(list).not.toContain('"one"')
  await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'three', content: '# Charter\n\nThree.\n' })
  expect(await fleet($, '')).toContain('   ⚠ also open for .claude/fleet/charter.md: D-7: applying one leaves the other stale')
})

test('a .py draft that Python won’t parse (a warning counts) is refused before it’s queued, saying where', async ($, on) => {
  const checks = [{ glob: 'notes/**', argv: ['python3', 'checks/lint.py'] }]
  const w = world(on, { files: { [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], checks }), [`${ROOT}/checks/lint.py`]: 'print(1)\n' } })
  const parsed: string[] = []
  w.exec.value = (argv, _cwd, stdin) => {
    if (argv[0] !== 'python3' || !argv.includes('-c')) return undefined
    parsed.push(argv.join(' '))
    return stdin?.includes('def f(:') ? { exitCode: 1, stderr: '  File "<unknown>", line 2\n    def f(:\n          ^\nSyntaxError: invalid syntax\n' } : { exitCode: 0 }
  }
  await startSession($, w)
  const bad = await decide($, { kind: 'change', path: 'checks/lint.py', summary: 'a helper', content: 'print(1)\ndef f(:\n' })
  expect(bad.deny).toBe("the draft of checks/lint.py doesn't parse as Python (line 2: SyntaxError: invalid syntax): fix it and file it again. Nothing was queued.")
  expect(parsed[0]).toBe('python3 -I -W error -c import ast, sys; ast.parse(sys.stdin.read())')
  expect((await decide($, { kind: 'change', path: 'checks/lint.py', summary: 'a helper', content: 'print(1)\ndef f():\n    pass\n' })).result).toContain('Queued as D-1')
})

const POST = 'mcp__claude_ai_Office__send_chat_message'
const READY = `${ROOT}/notes/ready.md`
const OUT = JSON.stringify({ outboundFormat: 1, hosts: [], remotes: [], recipients: [], calls: [{ tool: POST, match: { chatId: '19:aaaa' }, source: 'notes/ready.md', body: 'content' }] })

test('a ready post goes out only word for word as its file is now; refused once when a file the thread read changed since, then sent', async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [READY]: '# Ready\n\nWhich packet sizes matter most?\n', [`${FLEET}/outbound.json`]: OUT } })
  const sent: string[] = []
  on('tool.call', { tool: POST }, (_: any, e: any) => {
    sent.push(String(e.content))
    return { result: 'sent', text: 'sent' } as any
  })
  await startSession($, w)
  await tick(w, 1100)
  await $.tool.call({ tool: 'Read', file_path: READY } as any)
  const post = (content: string) => $.tool.call({ tool: POST, chatId: '19:aaaa', content } as any) as Promise<any>
  expect((await post('Which packet sizes matter most?')).deny).toBe(undefined)
  // A line of its own (B17): held, with where it departs
  const own = await post('Which packet sizes matter most? The person agrees with 64 B.')
  expect(own.deny).toContain('its text isn\'t word for word in notes/ready.md as it is now: it matches up to "…Which packet sizes matter most?", then says "The person agrees with 64 B.", which the file doesn\'t have there')
  // Another session edits the file: the same text is still in it, but this thread read the old one (G13)
  landByB(w, READY, '# Ready\n\nWhich packet sizes matter most? (64 B and 1500 B)\n')
  await tick(w)
  const stale = await post('Which packet sizes matter most?')
  expect(stale.deny).toMatch(/^fleet: this wasn't sent: a shared file you read changed since you read it \(notes\/ready\.md: changed at \d\d:\d\d by TEST B \(Edit\)\)\. Read it again and send what's there now\. The same call again sends it as it is\.$/)
  expect((await post('Which packet sizes matter most?')).deny).toBe(undefined)
  expect(sent).toEqual(['Which packet sizes matter most?', 'Which packet sizes matter most?'])
})

test('an answer for a busy asker reaches it at its next tool step and closes there, not waiting for the turn to end', async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${ROOT}/notes/a.md`]: 'a\n' } })
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: 'created', text: 'created' }) as any)
  await startSession($, w)
  await decide($, { questions: [Q] })
  await $.turn.start({ text: 'working', turnId: 't-1' })
  await fleet($, '')
  await fleet($, '1a')
  await tick(w)
  expect(w.submits.some(t => t.includes('[D-1]'))).toBe(false)
  const step: any = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  expect((step.context ?? []).join('\n')).toContain('[D-1] The person answered:\n1) Which color for the band? → a) Amber')
  expect(json(w, `${DEC}/register/2026-11/D-1.json`)).toMatchObject({ state: 'delivered', delivered: { how: 'result' } })
  expect(w.files.has(`${DEC}/queue/D-1.json`)).toBe(false)
  await $.turn.complete({ text: '' } as any)
  await tick(w, 30000)
  expect(w.submits.some(t => t.includes('[D-1]'))).toBe(false)
  // At any tool step of the main thread, not only those the world's hooks see (a task, an MCP call, a helper)
  await decide($, { questions: [{ ...Q, question: 'Which font for the band?' }] })
  await $.turn.start({ text: 'working again', turnId: 't-2' })
  await fleet($, '')
  await fleet($, '1b')
  const grep: any = await $.tool.call({ tool: 'TaskCreate', subject: 'x' } as any)
  expect((grep.context ?? []).join('\n')).toContain('[D-2] The person answered:\n1) Which font for the band? → b) Red')
  const again: any = await $.tool.call({ tool: 'TaskCreate', subject: 'y' } as any)
  expect((again.context ?? []).join('\n')).not.toContain('[D-2]')
  expect(json(w, `${DEC}/register/2026-11/D-2.json`)).toMatchObject({ state: 'delivered', delivered: { how: 'result' } })
  // A subagent's step doesn't take the main thread's answers
  await decide($, { questions: [{ ...Q, question: 'Which size for the band?' }] })
  await fleet($, '')
  await fleet($, '1a')
  const sub: any = await $.tool.call({ tool: 'TaskCreate', subject: 'z', agentId: 'agent-1' } as any)
  expect((sub.context ?? []).join('\n')).not.toContain('[D-3]')
})
