// Pure logic of the outbound gate (tested in tests/outbound.test.ts): what counts as the project's content leaving to
// a third party, the person's allowlist (outbound.json), and the words of the gate and of an outbound draft. No `$`.
//
// The lightness rule: the one hard line is no exposure of the project's IP to third parties (sending it to Claude's
// servers is fine: the models run there). So in a background session, a call that sends content outside is refused
// with a way through: the model drafts it with mcp__fleet__send, the person reads exactly what would go out in /fleet
// and answers, and fleet runs it once, exactly as approved. Hosts, remotes and recipients the person allows (his own
// dev machine, his own address) pass. Reading the web stays free, and so does any ordinary local command.
//
// The classification is small on purpose, and errs towards asking:
// - an MCP tool whose name has a verb that writes (send, post, create, upload, reply…), or any tool of an outside
//   service (claude.ai's connectors, the browser) that isn't a read; outbound.json's tools.outbound adds tools,
//   tools.free takes them out;
// - in a Bash command (each part of a pipeline or list, $(…), bash -c, and what ssh runs on the other side):
//   curl and wget with data or an upload, scp, rsync and sftp to a host, ssh to a host, git push and git send-email,
//   gh's create, comment, edit, upload and review (and gh api with a method or fields), mail, sendmail and nc; and the
//   commands outbound.json's commands names. A program or script that sends by itself isn't seen: the models' own
//   guardrails and the person's permission settings are the rest.

/** Person data: outbound.json. It only gains fields, and a write keeps the fields it doesn't know */
export const OUTBOUND_FORMAT = 1

export type OutboundConfig = {
  outboundFormat: number
  /** Hosts (or *.domain) that are the person's own: ssh, scp, rsync, sftp, nc and uploads to them pass, and a git
   * remote on one of them */
  hosts: string[]
  /** Git remotes (names or URLs, globs) a push may go to */
  remotes: string[]
  /** Addresses a message may go to without asking (the person's own) */
  recipients: string[]
  /** Tool names (globs, mcp__<server>__<tool>) that send although their names don't say so, and ones that don't */
  tools: { outbound: string[]; free: string[] }
  /** Commands (by name) that send content outside whatever their arguments */
  commands: string[]
  /** MCP tools (globs) whose results are outside content, besides the outside services' reads: they mark the context */
  outside: string[]
  [key: string]: unknown
}

export function newOutbound(): OutboundConfig {
  return { outboundFormat: OUTBOUND_FORMAT, hosts: [], remotes: [], recipients: [], tools: { outbound: [], free: [] }, commands: [], outside: [] }
}

export function outboundText(c: OutboundConfig): string {
  return `${JSON.stringify(c, null, 2)}\n`
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : []
}

/** outbound.json: its lists, or why it can't be used (a newer fleet wrote it, or it isn't JSON) */
export function parseOutbound(text: string): { outbound: OutboundConfig } | { problem: string } {
  let o: any
  try {
    o = JSON.parse(text)
  } catch {
    return { problem: "outbound.json isn't valid JSON" }
  }
  if (!o || typeof o !== 'object' || typeof o.outboundFormat !== 'number') return { problem: 'outbound.json has no outboundFormat' }
  if (o.outboundFormat > OUTBOUND_FORMAT) return { problem: `outbound.json is from a newer fleet (outboundFormat ${o.outboundFormat}): restart this session (u) to load it` }
  const tools = o.tools && typeof o.tools === 'object' ? o.tools : {}
  return {
    outbound: {
      ...o,
      hosts: strings(o.hosts),
      remotes: strings(o.remotes),
      recipients: strings(o.recipients),
      tools: { ...tools, outbound: strings(tools.outbound), free: strings(tools.free) },
      commands: strings(o.commands),
      outside: strings(o.outside),
    },
  }
}

// ---- Hosts ----

/** The host a destination names: a URL (scheme://user@host:port/…), an scp or rsync target (user@host:path,
 * host::module), an ssh destination (user@host), or a bare host with a path (example.com/x); null for a local path */
export function hostOf(target: string): string | null {
  const t = target.trim()
  if (!t) return null
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(t)
  if (url) {
    if ((url[1] as string).toLowerCase() === 'file') return null
    return cleanHost(url[2] as string)
  }
  if (t.startsWith('/') || t.startsWith('./') || t.startsWith('../') || t.startsWith('~') || t === '.' || t === '..') return null
  const bracket = /^(?:[^@/]+@)?\[([^\]]+)\]/.exec(t)
  if (bracket) return (bracket[1] as string).toLowerCase()
  const colon = /^((?:[^@/:]+@)?[^/:@]+):/.exec(t)
  if (colon) return cleanHost(colon[1] as string)
  return cleanHost(t.split('/')[0] as string)
}

function cleanHost(s: string): string | null {
  let h = s.includes('@') ? s.slice(s.lastIndexOf('@') + 1) : s
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined)
  else h = h.replace(/:\d*$/, '')
  h = h.trim().toLowerCase().replace(/\.$/, '')
  return h && /^[a-z0-9._:%-]+$/.test(h) ? h : null
}

