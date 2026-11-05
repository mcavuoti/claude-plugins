import { expect, test } from 'claude-code/testing'

import { keepPluginPins, pluginPinChange } from '../hooks/state'
import { WATCH_SET } from '../hooks/watch'
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
        else if (m === 'start') out = await $.sessions.start(input)
        else if (m === 'wake') out = await $.sessions.wake(input)
        else if (m === 'setMarks') out = await $.sessions.setMarks(input)
        else if (m === 'pin') out = await $.sessions.pin(input)
        else if (m === 'restart') out = await $.sessions.restart(input)
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
test('contract: api 1 and its methods, also before the mod has started here', WITH_PROBE, async ($, on) => {
  world(on)
  const c = await call($, 'contract')
  expect(c.api).toBe(1)
  expect(c.format).toBe(3)
  expect(typeof c.version).toBe('string')
  expect(c.methods).toEqual(['contract', 'current', 'status', 'sections', 'defineSection', 'assignSection', 'start', 'wake', 'setMarks', 'pin', 'restart'])
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
  // Under a parent session: kept with the member, and dropped by an assignment without one
  expect(await call($, 'assignSection', { source: 'probe', ref: 'bbbbbbbb', section: 'probe:desk', parent: 'aaaaaaaa' })).toEqual({ ok: true })
  expect((await call($, 'sections')).members).toEqual({ bbbbbbbb: { section: 'probe:desk', by: 'probe', parent: 'aaaaaaaa' } })
  expect(await call($, 'assignSection', { source: 'probe', ref: 'bbbbbbbb', section: 'probe:desk', parent: null })).toEqual({ ok: true })
  expect((await call($, 'sections')).members).toEqual({ bbbbbbbb: { section: 'probe:desk', by: 'probe' } })
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

test('start: checked, queued and started from the mod\'s own timer, with its agent and settings; refusals say why', WITH_PROBE, async ($, on) => {
  const w = world(on, { list: list() })
  const SETTINGS_FILE = `${ROOT}/.claude/fleet/instances/w.json`
  w.files.set(SETTINGS_FILE, '{}')
  // Before the mod has read the list here it can't check the name
  expect((await call($, 'start', { name: 'TEST w', cwd: ROOT })).reason).toBe('not-ready')
  await startSession($, w)
  const reason = async (input: unknown) => {
    const r = await call($, 'start', input)
    return `${r.reason}: ${r.detail}`
  }
  expect(await reason({ name: '', cwd: ROOT })).toContain('invalid')
  expect(await reason({ name: 'TEST w', cwd: 'myapp' })).toContain('invalid')
  expect(await reason({ name: 'TEST w', cwd: `${ROOT}/../x` })).toContain('invalid')
  expect(await reason({ name: 'TEST w', cwd: ROOT, agent: 'no spaces please' })).toContain('invalid')
  expect(await reason({ name: 'TEST w', cwd: '/Users/x/nowhere' })).toBe("invalid: /Users/x/nowhere isn't a folder")
  expect(await reason({ name: 'TEST w', cwd: ROOT, settings: '/Users/x/settings.json' })).toBe(`refused: a settings file inside ${ROOT}/.claude/`)
  expect(await reason({ name: 'TEST w', cwd: ROOT, settings: `${ROOT}/.claude/missing.json` })).toContain("invalid: ")
  expect(await reason({ name: 'TEST w', cwd: '/Users/x' })).toBe("refused: Claude doesn't start background sessions in your home folder")
  // A name the project already has (a regular session's too)
  expect(await reason({ name: 'myapp-1f', cwd: ROOT })).toBe(`refused: a session named “myapp-1f” is already in ${ROOT}`)
  const before = w.runs.length
  expect(await call($, 'start', { name: ' TEST  w ', cwd: `${ROOT}/`, agent: 'scout', settings: SETTINGS_FILE })).toEqual({ ok: true, queued: true })
  // The same name again while it's queued
  expect(await reason({ name: 'TEST w', cwd: ROOT })).toBe(`refused: a session named “TEST w” is already in ${ROOT}`)
  // Nothing ran inside the call: the mod's timer starts it, in that folder
  expect(w.runs.slice(before).some(a => a[1] === '--bg')).toBe(false)
  await w.clock.advance(600)
  const i = w.runs.findIndex(a => a[1] === '--bg')
  expect(w.runs[i]).toEqual(['/bin/claude', '--bg', '--agent', 'scout', '--settings', SETTINGS_FILE, '-n', 'TEST w'])
  expect(w.cwds[i]).toBe(ROOT)
  expect(w.toasts).toEqual([])
  // A folder Claude doesn't trust: said in this session when it's tried
  w.bgError.value = 'Workspace not trusted. Run `claude` in /Users/x/myapp once and accept the trust prompt, then retry.'
  expect(await call($, 'start', { name: 'TEST v', cwd: ROOT })).toEqual({ ok: true, queued: true })
  await w.clock.advance(600)
  expect(w.toasts).toEqual([`Couldn't start “TEST v”: Claude doesn't trust ${ROOT} yet, so it can't start a session there in the background: run claude there once and accept its question`])
})

test('wake: only a background session the service retired for being idle is restarted; the rest is running or refused with why', WITH_PROBE, async ($, on) => {
  const sessionsList = [
    ...list(),
    { id: 'dddddddd', sessionId: 'dddddddd-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', name: 'idle one' },
    { id: 'eeeeeeee', sessionId: 'eeeeeeee-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', name: 'stopped one' },
    { id: 'ffffffff', sessionId: 'ffffffff-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', name: 'memory one' },
  ]
  const w = world(on, { list: sessionsList })
  w.files.set(
    '/Users/x/daemon.log',
    [
      '[2026-10-26T10:00:00.000Z] [bg] bg retire dddddddd: settled, idle 61m',
      '[2026-10-26T10:00:01.000Z] [bg] bg settled dddddddd (done)',
      // Stopped by the person: the process ends with no retire before it
      '[2026-10-26T10:00:02.000Z] [bg] bg settled eeeeeeee (killed)',
      '[2026-10-26T10:00:03.000Z] [bg] bg retire ffffffff: settled, idle 38h [low memory, pinned]',
    ].join('\n'),
  )
  expect((await call($, 'wake', { ref: 'dddddddd', reason: 'x' })).reason).toBe('not-ready')
  await startSession($, w)
  expect(await call($, 'wake', { ref: 'aaaaaaaa', reason: 'x' })).toEqual({ ok: true, state: 'running' })
  const refused = async (ref: string) => {
    const r = await call($, 'wake', { ref, reason: 'x' })
    expect(r.state).toBe('refused')
    return `${r.reason}: ${r.detail}`
  }
  expect(await refused(`sid:${REGULAR}`)).toBe('refused: “myapp-1f” is a regular session: it lives in its own window')
  expect(await refused('zzzzzzzz')).toBe("refused: zzzzzzzz isn't in the session list")
  expect(await refused('eeeeeeee')).toBe('refused: “stopped one” was stopped by you: Enter or u restarts it')
  // Closed for lack of memory: not while memory is short; once it's normal, yes
  w.memory.value = '4'
  expect(await refused('ffffffff')).toContain('memory is still short')
  w.memory.value = '1'
  expect(await call($, 'wake', { ref: 'ffffffff', reason: 'x' })).toEqual({ ok: true, state: 'queued' })
  expect((await call($, 'wake', { ref: 1, reason: 'x' })).reason).toBe('invalid')
  const before = w.runs.length
  expect(await call($, 'wake', { ref: 'dddddddd', reason: 'fleet: an answer to D-3' })).toEqual({ ok: true, state: 'queued' })
  expect(await call($, 'wake', { ref: 'dddddddd', reason: 'again' })).toEqual({ ok: true, state: 'queued' })
  // Nothing ran inside the call: the mod's timer restarts them, each once
  expect(w.runs.slice(before).some(a => a[1] === 'respawn')).toBe(false)
  await w.clock.advance(600)
  expect(w.runs.filter(a => a[1] === 'respawn').map(a => a[2])).toEqual(['ffffffff', 'dddddddd'])
})

test("wake after a reboot or a crash: a background session that ended with no stop of the person's comes back; one the person stopped doesn't; status says why each is stopped", WITH_PROBE, async ($, on) => {
  const at = Date.parse('2026-10-26T10:00:00.000Z')
  const bg = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, sessionId: `${id}-0000-0000-0000-000000000000`, cwd: ROOT, kind: 'background', name, ...extra })
  const sessionsList = [
    ...list(),
    // The machine restarted: the process died with no line of its own; the service's next start found workers dead
    bg('dddddddd', 'rebooted', { startedAt: at - 3600000 }),
    // Nothing in the log says why it stopped (its lines rolled out): not woken
    bg('55555555', 'no evidence', { startedAt: at - 3600000 }),
    // Stopped with claude stop (the panel's s, or typed): its process was killed
    bg('eeeeeeee', 'stopped by the person', { startedAt: at - 3600000 }),
    // It crashed
    bg('ffffffff', 'crashed', { startedAt: at - 3600000 }),
    // Stopped from the panel's s long ago (the log no longer has it), and not started since
    bg('11111111', 'stopped from the panel', { startedAt: at - 7200000 }),
    // Stopped from the panel's s, then started again, then the machine restarted
    bg('22222222', 'started again', { startedAt: at - 600000 }),
    // Retired for being idle, and closed for lack of memory
    bg('33333333', 'idle one', { startedAt: at - 7200000 }),
    bg('44444444', 'memory one', { startedAt: at - 7200000 }),
  ]
  const w = world(on, {
    list: sessionsList,
    store: { 'personStop:11111111-0000-0000-0000-000000000000': at - 3600000, 'personStop:22222222-0000-0000-0000-000000000000': at - 3600000 },
  })
  w.memory.value = '1'
  w.files.set(
    '/Users/x/daemon.log',
    [
      '[2026-10-26T09:00:00.000Z] [bg] bg claimed-spare dddddddd (fleet)',
      '[2026-10-26T09:00:00.000Z] [bg] bg claimed-spare eeeeeeee (fleet)',
      '[2026-10-26T09:30:00.000Z] [bg] bg settled eeeeeeee (killed)',
      '[2026-10-26T09:31:00.000Z] [bg] bg settled ffffffff (crashed): SIGKILL (137) before init',
      '[2026-10-26T09:32:00.000Z] [bg] bg retire 33333333: settled, idle 61m',
      '[2026-10-26T09:32:01.000Z] [bg] bg settled 33333333 (done)',
      '[2026-10-26T09:33:00.000Z] [bg] bg retire 44444444: settled, idle 38h [low memory, pinned]',
      // Started again after the person's stop from the panel
      '[2026-10-26T09:40:00.000Z] [bg] bg claimed-spare 22222222 (fleet)',
      // The machine restarted: the service's next start found its workers dead
      '[2026-10-26T09:50:00.000Z] [supervisor] ─── daemon start ─── version=2.1.316 pid=1 origin=transient',
      '[2026-10-26T09:50:01.000Z] [bg] bg adopt: adopted=0 respawned=0 dead=3',
    ].join('\n'),
  )
  await startSession($, w)
  const rows = (await call($, 'status', { refs: ['dddddddd', 'eeeeeeee', 'ffffffff', '11111111', '22222222', '33333333', '44444444', '55555555', 'aaaaaaaa'] })).rows
  expect(Object.fromEntries(rows.map((r: any) => [r.ref, r.stopped ?? null]))).toEqual({
    dddddddd: 'ended',
    eeeeeeee: 'person',
    ffffffff: 'ended',
    '11111111': 'person',
    '22222222': 'ended',
    '33333333': 'idle',
    '44444444': 'memory',
    '55555555': 'unknown',
    aaaaaaaa: null,
  })
  // The person's claude stop the log shows is remembered: it outlives the log's tail
  expect(w.store.get('personStop:eeeeeeee-0000-0000-0000-000000000000')).toBe(Date.parse('2026-10-26T09:30:00.000Z'))
  w.files.set('/Users/x/daemon.log', '')
  expect((await call($, 'status', { refs: ['eeeeeeee', 'dddddddd'] })).rows.map((r: any) => r.stopped)).toEqual(['person', 'unknown'])
  w.files.set('/Users/x/daemon.log', [
    '[2026-10-26T09:00:00.000Z] [bg] bg claimed-spare dddddddd (fleet)',
    '[2026-10-26T09:00:00.000Z] [bg] bg claimed-spare eeeeeeee (fleet)',
    '[2026-10-26T09:30:00.000Z] [bg] bg settled eeeeeeee (killed)',
    '[2026-10-26T09:31:00.000Z] [bg] bg settled ffffffff (crashed): SIGKILL (137) before init',
    '[2026-10-26T09:40:00.000Z] [bg] bg claimed-spare 22222222 (fleet)',
    '[2026-10-26T09:50:01.000Z] [bg] bg adopt: adopted=0 respawned=0 dead=3',
  ].join('\n'))
  expect(await (async () => { const r = await call($, 'wake', { ref: '55555555', reason: 'x' }); return `${r.state}: ${r.detail}` })()).toBe('refused: nothing says why “no evidence” stopped (not a crash or a restart the service\'s log shows): Enter or u restarts it')
  const wake = async (ref: string) => {
    const r = await call($, 'wake', { ref, reason: 'x' })
    return r.ok ? r.state : `${r.state}: ${r.detail}`
  }
  expect(await wake('dddddddd')).toBe('queued')
  expect(await wake('ffffffff')).toBe('queued')
  expect(await wake('22222222')).toBe('queued')
  expect(await wake('eeeeeeee')).toBe('refused: “stopped by the person” was stopped by you: Enter or u restarts it')
  expect(await wake('11111111')).toBe('refused: “stopped from the panel” was stopped by you: Enter or u restarts it')
  await w.clock.advance(600)
  expect(w.runs.filter(a => a[1] === 'respawn').map(a => a[2])).toEqual(['dddddddd', 'ffffffff', '22222222'])
})

