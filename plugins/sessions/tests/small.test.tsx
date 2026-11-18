import { expect, test } from 'claude-code/testing'

import { compactRows, displayWidth, fitBand, heartbeatText, nextWaiting, sessionByName, smallWindow } from '../hooks/state'
import { BAND, COMMAND, DATA, panelRing, ROOT, SID, startSession, world, type World } from './world'

// The panel on a small terminal (ssh from a phone, a narrow window): Claude seats it above the prompt, not at the side.
// There the line above the prompt is what stays on screen, cut to its width; /sessions calls the list up as a compact
// block that goes away on a pick or Esc; and /sessions next and /sessions <name> switch without the list

const BRAVO = 'bbbbbbbb-0000-0000-0000-000000000000'
const CHARLIE = 'cccccccc-0000-0000-0000-000000000000'
// A command typed in a terminal of 48 columns, and the block Claude seats there
const SMALL = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 48 } } as const
const BLOCK = {
  plugin: 'sessions',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'sessions',
  props: { title: 'Sessions', isFocused: true, bodyColumns: 46, placement: 'inline', scroll: { offset: 0, bodyRows: 8 }, view: {} },
  viewport: { rows: 16, columns: 48, isFullscreen: true },
} as const

function list(): any[] {
  return [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'alpha' },
    { id: 'bbbbbbbb', sessionId: BRAVO, cwd: ROOT, kind: 'background', status: 'waiting', pid: 4243, name: 'bravo' },
    { id: 'cccccccc', sessionId: CHARLIE, cwd: ROOT, kind: 'background', status: 'busy', pid: 4244, name: 'charlie' },
  ]
}

async function run($: any, args: string, how: object = COMMAND): Promise<string | undefined> {
  const r: any = await $.command.run({ command: 'sessions', args, ...how })
  return r.text
}

// Everything a drawing says, in order: its text and its buttons' labels (with their key, as Claude draws them)
function textOf(node: any): string {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const label = node.props?.label !== undefined ? `${node.props.hotkey ? `${node.props.hotkey}: ` : ''}${node.props.label}` : ''
  return label + textOf(node.children)
}

// The mod's own row of the band: the first row laid out left to right
function bandRow(node: any): any {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) return node.map(bandRow).find(Boolean) ?? null
  if (node.props?.flexDirection === 'row') return node
  return bandRow(node.children)
}

async function band($: any, bodyColumns: number, columns: number): Promise<string> {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns }, viewport: { rows: 32, columns, isFullscreen: true } } as any)
  const text = textOf(bandRow(await ui.drawn()))
  await ui.unmount()
  return text
}

test('compactRows: every session a row, who needs the person first, then finished, working, idle and stopped, each group in its order', () => {
  const row = (title: string, color: string, more: object = {}) => ({ title, color, section: 's1', sectionTitle: 'One', folded: true, depth: 1, ...more }) as any
  const out = compactRows([row('idle a', 'green'), row('working', 'blue'), row('stopped', 'gray'), row('done', 'yellow'), row('asks', 'red'), row('idle b', 'green'), row('marked', 'green', { needsPerson: true })])
  expect(out.map(r => r.title)).toEqual(['asks', 'marked', 'done', 'working', 'idle a', 'idle b', 'stopped'])
  // No section, fold or indent is left: the list draws no header and folds nothing
  expect(out.every(r => r.section === '' && r.sectionTitle === '' && r.folded === false && r.depth === 0)).toBe(true)
})