/** This machine: nothing that goes there leaves it */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1' || h === '0.0.0.0' || h === '0'
}

/** A value against an entry of the person's lists: the same (ignoring case), or a glob where * is anything (? one) */
export function matches(value: string, pattern: string): boolean {
  const v = value.toLowerCase()
  const p = pattern.toLowerCase()
  if (p === v) return true
  if (!/[*?]/.test(p)) return false
  const re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${re}$`).test(v)
}

/** A host the person allows: on the list as it is, or under a *.domain entry (a user@ before it, or a :port after it,
 * counts as the host); this machine always */
export function hostAllowed(host: string | null, c: OutboundConfig): boolean {
  if (!host) return false
  if (isLocalHost(host)) return true
  return c.hosts.some(entry => {
    const e = entry.trim().toLowerCase().replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/\.$/, '')
    if (e === '*') return true
    if (e.startsWith('*.')) return host === e.slice(2) || host.endsWith(e.slice(1))
    return host === e
  })
}

export function recipientAllowed(address: string, c: OutboundConfig): boolean {
  const a = address.trim().replace(/^.*<([^>]+)>.*$/, '$1').toLowerCase()
  return !!a && c.recipients.some(r => matches(a, r.trim()))
}

/** A git remote a push may go to: a local path (nothing leaves), a remote or URL on the list, or a URL on a host the
 * person allows */
export function remoteAllowed(name: string | null, url: string | null, c: OutboundConfig): boolean {
  const u = url ?? (name && /[:/]/.test(name) ? name : null)
  if (u !== null && hostOf(u) === null) return true
  if (name && c.remotes.some(r => matches(name, r))) return true
  if (u && c.remotes.some(r => matches(u, r))) return true
  return !!u && hostAllowed(hostOf(u), c)
}

// ---- What a call sends ----

/** One way content would leave: what it is (for the person and the model), where to, and the files it sends */
export type Send = { what: string; to: string[]; files: string[] }
/** A git push whose remote has to be looked up (its URL) before it's known whether it leaves */
export type Push = { remote: string | null; cwd: string | null; words: string[] }

// ---- MCP tools ----

// The verbs of a tool's name that send content (any word of it), that only read (with none that sends), and that do
// neither (they move or mark what's there: a label, the trash)
const WRITES = new Set([
  'send', 'post', 'publish', 'upload', 'share', 'reply', 'forward', 'create', 'update', 'write', 'put', 'comment', 'submit', 'invite',
  'tweet', 'append', 'insert', 'edit', 'respond', 'notify', 'upsert', 'patch', 'push', 'save', 'input', 'type', 'fill', 'execute',
])
const READS = new Set([
  'get', 'list', 'search', 'read', 'fetch', 'query', 'find', 'describe', 'view', 'download', 'export', 'lookup', 'check', 'count',
  'show', 'status', 'scan', 'inspect', 'preview', 'suggest', 'resolve', 'info', 'browse', 'context', 'select', 'authenticate',
  'screenshot', 'console', 'network',
])
const NEUTRAL = new Set([
  'delete', 'remove', 'trash', 'untrash', 'archive', 'unarchive', 'mark', 'unmark', 'label', 'unlabel', 'apply', 'close', 'resize',
  'switch', 'stop', 'cancel', 'star', 'unstar', 'mute', 'snooze', 'pin', 'unpin', 'complete',
])

/** The words of a tool's name: send_message → send, message; createDraft → create, draft */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(w => w.toLowerCase())
    .filter(Boolean)
}

/** mcp__<server>__<tool> split; null for anything else */
export function mcpParts(tool: string): { server: string; name: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  return m ? { server: m[1] as string, name: m[2] as string } : null
}

/** Claude's own connectors (claude.ai's documents): sending there is sending to Claude's servers, which is fine */
export function claudeServer(server: string): boolean {
  return /^claude_ai_Claude_/i.test(server)
}

/** A service outside this machine: claude.ai's connectors to others (mail, files, calendars…) and the browser */
export function outsideServer(server: string): boolean {
  return (/^claude_ai_/i.test(server) && !claudeServer(server)) || /^claude[-_]in[-_]chrome$/i.test(server)
}

function toolListed(tool: string, globs: readonly string[]): boolean {
  return globs.some(g => matches(tool, g))
}

const RECIPIENT_KEYS = ['to', 'cc', 'bcc', 'recipient', 'recipients', 'email', 'emails', 'attendees', 'address', 'addresses']

/** The addresses an MCP call's input names (to, cc, bcc, attendees…), as text */
export function recipientsOf(input: Record<string, unknown>): string[] {
  const out: string[] = []
  const add = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const p of v.split(/[,;]/)) if (p.trim()) out.push(p.trim())
    } else if (Array.isArray(v)) {
      for (const x of v) add(x)
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      add(o.email ?? o.address)
    }
  }
  for (const k of RECIPIENT_KEYS) if (k in input) add(input[k])
  return out
}

/** An MCP call: whether it sends content outside (and where), and whether its result is outside content (it marks the
 * context). An outside service's tool that doesn't read sends, unless it only moves or marks what's there; another
 * server's sends when its name has a verb that writes. The person's lists come first; a message whose every recipient
 * is on his list passes */
export function classifyMcp(tool: string, input: Record<string, unknown>, c: OutboundConfig): { send: Send | null; outside: boolean } {
  const parts = mcpParts(tool)
  if (!parts || /^fleet$/i.test(parts.server)) return { send: null, outside: false }
  const words = nameWords(parts.name)
  const remote = outsideServer(parts.server)
  const writes = words.some(w => WRITES.has(w))
  const reads = !writes && words.some(w => READS.has(w))
  const neutral = !writes && !reads && words.some(w => NEUTRAL.has(w))
  const outside = toolListed(tool, c.outside) || (remote && reads)
  const listed = toolListed(tool, c.tools.outbound)
  if (!listed && (toolListed(tool, c.tools.free) || claudeServer(parts.server))) return { send: null, outside }
  if (!listed && !writes && !(remote && !reads && !neutral)) return { send: null, outside }
  const to = recipientsOf(input)
  if (!listed && to.length && to.every(r => recipientAllowed(r, c))) return { send: null, outside }
  return { send: { what: `${parts.name} on ${parts.server}`, to: to.length ? to : [parts.server], files: [] }, outside }
}

// ---- Bash: the simple commands a line runs ----

/** The simple commands of a shell line, each as its words (quotes taken off), with what $(…), `…`, bash -c and eval
 * run as commands of their own. Redirections and their targets are left out. A best effort, not a shell */
export function commandsOf(line: string, depth = 0): string[][] {
  const out: string[][] = []
  if (depth > 4) return out
  let seg: string[] = []
  let word = ''
  let inWord = false
  let skip = false
  const heredocs: { delim: string; strip: boolean }[] = []
  const bodies: string[] = []
  const endWord = () => {
    if (inWord) {
      if (skip) skip = false
      else seg.push(word)
    }
    word = ''
    inWord = false
  }
  const endSeg = () => {
    endWord()
    if (seg.length) out.push(seg)
    seg = []
  }
  // The text of $( … ) or <( … ) from i (at the open paren), and where it ends
  const sub = (i: number): { inner: string; end: number } => {
    let d = 0
    for (let j = i; j < line.length; j++) {
      if (line[j] === '(') d++
      else if (line[j] === ')') {
        d--
        if (d === 0) return { inner: line.slice(i + 1, j), end: j }
      }
    }
    return { inner: line.slice(i + 1), end: line.length - 1 }
  }
  let i = 0
  while (i < line.length) {
    const ch = line[i] as string
    if (ch === "'") {
      const end = line.indexOf("'", i + 1)
      word += line.slice(i + 1, end < 0 ? line.length : end)
      inWord = true
      i = end < 0 ? line.length : end + 1
      continue
    }
    if (ch === '"') {
      inWord = true
      let j = i + 1
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1] as string)) {
          word += line[j + 1]
          j += 2
          continue
        }
        if (line[j] === '$' && line[j + 1] === '(') {
          const s = sub(j + 1)
          out.push(...commandsOf(s.inner, depth + 1))
          word += `$(${s.inner})`
          j = s.end + 1
          continue
        }
        if (line[j] === '`') {
          const end = line.indexOf('`', j + 1)
          const inner = line.slice(j + 1, end < 0 ? line.length : end)
          out.push(...commandsOf(inner, depth + 1))
          word += `\`${inner}\``
          j = end < 0 ? line.length : end + 1
          continue
        }
        word += line[j]
        j++
      }
      i = j + 1
      continue
    }
    if (ch === '\\') {
      if (line[i + 1] === '\n') i += 2
      else {
        word += line[i + 1] ?? ''
        inWord = true
        i += 2
      }
      continue
    }
    if ((ch === '$' || ch === '<' || ch === '>') && line[i + 1] === '(') {
      const s = sub(i + 1)
      out.push(...commandsOf(s.inner, depth + 1))
      word += `${ch}(${s.inner})`
      inWord = true
      i = s.end + 1
      continue
    }
    if (ch === '`') {
      const end = line.indexOf('`', i + 1)
      const inner = line.slice(i + 1, end < 0 ? line.length : end)
      out.push(...commandsOf(inner, depth + 1))
      word += `\`${inner}\``
      inWord = true
      i = end < 0 ? line.length : end + 1
      continue
    }
    if (ch === '#' && !inWord) {
      const end = line.indexOf('\n', i)
      i = end < 0 ? line.length : end
      continue
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '(' || ch === ')') {
      if (ch === '&' && /[<>]$/.test(word)) {
        word += ch
        i++
        continue
      }
      endSeg()
      i++
      // A here-document's lines are text fed to the command, not commands: they end at their delimiter's line
      if (ch === '\n' && heredocs.length) {
        for (const h of heredocs.splice(0)) {
          const body: string[] = []
          while (i < line.length) {
            const end = line.indexOf('\n', i)
            const row = line.slice(i, end < 0 ? line.length : end)
            i = end < 0 ? line.length : end + 1
            if ((h.strip ? row.replace(/^\t+/, '') : row) === h.delim) break
            body.push(row)
          }
          bodies.push(body.join('\n'))
        }
      }
      continue
    }
    if (ch === '<' || ch === '>') {
      // A redirection: a number before it (2>) and the target after it (or &1) aren't words
      if (inWord && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      } else endWord()
      let j = i
      while (j < line.length && (line[j] === '<' || line[j] === '>')) j++
      const op = line.slice(i, j)
      if (op === '<<') {
        // A here-document (<<EOF, <<-'EOF'): its delimiter, without quotes; its lines are skipped at the next line
        const strip = line[j] === '-'
        if (strip) j++
        while (line[j] === ' ' || line[j] === '\t') j++
        let delim = ''
        while (j < line.length && !/[\s;&|<>()]/.test(line[j] as string)) {
          const q = line[j] as string
          if (q === "'" || q === '"') {
            const end = line.indexOf(q, j + 1)
            delim += line.slice(j + 1, end < 0 ? line.length : end)
            j = end < 0 ? line.length : end + 1
          } else if (q === '\\') {
            delim += line[j + 1] ?? ''
            j += 2
          } else {
            delim += q
            j++
          }
        }
        if (delim) heredocs.push({ delim, strip })
        i = j
        continue
      }
      if (line[j] === '&') {
        j++
        while (j < line.length && /[\d-]/.test(line[j] as string)) j++
      } else skip = true
      i = j
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord()
      i++
      continue
    }
    word += ch
    inWord = true
    i++
  }
  endSeg()
  // What a shell or eval runs, as commands of their own; and a here-document's lines when a shell (or ssh) on the line
  // reads its commands from them
  const more: string[][] = []
  let script = false
  for (const s of out) {
    const w = stripPrefixes(s)
    const cmd = baseName(w[0] ?? '')
    if (SHELLS.includes(cmd)) {
      const k = w.findIndex((x, n) => n > 0 && /^-[a-z]*c[a-z]*$/.test(x))
      if (k > 0 && w[k + 1] !== undefined) more.push(...commandsOf(w[k + 1] as string, depth + 1))
      else if (!w.slice(1).some(x => !x.startsWith('-')) || w.includes('-s')) script = true
    } else if (cmd === 'eval' && w.length > 1) more.push(...commandsOf(w.slice(1).join(' '), depth + 1))
    else if (cmd === 'ssh') script = true
  }
  if (script) for (const b of bodies) more.push(...commandsOf(b, depth + 1))
  return [...out, ...more]
}