const PANEL = { plugin: 'sessions', surface: 'terminal', component: 'Pane', requestId: 'sessions', props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
async function drawn($: any): Promise<string> {
  const ui = await $.ui.mount(PANEL)
  const text = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return text
}

test('setMarks: checked, kept per source and session for ttlMs, drawn in the panel, and gone when they expire', WITH_PROBE, async ($, on) => {
  const w = world(on, { list: list() })
  const reason = async (input: unknown) => {
    const r = await call($, 'setMarks', input)
    return `${r.reason}: ${r.detail}`
  }
  const ok = { source: 'probe', rows: { aaaaaaaa: { badge: '?2' } }, ttlMs: 60000 }
  expect(await reason({ ...ok, ttlMs: 600001 })).toBe('invalid: ttlMs is 1 to 600000 (10 minutes)')
  expect(await reason({ ...ok, ttlMs: 0 })).toContain('invalid')
  expect(await reason({ ...ok, source: 'me' })).toContain('refused')
  expect(await reason({ ...ok, rows: [] })).toContain('invalid')
  // A row that breaks a limit is left out alone, with why; the others are set
  const rejected = async (rows: unknown) => (await call($, 'setMarks', { ...ok, rows })).rejected
  expect(await rejected({ aaaaaaaa: { badge: 'four' } })).toEqual({ aaaaaaaa: 'a badge is up to 3 columns' })
  expect((await rejected({ aaaaaaaa: { tint: 'red' } })).aaaaaaaa).toContain('a tint is one of')
  expect((await rejected({ 'not a ref': {} }))['not a ref']).toContain("isn't a ref")
  const mixed = await call($, 'setMarks', { ...ok, rows: { aaaaaaaa: { badge: '$' }, bbbbbbbb: { line: `budget used up ($0.02 today): /fleet budget "TEST Business Plan" +n` } } })
  expect(mixed).toEqual({ ok: true, rejected: { bbbbbbbb: 'a status line is up to 60 characters on one line' } })
  expect(w.store.get(`marks:probe:${SID}`)).toMatchObject({ rows: { aaaaaaaa: { badge: '$' } } })
  // Before the mod has started here too: the session's own id names them
  expect(await call($, 'setMarks', ok)).toEqual({ ok: true })
  expect(w.store.get(`marks:probe:${SID}`)).toEqual({ at: w.clock.now(), until: w.clock.now() + 60000, rows: { aaaaaaaa: { badge: '?2' } } })
  // In the test environment's namespace, as the mod's own keys (another plugin's call has the overrides too)
  expect([...w.storeKeys].filter(k => !k.startsWith(w.namespace))).toEqual([])
  await startSession($, w)
  // A regular session of the project, marked as needing the person
  expect(await call($, 'setMarks', { source: 'probe', rows: { aaaaaaaa: { badge: '?2', tint: 'warning' }, [`sid:${REGULAR}`]: { line: ' blocked on   D-3 ', needsPerson: true } }, ttlMs: 60000 })).toEqual({ ok: true })
  await w.clock.advance(3000)
  let text = await drawn($)
  expect(text).toContain(' ?2')
  expect(text).toContain('   blocked on D-3')
  expect(text).toContain('"color":"warning"')
  // /sessions status says whose marks are up
  const status: any = await $.command.run({ command: 'sessions', args: 'status', ...COMMAND })
  expect(String(status.text)).toContain('Marks: probe (2 rows, 1 min left)')
  // Expired: gone from the panel and from the store
  await w.clock.advance(60000)
  text = await drawn($)
  expect(text).not.toContain('blocked on D-3')
  expect(w.store.has(`marks:probe:${SID}`)).toBe(false)
  // Empty rows clear them at once
  expect(await call($, 'setMarks', ok)).toEqual({ ok: true })
  expect(await call($, 'setMarks', { ...ok, rows: {} })).toEqual({ ok: true })
  expect(w.store.has(`marks:probe:${SID}`)).toBe(false)
})

test('marks: the f filter shows the rows marked as needing the person, and a status line never appears or goes while focused', WITH_PROBE, async ($, on) => {
  const w = world(on, { list: list() })
  await startSession($, w)
  await call($, 'setMarks', { source: 'probe', rows: { [`sid:${REGULAR}`]: { badge: '?1', needsPerson: true } }, ttlMs: 600000 })
  await w.clock.advance(3000)
  const pane = w.panes.find(p => p.id === 'sessions')
  pane.isFocused = true
  const ui = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, isFocused: true } })
  await ui.press({ key: 'waiting' })
  let text = JSON.stringify(await ui.drawn())
  // busy (blue), but marked as needing the person: in the filter
  expect(text).toContain('Waiting for you · 1 of 2')
  expect(text).toContain('myapp-1f')
  await ui.press({ key: 'waiting' })
  // While focused, a status line that's new waits until the panel loses the keyboard
  await call($, 'setMarks', { source: 'probe', rows: { aaaaaaaa: { line: 'doing the release notes' } }, ttlMs: 600000 })
  await w.clock.advance(3000)
  text = JSON.stringify(await ui.drawn())
  expect(text).not.toContain('doing the release notes')
  pane.isFocused = false
  await w.clock.advance(3000)
  pane.isFocused = true
  await call($, 'setMarks', { source: 'probe', rows: { aaaaaaaa: { line: 'doing the changelog' } }, ttlMs: 600000 })
  await w.clock.advance(3000)
  // Its text changes in place, focused or not
  expect(JSON.stringify(await ui.drawn())).toContain('doing the changelog')
  await ui.unmount()
})

