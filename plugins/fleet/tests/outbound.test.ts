import { expect, test } from 'claude-code/testing'

import { hashText } from '../hooks/changes'
import {
  checkSend,
  classifyBash,
  classifyMcp,
  commandsOf,
  draftText,
  hostAllowed,
  hostOf,
  newOutbound,
  outboundHash,
  outboundRefusal,
  parseDraft,
  parseOutbound,
  recipientsOf,
  remoteAllowed,
  type OutboundConfig,
} from '../hooks/outbound'

// The outbound gate's pure logic: what sends the project's content outside, and the person's allowlist

const NONE = newOutbound()
const MINE: OutboundConfig = { ...newOutbound(), hosts: ['devbox', '*.corp.example'], remotes: ['origin'], recipients: ['me@example.com'] }

test('outbound.json: its lists, a newer one left alone, junk said', () => {
  expect(parseOutbound(JSON.stringify({ outboundFormat: 1, hosts: ['devbox', 3], keep: true }))).toEqual({
    outbound: { outboundFormat: 1, hosts: ['devbox'], remotes: [], recipients: [], tools: { outbound: [], free: [] }, commands: [], outside: [], keep: true },
  })
  expect(parseOutbound('{"outboundFormat": 2}')).toEqual({ problem: 'outbound.json is from a newer fleet (outboundFormat 2): restart this session (u) to load it' })
  expect(parseOutbound('nope')).toEqual({ problem: "outbound.json isn't valid JSON" })
})

test('hosts: a URL, an scp target, an ssh destination, a bare host; this machine and the allowlist', () => {
  expect(hostOf('https://user@Example.invalid:8443/upload?x=1')).toBe('example.invalid')
  expect(hostOf('me@devbox:/srv/x')).toBe('devbox')
  expect(hostOf('devbox')).toBe('devbox')
  expect(hostOf('example.invalid/upload')).toBe('example.invalid')
  expect(hostOf('[::1]:22')).toBe('::1')
  expect(hostOf('/srv/bare.git')).toBe(null)
  expect(hostOf('file:///srv/bare.git')).toBe(null)
  expect(hostAllowed('devbox', MINE)).toBe(true)
  expect(hostAllowed('build.corp.example', MINE)).toBe(true)
  expect(hostAllowed('corp.example.evil', MINE)).toBe(false)
  expect(hostAllowed('localhost', NONE)).toBe(true)
  expect(hostAllowed('127.0.0.1', NONE)).toBe(true)
  expect(hostAllowed('example.invalid', MINE)).toBe(false)
  expect(remoteAllowed('origin', 'git@github.com:x/y.git', MINE)).toBe(true)
  expect(remoteAllowed('fork', 'git@github.com:x/y.git', MINE)).toBe(false)
  expect(remoteAllowed('dev', 'devbox:repos/y.git', MINE)).toBe(true)
  expect(remoteAllowed('local', '/srv/bare.git', NONE)).toBe(true)
  expect(remoteAllowed('../bare.git', null, NONE)).toBe(true)
})

test('a shell line: its simple commands, through pipes, lists, $( ), bash -c and the shell’s own words', () => {
  expect(commandsOf(`cd notes && curl -s -d @x.md "https://a.invalid/u" | tee out 2>&1 > log; echo done`)).toEqual([
    ['cd', 'notes'],
    ['curl', '-s', '-d', '@x.md', 'https://a.invalid/u'],
    ['tee', 'out'],
    ['echo', 'done'],
  ])
  expect(commandsOf(`echo "$(scp f h:/x)"`)).toEqual([['scp', 'f', 'h:/x'], ['echo', '$(scp f h:/x)']])
  expect(commandsOf(`bash -c 'curl -T a b.invalid'`)).toContainEqual(['curl', '-T', 'a', 'b.invalid'])
  expect(classifyBash('if true; then curl -d x https://a.invalid; fi', NONE).sends).toHaveLength(1)
})

