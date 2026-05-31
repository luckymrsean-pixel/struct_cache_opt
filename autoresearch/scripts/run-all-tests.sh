#!/usr/bin/env bash
# 依次运行所有测试套件，汇总结果
set -euo pipefail

PASS=0
FAIL=0
SUITE_RESULTS=()

run_suite() {
  local name="$1"
  local cmd="$2"
  echo ""
  echo "━━━ $name ━━━"
  if eval "$cmd"; then
    SUITE_RESULTS+=("✓  $name")
    PASS=$((PASS + 1))
  else
    SUITE_RESULTS+=("✗  $name")
    FAIL=$((FAIL + 1))
  fi
}

run_suite "M2  logger"   "tsx scripts/test-log.ts"
run_suite "M1  terminal" "tsx scripts/test-term.ts"
run_suite "M3  interactive-pty" "tsx scripts/test-interactive-pty.ts"
run_suite "M4  errors"   "tsx scripts/test-errors.ts"
run_suite "M5  stage-log" "tsx scripts/test-stage-log.ts"
run_suite "M6  skill-state" "tsx scripts/test-skill-state.ts"
run_suite "M7  meta-state" "tsx scripts/test-meta-state.ts"
run_suite "M8  apply-cmd"  "tsx scripts/test-apply-cmd.ts"
run_suite "M9  dry-run"    "tsx scripts/test-dry-run.ts"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for r in "${SUITE_RESULTS[@]}"; do echo "  $r"; done
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Suites: $PASS passed, $FAIL failed"
echo ""

exit $FAIL
