import { expect, test } from 'claude-code/testing'

import { hashText, hourFolder } from '../hooks/changes'
import { dateLine } from '../hooks/roster'
import { BAND, DEC, FAKE_LOG, FLEET, REF, ROOT, SID, decide, fleet, json, row, sessionsSay, startSession, under, world, type World, WITH_SESSIONS } from './world'
import { OWNER, PROJECT } from './up.test'

// The roster from an instance's side: this session is "Owner A" (its settings gave it FLEET_INSTANCE), a background
// session running as the owner role. Its binding, heartbeat and seed; the gate on command-level files; the `change`
// decision from filing to applying; its budget; its nudges

const INSTANCE = { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Owner A', FLEET_ROLE: 'owner' }
const HB = `${FLEET}/instances/owner-a`
const B_SID = 'bbbbbbbb-0000-0000-0000-000000000000'
const CURRENT = { ready: true, ref: REF, sessionId: SID, name: 'Owner A', root: ROOT, background: true, agent: 'owner' }

async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

function usage(on: any, cost: { value: number }) {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: cost.value } } }))
}

function calls(w: World, kind: string): any[] {
  return (w.files.get(FAKE_LOG) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(c => c[kind])
    .map(c => c[kind])
}

async function instance($: any, on: any, extra: { files?: Record<string, string>; worldPaths?: string[]; cost?: { value: number } } = {}) {
  const ownWorld = !!extra.files?.[`${FLEET}/world.json`]
  const w = world(on, { worldPaths: ownWorld ? undefined : (extra.worldPaths ?? ['notes/**']), env: INSTANCE, files: { ...PROJECT, [`${FLEET}/instances/owner-a.json`]: '{"env":{}}\n', ...extra.files } })
  usage(on, extra.cost ?? { value: 0.25 })
  on('classic.SessionStart', () => ({}))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a9' }))
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  await startSession($, w)
  // Its conversation starts: classic.SessionStart tells it who it is (as Claude does, when nothing sends it on past fleet)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  return w
}

test('an instance binds from its settings, writes a heartbeat with its spend, is seeded once and sits in its section', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on)
  const ctx: any = await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  expect(ctx.additionalContext.join('\n')).toContain(`fleet: this session is Owner A, the owner of this project's roster (${ROOT}/.claude/fleet/roster.json).`)
  expect(ctx.additionalContext.join('\n')).toContain('Your budget is $1.00 a day')
  await tick(w)
  expect(json(w, `${HB}/state.json`)).toMatchObject({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: REF, sessionId: SID, bound: true, agentType: 'owner', cost: 0.25, settingsHash: hashText('{"env":{}}\n'), budget: { usd: 0.25, cap: 1, state: 'ok' } })
  expect(json(w, `${HB}/spend.json`)).toMatchObject({ day: '2026-11-02', usd: 0.25, last: 0.25 })
  // The seed: once, as fleet's own prompt, from the role's seed and the brief, and today's date (in the machine's zone)
  expect(w.submits).toEqual([
    `You are Owner A, the owner of this project's fleet (the project folder is ${ROOT}; its roster is .claude/fleet/roster.json).\n\nYour brief: You own notes/a.\n\nRead the charter, then plan your part (Owner A).\n\n${dateLine(w.clock.now(), -new Date(w.clock.now()).getTimezoneOffset())}`,
  ])
  expect(json(w, `${HB}/seed-${REF}.json`)).toMatchObject({ format: 1, ref: REF })
  await tick(w, 40000)
  expect(w.submits.length).toBe(1)
  expect(calls(w, 'defineSection')).toContainEqual({ source: 'fleet', spec: { id: 'fleet:owners', title: 'Owners', order: 201 } })
  expect(calls(w, 'assignSection')).toContainEqual({ source: 'fleet', ref: REF, section: 'fleet:owners' })
  const status = await fleet($, 'status')
  expect(status).toContain('this session: Owner A (owner); runs as owner')
  expect(status).toContain('  Owner A · owner · Owners · wave 1 · idle · job aaaaaaaa · fleet ')
  expect(status).toContain('· seeded · $0.25 of $1.00 today')
})

