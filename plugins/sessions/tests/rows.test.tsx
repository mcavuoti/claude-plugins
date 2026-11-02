import { expect, test } from 'claude-code/testing'

import { FORMAT, buildNotice, heartbeatText, parseNotice } from '../hooks/state'
import { BAND, COMMAND, DATA, ROOT, SID, SLOW, startSession, world } from './world'

// What the panel's rows show beyond each session: sections (the person's /sessions section, the headers, the freeze
// while the panel has the keyboard, sections.json kept tidy) and what the sessions spend

const SECTIONS = `${DATA}/sections.json`
const PANEL = { plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

function list(): any[] {
  return [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'alpha' },
    { id: 'bbbbbbbb', sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'idle', pid: 4243, name: 'bravo' },
    { id: 'cccccccc', sessionId: 'cccccccc-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'idle', pid: 4244, name: 'charlie' },
  ]
}

async function sessions($: any, args: string): Promise<string> {
  const r: any = await $.command.run({ command: 'sessions', args, ...COMMAND })
  return String(r.text)
}

// The names and headers in the panel, top to bottom
async function drawnOrder($: any, words: string[]): Promise<string[]> {
  const ui = await $.ui.mount(PANEL)
  const text = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return words.filter(w => text.includes(w)).sort((a, b) => text.indexOf(a) - text.indexOf(b))
}

function setFocused(w: any, focused: boolean) {
  const pane = w.panes.find((p: any) => p.id === 'sessions')
  if (pane) pane.isFocused = focused
}

test("the person's sections: /sessions section puts this session in one, with a header only when two groups have rows", async ($, on) => {
  const w = world(on, { list: list() })
  await startSession($, w)
  const words = ['alpha', 'bravo', 'charlie', 'Renders']
  expect(await drawnOrder($, words)).toEqual(['alpha', 'bravo', 'charlie'])
  expect(await sessions($, 'section Renders')).toBe('This session is in “Renders” now')
  await w.clock.advance(3000)
  // In no section first, with no header; then the section's title above its rows
  expect(await drawnOrder($, words)).toEqual(['bravo', 'charlie', 'Renders', 'alpha'])
  // The order file ccc reads keeps the usual order, whatever the sections
  expect((w.files.get(`${DATA}/order/_Users_x_myapp`) ?? '').split('\n').filter(l => l.startsWith('row=')).map(l => l.split('\t')[2])).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'])
  expect(await sessions($, 'section')).toContain('This session is in “Renders”')
  expect(await sessions($, 'sections')).toContain('Renders · 1 session')
  expect(JSON.parse(w.files.get(SECTIONS) ?? '{}').members).toEqual({ aaaaaaaa: { section: 'me:renders', by: 'person' } })
  // Out of it: the section goes (nobody's in it), and so does the header
  expect(await sessions($, 'section -')).toBe('This session is in no section now')
  await w.clock.advance(3000)
  expect(await drawnOrder($, words)).toEqual(['alpha', 'bravo', 'charlie'])
  expect(JSON.parse(w.files.get(SECTIONS) ?? '{}').sections).toEqual([])
})

test('while the panel has the keyboard, sections and their members stay put; they apply when it leaves', async ($, on) => {
  const w = world(on, { list: list() })
  w.files.set(SECTIONS, JSON.stringify({ sectionsFormat: 1, sections: [{ id: 'probe:desk', title: 'Desk', order: 10, owner: 'probe' }], members: {} }))
  await startSession($, w)
  const words = ['alpha', 'bravo', 'charlie', 'Desk']
  expect(await drawnOrder($, words)).toEqual(['alpha', 'bravo', 'charlie'])
  setFocused(w, true)
  w.files.set(SECTIONS, JSON.stringify({ sectionsFormat: 1, sections: [{ id: 'probe:desk', title: 'Desk', order: 10, owner: 'probe' }], members: { bbbbbbbb: { section: 'probe:desk', by: 'probe' } } }))
  await w.clock.advance(6000)
  expect(await drawnOrder($, words)).toEqual(['alpha', 'bravo', 'charlie'])
  setFocused(w, false)
  await w.clock.advance(3000)
  expect(await drawnOrder($, words)).toEqual(['alpha', 'charlie', 'Desk', 'bravo'])
})

test('members of sessions gone from the list are dropped with the rest of their data', async ($, on) => {
  const sessionsList = list()
  const w = world(on, { list: sessionsList })
  w.files.set(
    SECTIONS,
    JSON.stringify({
      sectionsFormat: 1,
      sections: [{ id: 'me:renders', title: 'Renders', order: 100, owner: 'person' }],
      members: { bbbbbbbb: { section: 'me:renders', by: 'person' }, zzzzzzzz: { section: 'me:renders', by: 'person' } },
    }),
  )
  await startSession($, w)
  await w.clock.advance(3000)
  expect(Object.keys(JSON.parse(w.files.get(SECTIONS) ?? '{}').members)).toEqual(['bbbbbbbb'])
})

test("a plugin's section that two cleanups in a row find empty goes; one just defined, or with members, stays", SLOW, async ($, on) => {
  const w = world(on, { list: list() })
  const sections = (members: Record<string, unknown>) =>
    JSON.stringify({
      sectionsFormat: 1,
      sections: [
        { id: 'probe:old', title: 'Old', order: 200, owner: 'probe' },
        { id: 'probe:desk', title: 'Desk', order: 10, owner: 'probe' },
      ],
      members,
    })
  w.files.set(SECTIONS, sections({ bbbbbbbb: { section: 'probe:desk', by: 'probe' } }))
  await startSession($, w)
  const ids = () => JSON.parse(w.files.get(SECTIONS) ?? '{}').sections.map((s: any) => s.id)
  // The first cleanup finds probe:old empty and keeps it
  expect(ids()).toEqual(['probe:old', 'probe:desk'])
  // A section defined meanwhile, still waiting for its first member, is found empty only once at the next cleanup
  const file = JSON.parse(w.files.get(SECTIONS) ?? '{}')
  file.sections.push({ id: 'probe:new', title: 'New', order: 200, owner: 'probe' })
  w.files.set(SECTIONS, JSON.stringify(file))
  await w.clock.advance(600000)
  expect(ids()).toEqual(['probe:desk', 'probe:new'])
})

test("/clear in a regular session: its section follows its new session id", async ($, on) => {
  const REGULAR = 'dddddddd-0000-0000-0000-000000000000'
  const NEW = 'eeeeeeee-0000-0000-0000-000000000000'
  const w = world(on, { id: REGULAR, list: [{ sessionId: REGULAR, cwd: ROOT, kind: 'interactive', status: 'idle', pid: 4250, name: 'myapp-1f' }] })
  await startSession($, w)
  expect(await sessions($, 'section Renders')).toBe('This session is in “Renders” now')
  await $.session.end({ reason: 'clear', sessionId: REGULAR } as any)
  w.id.value = NEW
  await w.clock.advance(1000)
  expect(JSON.parse(w.files.get(SECTIONS) ?? '{}').members).toEqual({ [`sid:${NEW}`]: { section: 'me:renders', by: 'person' } })
})

test('f: only the sessions waiting for you, kept while the panel has the keyboard, for every session until f again', async ($, on) => {
  const sessionsList = list()
  sessionsList[2].status = 'waiting'
  const w = world(on, { list: sessionsList })
  await startSession($, w)
  setFocused(w, true)
  const ui = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, isFocused: true } })
  const shown = async () => {
    const text = JSON.stringify(await ui.drawn())
    return ['alpha', 'bravo', 'charlie', 'Waiting for you · 1 of 3', 'Nobody is waiting'].filter(x => text.includes(x))
  }
  expect(await shown()).toEqual(['alpha', 'bravo', 'charlie'])
  await ui.press({ key: 'waiting' })
  expect(await shown()).toEqual(['charlie', 'Waiting for you · 1 of 3'])
  expect(w.store.get('waitingOnly')).toBe(true)
  // Answered while you're in the panel: it stays until you leave
  sessionsList[2].status = 'idle'
  await w.clock.advance(4000)
  expect(await shown()).toEqual(['charlie', 'Waiting for you · 1 of 3'])
  setFocused(w, false)
  await w.clock.advance(4000)
  expect(await shown()).toEqual(['Nobody is waiting'])
  setFocused(w, true)
  await ui.press({ key: 'waiting' })
  expect(await shown()).toEqual(['alpha', 'bravo', 'charlie'])
  expect(w.store.get('waitingOnly')).toBe(false)
  await ui.unmount()
})

