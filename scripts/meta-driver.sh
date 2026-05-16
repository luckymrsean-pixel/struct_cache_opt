#!/usr/bin/env bash
# meta-driver.sh — Phase 2 autonomous meta-loop.
#
# Wraps the Phase-1 meta-bench.sh (reset → run N inner iters → score → decide
# → move champion) with the missing piece: automatically PROPOSING the next
# skill edit. Per meta-iter:
#   1. checkout champion (clean base)
#   2. propose_meta_edit.py → one diff to one *evolving* file
#   3. apply + meta: commit + tag skill-v<next>   (skip on bad proposal)
#   4. meta-bench.sh --skill-tag skill-v<next> --N <N>   (moves champion)
#   5. append meta-runs/driver.log + budget check
#
# Idempotent: the meta-iter index is derived (by meta-bench) from
# meta_results.tsv, so a killed driver resumes at the next index.
# See docs/superpowers/specs/2026-05-16-meta-loop-phase2-monitoring-design.md §4.

set -uo pipefail

META_ITERS=3
N=3
MAX_USD=""
DRY_RUN=0
CACHE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_REPO="/mnt/f/code2/target_skill"
SKILL_SUBDIR="struct_layout_opt"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --meta-iters) META_ITERS="$2"; shift 2 ;;
    --N)          N="$2"; shift 2 ;;
    --max-usd)    MAX_USD="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--meta-iters 3] [--N 3] [--max-usd 30] [--dry-run]"
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

DRIVER_LOG="$CACHE_ROOT/meta-runs/driver.log"
PID_FILE="$CACHE_ROOT/meta-driver.pid"
mkdir -p "$CACHE_ROOT/meta-runs"
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

dlog() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$DRIVER_LOG" >&2; }

# Single source of truth for the ideate backend = the yml the inner loop uses.
# Propagate it so propose_meta_edit.py uses the SAME backend (claude|copilot)
# as meta-bench's inner loop. Honor a pre-set env override if present.
YML="$CACHE_ROOT/vk-image-helper.yml"
if [ -z "${IDEATE_BACKEND:-}" ] && [ -f "$YML" ]; then
  IDEATE_BACKEND=$(grep -E '^\s*IDEATE_BACKEND:' "$YML" | head -1 \
    | sed -E 's/^[^:]*:\s*//; s/\s*#.*$//; s/[" ]//g')
fi
export IDEATE_BACKEND="${IDEATE_BACKEND:-claude}"
if [ -z "${IDEATE_MAX_USD:-}" ] && [ -f "$YML" ]; then
  IDEATE_MAX_USD=$(grep -E '^\s*IDEATE_MAX_USD:' "$YML" | head -1 \
    | sed -E 's/^[^:]*:\s*//; s/\s*#.*$//; s/['"'"'" ]//g')
fi
export IDEATE_MAX_USD="${IDEATE_MAX_USD:-1.50}"

skill_dir="$SKILL_REPO/$SKILL_SUBDIR"
spent=0
dlog "ideate backend = $IDEATE_BACKEND (max_usd=$IDEATE_MAX_USD)"

dlog "meta-driver start: meta_iters=$META_ITERS N=$N dry_run=$DRY_RUN"

