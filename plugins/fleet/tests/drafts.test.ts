import { expect, test } from 'claude-code/testing'

import { hashText } from '../hooks/changes'
import { applyEdits, applyVerdict, changeDelivery, changeTicket, checkChange, diffHead, draftName, lineDiff, sameHash, shortHash, type ChangeSpec } from '../hooks/drafts'

const SPEC: ChangeSpec = { path: 'req/R-1.md', summary: 'the target goes down', base: hashText('a\nb\n'), result: hashText('a\nc\n'), draft: 'decisions/drafts/D-4.md', diff: 'decisions/drafts/D-4.diff', added: 1, removed: 1 }

test("a change's input: path and summary, and edits or content, never both", () => {
  expect(checkChange({ summary: 'x', content: 'y' })).toMatchObject({ ok: false, reason: expect.stringContaining('path') })
  expect(checkChange({ path: 'a.md', content: 'y' })).toMatchObject({ ok: false, reason: expect.stringContaining('summary') })
  expect(checkChange({ path: 'a.md', summary: 's' })).toMatchObject({ ok: false, reason: 'the change itself is missing: give edits (a list of { "old_string": …, "new_string": … }, as with Edit) or content (the whole new text of a.md)' })
  expect(checkChange({ path: 'a.md', summary: 's', content: 'y', edits: [{ old_string: 'a', new_string: 'b' }] })).toMatchObject({ ok: false, reason: expect.stringContaining('edits or content, not both') })
  // edits as one JSON string of the list is read as the list; anything else that isn't a list says what it came as
  expect(checkChange({ path: 'a.md', summary: 's', edits: '[{"old_string":"a","new_string":"b"}]' })).toEqual({ ok: true, path: 'a.md', summary: 's', edits: [{ old_string: 'a', new_string: 'b' }] })
  expect(checkChange({ path: 'a.md', summary: 's', edits: 'a → b' })).toMatchObject({ ok: false, reason: expect.stringContaining('edits: a list of { "old_string": …, "new_string": … } objects, as with Edit (it came as text)') })
  expect(checkChange({ path: 'a.md', summary: 's', edits: { old_string: 'a', new_string: 'b' } })).toMatchObject({ ok: false, reason: expect.stringContaining('(it came as object)') })
  expect(checkChange({ path: 'a.md', summary: 's', edits: [{ old_string: '', new_string: 'b' }] })).toMatchObject({ ok: false, reason: expect.stringContaining('old_string is empty') })
  expect(checkChange({ path: ' a.md ', summary: '  the   why ', edits: [{ old_string: 'a', new_string: 'b', replace_all: true }], blocks: 'B-1' })).toEqual({
    ok: true,
    path: 'a.md',
    summary: 'the why',
    edits: [{ old_string: 'a', new_string: 'b', replace_all: true }],
    blocks: 'B-1',
  })
  expect(checkChange({ path: 'a.md', summary: 's', content: '' })).toEqual({ ok: true, path: 'a.md', summary: 's', content: '' })
})

test('edits apply in order, as Edit does: found once, or every time with replace_all', () => {
  expect(applyEdits('one two two', [{ old_string: 'one', new_string: '1' }])).toEqual({ text: '1 two two' })
  expect(applyEdits('one two two', [{ old_string: 'two', new_string: '2' }])).toMatchObject({ problem: expect.stringContaining('2 times') })
  expect(applyEdits('one two two', [{ old_string: 'two', new_string: '2', replace_all: true }])).toEqual({ text: 'one 2 2' })
  expect(applyEdits('one', [{ old_string: 'three', new_string: '3' }])).toMatchObject({ problem: expect.stringContaining("isn't in the file") })
  expect(applyEdits('a b', [{ old_string: 'a', new_string: 'x' }, { old_string: 'x b', new_string: 'done' }])).toEqual({ text: 'done' })
  // $ in the new text is kept as it is (no replacement patterns)
  expect(applyEdits('cost', [{ old_string: 'cost', new_string: '$& $1' }])).toEqual({ text: '$& $1' })
})