const SHELLS = ['bash', 'sh', 'zsh', 'dash', 'ksh']

function baseName(w: string): string {
  return w.slice(w.lastIndexOf('/') + 1)
}

const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', 'case', 'esac'])

/** A simple command without what runs it: VAR=x, the shell's own words (if, then, do, {…), sudo, env, nohup, time,
 * command, exec, nice, timeout, xargs */
export function stripPrefixes(words: readonly string[]): string[] {
  let w = [...words]
  for (let guard = 0; guard < 10 && w.length; guard++) {
    while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] as string) || KEYWORDS.has(w[0] as string))) w = w.slice(1)
    const c = baseName(w[0] ?? '')
    if (c === 'sudo' || c === 'doas') {
      let k = 1
      while (k < w.length && (w[k] as string).startsWith('-')) k += /^-[ugCDhpRrTU]$/.test(w[k] as string) ? 2 : 1
      w = w.slice(k)
    } else if (c === 'env') {
      let k = 1
      while (k < w.length && ((w[k] as string).startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k] as string))) k += /^-[uCS]$/.test(w[k] as string) ? 2 : 1
      w = w.slice(k)
    } else if (c === 'nohup' || c === 'time' || c === 'command' || c === 'builtin' || c === 'exec' || c === 'caffeinate') {
      let k = 1
      while (k < w.length && (w[k] as string).startsWith('-')) k++
      w = w.slice(k)
    } else if (c === 'nice') {
      let k = 1
      while (k < w.length && (w[k] as string).startsWith('-')) k += w[k] === '-n' ? 2 : 1
      w = w.slice(k)
    } else if (c === 'timeout') {
      let k = 1
      while (k < w.length && (w[k] as string).startsWith('-')) k += /^-(s|k)$/.test(w[k] as string) ? 2 : 1
      w = w.slice(k + 1)
    } else if (c === 'xargs') {
      let k = 1
      while (k < w.length && (w[k] as string).startsWith('-')) k += /^-[IJLnPsEd]$/.test(w[k] as string) ? 2 : 1
      w = w.slice(k)
    } else break
  }
  return w
}