const PINS = '/Users/x/jobs/pins.json'
// A session's state in the background service (jobs/<id>/state.json): no task in the background, or some
const NO_TASKS = JSON.stringify({ inFlight: { tasks: 0, queued: 0, kinds: [] } })
const TASKS = JSON.stringify({ inFlight: { tasks: 1, queued: 0, kinds: ['local_agent'] } })
function moreSessions(): any[] {
  return [
    ...list(),
    { id: 'dddddddd', sessionId: 'dddddddd-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'idle', pid: 4245, name: 'three' },
    { id: 'eeeeeeee', sessionId: 'eeeeeeee-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', name: 'stopped one' },
    { id: 'ffffffff', sessionId: 'ffffffff-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', status: 'busy', pid: 4246, name: 'busy one' },
  ]
}

test("pin: a background session is pinned in pins.json under its lock, and only a plugin's own pin is ever unpinned, never the person's", WITH_PROBE, async ($, on) => {
  const w = world(on, { list: moreSessions() })
  // The person pinned “two” themself (Ctrl+T)
  w.files.set(PINS, '[\n  "bbbbbbbb"\n]')
  expect((await call($, 'pin', { ref: 'dddddddd', pinned: true, reason: 'x' })).reason).toBe('not-ready')
  await startSession($, w)
  const said = async (input: unknown) => {
    const r = await call($, 'pin', input)
    return r.ok ? 'ok' : `${r.reason}: ${r.detail}`
  }
  const before = w.runs.length
  expect(await call($, 'pin', { ref: 'dddddddd', pinned: true, reason: 'fleet: an instance' })).toEqual({ ok: true })
  // Written as Claude writes it, under the same lock
  expect(w.files.get(PINS)).toBe('[\n  "bbbbbbbb",\n  "dddddddd"\n]')
  expect(w.runs.slice(before).filter(a => a[1] === `${PINS}.lock`).map(a => a[0])).toEqual(['mkdir', 'rmdir'])
  expect(w.runs.slice(before).some(a => a[0] === 'mv' && a.at(-1) === PINS)).toBe(true)
  expect(w.store.get('pluginPins')).toEqual({ ids: ['dddddddd'], added: ['dddddddd'] })
  // Again: nothing to change
  expect(await said({ ref: 'dddddddd', pinned: true, reason: 'again' })).toBe('ok')
  expect(w.files.get(PINS)).toBe('[\n  "bbbbbbbb",\n  "dddddddd"\n]')
  // The person's pin: wanted by the plugin too, never counted as its own
  expect(await said({ ref: 'bbbbbbbb', pinned: true, reason: 'x' })).toBe('ok')
  expect(w.store.get('pluginPins')).toEqual({ ids: ['dddddddd', 'bbbbbbbb'], added: ['dddddddd'] })
  expect(await said({ ref: 'bbbbbbbb', pinned: false, reason: 'x' })).toBe('refused: “two”: it was pinned before a plugin asked: it stays pinned')
  expect(await said({ ref: 'bbbbbbbb', pinned: false, reason: 'x' })).toBe('refused: “two”: it was pinned by the person, not by a plugin: it stays pinned')
  expect(w.files.get(PINS)).toBe('[\n  "bbbbbbbb",\n  "dddddddd"\n]')
  // The plugin's own pin goes, with its place among the pinned ones (as Claude unpins)
  const unpinning = w.runs.length
  expect(await said({ ref: 'dddddddd', pinned: false, reason: 'x' })).toBe('ok')
  expect(w.files.get(PINS)).toBe('[\n  "bbbbbbbb"\n]')
  expect(w.runs.slice(unpinning)).toContainEqual(['rm', '-f', '/Users/x/jobs/dddddddd/order'])
  expect(w.store.get('pluginPins')).toEqual({ ids: [], added: [] })
  // One that isn't pinned: nothing to unpin
  expect(await said({ ref: 'dddddddd', pinned: false, reason: 'x' })).toBe('ok')
  // Refusals
  expect(await said({ ref: `sid:${REGULAR}`, pinned: true, reason: 'x' })).toBe('refused: “myapp-1f” is a regular session: only a background session is pinned')
  expect(await said({ ref: 'zzzzzzzz', pinned: true, reason: 'x' })).toBe("refused: zzzzzzzz isn't in the session list")
  expect(await said({ ref: 1, pinned: true, reason: 'x' })).toContain('invalid')
  expect(await said({ ref: 'dddddddd', pinned: 'yes', reason: 'x' })).toBe('invalid: pinned is true or false')
  // A pins.json that isn't a list of ids is left as it is
  w.files.set(PINS, '{"later": true}')
  expect(await said({ ref: 'dddddddd', pinned: true, reason: 'x' })).toBe("refused: pins.json couldn't be read as a list of ids: left as it is")
  expect(w.files.get(PINS)).toBe('{"later": true}')
  // The lock held by another process: busy after a few 50 ms beats, and nothing is written
  w.files.set(PINS, '[]')
  w.dirs.add(`${PINS}.lock`)
  w.made.set(`${PINS}.lock`, w.clock.now())
  const pending = call($, 'pin', { ref: 'dddddddd', pinned: true, reason: 'x' })
  await w.clock.advance(400)
  expect(await pending).toEqual({ ok: false, reason: 'busy', detail: 'another session is changing pins.json: try again' })
  expect(w.files.get(PINS)).toBe('[]')
})

test("pin and Remote Control: a session a plugin keeps pinned stays pinned when its Remote Control goes off, and leaves the record once it's gone", WITH_PROBE, async ($, on) => {
  const sessionsList = list()
  const w = world(on, { list: sessionsList, store: { autoPins: { ids: ['bbbbbbbb'], released: [] } } })
  // Pinned by Remote Control's automatic pin
  w.files.set(PINS, '[\n  "bbbbbbbb"\n]')
  w.files.set('/Users/x/jobs/aaaaaaaa/state.json', '{}')
  w.files.set('/Users/x/jobs/bbbbbbbb/state.json', '{"bridgeSessionId": "x"}')
  await startSession($, w)
  await w.clock.advance(100)
  expect(await call($, 'pin', { ref: 'bbbbbbbb', pinned: true, reason: 'x' })).toEqual({ ok: true })
  expect(w.store.get('pluginPins')).toEqual({ ids: ['bbbbbbbb'], added: [] })
  // Remote Control goes off: its automatic pin would go, the plugin keeps it, and it becomes the plugin's own
  w.files.set('/Users/x/jobs/bbbbbbbb/state.json', '{}')
  await w.clock.advance(20000)
  expect(w.files.get(PINS)).toBe('[\n  "bbbbbbbb"\n]')
  expect(w.store.get('autoPins')).toEqual({ ids: [], released: [] })
  expect(w.store.get('pluginPins')).toEqual({ ids: ['bbbbbbbb'], added: ['bbbbbbbb'] })
  // Deleted: its pin goes with it, and the record forgets it
  sessionsList.splice(1, 1)
  await w.clock.advance(20000)
  expect(w.files.get(PINS)).toBe('[]')
  expect(w.store.get('pluginPins')).toEqual({ ids: [], added: [] })
})

test("restart: a running background session that's idle is restarted from the mod's own timer, checked again then; the rest is refused with why", WITH_PROBE, async ($, on) => {
  const sessionsList = moreSessions()
  const w = world(on, { list: sessionsList, env: { SESSIONS_PLUGIN_VERSION: '0.13.2', SESSIONS_PLUGIN_SINCE: '1' } })
  w.files.set('/Users/x/jobs/dddddddd/state.json', NO_TASKS)
  expect((await call($, 'restart', { ref: 'dddddddd', reason: 'x' })).reason).toBe('not-ready')
  await startSession($, w)
  const refused = async (ref: unknown) => {
    const r = await call($, 'restart', { ref, reason: 'x' })
    expect(r.state).toBe(r.reason === 'invalid' ? undefined : 'refused')
    return `${r.reason}: ${r.detail}`
  }
  expect(await refused(`sid:${REGULAR}`)).toBe('refused: “myapp-1f” is a regular session: it lives in its own window (/exit and claude -c)')
  expect(await refused('zzzzzzzz')).toBe("refused: zzzzzzzz isn't in the session list")
  expect(await refused('eeeeeeee')).toBe("refused: “stopped one” isn't running: $.sessions.wake brings back a stopped one")
  expect(await refused('ffffffff')).toBe("refused: “busy one” is working: ask again once it's idle")
  expect(await refused('bbbbbbbb')).toBe("refused: “two” is waiting for the person: ask again once it's idle")
  expect(await refused(1)).toContain('invalid')
  const before = w.runs.length
  expect(await call($, 'restart', { ref: 'dddddddd', reason: 'fleet: a pending restart' })).toEqual({ ok: true, state: 'queued' })
  expect(await call($, 'restart', { ref: 'dddddddd', reason: 'again' })).toEqual({ ok: true, state: 'queued' })
  // Nothing ran inside the call: the mod's timer restarts it, once, without what ccc hands its launcher
  expect(w.runs.slice(before).some(a => a[1] === 'respawn')).toBe(false)
  await w.clock.advance(600)
  const respawns = w.runs.map((argv, i) => ({ argv, env: w.envs[i] })).filter(r => r.argv[1] === 'respawn')
  expect(respawns.map(r => r.argv)).toEqual([['/bin/claude', 'respawn', 'dddddddd']])
  expect(respawns[0]?.env).toMatchObject({ SESSIONS_PLUGIN_VERSION: '', SESSIONS_PLUGIN_SINCE: '' })
  expect(w.toasts).toEqual([])
  // Working by the time the timer gets to it: dropped (its caller asks again once it's idle)
  expect(await call($, 'restart', { ref: 'dddddddd', reason: 'x' })).toEqual({ ok: true, state: 'queued' })
  const three = sessionsList.find(s => s.id === 'dddddddd')
  three.status = 'busy'
  await w.clock.advance(600)
  expect(w.runs.filter(a => a[1] === 'respawn').length).toBe(1)
})

test("restart: a queued one waits while what the session is doing can't be read yet (another session holds the list's lock), then goes", { ...WITH_PROBE, timeoutMs: 30000 }, async ($, on) => {
  const w = world(on, { list: moreSessions() })
  w.files.set('/Users/x/jobs/dddddddd/state.json', NO_TASKS)
  await startSession($, w)
  await w.clock.advance(4000)
  const respawns = () => w.runs.filter(a => a[1] === 'respawn').length
  // Another session takes the lock and its listing runs long: the stored list here gets older than a restart trusts
  const lock = `${DATA}/list.lock`
  w.dirs.add(lock)
  w.made.set(lock, w.clock.now())
  await w.clock.advance(6000)
  expect(await call($, 'restart', { ref: 'dddddddd', reason: 'x' })).toEqual({ ok: true, state: 'queued' })
  await w.clock.advance(10000)
  expect(respawns()).toBe(0)
  // Its listing lands (the stored list, fresh) and the lock goes: the restart, still queued, goes on the next try
  const stored: any = w.store.get('list')
  w.store.set('list', { ...stored, at: w.clock.now() })
  w.dirs.delete(lock)
  await w.clock.advance(2500)
  expect(w.runs.filter(a => a[1] === 'respawn')).toEqual([['/bin/claude', 'respawn', 'dddddddd']])
})

test('restart: a queued one waits while the listing fails, up to 5 minutes after the last call for it, then is dropped', { ...WITH_PROBE, timeoutMs: 30000 }, async ($, on) => {
  const w = world(on, { list: moreSessions() })
  w.files.set('/Users/x/jobs/dddddddd/state.json', NO_TASKS)
  await startSession($, w)
  await w.clock.advance(4000)
  const respawns = () => w.runs.filter(a => a[1] === 'respawn').length
  w.agentsFail.value = true
  await w.clock.advance(6000)
  expect(await call($, 'restart', { ref: 'dddddddd', reason: 'x' })).toEqual({ ok: true, state: 'queued' })
  await w.clock.advance(240000)
  // Asked again while it waits: 5 more minutes from now
  expect(await call($, 'restart', { ref: 'dddddddd', reason: 'x' })).toEqual({ ok: true, state: 'queued' })
  await w.clock.advance(240000)
  expect(respawns()).toBe(0)
  w.agentsFail.value = false
  await w.clock.advance(3000)
  expect(respawns()).toBe(1)
  // Once more, and the listing keeps failing past the 5 minutes (the last list it read, older by then than a restart
  // trusts): dropped, so a listing that works later restarts nothing
  w.agentsFail.value = true
  await w.clock.advance(6000)
  expect(await call($, 'restart', { ref: 'dddddddd', reason: 'x' })).toEqual({ ok: true, state: 'queued' })
  await w.clock.advance(310000)
  w.agentsFail.value = false
  await w.clock.advance(5000)
  expect(respawns()).toBe(1)
})

test("restart: a queued one waits for the background tasks the session has (as u warns of), and for state that can't be read", { ...WITH_PROBE, timeoutMs: 30000 }, async ($, on) => {
  const w = world(on, { list: moreSessions() })
  const state = '/Users/x/jobs/dddddddd/state.json'
  w.files.set(state, TASKS)
  await startSession($, w)
  await w.clock.advance(4000)
  const respawns = () => w.runs.filter(a => a[1] === 'respawn').length
  expect(await call($, 'restart', { ref: 'dddddddd', reason: 'x' })).toEqual({ ok: true, state: 'queued' })
  await w.clock.advance(10000)
  expect(respawns()).toBe(0)
  // No state to read: still waiting
  w.files.delete(state)
  await w.clock.advance(10000)
  expect(respawns()).toBe(0)
  w.files.set(state, NO_TASKS)
  await w.clock.advance(2500)
  expect(respawns()).toBe(1)
  // Tasks that outlast the 5 minutes: dropped
  w.files.set(state, TASKS)
  expect(await call($, 'restart', { ref: 'dddddddd', reason: 'x' })).toEqual({ ok: true, state: 'queued' })
  await w.clock.advance(305000)
  w.files.set(state, NO_TASKS)
  await w.clock.advance(5000)
  expect(respawns()).toBe(1)
})

test('restart in a watched session: it runs at once with no short timer, from what Claude’s files say, and one waiting for its tasks is tried again every 2 s', { ...WITH_PROBE, timeoutMs: 30000 }, async ($, on) => {
  const sessionsList = moreSessions()
  const w = world(on, { list: sessionsList })
  // Claude's registry of the running sessions: the list comes from these files, with no claude agents
  for (const s of sessionsList.filter(x => x.pid)) {
    const kind = s.kind === 'background' ? 'bg' : 'interactive'
    const job = s.id ? { jobId: `${s.id}-0000-0000-0000-000000000000` } : {}
    w.write(`/Users/x/.claude/sessions/${s.pid}.json`, JSON.stringify({ pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, kind, status: s.status, statusUpdatedAt: 1, name: s.name, ...job, procStart: 'x' }))
  }
  const state = '/Users/x/jobs/dddddddd/state.json'
  w.files.set(state, TASKS)
  await $.classic.SessionStart({ source: 'startup', session_id: SID } as any)
  await startSession($, w)
  await w.clock.advance(100)
  const respawns = () => w.runs.filter(a => a[1] === 'respawn').length
  const listings = () => w.runs.filter(a => a[0] === '/bin/claude' && a[1] === 'agents').length
  const before = listings()
  expect(await call($, 'restart', { ref: 'dddddddd', reason: 'x' })).toEqual({ ok: true, state: 'queued' })
  await w.clock.advance(1000)
  expect(respawns()).toBe(0)
  // Its task ends: the next try, 2 s after the last, restarts it, long before the pass
  w.files.set(state, NO_TASKS)
  await w.clock.advance(2000)
  expect(respawns()).toBe(1)
  expect(listings()).toBe(before)
  // Idle with no task when asked: at once
  expect(await call($, 'restart', { ref: 'dddddddd', reason: 'x' })).toEqual({ ok: true, state: 'queued' })
  await w.clock.advance(100)
  expect(respawns()).toBe(2)
})

test("a listing that fails or times out pushes every session's next one back, the stored sessions and when they were read kept", { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on, { list: moreSessions() })
  await startSession($, w)
  await w.clock.advance(4000)
  const listings = () => w.runs.filter(a => a[0] === '/bin/claude' && a[1] === 'agents').length
  const before: any = w.store.get('list')
  // A listing that hangs for 16 s, then fails (run's timeout)
  w.agentsFail.value = true
  let release = () => {}
  w.agentsGate.value = new Promise<void>(r => (release = r))
  await w.clock.advance(16000)
  w.agentsGate.value = null
  release()
  await w.clock.settle()
  const failedAt = w.clock.now()
  const after: any = w.store.get('list')
  expect(after.at).toBe(before.at)
  expect(after.sessions).toEqual(before.sessions)
  // Twice its time (it started at the first refresh after the gate closed, up to 3 s in)
  expect(after.until).toBeGreaterThanOrEqual(failedAt + 26000)
  expect(after.until).toBeLessThanOrEqual(failedAt + 32000)
  // Nobody lists again until then
  const n = listings()
  await w.clock.advance(after.until - w.clock.now() - 1000)
  expect(listings()).toBe(n)
  w.agentsFail.value = false
  await w.clock.advance(8000)
  expect(listings()).toBeGreaterThan(n)
  expect((w.store.get('list') as any).at).toBeGreaterThan(failedAt)
})

