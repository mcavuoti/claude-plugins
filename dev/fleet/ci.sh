#!/usr/bin/env bash
# The fleet plugin's own checks. The GitHub check (.github/workflows/test.yml) runs dev/<plugin>/ci.sh for every
# plugin that has one, on macOS and Linux, after the shared checks (validation, tests, script syntax).
# They check how fleet is built, not what it says: see .claude/rules/fleet-wire-format.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hooks="$here/../../plugins/fleet/hooks"
status=0

# Calls only: fleet never hooks a sessions.* event (if sessions failed to load, Claude would unload fleet whole)
if grep -nE "on\(['\"]sessions\." "$hooks"/*; then
  echo "fleet hooks a sessions.* event: call \$.sessions instead" >&2
  status=1
fi

# ... and never reads sessions' files
if grep -n "sessions-data" "$hooks"/*; then
  echo "fleet names sessions' data folder: ask \$.sessions instead" >&2
  status=1
fi

# A line fleet writes to the transcript doesn't start with its name: Claude puts the plugin's name before it already
if grep -n "ui\.log(\`fleet:" "$hooks"/* | grep -v "to: 'debug'"; then
  echo "fleet starts a transcript line with \"fleet:\": Claude adds the plugin's name itself" >&2
  status=1
fi

# Every command goes through run(), which gives it a folder that exists and a timeout
count=$(cat "$hooks"/* | grep -c '\$\.process\.run' || true)
if [ "$count" -ne 1 ]; then
  echo "\$.process.run appears $count times in plugins/fleet/hooks: call run() instead" >&2
  status=1
fi

# And one long-lived child: fleet's own file watch
count=$(cat "$hooks"/* | grep -c '\$\.process\.spawn' || true)
if [ "$count" -ne 1 ]; then
  echo "\$.process.spawn appears $count times in plugins/fleet/hooks: only fleet's own watch runs one" >&2
  status=1
fi

[ "$status" -eq 0 ] && echo "fleet: calls only, no sessions files, one way to run commands"

# The templates /fleet init copies: whole and consistent (roles with their files and fleet's tools, seeds, sections)
python3 "$here/check-templates.py" || status=1

# The proposal template's proofs check, on made-up records: what fails, what keeps its stored hash, what runs again
bash "$here/test-proof-check.sh" || status=1
exit "$status"
