#!/usr/bin/env bash
# The proposal template's proofs check (plugins/fleet/templates/proposal/fleet/checks/proof-check.py), run as fleet runs
# it on a project of made-up records: which files fail and with which line, what keeps its stored hash, and that its
# notes never read as a failure. Run by dev/fleet/ci.sh.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../../plugins/fleet/templates/proposal/fleet/checks/proof-check.py"
project="$(mktemp -d)"
trap 'rm -rf "$project"' EXIT
status=0
fail() {
  echo "test-proof-check: $*" >&2
  status=1
}
# Its source parses with every warning an error (a backslash escape in a docstring that isn't raw warns)
python3 -W error -c 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1])' "$script" || fail "it doesn't parse with warnings as errors"
sha() { python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'; }
record() { mkdir -p "$(dirname "$project/$1")" && cat >"$project/$1"; }

mkdir -p "$project/.claude/fleet"
cat >"$project/.claude/fleet/world.json" <<'EOF'
{
  "worldFormat": 1,
  "paths": ["findings/**", "poc/results/**", "notes/**"],
  "proofs": { "paths": ["findings/**", "poc/results/**"], "kinds": ["finding", "result"], "rerun": ["printf *", "sleep *"], "timeoutS": 1 }
}
EOF
good="$(printf 'rate 42\n' | sha)"
other="$(printf 'rate 41\n' | sha)"

# Results: one re-run that matches, one that doesn't, one with shell syntax and one nobody listed (both keep their
# stored hash), one past its time, one with no sha:, and two pairs of which the second is wrong
record poc/results/R-1.md <<EOF
---
kind: result
run: printf 'rate 42\n'
sha: ${good:0:16}
---
EOF
record poc/results/R-2.md <<EOF
---
kind: result
run: "printf 'rate 41\n'"
sha: sha256:${good:0:12}
---
EOF
record poc/results/R-3.md <<EOF
kind: result
run: printf 'rate 42\n'; printf x
sha: aaaaaaaaaaaa
EOF
record poc/results/R-4.md <<EOF
---
kind: result
run: make sim
sha: aaaaaaaaaaaa
---
EOF
record poc/results/R-5.md <<EOF
---
kind: result
run: sleep 5
sha: aaaaaaaaaaaa
---
EOF
record poc/results/R-6.md <<'EOF'
---
kind: result
run: printf 'rate 42\n'
---
EOF
record poc/results/R-7.md <<EOF
---
kind: result
run: printf 'rate 42\n'
sha: $good
run: printf 'rate 41\n'
sha: ${good:0:12}
---
EOF

# Findings: a quote in a local source (its line breaks aside), one that isn't, a URL, no proof at all, a source outside
# the project, one that isn't there, a quote too short, and a source given with a line number
record notes/sheet.md <<'EOF'
# Sheet

Measured on the testbench: the rate is 42 per
second at the nominal load.
EOF
record findings/F-1.md <<'EOF'
---
kind: finding
source: notes/sheet.md
quote: "the rate is 42 per second at the nominal load"
---
EOF
record findings/F-2.md <<'EOF'
---
kind: finding
source: notes/sheet.md
quote: "the rate is 43 per second"
---
EOF
record findings/F-3.md <<'EOF'
---
kind: finding
source: https://example.invalid/paper
quote: 'a sentence the verifier looks for'
---
EOF
record findings/F-4.md <<'EOF'
---
kind: finding
---
Nothing to check here: fleet marks it unproven itself.
EOF
record findings/F-5.md <<'EOF'
---
kind: finding
source: ../outside.md
quote: "anything at all, long enough"
---
EOF
record findings/F-6.md <<'EOF'
---
kind: finding
source: notes/missing.md
quote: "anything at all, long enough"
---
EOF
record findings/F-7.md <<'EOF'
---
kind: finding
source: notes/sheet.md
quote: "rate"
---
EOF
record findings/F-8.md <<'EOF'
---
kind: finding
source: notes/sheet.md:3
quote: "Measured on the testbench"
---
EOF

# A quote with \" and \\ in it, wrapped in double quotes: read as the source has it; a wrong one still fails; an
# unwrapped one is taken as it is
record notes/quoted.md <<'EOF'
The operator said "hold the rate" and saved it to C:\runs\a.
EOF
record findings/F-9.md <<'EOF'
---
kind: finding
source: notes/quoted.md
quote: "said \"hold the rate\" and saved it to C:\\runs\\a"
---
EOF
record findings/F-10.md <<'EOF'
---
kind: finding
source: notes/quoted.md
quote: "said \"drop the rate\" and saved it"
---
EOF
record findings/F-11.md <<'EOF'
---
kind: finding
source: notes/quoted.md
quote: saved it to C:\runs\a.
---
EOF
# A source that changed after the finding was written: its quote is no longer there
record notes/later.md <<'EOF'
The first draft says the margin is twelve percent.
EOF
record findings/F-12.md <<'EOF'
---
kind: finding
source: notes/later.md
quote: "the margin is twelve percent"
---
EOF
touch -t 202001010000 "$project/findings/F-12.md"
echo 'The second draft says the margin is nine percent.' >"$project/notes/later.md"

files=(findings/F-1.md findings/F-2.md findings/F-3.md findings/F-4.md findings/F-5.md findings/F-6.md findings/F-7.md
  findings/F-8.md findings/F-9.md findings/F-10.md findings/F-11.md findings/F-12.md poc/results/R-1.md
  poc/results/R-2.md poc/results/R-3.md poc/results/R-4.md poc/results/R-5.md poc/results/R-6.md poc/results/R-7.md)
# Run from the project's folder, as fleet runs a check: prints its exit code, its lines in out and its notes in err
run() {
  if (cd "$project" && python3 "$script" "$@" >"$project/out" 2>"$project/err"); then echo 0; else echo $?; fi
}

code="$(run --budget 20 "${files[@]}")"
[ "$code" = 1 ] || fail "exit $code, not 1"
want="findings/F-2.md: quote not found in notes/sheet.md
findings/F-5.md: source ../outside.md must be inside the project
findings/F-6.md: source notes/missing.md isn't there
findings/F-7.md: source: notes/sheet.md: its quote: is shorter than 10 characters
findings/F-10.md: quote not found in notes/quoted.md
findings/F-12.md: quote no longer in notes/later.md (it changed after this file)
poc/results/R-2.md: run: printf 'rate 41\n' gave sha256 ${other:0:12}…, not ${good:0:12}… (exit 0)
poc/results/R-6.md: run: printf 'rate 42\n' has no sha: after it
poc/results/R-7.md: run: printf 'rate 41\n' gave sha256 ${other:0:12}…, not ${good:0:12}… (exit 0)"
if [ "$(cat "$project/out")" != "$want" ]; then
  fail "its lines aren't the ones expected:"
  diff <(echo "$want") "$project/out" >&2 || true
fi
grep -q 'sleep 5 ran past 1 s' "$project/err" || fail "the run past its time isn't noted"
grep -q "has shell syntax" "$project/err" || fail "the command with shell syntax isn't noted"
for f in "${files[@]}"; do
  if grep -q "^$f" "$project/err"; then fail "a note starts with $f, so fleet would read it as a failure"; fi
done

# With no file named: every file under proofs.paths, and how many on standard error
code="$(run --budget 20)"
[ "$code" = 1 ] || fail "with no file named, exit $code, not 1"
if [ "$(sort "$project/out")" != "$(echo "$want" | sort)" ]; then
  fail "with no file named, its lines aren't the ones expected:"
  diff <(echo "$want" | sort) <(sort "$project/out") >&2 || true
fi
grep -q "checked ${#files[@]} file(s) under proofs.paths" "$project/err" || fail "with no file named, it doesn't say how many it checked: $(cat "$project/err")"

# Once the budget is used up nothing runs again: a wrong hash keeps its stored one
code="$(run --budget 0 poc/results/R-2.md poc/results/R-1.md)"
[ "$code" = 0 ] || fail "with no budget left, exit $code, not 0"
grep -q 'the budget is used up' "$project/err" || fail "the used-up budget isn't noted"

# Without world.json's rerun, nothing runs again either
echo '{ "worldFormat": 1, "paths": ["findings/**"] }' >"$project/.claude/fleet/world.json"
code="$(run poc/results/R-2.md findings/F-1.md findings/F-4.md)"
[ "$code" = 0 ] || fail "with no rerun listed, exit $code, not 0"
# ... and with no proofs.paths, a bare run checks nothing and says so
code="$(run)"
[ "$code" = 0 ] || fail "with no proofs.paths, a bare run exits $code, not 0"
grep -q 'no proofs.paths' "$project/err" || fail "with no proofs.paths, a bare run doesn't say why it checked nothing"

[ "$status" -eq 0 ] && echo "fleet: the proofs check fails what it should, and re-runs only what world.json lists"
exit "$status"
