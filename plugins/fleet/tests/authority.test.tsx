import { expect, test } from 'claude-code/testing'

import { hashText } from '../hooks/changes'
import { DEC, FLEET, JOB, REF, ROOT, SID, decide, fleet, json, startSession, under, world, type World, WITH_SESSIONS } from './world'

// The one hard line, from both sides: a background session's call that would send the project's content outside is
// refused with how to draft it; the draft is shown to the person exactly; fleet runs it once, as approved. And who may
// command: outside content marks the conversation, a change the person types in a clean one is applied as it's filed,
// and a resource is asked apart from the questions

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

const NOTE = 'Line one of the notes\nLine two\n'
const ALLOW = JSON.stringify({ outboundFormat: 1, hosts: ['devbox'], remotes: ['origin'], recipients: ['me@example.com'] })

function project(on: any, extra: { background?: boolean; files?: Record<string, string> } = {}) {
  return world(on, { background: extra.background, worldPaths: ['notes/**'], files: { [`${ROOT}/notes/x.md`]: NOTE, [`${FLEET}/outbound.json`]: ALLOW, ...extra.files } })
}

const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command } as any) as Promise<any>

test('a background session’s upload outside is refused with the way through; the person’s hosts, this machine and reading pass', async ($, on) => {
  const w = project(on)
  const ran: string[] = []
  w.bash.value = c => void ran.push(c)
  on('tool.call', { tool: 'mcp__claude_ai_Gmail__send_message' }, () => ({ result: 'sent', text: 'sent' }) as any)
  on('tool.call', { tool: 'mcp__claude_ai_Gmail__search_threads' }, () => ({ result: 'threads', text: 'threads' }) as any)
  await startSession($, w)
  const r = await bash($, 'curl -d @notes/x.md https://example.invalid/upload')
  expect(r.deny).toContain("fleet: this command would send the project's content outside it (curl sending data (notes/x.md) to example.invalid), which needs the person's approval, so it was not run.")
  expect(r.deny).toContain('draft it with mcp__fleet__send')
  expect(ran).toEqual([])
  expect(w.logs.some(l => l.includes('held: Bash sending outside (curl sending data (notes/x.md) to example.invalid) by main'))).toBe(true)
  // The person's own dev machine, this machine, and a plain read of the web
  expect((await bash($, 'ssh -o BatchMode=yes -o ConnectTimeout=1 devbox true')).deny).toBe(undefined)
  expect((await bash($, 'curl -s http://localhost:8080/health')).deny).toBe(undefined)
  expect((await bash($, 'curl -s https://example.invalid/page')).deny).toBe(undefined)
  expect((await bash($, 'scp notes/x.md elsewhere.invalid:/tmp/')).deny).toContain('scp of notes/x.md to elsewhere.invalid')
  expect(ran).toEqual(['ssh -o BatchMode=yes -o ConnectTimeout=1 devbox true', 'curl -s http://localhost:8080/health', 'curl -s https://example.invalid/page'])
  // An MCP tool that sends: refused; one to the person's own address passes; a read of an outside service passes
  const mail: any = await $.tool.call({ tool: 'mcp__claude_ai_Gmail__send_message', to: 'someone@else.invalid', body: 'the notes' } as any)
  expect(mail.deny).toContain('(send_message on claude_ai_Gmail to someone@else.invalid)')
  expect(((await $.tool.call({ tool: 'mcp__claude_ai_Gmail__send_message', to: 'me@example.com', body: 'mine' } as any)) as any).deny).toBe(undefined)
  expect(((await $.tool.call({ tool: 'mcp__claude_ai_Gmail__search_threads', query: 'x' } as any)) as any).deny).toBe(undefined)
  await w.clock.settle()
  // The web read before them was outside content: the conversation is marked (once: the first mark stays)
  expect(await fleet($, 'status')).toContain('this conversation read outside content (a command that read example.invalid at ')
})

test('git push: to a remote the person allows, or a local path, it passes; to another it’s held', async ($, on) => {
  const w = project(on)
  w.exec.value = argv => {
    if (argv.includes('@{push}')) return { exitCode: 0, stdout: 'origin/main\n' }
    if (argv.includes('get-url')) return { exitCode: 0, stdout: argv[argv.length - 1] === 'origin' ? 'git@github.com:me/proj.git\n' : 'git@github.com:other/fork.git\n' }
    return undefined
  }
  await startSession($, w)
  expect((await bash($, 'git push')).deny).toBe(undefined)
  expect((await bash($, 'git push fork main')).deny).toContain('git push to fork to git@github.com:other/fork.git')
  expect((await bash($, 'git push /srv/bare.git main')).deny).toBe(undefined)
  expect((await bash($, 'git push --dry-run fork')).deny).toBe(undefined)
})

