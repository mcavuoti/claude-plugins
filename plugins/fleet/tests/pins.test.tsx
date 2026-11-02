import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { BAND, FAKE_SESSIONS, FLEET, REF, ROOT, SID, fleet, json, sessionsSay, startSession, under, world, type World } from './world'

// Records and pins in one session (TEST W), with the engine's file tools and shell standing in beneath fleet. Another
// session (TEST R) lands a record as its fleet would: the file, its next version, its event

const WITH_SESSIONS = { plugins: [FAKE_SESSIONS] }
const STATE = `${FLEET}/state`
const R1 = `${ROOT}/req/R-1.md`
const R2 = `${ROOT}/req/R-2.md`
const B1 = `${ROOT}/board/B-1.md`
const B2 = `${ROOT}/board/B-2.md`
const PLAN = `${ROOT}/notes/plan.md`
const R_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const RB = { sessionId: R_SID, agentId: null, ref: 'bbbbbbbb', name: 'TEST R' }
const CURRENT = { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST W', root: ROOT, background: true, agent: null } }
const WHEN = '\\d\\d:\\d\\d'
const WORK = '---\nrelies_on: [R-1@1]\n---\nB-1: the work, built on R-1@1\n'

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

// A session past its first scan, and the project's sweeper (it took the free lease at its start, and keeps it)
async function begin($: any, w: World) {
  sessionsSay(w, CURRENT)
  await startSession($, w)
  await tick(w, 1100)
  await tick(w)
  await tick(w)
}

let n = 0
function landByR(w: World, path: string, text: string, rev: number, kind = 'revision', marks: { pins?: string[]; confirmed?: string[] } = {}) {
  const rel = path.slice(ROOT.length + 1)
  const id = (/^[A-Z]+-\d+/.exec(rel.slice(rel.lastIndexOf('/') + 1)) as RegExpExecArray)[0]
  const before = w.files.get(path)
  w.touch(path, text)
  const at = w.clock.now()
  w.touch(`${STATE}/revs/${id}/${rev}.json`, JSON.stringify({ format: 1, id, path: rel, rev, hash: hashText(text), kind, changeHash: null, at, by: RB, via: 'tool', pins: marks.pins ?? [], ...marks }))
  const name = `${at}-bbbbbbbb-${++n}.json`
  const event = { format: 1, at, path: rel, from: before === undefined ? null : hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: RB, id, rev, kind, ...marks }
  w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify(event))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
}

function events(w: World): any[] {
  return [...w.files.keys()]
    .filter(p => p.startsWith(`${FLEET}/events/`) && /\/\d{4}-\d{2}-\d{2}\/\d{2}\/[^/]+\.json$/.test(p))
    .map(p => JSON.parse(w.files.get(p) as string))
    .sort((a, b) => a.at - b.at)
}

async function call($: any, input: Record<string, unknown>): Promise<any> {
  return $.tool.call(input as any)
}

async function band($: any): Promise<string> {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const drawn = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return drawn
}

