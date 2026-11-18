import { expect, test } from 'claude-code/testing'

import { personPin } from '../hooks/state'
import { panelRing, ROOT, SID, startSession, world, type World } from './world'

// p in the panel: the person's own pin of the selected background session (◆), so the background service doesn't close
// it for being idle; p again unpins it. Remote Control's automatic pins and other plugins' are in panel.test.tsx

const JOBS = '/Users/x/jobs'
const PINS = `${JOBS}/pins.json`
const BRAVO = 'bbbbbbbb-0000-0000-0000-000000000000'
const DELTA = 'dddddddd-0000-0000-0000-000000000000'
const PANEL = { plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

function list(): any[] {
  return [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'alpha' },
    { id: 'bbbbbbbb', sessionId: BRAVO, cwd: ROOT, kind: 'background', status: 'idle', pid: 4243, name: 'bravo' },
    { sessionId: DELTA, cwd: ROOT, kind: 'interactive', status: 'idle', pid: 4245, name: 'delta' },
  ]
}

const pins = (w: World): string[] => JSON.parse(w.files.get(PINS) ?? '[]')

test('personPin: a session not pinned is pinned and is the person’s; a pinned one is unpinned, whoever pinned it', () => {
  const none = { ids: [], added: [] }
  // Pinned: after the ones already there
  expect(personPin(['x'], null, none, 'b')).toEqual({ pinned: true, pins: ['x', 'b'], auto: null, plugin: none, wasPlugin: false })
  // One Remote Control's pin had released, or a plugin had added: it's the person's from now on
  expect(personPin([], { ids: ['b', 'c'], released: ['b'] }, { ids: ['b'], added: ['b'] }, 'b')).toEqual({ pinned: true, pins: ['b'], auto: { ids: ['c'], released: [] }, plugin: { ids: ['b'], added: [] }, wasPlugin: false })
  // Unpinned: gone from the pins, and Remote Control's record is left for its own pass to read
  const auto = { ids: ['b'], released: [] }
  expect(personPin(['x', 'b'], auto, none, 'b')).toEqual({ pinned: false, pins: ['x'], auto, plugin: none, wasPlugin: false })
  // A plugin had asked to keep it pinned: its wish goes too, and that's said
  expect(personPin(['b'], null, { ids: ['b', 'c'], added: ['b'] }, 'b')).toEqual({ pinned: false, pins: [], auto: null, plugin: { ids: ['c'], added: [] }, wasPlugin: true })
})

test('p: pins the selected background session (◆ on its row), and p again unpins it; the keys above the list have p and no a', async ($, on) => {
  const w = world(on, { list: list() })
  await startSession($, w)
  await w.clock.advance(4000)
  const pane = w.panes.find((p: any) => p.id === 'sessions')
  pane.isFocused = true
  const ui = await $.ui.mount(PANEL as any)
  expect((await ui.find({ key: 'pin' }))?.props).toMatchObject({ hotkey: 'p', label: 'Pin' })
  expect(await ui.find({ key: 'agents' })).toBe(undefined)
  const ring = panelRing($, w, ui)
  expect(await ring.put(`s:${BRAVO}`)).toBe(`s:${BRAVO}`)
  // Pinned: in pins.json as Claude writes it, said, and drawn
  await ui.press({ key: 'pin' })
  await w.clock.settle()
  expect(pins(w)).toEqual(['bbbbbbbb'])
  expect(w.files.get(PINS)).toBe(JSON.stringify(['bbbbbbbb'], null, 2))
  expect(w.toasts.at(-1)).toBe("“bravo” pinned: the background service won't close it for being idle")
  expect(w.dirs.has(`${PINS}.lock`)).toBe(false)
  await w.clock.advance(4000)
  expect(JSON.stringify(await ui.drawn())).toContain('◆')
  // Unpinned: gone from pins.json, with the place it had among the pinned ones
  const from = w.runs.length
  await ui.press({ key: 'pin' })
  await w.clock.settle()
  expect(pins(w)).toEqual([])
  expect(w.toasts.at(-1)).toBe('“bravo” unpinned')
  expect(w.runs.slice(from)).toContainEqual(['rm', '-f', `${JOBS}/bbbbbbbb/order`])
  await ui.unmount()
})

test("p on a regular session, or with nothing selected, changes nothing and says why; a pin another session made stays", async ($, on) => {
  const w = world(on, { list: list() })
  w.write(PINS, JSON.stringify(['zzzzzzzz'], null, 2))
  await startSession($, w)
  await w.clock.advance(4000)
  const pane = w.panes.find((p: any) => p.id === 'sessions')
  pane.isFocused = true
  const ui = await $.ui.mount(PANEL as any)
  const ring = panelRing($, w, ui)
  expect(await ring.put(`s:${DELTA}`)).toBe(`s:${DELTA}`)
  await ui.press({ key: 'pin' })
  await w.clock.settle()
  expect(w.toasts.at(-1)).toBe("“delta” isn't a background session: only those are pinned")
  expect(pins(w)).toEqual(['zzzzzzzz'])
  // A background one: pinned after what was there
  expect(await ring.put(`s:${BRAVO}`)).toBe(`s:${BRAVO}`)
  await ui.press({ key: 'pin' })
  await w.clock.settle()
  expect(pins(w)).toEqual(['zzzzzzzz', 'bbbbbbbb'])
  await ui.unmount()
})

test("p on a session a plugin keeps pinned: unpinned, the plugin's wish dropped, and said; one Remote Control's pin had released is the person's once pinned", async ($, on) => {
  const w = world(on, { list: list(), store: { pluginPins: { ids: ['bbbbbbbb'], added: ['bbbbbbbb'] }, autoPins: { ids: [], released: ['aaaaaaaa'] } } })
  w.write(PINS, JSON.stringify(['bbbbbbbb'], null, 2))
  await startSession($, w)
  await w.clock.advance(4000)
  const pane = w.panes.find((p: any) => p.id === 'sessions')
  pane.isFocused = true
  const ui = await $.ui.mount(PANEL as any)
  const ring = panelRing($, w, ui)
  expect(await ring.put(`s:${BRAVO}`)).toBe(`s:${BRAVO}`)
  await ui.press({ key: 'pin' })
  await w.clock.settle()
  expect(pins(w)).toEqual([])
  expect(w.toasts.at(-1)).toBe('“bravo” unpinned (a plugin had asked to keep it pinned, and may pin it again)')
  expect(w.store.get('pluginPins')).toEqual({ ids: [], added: [] })
  // This session itself, which Remote Control's pin had let go: pinned by the person, and no longer "released"
  expect(await ring.put(`s:${SID}`)).toBe(`s:${SID}`)
  await ui.press({ key: 'pin' })
  await w.clock.settle()
  expect(pins(w)).toEqual(['aaaaaaaa'])
  expect(w.store.get('autoPins')).toEqual({ ids: [], released: [] })
  await ui.unmount()
})

test('the usage block: its scope key is a, now that p pins', async ($, on) => {
  const w = world(on, { list: list() })
  await startSession($, w)
  await w.clock.advance(4000)
  const ui = await $.ui.mount(PANEL as any)
  const scope = await ui.find({ key: 'usage-scope' })
  if (scope) expect(scope.props.hotkey).toBe('a')
  const hotkeys = (await ui.findAll({ type: 'Button' })).map((b: any) => b.props?.hotkey).filter(Boolean)
  // No key is on two buttons
  expect(new Set(hotkeys).size).toBe(hotkeys.length)
  expect(hotkeys).toContain('p')
  await ui.unmount()
})