test('a session of the person’s own (no background) isn’t held: Claude’s permission prompts are his', async ($, on) => {
  const w = project(on, { background: false })
  await startSession($, w)
  expect((await bash($, 'curl -d @notes/x.md https://example.invalid/upload')).deny).toBe(undefined)
  expect(await fleet($, 'status')).toContain("outbound: not held in this session (you're at it")
  // His own edit of the allowlist is his, once he stamps it
  await fleet($, 'accept')
  w.touch(`${FLEET}/outbound.json`, JSON.stringify({ outboundFormat: 1, hosts: ['devbox', 'build'] }))
  expect(await fleet($, 'accept')).toContain('  .claude/fleet/outbound.json: changed outside fleet (not through a change you applied) · /fleet accept .claude/fleet/outbound.json')
  expect(await fleet($, 'accept outbound.json')).toBe('.claude/fleet/outbound.json: its current version is stamped as yours (fleet no longer flags it as changed outside fleet).')
  expect(await fleet($, 'status')).toContain('allowed without asking: hosts devbox, build (outbound.json)')
})

test('mcp__fleet__send: drafted, shown exactly in /fleet, sent once by fleet as approved; a file changed since needs its new version', async ($, on) => {
  const w = project(on)
  const runs: { argv: string[]; cwd: string }[] = []
  w.exec.value = (argv, cwd) => {
    if (argv[0] !== '/bin/sh') return undefined
    runs.push({ argv, cwd })
    return { exitCode: 0, stdout: 'uploaded\n' }
  }
  await startSession($, w)
  const r: any = await $.tool.call({ tool: 'mcp__fleet__send', to: 'example.invalid', why: 'the vendor asked for the notes', command: 'curl -d @notes/x.md https://example.invalid/upload' } as any)
  expect(r.result).toContain('Queued as D-1 for the person: curl sending data (notes/x.md) to example.invalid. Nothing goes out until the person approves it')
  const q = json(w, `${DEC}/queue/D-1.json`)
  expect(q).toMatchObject({ kind: 'outbound', questions: [], asker: { ref: REF }, outbound: { to: 'example.invalid', why: 'the vendor asked for the notes', how: 'command', draft: 'decisions/drafts/D-1.json', cwd: ROOT, files: [{ path: 'notes/x.md', v: hashText(NOTE) }] } })
  expect(json(w, `${DEC}/drafts/D-1.json`)).toEqual({ command: 'curl -d @notes/x.md https://example.invalid/upload' })
  const list = await fleet($, '')
  expect(list).toContain('1 outbound draft for you · answer with /fleet 1 send · /fleet help')
  expect(list).toContain('1. Send outside: curl sending data (notes/x.md) to example.invalid\n   why: the vendor asked for the notes\n```sh\ncurl -d @notes/x.md https://example.invalid/upload\n```')
  expect(list).toContain(`   notes/x.md (2 lines, ${hashText(NOTE).slice(0, 9)}):\n\`\`\`\nLine one of the notes\nLine two\n\`\`\``)
  expect(list).toContain('/fleet 1 send, /fleet 1 reject, /fleet 1 edit to change it first, or /fleet 1 done if you sent it yourself')
  // The file changes after it was drafted: what would go out isn't what was drafted
  w.touch(`${ROOT}/notes/x.md`, `${NOTE}Line three\n`)
  const moved = await fleet($, '1 send')
  expect(moved).toContain("1: D-1 isn't as it was drafted (notes/x.md changed since it was drafted). /fleet shows it as it would go out now; /fleet 1 send h")
  expect(runs).toEqual([])
  const shown = await fleet($, '')
  expect(shown).toContain('(changed since it was drafted: what is shown is what would go out)')
  const v = /\/fleet 1 send (h[0-9a-f]{8})/.exec(moved)?.[1] as string
  const sent = await fleet($, `1 send ${v}`)
  expect(sent).toContain('1: sent D-1 (curl sending data (notes/x.md) to example.invalid), exactly as shown: it ran: uploaded. ')
  expect(runs).toEqual([{ argv: ['/bin/sh', '-c', 'curl -d @notes/x.md https://example.invalid/upload'], cwd: ROOT }])
  expect(json(w, `${DEC}/answers/D-1.1.json`)).toMatchObject({ label: 'sent', text: 'it ran: uploaded', origin: 'composer' })
  expect(await fleet($, '1 send')).toBe('1: D-1 was answered already')
  expect(runs.length).toBe(1)
  // The asker hears it, and the decision closes with what went out in the register
  await tick(w)
  expect(w.submits[w.submits.length - 1]).toBe('[D-1] The person approved your outbound (curl sending data (notes/x.md) to example.invalid), and fleet ran it exactly as drafted, once: it ran: uploaded. Don\'t run it again.')
  await $.turn.start({ text: `The fleet plugin sent a message:\n${w.submits[w.submits.length - 1]}`, turnId: 't-1' })
  await w.clock.settle()
  await tick(w)
  expect(json(w, `${DEC}/register/2026-11/D-1.json`)).toMatchObject({ state: 'delivered', kind: 'outbound', call: '{\n  "command": "curl -d @notes/x.md https://example.invalid/upload"\n}\n', answers: [{ label: 'sent' }] })
  expect(under(w, `${DEC}/drafts`)).toEqual([])
})