/** The operands of a command (its words that aren't options), given the options that take a value */
function operands(words: readonly string[], withValue: RegExp): { args: string[]; opts: { name: string; value: string | null }[] } {
  const args: string[] = []
  const opts: { name: string; value: string | null }[] = []
  for (let k = 0; k < words.length; k++) {
    const x = words[k] as string
    if (x === '--') {
      args.push(...words.slice(k + 1))
      break
    }
    if (x.startsWith('--')) {
      const eq = x.indexOf('=')
      if (eq > 0) opts.push({ name: x.slice(0, eq), value: x.slice(eq + 1) })
      else if (withValue.test(x)) opts.push({ name: x, value: words[++k] ?? null })
      else opts.push({ name: x, value: null })
    } else if (x.startsWith('-') && x.length > 1) {
      // A group of short options (-sSL): the last may take a value, glued (-dfoo) or next
      const flags = x.slice(1)
      for (let n = 0; n < flags.length; n++) {
        const f = `-${flags[n]}`
        if (withValue.test(f)) {
          const glued = flags.slice(n + 1)
          opts.push({ name: f, value: glued || (words[++k] ?? null) })
          break
        }
        opts.push({ name: f, value: null })
      }
    } else args.push(x)
  }
  return { args, opts }
}

const CURL_VALUE = /^(-[dFTXHouAebcxmwKErCYyzDQ]|--(data|data-raw|data-binary|data-ascii|data-urlencode|form|form-string|upload-file|request|header|output|user|user-agent|referer|cookie|cookie-jar|proxy|max-time|connect-timeout|write-out|config|url|json|cert|key|cacert|resolve|interface|range|continue-at|retry|retry-delay|retry-max-time|dump-header|limit-rate|max-filesize|oauth2-bearer|aws-sigv4|variable|expand-data|proxy-user|unix-socket|output-dir|trace|trace-ascii|stderr))$/
const WGET_VALUE = /^(-[OoPUeatTwQiBDlAR]|--(post-data|post-file|body-data|body-file|method|header|user|password|output-document|output-file|directory-prefix|user-agent|tries|timeout|wait|quota|input-file|base|domains|level|accept|reject|execute))$/
const SCP_VALUE = /^-[PiFcolSJDX]$/
const SSH_VALUE = /^-[bcDEeFIiJLlmOopQRSWwB]$/
const RSYNC_VALUE = /^(-[efTBM]|--(rsh|filter|exclude|include|exclude-from|include-from|files-from|log-file|temp-dir|partial-dir|password-file|port|chmod|chown|block-size|max-size|min-size|timeout|contimeout|backup-dir|suffix|compare-dest|copy-dest|link-dest|remote-option|out-format|rsync-path))$/
const SFTP_VALUE = /^-[PiFobBcDlRSJX]$/
const GIT_GLOBAL_VALUE = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/
const GH_VALUE = /^(-X|--method|-f|-F|--field|--raw-field|--input|-H|--header|--hostname|-R|--repo|-t|--title|-b|--body|-B|--base|-q|--jq|--template|-p|--preview)$/
const NC_VALUE = /^-[psiIOqTwXx]$/

