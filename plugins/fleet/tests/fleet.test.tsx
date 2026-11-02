import { expect, test } from 'claude-code/testing'

import { BAND, DEC, FAKE_LOG, FAKE_SESSIONS, FLEET, GOLDEN, HOME, REF, ROOT, SID, TWO_QUESTIONS, decide, fleet, json, row, sessionsSay, startSession, under, world, type World, WITH_SESSIONS } from './world'


// The person answers, then the asker's 2 s tick submits the answers once its session is idle
async function tick(w: World, ms = 2100) {
  await w.clock.advance(ms)
  await w.clock.settle()
}

test('the stand-in for sessions serves the golden list of api 1', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  // The stand-in's own list, as fleet reads it through /fleet status
  expect(await fleet($, 'status')).toContain('sessions: api 1, version 0.13.0')
  expect(GOLDEN).toEqual(['contract', 'current', 'status', 'sections', 'defineSection', 'assignSection', 'start', 'wake', 'setMarks'])
})

test('/fleet init sets the project up: config, decisions folders, .gitignore; again it only updates', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { fleet: false, background: false })
  await startSession($, w)
  expect(w.tools).toEqual([])
  expect(await fleet($, '')).toContain('/fleet init')
  const said = await fleet($, 'init')
  expect(said).toContain(`Set up in ${FLEET}/`)
  expect(json(w, `${FLEET}/config.json`)).toEqual({ configFormat: 1, template: 'blank', commitRegister: false })
  expect(w.files.get(`${FLEET}/.gitignore`)).toContain('\ndecisions/\n')
  for (const d of ['queue', 'answers', 'register', 'tmp', 'prune']) expect(w.dirs.has(`${DEC}/${d}`)).toBe(true)
  // Not a background session: no decide here; the person's taste is heard from now on
  expect(w.tools.map(t => t.name)).toEqual(['taste'])
  expect(await fleet($, 'init --commit-register')).toContain('Up to date')
  expect(json(w, `${FLEET}/config.json`).commitRegister).toBe(true)
  expect(w.files.get(`${FLEET}/.gitignore`)).toContain('!decisions/register/')
  expect(await fleet($, 'init solo')).toContain('No template "solo": there are blank')
  expect(await fleet($, '')).toContain('Nothing is waiting for you')
})

test('/fleet init refuses the home folder and a config.json from a newer fleet', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { fleet: false })
  w.root.value = HOME
  await startSession($, w)
  expect(await fleet($, 'init')).toContain("Not in your home folder")
  w.root.value = ROOT
  w.files.set(`${FLEET}/config.json`, '{"configFormat": 2}')
  expect(await fleet($, 'init')).toContain('newer fleet')
  expect(w.files.get(`${FLEET}/config.json`)).toBe('{"configFormat": 2}')
})

test('decide is offered in a background session of a fleet project only, in the first request', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  expect(w.tools.map(t => [t.name, t.isDeferred])).toEqual([['taste', false], ['decide', false], ['send', false], ['slot', false]])
  expect(w.tools[1].inputSchema.properties.questions.maxItems).toBe(4)
  expect(w.commands).toEqual(['fleet'])
})

test('decide is not offered outside a background session, nor where the job folder names another session', async ($, on) => {
  const w = world(on, { background: false })
  await startSession($, w)
  // The person's taste is heard where he types: taste is offered in every session of a fleet project
  expect(w.tools.map(t => t.name)).toEqual(['taste'])
  expect(await fleet($, 'status')).toContain("decide: not offered here: this isn't a background session")
})

test('a claude started from a background session’s shell inherits CLAUDE_JOB_DIR and gets no decide', async ($, on) => {
  const w = world(on)
  w.files.set(`${HOME}/.claude/jobs/${REF}/state.json`, JSON.stringify({ sessionId: 'bbbbbbbb-0000-0000-0000-000000000000' }))
  await startSession($, w)
  expect(w.tools.map(t => t.name)).toEqual(['taste'])
})