test('a folder an outbound sends is listed and versioned: its count and first paths shown, a file changed in it needs the new version; a pattern too', WITH_SESSIONS, async ($, on) => {
  const files: Record<string, string> = { [`${ROOT}/code/area/sub/deep.py`]: 'x = 1\n', [`${ROOT}/dist/a.whl`]: 'a', [`${ROOT}/dist/b.whl`]: 'b', [`${ROOT}/dist/notes.txt`]: 'n' }
  for (let i = 1; i <= 14; i++) files[`${ROOT}/code/area/f${String(i).padStart(2, '0')}.py`] = `print(${i})\n`
  const w = project(on, { files })
  const runs: string[][] = []
  w.exec.value = argv => {
    if (argv[0] !== '/bin/sh') return undefined
    runs.push(argv)
    return { exitCode: 0, stdout: 'sent\n' }
  }
  await startSession($, w)
  const r: any = await $.tool.call({ tool: 'mcp__fleet__send', to: 'far.invalid', why: 'the CI machine runs the tests', command: 'rsync -az --exclude .git code/area/ ci@far.invalid:area/' } as any)
  expect(r.result).toContain('Queued as D-1 for the person: rsync of code/area/ to far.invalid.')
  const spec = json(w, `${DEC}/queue/D-1.json`).outbound
  expect(spec.files.map((f: any) => f.path)).toEqual(['code/area/'])
  const v = spec.files[0].v as string
  expect(v).toMatch(/^h[0-9a-f]{14}$/)
  const first12 = Array.from({ length: 12 }, (_, k) => `f${String(k + 1).padStart(2, '0')}.py`).join('\n')
  expect(await fleet($, '')).toContain(`   code/area/ (a folder, 15 files, ${v.slice(0, 9)}):\n\`\`\`\n${first12}\n\`\`\`\n   and 3 more files in ${ROOT}/code/area/`)
  // A file deep in it changes: what would go out isn't what was drafted
  w.touch(`${ROOT}/code/area/sub/deep.py`, 'x = 2\n')
  const moved = await fleet($, '1 send')
  expect(moved).toContain("1: D-1 isn't as it was drafted (code/area/ changed since it was drafted). /fleet shows it as it would go out now; /fleet 1 send h")
  expect(runs).toEqual([])
  expect(await fleet($, '')).toContain('   code/area/ (a folder, 15 files, ')
  const now = /\/fleet 1 send (h[0-9a-f]{8})/.exec(moved)?.[1] as string
  expect(await fleet($, `1 send ${now}`)).toContain('1: sent D-1 (rsync of code/area/ to far.invalid), exactly as shown: it ran: sent.')
  expect(runs.length).toBe(1)
  // A pattern: the files it names now
  await $.tool.call({ tool: 'mcp__fleet__send', to: 'far.invalid', why: 'the wheels for the CI machine', command: 'scp dist/*.whl far.invalid:wheels/' } as any)
  expect(json(w, `${DEC}/queue/D-2.json`).outbound.files.map((f: any) => f.path)).toEqual(['dist/*.whl'])
  expect(await fleet($, '')).toMatch(/ {3}dist\/\*\.whl \(a pattern, 2 files, h[0-9a-f]{8}\):\n```\na\.whl\nb\.whl\n```/)
})