test('nextWaiting and sessionByName: where /sessions next and /sessions <name> go', () => {
  const rows = [
    { title: 'alpha', color: 'green', current: true },
    { title: 'Build one', color: 'yellow', current: false },
    { title: 'build two', color: 'red', current: false },
    { title: 'docs', color: 'blue', current: false },
  ] as any[]
  expect(nextWaiting(rows)?.title).toBe('build two')
  expect(nextWaiting(rows.filter(r => r.color !== 'red'))?.title).toBe('Build one')
  expect(nextWaiting(rows.filter(r => r.color === 'green' || r.color === 'blue'))).toBe(null)
  // This session itself is never where "next" goes
  expect(nextWaiting([{ title: 'alpha', color: 'red', current: true }] as any[])).toBe(null)
  expect(sessionByName(rows, 'DOCS')).toEqual({ row: rows[3] })
  expect(sessionByName(rows, 'do')).toEqual({ row: rows[3] })
  expect(sessionByName(rows, 'two')).toEqual({ row: rows[2] })
  expect(sessionByName(rows, 'build')).toEqual({ several: [rows[1], rows[2]] })
  expect(sessionByName(rows, 'build one')).toEqual({ row: rows[1] })
  expect(sessionByName(rows, 'zzz')).toBe(null)
  expect(sessionByName(rows, '  ')).toBe(null)
})

test('fitBand: the parts that fit the width, the most needed first, a short form grown when there is room; smallWindow', () => {
  const parts = [
    { key: 'counts', text: '● 2' },
    { key: 'names', text: 'build two, docs' },
    { key: 'hint', text: 'panel closed · /sessions to open', short: '/sessions' },
    { key: 'id', text: '⟨aaaaaaaa⟩' },
  ]
  const order = ['counts', 'hint', 'names', 'id']
  const fit = (width: number) => fitBand(parts, order, width).map(p => p.text)
  expect(fit(200)).toEqual(['● 2', 'build two, docs', 'panel closed · /sessions to open', '⟨aaaaaaaa⟩'])
  expect(fit(44)).toEqual(['● 2', 'build two, docs', '/sessions', '⟨aaaaaaaa⟩'])
  // A part that doesn't fit is left out, and a smaller one after it may still go in
  expect(fit(30)).toEqual(['● 2', '/sessions', '⟨aaaaaaaa⟩'])
  expect(fit(31)).toEqual(['● 2', 'build two, docs', '/sessions'])
  expect(fit(14)).toEqual(['● 2', '/sessions'])
  // The first of the order stays whatever the width; an empty part is never kept
  expect(fit(1)).toEqual(['● 2'])
  expect(fitBand([{ key: 'counts', text: '' }, { key: 'id', text: '⟨a⟩' }], ['counts', 'id'], 40).map(p => p.key)).toEqual(['id'])
  for (const width of [14, 20, 30, 44, 60]) expect(displayWidth(fit(width).join('  '))).toBeLessThanOrEqual(width)
  expect(smallWindow({ isFullscreen: true, columns: 109 })).toBe(true)
  expect(smallWindow({ isFullscreen: true, columns: 110 })).toBe(false)
  expect(smallWindow({ isFullscreen: false, columns: 200 })).toBe(true)
  expect(smallWindow(undefined)).toBe(false)
})

test('the line above the prompt on a small terminal: who needs you, who they are, how many work and how to open the list, never wider than it has', async ($, on) => {
  const w = world(on, { list: list(), placed: false })
  await startSession($, w)
  await w.clock.advance(4000)
  // A phone held upright: the counts and the way in, and nothing that would wrap
  const narrow = await band($, 43, 48)
  expect(narrow).toContain('● 1')
  expect(narrow).toContain('/sessions')
  expect(narrow).not.toContain('panel hidden')
  expect(displayWidth(narrow.trimEnd())).toBeLessThanOrEqual(43)
  // On its side: the name of the one that waits and how many work too
  const wider = await band($, 75, 80)
  expect(wider).toContain('bravo')
  expect(wider).toContain('1 working')
  expect(wider).toContain('/sessions')
  expect(displayWidth(wider.trimEnd())).toBeLessThanOrEqual(75)
  for (const columns of [20, 30, 43, 60, 75, 104]) expect(displayWidth((await band($, columns, columns + 5)).trimEnd())).toBeLessThanOrEqual(columns)
  // A window wide enough to dock the panel, where it waits undrawn: said in full, as before
  expect(await band($, 125, 130)).toContain('panel hidden: window too narrow · /sessions to show')
})