test('the line diff: hunks with two lines of context, the counts, a new file, nothing for no change', () => {
  const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n') + '\n'
  const after = before.replace('three', '3').replace('nine\n', '')
  const d = lineDiff(before, after, 'notes/a.md')
  expect(d.added).toBe(1)
  expect(d.removed).toBe(2)
  expect(d.text).toBe(
    ['--- a/notes/a.md', '+++ b/notes/a.md', '@@ -1,5 +1,5 @@', ' one', ' two', '-three', '+3', ' four', ' five', '@@ -7,4 +7,3 @@', ' seven', ' eight', '-nine', ' ten', ''].join('\n'),
  )
  const fresh = lineDiff(null, 'a\nb\n', 'req/R-2.md')
  expect(fresh).toMatchObject({ added: 2, removed: 0 })
  expect(fresh.text.split('\n').slice(0, 3)).toEqual(['--- /dev/null', '+++ b/req/R-2.md', '@@ -0,0 +1,2 @@'])
  expect(lineDiff('same\n', 'same\n', 'x')).toEqual({ text: '', added: 0, removed: 0 })
  expect(diffHead(d.text, 3)).toEqual({ shown: ['@@ -1,5 +1,5 @@', ' one', ' two'], more: 9 })
})

test('applying: the draft as filed (or the one the person confirmed), on the version it was drafted on', () => {
  const base = hashText('a\nb\n')
  expect(applyVerdict(SPEC, base, 'a\nc\n', undefined)).toEqual({ ok: true, hash: SPEC.result, edited: false })
  // The file moved since: refused, nothing written
  expect(applyVerdict(SPEC, hashText('a\nz\n'), 'a\nc\n', undefined)).toEqual({ ok: false, why: 'moved' })
  // The draft was swapped (or the person edited it): refused until the person types its new version
  const edited = 'a\nc, better\n'
  const v = applyVerdict(SPEC, base, edited, undefined)
  expect(v).toEqual({ ok: false, why: 'draft-changed', hash: hashText(edited) })
  expect(applyVerdict(SPEC, base, edited, shortHash(hashText(edited)))).toEqual({ ok: true, hash: hashText(edited), edited: true })
  expect(applyVerdict(SPEC, base, edited, 'h12')).toMatchObject({ ok: false, why: 'draft-changed' })
  expect(applyVerdict(SPEC, base, null, undefined)).toEqual({ ok: false, why: 'draft-gone' })
  // A new file: drafted on nothing, so it must still be missing
  const fresh = { ...SPEC, base: null }
  expect(applyVerdict(fresh, null, 'a\nc\n', undefined)).toMatchObject({ ok: true })
  expect(applyVerdict(fresh, base, 'a\nc\n', undefined)).toEqual({ ok: false, why: 'moved' })
  expect(sameHash(undefined, SPEC.result)).toBe(false)
  expect(shortHash(null)).toBe('none')
})

test("the words: the asker's ticket and what it hears when the person answers; the draft's name", () => {
  expect(changeTicket('D-4', SPEC)).toContain('Queued as D-4 for the person: a change to req/R-1.md (+1 −1 lines)')
  expect(changeTicket('D-4', SPEC)).toContain('[D-4]')
  expect(changeTicket('D-4', SPEC)).not.toContain('Its summary is')
  // A long summary is kept whole (it was cut at 200 before), and the asker hears the brief shows only its start
  const summary = `${'the charter changes too: '.repeat(14)}the deadline`
  const c = checkChange({ path: 'a.md', summary, content: 'x' })
  expect(c.ok && c.summary).toBe(summary)
  expect(changeTicket('D-4', { ...SPEC, summary })).toContain(`Its summary is ${summary.length} characters: /fleet shows it whole, the brief only its start`)
  expect(changeDelivery('D-4', SPEC, { label: 'applied' }, null)).toBe('[D-4] The person applied your change to req/R-1.md ("the target goes down"): fleet wrote it as you drafted it.')
  expect(changeDelivery('D-4', SPEC, { label: 'applied', text: 'edited', note: 'keep it short' }, null)).toContain('with edits of their own to the draft: read it before you rely on it (note: keep it short)')
  expect(changeDelivery('D-4', SPEC, { label: 'rejected' }, null)).toContain("[D-4] The person rejected your change to req/R-1.md")
  expect(changeDelivery('D-4', SPEC, { label: 'stale', text: 'req/R-1.md changed at 14:02 by TEST B (Edit), after D-4 was drafted' }, null)).toBe(
    '[D-4] The person couldn\'t apply your change to req/R-1.md ("the target goes down"): req/R-1.md changed at 14:02 by TEST B (Edit), after D-4 was drafted. Read it again and file the change anew if it\'s still needed.',
  )
  expect(changeDelivery('D-4', SPEC, null, { why: 'not now' })).toContain('[D-4] The person dropped your change to req/R-1.md ("the target goes down") without applying it (not now)')
  expect(draftName('D-4', '.claude/fleet/roster.json')).toBe('D-4.json')
  expect(draftName('D-4', 'req/R-1')).toBe('D-4.txt')
})