test('an outbound MCP call, approved: fleet makes it with the server’s own connection; rejected: the asker hears it', async ($, on) => {
  const w = project(on)
  const calls: any[] = []
  on('mcp.call', (_, e) => {
    calls.push(e)
    return { value: { content: [{ type: 'text', text: 'message 17 sent' }], isError: false } }
  })
  await startSession($, w)
  const send = (input: Record<string, unknown>): Promise<any> => $.tool.call({ tool: 'mcp__fleet__send', ...input } as any)
  expect((await send({ to: 'colleague@example.invalid', why: 'thanks for the idea' })).deny).toContain('give either command')
  // The model drafts the call it would have made
  const q = await send({ to: 'colleague@example.invalid', why: 'thanks for the idea', mcp_tool: 'mcp__claude_ai_Gmail__send_message', input: { to: 'colleague@example.invalid', body: 'Thanks' } })
  expect(q.result).toContain('Queued as D-1 for the person: send_message on claude_ai_Gmail to colleague@example.invalid.')
  const list = await fleet($, '')
  expect(list).toContain('1. Send outside: send_message on claude_ai_Gmail to colleague@example.invalid')
  expect(list).toContain('   mcp__claude_ai_Gmail__send_message, with:\n```json\n{\n  "to": "colleague@example.invalid",\n  "body": "Thanks"\n}\n```')
  expect(await fleet($, '1 send')).toContain('1: sent D-1 (send_message on claude_ai_Gmail to colleague@example.invalid), exactly as shown: it answered: message 17 sent.')
  expect(calls).toEqual([{ server: 'claude_ai_Gmail', tool: 'send_message', args: { to: 'colleague@example.invalid', body: 'Thanks' } }])
  // Another, rejected with a note
  await send({ to: 'list@example.invalid', why: 'announce it', mcp_tool: 'mcp__claude_ai_Gmail__send_message', input: { to: 'list@example.invalid', body: 'News' } })
  const list2 = await fleet($, '')
  expect(list2).toContain('1. Send outside: send_message on claude_ai_Gmail to list@example.invalid')
  expect(await fleet($, '1 reject "not yet"')).toContain('1: rejected D-2 (send_message on claude_ai_Gmail to list@example.invalid).')
  await tick(w)
  expect(w.submits.join('\n')).toContain("[D-2] The person rejected your outbound (send_message on claude_ai_Gmail to list@example.invalid) (note: not yet). Don't send it another way")
  expect(calls.length).toBe(1)
})