test("a child sits under its parent once the parent's fleet runs; an instance the roster doesn't have isn't one", WITH_SESSIONS, async ($, on) => {
  const now = Date.UTC(2026, 10, 2, 12, 0, 0)
  const w = world(on, { worldPaths: ['notes/**'], env: { ...INSTANCE, FLEET_INSTANCE: 'Owner B' }, files: { ...PROJECT, [`${FLEET}/instances/owner-a/state.json`]: JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'aaaaaaa1', sessionId: 's', at: now, cwd: ROOT, bound: true }) } })
  sessionsSay(w, { current: { ...CURRENT, name: 'Owner B' } })
  await startSession($, w)
  await tick(w, 10100)
  expect(calls(w, 'assignSection')).toContainEqual({ source: 'fleet', ref: REF, section: 'fleet:owners', parent: 'aaaaaaa1' })
  // While its parent asks the person (and moves to "Asking you"), the child stays in its section on its own
  w.files.set(`${FLEET}/instances/owner-a/state.json`, JSON.stringify({ format: 1, instance: 'Owner A', slug: 'owner-a', ref: 'aaaaaaa1', sessionId: 's', at: now + 10100, cwd: ROOT, bound: true }))
  w.files.set(
    `${DEC}/queue/D-1.json`,
    JSON.stringify({ format: 1, fleet: '0.1.0', id: 'D-1', at: now, asker: { ref: 'aaaaaaa1', sessionId: 's', name: 'Owner A', root: ROOT }, questions: [{ question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'w' }] }),
  )
  await tick(w, 10100)
  const placed = calls(w, 'assignSection')
  expect(placed[placed.length - 1]).toEqual({ source: 'fleet', ref: REF, section: 'fleet:owners' })
  w.touch(`${FLEET}/roster.json`, JSON.stringify({ rosterFormat: 1, roles: {}, instances: [] }))
  await tick(w, 31000)
  expect(await fleet($, 'status')).toContain(`this session: "Owner B" isn't in roster.json`)
})

test("an instance's own tools don't write a command-level file: told to file a change; a session of the person's can", WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, { files: { [`${FLEET}/charter.md`]: '# Charter\n', [`${ROOT}/req/R-1.md`]: 'R-1: x\n' }, worldPaths: ['notes/**', 'req/**'] })
  await tick(w)
  const charter: any = await $.tool.call({ tool: 'Write', file_path: `${FLEET}/charter.md`, content: 'mine' } as any)
  expect(charter.deny).toContain('fleet: .claude/fleet/charter.md is a command-level file of this project, and your own tools don\'t write it (this write was not made). To change it, call mcp__fleet__decide with kind "change", path ".claude/fleet/charter.md"')
  const own: any = await $.tool.call({ tool: 'Edit', file_path: `${FLEET}/instances/owner-a.json`, old_string: '{', new_string: '[' } as any)
  expect(own.deny).toContain("is fleet's own")
  const role: any = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/.claude/agents/owner.md`, content: 'x' } as any)
  expect(role.deny).toContain('command-level')
  expect(w.files.get(`${FLEET}/charter.md`)).toBe('# Charter\n')
  // A shared file is the gate's as usual: not command-level (world.json has no "command" here)
  const note: any = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes/new.md`, content: 'hello' } as any)
  expect(note.deny).toBe(undefined)
})

