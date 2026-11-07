import { expect, test } from 'claude-code/testing'

import { hashText } from '../hooks/changes'
import { FLEET, REF, ROOT, SID, json, sessionsSay, startSession, world, type World, WITH_SESSIONS } from './world'

// fleet 0.12.2's review: the outside scan's batch (a claims shell cut short, a claim another scan took and never
// recorded, a rename whose new file another scan claimed) and the front door's idle line read from work.json

const STATE = `${FLEET}/state`
const CURRENT = { current: { ready: true, ref: REF, sessionId: SID, name: 'TEST A', root: ROOT, background: true, agent: null } }

async function tick(w: World, ms = 2100) {
  for (let left = ms; left > 0; left -= 60000) {
    await w.clock.advance(Math.min(left, 60000))
    await w.clock.settle()
  }
}
function events(w: World): any[] {
  return [...w.files.keys()]
    .filter(p => p.startsWith(`${FLEET}/events/`) && /\/\d{4}-\d{2}-\d{2}\/\d{2}\/[^/]+\.json$/.test(p))
    .map(p => JSON.parse(w.files.get(p) as string))
    .sort((a, b) => a.at - b.at)
}
async function begin($: any, w: World) {
  sessionsSay(w, CURRENT)
  await startSession($, w)
  await tick(w, 1100)
  await tick(w)
  await tick(w)
}