test('C10: a record cited at a version that has been revised: its owner hears it at its next step, the landing is refused once, and passes once the pin moves', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'board/**'], files: { [R1]: 'R-1 v1\n', [B1]: WORK } })
  await begin($, w)
  // A record's read says which version it is
  expect((await call($, { tool: 'Read', file_path: R1 })).context).toEqual(['fleet: this is R-1@1 (cite it so; fleet tells whoever cites it when it changes).'])
  expect(json(w, `${STATE}/revs/R-1/1.json`)).toMatchObject({ format: 1, id: 'R-1', rev: 1, via: 'base', by: null, hash: hashText('R-1 v1\n') })
  await call($, { tool: 'Read', file_path: B1 })
  // W lands B-1, which makes it B-1's owner
  const landed = await call($, { tool: 'Edit', file_path: B1, old_string: 'the work', new_string: 'the work, started' })
  expect(landed.deny).toBe(undefined)
  expect(landed.context).toContain('fleet: board/B-1.md is now B-1@2.')
  expect(events(w).at(-1)).toMatchObject({ path: 'board/B-1.md', id: 'B-1', rev: 2, kind: 'revision', pins: ['R-1@1'], by: { sessionId: SID } })
  // R lands R-1 v2
  landByR(w, R1, 'R-1 v2, revised\n', 2)
  await tick(w)
  await tick(w)
  expect(json(w, `${STATE}/suspects.json`).suspects).toEqual([expect.objectContaining({ path: 'board/B-1.md', id: 'B-1', owner: expect.objectContaining({ sessionId: SID }), reasons: [expect.objectContaining({ why: 'stale', pin: 'R-1@1', now: 2 })] })])
  // The next step carries both: R-1 changed since W read it, and B-1 (W's) cites it at v1
  const step = (await call($, { tool: 'Bash', command: 'ls' })).context.join('\n')
  expect(step).toMatch(new RegExp(`- req/R-1\\.md: changed at ${WHEN} by TEST R \\(Edit\\), now R-1@2`))
  expect(step).toMatch(new RegExp(`fleet: shared files you wrote last are flagged[^\\n]*\\n- board/B-1\\.md \\(B-1\\) cites R-1@1, and R-1 is at v2 \\(a revision at ${WHEN} by TEST R\\)`))
  expect((await call($, { tool: 'Bash', command: 'ls' })).context).toBe(undefined)
  expect(await band($)).toContain('!! 1 flagged · /fleet status')
  expect(await fleet($, 'status')).toMatch(/suspect \(flags, nothing is held\):\n {2}board\/B-1\.md \(B-1\) cites R-1@1, and R-1 is at v2 \(a revision at \d\d:\d\d by TEST R\) · last written by this session/)
  // Its landing still citing v1 is refused once, with what to read; nothing is written
  const refused = await call($, { tool: 'Edit', file_path: B1, old_string: 'started', new_string: 'done' })
  expect(refused.deny).toMatch(new RegExp(`^fleet: this write cites records you need to read first \\(this write was not made\\):\\n- R-1@1: R-1 is at v2 now \\(a revision at ${WHEN} by TEST R\\)\\. Read req/R-1\\.md, decide whether your work still holds, then cite R-1@2`))
  expect(w.files.get(B1)).toContain('started')
  // It re-reads, moves the pin, and lands
  expect((await call($, { tool: 'Read', file_path: R1 })).context).toEqual(['fleet: this is R-1@2 (cite it so; fleet tells whoever cites it when it changes).'])
  const fixed = await call($, { tool: 'Edit', file_path: B1, old_string: 'relies_on: [R-1@1]', new_string: 'relies_on: [R-1@2]' })
  expect(fixed.deny).toBe(undefined)
  expect(fixed.context).toContain('fleet: board/B-1.md is now B-1@3.')
  // The body still says R-1@1 (every ID@n of the text is a pin): kept after reading R-1 at v2, it's confirmed
  expect(events(w).at(-1)).toMatchObject({ rev: 3, pins: ['R-1@1', 'R-1@2'], confirmed: ['R-1@1>2'] })
  await tick(w)
  expect(json(w, `${STATE}/suspects.json`).suspects).toEqual([])
  expect(await band($)).not.toContain('flagged')
  // Until R-1 moves again
  landByR(w, R1, 'R-1 v3\n', 3)
  await tick(w)
  await tick(w)
  expect(json(w, `${STATE}/suspects.json`).suspects.map((s: any) => [s.path, s.reasons.map((r: any) => r.pin)])).toEqual([['board/B-1.md', ['R-1@1', 'R-1@2']]])
})