test('the person’s own session writes the charter (his edit is his; /fleet accept stamps it)', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false, worldPaths: ['notes/**'], files: { ...PROJECT, [`${FLEET}/charter.md`]: '# Charter\n' } })
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  // No stamps yet: what's there is the baseline
  expect(await fleet($, 'accept')).toBe('No change made outside fleet waits to be stamped.')
  const r: any = await $.tool.call({ tool: 'Write', file_path: `${FLEET}/charter.md`, content: '# Charter, by hand\n' } as any)
  expect(r.deny).toBe(undefined)
  expect(await fleet($, 'accept')).toContain('  .claude/fleet/charter.md: changed outside fleet (not through a change you applied) · /fleet accept .claude/fleet/charter.md')
  w.touch(`${ROOT}/.claude/agents/owner.md`, '---\nname: owner\ntools: Read, mcp__fleet__*\n---\nYou own the notes.\n')
  expect(await fleet($, 'up --dry-run')).toContain(
    "Your edits since /fleet init or your last /fleet accept: .claude/fleet/charter.md, .claude/agents/owner.md. If they're yours, /fleet accept charter.md .claude/agents/owner.md stamps them (till then fleet flags them as changed outside fleet; one you didn't make, read first).",
  )
  // Several at once, as the dry run says
  expect(await fleet($, 'accept charter.md .claude/agents/owner.md')).toBe(
    '.claude/fleet/charter.md: its current version is stamped as yours (fleet no longer flags it as changed outside fleet).\n.claude/agents/owner.md: its current version is stamped as yours (fleet no longer flags it as changed outside fleet).',
  )
  expect(await fleet($, 'accept')).toBe('No change made outside fleet waits to be stamped.')
})

test('a change: filed with its draft and diff, listed, applied once by fleet at its base, delivered, closed; a replay is refused', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, { files: { [`${FLEET}/charter.md`]: '# Charter\n\n## Goal\n\n' } })
  await tick(w)
  const r = await decide($, { kind: 'change', path: '.claude/fleet/charter.md', summary: 'the goal, from the interview', edits: [{ old_string: '## Goal\n\n', new_string: '## Goal\n\nA plan for the notes.\n' }] })
  expect(r.result).toContain('Queued as D-1 for the person: a change to .claude/fleet/charter.md (+1 −0 lines)')
  const q = json(w, `${DEC}/queue/D-1.json`)
  expect(q).toMatchObject({ format: 1, id: 'D-1', kind: 'change', questions: [], asker: { ref: REF }, change: { path: '.claude/fleet/charter.md', base: hashText('# Charter\n\n## Goal\n\n'), result: hashText('# Charter\n\n## Goal\n\nA plan for the notes.\n'), draft: 'decisions/drafts/D-1.md', diff: 'decisions/drafts/D-1.diff', added: 1, removed: 0 } })
  expect(w.files.get(`${DEC}/drafts/D-1.md`)).toBe('# Charter\n\n## Goal\n\nA plan for the notes.\n')
  // The band and the listing
  await tick(w, 10100)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).toContain('? 1 for you · /fleet')
  await ui.unmount()
  const list = await fleet($, '')
  expect(list).toContain('1 change for you · answer with /fleet 1 apply · /fleet help')
  expect(list).toContain('1. Change .claude/fleet/charter.md: "the goal, from the interview" (+1 −0 lines)\n```diff\n@@ -3,2 +3,3 @@\n ## Goal\n \n+A plan for the notes.\n```')
  expect(list).toContain(`   draft ${FLEET}/decisions/drafts/D-1.md (${hashText('# Charter\n\n## Goal\n\nA plan for the notes.\n').slice(0, 9)}) · /fleet 1 apply, /fleet 1 reject, or /fleet 1 edit to change the draft first`)
  expect(list).toContain('Owner A (idle) · D-1')
  expect(await fleet($, '1a')).toContain('1: D-1 is a change to .claude/fleet/charter.md: answer /fleet 1 apply, /fleet 1 reject, or /fleet 1 edit')
  expect(await fleet($, '1 apply', { kind: 'plugin', name: 'other' })).toContain('Only the person answers')
  // Applied by fleet, once
  let release: (v: unknown) => void = () => {}
  w.answerSubmit.value = () => new Promise(res => (release = res))
  const said = await fleet($, '1 apply')
  expect(said).toContain('1: applied D-1: fleet wrote .claude/fleet/charter.md as drafted')
  expect(said).toContain('Owner A hears it.')
  expect(w.files.get(`${FLEET}/charter.md`)).toBe('# Charter\n\n## Goal\n\nA plan for the notes.\n')
  expect(json(w, `${DEC}/answers/D-1.1.json`)).toMatchObject({ format: 1, id: 'D-1', q: 1, label: 'applied', origin: 'composer' })
  expect(json(w, `${DEC}/applied/D-1.json`)).toMatchObject({ format: 1, id: 'D-1' })
  expect(json(w, `${FLEET}/state/stamps.json`).files['.claude/fleet/charter.md']).toBe(hashText('# Charter\n\n## Goal\n\nA plan for the notes.\n'))
  expect(await fleet($, '1 apply')).toBe('1: D-1 was applied already')
  // The asker hears it, and the decision closes at the turn that carries it
  await tick(w)
  expect(w.submits[w.submits.length - 1]).toBe('[D-1] The person applied your change to .claude/fleet/charter.md ("the goal, from the interview"): fleet wrote it as you drafted it.')
  await $.turn.start({ text: `The fleet plugin sent a message:\n${w.submits[w.submits.length - 1]}`, turnId: 't-1' })
  await w.clock.settle()
  release({ text: '' })
  await w.clock.settle()
  expect(json(w, `${DEC}/register/2026-11/D-1.json`)).toMatchObject({ state: 'delivered', kind: 'change', change: { path: '.claude/fleet/charter.md' }, answers: [{ label: 'applied' }] })
  expect(under(w, `${DEC}/drafts`)).toEqual([])
  expect(under(w, `${DEC}/applied`)).toEqual([])
  expect(await fleet($, '1 apply')).toContain('D-1 is closed')
})