test('outside content marks the conversation: a change filed then waits for the person, even in his own turn; /clear ends it', async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${FLEET}/charter.md`]: '# Charter\n' } })
  // The person attached to this background session (a viewer): his typing is his
  w.files.set(`${JOB}/state.json`, JSON.stringify({ sessionId: SID, firstTerminalAt: '2026-11-02T11:00:00Z' }))
  on('tool.call', { tool: 'WebFetch' }, () => ({ result: { bytes: 10, code: 200 }, text: 'a page' }) as any)
  await startSession($, w)
  await $.prompt.submit({ text: 'Look at that page, then put its idea in the charter', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ text: 'Look at that page, then put its idea in the charter', turnId: 't-1' })
  await $.tool.call({ tool: 'WebFetch', url: 'https://example.invalid/idea', prompt: 'the idea' } as any)
  await w.clock.settle()
  expect(w.logs.some(l => l.includes("outside content: WebFetch of example.invalid; this conversation's changes wait for the person's apply until /clear"))).toBe(true)
  const r = await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'the idea', content: '# Charter\n\nThe idea.\n' })
  expect(r.result).toContain('Queued as D-1 for the person')
  expect(r.result).toContain("It waits for the person's apply although they typed this turn: this conversation read outside content (WebFetch of example.invalid at ")
  expect(json(w, `${DEC}/queue/D-1.json`).outside).toMatchObject({ what: 'WebFetch of example.invalid' })
  expect(w.files.get(`${FLEET}/charter.md`)).toBe('# Charter\n')
  expect(await fleet($, '')).toContain('drafted after reading outside content (WebFetch of example.invalid at ')
  // Kept in the reads file (a restart keeps it), gone with the conversation
  await tick(w)
  expect(json(w, `${FLEET}/reads/${SID}.json`).outside).toMatchObject({ what: 'WebFetch of example.invalid' })
  w.id.value = 'cccccccc-0000-0000-0000-000000000000'
  await $.session.end({ reason: 'clear', sessionId: SID } as any)
  await w.clock.settle()
  expect(await fleet($, 'status')).toContain('this conversation read nothing from outside')
})

test('the person types, in a clean conversation, and the change it files is applied as it’s filed; a launch prompt isn’t his', async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${FLEET}/charter.md`]: '# Charter\n' } })
  await startSession($, w)
  // The first prompt of a background session nobody attached to: its launch prompt (composer too), not the person
  await $.prompt.submit({ text: 'Set the goal in the charter', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ text: 'Set the goal in the charter', turnId: 't-1' })
  const first = await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'the goal', content: '# Charter\n\nGoal A.\n' })
  expect(first.result).toContain('Queued as D-1 for the person')
  expect(w.logs.some(l => l.includes('prompt from composer, the launch prompt (not the person)'))).toBe(true)
  await $.turn.complete({ text: '' } as any)
  // A fleet prompt starts a turn: not the person's either
  await $.prompt.submit({ text: 'from a plugin', origin: { kind: 'plugin', name: 'sessions' }, wait: false } as any)
  await $.turn.start({ text: 'The sessions plugin sent a message:\nfrom a plugin', turnId: 't-2' })
  expect((await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'again', content: '# Charter\n\nGoal B.\n' })).result).toContain('Queued as D-2')
  await $.turn.complete({ text: '' } as any)
  // The person, typing in the viewer
  await $.prompt.submit({ text: 'Make the goal C', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ text: 'Make the goal C', turnId: 't-3' })
  const r = await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'the goal is C', content: '# Charter\n\nGoal C.\n' })
  expect(r.result).toContain("Applied at once as D-3: the person typed this turn's prompt, and this conversation read nothing from outside, so fleet wrote .claude/fleet/charter.md as you drafted it")
  expect(w.files.get(`${FLEET}/charter.md`)).toBe('# Charter\n\nGoal C.\n')
  expect(json(w, `${DEC}/register/2026-11/D-3.json`)).toMatchObject({ state: 'delivered', delivered: { how: 'result' }, kind: 'change', answers: [{ label: 'applied', origin: 'composer' }] })
  expect(w.files.has(`${DEC}/queue/D-3.json`)).toBe(false)
  expect(w.logs.some(l => l.includes('prompt from composer: the person'))).toBe(true)
  await $.turn.complete({ text: '' } as any)
  // He types into a running turn; fleet's own prompt (which its own hooks never see) starts the next turn before his
  await $.turn.start({ text: 'working', turnId: 't-4' })
  await $.prompt.submit({ text: 'Then make the goal D', origin: { kind: 'composer' }, wait: false, turnId: 't-4' } as any)
  await $.turn.complete({ text: '' } as any)
  await $.turn.start({ text: 'The fleet plugin sent a message:\n[D-9] The person answered: …', turnId: 't-5' })
  expect((await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'not his turn', content: '# Charter\n\nGoal X.\n' })).result).toContain('Queued as D-4')
  await $.turn.complete({ text: '' } as any)
  await $.turn.start({ text: 'Then make the goal D', turnId: 't-6' })
  expect((await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'the goal is D', content: '# Charter\n\nGoal D.\n' })).result).toContain('Applied at once as D-5')
  // The ones that weren't his wait for /fleet n apply
  expect(await fleet($, '')).toContain('3 changes for you')
})

test('a resource: asked apart from the questions, answered done or no with a note, delivered', async ($, on) => {
  const w = project(on)
  await startSession($, w)
  const r = await decide($, { kind: 'resource', what: 'a license for the timing tool', why: 'the timing runs need it', cost: 'about $2k a year', byWhen: 'Friday', alternatives: 'a slower open tool', blocks: 'B-14' })
  expect(r.result).toBe("Queued as D-1 for the person: a license for the timing tool. The person gets it (or says no) outside of here and answers; don't count on it meanwhile, and keep working on what doesn't need it. The answer arrives later as a message from the fleet plugin that starts with [D-1].")
  const list = await fleet($, '')
  expect(list).toContain('1 resource for you · answer with /fleet 1 done · /fleet help')
  expect(list).toContain('1. Resource: a license for the timing tool\n   why: the timing runs need it\n   cost: about $2k a year · by: Friday · without it: a slower open tool\n   /fleet 1 done "a note" once you have it, or /fleet 1 no "why"')
  expect(await fleet($, '1a')).toContain('answer /fleet 1 done "a note" once you have it, or /fleet 1 no "why"')
  expect(await fleet($, '1 done "the key is in the team vault"')).toContain('1: D-1 (a license for the timing tool): you got it, "the key is in the team vault".')
  await tick(w)
  expect(w.submits[w.submits.length - 1]).toBe('[D-1] The person got what you asked for (a license for the timing tool): the key is in the team vault. Go on with what waited on it.')
})