test('/sessions on a small terminal: the list comes up with the keyboard, set to go away on Esc, and nothing is printed or remembered as closed', async ($, on) => {
  const w = world(on, { list: list() })
  await startSession($, w)
  await w.clock.advance(4000)
  const opens = w.opens.length
  expect(await run($, '', SMALL)).toBe(undefined)
  await w.clock.settle()
  expect(w.opens.slice(opens).some((o: any) => o.id === 'sessions' && o.focus === true && o.closeOnEscape === true)).toBe(true)
  expect(w.store.has('panelClosed')).toBe(false)

  const ui = await $.ui.mount(BLOCK as any)
  const text = textOf(await ui.drawn())
  // Rows only: no legend, the one that waits first, then the one working, then this idle one
  expect(text).not.toContain('Attention')
  expect(text).not.toContain('Idle')
  expect(['bravo', 'charlie', 'alpha'].map(n => text.indexOf(n)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]!))).toBe(true)
  // Under them, while it has the keyboard: the keys a small screen needs, and how to leave
  expect(text).toContain('s: Stop · u: Restart · r: Rename · n: New · p: Pin · f: Waiting · ↑↓ Enter · Esc closes')
  expect(await ui.find({ key: 'agents' })).toBe(undefined)
  expect(await ui.find({ key: 'fold' })).toBe(undefined)
  // The arrows go down the list as it's drawn
  const ring = panelRing($, w, ui)
  expect(await ring.put(`s:${BRAVO}`)).toBe(`s:${BRAVO}`)
  expect(await ring.arrow('down')).toBe(`s:${CHARLIE}`)
  expect(await ring.arrow('down')).toBe(`s:${SID}`)
  await ui.unmount()
  // The block is asked to be as tall as its list (three sessions and the two lines of keys), no more
  await w.clock.settle()
  expect(w.opens.slice(opens).some((o: any) => o.id === 'sessions' && o.rows === 5 && o.closeOnEscape === true)).toBe(true)

  // Without the keyboard the block is the list alone
  const quiet = await $.ui.mount({ ...BLOCK, props: { ...BLOCK.props, isFocused: false } } as any)
  expect(textOf(await quiet.drawn())).not.toContain('Stop')
  expect(await quiet.find({ key: 'stop' })).toBe(undefined)
  await quiet.unmount()
})

test('a list longer than its block says how many are below, counted against the block and not the terminal', async ($, on) => {
  const many = Array.from({ length: 12 }, (_, i) => {
    const n = String(i).padStart(2, '0')
    return { id: `dddddd${n}`, sessionId: `dddddd${n}-0000-0000-0000-000000000000`, cwd: ROOT, kind: 'background', status: 'idle', pid: 5000 + i, name: `session ${n}` }
  })
  const w = world(on, { list: [list()[0], ...many] })
  await startSession($, w)
  await w.clock.advance(4000)
  await run($, '', SMALL)
  await w.clock.settle()
  // 8 rows: the line itself and 7 of the 13 sessions (the keys go under the list, out of view until the end of it)
  const ui = await $.ui.mount(BLOCK as any)
  expect(textOf(await ui.drawn())).toContain('↓ 6 more below')
  await ui.unmount()
})

test('the list called up goes away on a pick and on /sessions again, and neither counts as the panel closed by you', async ($, on) => {
  const w = world(on, { list: list() })
  await startSession($, w)
  await w.clock.advance(4000)
  const shown = () => w.panes.some((p: any) => p.id === 'sessions')
  // Enter on this session's own row: back to the prompt, and the list is gone
  await run($, '', SMALL)
  await w.clock.settle()
  const ui = await $.ui.mount(BLOCK as any)
  await ui.press({ key: `s:${SID}` })
  await w.clock.settle()
  await ui.unmount()
  expect(shown()).toBe(false)
  expect(w.store.has('panelClosed')).toBe(false)
  // /sessions again while it has the keyboard sends it away too (Esc is Claude's own close, tried in a real session)
  await run($, '', SMALL)
  await w.clock.settle()
  expect(shown()).toBe(true)
  expect(await run($, '', SMALL)).toBe(undefined)
  await w.clock.settle()
  expect(shown()).toBe(false)
  expect(w.store.has('panelClosed')).toBe(false)
})