test('a change refused: its file moved since (stale, told), its draft swapped (until the person confirms it), bad input', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, { worldPaths: ['notes/**', 'req/**'], files: { [`${FLEET}/world.json`]: JSON.stringify({ worldFormat: 1, paths: ['notes/**', 'req/**'], command: ['req/**'] }), [`${ROOT}/req/R-1.md`]: 'R-1: the target is 10\n' } })
  await tick(w, 10100)
  const edit = (to: string) => decide($, { kind: 'change', path: 'req/R-1.md', summary: `the target becomes ${to}`, edits: [{ old_string: 'is 10', new_string: `is ${to}` }] })
  expect((await edit('8')).result).toContain('Queued as D-1')
  expect((await edit('9')).result).toContain('Queued as D-2')
  expect((await decide($, { kind: 'change', path: 'notes/a.md', summary: 's', content: 'x' })).deny).toContain("notes/a.md isn't a command-level file of this project")
  expect((await decide($, { kind: 'change', path: '.claude/settings.local.json', summary: 's', content: '{}' })).deny).toContain(".claude/settings.local.json is Claude's own (its settings, say), not a command-level file of fleet's: a change can't name it. If the person should change it, ask them with kind choice")
  expect((await decide($, { kind: 'change', path: '.claude/fleet/instances/owner-a.json', summary: 's', content: 'x' })).deny).toContain('generated by /fleet up')
  expect((await decide($, { kind: 'change', path: 'req/R-1.md', summary: 's', edits: [{ old_string: 'nothing', new_string: 'x' }] })).deny).toContain("old_string isn't in the file")
  expect((await decide($, { kind: 'change', path: '.claude/fleet/roster.json', summary: 's', content: '{' })).deny).toContain("the draft of .claude/fleet/roster.json isn't usable: roster.json isn't valid JSON")
  expect((await decide($, { kind: 'change', path: '../x', summary: 's', content: 'x' })).deny).toContain('without . or ..')
  expect((await decide($, { kind: 'judge' })).deny).toContain('kind is "choice"')
  expect((await decide($, { kind: 'resource' })).deny).toContain('what: say what you need')
  await fleet($, '')
  expect(await fleet($, '1 apply')).toContain('1: applied D-1: fleet wrote req/R-1.md as drafted')
  expect(w.files.get(`${ROOT}/req/R-1.md`)).toBe('R-1: the target is 8\n')
  // A shared file: its landing is the person's, through an answer
  const events = [...w.files.keys()].filter(p => p.startsWith(`${FLEET}/events/${hourFolder(w.clock.now())}/`)).map(p => JSON.parse(w.files.get(p) as string))
  expect(events.find(e => e.via === 'answer')).toMatchObject({ path: 'req/R-1.md', from: hashText('R-1: the target is 10\n'), to: hashText('R-1: the target is 8\n'), by: { person: true }, id: 'R-1' })
  // D-2 was drafted on what's no longer there
  const stale = await fleet($, '2 apply')
  expect(stale).toContain('2: not applied: req/R-1.md changed at ')
  expect(stale).toContain('after D-2 was drafted. Owner A hears it, and can draft it again.')
  expect(w.files.get(`${ROOT}/req/R-1.md`)).toBe('R-1: the target is 8\n')
  expect(json(w, `${DEC}/answers/D-2.1.json`)).toMatchObject({ label: 'stale' })
  // D-3 to reject, and D-4 whose draft someone else changed: refused until the person types its new version
  const next = (to: string) => decide($, { kind: 'change', path: 'req/R-1.md', summary: `the target becomes ${to}`, edits: [{ old_string: 'is 8', new_string: `is ${to}` }] })
  expect((await next('5')).result).toContain('Queued as D-3')
  expect((await next('7')).result).toContain('Queued as D-4')
  await fleet($, '')
  w.files.set(`${DEC}/drafts/D-4.md`, 'R-1: the target is 6\n')
  const swapped = await fleet($, '2 apply')
  expect(swapped).toContain("2: the draft of D-4 isn't the one filed")
  const h = hashText('R-1: the target is 6\n').slice(0, 9)
  expect(swapped).toContain(`If you edited it, apply your version with /fleet 2 apply ${h}`)
  expect(w.files.get(`${ROOT}/req/R-1.md`)).toBe('R-1: the target is 8\n')
  expect(await fleet($, `2 apply ${h}`)).toContain('2: applied D-4: fleet wrote req/R-1.md with your edits to the draft')
  expect(w.files.get(`${ROOT}/req/R-1.md`)).toBe('R-1: the target is 6\n')
  expect(await fleet($, '1 edit')).toContain(`1: edit the draft in your editor: ${FLEET}/decisions/drafts/D-3.md`)
  // Its file moved too (D-4 landed): with a note of his, a reject is his rejection (with none, it closes as stale)
  expect(await fleet($, '1 reject "not 5"')).toBe('1: rejected D-3 (the change to req/R-1.md). Owner A hears it.')
  await tick(w)
  const told = w.submits.join('\n\n')
  expect(told).toContain('[D-2] The person couldn\'t apply your change to req/R-1.md ("the target becomes 9"): req/R-1.md changed at')
  expect(told).toContain('[D-3] The person rejected your change to req/R-1.md ("the target becomes 5")')
  expect(told).toContain('[D-4] The person applied your change to req/R-1.md ("the target becomes 7"): fleet wrote it, with edits of their own to the draft: read it before you rely on it.')
})