test('decide answers at once with a ticket and queues the record; refuses subagents and bad input', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null } })
  await startSession($, w)
  const r = await decide($)
  expect(r.result).toContain('Queued as D-1')
  expect(r.result).toContain('[D-1]')
  const q = json(w, `${DEC}/queue/D-1.json`)
  expect(q).toMatchObject({ format: 1, fleet: '0.1.0', id: 'D-1', asker: { ref: REF, sessionId: SID, name: 'TEST A', root: ROOT }, blocks: 'the cache layer' })
  expect(q.questions.map((x: any) => x.recommended)).toEqual(['Redis', 'After a day'])
  expect(json(w, `${DEC}/last`)).toEqual({ format: 1, last: 1 })
  expect((await decide($)).result).toContain('Queued as D-2')
  const sub = await decide($, TWO_QUESTIONS, { agentId: 'a1' })
  expect(sub.deny).toContain('report to the main thread')
  const bad = await decide($, { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], recommended: 'C', why: 'x' }] })
  expect(bad.deny).toContain('recommended must be one of the option labels')
  expect(under(w, `${DEC}/queue`)).toEqual(['D-1.json', 'D-2.json'])
  // Nothing left in tmp/ once the beat each decide starts has run
  await w.clock.settle()
  expect(under(w, `${DEC}/tmp`)).toEqual([])
})

test('the whole loop: listed, answered once from a terminal, delivered exactly once at idle, closed in the register', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  sessionsSay(w, { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null }, rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  await startSession($, w)
  await decide($)
  // The band counts the questions waiting for the person, above what's drawn beneath
  w.band.value = 'beneath'
  await tick(w, 10100)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).toContain('? 2 for you · /fleet')
  expect(JSON.stringify(await ui.drawn())).toContain('beneath')
  const list = await fleet($, '')
  expect(list).toContain('2 questions for you')
  expect(list).toContain('1. Which database for the cache?')
  expect(list).toContain('   a) SQLite: one file, no server')
  expect(list).toContain('   Recommended: b, the queue already runs it')
  expect(list).toContain('TEST A (idle) · D-1 (1 of 2)')
  expect(list).toContain('2. Should entries expire?')
  // Only the person's own typing answers
  expect(await fleet($, '1a 2b', { kind: 'plugin', name: 'other' })).toContain('Only the person answers')
  expect(await fleet($, '1a 2b', { kind: 'bridge' })).toContain("Remote Control aren't taken yet")
  expect(w.submits).toEqual([])
  const said = await fleet($, '1a 2b')
  expect(said).toContain('1: Which database for the cache? → a) SQLite')
  expect(said).toContain('2: Should entries expire? → b) Never')
  expect(said).toContain("D-1 goes to TEST A when it's idle")
  expect(json(w, `${DEC}/answers/D-1.1.json`)).toMatchObject({ format: 1, id: 'D-1', q: 1, label: 'SQLite', origin: 'composer', session: 'TEST A' })
  // A second answer finds the first
  expect(await fleet($, '1b')).toContain('already answered')
  expect(json(w, `${DEC}/answers/D-1.1.json`).label).toBe('SQLite')
  // The engine starts the submitted prompt's turn later: hold it
  let release: (v: unknown) => void = () => {}
  w.answerSubmit.value = () => new Promise(res => (release = res))
  await tick(w)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toBe(
    '[D-1] The person answered:\n1) Which database for the cache? → a) SQLite\n2) Should entries expire? → b) Never\n\nGo on with what depended on it.',
  )
  // In flight: not sent again while its turn hasn't started
  await tick(w, 6000)
  expect(w.submits.length).toBe(1)
  // Its turn starts: the record closes
  await $.turn.start({ text: `The fleet plugin sent a message:\n${w.submits[0]}`, turnId: 't-9' })
  await w.clock.settle()
  release({ text: w.submits[0] })
  await w.clock.settle()
  const reg = json(w, `${DEC}/register/2026-11/D-1.json`)
  expect(reg).toMatchObject({ registerFormat: 1, id: 'D-1', source: 'decide', state: 'delivered', delivered: { turnId: 't-9', how: 'submit' } })
  expect(reg.answers.map((a: any) => a.label)).toEqual(['SQLite', 'Never'])
  expect(under(w, `${DEC}/queue`)).toEqual([])
  expect(under(w, `${DEC}/answers`)).toEqual([])
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't-9', reason: 'answer' } as any)
  await tick(w, 12000)
  expect(w.submits.length).toBe(1)
  expect(JSON.stringify(await ui.drawn())).not.toContain('for you')
  expect(await fleet($, '1a')).toContain('already answered in TEST A: a) SQLite (delivered')
  await ui.unmount()
})

