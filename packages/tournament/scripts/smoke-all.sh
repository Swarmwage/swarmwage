#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Swarmwage
#
# Smoke-test the LLM provider for each tournament agent slot, in sequence.
# Reports a final OK / SKIP / FAIL summary. Loads .env automatically if
# present in the package root.
#
# Skips agents whose provider API key isn't in the environment (expected
# during partial-key collection — that's a SKIP, not a FAIL).
#
# Usage (from packages/tournament/):
#   pnpm smoke                                # all 10 agents
#   AGENT_IDS=agent_01,agent_02 pnpm smoke    # subset
#
# Exit code: 0 if no FAIL, 1 if any FAIL.

set +e

cd "$(dirname "$0")/.." || exit 1

# Auto-load .env if present. Lines must be KEY=VALUE (no `export`).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  echo "loaded .env"
else
  echo "no .env file in $(pwd) — relying on inherited environment"
fi

IDS=${AGENT_IDS:-agent_01,agent_02,agent_03,agent_04,agent_05,agent_06,agent_07,agent_08,agent_09,agent_10}
IFS=',' read -ra AGENTS <<< "$IDS"

OK_COUNT=0
SKIP_COUNT=0
FAIL_COUNT=0
declare -a RESULTS

for id in "${AGENTS[@]}"; do
  echo ""
  AGENT_ID=$id npx tsx agent-runner/src/smoke.ts
  status=$?
  case $status in
    0) OK_COUNT=$((OK_COUNT+1));   RESULTS+=("✓ $id  OK") ;;
    2) SKIP_COUNT=$((SKIP_COUNT+1));RESULTS+=("· $id  SKIP (no key)") ;;
    *) FAIL_COUNT=$((FAIL_COUNT+1));RESULTS+=("✗ $id  FAIL") ;;
  esac
done

echo ""
echo "============================="
echo " Smoke summary"
echo "============================="
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo ""
echo "  OK=$OK_COUNT  SKIP=$SKIP_COUNT  FAIL=$FAIL_COUNT  TOTAL=${#AGENTS[@]}"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
