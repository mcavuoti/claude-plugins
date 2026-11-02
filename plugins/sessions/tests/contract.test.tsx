import { expect, test } from 'claude-code/testing'

import { COMMAND, DATA, ROOT, SID, startSession, world } from './world'

// $.sessions, the contract other plugins call (types/index.d.ts, docs/plugin-contract.md), seen from another plugin:
// PROBE stands for it. It calls one method per /probe and answers what came back (or what it threw) as JSON

const PROBE = {
  name: 'probe',
  register(on: any) {
    on('command.run', { command: 'probe' }, async ($: any, e: any) => {
      const { m, input } = JSON.parse(String(e.args))
      try {
        let out: unknown
        if (m === 'contract') out = await $.sessions.contract()
        else if (m === 'current') out = await $.sessions.current()
        else if (m === 'status') out = await $.sessions.status(input)
        else if (m === 'sections') out = await $.sessions.sections()
        else if (m === 'defineSection') out = await $.sessions.defineSection(input)
        else if (m === 'assignSection') out = await $.sessions.assignSection(input)
        return { text: JSON.stringify({ out }) }
      } catch (err) {
        return { text: JSON.stringify({ threw: String(err) }) }
      }
    })
  },
}
const WITH_PROBE = { plugins: [PROBE] }

async function call($: any, m: string, input?: unknown): Promise<any> {
  const r: any = await $.command.run({ command: 'probe', args: JSON.stringify({ m, input }), ...COMMAND })
  const answer = JSON.parse(r.text)
  if (answer.threw) throw new Error(answer.threw)
  return answer.out
}

const SECTIONS = `${DATA}/sections.json`
const TWO = 'bbbbbbbb-0000-0000-0000-000000000000'
const REGULAR = 'cccccccc-0000-0000-0000-000000000000'
function list(): any[] {
  return [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'one' },
    { id: 'bbbbbbbb', sessionId: TWO, cwd: '/Users/x/other', kind: 'background', status: 'waiting', pid: 4243, name: 'two' },
    { sessionId: REGULAR, cwd: ROOT, kind: 'interactive', status: 'busy', pid: 4244, name: 'myapp-1f' },
  ]
}

// The golden list: what api 1 serves. A method is never removed or renamed within an api (docs/plugin-contract.md):
// removing one here is a new api, released together with every plugin that calls it
test('contract: api 1 and its six methods, also before the mod has started here', WITH_PROBE, async ($, on) => {
  world(on)
  const c = await call($, 'contract')
  expect(c.api).toBe(1)
  expect(c.format).toBe(1)
  expect(typeof c.version).toBe('string')
  expect(c.methods).toEqual(['contract', 'current', 'status', 'sections', 'defineSection', 'assignSection'])
})

test('current and status: not ready before the start, then this session and the others from the official list', WITH_PROBE, async ($, on) => {
  const w = world(on, { list: list() })
  expect(await call($, 'current')).toEqual({ ready: false, ref: null, sessionId: '', name: '', root: '', background: false, agent: null })
  expect(await call($, 'status', { refs: ['aaaaaaaa'] })).toEqual({ ready: false, rows: [] })
  await startSession($, w)
  expect(await call($, 'current')).toEqual({ ready: true, ref: 'aaaaaaaa', sessionId: SID, name: 'one', root: ROOT, background: true, agent: null })
  const s = await call($, 'status', { refs: ['bbbbbbbb', 'zzzzzzzz', `sid:${REGULAR}`, 'bbbbbbbb'], names: ['one', 'two', 'nobody'] })
  expect(s.ready).toBe(true)
  // In order, once each: by ref, then by name; a ref not in the list is gone; a regular session is sid:<sessionId>
  expect(s.rows.map((r: any) => [r.ref, r.state])).toEqual([
    ['bbbbbbbb', 'waiting'],
    ['zzzzzzzz', 'gone'],
    [`sid:${REGULAR}`, 'working'],
    ['aaaaaaaa', 'idle'],
  ])
  // Another project's session with no heartbeat: its panel isn't running; this one's is
  expect(s.rows[0]).toEqual({ ref: 'bbbbbbbb', sessionId: TWO, name: 'two', state: 'waiting', panel: 'none', root: null, background: true, agent: null })
  expect(s.rows[1]).toEqual({ ref: 'zzzzzzzz', sessionId: null, name: null, state: 'gone', panel: 'none', root: null, background: false, agent: null })
  expect(s.rows[3]).toMatchObject({ panel: 'ok', root: ROOT })
  // What another session published about itself (its root and agent) comes through
  w.store.set(`state:${TWO}`, { root: '/Users/x/other', agent: 'scout' })
  expect((await call($, 'status', { refs: ['bbbbbbbb'] })).rows[0]).toMatchObject({ root: '/Users/x/other', agent: 'scout' })
  // Junk in the input is left out, not fatal
  expect((await call($, 'status', { refs: [1, null], names: 'one' })).rows).toEqual([])
})