test('a busy session gets its answers when its turn ends; an Esc holds them until the person types', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  await decide($, { questions: [TWO_QUESTIONS.questions[0]] })
  await $.turn.start({ text: 'working on it', turnId: 't-1' })
  await fleet($, '')
  await fleet($, '1b')
  await tick(w)
  expect(w.submits).toEqual([])
  w.answerSubmit.value = () => ({ drop: 'the session was stopped and nobody has sent input since' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't-1', reason: 'aborted' } as any)
  await tick(w)
  expect(w.submits.length).toBe(1)
  await tick(w, 10000)
  expect(w.submits.length).toBe(1)
  expect(await fleet($, 'status')).toContain('waiting for you to type something here')
  // The person types: fleet submits again
  w.answerSubmit.value = text => ({ text })
  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ text: 'go on', turnId: 't-2' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't-2', reason: 'answer' } as any)
  await tick(w)
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).toContain('[D-1] The person answered:\n1) Which database for the cache? → b) Redis')
  await tick(w, 1100)
  expect(json(w, `${DEC}/register/2026-11/D-1.json`).state).toBe('delivered')
})

test('a note goes with the answer, free text is kept as typed, and a drop tells the asker', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  await decide($)
  await decide($, { questions: [TWO_QUESTIONS.questions[1]] })
  expect(await fleet($, '')).toContain('3 questions for you')
  expect(await fleet($, 'note 1 keep it local for now')).toContain('Note on 1 saved')
  expect(await fleet($, '1 "neither: a plain map" 2a')).toContain('→ "neither: a plain map"')
  expect(await fleet($, 'drop 3 not needed any more')).toContain('D-2 dropped')
  await tick(w)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain('[D-1] The person answered:\n1) Which database for the cache? → they wrote: "neither: a plain map" (note: keep it local for now)\n2) Should entries expire? → a) After a day')
  expect(w.submits[0]).toContain('[D-2] The person dropped this decision without answering it (not needed any more): 1) Should entries expire?')
  await tick(w, 1100)
  expect(json(w, `${DEC}/register/2026-11/D-1.json`).answers[0]).toMatchObject({ text: 'neither: a plain map', note: 'keep it local for now' })
  expect(json(w, `${DEC}/register/2026-11/D-2.json`)).toMatchObject({ state: 'dropped', why: 'not needed any more' })
})

test('the asking session sits in the "Asking you" section while it waits, and leaves it once answered', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  sessionsSay(w, { rows: { [REF]: row(REF, 'TEST A', 'idle') } })
  await startSession($, w)
  await tick(w, 10100)
  await decide($, { questions: [TWO_QUESTIONS.questions[0]] })
  await tick(w, 10100)
  await fleet($, '')
  await fleet($, '1a')
  await tick(w, 10100)
  const calls = (w.files.get(FAKE_LOG) ?? '').trim().split('\n').map(l => JSON.parse(l))
  expect(calls).toEqual([
    { assignSection: { source: 'fleet', ref: REF, section: null } },
    { defineSection: { source: 'fleet', spec: { id: 'fleet:asking', title: 'Asking you' } } },
    { assignSection: { source: 'fleet', ref: REF, section: 'fleet:asking' } },
    { assignSection: { source: 'fleet', ref: REF, section: null } },
  ])
})

test('after a restart the open decisions come back from the files, and a /clear keeps them', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  // Asked by this session (its short id) before the restart, answered meanwhile
  const record = { format: 1, fleet: '0.1.0', id: 'D-7', at: Date.UTC(2026, 10, 2, 11, 0, 0), asker: { ref: REF, sessionId: SID, name: 'TEST A', root: ROOT }, questions: [{ question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'it works' }] }
  w.files.set(`${DEC}/queue/D-7.json`, JSON.stringify(record))
  w.files.set(`${DEC}/answers/D-7.1.json`, JSON.stringify({ format: 1, id: 'D-7', q: 1, label: 'No', origin: 'composer', session: 'TEST B', at: record.at }))
  // Another session's open decision stays its own
  w.files.set(`${DEC}/queue/D-8.json`, JSON.stringify({ ...record, id: 'D-8', asker: { ...record.asker, ref: 'bbbbbbbb' } }))
  w.files.set(`${DEC}/answers/D-8.1.json`, JSON.stringify({ format: 1, id: 'D-8', q: 1, label: 'No', origin: 'composer', session: 'TEST B', at: record.at }))
  await startSession($, w)
  await $.session.end({ reason: 'clear', sessionId: SID } as any)
  w.id.value = 'cccccccc-0000-0000-0000-000000000000'
  await tick(w)
  expect(w.submits).toEqual(['[D-7] The person answered:\n1) Go? → b) No\n\nGo on with what depended on it.'])
  await tick(w, 1100)
  expect(json(w, `${DEC}/register/2026-11/D-7.json`).state).toBe('delivered')
  expect(under(w, `${DEC}/queue`)).toEqual(['D-8.json'])
  // The next number goes past both
  expect((await decide($)).result).toContain('Queued as D-9')
})

