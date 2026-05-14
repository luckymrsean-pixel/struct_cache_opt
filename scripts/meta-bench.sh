#!/usr/bin/env bash
# meta-bench.sh — evaluate one skill version against the current champion.
# See docs/superpowers/specs/2026-05-13-meta-loop-design.md §5.

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────
N=10
SKILL_TAG="HEAD"
BASELINE_TAG="meta-baseline"
WORKDIR="${AR_WORKDIR:-/home/fxy/angle}"
SKILL_REPO="/mnt/f/code2/target_skill"
CACHE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=0

# ── Args ──────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --N)             N="$2"; shift 2 ;;
    --skill-tag)     SKILL_TAG="$2"; shift 2 ;;
    --baseline-tag)  BASELINE_TAG="$2"; shift 2 ;;
    --workdir)       WORKDIR="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--N 10] [--skill-tag HEAD] [--baseline-tag meta-baseline] [--workdir DIR] [--dry-run]"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

run() {
  echo "+ $*" >&2
  if [ "$DRY_RUN" -eq 1 ]; then return 0; fi
  "$@"
}

# ── Resolve SKILL_TAG to concrete identifier ──────────────────────────────
RESOLVED_TAG=$(git -C "$SKILL_REPO" tag --points-at "$SKILL_TAG" | grep -v '^champion$' | head -1 || true)
if [ -z "$RESOLVED_TAG" ]; then
  RESOLVED_TAG=$(git -C "$SKILL_REPO" rev-parse --short "$SKILL_TAG")
fi
RUN_DIR="$CACHE_ROOT/meta-runs/$RESOLVED_TAG"

# Verify champion tag exists at all
if ! git -C "$SKILL_REPO" rev-parse --verify champion >/dev/null 2>&1; then
  echo "ERROR: champion tag not set in $SKILL_REPO. Seed it: git tag champion HEAD" >&2
  exit 2
fi
# Find a version tag co-located with champion (any tag other than "champion" itself)
CHAMPION_TAG=$(git -C "$SKILL_REPO" tag --points-at champion | grep -v '^champion$' | head -1 || true)
if [ -z "$CHAMPION_TAG" ]; then
  # Fall back to short SHA if no version tag co-exists with champion
  CHAMPION_TAG=$(git -C "$SKILL_REPO" rev-parse --short champion)
fi
CHAMPION_RUN_DIR="$CACHE_ROOT/meta-runs/$CHAMPION_TAG"

if [ ! -f "$CHAMPION_RUN_DIR/result.json" ]; then
  echo "ERROR: champion result missing: $CHAMPION_RUN_DIR/result.json" >&2
  echo "Seed it by running this script with --skill-tag $CHAMPION_TAG first." >&2
  exit 2
fi

# Compute next meta_iter index (count of non-comment lines in meta_results.tsv - 1 header)
META_TSV="$CACHE_ROOT/meta_results.tsv"
if [ -f "$META_TSV" ]; then
  NEXT_ITER=$(grep -vc '^#' "$META_TSV" || true)
  # subtract 1 for the column-header row
  NEXT_ITER=$((NEXT_ITER - 1))
  [ "$NEXT_ITER" -lt 0 ] && NEXT_ITER=0
else
  NEXT_ITER=0
fi

echo "[meta-bench] meta_iter=$NEXT_ITER  skill_tag=$RESOLVED_TAG  parent=$CHAMPION_TAG  N=$N" >&2

# ── Step 0: stop live loop ────────────────────────────────────────────────
if [ -f "$CACHE_ROOT/loop.pid" ]; then
  pid=$(cat "$CACHE_ROOT/loop.pid")
  if kill -0 "$pid" 2>/dev/null; then
    run kill -INT "$pid"
    # wait for clean shutdown (up to 30s)
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
  fi
fi

# ── Step 1: reset ANGLE to baseline ───────────────────────────────────────
run git -C "$WORKDIR" reset --hard "$BASELINE_TAG"

# ── Step 2: checkout candidate skill version ──────────────────────────────
run git -C "$SKILL_REPO" checkout "$RESOLVED_TAG"

# ── Step 3: wipe skill state ──────────────────────────────────────────────
# AR_TARGET_LIB defaults to vk_helpers per the existing yml; honor an override.
LIB="${AR_TARGET_LIB:-vk_helpers}"
run rm -rf "$SKILL_REPO/struct_layout_opt/state/$LIB"

# ── Step 4: prep run dir ─────────────────────────────────────────────────
run mkdir -p "$RUN_DIR"
RESULTS_TSV="$RUN_DIR/results.tsv"
run rm -f "$RESULTS_TSV"

# ── Step 5: run autoresearch headless for N iters ─────────────────────────
echo "[meta-bench] running $N inner iters → $RESULTS_TSV (this takes ~$((N*5)) minutes)" >&2
if [ "$DRY_RUN" -eq 0 ]; then
  cd "$CACHE_ROOT/autoresearch"
  AR_TSV="$RESULTS_TSV" AR_ITERS="$N" AR_HEADLESS="${AR_HEADLESS:-1}" \
    timeout $((N * 600)) npx tsx src/index.ts "$CACHE_ROOT/vk-image-helper.yml" 2>&1 | \
    tee "$RUN_DIR/autoresearch.log"
fi

# ── Step 6: score ─────────────────────────────────────────────────────────
RESULT_JSON="$RUN_DIR/result.json"
run python3 "$CACHE_ROOT/scripts/meta_score.py" --in "$RESULTS_TSV" --out "$RESULT_JSON"

# ── Step 7: decide ────────────────────────────────────────────────────────
run python3 "$CACHE_ROOT/scripts/meta_decide.py" \
  --candidate  "$RESULT_JSON" \
  --champion   "$CHAMPION_RUN_DIR/result.json" \
  --append     "$META_TSV" \
  --meta-iter  "$NEXT_ITER" \
  --skill-tag  "$RESOLVED_TAG" \
  --parent-tag "$CHAMPION_TAG" \
  --run-dir    "meta-runs/$RESOLVED_TAG"

# ── Step 8: apply decision ────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 0 ]; then
  decision=$(python3 -c "import json,sys; print(json.load(open('$RESULT_JSON'))['decision'])")
else
  decision=manual
fi

case "$decision" in
  advance)
    run git -C "$SKILL_REPO" tag -f champion "$RESOLVED_TAG"
    echo "[meta-bench] ADVANCE: champion → $RESOLVED_TAG" >&2
    ;;
  revert)
    run git -C "$SKILL_REPO" checkout champion
    echo "[meta-bench] REVERT: target_skill rolled back to $CHAMPION_TAG" >&2
    ;;
  manual)
    echo "[meta-bench] MANUAL: candidate left in working tree. Operator decides." >&2
    echo "  Advance: git -C $SKILL_REPO tag -f champion $RESOLVED_TAG" >&2
    echo "  Revert:  git -C $SKILL_REPO checkout champion" >&2
    ;;
esac

echo "[meta-bench] done. row appended to $META_TSV" >&2