// A newer copy of the mod installed beside the running one (claude plugin list --json), as the in-place update looks for,
// watching the same paths as this one (its watch.ts)
function installNewer(w: ReturnType<typeof world>) {
  const plugins = String((import.meta as any).dir).replace(/\/sessions\/tests$/, '')
  w.plugins.value = JSON.stringify([{ id: 'sessions@x', enabled: true, version: '0.10.1', installPath: `${plugins}/sessions-0.10.1`, lastUpdated: '2026-01-01T00:00:00Z' }])
  w.files.set(`${plugins}/sessions-0.10.1/hooks/watch.ts`, `export const WATCH_SET = ${WATCH_SET}\n`)
}

test('in-place update: no list read for a session the last list shows working; once it shows it idle, it reloads', { timeoutMs: 30000 }, async ($, on) => {
  const sessionsList = moreSessions()
  const own = sessionsList.find(s => s.id === 'aaaaaaaa')
  own.status = 'busy'
  const w = world(on, { list: sessionsList })
  w.files.set('/Users/x/jobs/aaaaaaaa/state.json', NO_TASKS)
  installNewer(w)
  await startSession($, w)
  for (const p of w.panes) p.isFocused = false
  const listings = () => w.runs.filter(a => a[0] === '/bin/claude' && a[1] === 'agents').length
  // A list always fresh in the store (as when other sessions keep listing): only a list read now runs claude agents
  const fresh = async (ms: number) => {
    for (let t = 0; t < ms; t += 1000) {
      w.store.set('list', { at: w.clock.now(), sessions: sessionsList })
      await w.clock.advance(1000)
    }
  }
  await fresh(2000)
  const n = listings()
  await fresh(31000)
  expect(listings()).toBe(n)
  expect(w.store.has(`reloaded:${SID}`)).toBe(false)
  own.status = 'idle'
  await fresh(31000)
  expect(listings()).toBeGreaterThan(n)
  expect(w.store.has(`reloaded:${SID}`)).toBe(true)
})

