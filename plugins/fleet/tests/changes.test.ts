import { expect, test } from 'claude-code/testing'

import {
  acceptable,
  addGlob,
  ancestorsOf,
  bashReadTarget,
  caseProbe,
  changeLine,
  changedPaths,
  checkGlob,
  clock,
  digestItems,
  digestText,
  gateText,
  globBase,
  globRegex,
  hashText,
  hourFolder,
  inWorld,
  oldDays,
  overwroteText,
  parseReads,
  parseWorld,
  placeable,
  relOf,
  removeGlob,
  staleOf,
  verdict,
  whoText,
  windowFolders,
  type ChangeEvent,
} from '../hooks/changes'
import { parseCommand } from '../hooks/decisions'

const ME = { sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', offsetMin: 0 }
const AT = Date.UTC(2026, 10, 2, 14, 2, 0)
const B = { sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', agentId: null, ref: 'bbbbbbbb', name: 'TEST B' }

function ev(over: Partial<ChangeEvent> = {}): ChangeEvent {
  return { format: 1, at: AT, path: 'notes/plan.md', from: 'h1', to: 'h2', via: 'tool', tool: 'Edit', blind: false, by: B, ...over }
}

test('world.json: globs, a newer format left alone, bad globs named', () => {
  expect(parseWorld('{"worldFormat":1,"paths":["notes/**"],"later":true}')).toEqual({ world: { worldFormat: 1, paths: ['notes/**'], later: true } })
  expect('problem' in parseWorld('{"worldFormat":2,"paths":[]}') && (parseWorld('{"worldFormat":2,"paths":[]}') as any).problem).toContain('newer fleet')
  expect((parseWorld('nope') as any).problem).toContain("isn't valid JSON")
  expect((parseWorld('{"worldFormat":1,"paths":["/abs/**"]}') as any).problem).toContain('relative to the project')
  expect(checkGlob('../x/**')).toContain('..')
  expect(checkGlob('.claude/fleet/**')).toContain("fleet's own")
  expect(checkGlob('docs/**')).toBe(null)
})

test('/fleet world add and remove keep the other fields; a folder written with / means everything under it', () => {
  const w = { worldFormat: 1, paths: ['notes/**'], later: 1 }
  const a = addGlob(w, 'specs/')
  expect(a).toEqual({ world: { worldFormat: 1, paths: ['notes/**', 'specs/**'], later: 1 }, added: 'specs/**' })
  expect((addGlob(w, 'notes/**') as any).problem).toContain('already')
  expect(removeGlob(w, 'notes/**')).toEqual({ world: { worldFormat: 1, paths: [], later: 1 } })
  expect((removeGlob(w, 'docs/**') as any).problem).toContain("isn't in the world")
  expect(parseCommand('world')).toEqual({ kind: 'world', action: 'list', glob: '' })
  expect(parseCommand('world add docs/**')).toEqual({ kind: 'world', action: 'add', glob: 'docs/**' })
  expect(parseCommand('world drop docs').kind).toBe('bad')
  expect(parseCommand('accept notes/plan.md')).toEqual({ kind: 'accept', paths: ['notes/plan.md'] })
  expect(parseCommand('accept')).toEqual({ kind: 'accept', paths: [] })
  expect(parseCommand('accept charter.md roster.json "notes/a b.md"')).toEqual({ kind: 'accept', paths: ['charter.md', 'roster.json', 'notes/a b.md'] })
})

test('globs: ** any folders, * within a name, {a,b}; case ignored where the volume ignores it; fleet’s folder never', () => {
  const g = (glob: string, i = false) => globRegex(glob, i)
  expect(g('notes/**').test('notes/plan.md')).toBe(true)
  expect(g('notes/**').test('notes/a/b/c.md')).toBe(true)
  expect(g('notes/**').test('notesx/plan.md')).toBe(false)
  expect(g('docs/*.md').test('docs/a.md')).toBe(true)
  expect(g('docs/*.md').test('docs/a/b.md')).toBe(false)
  expect(g('**/*.md').test('a.md')).toBe(true)
  expect(g('**/*.md').test('x/y/a.md')).toBe(true)
  expect(g('{req,findings}/**').test('findings/F-1.md')).toBe(true)
  expect(g('notes/**').test('Notes/Plan.md')).toBe(false)
  expect(g('notes/**', true).test('Notes/Plan.md')).toBe(true)
  expect(inWorld('.claude/fleet/events/latest', [g('**')])).toBe(false)
  expect(inWorld('notes/plan.md', [g('docs/**'), g('notes/**')])).toBe(true)
  expect(globBase('notes/**')).toBe('notes')
  expect(globBase('docs/plan/*.md')).toBe('docs/plan')
  expect(globBase('*.md')).toBe('')
  expect(globBase('{a,b}/**')).toBe('')
})

test('placing a path: relative to the real project folder, case-folded where the volume ignores case; new files by their folders', () => {
  expect(relOf('/Users/x/proj/notes/plan.md', '/Users/x/proj', false)).toBe('notes/plan.md')
  expect(relOf('/Users/x/projx/notes/plan.md', '/Users/x/proj', false)).toBe(null)
  expect(relOf('/USERS/x/Proj/notes/new.md', '/Users/x/proj', true)).toBe('notes/new.md')
  expect(relOf('/USERS/x/Proj/notes/new.md', '/Users/x/proj', false)).toBe(null)
  expect(ancestorsOf('/p/notes/new/x.md')).toEqual([
    { dir: '/p/notes/new', rest: 'x.md' },
    { dir: '/p/notes', rest: 'new/x.md' },
    { dir: '/p', rest: 'notes/new/x.md' },
  ])
  expect(ancestorsOf('/p/notes/../x.md')).toEqual([{ dir: '/p/notes/..', rest: 'x.md' }])
  expect(placeable('/p/notes/x.md')).toBe(true)
  expect(placeable('notes/x.md')).toBe(false)
  expect(placeable('//server/share/x')).toBe(false)
  expect(placeable('/p/notes/..')).toBe(false)
  expect(caseProbe('/Users/x/proj')).toBe('/Users/x/PROJ')
  expect(caseProbe('/Users/x/123')).toBe('/Users/X/123')
  expect(caseProbe('/1/2')).toBe(null)
})

test('versions: a hash that ignores line endings and a BOM, and moves with any other change', () => {
  expect(hashText('a\nb\n')).toBe(hashText('a\r\nb\r\n'))
  expect(hashText('﻿a')).toBe(hashText('a'))
  expect(hashText('a')).not.toBe(hashText('b'))
  expect(hashText('')).toMatch(/^h[0-9a-f]{14}$/)
})

test('events: hour folders in UTC, the trailing window, the days to remove', () => {
  expect(hourFolder(AT)).toBe('2026-11-02/14')
  expect(windowFolders(AT, 2)).toEqual(['2026-11-02/14', '2026-11-02/13'])
  expect(windowFolders(Date.UTC(2026, 10, 2, 0, 5), 2)).toEqual(['2026-11-02/00', '2026-11-01/23'])
  expect(oldDays(['2026-10-25', '2026-10-26', '2026-11-01', 'latest', 'claims'], AT)).toEqual(['2026-10-25'])
})

test('who and when, in words: a session’s tool, its Bash (landed blind), outside fleet, the person, this session', () => {
  expect(clock(AT, 0)).toBe('14:02')
  expect(clock(AT, -180)).toBe('11:02')
  expect(changeLine(ev(), ME)).toBe('changed at 14:02 by TEST B (Edit)')
  expect(changeLine(ev({ via: 'bash', tool: 'Bash', blind: true }), ME)).toBe('changed at 14:02 by TEST B (a Bash command, landed blind)')
  expect(changeLine(ev({ via: 'outside', by: null, blind: true }), ME)).toBe('changed at 14:02 outside fleet (an editor, a script, or a session without fleet)')
  expect(changeLine(ev({ via: 'accept', by: { ...B, person: true } }), ME)).toBe('changed at 14:02 by the person')
  expect(changeLine(ev({ to: null }), ME)).toBe('was removed at 14:02 by TEST B (Edit)')
  expect(whoText(ev({ by: { ...B, sessionId: ME.sessionId, agentId: 'a1' } }), ME)).toBe('a helper of this session (Edit)')
  expect(whoText(ev({ by: { sessionId: 'cccccccc-1', agentId: null, ref: null, name: null } }), ME)).toBe('the session cccccccc (Edit)')
})

test('the gate: passes a file not there, the version read, or one refused once already; else stale or unread', () => {
  const read = { v: 'h1', at: 1 }
  expect(verdict(read, null, undefined)).toBe('pass')
  expect(verdict(read, 'h1', undefined)).toBe('pass')
  expect(verdict(read, 'h2', undefined)).toBe('stale')
  expect(verdict(read, 'h2', 'h2')).toBe('pass')
  expect(verdict(read, 'h3', 'h2')).toBe('stale')
  expect(verdict(undefined, 'h2', undefined)).toBe('unread')
  expect(gateText('stale', 'notes/plan.md', ev(), 0, ME)).toBe(
    'fleet: notes/plan.md changed at 14:02 by TEST B (Edit), after you read it. Read it again, then redo this write so it agrees with that change (this write was not made).',
  )
  expect(gateText('stale', 'notes/plan.md', null, AT, ME)).toContain('changed at 14:02 outside fleet')
  expect(gateText('unread', 'notes/plan.md', ev(), 0, ME)).toBe(
    "fleet: notes/plan.md is a shared file of this project and you haven't read it in this conversation (it last changed at 14:02 by TEST B (Edit)). Read it first, then redo this write so it keeps what's there (this write was not made).",
  )
  expect(gateText('unread', 'notes/plan.md', null, AT, ME)).not.toContain('last changed')
  expect(overwroteText('notes/plan.md', ev(), ME, 'command')).toBe('fleet: your command changed notes/plan.md, which changed at 14:02 by TEST B (Edit) after you read it. Read notes/plan.md and check that change is still there.')
  expect(overwroteText('notes/plan.md', ev(), ME, 'write')).toContain('your write replaced notes/plan.md, which changed at 14:02 by TEST B (Edit) after you read it: that change may be lost')
  expect(overwroteText('notes/plan.md', ev(), ME, 'edit')).toContain('landed on top of a change that came in at 14:02 by TEST B (Edit)')
})

test('the digest: the files this thread read that someone else changed since, told once, at most ten lines, no content', () => {
  const latest = new Map<string, ChangeEvent>([
    ['notes/plan.md', ev()],
    ['notes/todo.md', ev({ path: 'notes/todo.md', at: AT + 60000, via: 'bash', tool: 'Bash', blind: true })],
    ['notes/mine.md', ev({ path: 'notes/mine.md', by: { ...B, sessionId: ME.sessionId } })],
    ['notes/seen.md', ev({ path: 'notes/seen.md' })],
    ['notes/old.md', ev({ path: 'notes/old.md', at: 5 })],
    ['notes/stamped.md', ev({ path: 'notes/stamped.md', at: AT - 60000, via: 'accept', by: { ...B, sessionId: ME.sessionId, person: true } })],
  ])
  const reads = {
    'notes/plan.md': { v: 'h1', at: 10 },
    'notes/todo.md': { v: 'h1', at: 10 },
    'notes/mine.md': { v: 'h1', at: 10 },
    'notes/seen.md': { v: 'h1', at: 10, told: 'h2' },
    'notes/old.md': { v: 'h0', at: 10 },
    'notes/quiet.md': { v: 'h1', at: 10 },
    'notes/stamped.md': { v: 'h1', at: 10 },
  }
  const items = digestItems(reads, latest, ME)
  // The person's stamp typed in this session is news to its model; its own landings aren't
  expect(items.map(i => i.path)).toEqual(['notes/todo.md', 'notes/plan.md', 'notes/stamped.md'])
  expect(digestText(items, ME)).toBe(
    [
      'fleet: 3 shared files you read have changed since you read them. Read them again before you rely on them or write them:',
      '- notes/todo.md: changed at 14:03 by TEST B (a Bash command, landed blind)',
      '- notes/plan.md: changed at 14:02 by TEST B (Edit)',
      '- notes/stamped.md: changed at 14:01 by the person',
    ].join('\n'),
  )
  expect(digestItems(undefined, latest, ME)).toEqual([])
  // Reads are per thread: a helper's landing is news to main, and main's to the helper; a thread's own isn't
  const helper = new Map<string, ChangeEvent>([['notes/mine.md', ev({ path: 'notes/mine.md', by: { ...B, sessionId: ME.sessionId, agentId: 'a1' } })]])
  expect(digestItems(reads, helper, ME).map(i => i.path)).toEqual(['notes/mine.md'])
  expect(digestText(digestItems(reads, helper, ME), ME)).toContain('- notes/mine.md: changed at 14:02 by a helper of this session (Edit)')
  expect(digestItems(reads, helper, ME, 'a1')).toEqual([])
  expect(digestItems(reads, latest, ME, 'a1').map(i => i.path)).toEqual(['notes/todo.md', 'notes/mine.md', 'notes/plan.md', 'notes/stamped.md'])
  const many = Array.from({ length: 13 }, (_, i) => ({ path: `notes/n${i}.md`, event: ev({ path: `notes/n${i}.md` }) }))
  const text = digestText(many, ME)
  expect(text.split('\n').length).toBe(12)
  expect(text).toContain('- and 3 more: notes/n10.md, notes/n11.md, notes/n12.md')
})

test('Bash reads: one file, no pipes or redirections', () => {
  expect(bashReadTarget('cat notes/plan.md')).toBe('notes/plan.md')
  expect(bashReadTarget('cat "notes/my plan.md"')).toBe('notes/my plan.md')
  expect(bashReadTarget('head -n 20 notes/plan.md')).toBe('notes/plan.md')
  expect(bashReadTarget("sed -n '1,40p' notes/plan.md")).toBe('notes/plan.md')
  expect(bashReadTarget('cat a.md b.md')).toBe(null)
  expect(bashReadTarget('cat notes/plan.md | wc -l')).toBe(null)
  expect(bashReadTarget('cat notes/plan.md > x')).toBe(null)
  expect(bashReadTarget('grep x notes/plan.md')).toBe(null)
  expect(bashReadTarget('sed -i s/a/b/ notes/plan.md')).toBe(null)
})

test('the post-scan compares size and time; accept takes only a change nobody’s landing explains; who is behind', () => {
  const before = new Map([
    ['a', { mtimeMs: 1, size: 1 }],
    ['b', { mtimeMs: 1, size: 1 }],
    ['c', { mtimeMs: 1, size: 1 }],
  ])
  const after = new Map([
    ['a', { mtimeMs: 1, size: 1 }],
    ['b', { mtimeMs: 2, size: 1 }],
    ['d', { mtimeMs: 1, size: 1 }],
  ])
  expect(changedPaths(before, after)).toEqual(['b', 'c', 'd'])
  expect(acceptable(null, 'h2')).toBe('ok')
  expect(acceptable(ev({ via: 'outside', by: null }), 'h2')).toBe('ok')
  expect(acceptable(ev(), 'h3')).toBe('ok')
  expect(acceptable(ev({ via: 'accept' }), 'h2')).toBe('already')
  expect(acceptable(ev(), 'h2')).toEqual({ by: ev() })
  expect(acceptable(ev(), null)).toBe('missing')
  const threads = { main: { 'notes/plan.md': { v: 'h1', at: 1 }, 'notes/ok.md': { v: 'h5', at: 1 } }, a1: { 'notes/plan.md': { v: 'h2', at: 1 } } }
  const now: Record<string, string> = { 'notes/plan.md': 'h2', 'notes/ok.md': 'h5' }
  expect(staleOf(threads, p => now[p])).toEqual([{ path: 'notes/plan.md', thread: 'main' }])
  expect(parseReads('{"format":1,"sessionId":"s","ref":null,"name":null,"at":1,"threads":{}}')).toMatchObject({ sessionId: 's' })
  expect(parseReads('{"format":9}')).toEqual({ otherFormat: 9 })
})