test('another session’s landing that keeps a stale pin after reading its record clears the suspect at once, before any scan here', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'board/**'], files: { [R1]: 'R-1 v1\n', [B1]: WORK } })
  await begin($, w)
  landByR(w, R1, 'R-1 v2\n', 2)
  await tick(w)
  await tick(w)
  expect(json(w, `${STATE}/suspects.json`).suspects.map((s: any) => s.path)).toEqual(['board/B-1.md'])
  landByR(w, B1, `${WORK}note: v1 still holds\n`, 2, 'revision', { pins: ['R-1@1'], confirmed: ['R-1@1>2'] })
  await tick(w)
  expect(json(w, `${STATE}/suspects.json`).suspects).toEqual([])
})

test('the gate tells once: a second identical try passes; a new pin of a record never read is refused once; a current pin the file had needs no read', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'board/**'], files: { [R1]: 'R-1 v1\n', [R2]: 'R-2 v1\n', [B1]: WORK } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: B1 })
  // R-1@1 is current and B-1 cited it already: no read of R-1 needed
  expect((await call($, { tool: 'Edit', file_path: B1, old_string: 'the work', new_string: 'the work, part one' })).deny).toBe(undefined)
  // A pin it adds, of a record this thread never read
  const add = { tool: 'Edit', file_path: B1, old_string: 'part one', new_string: 'part one, and R-2@1' }
  expect((await call($, add)).deny).toMatch(/- R-2@1: you haven't read R-2 in this conversation\. Read req\/R-2\.md first\./)
  expect((await call($, add)).deny).toBe(undefined)
  expect(w.files.get(B1)).toContain('and R-2@1')
  // A stale pin, told once, then passes on a second try
  landByR(w, R1, 'R-1 v2\n', 2)
  await tick(w)
  const again = { tool: 'Edit', file_path: B1, old_string: 'part one', new_string: 'part two' }
  expect((await call($, again)).deny).toContain('- R-1@1: R-1 is at v2 now')
  expect((await call($, again)).deny).toBe(undefined)
  // An editorial change doesn't make a pin stale
  await call($, { tool: 'Read', file_path: R2 })
  landByR(w, R2, 'R-2 v1, a typo fixed\n', 2, 'editorial')
  await tick(w)
  expect((await call($, { tool: 'Edit', file_path: B1, old_string: 'part two', new_string: 'part three' })).deny).toBe(undefined)
  const log = w.logs.join('\n')
  expect(log).toContain('fleet: refused once: Edit of board/B-1.md by main (pins R-2@1 unread)')
  expect(log).toContain('fleet: refused once: Edit of board/B-1.md by main (pins R-1@1 stale)')
})

test('strict (world.json): nothing passes on a second try, only a read clears it', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { files: { [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['req/**', 'board/**'], strict: true }), [R1]: 'R-1 v1\n', [B1]: WORK } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: B1 })
  await call($, { tool: 'Read', file_path: R1 })
  landByR(w, R1, 'R-1 v2\n', 2)
  await tick(w)
  const edit = { tool: 'Edit', file_path: B1, old_string: 'the work', new_string: 'the work, more' }
  expect((await call($, edit)).deny).toContain('R-1@1: R-1 is at v2 now')
  expect((await call($, edit)).deny).toContain('R-1@1: R-1 is at v2 now')
  expect(w.logs.join('\n')).toContain('(pins R-1@1 stale), strict')
  await call($, { tool: 'Read', file_path: R1 })
  expect((await call($, edit)).deny).toBe(undefined)
  // A file that changed since this thread read it: the same
  landByR(w, B1, 'B-1 by R\n', 3)
  await tick(w)
  const write = { tool: 'Write', file_path: B1, content: 'B-1 mine\n' }
  expect((await call($, write)).deny).toContain('after you read it')
  expect((await call($, write)).deny).toContain('after you read it')
  expect(await fleet($, 'status')).toContain('strict on every shared file')
})