test('spend on a subscription: the account windows it has, once, above the prompt, and no dollars in the rows', async ($, on) => {
  const w = world(on, { list: list() })
  w.usage.value = { context: { percent: 10 }, rateLimits: [{ kind: 'seven_day', percentUsed: 43.4, resetsAt: '2026-11-08T00:00:00Z' }], cost: { usd: 3.5 } }
  await startSession($, w)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await band.drawn())).toContain('7d 43%')
  await band.unmount()
  await w.clock.advance(3000)
  const ui = await $.ui.mount(PANEL)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('$3.50')
  expect(drawn).not.toContain('est.')
  await ui.unmount()
})

test('spend on an API account: each row its cost so far, and the project total, as estimates at list price', async ($, on) => {
  const w = world(on, { list: list() })
  w.usage.value = { context: { percent: 10 }, rateLimits: [], cost: { usd: 1.2 } }
  // Another session published its own: still on a subscription (no dollars) or on an API key
  w.store.set('state:bbbbbbbb-0000-0000-0000-000000000000', { usd: 20.04, limits: [] })
  w.store.set('state:cccccccc-0000-0000-0000-000000000000', { usd: 9, limits: [{ kind: 'seven_day', percent: 40 }] })
  await startSession($, w)
  await w.clock.advance(3000)
  const ui = await $.ui.mount(PANEL)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('$1.20')
  expect(drawn).toContain('$20.04')
  expect(drawn).not.toContain('$9.00')
  expect(drawn).toContain('$21.24 est. spent here so far (list price)')
  await ui.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await band.drawn())).not.toContain('7d')
  await band.unmount()
})