test('over its budget: told once, marked on the band, new helpers refused (nothing else); the person lifts it for the day', WITH_SESSIONS, async ($, on) => {
  const cost = { value: 0.85 }
  const w = await instance($, on, { cost, files: { [`${ROOT}/notes/a.md`]: 'a\n' } })
  await tick(w)
  // At 85%: a line at the next step, once
  const read1: any = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  expect(read1.context.join('\n')).toContain("fleet: this instance's budget ($0.85 of $1.00 today, estimated at list price) is past 80%: land what you have")
  const read2: any = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  expect((read2.context ?? []).join('\n')).not.toContain('budget')
  expect(await $.agent.spawn({ prompt: 'help me' } as any)).toMatchObject({ agentId: 'a9' })
  // Past it
  cost.value = 1.1
  await tick(w, 30100)
  const read3: any = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  expect(read3.context.join('\n')).toContain('is used up. Nothing is held, and your tools still work; but fleet won\'t wake or nudge this instance, and new helpers (Agent) are refused until the person lifts it (/fleet budget "Owner A" +<dollars>)')
  const spawn: any = await $.agent.spawn({ prompt: 'help me' } as any)
  expect(spawn.deny).toContain("fleet: this instance's budget ($1.10 of $1.00 today, estimated at list price) is used up, so no new helper starts")
  const edit: any = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes/b.md`, content: 'still works' } as any)
  expect(edit.deny).toBe(undefined)
  await tick(w, 10100)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).toContain('$ 1 over budget · /fleet budget')
  await ui.unmount()
  // Stopped (as sessions says, with its heartbeat still fresh): the band counts it no more, as /fleet status says
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'stopped') } })
  await tick(w, 10100)
  const stopped = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await stopped.drawn())).not.toContain('over budget')
  await stopped.unmount()
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle'), bbbbbbbb: row('bbbbbbbb', 'Owner B', 'idle') } })
  await tick(w, 10100)
  expect(await fleet($, 'budget "Owner A" +1')).toContain('Owner A: $2.00 for today ($1.10 spent so far)')
  expect(await $.agent.spawn({ prompt: 'help me' } as any)).toMatchObject({ agentId: 'a9' })
})

test('a nudge: an idle instance whose shared file changed is prompted by its own fleet, once per window', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, { files: { [`${ROOT}/notes/a.md`]: 'a\n', [`${FLEET}/roster.json`]: JSON.stringify({ ...JSON.parse(PROJECT[`${FLEET}/roster.json`] as string), wakes: { everyMin: 30, perDay: 5 } }) } })
  await tick(w)
  expect(w.submits.length).toBe(1)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  // Owner B lands a change to it, as its fleet would
  const land = (text: string, n: number) => {
    const before = w.files.get(`${ROOT}/notes/a.md`) as string
    w.touch(`${ROOT}/notes/a.md`, text)
    const at = w.clock.now()
    const name = `${at}-bbbbbbbb-${n}.json`
    w.touch(`${FLEET}/events/${hourFolder(at)}/${name}`, JSON.stringify({ format: 1, at, path: 'notes/a.md', from: hashText(before), to: hashText(text), via: 'tool', tool: 'Edit', blind: false, by: { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'Owner B' } }))
    w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: name }))
  }
  land('a, by B\n', 1)
  await tick(w, 40000)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toContain('fleet: a shared file you read has changed since you read it.')
  expect(w.submits[1]).toContain('- notes/a.md: changed at')
  expect(w.submits[1]).toContain('This is a nudge from fleet (at most one every 30 min, 5 a day)')
  expect(json(w, `${HB}/nudges.json`)).toMatchObject({ format: 1, count: 1 })
  // Another change within the window: no second nudge (the digest waits for its next step)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  land('a, by B again\n', 2)
  await tick(w, 60000)
  expect(w.submits.length).toBe(2)
  await tick(w, 30 * 60000)
  expect(w.submits.length).toBe(3)
  // Down: no more
  expect(await fleet($, 'down "Owner A"')).toContain('Down: Owner A.')
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  land('a, by B a third time\n', 3)
  await tick(w, 31 * 60000)
  expect(w.submits.length).toBe(3)
  expect(OWNER).toContain('mcp__fleet__*')
})

test('a dropped nudge keeps what it carried: the next nudge carries the change again, also after an Esc once the person typed', WITH_SESSIONS, async ($, on) => {
  const w = await instance($, on, { files: { [`${ROOT}/notes/a.md`]: 'a\n', [`${FLEET}/roster.json`]: JSON.stringify({ ...JSON.parse(PROJECT[`${FLEET}/roster.json`] as string), wakes: { everyMin: 30, perDay: 5 } }) } })
  await tick(w)
  expect(w.submits.length).toBe(1)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/a.md` } as any)
  // Owner B lands a change to it, as its fleet would
  const before = w.files.get(`${ROOT}/notes/a.md`) as string
  w.touch(`${ROOT}/notes/a.md`, 'a, by B\n')
  const at = w.clock.now()
  w.touch(`${FLEET}/events/${hourFolder(at)}/${at}-bbbbbbbb-1.json`, JSON.stringify({ format: 1, at, path: 'notes/a.md', from: hashText(before), to: hashText('a, by B\n'), via: 'tool', tool: 'Edit', blind: false, by: { sessionId: B_SID, agentId: null, ref: 'bbbbbbbb', name: 'Owner B' } }))
  w.touch(`${FLEET}/events/latest`, JSON.stringify({ format: 1, last: `${at}-bbbbbbbb-1.json` }))
  // The nudge is dropped: nothing it carried is told, and it isn't counted among the wakes
  w.answerSubmit.value = () => ({ drop: 'the queue was cleared' })
  await tick(w, 6000)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toContain('- notes/a.md: changed at')
  expect(w.files.has(`${HB}/nudges.json`)).toBe(false)
  // 30 s later the next one carries the change again; an Esc drops it too
  w.answerSubmit.value = () => ({ drop: 'the session was stopped and nobody has sent input since' })
  await tick(w, 31000)
  expect(w.submits.length).toBe(3)
  expect(w.submits[2]).toContain('- notes/a.md: changed at')
  // Stopped: nothing more until the person types here (a command of his doesn't carry the digest)
  await tick(w, 120000)
  expect(w.submits.length).toBe(3)
  w.answerSubmit.value = text => ({ text })
  await $.prompt.submit({ text: '/fleet status', command: 'fleet', origin: { kind: 'composer' }, wait: false } as any)
  await tick(w, 40000)
  expect(w.submits.length).toBe(4)
  expect(w.submits[3]).toContain('- notes/a.md: changed at')
  expect(json(w, `${HB}/nudges.json`)).toMatchObject({ format: 1, count: 1 })
  // Told now: the next step doesn't carry it again
  const step: any = await $.tool.call({ tool: 'Bash', command: 'true' } as any)
  expect((step.context ?? []).join('\n')).not.toContain('notes/a.md')
})