test('a decision from a fleet with another format is listed as such and not answered', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  w.files.set(`${DEC}/queue/D-3.json`, JSON.stringify({ format: 2, id: 'D-3' }))
  await startSession($, w)
  const list = await fleet($, '')
  expect(list).toContain('1 decision was asked by a fleet with another format: restart the sessions (u)')
  expect(list).toContain('Nothing is waiting for you')
})

test('the daily prune closes the decisions of a session gone from the list, keeping their answers', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false })
  const at = Date.UTC(2026, 10, 1, 9, 0, 0)
  const record = { format: 1, fleet: '0.1.0', id: 'D-4', at, asker: { ref: 'dddddddd', sessionId: 'dddddddd-0000-0000-0000-000000000000', name: 'TEST D', root: ROOT }, questions: [{ question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'it works' }] }
  w.files.set(`${DEC}/queue/D-4.json`, JSON.stringify(record))
  w.files.set(`${DEC}/answers/D-4.1.json`, JSON.stringify({ format: 1, id: 'D-4', q: 1, label: 'Yes', origin: 'composer', session: 'TEST B', at }))
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  await tick(w, 10100)
  expect(json(w, `${DEC}/register/2026-11/D-4.json`)).toMatchObject({ state: 'abandoned', why: 'its session is gone', answers: [{ label: 'Yes' }] })
  expect(under(w, `${DEC}/queue`)).toEqual([])
  expect(under(w, `${DEC}/prune`)).toEqual(['2026-11-02'])
})

test("the model's AskUserQuestion is recorded as the person answered it; Esc and chat as not answered", WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false })
  const questions = [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: false }]
  let reply: any = { result: { questions, answers: { 'Which color?': 'Red' }, annotations: {} }, text: 'answered' }
  on('tool.call', { tool: 'AskUserQuestion' }, () => reply)
  await startSession($, w)
  const r: any = await $.tool.call({ tool: 'AskUserQuestion', questions, tool_use_id: 'toolu_01' } as any)
  expect(r.text).toBe('answered')
  await w.clock.settle()
  const files = under(w, `${DEC}/register/2026-11`)
  expect(files.length).toBe(1)
  const rec = json(w, `${DEC}/register/2026-11/${files[0]}`)
  expect(rec).toMatchObject({ registerFormat: 1, source: 'dialog', state: 'answered', answers: [{ label: 'Red' }], asker: { ref: null, sessionId: SID } })
  reply = { result: "Error: The user doesn't want to proceed with this tool use. … STOP what you are doing and wait for the user to tell you how to proceed.", isError: true }
  await $.tool.call({ tool: 'AskUserQuestion', questions } as any)
  await w.clock.settle()
  const all = under(w, `${DEC}/register/2026-11`).map(f => json(w, `${DEC}/register/2026-11/${f}`))
  expect(all.map(x => [x.state, x.why ?? ''])).toContainEqual(['not answered', 'dismissed'])
})

// Another plugin asking the person through the same dialog: fleet leaves it alone
const ASKER = {
  name: 'asker',
  register(on: any) {
    on('turn.start', async ($: any, e: any, next: any) => {
      if (e.text === 'ask through the plugin') {
        try {
          await $.ui.ask('Plugin?', ['A', 'B'])
        } catch (err) {
          await $.fs.write('/fake/asker-error', String(err))
        }
      }
      return next(e)
    })
  },
}

test("another plugin's dialog isn't recorded", { plugins: [FAKE_SESSIONS, ASKER] }, async ($, on) => {
  const w = world(on, { background: false })
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    asked++
    return { result: { answers: { 'Plugin?': 'A' } } }
  })
  await startSession($, w)
  await $.turn.start({ text: 'ask through the plugin', turnId: 't-1' })
  await w.clock.settle()
  expect(w.files.get('/fake/asker-error')).toBe(undefined)
  expect(asked).toBe(1)
  expect(under(w, `${DEC}/register`)).toEqual([])
})

