import { expect, test } from 'claude-code/testing'

import { BAND, COMMAND, DATA, ROOT, SID, startSession, world } from './world'

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