test('C10b: a Bash heredoc that writes a record citing a stale pin and one never read lands blind, and the record is suspect', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['req/**', 'board/**'], files: { [R1]: 'R-1 v1\n', [R2]: 'R-2 v1\n', [`${ROOT}/req/R-3.md`]: 'R-3 v1\n' } })
  await begin($, w)
  await call($, { tool: 'Read', file_path: R1 })
  landByR(w, R1, 'R-1 v2\n', 2)
  await tick(w)
  await call($, { tool: 'Read', file_path: R2 })
  w.bash.value = command => {
    if (command.startsWith('cat >')) w.touch(B2, '---\nrelies_on: [R-1@1, R-3@1]\n---\nB-2 from a command\n')
  }
  const r = await call($, { tool: 'Bash', command: "cat > board/B-2.md <<'EOF'\n...\nEOF" })
  const text = r.context.join('\n')
  expect(text).toMatch(new RegExp(`fleet: your command wrote board/B-2\\.md, which cites R-1@1 \\(R-1 is at v2, a revision at ${WHEN} by TEST R\\), R-3@1 \\(you haven't read R-3\\)\\. It is marked suspect until it lands again`))
  expect(events(w).at(-1)).toMatchObject({ path: 'board/B-2.md', via: 'bash', blind: true, id: 'B-2', rev: 1, kind: 'addition', pins: ['R-1@1', 'R-3@1'], suspect: ['R-1@1:stale', 'R-3@1:unread'] })
  expect(json(w, `${STATE}/revs/B-2/1.json`)).toMatchObject({ via: 'bash', suspect: ['R-1@1:stale', 'R-3@1:unread'] })
  await tick(w)
  const s = json(w, `${STATE}/suspects.json`).suspects
  expect(s).toEqual([expect.objectContaining({ path: 'board/B-2.md', reasons: [expect.objectContaining({ why: 'stale', pin: 'R-1@1' }), expect.objectContaining({ why: 'blind', pin: 'R-3@1', detail: 'unread' })] })])
  // Landing it again through the gate, after reading what it cites, clears it
  await call($, { tool: 'Read', file_path: R1 })
  await call($, { tool: 'Read', file_path: `${ROOT}/req/R-3.md` })
  expect((await call($, { tool: 'Edit', file_path: B2, old_string: 'R-1@1', new_string: 'R-1@2' })).deny).toBe(undefined)
  await tick(w)
  expect(json(w, `${STATE}/suspects.json`).suspects).toEqual([])
})

test('check scripts: run only once the person stamps them; a failure reaches the file’s owner and status; an unchanged file isn’t checked again', WITH_SESSIONS, async ($, on) => {
  const checks = [{ glob: 'board/**', argv: ['bash', 'checks/board.sh'] }]
  const w = world(on, { files: { [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['req/**', 'board/**'], checks }), [`${ROOT}/checks/board.sh`]: 'echo\n', [R1]: 'R-1 v1\n', [B1]: WORK } })
  const ran: string[][] = []
  w.exec.value = (argv, cwd) => {
    if (argv[0] !== 'bash') return undefined
    ran.push([cwd, ...argv])
    const bad = argv.slice(2).filter(p => !w.files.get(`${ROOT}/${p}`)?.includes('status:'))
    return bad.length ? { exitCode: 1, stdout: bad.map(p => `${p}: no status line`).join('\n') } : { exitCode: 0 }
  }
  await begin($, w)
  await call($, { tool: 'Read', file_path: B1 })
  await call($, { tool: 'Edit', file_path: B1, old_string: 'the work', new_string: 'the work, edited' })
  await tick(w, 61000)
  expect(ran).toEqual([])
  expect(await fleet($, 'status')).toContain('checks: board.sh (at landing): not stamped, so not run: /fleet accept checks runs them')
  expect(await fleet($, 'accept checks', { kind: 'plugin', name: 'other' })).toContain('Only the person stamps the checks')
  expect(await fleet($, 'accept checks')).toContain('Stamped: board.sh (bash checks/board.sh, on board/**, at each landing).')
  // The sweeper catches up with what's out of date
  await tick(w, 61000)
  expect(ran).toEqual([[ROOT, 'bash', 'checks/board.sh', 'board/B-1.md']])
  const step = (await call($, { tool: 'Bash', command: 'ls' })).context.join('\n')
  expect(step).toContain('- board/B-1.md failed the check board.sh: no status line')
  expect(await fleet($, 'status')).toContain('failing a check:\n  board/B-1.md: board.sh: no status line')
  expect(await band($)).toContain('!! 1 flagged')
  // Unchanged: not checked again
  await tick(w, 61000)
  expect(ran.length).toBe(1)
  // A landing runs it at once, on what landed
  await call($, { tool: 'Edit', file_path: B1, old_string: 'edited', new_string: 'edited\nstatus: done' })
  await tick(w, 100)
  expect(ran.at(-1)).toEqual([ROOT, 'bash', 'checks/board.sh', 'board/B-1.md'])
  await tick(w)
  expect(await fleet($, 'status')).toContain('failing a check: nothing')
  // A script changed since the stamp isn't run
  w.touch(`${ROOT}/checks/board.sh`, 'echo changed\n')
  await tick(w, 11000)
  expect(await fleet($, 'status')).toContain('not stamped, so not run')
})

