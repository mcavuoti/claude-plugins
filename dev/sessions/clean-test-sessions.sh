#!/bin/bash
# Stop and remove the background sessions started in a test folder (and its subfolders), and only those.
# Never clean up by session name: a name can match a real session in another folder.
#
# Usage: clean-test-sessions.sh <test-folder>
set -u
base="${1:?usage: clean-test-sessions.sh <test-folder>}"
base="$(cd "$base" && pwd)" || exit 1
claude agents --json --all 2>/dev/null | BASE="$base" python3 -c "
import json, os, sys
base = os.environ['BASE']
for s in json.load(sys.stdin):
    cwd = s.get('cwd', '')
    if (cwd == base or cwd.startswith(base + '/')) and s.get('id'):
        print(s['id'])
" | while read -r id; do
  claude stop "$id" >/dev/null 2>&1
  claude rm "$id" >/dev/null 2>&1
  echo "removed $id"
done