function remoteTarget(x: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(x)) return !/^file:/i.test(x)
  return hostOf(x) !== null && /^(?:[^@/:]+@)?(?:\[[^\]]+\]|[^/:@]+):/.test(x)
}

function localFile(x: string): string | null {
  return x && x !== '-' && !remoteTarget(x) ? x : null
}

/** What a Bash line sends outside (each part of it), the pushes whose remote has to be looked up, and the outside
 * hosts it reads from (curl and wget without data: reading the web marks the context, it isn't held) */
export function classifyBash(line: string, c: OutboundConfig): { sends: Send[]; pushes: Push[]; reads: string[] } {
  const sends: Send[] = []
  const pushes: Push[] = []
  const reads: string[] = []
  for (const raw of commandsOf(line)) {
    const w = stripPrefixes(raw)
    if (!w.length) continue
    const cmd = baseName(w[0] as string)
    const rest = w.slice(1)
    if (c.commands.some(x => x === cmd)) {
      sends.push({ what: cmd, to: ['outside'], files: [] })
      continue
    }
    if (cmd === 'curl') {
      const { args, opts } = operands(rest, CURL_VALUE)
      const urls = [...args, ...opts.filter(o => o.name === '--url').map(o => o.value ?? '')].filter(Boolean)
      const data = opts.filter(o => /^(-d|-F|-T|--data.*|--form.*|--upload-file|--json)$/.test(o.name))
      const method = opts.find(o => o.name === '-X' || o.name === '--request')?.value?.toUpperCase() ?? ''
      // The files it sends: -T f, -d @f (and --data-binary @f, --json @f), -F name=@f or name=<f
      const files: string[] = []
      for (const o of data) {
        const v = o.value ?? ''
        const form = /=[@<]([^;]+)/.exec(v)
        const f = o.name === '-T' || o.name === '--upload-file' ? v : o.name === '-F' || o.name === '--form' ? (form?.[1] ?? '') : o.name === '--form-string' ? '' : v.startsWith('@') ? v.slice(1) : ''
        const local = localFile(f)
        if (local) files.push(local)
      }
      const hosts = urls.map(u => hostOf(u)).filter((h): h is string => h !== null)
      const away = hosts.filter(h => !hostAllowed(h, c))
      if (data.length || /^(POST|PUT|PATCH)$/.test(method)) {
        if (away.length || !hosts.length) sends.push({ what: `curl sending data${files.length ? ` (${files.join(', ')})` : ''}`, to: away.length ? away : ['an address fleet can’t read'], files })
      } else reads.push(...away)
      continue
    }
    if (cmd === 'wget') {
      const { args, opts } = operands(rest, WGET_VALUE)
      const data = opts.filter(o => /^--(post-data|post-file|body-data|body-file)$/.test(o.name))
      const method = (opts.find(o => o.name === '--method')?.value ?? '').toUpperCase()
      const files = opts.filter(o => /^--(post-file|body-file)$/.test(o.name) && o.value).map(o => o.value as string)
      const away = args.map(u => hostOf(u)).filter((h): h is string => h !== null && !hostAllowed(h, c))
      if (data.length || /^(POST|PUT|PATCH)$/.test(method)) {
        if (away.length || !args.length) sends.push({ what: `wget sending data${files.length ? ` (${files.join(', ')})` : ''}`, to: away.length ? away : ['an address fleet can’t read'], files })
      } else reads.push(...away)
      continue
    }
    if (cmd === 'scp' || cmd === 'rsync') {
      const { args } = operands(rest, cmd === 'scp' ? SCP_VALUE : RSYNC_VALUE)
      if (args.length < 2) continue
      const dest = args[args.length - 1] as string
      if (!remoteTarget(dest) && !/::/.test(dest)) continue
      const host = /^rsync:\/\//i.test(dest) ? hostOf(dest) : /::/.test(dest) ? cleanHost(dest.slice(0, dest.indexOf('::'))) : hostOf(dest)
      if (hostAllowed(host, c)) continue
      const files = args.slice(0, -1).map(localFile).filter((v): v is string => !!v)
      sends.push({ what: `${cmd} of ${files.length ? files.join(', ') : 'files'}`, to: [host ?? dest], files })
      continue
    }
    if (cmd === 'sftp') {
      const { args } = operands(rest, SFTP_VALUE)
      const host = args[0] ? hostOf(args[0]) : null
      if (args[0] && !hostAllowed(host, c)) sends.push({ what: 'sftp', to: [host ?? (args[0] as string)], files: [] })
      continue
    }
    if (cmd === 'ssh') {
      const { args } = operands(rest, SSH_VALUE)
      const dest = args[0]
      if (!dest) continue
      const host = hostOf(dest)
      if (!hostAllowed(host, c)) sends.push({ what: `ssh${args.length > 1 ? ' running a command' : ''}`, to: [host ?? dest], files: [] })
      else if (args.length > 1) {
        // What runs on the person's own machine goes through the same rules
        const inner = classifyBash(args.slice(1).join(' '), c)
        sends.push(...inner.sends.map(s => ({ ...s, what: `${s.what} (through ssh on ${host})`, files: [] })))
        reads.push(...inner.reads)
      }
      continue
    }
    if (cmd === 'git') {
      // The global options stop at the subcommand
      let k = 0
      let cwd: string | null = null
      while (k < rest.length && (rest[k] as string).startsWith('-')) {
        const x = rest[k] as string
        if (x === '-C') cwd = rest[k + 1] ?? null
        k += GIT_GLOBAL_VALUE.test(x) ? 2 : 1
      }
      const sub = rest[k]
      const after = rest.slice(k + 1)
      if (sub === 'push') {
        const p = operands(after, /^(-o|--push-option|--repo|--receive-pack|--exec)$/)
        if (p.opts.some(o => o.name === '-n' || o.name === '--dry-run')) continue
        const repo = p.opts.find(o => o.name === '--repo')?.value ?? p.args[0] ?? null
        pushes.push({ remote: repo, cwd, words: after })
      } else if (sub === 'send-email') {
        const p = operands(after, /^(--to|--cc|--bcc|--from|--in-reply-to|--subject|--smtp-server|--smtp-user|--smtp-server-port|--identity)$/)
        const to = p.opts.filter(o => /^--(to|cc|bcc)$/.test(o.name) && o.value).map(o => o.value as string)
        if (!to.length || !to.every(r => recipientAllowed(r, c))) sends.push({ what: 'git send-email', to: to.length ? to : ['recipients fleet can’t read'], files: p.args.filter(a => !a.startsWith('-')) })
      }
      continue
    }
    if (cmd === 'gh') {
      const { args, opts } = operands(rest, GH_VALUE)
      const host = (opts.find(o => o.name === '--hostname')?.value ?? 'github.com').toLowerCase()
      if (hostAllowed(host, c)) continue
      const [group = '', verb = ''] = args
      const writes = ['create', 'comment', 'edit', 'upload', 'review']
      const api = group === 'api' && (opts.some(o => /^(-f|-F|--field|--raw-field|--input)$/.test(o.name)) || /^(POST|PUT|PATCH|DELETE)$/i.test(opts.find(o => o.name === '-X' || o.name === '--method')?.value ?? ''))
      if (api || writes.includes(verb)) sends.push({ what: `gh ${[group, verb].filter(Boolean).join(' ')}`, to: [host], files: [] })
      continue
    }
    if (cmd === 'mail' || cmd === 'mailx' || cmd === 'sendmail' || cmd === 'mutt') {
      const { args } = operands(rest, /^-[sacbrFfiAeEuR]$/)
      const to = args.filter(a => a.includes('@') || /^[A-Za-z0-9._-]+$/.test(a))
      if (!to.length || !to.every(r => recipientAllowed(r, c))) sends.push({ what: cmd, to: to.length ? to : ['recipients fleet can’t read'], files: [] })
      continue
    }
    if (cmd === 'nc' || cmd === 'ncat' || cmd === 'netcat') {
      const { args, opts } = operands(rest, NC_VALUE)
      if (opts.some(o => o.name === '-l' || o.name === '--listen')) continue
      const host = args[0] ? hostOf(args[0]) : null
      if (args[0] && !hostAllowed(host, c)) sends.push({ what: cmd, to: [host ?? (args[0] as string)], files: [] })
    }
  }
  return { sends, pushes, reads: [...new Set(reads)] }
}