test('the world commit: only the shared files, with --only so other staged work stays staged; never in a worktree, nor without changes', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { files: { [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**'], commit: { everyMin: 60 } }), [PLAN]: 'plan\n' } })
  const git: string[][] = []
  let linked = false
  let status = ' M notes/plan.md\0?? notes/new.md\0'
  w.exec.value = argv => {
    if (argv[0] !== 'git') return undefined
    git.push(argv.slice(3))
    const sub = argv[3]
    if (sub === 'rev-parse') return { exitCode: 0, stdout: `${ROOT}\n${ROOT}/.git${linked ? '/worktrees/w1' : ''}\n${ROOT}/.git\n` }
    if (sub === 'worktree') return { exitCode: 0, stdout: `worktree ${ROOT}\n` }
    if (sub === 'status') return { exitCode: 0, stdout: status }
    return { exitCode: 0 }
  }
  await begin($, w)
  await tick(w, 61000)
  const adds = git.filter(a => a[0] === 'add')
  expect(adds).toEqual([['add', '-A', '--', PLAN, `${ROOT}/notes/new.md`]])
  const commit = git.find(a => a[0] === 'commit') as string[]
  expect(commit.slice(0, 4)).toEqual(['commit', '-q', '--only', '-m'])
  expect(commit[4]).toMatch(/^fleet: world 2026-11-02 \d\d:\d\d$/)
  expect(commit.slice(5)).toEqual(['--', PLAN, `${ROOT}/notes/new.md`])
  expect(json(w, `${STATE}/commit.json`)).toMatchObject({ format: 1, ok: true, files: 2 })
  // Not again within the hour
  await tick(w, 61000)
  expect(git.filter(a => a[0] === 'commit').length).toBe(1)
  // After the hour, nothing changed: no commit
  status = ''
  await tick(w, 3600000)
  expect(git.filter(a => a[0] === 'commit').length).toBe(1)
  // In a linked worktree: none
  status = ' M notes/plan.md\0'
  linked = true
  await tick(w, 61000)
  expect(git.filter(a => a[0] === 'commit').length).toBe(1)
  expect(await fleet($, 'status')).toMatch(/world commits: every 60 min, only the shared files; last at \d\d:\d\d \(the project is a linked worktree/)
})

test('worktree copies: a read of a copy that matches counts for the shared file; a write of a copy is told once where the shared one is; copies are never the world', WITH_SESSIONS, async ($, on) => {
  const COPY = `${ROOT}/.claude/worktrees/w1/notes/plan.md`
  const w = world(on, { worldPaths: ['**/*.md'], files: { [PLAN]: 'plan v1\n', [COPY]: 'plan v1\n' } })
  w.exec.value = argv => {
    if (argv[0] !== 'git') return undefined
    if (argv[3] === 'rev-parse') return { exitCode: 0, stdout: `${ROOT}\n${ROOT}/.git\n${ROOT}/.git\n` }
    if (argv[3] === 'worktree') return { exitCode: 0, stdout: `worktree ${ROOT}\nHEAD a\n\nworktree ${ROOT}/.claude/worktrees/w1\nHEAD b\n` }
    return { exitCode: 0 }
  }
  await begin($, w)
  // The copy is the same as the shared file: reading it counts
  expect((await call($, { tool: 'Read', file_path: COPY })).context).toBe(undefined)
  expect((await call($, { tool: 'Write', file_path: PLAN, content: 'plan v2\n' })).deny).toBe(undefined)
  // Now it differs: its read says so, once, and counts for nothing
  expect((await call($, { tool: 'Read', file_path: COPY })).context?.[0]).toBe(`fleet: ${COPY} is a worktree's copy of the shared file notes/plan.md, and it differs from the main checkout's copy, ${PLAN}, which is the one the project's sessions share. Read that one before you rely on it or cite it.`)
  expect((await call($, { tool: 'Read', file_path: COPY })).context).toBe(undefined)
  // A write of the copy: told once, then it stays in the worktree, with no event
  const write = { tool: 'Write', file_path: COPY, content: 'plan in the branch\n' }
  expect((await call($, write)).deny).toContain(`is a worktree's copy of the shared file notes/plan.md. The project's sessions share the main checkout's copy, ${PLAN}: write that one`)
  expect((await call($, write)).deny).toBe(undefined)
  expect(w.files.get(COPY)).toBe('plan in the branch\n')
  await tick(w, 10000)
  await tick(w, 10000)
  expect(events(w).map(e => e.path)).toEqual(['notes/plan.md'])
  expect(await fleet($, 'status')).toContain('worktrees: 1 linked')
})

test('a session started in a linked worktree belongs to the main checkout’s project', WITH_SESSIONS, async ($, on) => {
  const TREE = `${ROOT}/.claude/worktrees/w1`
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${TREE}/.claude/fleet/config.json`]: '{ "configFormat": 1, "template": "blank", "commitRegister": false }\n', [`${TREE}/notes/plan.md`]: 'x\n' } })
  w.root.value = TREE
  w.exec.value = (argv) => {
    if (argv[0] !== 'git') return undefined
    const dir = argv[2] as string
    if (argv[3] === 'rev-parse') return dir.startsWith(TREE) ? { exitCode: 0, stdout: `${TREE}\n${ROOT}/.git/worktrees/w1\n${ROOT}/.git\n` } : { exitCode: 0, stdout: `${ROOT}\n${ROOT}/.git\n${ROOT}/.git\n` }
    if (argv[3] === 'worktree') return { exitCode: 0, stdout: `worktree ${ROOT}\n\nworktree ${TREE}\n` }
    return { exitCode: 0 }
  }
  await begin($, w)
  const s = await fleet($, 'status')
  expect(s).toContain(`project ${ROOT}`)
  expect(s).toContain(`worktree: this session started in ${TREE}; its project is the main checkout's, ${ROOT}`)
  expect(under(w, `${TREE}/.claude/fleet`)).toEqual(['config.json'])
})

test('the sweeper is one session: a lease another session keeps is left alone; one older than 90 s is taken', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [PLAN]: 'plan\n' } })
  const other = () => w.touch(`${STATE}/sweeper.json`, JSON.stringify({ format: 1, sessionId: R_SID, ref: 'bbbbbbbb', name: 'TEST R', at: w.clock.now() }))
  other()
  await begin($, w)
  expect(await fleet($, 'status')).toContain('sweeper: TEST R')
  other()
  await tick(w, 20000)
  expect(json(w, `${STATE}/sweeper.json`).sessionId).toBe(R_SID)
  await tick(w, 95000)
  await tick(w)
  await tick(w)
  expect(json(w, `${STATE}/sweeper.json`).sessionId).toBe(SID)
  expect(await fleet($, 'status')).toContain('sweeper: this session')
  expect(w.logs.join('\n')).toContain('fleet: sweeper: this session')
  expect(w.files.get(`${STATE}/.gitignore`)).toContain('*')
})
