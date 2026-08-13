#!/usr/bin/env bash
# Local pre-push gate. CI runs the uninstrumented suite; coverage lives here
# because c8 slows the process-spawning suites by roughly an order of magnitude,
# which pushes the slowest property test past vitest's 30s timeout on CI runners.
# Invoked by .husky/pre-push, which npm install wires up via the prepare script.
# Bypass:   SKIP_COVERAGE=1 git push
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ "${SKIP_COVERAGE:-0}" = "1" ]; then
  echo "pre-push: SKIP_COVERAGE=1, skipping the coverage gate"
  exit 0
fi
echo "pre-push: running the coverage gate (SKIP_COVERAGE=1 to bypass)"
npm run test:coverage