const DESK = (members: Record<string, unknown>) => JSON.stringify({ sectionsFormat: 1, sections: [{ id: 'probe:desk', title: 'Desk', order: 10, owner: 'probe' }], members })

// The person moves the panel's focus (the arrows) onto an element
async function focusOn($: any, key: string) {
  await $.ui.focus({ component: 'Pane', requestId: 'sessions', plugin: 'sessions', element: key, origin: { kind: 'person' } } as any)
}

test('children: indented under their parent, in its section; moved there only when the panel leaves the keyboard', async ($, on) => {
  const w = world(on, { list: list() })
  w.files.set(SECTIONS, DESK({ cccccccc: { section: 'probe:desk', by: 'probe' } }))
  await startSession($, w)
  const words = ['alpha', 'bravo', 'charlie', 'Desk']
  expect(await drawnOrder($, words)).toEqual(['alpha', 'bravo', 'Desk', 'charlie'])
  setFocused(w, true)
  w.files.set(SECTIONS, DESK({ cccccccc: { section: 'probe:desk', by: 'probe' }, aaaaaaaa: { section: 'probe:desk', by: 'probe', parent: 'cccccccc' } }))
  await w.clock.advance(3000)
  expect(await drawnOrder($, words)).toEqual(['alpha', 'bravo', 'Desk', 'charlie'])
  setFocused(w, false)
  await w.clock.advance(3000)
  expect(await drawnOrder($, words)).toEqual(['bravo', 'Desk', 'charlie', 'alpha'])
  const ui = await $.ui.mount(PANEL)
  expect((await ui.find({ key: `row:${SID}` }))?.text).toMatch(/^▌  ● alpha/)
  expect((await ui.find({ key: 'row:cccccccc-0000-0000-0000-000000000000' }))?.text).toMatch(/^ ● charlie  /)
  await ui.unmount()
})

