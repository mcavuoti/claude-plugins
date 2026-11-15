import { expect, test } from 'claude-code/testing'

import { below, meterOff, meterOpen, run, sized, snapshot, under, work } from '../hooks/meter'

// The review of fleet 0.15.0's meter (hooks/meter.ts), by its own functions and the system's clock: each finding's
// control, and the case that failed before its fix. Nothing here touches a file or a session.

declare const console: { log: (...a: unknown[]) => void }
declare function setTimeout(fn: (...args: unknown[]) => void, ms: number): unknown
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(() => resolve(), ms))
function latch() {
  let open!: () => void
  const p = new Promise<void>(resolve => (open = resolve))
  return { p, open }
}
const taken = () => snapshot(1, {}, null)

// ---- A: a hook stops its own run's clock (below(r)), whatever else started since: before, the newest run's ----

test('A control: a hook alone: the tool beneath it (150 ms) is not its time', async () => {
  meterOpen('r-aaaaaa', 0, 60000)
  await run('bash.scan', async r => {
    await sleep(5)
    await under(below(r), sleep(150))
  })
  const d = taken()
  meterOff()
  expect(d.actions['bash.scan']?.ms).toBeLessThan(60)
})

test('A1: another action still running when the hook reaches next: the hook is charged the whole tool, and the other loses its work', async () => {
  meterOpen('r-aaaaaa', 0, 60000)
  // A Bash hook: 5 ms of its own, then the command (150 ms) beneath it
  const hook = run('bash.scan', async r => {
    await sleep(5)
    await under(below(r), sleep(150))
  })
  // 2 ms in, a landing's chain read starts (a watched path changed) and is still reading at 5 ms
  await sleep(2)
  const chain = run('landing.chain', async () => {
    await sleep(10)
    work('read')
  })
  await Promise.all([hook, chain])
  const d = taken()
  meterOff()
  console.log(`PROOF A1 ${JSON.stringify({ bashScanMs: d.actions['bash.scan']?.ms, chainReads: d.actions['landing.chain']?.work.read ?? 0, totalReads: d.totals.work.read })}`)
  expect(d.totals.work.read).toBe(1)
  // The hook's own time is about 5 ms; the command's 150 ms is the tool's
  expect(d.actions['bash.scan']?.ms).toBeLessThan(60)
  // The chain's read is the chain's
  expect(d.actions['landing.chain']?.work.read).toBe(1)
})

test('A2: two tool calls of one batch: one hook is charged the other tool, the other reads 0', async () => {
  meterOpen('r-aaaaaa', 0, 60000)
  const call = (own: number) =>
    run('outbound.check', async r => {
      await sleep(own)
      await under(below(r), sleep(100))
    })
  await Promise.all([call(3), call(6)])
  const d = taken()
  meterOff()
  const a = d.actions['outbound.check']
  console.log(`PROOF A2 ${JSON.stringify({ runs: a?.runs, ms: a?.ms, slowest: a?.slowest })}`)
  expect(a?.runs).toBe(2)
  // Their own time is 3 ms and 6 ms; each tool's 100 ms is the tool's
  expect(a?.slowest).toBeLessThan(50)
})

// ---- B: an action inside a part gives its time to the part only: the whole keeps it, and so does the action ----

test('B control: an action inside another gives its time back: 60 ms of work is 60 ms in all', async () => {
  meterOpen('r-aaaaaa', 0, 60000)
  await run('beat', () => run('landing.chain', () => sleep(60)))
  const d = taken()
  meterOff()
  expect((d.actions.beat?.ms ?? 0) + (d.actions['landing.chain']?.ms ?? 0)).toBeLessThan(90)
})

test('B: an action inside a part of the sweep: its 60 ms are in the sweep and in the action (120 ms in the total)', async () => {
  meterOpen('r-aaaaaa', 0, 60000)
  await run('sweep', () => run('sweep.roster', () => run('landing.chain', () => sleep(60))))
  const d = taken()
  meterOff()
  console.log(`PROOF B ${JSON.stringify({ sweep: d.actions.sweep?.ms, part: d.actions['sweep.roster']?.ms, chain: d.actions['landing.chain']?.ms })}`)
  // What the report adds up for the plugin: every action that isn't a part
  expect((d.actions.sweep?.ms ?? 0) + (d.actions['landing.chain']?.ms ?? 0)).toBeLessThan(90)
})

// ---- C: a run that began in one window and ends in the next adds its whole time to the new one ----

test('C: a run left over from the window before: its time since then lands in the new window, with no run counted', async () => {
  meterOpen('r-aaaaaa', 0, 60000)
  const l = latch()
  const old = run('judge', () => l.p)
  // (the close: the hand-in, and the meter off)
  meterOff()
  await sleep(80)
  meterOpen('r-bbbbbb', 0, 60000)
  await run('judge', async () => {})
  l.open()
  await old
  const d = taken()
  meterOff()
  console.log(`PROOF C ${JSON.stringify({ runs: d.actions.judge?.runs, ms: d.actions.judge?.ms })}`)
  expect(d.actions.judge?.runs).toBe(1)
  // The new window is a few ms old
  expect(d.actions.judge?.ms).toBeLessThan(40)
})

// ---- D: a holding's size doesn't see a Map or a Set inside an entry ----

test('D control: entries of plain data: about their size', async () => {
  const text = 'x'.repeat(10000)
  expect(sized(new Map([['R-1', { revs: { 1: { hash: text } } }]]), []).bytes).toBeGreaterThan(10000)
})

test('D: entries that keep a Map (revCache, toldHere): the Map counts for nothing', async () => {
  const text = 'x'.repeat(10000)
  // revCache's shape: Map<id, { revs: Map<number, Rev>; mtime; at; fixed: Set<string> }>
  const h = sized(new Map([['R-1', { revs: new Map([[1, { hash: text }]]), mtime: 1, at: 1, fixed: new Set(['a']) }]]), [])
  console.log(`PROOF D ${JSON.stringify(h)}`)
  expect(h.bytes).toBeGreaterThan(10000)
})

// ---- What the code can know of two actions at once: a hook waiting beneath keeps none of what runs beside it ----
// (seen live: `lease` showed entries listed and `landing.pull` an `mv:lease`, each the other's. Two actions that run
// side by side with neither waiting beneath can still take each other's work: a mod has no way to tell them apart)

test("a hook waiting beneath, and a timer's pass beside it: the pass's work is the pass's, and the hook's own work, before and after its tool, is the hook's", async () => {
  meterOpen('r-aaaaaa', 0, 60000)
  const hook = run('write.land', async r => {
    work('read')
    work('stat')
    await sleep(3)
    // The tool runs beneath: 80 ms
    await under(below(r), sleep(80))
    // Back in the hook: its event, its mv
    work('write')
    work('command')
  })
  await sleep(10)
  // While the hook waits beneath, the minute's pass lists an hour folder
  await run('landing.pull', async () => {
    work('list')
    work('listed', 40)
    await sleep(20)
    work('read')
  })
  await hook
  const d = taken()
  meterOff()
  expect(d.actions['landing.pull']?.work).toEqual({ list: 1, listed: 40, read: 1 })
  expect(d.actions['write.land']?.work).toEqual({ read: 1, stat: 1, write: 1, command: 1 })
  // Neither is charged the tool, nor the other
  expect(d.actions['write.land']?.ms).toBeLessThan(40)
  expect(d.actions['landing.pull']?.ms).toBeLessThan(60)
  expect(d.totals.work).toEqual({ read: 2, stat: 1, write: 1, command: 1, list: 1, listed: 40 })
})