// A window opened with ccc that shows this session, so a switch has a launcher to ask
function shownByCcc(w: World) {
  w.files.set(`${DATA}/alive/${BRAVO}`, heartbeatText({ pid: 4243, at: w.clock.now() + 600000, version: '0.13.2', via: 'session.start' }))
  w.ps.value = '  100 ttys001  bash /Users/x/p/hooks/visor.sh start\n  101 ttys001  claude attach aaaaaaaa'
  w.terminal.value = (args: string[]) => (args[0] === 'frente' ? 'true /dev/ttys001' : '')
}

test('/sessions next and /sessions <name>: straight to the session, with nothing printed; and what each says when it cannot', async ($, on) => {
  const w = world(on, { list: list() })
  shownByCcc(w)
  on('session.send', () => ({ isDelivered: true }))
  await startSession($, w)
  await w.clock.advance(4000)
  // next: the one that waits for you
  let from = w.runs.length
  expect(await run($, 'next')).toBe(undefined)
  await w.clock.settle()
  expect(w.runs.slice(from)).toContainEqual(['kill', '-HUP', '101'])
  expect(w.files.get(`${DATA}/windows/_dev_ttys001`)).toContain('id=bbbbbbbb\n')
  // by name: the start of it is enough
  from = w.runs.length
  expect(await run($, 'char')).toBe(undefined)
  await w.clock.settle()
  expect(w.files.get(`${DATA}/windows/_dev_ttys001`)).toContain('id=cccccccc\n')
  // What it says when there's nowhere to go: this session itself, no such name
  from = w.runs.length
  expect(await run($, 'alpha')).toBe("You're in “alpha” already")
  expect(await run($, 'zulu')).toBe('No session here is named “zulu”. There are: alpha, bravo, charlie')
  expect(w.runs.slice(from).filter(a => a[0] === 'kill')).toEqual([])
})

test('/sessions <name> that fits several names them, and /sessions next with nobody waiting says so', async ($, on) => {
  const two = list().map(s => (s.name === 'bravo' ? { ...s, name: 'charm', status: 'idle' } : s))
  const w = world(on, { list: two })
  await startSession($, w)
  await w.clock.advance(4000)
  expect(await run($, 'cha')).toBe('“cha” fits several: charm, charlie')
  expect(await run($, 'next')).toBe('Nobody is waiting for you, and nothing finished unseen.')
})

test('on a wide terminal /sessions is the docked panel as ever: no picker, and closing it is remembered', async ($, on) => {
  const w = world(on, { list: list() })
  await startSession($, w)
  await w.clock.advance(4000)
  const opens = w.opens.length
  // The panel is open without the keyboard: /sessions gives it the keyboard
  expect(await run($, '')).toBe(undefined)
  await w.clock.settle()
  expect(w.opens.slice(opens).some((o: any) => o.id === 'sessions' && o.closeOnEscape === true)).toBe(false)
  // And again closes it, by the person's choice
  expect(await run($, '')).toBe(undefined)
  await w.clock.settle()
  expect(w.panes.some((p: any) => p.id === 'sessions')).toBe(false)
  expect(w.store.get('panelClosed')).toBe(true)
})

test("a block Claude seats above the prompt by itself goes away, and the panel comes back once the terminal is wide enough to dock it", async ($, on) => {
  const w = world(on, { list: list() })
  await startSession($, w)
  await w.clock.advance(4000)
  const shown = () => w.panes.some((p: any) => p.id === 'sessions')
  // The panel the session opened at its start, drawn above the prompt by a narrow window: nobody called it
  expect(shown()).toBe(true)
  const ui = await $.ui.mount(BLOCK as any)
  await w.clock.settle()
  await ui.unmount()
  expect(shown()).toBe(false)
  expect(w.store.has('panelClosed')).toBe(false)
  // The line above the prompt in that narrow window says how to call the list
  expect(await band($, 43, 48)).toContain('/sessions')
  expect(shown()).toBe(false)
  // The window is made wide: the panel is opened again, to be docked
  await band($, 195, 200)
  await w.clock.settle()
  expect(shown()).toBe(true)
})