// ---- Words ----

export function sendWords(sends: readonly Send[]): string {
  const parts = sends.map(s => `${s.what} to ${s.to.join(', ')}`)
  return [...new Set(parts)].join('; ')
}

/** What the model reads when its call is held: it wasn't made, and how it goes out with the person's approval */
export function outboundRefusal(sends: readonly Send[], how: 'command' | 'tool'): string {
  return [
    `fleet: this ${how === 'command' ? 'command' : 'call'} would send the project's content outside it (${sendWords(sends)}), which needs the person's approval, so it was not ${how === 'command' ? 'run' : 'made'}.`,
    `If it should go out, draft it with mcp__fleet__send: to, why (one line), and the exact ${how === 'command' ? 'command' : 'call (mcp_tool, the tool’s name, and input)'} as you'd have run it (and files, any other file whose content it sends).`,
    "The person reads exactly what would go out in /fleet and answers; once approved, fleet runs it exactly as drafted, once, and tells you the result. Don't send it another way meanwhile.",
    'The hosts, remotes and recipients the person allows are in .claude/fleet/outbound.json (yours to read, not to change: propose a change with mcp__fleet__decide kind "change").',
  ].join(' ')
}

/** mcp__fleet__send's input: where to, why, and the exact call (a Bash command, or an MCP tool and its input) */
export const SEND_SCHEMA = {
  type: 'object',
  required: ['to', 'why'],
  properties: {
    to: { type: 'string', maxLength: 300, description: 'Who or where it goes: an address, a host, a remote, a channel' },
    why: { type: 'string', maxLength: 300, description: 'One line: why it should go out' },
    command: { type: 'string', maxLength: 20000, description: 'The exact Bash command to run once approved (instead of mcp_tool and input)' },
    mcp_tool: { type: 'string', description: 'The MCP tool to call once approved, by its full name (mcp__<server>__<tool>), with input' },
    input: { type: 'object', description: "The MCP tool's exact input" },
    files: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Optional: other files whose content it sends (fleet finds the ones a curl, scp or rsync names)' },
    blocks: { type: 'string', maxLength: 200, description: 'Optional: what waits on it' },
  },
} as const