test('a claims shell cut short after it linked them (a timeout) still records each change: the claims carry this scan', WITH_SESSIONS, async ($, on) => {
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${ROOT}/notes/plan.md`]: 'plan\n' } })
  await begin($, w)
  await tick(w)
  for (let i = 1; i <= 10; i++) w.touch(`${ROOT}/notes/n-${i}.md`, `note ${i}\n`)
  // The first shell that links claims links them all (as sh does), then is killed at its 30 s timeout
  let killed = 0
  w.exec.value = argv => {
    if (argv[0] !== 'sh' || !String(argv[2]).includes('ln "$t" "$d"')) return undefined
    const pairs = argv.slice(4)
    if (killed || !pairs.some(p => p.includes('/events/claims/'))) return undefined
    killed++
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const t = pairs[i] as string
      const d = pairs[i + 1] as string
      const text = w.files.get(t)
      if (text !== undefined && !w.files.has(d)) w.touch(d, text)
      w.files.delete(t)
    }
    throw new Error('process timed out after 30000 ms')
  }
  for (let i = 0; i < 4; i++) await tick(w, 10000)
  await tick(w)
  expect(killed).toBe(1)
  expect(events(w).filter(e => e.via === 'outside' && e.path.startsWith('notes/n-')).length).toBe(10)
})

test('a change another scan claimed and never recorded (it died between its claims and its events) is recorded here after 3 minutes, once', WITH_SESSIONS, async ($, on) => {
  const N1 = `${ROOT}/notes/n-1.md`
  const w = world(on, { worldPaths: ['notes/**'], files: { [`${ROOT}/notes/plan.md`]: 'plan\n' } })
  await begin($, w)
  await tick(w)
  const mtime = Math.floor(w.clock.now()) + 5
  w.touch(N1, 'note 1\n', mtime)
  // The dead scan's claim, of another session
  w.touch(`${FLEET}/events/claims/${hashText(`notes/n-1.md\n${hashText('note 1\n')}\n${mtime}`).slice(1)}`, JSON.stringify({ format: 1, path: 'notes/n-1.md', at: w.clock.now(), scan: 'zzzzzzzz:0:1' }))
  await tick(w, 10000)
  await tick(w, 10000)
  // Not this scan's while that claim is fresh
  expect(events(w).filter(e => e.path === 'notes/n-1.md').length).toBe(0)
  for (let i = 0; i < 4; i++) await tick(w, 60000)
  const recorded = events(w).filter(e => e.path === 'notes/n-1.md')
  expect(recorded.length).toBe(1)
  expect(recorded[0]).toMatchObject({ via: 'outside', to: hashText('note 1\n') })
  // And not again
  for (let i = 0; i < 4; i++) await tick(w, 60000)
  expect(events(w).filter(e => e.path === 'notes/n-1.md').length).toBe(1)
})

test('a renamed record whose new file another scan claimed is still a twin, not a retraction', WITH_SESSIONS, async ($, on) => {
  const R2 = `${ROOT}/req/R-2.md`
  const w = world(on, { worldPaths: ['req/**'], files: { [R2]: 'R-2 v1\n' } })
  await begin($, w)
  await tick(w)
  expect(json(w, `${STATE}/revs/R-2/1.json`)).toMatchObject({ rev: 1, path: 'req/R-2.md' })
  // Outside fleet: R-2.md renamed to R-2-units.md (same text, a time of its own)
  const NEW = `${ROOT}/req/R-2-units.md`
  const mtime = Math.floor(w.clock.now()) + 5
  w.files.delete(R2)
  w.touch(NEW, 'R-2 v1\n', mtime)
  // The new file's claim is taken already (a second scan at a handover); this scan takes the removal's
  w.touch(`${FLEET}/events/claims/${hashText(`req/R-2-units.md\n${hashText('R-2 v1\n')}\n${mtime}`).slice(1)}`, JSON.stringify({ format: 1, path: 'req/R-2-units.md', at: w.clock.now() }))
  await tick(w, 10000)
  await tick(w, 10000)
  await tick(w)
  const revs = [...w.files.keys()].filter(p => p.startsWith(`${STATE}/revs/R-2/`) && /\/\d+\.json$/.test(p)).map(p => JSON.parse(w.files.get(p) as string))
  // No version of R-2 says it's gone: its file is there, at its new name
  expect(revs.filter(r => r.hash === null)).toEqual([])
})

test("the front door's idle line reads since when from work.json, not each idle instance's heartbeat at each of its steps", WITH_SESSIONS, async ($, on) => {
  const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
  const OWNER = '---\nname: owner\ndescription: owns a part of the notes\ntools: Read, Write, Edit, mcp__fleet__*\n---\nYou own a part of the notes.\n'
  const names = Array.from({ length: 8 }, (_, i) => `Tester ${i + 1}`)
  const TEAM = { rosterFormat: 1, sections: [{ id: 'work', title: 'Work' }], roles: { chief: { agent: 'owner', model: 'haiku' }, tester: { agent: 'owner', model: 'haiku' } }, instances: [{ name: 'Chief', role: 'chief', section: 'work' }, ...names.map(name => ({ name, role: 'tester', section: 'work' }))], wakes: { everyMin: 5, perDay: 8 } }
  // Every tester seeded a minute ago (the fleet just went up), as the sweeper wrote it
  const idleSince = Object.fromEntries(names.map(n => [n, NOW - 60000]))
  const work = { format: 1, at: NOW, unowned: {}, capacity: { idle: names, unowned: 0, oldest: null, slotsFree: null, slotsTotal: null, runs: 0, unrecorded: 0, flags: [], idleSince } }
  const files: Record<string, string> = { [`${FLEET}/roster.json`]: JSON.stringify(TEAM), [`${ROOT}/.claude/agents/owner.md`]: OWNER, [`${FLEET}/instances/chief.json`]: '{"env":{}}\n', [`${FLEET}/state/work.json`]: JSON.stringify(work), [`${ROOT}/notes/plan.md`]: '# plan\n' }
  names.forEach((name, i) => {
    const slug = `tester-${i + 1}`
    files[`${FLEET}/instances/${slug}/state.json`] = JSON.stringify({ format: 1, instance: name, slug, ref: `ttttttt${i + 1}`, sessionId: `ttttttt${i + 1}-0000-0000-0000-000000000000`, at: NOW, cwd: ROOT, bound: true, settingsHash: null, agentType: 'owner', cost: 0, startedAt: NOW - 60000, idleSince: NOW - 30000 })
  })
  const w = world(on, { worldPaths: ['notes/**', 'board/**'], env: { FLEET_ROOT: ROOT, FLEET_INSTANCE: 'Chief', FLEET_ROLE: 'chief' }, files })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  on('classic.SessionStart', () => ({}))
  sessionsSay(w, { current: { ready: true, ref: 'aaaaaaaa', sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Chief', root: ROOT, background: true, agent: 'owner' }, rows: { aaaaaaaa: { ref: 'aaaaaaaa', sessionId: null, name: 'Chief', state: 'working', panel: 'ok', root: ROOT, background: true, agent: null }, ...Object.fromEntries(names.map((name, i) => [`ttttttt${i + 1}`, { ref: `ttttttt${i + 1}`, sessionId: null, name, state: 'idle', panel: 'ok', root: ROOT, background: true, agent: null }])) } })
  await startSession($, w)
  await $.classic.SessionStart({ source: 'startup', agent_type: 'owner' } as any)
  await w.clock.advance(2100)
  await w.clock.settle()
  w.readCount.clear()
  let told = ''
  for (let i = 0; i < 10; i++) told += ((await $.tool.call({ tool: 'Read', file_path: `${ROOT}/notes/plan.md` } as any)).context ?? []).join('\n')
  const hb = [...w.readCount].filter(([p]) => /\/instances\/tester-\d+\/state\.json$/.test(p)).reduce((a, [, k]) => a + k, 0)
  expect(hb).toBeLessThanOrEqual(8)
  expect(told).not.toContain('idle with no item to take')
})
