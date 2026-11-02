import { expect, test } from 'claude-code/testing'

import { COMMAND, DATA, ROOT, SID, startSession, world, type World } from './world'

// ccc tell, the session's side: the person's opt-in (/sessions tell on), the requests in <data>/tell/<ref>/ submitted as
// turns of their own once the session is idle, their status files, and waking a stopped session for the launcher.
// The launcher's side is in dev/sessions/test-launcher.sh

const TELL = `${DATA}/tell/aaaaaaaa`

async function sessions($: any, args: string): Promise<string> {
  const r: any = await $.command.run({ command: 'sessions', args, ...COMMAND })
  return String(r.text)
}

// What the engine does with the mod's $.prompt.submit: the prompts it got, and what it answers (a turn, or a drop)
function engine(on: any) {
  const prompts: string[] = []
  const answer: { value: any } = { value: (text: string) => ({ text }) }
  on('prompt.submit', (_: any, e: any) => {
    prompts.push(String(e.text))
    return answer.value(String(e.text))
  })
  return { prompts, answer }
}

function request(w: World, id: string, text: string, format = 3) {
  w.files.set(`${TELL}/${id}.txt`, text)
  w.files.set(`${TELL}/${id}.status`, `format=3\nstate=queued\nreason=\nat=1\n`)
  w.files.set(`${TELL}/${id}.req`, `format=${format}\nfrom=cron\nat=${w.clock.now()}\n`)
}

function state(w: World, id: string): string {
  return (w.files.get(`${TELL}/${id}.status`) ?? '').match(/^state=(.*)$/m)?.[1] ?? ''
}

test('/sessions tell on and off: the person lets ccc tell reach this background session, never a regular one', async ($, on) => {
  const w = world(on)
  await startSession($, w)
  expect(await sessions($, 'tell')).toContain('Off. /sessions tell on turns it on')
  expect(await sessions($, 'tell on')).toContain('ccc tell "one" "<text>" (or its id, aaaaaaaa)')
  expect(w.files.get(`${TELL}/allow`)).toMatch(/^format=3\nat=\d+\n$/)
  expect(await sessions($, 'tell')).toContain('On.')
  expect(await sessions($, 'tell off')).toContain('Off')
  expect(w.files.has(`${TELL}/allow`)).toBe(false)
})

test('/sessions tell in a regular session: refused', async ($, on) => {
  const w = world(on, { list: [{ sessionId: SID, cwd: ROOT, kind: 'interactive', status: 'idle', pid: 4242, name: 'one' }] })
  await startSession($, w)
  expect(await sessions($, 'tell on')).toContain('Only a background session takes text from ccc tell')
})

test('a request becomes a turn of its own, framed as sent by a script, and its status says delivered', async ($, on) => {
  const e = engine(on)
  const w = world(on)
  await startSession($, w)
  await sessions($, 'tell on')
  const id = `${w.clock.now()}-501`
  request(w, id, 'New mail, id 42: read it with the mail tool')
  await w.clock.advance(600)
  expect(e.prompts).toEqual([`[ccc tell ${id} from cron: sent by a script, not typed by the person]\nNew mail, id 42: read it with the mail tool`])
  expect(state(w, id)).toBe('delivered')
  expect(w.files.has(`${TELL}/${id}.txt`)).toBe(false)
  expect(w.files.has(`${TELL}/${id}.req`)).toBe(false)
  expect(w.files.has(`${TELL}/${id}.taken`)).toBe(false)
  // Once each
  await w.clock.advance(1000)
  expect(e.prompts).toHaveLength(1)
})

test('refused: not opted in, another format, too long, no text; nothing reaches the model', async ($, on) => {
  const e = engine(on)
  const w = world(on)
  await startSession($, w)
  request(w, '1-1', 'hello')
  await w.clock.advance(600)
  expect(state(w, '1-1')).toBe('refused')
  expect(w.files.get(`${TELL}/1-1.status`)).toContain("doesn't take text from ccc tell")
  await sessions($, 'tell on')
  request(w, '2-1', 'hello', 1)
  request(w, '3-1', 'x'.repeat(4097))
  request(w, '4-1', '  \n')
  await w.clock.advance(2000)
  expect(w.files.get(`${TELL}/2-1.status`)).toContain('another version of the sessions mod')
  expect(w.files.get(`${TELL}/3-1.status`)).toContain('longer than 4 KB')
  expect(w.files.get(`${TELL}/4-1.status`)).toContain('no text')
  expect(e.prompts).toEqual([])
})

