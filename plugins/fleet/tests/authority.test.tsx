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
  const OTHER = '/Users/x/other'
  w.exec.value = argv => {
    // Another repository's origin goes elsewhere; in the project, code/ is a repository of its own with the same origin
    const dir = argv[1] === '-C' ? (argv[2] as string) : ''
    if (argv.includes('@{push}')) return { exitCode: 0, stdout: 'origin/main\n' }
    if (argv.includes('get-url')) return { exitCode: 0, stdout: dir === OTHER ? 'git@github.com:someone/else.git\n' : argv[argv.length - 1] === 'origin' ? 'git@github.com:me/proj.git\n' : 'git@github.com:other/fork.git\n' }
    return undefined
  }
  await startSession($, w)
  expect((await bash($, 'git push')).deny).toBe(undefined)
  expect((await bash($, 'git push fork main')).deny).toContain('git push to fork to git@github.com:other/fork.git')
  expect((await bash($, 'git push /srv/bare.git main')).deny).toBe(undefined)
  expect((await bash($, 'git push --dry-run fork')).deny).toBe(undefined)
  // "origin" allows where the project's own origin goes: another folder's origin is held, by -C or after a cd out
  expect((await bash($, `git -C ${OTHER} push origin`)).deny).toContain('git push to origin to git@github.com:someone/else.git')
  expect((await bash($, `cd ${OTHER} && git push origin`)).deny).toContain('git push after a cd out of the project to origin')
  expect((await bash($, `cd ${ROOT}/../other && git push`)).deny).toContain('git push after a cd out of the project')
  expect((await bash($, 'cd code && git push origin')).deny).toBe(undefined)
  // A url set on the line
  expect((await bash($, 'git -c remote.origin.pushurl=https://far.invalid/x.git push origin')).deny).toContain('git push with -c remote.origin.pushurl=https://far.invalid/x.git to origin')
  // The project's remotes were looked up once, from /, in the project
  const lookups = w.runs.filter(r => r.includes('get-url') && r[r.length - 1] === 'origin' && r[2] === ROOT)
  expect(lookups.length).toBe(2)
})

