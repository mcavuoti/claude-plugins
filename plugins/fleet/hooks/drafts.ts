// Pure logic of the `change` decision (tested in tests/drafts.test.ts): what an instance files to change a
// command-level file (the charter, roster.json, world.json, role files, check scripts, the records world.json lists
// under "command"), the draft and the line diff the person reads, and what fleet checks before it writes the draft
// itself. No `$` here.
//
// Decision 1a: those files change only when fleet applies a change the person approved, bound to the file's version
// it was drafted on (base) and to the draft's (result), once. No agent tool writes them (every instance's settings
// deny it); the person's own editor always may (/fleet accept stamps it as his).

import { hashText } from './changes'

/** The change a queue record carries: the file (relative to the project), what it does, the versions it's bound to,
 * where the draft and its diff are (relative to the project's .claude/fleet/) and how many lines it adds and removes */
export type ChangeSpec = {
  path: string
  summary: string
  /** The file's version when it was drafted; null: it didn't exist */
  base: string | null
  /** The draft's version: fleet writes the draft only while it still has it (or the one the person confirmed) */
  result: string
  draft: string
  diff: string
  added: number
  removed: number
}
export type Edit = { old_string: string; new_string: string; replace_all?: boolean }
/** What the person answered to a change: fleet applied it, he rejected it, or it couldn't be applied (the file moved) */
export type ChangeOutcome = 'applied' | 'rejected' | 'stale'

/** The biggest draft fleet keeps */
export const MAX_DRAFT = 1024 * 1024
/** How many diff lines /fleet shows inline */
export const DIFF_SHOWN = 12

/** decide's input for kind change, tidied, or what to fix */
export function checkChange(input: any): { ok: true; path: string; summary: string; edits?: Edit[]; content?: string; blocks?: string } | { ok: false; reason: string } {
  const path = typeof input?.path === 'string' ? input.path.trim() : ''
  if (!path) return { ok: false, reason: 'path: name the file to change, relative to the project folder' }
  const summary = typeof input?.summary === 'string' ? input.summary.trim().replace(/\s+/g, ' ').slice(0, 200) : ''
  if (!summary) return { ok: false, reason: 'summary: say in one line what the change does and why' }
  const hasEdits = Array.isArray(input?.edits) && input.edits.length > 0
  const hasContent = typeof input?.content === 'string'
  if (hasEdits === hasContent) return { ok: false, reason: 'give either edits (old_string → new_string, as with Edit) or content (the whole new text), not both' }
  const blocks = typeof input?.blocks === 'string' ? input.blocks.trim().slice(0, 200) : ''
  const more = blocks ? { blocks } : {}
  if (hasContent) {
    if (input.content.length > MAX_DRAFT) return { ok: false, reason: `content: at most ${MAX_DRAFT} characters` }
    return { ok: true, path, summary, content: input.content, ...more }
  }
  const edits: Edit[] = []
  for (const [i, e] of (input.edits as any[]).entries()) {
    if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') return { ok: false, reason: `edit ${i + 1}: old_string and new_string are text` }
    if (!e.old_string) return { ok: false, reason: `edit ${i + 1}: old_string is empty (for a new file give content)` }
    edits.push({ old_string: e.old_string, new_string: e.new_string, ...(e.replace_all === true ? { replace_all: true } : {}) })
  }
  return { ok: true, path, summary, edits, ...more }
}

/** The text after the edits, in order, each as Edit does it: old_string found once (or every time with replace_all) */
export function applyEdits(text: string, edits: readonly Edit[]): { text: string } | { problem: string } {
  let out = text
  for (const [i, e] of edits.entries()) {
    const count = out.split(e.old_string).length - 1
    if (count === 0) return { problem: `edit ${i + 1}: old_string isn't in the file as it is now (read it again)` }
    if (count > 1 && !e.replace_all) return { problem: `edit ${i + 1}: old_string is in the file ${count} times: give more context, or replace_all` }
    out = e.replace_all ? out.split(e.old_string).join(e.new_string) : out.replace(e.old_string, () => e.new_string)
  }
  return { text: out }
}

/** The draft's file name: the decision's id with the target's extension, so an editor shows it as such */
export function draftName(id: string, path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '').slice(0, 10) : ''
  return ext ? `${id}.${ext}` : `${id}.txt`
}

// ---- A line diff (unified, 2 lines of context), by the longest common subsequence of the lines in between the
// common start and end. A middle too big for that is shown as all removed and all added ----

const CONTEXT = 2
const MAX_CELLS = 2_500_000

function lines(text: string): string[] {
  if (!text) return []
  const l = text.replace(/\r\n/g, '\n').split('\n')
  if (l[l.length - 1] === '') l.pop()
  return l
}

type Op = { kind: ' ' | '-' | '+'; line: string; a: number; b: number }

