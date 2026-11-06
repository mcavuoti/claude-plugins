import { expect, test } from 'claude-code/testing'
import { bashWritesNothing } from '../hooks/changes'

// B28: commands like the ones a busy fleet runs all day (read a file, cut a range, count, compare, check a remote
// machine), each of which was once blamed for a peer's write. A read-only one lands nothing, so it can't be blamed;
// these stay read-only. Paths, hosts and names are placeholders
const inWorld = (t: string) => !t.startsWith('/tmp/') && !t.startsWith('/home/x/') && !t.startsWith('/Users/x/other/')

const READS = [
  'date',
  "date '+%Y-%m-%d %H:%M %Z'",
  'grep -n "x" notes/a.md',
  "grep -rn --include='*.md' 'x' notes/ board/",
  "grep -n -o 'x[0-9]*' notes/a.md notes/b.md",
  "grep -cF 'x' notes/a.md",
  "grep -n 'x' notes/a.md | cut -d: -f1 | head -5",
  "grep -n 'x' notes/a.md | sed 's/^/  /'",
  "sed -n '1,40p' notes/a.md",
  "sed -n '120,160p' notes/b.md",
  "sed -n '/^## A/,/^## B/p' notes/a.md",
  "sed -n '1,80p' notes/a.md | fold -w 160 | tail -20",
  "awk '/^## A/,/^$/' board/B-1.md | head -30 | cut -c1-200",
  'cat /tmp/x/tasks/a1.output',
  'tail -50 /tmp/x/tasks/a1.output',
  'wc -l notes/*.md board/*.md',
  'ls -la board/ notes/',
  'git diff -- notes/a.md',
  'git diff HEAD~1 --stat',
  'git show HEAD:notes/a.md | head -40',
  'git log --oneline -5 -- notes/a.md',
  "cd /Users/x/other/wt && grep -rn 'x' src | sed -n '1,20p' | cut -c1-160; cd /Users/x/proj",
  "ssh -n x.example 'grep -c x /home/x/run/log.txt'",
  "ssh -n x.example 'sha256sum /home/x/run/out.bin; wc -c /home/x/run/out.bin; stat -c %Y /home/x/run/out.bin'",
  "ssh -n x.example 'bash /home/x/run/smoke.sh > /home/x/run/out.txt 2>&1; cat /home/x/run/out.txt'",
  "ssh -n x.example 'bash /home/x/run/readout.sh'",
  'ssh -o BatchMode=yes x.example "ls -la /home/x/run | tail -5"',
  'cp board/B-1.md /tmp/x/B-1.md',
  'cp notes/a.md /tmp/x/a.before.md && diff /tmp/x/a.before.md notes/a.md',
  'cp notes/a.md /tmp/x/a.md && wdiff /tmp/x/a.md notes/a.md',
  "grep -l 'x' notes/*.md | xargs wc -l",
  "grep -l 'x' notes/*.md | xargs grep -c 'y'",
  'diff <(sort notes/a.md) <(sort notes/b.md)',
  "sha256sum notes/a.md board/B-1.md | cut -c1-16",
  'head -c 2000 notes/a.md',
  'nl -ba notes/a.md | sed -n 10,30p',
  'jq .items notes/a.json | head',
  "python3 -I .claude/fleet/checks/proof-check.py notes/a.md",
  // A file name with a w in it is an operand, not a sed command
  "sed -n '1,40p' notes/area-w2-vs-w1.md",
  "sed -n '/x/,/y/p' notes/workload.md",
  "sed -e '1,5p' -n notes/w.md",
  "sed -n -e '/now/p' notes/a.md",
  'sed s/a/b/ notes/a.md',
  "sed -n 's/a/b/p' notes/a.md",
  "sed -n '/a/{n;p}' notes/a.md",
  "sed 'y/abc/xyz/' notes/a.md",
  "sed -n '$p' notes/a.md",
  "sed -E -n 's/(x+)/\\1/p' notes/a.md",
  // Loops whose bodies only read
  "for f in notes/*.md; do grep -c 'x' \"$f\"; done",
  "for f in notes/a.md notes/b.md; do echo \"== $f\"; head -5 \"$f\"; done",
  'while read -r f; do wc -l "$f"; done < /tmp/x/list.txt',
  "find notes -name '*.md' | while IFS= read -r f; do grep -H 'x' \"$f\"; done",
  // A file fed in with < is read, and a here-string is text
  'wc -l < notes/a.md',
  'while read -r f; do head -3 "$f"; done < notes/list.md',
  'grep -c x <<< "$v"',
]

const WRITES = [
  // Programs fleet can't see into: what they write, the scan sees
  "python3 -I -c 'print(1)'",
  'python3 /tmp/x/replay.py',
  "bash -c 'python3 /tmp/x/replay.py'",
  "perl -ne 'print if /x/' notes/a.md",
  // sed's own writes: in place, a w or W command, an s command's w or e flag, the e command, a script from a file
  "sed -i '' 's/a/b/' notes/a.md",
  "sed -n '/x/w notes/out.md' notes/a.md",
  "sed -n '1,5W notes/out.md' notes/a.md",
  "sed -n 's/a/b/w notes/out.md' notes/a.md",
  "sed 's/a/date/e' notes/a.md",
  "sed '1e date' notes/a.md",
  "sed -e '/x/w notes/out.md' notes/a.md",
  "sed --expression='/x/w notes/out.md' notes/a.md",
  'sed -f /tmp/x/script.sed notes/a.md',
  // Loops whose bodies write, or that write where they end
  "for f in notes/*.md; do sed -i '' 's/a/b/' \"$f\"; done",
  'for f in notes/*.md; do cat "$f"; done > notes/all.md',
  'while read -r f; do touch "$f"; done < /tmp/x/list.txt',
  // A file opened to read and write, or written after a read from it
  'exec 3<> notes/a.md',
  'sort < notes/a.md > notes/b.md',
]

test('B28: the command shapes a fleet runs all day to read stay read-only', () => {
  const wrong = READS.filter(c => !bashWritesNothing(c, inWorld))
  expect(wrong).toEqual([])
})

test('B28: commands that write, or that fleet can not see into, still count as writing', () => {
  const wrong = WRITES.filter(c => bashWritesNothing(c, inWorld))
  expect(wrong).toEqual([])
})