test('c folds the selected session\'s section into one line, Enter on it unfolds it, and the focus follows', async ($, on) => {
  const sessionsList = list()
  sessionsList[2].status = 'waiting'
  const w = world(on, { list: sessionsList })
  w.files.set(SECTIONS, DESK({ bbbbbbbb: { section: 'probe:desk', by: 'probe' }, cccccccc: { section: 'probe:desk', by: 'probe' } }))
  await startSession($, w)
  setFocused(w, true)
  const ui = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, isFocused: true } })
  const text = async () => JSON.stringify(await ui.drawn())
  // Not in a section with a title: nothing folds
  await focusOn($, `s:${SID}`)
  await ui.press({ key: 'fold' })
  expect(w.toasts.at(-1)).toContain("isn't in a section with a title")
  await focusOn($, 's:bbbbbbbb-0000-0000-0000-000000000000')
  await ui.press({ key: 'fold' })
  expect(await text()).toContain('▸ Desk · 2 · 1 waiting for you')
  expect(await text()).not.toContain('charlie')
  expect(w.store.get('collapsed')).toEqual(['probe:desk'])
  // The keyboard goes to the folded section's line; its Enter unfolds it, and the focus goes to its first session
  await w.clock.advance(200)
  expect(w.opens.length).toBeGreaterThan(0)
  await ui.press({ key: 'h:probe:desk' })
  expect(await text()).toContain('charlie')
  expect(w.store.get('collapsed')).toEqual([])
  await ui.unmount()
})

function four(): any[] {
  return [...list(), { id: 'dddddddd', sessionId: 'dddddddd-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'idle', pid: 4245, name: 'delta' }]
}

test('c folds and unfolds with the other rows where they were: the pending sort waits until you leave the panel', async ($, on) => {
  const sessionsList = four()
  const w = world(on, { list: sessionsList })
  w.files.set(SECTIONS, DESK({ bbbbbbbb: { section: 'probe:desk', by: 'probe' }, cccccccc: { section: 'probe:desk', by: 'probe' } }))
  await startSession($, w)
  const words = ['alpha', 'delta', 'bravo', 'charlie', '▸ Desk']
  expect(await drawnOrder($, words)).toEqual(['alpha', 'delta', 'bravo', 'charlie'])
  setFocused(w, true)
  // delta now waits for you: it would go first, but nothing moves while you're in the panel
  sessionsList[3].status = 'waiting'
  await w.clock.advance(7000)
  expect(await drawnOrder($, words)).toEqual(['alpha', 'delta', 'bravo', 'charlie'])
  const ui = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, isFocused: true } })
  await focusOn($, 's:bbbbbbbb-0000-0000-0000-000000000000')
  await ui.press({ key: 'fold' })
  await ui.unmount()
  expect(await drawnOrder($, words)).toEqual(['alpha', 'delta', '▸ Desk'])
  const again = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, isFocused: true } })
  await again.press({ key: 'h:probe:desk' })
  await again.unmount()
  expect(await drawnOrder($, words)).toEqual(['alpha', 'delta', 'bravo', 'charlie'])
  // Leaving the panel applies the sort
  setFocused(w, false)
  await w.clock.advance(3000)
  expect(await drawnOrder($, words)).toEqual(['delta', 'alpha', 'bravo', 'charlie'])
})

test('folds made in another session apply here once the panel doesn\'t have the keyboard', async ($, on) => {
  const w = world(on, { list: list() })
  w.files.set(SECTIONS, DESK({ cccccccc: { section: 'probe:desk', by: 'probe' } }))
  await startSession($, w)
  setFocused(w, true)
  w.store.set('collapsed', ['probe:desk'])
  await w.clock.advance(3000)
  expect(await drawnOrder($, ['charlie', '▸ Desk'])).toEqual(['charlie'])
  setFocused(w, false)
  await w.clock.advance(3000)
  expect(await drawnOrder($, ['charlie', '▸ Desk'])).toEqual(['▸ Desk'])
})

test('⚙n: what a running background session has going on in the background, as the service counts it', async ($, on) => {
  const w = world(on, { list: list() })
  w.files.set('/Users/x/jobs/bbbbbbbb/state.json', JSON.stringify({ inFlight: { tasks: 2, drainableMonitors: 0, kinds: ['local_agent', 'local_bash'] } }))
  // An artifact watch alone isn't work
  w.files.set('/Users/x/jobs/cccccccc/state.json', JSON.stringify({ inFlight: { tasks: 1, drainableMonitors: 1, kinds: ['artifact_watch'] } }))
  await startSession($, w)
  const ui = await $.ui.mount(PANEL)
  expect((await ui.find({ key: 'row:bbbbbbbb-0000-0000-0000-000000000000' }))?.text).toContain(' ⚙2')
  expect((await ui.find({ key: 'row:cccccccc-0000-0000-0000-000000000000' }))?.text).not.toContain('⚙')
  expect(JSON.stringify(await ui.drawn())).toContain('⚙ Running in the background')
  await ui.unmount()
  // Done: gone at the next refresh
  w.files.set('/Users/x/jobs/bbbbbbbb/state.json', JSON.stringify({ inFlight: { tasks: 0, drainableMonitors: 0 } }))
  await w.clock.advance(3000)
  const again = await $.ui.mount(PANEL)
  expect(JSON.stringify(await again.drawn())).not.toContain('⚙')
  await again.unmount()
})