function ops(a: string[], b: string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const out: Op[] = []
  for (let i = 0; i < start; i++) out.push({ kind: ' ', line: a[i] as string, a: i, b: i })
  const am = a.slice(start, a.length - end)
  const bm = b.slice(start, b.length - end)
  const n = am.length
  const m = bm.length
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    am.forEach((line, i) => out.push({ kind: '-', line, a: start + i, b: start }))
    bm.forEach((line, j) => out.push({ kind: '+', line, a: start + n, b: start + j }))
  } else {
    // lcs[i][j]: the longest common subsequence of am[i..] and bm[j..]
    const w = m + 1
    const lcs = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = am[i] === bm[j] ? (lcs[(i + 1) * w + j + 1] as number) + 1 : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number)
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        out.push({ kind: ' ', line: am[i] as string, a: start + i, b: start + j })
        i++
        j++
      } else if (i < n && (j >= m || (lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number))) {
        // Removed lines before the added ones that take their place
        out.push({ kind: '-', line: am[i] as string, a: start + i, b: start + j })
        i++
      } else {
        out.push({ kind: '+', line: bm[j] as string, a: start + i, b: start + j })
        j++
      }
    }
  }
  for (let k = 0; k < end; k++) out.push({ kind: ' ', line: a[a.length - end + k] as string, a: a.length - end + k, b: b.length - end + k })
  return out
}

/** A unified diff of two texts, and how many lines it adds and removes. Empty text when they're the same */
export function lineDiff(before: string | null, after: string, path: string): { text: string; added: number; removed: number } {
  const a = lines(before ?? '')
  const b = lines(after)
  const all = ops(a, b)
  const added = all.filter(o => o.kind === '+').length
  const removed = all.filter(o => o.kind === '-').length
  if (!added && !removed) return { text: '', added, removed }
  // Hunks: the changed lines with CONTEXT lines around them, joined when they touch
  const changed = all.map((o, k) => (o.kind === ' ' ? -1 : k)).filter(k => k >= 0)
  const hunks: [number, number][] = []
  for (const k of changed) {
    const from = Math.max(0, k - CONTEXT)
    const to = Math.min(all.length - 1, k + CONTEXT)
    const last = hunks[hunks.length - 1]
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else hunks.push([from, to])
  }
  const out = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`]
  for (const [from, to] of hunks) {
    const part = all.slice(from, to + 1)
    const first = part[0] as Op
    const aCount = part.filter(o => o.kind !== '+').length
    const bCount = part.filter(o => o.kind !== '-').length
    out.push(`@@ -${aCount ? first.a + 1 : first.a},${aCount} +${bCount ? first.b + 1 : first.b},${bCount} @@`)
    for (const o of part) out.push(`${o.kind}${o.line}`)
  }
  return { text: `${out.join('\n')}\n`, added, removed }
}

/** The first lines of a diff that change something, after its two header lines */
export function diffHead(diff: string, max = DIFF_SHOWN): { shown: string[]; more: number } {
  const body = diff.split('\n').slice(2).filter(Boolean)
  return { shown: body.slice(0, max), more: Math.max(0, body.length - max) }
}

/** The short form of a version the person reads and types back: its first 9 characters (h + 8 hex) */
export function shortHash(v: string | null): string {
  return v ? v.slice(0, 9) : 'none'
}

/** Whether a version the person typed names this one (its short form, or more of it) */
export function sameHash(typed: string | undefined, v: string): boolean {
  return !!typed && typed.length >= 7 && v.toLowerCase().startsWith(typed.toLowerCase())
}

/** What fleet checks before it writes a draft: the decision not applied before (the caller claims that), the file still
 * at the version it was drafted on, the draft still the one filed (or the one the person confirmed after editing it) */
export function applyVerdict(spec: ChangeSpec, current: string | null, draft: string | null, confirmed: string | undefined): { ok: true; hash: string; edited: boolean } | { ok: false; why: 'moved' | 'draft-gone' | 'draft-changed'; hash?: string } {
  if (draft === null) return { ok: false, why: 'draft-gone' }
  const hash = hashText(draft)
  if (hash !== spec.result && !sameHash(confirmed, hash)) return { ok: false, why: 'draft-changed', hash }
  if (current !== spec.base) return { ok: false, why: 'moved' }
  return { ok: true, hash, edited: hash !== spec.result }
}

// ---- Words ----

export function changeTicket(id: string, spec: ChangeSpec): string {
  const what = spec.base === null ? 'a new file' : `+${spec.added} −${spec.removed} lines`
  return `Queued as ${id} for the person: a change to ${spec.path} (${what}). Nothing changes until the person applies it; then fleet writes your draft itself, as long as ${spec.path} is still as it is now. Don't write it another way meanwhile. The answer arrives later as a message from the fleet plugin that starts with [${id}].`
}

/** What the asker reads when its change was answered. It stands on its own (after a /clear too) */
export function changeDelivery(id: string, spec: ChangeSpec, outcome: { label?: string; text?: string; note?: string } | null, dropped: { why?: string } | null): string {
  const note = outcome?.note ? ` (note: ${outcome.note})` : ''
  if (dropped) return `[${id}] The person dropped your change to ${spec.path} ("${spec.summary}") without applying it${dropped.why ? ` (${dropped.why})` : ''}. Go on without it.`
  if (outcome?.label === 'applied') {
    const edited = outcome.text === 'edited' ? ', with edits of their own to the draft: read it before you rely on it' : ' as you drafted it'
    return `[${id}] The person applied your change to ${spec.path} ("${spec.summary}"): fleet wrote it${edited}${note}.`
  }
  if (outcome?.label === 'rejected') return `[${id}] The person rejected your change to ${spec.path} ("${spec.summary}")${note}. Don't make it another way; go on without it, or ask with mcp__fleet__decide.`
  return `[${id}] The person couldn't apply your change to ${spec.path} ("${spec.summary}"): ${outcome?.text ?? 'the file changed since you drafted it'}. Read it again and file the change anew if it's still needed.`
}