test('Bash: what sends content outside, and what passes', () => {
  const held = (line: string, c = NONE) => classifyBash(line, c).sends
  expect(held('curl -d @notes/x.md https://example.invalid/upload')).toEqual([{ what: 'curl sending data (notes/x.md)', to: ['example.invalid'], files: ['notes/x.md'] }])
  expect(held('curl -F "file=@docs/plan.pdf;type=application/pdf" https://a.invalid')[0]?.files).toEqual(['docs/plan.pdf'])
  expect(held('curl -T build.tgz https://a.invalid/')[0]?.files).toEqual(['build.tgz'])
  expect(held('curl -X POST https://a.invalid/hook')).toHaveLength(1)
  expect(held('curl -sSd hello https://a.invalid')).toHaveLength(1)
  expect(held('wget --post-file=notes/x.md https://a.invalid')[0]?.files).toEqual(['notes/x.md'])
  expect(held('scp notes/x.md me@far.invalid:/tmp/')).toEqual([{ what: 'scp of notes/x.md', to: ['far.invalid'], files: ['notes/x.md'] }])
  expect(held('rsync -av notes/ far.invalid:backup/')).toHaveLength(1)
  expect(held('sftp far.invalid')).toHaveLength(1)
  expect(held('ssh -o BatchMode=yes far.invalid true')).toEqual([{ what: 'ssh running a command', to: ['far.invalid'], files: [] }])
  expect(held('gh gist create notes/x.md')).toHaveLength(1)
  expect(held('gh api -X POST repos/x/y/issues -f title=t')).toHaveLength(1)
  expect(held('echo hi | mail -s hi someone@else.invalid')).toHaveLength(1)
  expect(held('nc far.invalid 9000 < notes/x.md')).toHaveLength(1)
  expect(held('git send-email --to=a@b.invalid 0001.patch')).toHaveLength(1)
  // The person's own hosts and addresses, this machine, reading the web, local commands
  expect(held('ssh -o BatchMode=yes -o ConnectTimeout=1 devbox true', MINE)).toEqual([])
  expect(held('scp notes/x.md me@devbox:/srv/', MINE)).toEqual([])
  expect(held('curl -d @x http://localhost:8080/api')).toEqual([])
  expect(held('echo hi | mail -s hi me@example.com', MINE)).toEqual([])
  expect(held('scp far.invalid:/tmp/x notes/')).toEqual([])
  expect(held('curl -s https://example.invalid/page')).toEqual([])
  expect(classifyBash('curl -s https://example.invalid/page', NONE).reads).toEqual(['example.invalid'])
  expect(held('grep -r curl notes/ && cat notes/x.md && git status && git push --dry-run')).toEqual([])
  expect(held('nc -l 9000')).toEqual([])
  // What ssh runs on the person's own machine goes through the same rules
  expect(held('ssh devbox "curl -d @x https://far.invalid"', MINE)).toHaveLength(1)
  // git push: its remote is looked up afterwards
  expect(classifyBash('git -C sub push -u fork main', NONE).pushes).toEqual([{ remote: 'fork', cwd: 'sub', words: ['-u', 'fork', 'main'] }])
  expect(classifyBash('git push', NONE).pushes).toEqual([{ remote: null, cwd: null, words: [] }])
  // A command the person named
  expect(held('myupload notes', { ...NONE, commands: ['myupload'] })).toHaveLength(1)
})