test("agent: the transcript's first row says which agent the session runs as", WITH_PROBE, async ($, on) => {
  const w = world(on, { transcript: `{"type":"agent-setting","agentSetting":"scout","sessionId":"${SID}"}\n{"type":"user"` })
  await startSession($, w)
  expect((await call($, 'current')).agent).toBe('scout')
  expect((w.store.get(`state:${SID}`) as any)?.agent).toBe('scout')
  // After /clear the new conversation's transcript doesn't name it, but the process still runs as it
  const NEW = 'dddddddd-0000-0000-0000-000000000000'
  w.transcript.value = `{"type":"custom-title","customTitle":"one"}\n{"type":"user","message":{}}`
  await $.session.end({ reason: 'clear', sessionId: SID } as any)
  w.id.value = NEW
  await w.clock.advance(16000)
  expect(await call($, 'current')).toMatchObject({ sessionId: NEW, agent: 'scout' })
  expect((w.store.get(`state:${NEW}`) as any)?.agent).toBe('scout')
})

test('sections: defined and assigned before the start, from a session whose folder is gone, through sections.json', WITH_PROBE, async ($, on) => {
  const w = world(on)
  w.dirs.delete(ROOT)
  w.cwd.value = ROOT
  expect(await call($, 'sections')).toEqual({ sections: [], members: {} })
  expect(await call($, 'defineSection', { source: 'probe', spec: { id: 'probe:desk', title: '  Decisions  ' } })).toEqual({ ok: true })
  expect(await call($, 'assignSection', { source: 'probe', ref: 'bbbbbbbb', section: 'probe:desk' })).toEqual({ ok: true })
  expect(await call($, 'sections')).toEqual({
    sections: [{ id: 'probe:desk', title: 'Decisions', order: 200, owner: 'probe' }],
    members: { bbbbbbbb: { section: 'probe:desk', by: 'probe' } },
  })
  expect(JSON.parse(w.files.get(SECTIONS) ?? '{}').sectionsFormat).toBe(1)
  // Defining it again changes the title and order in place; null takes the session out
  expect(await call($, 'defineSection', { source: 'probe', spec: { id: 'probe:desk', title: 'Desk', order: 5 } })).toEqual({ ok: true })
  expect((await call($, 'sections')).sections).toEqual([{ id: 'probe:desk', title: 'Desk', order: 5, owner: 'probe' }])
  expect(await call($, 'assignSection', { source: 'probe', ref: 'bbbbbbbb', section: null })).toEqual({ ok: true })
  expect((await call($, 'sections')).members).toEqual({})
  // Every command ran in a folder that exists, and the lock was given back
  expect(w.cwds.every(c => c !== undefined && w.dirs.has(c))).toBe(true)
  expect(w.dirs.has(`${SECTIONS}.lock`)).toBe(false)
})