test('in-place update: a restart queued while it checks (a list read takes seconds) keeps it from reloading', { ...WITH_PROBE, timeoutMs: 30000 }, async ($, on) => {
  const w = world(on, { list: moreSessions() })
  w.files.set('/Users/x/jobs/aaaaaaaa/state.json', NO_TASKS)
  const other = '/Users/x/jobs/dddddddd/state.json'
  w.files.set(other, TASKS)
  installNewer(w)
  await startSession($, w)
  for (const p of w.panes) p.isFocused = false
  await w.clock.advance(4000)
  // A slow listing: the update's own check (a list read now) waits on it
  let release = () => {}
  w.agentsGate.value = new Promise<void>(r => (release = r))
  await w.clock.advance(16000)
  expect(await call($, 'restart', { ref: 'dddddddd', reason: 'x' })).toEqual({ ok: true, state: 'queued' })
  await w.clock.advance(600)
  w.agentsGate.value = null
  release()
  await w.clock.advance(1000)
  expect(w.store.has(`reloaded:${SID}`)).toBe(false)
  // Its tasks done, the restart goes; then the update reloads
  w.files.set(other, NO_TASKS)
  await w.clock.advance(31000)
  expect(w.runs.filter(a => a[1] === 'respawn')).toEqual([['/bin/claude', 'respawn', 'dddddddd']])
  expect(w.store.has(`reloaded:${SID}`)).toBe(true)
})

