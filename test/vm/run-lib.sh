#!/usr/bin/env bash
# Runs a TypeScript file that imports src/lib/ against the test DC: every
# command the module would spawn runs there as root, over SSH.
#   test/vm/run-lib.sh SCRIPT.ts
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/env.sh"
exec node --experimental-strip-types --no-warnings --import "$here/cockpit-ssh-loader.mjs" "$@"