test('an instance at a permission prompt: its heartbeat says so, with its mode; the sweeper marks its row, which needs the person', WITH_SESSIONS, async ($, on) => {
  on('classic.PermissionRequest', () => ({}))
  on('classic.PostToolUse', () => ({}))
  const w = await instance($, on)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner', permission_mode: 'default' } as any)
  await tick(w)
  await $.classic.PermissionRequest({ tool_name: 'Write', tool_input: {}, permission_mode: 'default' } as any)
  await tick(w, 100)
  expect(json(w, `${HB}/state.json`)).toMatchObject({ mode: 'default', waitingOn: { kind: 'permission', tool: 'Write' }, remote: false })
  // This session sweeps too; sessions sees it waiting
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'waiting') } })
  for (let i = 0; i < 3; i++) await tick(w, 30000)
  const marks = calls(w, 'setMarks')
  expect(marks[marks.length - 1].rows[REF]).toEqual({ badge: '!', tint: 'warning', line: 'waiting on a permission prompt: Enter answers it', needsPerson: true })
  const status = await fleet($, 'status')
  expect(status).toContain('mode default (it asks: a mode that doesn’t lets it work unattended)')
  expect(status).toContain('waiting on a permission prompt (Write) since ')
  expect(await fleet($, 'brief')).toContain('   - Owner A waits on a permission prompt (Write) · ')
  // Answered: its tool ran
  await $.classic.PostToolUse({ tool_name: 'Write', tool_input: {}, tool_response: {} } as any)
  await tick(w, 100)
  expect(json(w, `${HB}/state.json`).waitingOn).toBe(null)
})