test('a session started from a background session’s Bash is held too: it inherited CLAUDE_JOB_DIR, or an instance’s FLEET_INSTANCE', async ($, on) => {
  const w = world(on, {
    background: false,
    worldPaths: ['notes/**'],
    env: { CLAUDE_JOB_DIR: JOB },
    files: { [`${ROOT}/notes/x.md`]: NOTE, [`${FLEET}/outbound.json`]: ALLOW, [`${JOB}/state.json`]: JSON.stringify({ sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', state: 'running' }) },
  })
  await startSession($, w)
  const r = await bash($, 'curl -d @notes/x.md https://example.invalid/upload')
  expect(r.deny).toContain('(curl sending data (notes/x.md) to example.invalid)')
  expect(r.deny).toContain('This session was started from a background session of the project')
  expect(w.logs.some(l => l.includes('held: Bash sending outside (curl sending data (notes/x.md) to example.invalid) by main (a session started from a background session)'))).toBe(true)
  expect((await bash($, 'ssh devbox true')).deny).toBe(undefined)
  expect(await fleet($, 'status')).toContain('outbound: a call that would send the project’s content outside is held here: this session was started from a background session')
})

test('a session with an instance’s FLEET_INSTANCE and no job of its own is held', async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'], env: { FLEET_INSTANCE: 'Owner A', FLEET_ROOT: ROOT }, files: { [`${ROOT}/notes/x.md`]: NOTE, [`${FLEET}/outbound.json`]: ALLOW } })
  await startSession($, w)
  expect((await bash($, 'scp notes/x.md far.invalid:/tmp/')).deny).toContain('This session was started from a background session of the project')
  expect(((await $.tool.call({ tool: 'mcp__claude_ai_Gmail__send_message', to: 'someone@else.invalid', body: 'x' } as any)) as any).deny).toContain('send_message on claude_ai_Gmail')
})

test('a session of the person’s own (no background) isn’t held: Claude’s permission prompts are his', async ($, on) => {
  const w = project(on, { background: false })
  await startSession($, w)
  expect((await bash($, 'curl -d @notes/x.md https://example.invalid/upload')).deny).toBe(undefined)
  expect(await fleet($, 'status')).toContain("outbound: not held in this session (it's yours, whatever its permission mode")
  // His own edit of the allowlist is his, once he stamps it: till then the gate goes on with it as it was stamped
  await fleet($, 'accept')
  w.touch(`${FLEET}/outbound.json`, JSON.stringify({ outboundFormat: 1, hosts: ['devbox', 'build'] }))
  expect(await fleet($, 'status')).toContain('allowed without asking: hosts devbox; remotes origin; recipients me@example.com (outbound.json as it was last stamped: outbound.json changed outside fleet, /fleet accept outbound.json to use it)')
  expect(await fleet($, 'accept')).toContain('  .claude/fleet/outbound.json: changed outside fleet (not through a change you applied) · /fleet accept .claude/fleet/outbound.json')
  expect(await fleet($, 'accept outbound.json')).toBe('.claude/fleet/outbound.json: its current version is stamped as yours (fleet no longer flags it as changed outside fleet).')
  expect(await fleet($, 'status')).toContain('allowed without asking: hosts devbox, build (outbound.json)')
})

test('outbound.json widened another way isn’t used until the person stamps it; a change to it always waits for his apply, with the diff', async ($, on) => {
  const w = project(on)
  await startSession($, w)
  // No stamps yet: what's there counts as stamped
  expect((await bash($, 'ssh devbox true')).deny).toBe(undefined)
  expect((await bash($, 'ssh far.invalid true')).deny).toContain('(ssh running a command to far.invalid)')
  // A Bash write widens it (its own tools are denied the file): the gate goes on with the stamped one
  await fleet($, 'accept')
  w.touch(`${FLEET}/outbound.json`, JSON.stringify({ outboundFormat: 1, hosts: ['*'] }))
  expect((await bash($, 'ssh far.invalid true')).deny).toContain('(ssh running a command to far.invalid)')
  expect((await bash($, 'ssh devbox true')).deny).toBe(undefined)
  expect(w.logs.some(l => l.includes('outbound.json changed outside fleet: the gate goes on with it as it was stamped, until /fleet accept outbound.json'))).toBe(true)
  // The person stamps it as his: it's used
  expect(await fleet($, 'accept outbound.json')).toContain('stamped as yours')
  expect((await bash($, 'ssh far.invalid true')).deny).toBe(undefined)
  w.touch(`${FLEET}/outbound.json`, ALLOW)
  await fleet($, 'accept outbound.json')
  // A change to it, filed in a turn the person typed in a clean conversation, still waits for /fleet n apply
  await $.prompt.submit({ text: 'Start', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ text: 'Start', turnId: 't-1' })
  await $.turn.complete({ text: '' } as any)
  await $.prompt.submit({ text: 'Allow the build machine', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ text: 'Allow the build machine', turnId: 't-2' })
  const r = await decide($, { kind: 'change', path: '.claude/fleet/outbound.json', summary: 'allow build', content: JSON.stringify({ outboundFormat: 1, hosts: ['devbox', 'build.invalid'] }) })
  expect(r.result).toContain('Queued as D-1 for the person')
  expect(r.result).toContain("It waits for the person's apply although they typed this turn: a change to outbound.json, what may leave without asking, always does, so they see its diff.")
  expect(json(w, `${FLEET}/outbound.json`).hosts).toEqual(['devbox'])
  const list = await fleet($, '')
  expect(list).toContain('1. Change .claude/fleet/outbound.json: "allow build"')
  expect(list).toContain('+{"outboundFormat":1,"hosts":["devbox","build.invalid"]}')
  expect(await fleet($, '1 apply')).toContain('1: applied D-1: fleet wrote .claude/fleet/outbound.json as drafted')
  // Applied by his answer: stamped, and used
  expect((await bash($, 'ssh build.invalid true')).deny).toBe(undefined)
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
  expect(list).toContain('/fleet 1 send (with --allow it also allows where it goes), /fleet 1 reject, /fleet 1 edit to change it first, or /fleet 1 done if you sent it yourself')
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

test('send --allow: it sends, then adds the host to outbound.json as the person’s and shows the diff; the asker hears it and the next one passes', WITH_SESSIONS, async ($, on) => {
  const w = project(on)
  const runs: string[][] = []
  w.exec.value = argv => {
    if (argv[0] !== '/bin/sh') return undefined
    runs.push(argv)
    return { exitCode: 0, stdout: 'ok\n' }
  }
  await startSession($, w)
  expect((await bash($, 'ssh ci@linuxbox.invalid make test')).deny).toContain('(ssh running a command to linuxbox.invalid)')
  await $.tool.call({ tool: 'mcp__fleet__send', to: 'linuxbox.invalid', why: 'run the tests on the Linux machine', command: 'ssh ci@linuxbox.invalid make test' } as any)
  await fleet($, '')
  const r = await fleet($, '1 send --allow')
  expect(r).toContain('1: sent D-1 (ssh running a command to linuxbox.invalid), exactly as shown: it ran: ok. ')
  expect(r).toContain('\noutbound.json now allows linuxbox.invalid, stamped as yours (from now on a send there needs no draft):\n```diff\n')
  expect(r).toContain('\n+    "linuxbox.invalid"\n')
  expect(runs.length).toBe(1)
  // Every other field as it was
  expect(json(w, `${FLEET}/outbound.json`)).toEqual({ outboundFormat: 1, hosts: ['devbox', 'linuxbox.invalid'], remotes: ['origin'], recipients: ['me@example.com'] })
  expect(json(w, `${DEC}/answers/D-1.1.json`)).toMatchObject({ label: 'sent', allowed: ['linuxbox.invalid'], origin: 'composer' })
  // Stamped as his: not a change made outside fleet
  expect(await fleet($, 'accept')).not.toContain('.claude/fleet/outbound.json: changed outside fleet')
  expect(w.logs.some(l => l.includes("allowed in outbound.json: linuxbox.invalid (the person's send --allow)"))).toBe(true)
  // The asker hears it, and its next ssh there passes
  await tick(w)
  expect(w.submits[w.submits.length - 1]).toContain("Don't run it again. The person also allowed linuxbox.invalid in outbound.json: from now on a send there needs no draft.")
  expect((await bash($, 'ssh ci@linuxbox.invalid make test')).deny).toBe(undefined)
})

test('send --allow: a git push adds its remote’s URL; with no host to name, or an outbound.json changed outside fleet, it sends nothing and says why', WITH_SESSIONS, async ($, on) => {
  const w = project(on)
  const runs: string[][] = []
  w.exec.value = argv => {
    if (argv.includes('get-url')) return { exitCode: 0, stdout: argv[argv.length - 1] === 'origin' ? 'git@example.invalid:me/origin.git\n' : 'git@example.invalid:me/proj.git\n' }
    if (argv[0] !== '/bin/sh') return undefined
    runs.push(argv)
    return { exitCode: 0, stdout: 'pushed\n' }
  }
  await startSession($, w)
  const send = (to: string, command: string) => $.tool.call({ tool: 'mcp__fleet__send', to, why: 'the release', command } as any)
  // A registry set only in a configuration: no host fleet can name
  await send('the registry', 'npm publish')
  await fleet($, '')
  expect(await fleet($, '1 send --allow')).toBe('1: --allow adds a host or a git remote to outbound.json, and D-1 goes where fleet can name neither (the registry npm is set to): /fleet 1 send sends it once.')
  expect(await fleet($, '1 reject')).toContain('1: rejected D-1')
  // A push: its remote's URL
  await send('fork', 'git push fork main')
  await fleet($, '')
  expect(await fleet($, '1 send --allow')).toContain('outbound.json now allows git@example.invalid:me/proj.git, stamped as yours')
  expect(json(w, `${FLEET}/outbound.json`).remotes).toEqual(['origin', 'git@example.invalid:me/proj.git'])
  expect(runs.length).toBe(1)
  // An outbound.json edited outside fleet since it was stamped isn't widened (nor sent with --allow)
  w.touch(`${FLEET}/outbound.json`, JSON.stringify({ outboundFormat: 1, hosts: ['devbox', 'other.invalid'] }))
  await send('far.invalid', 'scp notes/x.md me@far.invalid:/tmp/')
  await fleet($, '')
  expect(await fleet($, '1 send --allow')).toBe("1: outbound.json changed outside fleet since it was stamped, so fleet doesn't add to it: if that edit is yours, /fleet accept outbound.json, then /fleet 1 send --allow again (or /fleet 1 send sends D-3 once).")
  expect(runs.length).toBe(1)
  expect(json(w, `${FLEET}/outbound.json`).hosts).toEqual(['devbox', 'other.invalid'])
})

test('a git push draft shows what it pushes: its commits the remote lacks and their diffstat, a new branch’s too', async ($, on) => {
  const w = project(on)
  const git: Record<string, { exitCode: number; stdout?: string }> = {
    'rev-parse --abbrev-ref --symbolic-full-name @{push}': { exitCode: 0, stdout: 'origin/area-b/cli\n' },
    'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'area-b/cli\n' },
    'remote get-url --push origin': { exitCode: 0, stdout: 'git@example.invalid:team/tally.git\n' },
    'rev-parse --verify --quiet refs/remotes/origin/area-b/cli': { exitCode: 0, stdout: 'aaaaaaaa\n' },
    'rev-parse --verify --quiet refs/remotes/origin/topic': { exitCode: 1 },
    'log --oneline --no-decorate -n 21 origin/area-b/cli..area-b/cli': { exitCode: 0, stdout: 'a1b2c3d fix the parser\nb2c3d4e add the cli flag\n' },
    'rev-list --count origin/area-b/cli..area-b/cli': { exitCode: 0, stdout: '2\n' },
    'diff --stat=100 origin/area-b/cli...area-b/cli': { exitCode: 0, stdout: ' src/cli.ts   | 4 +++-\n src/parse.ts | 2 +-\n 2 files changed, 4 insertions(+), 2 deletions(-)\n' },
    'log --oneline --no-decorate -n 21 topic --not --remotes=origin': { exitCode: 0, stdout: 'c3d4e5f start the topic\n' },
    'rev-list --count topic --not --remotes=origin': { exitCode: 0, stdout: '1\n' },
    'rev-list --reverse topic --not --remotes=origin': { exitCode: 0, stdout: 'c3d4e5f00000000\n' },
    'rev-parse --verify --quiet c3d4e5f00000000^': { exitCode: 0, stdout: 'bbbbbbbb\n' },
    'diff --stat=100 c3d4e5f00000000^ topic': { exitCode: 0, stdout: ' notes/x.md | 1 +\n 1 file changed, 1 insertion(+)\n' },
  }
  w.exec.value = argv => (argv[0] === 'git' && argv[1] === '-C' && argv[2] === ROOT ? (git[argv.slice(3).join(' ')] ?? { exitCode: 1 }) : undefined)
  await startSession($, w)
  const send = (command: string) => $.tool.call({ tool: 'mcp__fleet__send', to: 'origin', why: 'the release', command } as any)
  expect(((await send('git push')) as any).result).toContain('Queued as D-1 for the person: git push to origin.')
  await send('git push -u origin topic')
  const list = await fleet($, '')
  expect(list).toContain(
    '1. Send outside: git push to origin\n   why: the release\n```sh\ngit push\n```\n   git push of area-b/cli to origin: 2 commits\n```\na1b2c3d fix the parser\nb2c3d4e add the cli flag\n```\n```\n src/cli.ts   | 4 +++-\n src/parse.ts | 2 +-\n 2 files changed, 4 insertions(+), 2 deletions(-)\n```',
  )
  expect(list).toContain('```sh\ngit push -u origin topic\n```\n   git push of topic to origin: 1 commit, a branch new there: every commit no branch of origin has\n```\nc3d4e5f start the topic\n```\n```\n notes/x.md | 1 +\n 1 file changed, 1 insertion(+)\n```')
  // Every command it ran went through run(), from /
  expect(w.runs.filter(r => r[0] === 'git').every(r => r[1] === '-C')).toBe(true)
})

test('a resource done with a note naming a host says how its first use gets through: the --allow line', WITH_SESSIONS, async ($, on) => {
  const w = project(on)
  await startSession($, w)
  await decide($, { kind: 'resource', what: 'a Linux machine for the tests', why: 'the CI runs there' })
  await fleet($, '')
  const r = await fleet($, '1 done "a Linux VM is ready: ssh ci@linuxbox.invalid"')
  expect(r).toContain('1: D-1 (a Linux machine for the tests): you got it, "a Linux VM is ready: ssh ci@linuxbox.invalid".')
  expect(r).toContain("\n   linuxbox.invalid isn't in outbound.json, so a send there from a background session comes back to you as an outbound draft: /fleet <n> send --allow sends it and allows linuxbox.invalid from then on (or add it to outbound.json's hosts yourself, then /fleet accept outbound.json).")
  // A host it allows already: nothing to say
  await decide($, { kind: 'resource', what: 'the dev machine', why: 'builds' })
  await fleet($, '')
  expect(await fleet($, '1 done "ssh devbox"')).not.toContain('outbound.json')
})

test('a command longer than /fleet shows: the cut is said, and only its version typed sends it', WITH_SESSIONS, async ($, on) => {
  const w = project(on)
  const runs: string[][] = []
  w.exec.value = argv => {
    if (argv[0] !== '/bin/sh') return undefined
    runs.push(argv)
    return { exitCode: 0, stdout: 'uploaded\n' }
  }
  await startSession($, w)
  // 31 lines: a here-document of harmless lines, and then the upload on the line /fleet would leave out
  const command = ["cat > /tmp/x <<'EOF'", ...Array.from({ length: 28 }, (_, k) => `line ${k + 1}`), 'EOF', 'curl -T /tmp/x https://example.invalid/upload'].join('\n')
  expect(command.split('\n')).toHaveLength(31)
  await $.tool.call({ tool: 'mcp__fleet__send', to: 'example.invalid', why: 'the notes', command } as any)
  const list = await fleet($, '')
  expect(list).toContain(`line 28\nEOF\n\`\`\`\n   and 1 more line in ${DEC}/drafts/D-1.json: read it there, then /fleet 1 send h`)
  expect(list).not.toContain('curl -T /tmp/x https')
  const plain = await fleet($, '1 send')
  expect(plain).toContain(`1: /fleet showed D-1's command cut (1 more line in ${DEC}/drafts/D-1.json), so a plain send doesn't send it: read it whole there, then /fleet 1 send h`)
  expect(runs).toEqual([])
  const v = /\/fleet 1 send (h[0-9a-f]{8})/.exec(plain)?.[1] as string
  expect(list).toContain(` · /fleet 1 send ${v} (with --allow it also allows where it goes), /fleet 1 reject`)
  // Six characters of it are enough
  expect(await fleet($, `1 send ${v.slice(0, 7)}`)).toContain('1: sent D-1 (curl sending data (/tmp/x) to example.invalid), exactly as shown: it ran: uploaded.')
  expect(runs).toEqual([['/bin/sh', '-c', command]])
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