test('seen: a session shown in no window asks Terminal nothing; its viewer in front, with you at the computer, sees it', async ($, on) => {
  const w = world(on, { list: list(), store: { [`state:${SID}`]: { finished: 999_999_000 } } })
  await startSession($, w)
  await w.clock.advance(6000)
  // Unseen, but in no window: no AppleScript at all (a quit Terminal isn't started either)
  expect(w.runs.some(a => a[0] === 'osascript')).toBe(false)
  expect(w.store.get(`seen:${SID}`)).toBe(undefined)
  // Its viewer, in the window in front
  w.ps.value = '  101 ttys001  claude attach aaaaaaaa'
  w.terminal.value = args => (args[0] === 'frente' ? 'true /dev/ttys001' : '')
  await w.clock.advance(2000)
  expect(Number(w.store.get(`seen:${SID}`))).toBeGreaterThan(0)
  expect(w.runs.filter(a => a[0] === 'osascript')).toHaveLength(1)
})

test('seen: what another session found a moment ago (the windows, the one in front) serves this one too', async ($, on) => {
  const w = world(on, { list: list(), store: { [`state:${SID}`]: { finished: 999_999_000 } } })
  w.terminal.value = args => (args[0] === 'frente' ? 'true /dev/ttys001' : '')
  await startSession($, w)
  await w.clock.advance(6000)
  // Another session listed the windows and asked Terminal a second ago: this one's next check runs neither
  const ps = w.runs.filter(a => a[0] === 'ps').length
  w.store.set('windowsList', { at: w.clock.now() + 1000, windows: { byId: { aaaaaaaa: ['/dev/ttys001'] }, byPid: {}, agentsViews: [], clients: {}, launchers: {} } })
  w.store.set('frontWindow', { at: w.clock.now() + 1000, tty: '/dev/ttys001' })
  await w.clock.advance(2000)
  expect(Number(w.store.get(`seen:${SID}`))).toBeGreaterThan(0)
  expect(w.runs.some(a => a[0] === 'osascript')).toBe(false)
  expect(w.runs.filter(a => a[0] === 'ps').length).toBe(ps)
})

test('with the f filter, a child whose parent waits for nobody is drawn as any row, not indented under nothing', async ($, on) => {
  const sessionsList = list()
  sessionsList[2].status = 'waiting'
  const w = world(on, { list: sessionsList })
  w.files.set(SECTIONS, DESK({ cccccccc: { section: 'probe:desk', by: 'probe', parent: 'bbbbbbbb' }, bbbbbbbb: { section: 'probe:desk', by: 'probe' } }))
  await startSession($, w)
  setFocused(w, true)
  const ui = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, isFocused: true } })
  expect((await ui.find({ key: 'row:cccccccc-0000-0000-0000-000000000000' }))?.text).toMatch(/^ {3}● charlie/)
  await ui.press({ key: 'waiting' })
  expect((await ui.find({ key: 'row:cccccccc-0000-0000-0000-000000000000' }))?.text).toMatch(/^ ● charlie/)
  await ui.unmount()
})

// Stop and Restart asked in the session acted on, which can't show a dialog (its agent leaves AskUserQuestion out)
const BRAVO = 'bbbbbbbb-0000-0000-0000-000000000000'
const PEER = { kind: 'peer', plugin: 'sessions' } as const

// Bravo runs the mod (a fresh heartbeat of its process); with a window, this session is in the one in front, opened
// with ccc (the window can switch in place)
function reachableBravo(w: any, window = true) {
  w.files.set(`${DATA}/alive/${BRAVO}`, heartbeatText({ pid: 4243, at: w.clock.now() + 600000, version: '0.13.2', via: 'session.start' }))
  if (!window) return
  w.ps.value = '  100 ttys001  bash /Users/x/p/hooks/visor.sh start\n  101 ttys001  claude attach aaaaaaaa'
  w.terminal.value = (args: string[]) => (args[0] === 'frente' ? 'true /dev/ttys001' : '')
}