test('auto mode’s blocks: the instance’s fleet keeps today’s, the brief and /fleet status say what would allow each, and its row is marked once they pile up; nothing is held', WITH_SESSIONS, async ($, on) => {
  on('classic.PermissionDenied', () => ({}))
  const w = await instance($, on)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner', permission_mode: 'auto' } as any)
  await tick(w)
  // The denial goes on as Claude's (no retry asked), and fleet keeps a cut of it
  const said = await $.classic.PermissionDenied({ tool_name: 'Bash', tool_input: { command: 'ssh dev uptime', description: 'check the box' }, tool_use_id: 'toolu_1', reason: '[Remote Shell]', permission_mode: 'auto' } as any)
  expect(said).toEqual({})
  await tick(w, 100)
  expect(json(w, `${HB}/blocks.json`)).toEqual({ format: 1, slug: 'owner-a', day: '2026-11-02', count: 1, last: [{ at: expect.any(Number), tool: 'Bash', what: 'ssh dev uptime', reason: '[Remote Shell]' }] })
  // One block: listed, no mark yet
  sessionsSay(w, { current: CURRENT, rows: { [REF]: row(REF, 'Owner A', 'idle') } })
  for (let i = 0; i < 3; i++) await tick(w, 30000)
  expect(calls(w, 'setMarks').some(m => m.rows?.[REF])).toBe(false)
  expect(await fleet($, 'brief')).toContain('   - Owner A: 1 blocked by auto mode today, the last at ')
  // Two more at once (parallel calls are refused together): both kept, and the row is marked
  await Promise.all([
    $.classic.PermissionDenied({ tool_name: 'Bash', tool_input: { command: 'ssh dev make test' }, tool_use_id: 'toolu_2', reason: '[Remote Shell]' } as any),
    $.classic.PermissionDenied({ tool_name: 'mcp__files__upload', tool_input: { name: 'a.txt', content: 'the notes' }, tool_use_id: 'toolu_3', reason: '[Data Exfiltration]' } as any),
  ])
  await tick(w, 100)
  const kept = json(w, `${HB}/blocks.json`)
  expect([kept.count, kept.last.map((b: any) => b.what)]).toEqual([3, ['ssh dev uptime', 'ssh dev make test', '']])
  for (let i = 0; i < 3; i++) await tick(w, 30000)
  const marks = calls(w, 'setMarks')
  expect(marks[marks.length - 1].rows[REF]).toEqual({ badge: '⊘3', tint: 'warning', line: 'auto mode blocked 3 today: /fleet brief says how to allow' })
  const brief = await fleet($, 'brief')
  expect(brief).toContain('3. Blocked and stale:\n   - Owner A: 3 blocked by auto mode today, the last at ')
  expect(brief).toContain(': ssh dev… ×2, mcp__files__upload\n     ssh dev… [Remote Shell]: a host it needs throughout, trusted infrastructure: "settings": { "autoMode": { "environment": ["$defaults", "Trusted internal domains: dev"] } }\n')
  expect(brief).toContain('     mcp__files__upload [Data Exfiltration]: a routine pattern: "settings": { "autoMode": { "allow": ["$defaults", "mcp__files__upload is allowed: routine work in this project"] } }; or, for exactly this tool and nothing else, "permissions": { "allow": ["mcp__files__upload"] }')
  expect(brief).toContain('     it goes in Owner A\'s entry in roster.json (yours: edit it, then /fleet accept roster.json; /fleet up "Owner A" rewrites its settings and u restarts it with them)')
  expect(brief).not.toContain('the notes')
  const status = await fleet($, 'status')
  expect(status).toContain('\n    Owner A: 3 blocked by auto mode today, the last at ')
  expect(status).toContain('\n      ssh dev… [Remote Shell]: a host it needs throughout')
  // Nothing of it reached the model, and nothing was held
  expect(w.submits.filter(s => s.includes('auto mode'))).toEqual([])
})