export const SEND_DESCRIPTION =
  "Draft something that sends the project's content outside it (a message, a post, an upload, a git push to a remote the person hasn't allowed) for the person's approval. In a background session fleet refuses such a call when you make it directly; draft it here instead, with the exact command, or the MCP tool (mcp_tool) and input, you would run. The person reads exactly what would go out and answers from any session; once approved, fleet runs it exactly as drafted, once, and the result arrives later as a message from the fleet plugin that starts with [D-<n>]. Meanwhile go on with what doesn't depend on it, and don't send it another way. Reading the web, and anything that stays on this machine or goes to the hosts the person allows (.claude/fleet/outbound.json), needs no draft."

export type SendInput = { to: string; why: string; command?: string; tool?: string; input?: Record<string, unknown>; files: string[]; blocks?: string }

/** mcp__fleet__send's input, tidied, or what to fix. The MCP call's name is mcp_tool: a tool call's own "tool" is the
 * name of the tool called (mcp__fleet__send itself) */
export function checkSend(input: any): { ok: true; send: SendInput } | { ok: false; reason: string } {
  const to = typeof input?.to === 'string' ? input.to.trim().slice(0, 300) : ''
  if (!to) return { ok: false, reason: 'to: say who or where it goes' }
  const why = typeof input?.why === 'string' ? input.why.trim().replace(/\s+/g, ' ').slice(0, 300) : ''
  if (!why) return { ok: false, reason: 'why: say in one line why it should go out' }
  const command = typeof input?.command === 'string' ? input.command.trim() : ''
  const tool = typeof input?.mcp_tool === 'string' ? input.mcp_tool.trim() : ''
  if (!!command === !!tool) return { ok: false, reason: 'give either command (the exact Bash command) or mcp_tool and input (an MCP call), not both' }
  if (command.length > 20000) return { ok: false, reason: 'command: at most 20000 characters' }
  if (tool && !mcpParts(tool)) return { ok: false, reason: 'mcp_tool: an MCP tool, mcp__<server>__<tool>' }
  if (tool && /^mcp__fleet__/.test(tool)) return { ok: false, reason: "mcp_tool: fleet's own tools send nothing outside" }
  if (tool && input?.input !== undefined && (typeof input.input !== 'object' || input.input === null || Array.isArray(input.input))) return { ok: false, reason: "input: the tool's input, as an object" }
  const files = strings(input?.files).slice(0, 20)
  const blocks = typeof input?.blocks === 'string' ? input.blocks.trim().slice(0, 200) : ''
  return {
    ok: true,
    send: { to, why, ...(command ? { command } : { tool, input: (input?.input as Record<string, unknown>) ?? {} }), files, ...(blocks ? { blocks } : {}) },
  }
}