function sentNotices(on: any): any[] {
  const sent: any[] = []
  on('session.send', (_: any, e: any) => {
    const n = parseNotice(String(e.text))
    if (n) sent.push(n)
    return { isDelivered: true }
  })
  return sent
}

for (const window of [true, false]) {
  test(`asked to stop where no dialog can show: the answer says it wasn't shown (${window ? 'the window goes back' : "the window can't go back, and says where to go"})`, async ($, on) => {
    const w = world(on, { list: list() })
    reachableBravo(w, window)
    const sent = sentNotices(on)
    // No hook answers it, as in a session whose agent hasn't the tool: the engine has none to call
    await startSession($, w)
    await $.session.receive({ text: buildNotice('ask', { from: BRAVO, topic: 'stop', detail: '' }), origin: PEER } as any)
    await w.clock.settle()
    expect(sent.find(n => n.kind === 'answer')?.data).toMatchObject({ sessionId: SID, action: 'unshown', cameBack: window })
    expect(w.runs.some(a => a[0] === '/bin/claude' && a[1] === 'stop')).toBe(false)
    expect(w.toasts.some(t => t.includes('go back to “bravo”'))).toBe(!window)
  })
}

test('asked to stop, dismissed with Esc: the answer is a cancel, as before', async ($, on) => {
  const w = world(on, { list: list() })
  reachableBravo(w)
  const sent = sentNotices(on)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: "Error: The user doesn't want to proceed with this tool use.", isError: true }))
  await startSession($, w)
  await $.session.receive({ text: buildNotice('ask', { from: BRAVO, topic: 'stop', detail: '' }), origin: PEER } as any)
  await w.clock.settle()
  expect(sent.find(n => n.kind === 'answer')?.data).toMatchObject({ sessionId: SID, action: 'cancel' })
})

test("s on a session that can't show the question: it's asked here instead, and what's chosen is done", async ($, on) => {
  const w = world(on, { list: list() })
  reachableBravo(w)
  const sent = sentNotices(on)
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    asked++
    return { result: { answers: { [e.questions[0].question]: 'Stop' } } }
  })
  await startSession($, w)
  setFocused(w, true)
  const ui = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, isFocused: true } })
  // Bravo selected, as the arrows leave it (the engine moving the ring onto its row)
  await $.ui.focus({ requestId: 'sessions', key: `s:${BRAVO}`, element: `s:${BRAVO}`, component: 'Pane', origin: { kind: 'engine' } } as any)
  await ui.press({ key: 'stop' })
  await w.clock.settle()
  // The window went to bravo and the question was sent there, not asked here
  expect(sent.find(n => n.kind === 'ask')?.data).toMatchObject({ from: SID, topic: 'stop' })
  expect(asked).toBe(0)
  // Bravo couldn't show it: the window came back, and this session asks
  await $.session.receive({ text: buildNotice('answer', { sessionId: BRAVO, action: 'unshown', cameBack: true }), origin: PEER } as any)
  await w.clock.settle()
  expect(asked).toBe(1)
  expect(w.runs.some(a => a[0] === '/bin/claude' && a[1] === 'stop' && a[2] === 'bbbbbbbb')).toBe(true)
  // An answer nobody asked for any more does nothing
  await $.session.receive({ text: buildNotice('answer', { sessionId: BRAVO, action: 'unshown', cameBack: true }), origin: PEER } as any)
  await w.clock.settle()
  expect(asked).toBe(1)
  await ui.unmount()
})