test("restart of the caller's own session: refused while a window not opened with ccc shows it; else run detached, and its ccc windows reopen it", WITH_PROBE, async ($, on) => {
  const w = world(on, { list: list() })
  w.files.set('/Users/x/jobs/aaaaaaaa/state.json', NO_TASKS)
  await startSession($, w)
  w.ps.value = '  101 ttys001  claude attach aaaaaaaa'
  const r = await call($, 'restart', { ref: 'aaaaaaaa', reason: 'x' })
  expect(`${r.state} ${r.detail}`).toBe("refused a window that wasn't opened with ccc shows “one” (/dev/ttys001): it wouldn't come back by itself after the restart; u in the panel restarts it")
  w.ps.value = '  100 ttys001  bash /Users/x/p/hooks/visor.sh start\n  101 ttys001  claude attach aaaaaaaa'
  expect(await call($, 'restart', { ref: 'aaaaaaaa', reason: 'x' })).toEqual({ ok: true, state: 'queued' })
  expect(w.runs.some(a => a[0] === 'perl')).toBe(false)
  await w.clock.advance(600)
  const perl = w.runs.find(a => a[0] === 'perl')
  expect(perl?.slice(-3)).toEqual(['/bin/claude', 'respawn', 'aaaaaaaa'])
  // The ccc window is told to reopen it
  const windowFiles = [...w.files.keys()].filter(p => p.startsWith(`${DATA}/windows/`))
  expect(windowFiles.length).toBe(1)
  expect(w.files.get(windowFiles[0] ?? '')).toContain('aaaaaaaa')
  // Still here 15 s later: it wasn't restarted, the window file goes and the person is told
  await w.clock.advance(16000)
  expect(w.files.has(windowFiles[0] ?? '')).toBe(false)
  expect(w.toasts).toContain("Couldn't restart “one”")
})