for ((k = 1; k <= META_ITERS; k++)); do
  dlog "── meta-iter $k/$META_ITERS ──"

  # 1. Clean base = current champion.
  if ! git -C "$SKILL_REPO" checkout -q champion 2>/dev/null; then
    dlog "ERROR: cannot checkout champion in $SKILL_REPO — stopping"
    exit 1
  fi

  # Resolve champion's run dir (for propose inputs).
  CHAMP_TAG=$(git -C "$SKILL_REPO" tag --points-at champion | grep -v '^champion$' | head -1 || true)
  [ -z "$CHAMP_TAG" ] && CHAMP_TAG=$(git -C "$SKILL_REPO" rev-parse --short champion)
  CHAMP_DIR="$CACHE_ROOT/meta-runs/$CHAMP_TAG"

  if [ "$DRY_RUN" -eq 1 ]; then
    dlog "dry-run: would propose → commit → tag → meta-bench --skill-tag skill-v<next> --N $N (champion=$CHAMP_TAG)"
    continue
  fi

  # 2. Propose one evolving-file edit.
  PROP_OUT=$(python3 "$CACHE_ROOT/scripts/propose_meta_edit.py" \
      --out /tmp/meta-driver.diff \
      --skill-repo "$SKILL_REPO" --skill-subdir "$SKILL_SUBDIR" \
      --meta-tsv "$CACHE_ROOT/meta_results.tsv" \
      --champion-result "$CHAMP_DIR/result.json" \
      --champion-inner-tsv "$CHAMP_DIR/results.tsv" \
      ${MAX_USD:+--max-usd "$MAX_USD"} 2>>"$DRIVER_LOG")
  prc=$?
  if [ $prc -ne 0 ]; then
    dlog "skip meta-iter $k: propose failed (rc=$prc) — see driver.log"
    continue
  fi
  IFS=$'\t' read -r P_FILE P_SCOPE P_ONE P_HYP <<< "$PROP_OUT"
  dlog "proposal: FILE=$P_FILE SCOPE=$P_SCOPE :: $P_ONE"

  # 3. Apply + meta: commit + tag. propose_meta_edit emits skill-subdir-
  # relative paths (`a/inputs/rules.MD`). Cascade:
  #  (a) exact `git apply --recount --directory=$SKILL_SUBDIR` from repo root
  #      (errors loudly on mismatch — does NOT silently no-op like
  #      `git -C subdir apply` did, which made every meta-iter skip);
  #  (b) recount_diff.py fixes bogus @@ counts/start lines so GNU
  #      `patch -p1 --fuzz=3` (run inside $skill_dir) relocates by context.
  applied=0
  if git -C "$SKILL_REPO" apply --recount --directory="$SKILL_SUBDIR" \
        /tmp/meta-driver.diff 2>>"$DRIVER_LOG"; then
    applied=1
  else
    python3 "$CACHE_ROOT/scripts/recount_diff.py" < /tmp/meta-driver.diff \
      > /tmp/meta-driver.recount.diff 2>>"$DRIVER_LOG"
    if ( cd "$skill_dir" && patch -p1 --fuzz=3 --no-backup-if-mismatch -s \
           < /tmp/meta-driver.recount.diff ) 2>>"$DRIVER_LOG"; then
      applied=1
    fi
  fi
  if [ "$applied" -ne 1 ] || git -C "$SKILL_REPO" diff --quiet -- "$SKILL_SUBDIR/$P_FILE"; then
    dlog "skip meta-iter $k: proposed diff did not apply / changed nothing"
    git -C "$SKILL_REPO" checkout -q -- . 2>/dev/null || true
    continue
  fi
  git -C "$SKILL_REPO" add -- "$SKILL_SUBDIR/$P_FILE"
  CMSG="meta($P_SCOPE): $P_ONE

Hypothesis: $P_HYP
Eval-N: $N"
  # pre-commit hook validates struct_layout_opt/ stays evolving-only; a bad
  # proposal touching frozen paths is rejected here → skip, don't crash.
  if ! git -C "$SKILL_REPO" -c user.email=metadriver@local -c user.name=meta-driver \
        commit -q -m "$CMSG" 2>>"$DRIVER_LOG"; then
    dlog "skip meta-iter $k: commit rejected (manifest/pre-commit) — reverting"
    git -C "$SKILL_REPO" reset -q --hard champion
    continue
  fi
  TAG_OUT=$(bash "$SKILL_REPO/scripts/tag_meta_iter.sh" 2>>"$DRIVER_LOG")
  NEW_TAG=$(echo "$TAG_OUT" | grep -oE 'skill-v[0-9]+' | tail -1)
  [ -z "$NEW_TAG" ] && NEW_TAG=$(git -C "$SKILL_REPO" describe --tags --exact-match HEAD 2>/dev/null)
  dlog "tagged $NEW_TAG"

  # 4. Bench it (Phase 1, unchanged) — moves champion on advance.
  if bash "$CACHE_ROOT/scripts/meta-bench.sh" --skill-tag "$NEW_TAG" --N "$N" 2>>"$DRIVER_LOG"; then
    LASTROW=$(grep -v '^#' "$CACHE_ROOT/meta_results.tsv" | tail -1)
    DEC=$(echo "$LASTROW" | awk -F'\t' '{print $10}')
    M1=$(echo "$LASTROW" | awk -F'\t' '{print $5}')
    dlog "meta-iter $k done: $NEW_TAG decision=$DEC M1=$M1"
  else
    dlog "ERROR: meta-bench failed for $NEW_TAG — stopping (infra problem)"
    exit 1
  fi

  # 5. Budget guard (sum claude cost from the run's result.json if present).
  if [ -n "$MAX_USD" ]; then
    RJ="$CACHE_ROOT/meta-runs/$NEW_TAG/result.json"
    c=$(python3 -c "import json,sys;d=json.load(open('$RJ'));print(d.get('cost_usd',0))" 2>/dev/null || echo 0)
    spent=$(python3 -c "print($spent + $c)" 2>/dev/null || echo "$spent")
    dlog "cumulative cost ~\$$spent / \$$MAX_USD"
    if python3 -c "import sys; sys.exit(0 if $spent >= $MAX_USD else 1)" 2>/dev/null; then
      dlog "budget reached — stopping after meta-iter $k"
      break
    fi
  fi
done

dlog "meta-driver done."