// The asker isn't among the rows this panel shows: the f filter is on (bravo waits for nobody), or it's a session of
// another project root (delta, in no list this session reads): it's found all the same, and the answer goes back
const DELTA = 'dddddddd-0000-0000-0000-000000000000'
for (const asker of ['bravo, with the f filter on', 'delta, of another project root']) {
  test(`asked to stop by ${asker}: the answer goes back to it`, async ($, on) => {
    const w = world(on, { list: list() })
    const from = asker.startsWith('bravo') ? BRAVO : DELTA
    reachableBravo(w)
    w.store.set('waitingOnly', true)
    const sent: any[] = []
    on('session.send', (_: any, e: any) => {
      const n = parseNotice(String(e.text))
      if (n) sent.push({ to: e.to, ...n })
      return { isDelivered: true }
    })
    on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => ({ result: { answers: { [e.questions[0].question]: 'Stop' } } }))
    await startSession($, w)
    await $.session.receive({ text: buildNotice('ask', { from, topic: 'stop', detail: '', id: from.slice(0, 8), title: 'the asker', background: true }), origin: PEER } as any)
    await w.clock.settle()
    expect(sent.find(n => n.kind === 'answer')).toMatchObject({ to: from, data: { sessionId: SID, action: 'stop', cameBack: true } })
    // The window went back to the asker
    expect([...w.files].filter(([p]) => p.startsWith(`${DATA}/windows/`)).map(([, t]) => t).join()).toContain(`id=${from.slice(0, 8)}`)
  })
}

// A session whose agent has no SendMessage can't send the answer as a notice (Claude answers not delivered): it
// leaves it in the store, where the asker's panel takes it and does what was chosen
test('asked to stop where no notice can be sent: the answer waits in the store, and the asker does it', async ($, on) => {
  const w = world(on, { list: list() })
  reachableBravo(w)
  on('session.send', () => ({ isDelivered: false, reason: 'this session has no SendMessage tool' }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => ({ result: { answers: { [e.questions[0].question]: 'Stop' } } }))
  await startSession($, w)
  await $.session.receive({ text: buildNotice('ask', { from: BRAVO, topic: 'stop', detail: '', id: 'bbbbbbbb', title: 'bravo', background: true }), origin: PEER } as any)
  await w.clock.settle()
  expect(w.store.get(`answer:${BRAVO}`)).toMatchObject({ sessionId: SID, action: 'stop', cameBack: true })
  expect(w.toasts.some(t => t.includes("Couldn't hand the answer"))).toBe(false)
})

test('s on a session that answers through the store: its answer is taken and done', async ($, on) => {
  const w = world(on, { list: list() })
  reachableBravo(w)
  const sent = sentNotices(on)
  await startSession($, w)
  setFocused(w, true)
  const ui = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, isFocused: true } })
  await $.ui.focus({ requestId: 'sessions', key: `s:${BRAVO}`, element: `s:${BRAVO}`, component: 'Pane', origin: { kind: 'engine' } } as any)
  await ui.press({ key: 'stop' })
  await w.clock.settle()
  // The ask carries what bravo needs to come back here even when its panel doesn't show this session
  expect(sent.find(n => n.kind === 'ask')?.data).toMatchObject({ from: SID, topic: 'stop', id: 'aaaaaaaa', title: 'alpha', background: true })
  // Bravo couldn't send its answer: it left it in the store
  w.store.set(`answer:${SID}`, { format: FORMAT, sessionId: BRAVO, action: 'stop', cameBack: true, at: w.clock.now() })
  await w.clock.advance(600)
  await w.clock.settle()
  expect(w.runs.some(a => a[0] === '/bin/claude' && a[1] === 'stop' && a[2] === 'bbbbbbbb')).toBe(true)
  expect(w.store.has(`answer:${SID}`)).toBe(false)
  await ui.unmount()
})

test("s from a session that can't send notices (no SendMessage): it asks here, without going there", async ($, on) => {
  const w = world(on, { list: list() })
  reachableBravo(w)
  const sent = sentNotices(on)
  on('tool.list', () => ({ value: [{ name: 'Read' }, { name: 'AskUserQuestion' }] as any }))
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    asked++
    return { result: { answers: { [e.questions[0].question]: 'Stop' } } }
  })
  await startSession($, w)
  setFocused(w, true)
  const ui = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, isFocused: true } })
  await $.ui.focus({ requestId: 'sessions', key: `s:${BRAVO}`, element: `s:${BRAVO}`, component: 'Pane', origin: { kind: 'engine' } } as any)
  await ui.press({ key: 'stop' })
  await w.clock.settle()
  expect(sent.some(n => n.kind === 'ask')).toBe(false)
  expect(asked).toBe(1)
  expect(w.runs.some(a => a[0] === '/bin/claude' && a[1] === 'stop' && a[2] === 'bbbbbbbb')).toBe(true)
  await ui.unmount()
})