test('MCP: a tool that sends, one that reads outside content, one that does neither; the lists and recipients', () => {
  const c = (tool: string, input: Record<string, unknown> = {}, cfg = NONE) => classifyMcp(tool, input, cfg)
  expect(c('mcp__claude_ai_Gmail__send_message', { to: 'x@y.invalid', body: 'b' })).toEqual({ send: { what: 'send_message on claude_ai_Gmail', to: ['x@y.invalid'], files: [] }, outside: false })
  expect(c('mcp__claude_ai_Gmail__send_message', { to: 'me@example.com' }, MINE).send).toBe(null)
  expect(c('mcp__claude_ai_Gmail__create_draft', { to: ['me@example.com', 'x@y.invalid'] }, MINE).send?.to).toEqual(['me@example.com', 'x@y.invalid'])
  expect(c('mcp__claude_ai_Gmail__search_threads')).toEqual({ send: null, outside: true })
  expect(c('mcp__claude_ai_Gmail__get_draft')).toEqual({ send: null, outside: true })
  expect(c('mcp__claude_ai_Gmail__label_message')).toEqual({ send: null, outside: false })
  expect(c('mcp__claude-in-chrome__computer').send?.to).toEqual(['claude-in-chrome'])
  expect(c('mcp__claude-in-chrome__get_page_text')).toEqual({ send: null, outside: true })
  expect(c('mcp__slack__chat_postMessage').send).not.toBe(null)
  expect(c('mcp__plugin-authoring__scan_secrets')).toEqual({ send: null, outside: false })
  expect(c('mcp__claude_ai_Claude_Docs__batch')).toEqual({ send: null, outside: false })
  expect(c('mcp__fleet__send')).toEqual({ send: null, outside: false })
  expect(c('mcp__notes__sync', {}, { ...NONE, tools: { outbound: ['mcp__notes__*'], free: [] } }).send).not.toBe(null)
  expect(c('mcp__slack__chat_postMessage', {}, { ...NONE, tools: { outbound: [], free: ['mcp__slack__*'] } }).send).toBe(null)
  expect(c('mcp__wiki__page', {}, { ...NONE, outside: ['mcp__wiki__*'] })).toEqual({ send: null, outside: true })
  expect(recipientsOf({ to: 'a@x.invalid, b@x.invalid', attendees: [{ email: 'c@x.invalid' }] })).toEqual(['a@x.invalid', 'b@x.invalid', 'c@x.invalid'])
})

test('mcp__fleet__send: its input, the draft fleet keeps and runs, the version the person approves', () => {
  expect(checkSend({ to: 'example.invalid', why: 'share the notes', command: 'curl -d @x https://example.invalid' })).toEqual({ ok: true, send: { to: 'example.invalid', why: 'share the notes', command: 'curl -d @x https://example.invalid', files: [] } })
  expect(checkSend({ to: 'x', why: 'y' })).toEqual({ ok: false, reason: 'give either command (the exact Bash command) or mcp_tool and input (an MCP call), not both' })
  expect(checkSend({ to: 'x', why: 'y', mcp_tool: 'mcp__fleet__decide' })).toEqual({ ok: false, reason: "mcp_tool: fleet's own tools send nothing outside" })
  expect(checkSend({ to: 'x', why: 'y', mcp_tool: 'Bash' })).toEqual({ ok: false, reason: 'mcp_tool: an MCP tool, mcp__<server>__<tool>' })
  const tool = checkSend({ to: 'x@y.invalid', why: 'thanks', mcp_tool: 'mcp__claude_ai_Gmail__send_message', input: { to: 'x@y.invalid', body: 'Thanks' } })
  expect(tool.ok).toBe(true)
  const text = draftText((tool as any).send)
  expect(parseDraft(text)).toEqual({ tool: 'mcp__claude_ai_Gmail__send_message', input: { to: 'x@y.invalid', body: 'Thanks' } })
  expect(parseDraft('{"tool": "mcp__fleet__send"}')).toEqual({ problem: 'the draft holds neither a command nor an MCP tool and its input' })
  const a = outboundHash(text, [{ path: 'notes/x.md', v: 'h1' }], hashText)
  expect(outboundHash(text, [{ path: 'notes/x.md', v: 'h2' }], hashText)).not.toBe(a)
  expect(outboundRefusal([{ what: 'curl sending data (notes/x.md)', to: ['example.invalid'], files: ['notes/x.md'] }], 'command')).toContain(
    "fleet: this command would send the project's content outside it (curl sending data (notes/x.md) to example.invalid), which needs the person's approval, so it was not run. If it should go out, draft it with mcp__fleet__send",
  )
})