test('a failed submit is tried again 30 s later; a { text } with no turn.start seen still closes the record', WITH_SESSIONS, async ($, on) => {
  const w = world(on)
  await startSession($, w)
  await decide($, { questions: [TWO_QUESTIONS.questions[0]] })
  await fleet($, '')
  await fleet($, '1a')
  w.answerSubmit.value = () => {
    throw new Error('the engine is busy elsewhere')
  }
  await tick(w)
  expect(w.submits.length).toBe(1)
  w.answerSubmit.value = text => ({ text })
  await tick(w, 20000)
  expect(w.submits.length).toBe(1)
  await tick(w, 12000)
  expect(w.submits.length).toBe(2)
  await tick(w, 1100)
  expect(json(w, `${DEC}/register/2026-11/D-1.json`)).toMatchObject({ state: 'delivered', delivered: { how: 'submit' } })
  await tick(w, 6000)
  expect(w.submits.length).toBe(2)
})

test('dropping the decision of a session gone from the list closes it at once', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { background: false })
  const record = { format: 1, fleet: '0.1.0', id: 'D-5', at: Date.UTC(2026, 10, 2, 11, 0, 0), asker: { ref: 'dddddddd', sessionId: 'dddddddd-0000-0000-0000-000000000000', name: 'TEST D', root: ROOT }, questions: [{ question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }], recommended: 'Yes', why: 'it works' }] }
  w.files.set(`${DEC}/queue/D-5.json`, JSON.stringify(record))
  sessionsSay(w, { rows: {} })
  await startSession($, w)
  expect(await fleet($, '')).toContain('TEST D (gone) · D-5')
  expect(await fleet($, 'drop 1 no longer needed')).toContain('D-5 dropped and closed')
  expect(json(w, `${DEC}/register/2026-11/D-5.json`)).toMatchObject({ state: 'abandoned', why: 'no longer needed' })
  expect(under(w, `${DEC}/queue`)).toEqual([])
})

test('plan B: /fleet init takes the sessions key out of settings.local.json, backed up; status and the dry run name a local record', WITH_SESSIONS, async ($, on) => {
  const LOCAL = `${ROOT}/.claude/settings.local.json`
  const before = JSON.stringify({ enabledPlugins: { 'fleet@m': true, 'sessions@m': true } }, null, 2)
  const w = world(on, { fleet: false, background: false, env: { FLEET_CLAUDE: '/opt/x/claude' }, files: { [LOCAL]: before } })
  on('settings.read', (_, e) => (e.source === 'user' ? { value: { enabledPlugins: { 'sessions@m': true } } } : undefined) as any)
  const listed = JSON.stringify([
    { id: 'sessions@m', version: '0.13.1', scope: 'user', enabled: true },
    { id: 'sessions@m', version: '0.13.0', scope: 'local', enabled: true, projectPath: ROOT },
  ])
  w.exec.value = argv => (argv[0] === '/opt/x/claude' && argv.slice(1).join(' ') === 'plugin list --json' ? { exitCode: 0, stdout: listed } : undefined)
  await startSession($, w)
  const said = await fleet($, 'init')
  expect(said).toContain('Took sessions@m out of .claude/settings.local.json (backed up as settings.local.json.bak-antes-fleet)')
  expect(json(w, LOCAL)).toEqual({ enabledPlugins: { 'fleet@m': true } })
  expect(w.files.get(`${LOCAL}.bak-antes-fleet`)).toBe(before)
  expect(said).toContain('sessions@m 0.13.0 is installed for this project alone (a local record)')
  expect(said).toContain('`claude plugin uninstall sessions@m --scope local`')
  // Once the key is gone only the record is said; a second init keeps the first backup
  w.files.set(LOCAL, JSON.stringify({ enabledPlugins: { 'fleet@m': true, 'sessions@m': true } }))
  expect(await fleet($, 'status')).toContain('plan B: .claude/settings.local.json enables sessions@m for this project too')
  await fleet($, 'init')
  expect(w.files.get(`${LOCAL}.bak-antes-fleet`)).toBe(before)
  const status = await fleet($, 'status')
  expect(status).toContain('plan B: sessions@m 0.13.0 is installed for this project alone')
  expect(status).not.toContain('enables sessions@m for this project too')
})
