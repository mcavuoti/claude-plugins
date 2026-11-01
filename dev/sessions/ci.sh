#!/usr/bin/env bash
# The sessions plugin's own checks. The GitHub check (.github/workflows/test.yml) runs dev/<plugin>/ci.sh for every
# plugin that has one, on macOS and Linux, after the shared checks (validation, tests, script syntax).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The one-time setup, in throwaway home folders, for bash, zsh and the account's shell; a second run changes nothing
bash "$here/test-setup.sh"

# What ccc opens (the launcher's decisions and its window loop), with a stand-in claude in a throwaway home folder
bash "$here/test-launcher.sh"
