import { expect, test } from 'claude-code/testing'

import { COMMAND, DATA, ROOT, SID, startSession, world } from './world'

// Sections in the panel: the person's /sessions section, the headers, the freeze while the panel has the keyboard, and
// sections.json kept tidy (members of gone sessions, a regular session's /clear)

const SECTIONS = `${DATA}/sections.json`
const PANEL = { plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

function list(): any[] {
  return [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'one' },
    { id: 'bbbbbbbb', sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'idle', pid: 4243, name: 'two' },
    { id: 'cccccccc', sessionId: 'cccccccc-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'idle', pid: 4244, name: 'three' },
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
  const words = ['one', 'two', 'three', 'Renders']
  expect(await drawnOrder($, words)).toEqual(['one', 'three', 'two'])
  expect(await sessions($, 'section Renders')).toBe('This session is in “Renders” now')
  await w.clock.advance(3000)
  // In no section first, with no header; then the section's title above its rows
  expect(await drawnOrder($, words)).toEqual(['three', 'two', 'Renders', 'one'])
  expect(await sessions($, 'section')).toContain('This session is in “Renders”')
  expect(await sessions($, 'sections')).toContain('Renders · 1 session')
  expect(JSON.parse(w.files.get(SECTIONS) ?? '{}').members).toEqual({ aaaaaaaa: { section: 'me:renders', by: 'person' } })
  // Out of it: the section goes (nobody's in it), and so does the header
  expect(await sessions($, 'section -')).toBe('This session is in no section now')
  await w.clock.advance(3000)
  expect(await drawnOrder($, words)).toEqual(['one', 'three', 'two'])
  expect(JSON.parse(w.files.get(SECTIONS) ?? '{}').sections).toEqual([])
  // The order file ccc reads stays the usual order, whatever the sections
  expect((w.files.get(`${DATA}/order/_Users_x_myapp`) ?? '').split('\n').filter(l => l.startsWith('row=')).map(l => l.split('\t')[2])).toEqual(['aaaaaaaa', 'cccccccc', 'bbbbbbbb'])
})

test('while the panel has the keyboard, sections and their members stay put; they apply when it leaves', async ($, on) => {
  const w = world(on, { list: list() })
  w.files.set(SECTIONS, JSON.stringify({ sectionsFormat: 1, sections: [{ id: 'probe:desk', title: 'Desk', order: 10, owner: 'probe' }], members: {} }))
  await startSession($, w)
  const words = ['one', 'two', 'three', 'Desk']
  expect(await drawnOrder($, words)).toEqual(['one', 'three', 'two'])
  setFocused(w, true)
  w.files.set(SECTIONS, JSON.stringify({ sectionsFormat: 1, sections: [{ id: 'probe:desk', title: 'Desk', order: 10, owner: 'probe' }], members: { bbbbbbbb: { section: 'probe:desk', by: 'probe' } } }))
  await w.clock.advance(6000)
  expect(await drawnOrder($, words)).toEqual(['one', 'three', 'two'])
  setFocused(w, false)
  await w.clock.advance(3000)
  expect(await drawnOrder($, words)).toEqual(['one', 'three', 'Desk', 'two'])
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
