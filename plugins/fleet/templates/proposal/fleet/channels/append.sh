#!/usr/bin/env bash
# A sample command channel for fleet's alerts. In roster.json:
#   "person": { "channel": { "kind": "command", "argv": ["bash", ".claude/fleet/channels/append.sh", "<a file of yours>"] } }
# then /fleet accept channel. fleet runs it from the project's folder, from the sweeper session, with the alert's text
# on its standard input. This one appends the text, with the time, to the file it's given (by default
# .claude/fleet/alerts.log). Write your own to mail it to yourself or post it to your own chat: the recipient is fixed
# in your script, and fleet sends ids, paths and names, never the project's content.
set -euo pipefail
out="${1:-.claude/fleet/alerts.log}"
{
  printf '%s ' "$(date '+%Y-%m-%d %H:%M')"
  cat
} >>"$out"