test("sections: a plugin defines and assigns only its own, never over the person's choice or another plugin's", WITH_PROBE, async ($, on) => {
  const w = world(on)
  w.files.set(
    SECTIONS,
    JSON.stringify({
      sectionsFormat: 1,
      sections: [
        { id: 'me:renders', title: 'Renders', order: 100, owner: 'person' },
        { id: 'probe:desk', title: 'Desk', order: 200, owner: 'probe' },
        { id: 'other:x', title: 'X', order: 200, owner: 'other' },
      ],
      members: { aaaaaaaa: { section: 'me:renders', by: 'person' }, cccccccc: { section: 'other:x', by: 'other' } },
    }),
  )
  const before = w.files.get(SECTIONS)
  const refused = async (m: string, input: unknown) => (await call($, m, input)).reason
  expect(await refused('defineSection', { source: 'me', spec: { id: 'me:x', title: 'X' } })).toBe('refused')
  expect(await refused('defineSection', { source: 'sessions', spec: { id: 'sessions:x', title: 'X' } })).toBe('refused')
  expect(await refused('defineSection', { source: 'probe', spec: { id: 'other:y', title: 'Y' } })).toBe('refused')
  expect(await refused('defineSection', { source: 'probe', spec: { id: 'desk', title: 'Y' } })).toBe('invalid')
  expect(await refused('defineSection', { source: 'probe', spec: { id: 'probe:y', title: '' } })).toBe('invalid')
  expect(await refused('assignSection', { source: 'probe', ref: 'aaaaaaaa', section: 'probe:desk' })).toBe('refused')
  expect(await refused('assignSection', { source: 'probe', ref: 'aaaaaaaa', section: null })).toBe('refused')
  expect(await refused('assignSection', { source: 'probe', ref: 'cccccccc', section: 'probe:desk' })).toBe('refused')
  expect(await refused('assignSection', { source: 'probe', ref: 'dddddddd', section: 'other:x' })).toBe('refused')
  expect(await refused('assignSection', { source: 'probe', ref: 'dddddddd', section: 'probe:none' })).toBe('invalid')
  expect(await refused('assignSection', { source: 'probe', ref: 'not a ref', section: 'probe:desk' })).toBe('invalid')
  expect((await call($, 'assignSection', { source: 'probe', ref: 'aaaaaaaa', section: 'probe:desk' })).detail).toContain('Renders')
  expect(w.files.get(SECTIONS)).toBe(before)
})

test('sections: a lock held by another session answers busy at once, and nothing is written', WITH_PROBE, async ($, on) => {
  const w = world(on)
  w.dirs.add(`${SECTIONS}.lock`)
  w.made.set(`${SECTIONS}.lock`, w.clock.now())
  // The call waits a few 50 ms beats for the lock (on the test's clock), and no more
  const pending = call($, 'defineSection', { source: 'probe', spec: { id: 'probe:desk', title: 'Desk' } })
  await w.clock.advance(400)
  const r = await pending
  expect(r.ok).toBe(false)
  expect(r.reason).toBe('busy')
  expect(w.files.has(SECTIONS)).toBe(false)
  // A lock left behind long ago is stale and taken over
  w.made.set(`${SECTIONS}.lock`, w.clock.now() - 60000)
  const retried = call($, 'defineSection', { source: 'probe', spec: { id: 'probe:desk', title: 'Desk' } })
  await w.clock.advance(100)
  expect(await retried).toEqual({ ok: true })
})

test('sections: a sections.json from a newer sessions is left alone, refused with a restart, and the panel says so', WITH_PROBE, async ($, on) => {
  const w = world(on)
  const newer = JSON.stringify({ sectionsFormat: 2, sections: [], members: {}, later: true })
  w.files.set(SECTIONS, newer)
  const r = await call($, 'defineSection', { source: 'probe', spec: { id: 'probe:desk', title: 'Desk' } })
  expect(r.reason).toBe('refused')
  expect(r.detail).toContain('restart')
  let threw = ''
  try {
    await call($, 'sections')
  } catch (err) {
    threw = String(err)
  }
  expect(threw).toContain('newer sessions')
  expect(w.files.get(SECTIONS)).toBe(newer)
  await startSession($, w)
  const ui = await $.ui.mount({ plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  expect(JSON.stringify(await ui.drawn())).toContain('sections.json is from a newer sessions')
  await ui.unmount()
})