test("a plugin's pins: it unpins only what it pinned, Remote Control's own pin stays its own, and a session that's gone leaves the record", () => {
  const none = { ids: [], added: [] }
  expect(pluginPinChange(['a'], none, [], 'b', true)).toEqual({ pins: ['a', 'b'], plugin: { ids: ['b'], added: ['b'] }, changed: true })
  // Already pinned (the person's, or Remote Control's): wanted, never added
  expect(pluginPinChange(['a'], none, [], 'a', true)).toEqual({ pins: ['a'], plugin: { ids: ['a'], added: [] }, changed: false })
  expect(pluginPinChange(['a', 'b'], { ids: ['b'], added: ['b'] }, [], 'b', false)).toEqual({ pins: ['a'], plugin: none, changed: true })
  // Remote Control's automatic pin holds it: it stays, and the plugin no longer wants it
  expect(pluginPinChange(['b'], { ids: ['b'], added: [] }, ['b'], 'b', false)).toEqual({ pins: ['b'], plugin: none, changed: false })
  expect(pluginPinChange(['a'], none, [], 'a', false).refused).toBe('it was pinned by the person, not by a plugin: it stays pinned')
  // Unpinned meanwhile by the person: nothing to do
  expect(pluginPinChange([], { ids: ['b'], added: ['b'] }, [], 'b', false)).toEqual({ pins: [], plugin: none, changed: false })
  // Remote Control off for b and c: b, kept by a plugin, stays pinned and becomes its own; c goes
  expect(keepPluginPins({ pins: ['a'], toUnpin: ['b', 'c'] }, { ids: ['b'], added: [] }, new Set(['a', 'b', 'c']))).toEqual({ pins: ['a', 'b'], toUnpin: ['c'], plugin: { ids: ['b'], added: ['b'] } })
  // Gone from the list: the record forgets them, and the pin a plugin added goes (never the person's)
  expect(keepPluginPins({ pins: ['a', 'd'], toUnpin: [] }, { ids: ['a', 'd'], added: ['d'] }, new Set())).toEqual({ pins: ['a'], toUnpin: ['d'], plugin: none })
})