test('after an Esc the engine refuses it: held until the person types, then it goes', async ($, on) => {
  const e = engine(on)
  const w = world(on)
  await startSession($, w)
  await sessions($, 'tell on')
  e.answer.value = () => ({ drop: 'the session was stopped and nobody has sent input since' })
  request(w, '5-1', 'build finished, log at /tmp/x.log')
  await w.clock.advance(600)
  expect(state(w, '5-1')).toBe('held')
  expect(w.files.get(`${TELL}/5-1.status`)).toContain('the session was stopped and nobody has sent input since')
  expect(w.files.has(`${TELL}/5-1.held`)).toBe(true)
  // Held, it isn't submitted again on its own
  await w.clock.advance(2000)
  expect(e.prompts).toHaveLength(1)
  // The person types: it goes again, as its own turn
  e.answer.value = (text: string) => ({ text })
  await $.prompt.submit({ text: 'carry on', origin: { kind: 'composer' } } as any)
  await w.clock.advance(600)
  expect(e.prompts.at(-1)).toContain('build finished, log at /tmp/x.log')
  expect(state(w, '5-1')).toBe('delivered')
})

test('a turn that carries a request marks it delivered, also when the call that submitted it was lost', async ($, on) => {
  const e = engine(on)
  const w = world(on)
  await startSession($, w)
  await sessions($, 'tell on')
  // The engine holds the prompt (the session is busy): the call doesn't resolve
  e.answer.value = () => new Promise(() => {})
  request(w, '6-1', 'ping')
  await w.clock.advance(600)
  expect(state(w, '6-1')).toBe('queued')
  expect(w.files.has(`${TELL}/6-1.taken`)).toBe(true)
  await $.turn.start({ turnId: 't1', text: 'The sessions plugin sent a message:\n[ccc tell 6-1 from cron: sent by a script, not typed by the person]\nping' } as any)
  await w.clock.settle()
  expect(state(w, '6-1')).toBe('delivered')
})

test('a request taken and never delivered (the session restarted before its turn) goes back in line and is delivered', async ($, on) => {
  const e = engine(on)
  const w = world(on)
  // Taken by the process before this one, which ended before the request's turn
  request(w, '7-1', 'deploy done')
  w.files.set(`${TELL}/7-1.taken`, w.files.get(`${TELL}/7-1.req`) ?? '')
  w.files.delete(`${TELL}/7-1.req`)
  w.files.set(`${TELL}/allow`, `format=3\nat=1\n`)
  await startSession($, w)
  await w.clock.advance(1500)
  expect(e.prompts).toEqual([`[ccc tell 7-1 from cron: sent by a script, not typed by the person]\ndeploy done`])
  expect(state(w, '7-1')).toBe('delivered')
  expect(w.files.has(`${TELL}/7-1.taken`)).toBe(false)
})

test('a submit that fails goes back in line once, and is refused the second time', async ($, on) => {
  const e = engine(on)
  const w = world(on)
  await startSession($, w)
  await sessions($, 'tell on')
  e.answer.value = () => {
    throw new Error('the engine refused the prompt')
  }
  request(w, '8-1', 'ping')
  await w.clock.advance(600)
  expect(e.prompts).toHaveLength(1)
  expect(state(w, '8-1')).toBe('queued')
  expect(w.files.has(`${TELL}/8-1.req`)).toBe(true)
  await w.clock.advance(1000)
  expect(e.prompts).toHaveLength(2)
  expect(state(w, '8-1')).toBe('refused')
  expect(w.files.get(`${TELL}/8-1.status`)).toContain("couldn't be submitted")
  expect([...w.files.keys()].filter(f => f.startsWith(`${TELL}/8-1.`) && !f.endsWith('.status'))).toEqual([])
})

test('ccc tell for a stopped session: a running session wakes it under the wake rules and answers the launcher', async ($, on) => {
  const list = [
    { id: 'aaaaaaaa', sessionId: SID, cwd: ROOT, kind: 'background', status: 'idle', pid: 4242, name: 'one' },
    { id: 'dddddddd', sessionId: 'dddddddd-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', name: 'idle one' },
    { id: 'eeeeeeee', sessionId: 'eeeeeeee-0000-0000-0000-000000000000', cwd: ROOT, kind: 'background', name: 'stopped one' },
  ]
  const w = world(on, { list })
  w.files.set('/Users/x/daemon.log', '[2026-10-26T10:00:00.000Z] [bg] bg retire dddddddd: settled, idle 61m\n[2026-10-26T10:00:01.000Z] [bg] bg settled eeeeeeee (killed)\n')
  await startSession($, w)
  w.files.set(`${DATA}/inbox/${SID}`, `format=3\naction=wake\nat=${w.clock.now()}\nref=dddddddd\nreply=${DATA}/replies/1-1\n`)
  await w.clock.advance(600)
  expect(w.runs.some(a => a[1] === 'respawn' && a[2] === 'dddddddd')).toBe(true)
  expect(w.files.get(`${DATA}/replies/1-1`)).toBe('format=3\nresult=ok\nstate=queued\nreason=woke “idle one”\n')
  w.files.set(`${DATA}/inbox/${SID}`, `format=3\naction=wake\nat=${w.clock.now()}\nref=eeeeeeee\nreply=${DATA}/replies/1-2\n`)
  await w.clock.advance(600)
  expect(w.runs.some(a => a[1] === 'respawn' && a[2] === 'eeeeeeee')).toBe(false)
  expect(w.files.get(`${DATA}/replies/1-2`)).toContain('result=failed\nstate=refused\nreason=“stopped one” wasn\'t retired for being idle')
})