/** The outbound a queue record carries: what it is, where it goes, why; the exact call (its draft file, relative to
 * <project>/.claude/fleet/, which the person may edit), the files it sends with their versions when it was drafted,
 * the folder it runs from, and the version the person approves: the draft and the files together */
export type OutboundSpec = {
  to: string
  why: string
  what: string
  how: 'command' | 'tool'
  draft: string
  files: { path: string; v: string | null }[]
  cwd: string
  hash: string
}

/** The draft file's text: the exact call, as fleet will make it */
export function draftText(s: SendInput): string {
  return `${JSON.stringify(s.command !== undefined ? { command: s.command } : { tool: s.tool, input: s.input ?? {} }, null, 2)}\n`
}

/** The call a draft file holds, or why it can't be made (the person edited it into something else) */
export function parseDraft(text: string): { command: string } | { tool: string; input: Record<string, unknown> } | { problem: string } {
  let d: any
  try {
    d = JSON.parse(text)
  } catch {
    return { problem: "the draft isn't valid JSON" }
  }
  if (d && typeof d.command === 'string' && d.command.trim()) return { command: d.command }
  if (d && typeof d.tool === 'string' && mcpParts(d.tool) && !/^mcp__fleet__/.test(d.tool)) {
    if (d.input !== undefined && (typeof d.input !== 'object' || d.input === null || Array.isArray(d.input))) return { problem: "the draft's input isn't an object" }
    return { tool: d.tool, input: d.input ?? {} }
  }
  return { problem: 'the draft holds neither a command nor an MCP tool and its input' }
}

/** The version the person approves: the draft's text and every file it sends, as they are */
export function outboundHash(draft: string, files: readonly { path: string; v: string | null }[], hash: (t: string) => string): string {
  return hash([draft, ...files.map(f => `${f.path}\t${f.v ?? 'missing'}`)].join('\n'))
}

export function outboundTicket(id: string, spec: OutboundSpec): string {
  return `Queued as ${id} for the person: ${spec.what} to ${spec.to}. Nothing goes out until the person approves it; then fleet runs it exactly as drafted, once${spec.files.length ? `, with ${spec.files.map(f => f.path).join(', ')} as ${spec.files.length === 1 ? 'it is' : 'they are'} now (a change to ${spec.files.length === 1 ? 'it' : 'them'} needs a new approval)` : ''}. Don't send it another way meanwhile. The answer arrives later as a message from the fleet plugin that starts with [${id}].`
}

/** What the asker reads when its outbound was answered. It stands on its own (after a /clear too) */
export function outboundDelivery(id: string, spec: OutboundSpec, outcome: { label?: string; text?: string; note?: string } | null, dropped: { why?: string } | null): string {
  const what = `${spec.what} to ${spec.to}`
  const note = outcome?.note ? ` (note: ${outcome.note})` : ''
  if (dropped) return `[${id}] The person dropped your outbound (${what}) without sending it${dropped.why ? ` (${dropped.why})` : ''}. Don't send it another way.`
  if (outcome?.label === 'sent') return `[${id}] The person approved your outbound (${what}), and fleet ran it exactly as drafted, once: ${outcome.text ?? 'done'}${note}. Don't run it again.`
  if (outcome?.label === 'done') return `[${id}] The person sent it themselves (${what})${note}. Don't send it again.`
  return `[${id}] The person rejected your outbound (${what})${note}. Don't send it another way; go on without it, or ask with mcp__fleet__decide.`
}
