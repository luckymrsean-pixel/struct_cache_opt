# Meta-loop smoke pass + first real meta-iter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the Phase-1 meta-loop scaffolding from "compiled, never run" to "three rows in meta_results.tsv, the third being the first real verdict from an evolving-file edit."

**Architecture:** This is an operational pass over existing infrastructure, not a feature build. The only code change is one line in `scripts/meta-bench.sh` to honor an inbound `AR_HEADLESS` env so the dashboard remains reachable during human-driven runs. Everything else is running existing scripts, verifying their outputs against the spec's checklists, and authoring one small commit to `target_skill/struct_layout_opt/inputs/rules.MD`.

**Tech Stack:** Bash (meta-bench.sh), Python 3 (meta_score.py, meta_decide.py, check_manifest.py), Node + tsx (autoresearch), git (champion tag + meta:/contract: commit conventions), pahole (DWARF struct extraction, sibling skill).

**Spec:** [docs/superpowers/specs/2026-05-14-meta-loop-smoke-and-first-iter-design.md](../specs/2026-05-14-meta-loop-smoke-and-first-iter-design.md)

---

## File Map

Only one file is modified by source-code changes; the rest of the plan creates state (tags, generated result.json, appended TSV rows, deleted placeholder).

| Path | Action | Purpose |
|---|---|---|
| `scripts/meta-bench.sh` | Modify L110 | Make `AR_HEADLESS` honor inbound env |
| `meta-runs/skill-v0/result.json` | Delete, regenerate via runs | Replace placeholder with real M1..M5 |
| `meta_results.tsv` | Appended by `meta_decide.py` | Verdict log — three new rows by end of plan |
| `target_skill/struct_layout_opt/inputs/rules.MD` | Append one rule | The substance of the first meta-iter |
| `target_skill` (repo state) | Move `champion` tag, add `skill-v2` tag | Reset baseline, mark first real iter |

---

## Task 1: Patch meta-bench.sh to honor inbound AR_HEADLESS

**Files:**
- Modify: `scripts/meta-bench.sh:110`

- [ ] **Step 1: Inspect the current line**

Run: `grep -n 'AR_HEADLESS' scripts/meta-bench.sh`

Expected output:
```
110:  AR_TSV="$RESULTS_TSV" AR_ITERS="$N" AR_HEADLESS=1 \
```

- [ ] **Step 2: Apply the edit**

Use the Edit tool to change exactly:

old_string:
```
  AR_TSV="$RESULTS_TSV" AR_ITERS="$N" AR_HEADLESS=1 \
```

new_string:
```
  AR_TSV="$RESULTS_TSV" AR_ITERS="$N" AR_HEADLESS="${AR_HEADLESS:-1}" \
```

- [ ] **Step 3: Verify the change applied and didn't break shell syntax**

Run: `bash -n scripts/meta-bench.sh && grep -n 'AR_HEADLESS' scripts/meta-bench.sh`

Expected output:
```
110:  AR_TSV="$RESULTS_TSV" AR_ITERS="$N" AR_HEADLESS="${AR_HEADLESS:-1}" \
```

(`bash -n` validates syntax without executing; absent error means good.)

- [ ] **Step 4: Smoke-check the dry-run path still works**

Run: `./scripts/meta-bench.sh --dry-run --N 2 --skill-tag skill-v0 2>&1 | tail -20`

Expected: prints the planned commands (lines starting with `+`), exits 0, no syntax errors. Don't worry about whether all steps succeed — `--dry-run` skips most work.

- [ ] **Step 5: Commit**

```bash
git add scripts/meta-bench.sh
git commit -m "$(cat <<'EOF'
fix(meta-bench): honor inbound AR_HEADLESS env

Lets human-driven runs set AR_HEADLESS=0 to keep the dashboard on
port 8080 reachable while still defaulting to headless for
autonomous mode.
EOF
)"
```

---

## Task 2: Pre-flight reset (champion tag + placeholder deletion)

**Files:**
- Modify: target_skill repo tags (champion → skill-v0)
- Delete: `meta-runs/skill-v0/result.json`

- [ ] **Step 1: Confirm current state**

Run: `git -C /mnt/f/code2/target_skill log -1 champion --format='%h %s' && git -C /mnt/f/code2/target_skill tag --points-at champion`

Expected output: shows `champion` points at the same commit as `skill-v1` (not skill-v0). If `champion` already points at `skill-v0`, Step 2 is a no-op.

- [ ] **Step 2: Move champion to skill-v0**

Run: `git -C /mnt/f/code2/target_skill tag -f champion skill-v0 && git -C /mnt/f/code2/target_skill tag --points-at champion`

Expected output:
```
Updated tag 'champion' (was <old sha>)
champion
skill-v0
```

- [ ] **Step 3: Confirm the placeholder result.json exists and looks fake**

Run: `cat /mnt/f/code2/struct_cache_opt/meta-runs/skill-v0/result.json`

Expected: round numbers like `"baseline_metric": 100000000, "final_metric": 80000000, "M1_total_drop": 20000000`. If the file is absent or already contains real-looking numbers, skip Step 4.

- [ ] **Step 4: Delete the placeholder**

Run: `rm /mnt/f/code2/struct_cache_opt/meta-runs/skill-v0/result.json && ls /mnt/f/code2/struct_cache_opt/meta-runs/skill-v0/`

Expected: directory empty or contains only stale files but no `result.json`.

- [ ] **Step 5: Confirm meta_results.tsv is still header-only**

Run: `cat /mnt/f/code2/struct_cache_opt/meta_results.tsv`

Expected: two lines — the `# direction=multi...` comment and the column header row. No data rows yet. If data rows exist from prior runs, leave them in place; the smoke pass will simply add `meta_iter=N` where N follows the existing count.

- [ ] **Step 6: No commit needed**

The champion tag move is a target_skill ref-only change; deleting `result.json` in struct_cache_opt is local state. Neither needs a commit. If you want a marker, add `meta-runs/skill-v0/result.json` is already gitignored — confirm with `git -C /mnt/f/code2/struct_cache_opt status`.

Expected: working tree clean (or shows only files outside meta-runs/).

---

## Task 3: Smoke pass — N=2 on skill-v0

**Files:**
- Creates: `meta-runs/skill-v0/result.json` (real, N=2)
- Creates: `meta-runs/skill-v0/results.tsv`
- Creates: `meta-runs/skill-v0/autoresearch.log`
- Appends: one row to `meta_results.tsv`

- [ ] **Step 1: Confirm pre-conditions**

Run:
```bash
test ! -f /mnt/f/code2/struct_cache_opt/meta-runs/skill-v0/result.json && echo "result.json absent: OK"
git -C /mnt/f/code2/target_skill tag --points-at champion | grep -q skill-v0 && echo "champion at skill-v0: OK"
grep -q 'AR_HEADLESS:-1' /mnt/f/code2/struct_cache_opt/scripts/meta-bench.sh && echo "meta-bench patched: OK"
```

Expected: all three OK lines print. Any missing OK → go back and fix the corresponding earlier task.

- [ ] **Step 2: Pick a monitoring mode (dashboard or terminal tail)**

`AR_HEADLESS` has two failure-prone modes:

| Mode | Behavior | Use when |
|---|---|---|
| `AR_HEADLESS=0` | Dashboard at `http://localhost:8080` reachable, but the loop **pauses at Stage 0 awaiting a human "Start" click in the dashboard** ([src/loop.ts:181](../../autoresearch/src/loop.ts#L181)). Will hang forever unattended. | An operator is at the keyboard and will click Start |
| `AR_HEADLESS=1` (default) | No dashboard; loop auto-runs N iters end-to-end. Progress visible only via `tail -f meta-runs/<tag>/autoresearch.log` or `meta-runs/smoke-controller.log`. | Unattended / scripted execution |

For an unattended smoke pass, **omit `AR_HEADLESS`** so it defaults to `1`. Open a side terminal with `tail -f /mnt/f/code2/struct_cache_opt/meta-runs/skill-v0/autoresearch.log` if you want live visibility.

- [ ] **Step 3: Launch the smoke run**

From `/mnt/f/code2/struct_cache_opt`:
```bash
./scripts/meta-bench.sh --N 2 --skill-tag skill-v0 2>&1 | tee meta-runs/smoke-controller.log
```

Expected wall time: 10–20 minutes. The terminal shows the script's `+ <command>` traces; autoresearch's per-stage logs are in `meta-runs/skill-v0/autoresearch.log`.

- [ ] **Step 4: Verify the 4-item smoke checklist**

After the script exits 0, run:

```bash
# Check 1: real result.json shape
python3 -c "import json; d=json.load(open('meta-runs/skill-v0/result.json')); print('M1..M5:', d['M1_total_drop'], d['M2_apply_rate'], d['M3_keep_rate'], d['M4_struct_coverage'], d['M5_keep_delta_cv']); print('eval_N:', d['eval_N']); assert d['eval_N'] == 2"

# Check 2: inner TSV populated
wc -l meta-runs/skill-v0/results.tsv

# Check 3: verdict row appended
tail -1 meta_results.tsv

# Check 4: pipeline executed
grep -c 'Stage' meta-runs/skill-v0/autoresearch.log
```

Expected:
- Check 1: prints non-round numbers, eval_N=2, no AssertionError
- Check 2: ≥2 lines (1 header + ≥1 data row; some iters may apply-fail)
- Check 3: row begins with `0\tskill-v0\tskill-v0\t2\t...\tmanual\twithin noise band\t...` — `manual`, not `advance`. The decide rule classifies a self-comparison as "within noise band" since the candidate's M1 equals the champion's M1 by construction. That's correct behavior for a bootstrap row.
- Check 4: ≥7 (at least one full pipeline pass; usually 14+ for 2 iters)

- [ ] **Step 5: Stop conditions — debug before proceeding if any apply**

If any of the following are true, **stop and root-cause** before Task 4:

| Symptom | Likely cause | Look at |
|---|---|---|
| `AssertionError` in Check 1 (`eval_N` mismatch) | N wasn't propagated, or partial run | `meta-runs/skill-v0/autoresearch.log` last 50 lines |
| Check 2 = 1 (header only) | All inner iters failed before producing any row | per-stage logs in target_skill / ANGLE worktree |
| Check 3 missing or `decision=manual` against self | bug in `meta_decide.py` | re-run `python3 scripts/meta_decide.py --help` to confirm CLI, then run it standalone against the generated result.json |
| Check 4 = 0 | autoresearch never started (yml error, port conflict, npx missing) | `tail meta-runs/skill-v0/autoresearch.log` |

- [ ] **Step 6: No commit needed**

`meta-runs/` and `meta_results.tsv` are working artifacts. They're committed implicitly by being written; verify they're tracked or gitignored as your repo dictates:

Run: `git -C /mnt/f/code2/struct_cache_opt status meta-runs/ meta_results.tsv`

Expected: per existing `.gitignore` policy. If `meta_results.tsv` shows as modified-but-tracked, leave it for now — it'll be committed at the end of the plan.

---

## Task 4: Real baseline — N=10 on skill-v0

**Files:**
- Overwrites: `meta-runs/skill-v0/result.json` (now N=10)
- Overwrites: `meta-runs/skill-v0/results.tsv`
- Overwrites: `meta-runs/skill-v0/autoresearch.log`
- Appends: one row to `meta_results.tsv` (meta_iter=1)

- [ ] **Step 1: Delete the smoke result.json so the baseline overwrites cleanly**

Run: `rm meta-runs/skill-v0/result.json`

(The script writes a fresh one; deleting first prevents any chance of stale fields surviving.)

- [ ] **Step 2: Launch the real baseline run**

```bash
./scripts/meta-bench.sh --N 3 --skill-tag skill-v0 2>&1 | tee meta-runs/skill-v0-N3.controller.log
```

Expected wall time: ~24 minutes (3 iters × ~8 min/iter). Headless (default). `tail -f meta-runs/skill-v0/autoresearch.log` in a side terminal for live visibility. (Operator preference 2026-05-14: N=3 instead of N=10 to reduce wall time while still producing usable signal; ramp back up once skill quality is verified.)

- [ ] **Step 3: Verify baseline shape**

After script exits 0:

```bash
python3 -c "
import json
d=json.load(open('meta-runs/skill-v0/result.json'))
print(f'M1_total_drop={d[\"M1_total_drop\"]}')
print(f'M2_apply_rate={d[\"M2_apply_rate\"]:.3f}')
print(f'M3_keep_rate={d[\"M3_keep_rate\"]:.3f}')
print(f'M4_struct_coverage={d[\"M4_struct_coverage\"]}')
print(f'M5_keep_delta_cv={d[\"M5_keep_delta_cv\"]:.3f}')
print(f'eval_N={d[\"eval_N\"]}')
assert d['eval_N'] == 3
"
tail -1 meta_results.tsv
```

Expected:
- `eval_N=3`, no AssertionError
- last meta_results.tsv row: `1\tskill-v0\tskill-v0\t3\t...\tmanual\twithin noise band\t...` or `revert` if `M2_apply_rate` falls below the 50% gate (a real possibility at small N — observed in execution).

- [ ] **Step 4: Decision gate — sanity-check the baseline**

The first real meta-iter (Task 6) is only meaningful if the baseline is reasonable. Apply these gates:

| Metric | Acceptable range | If outside |
|---|---|---|
| `M2_apply_rate` | ≥ 0.30 | Skill barely generates applyable diffs — fix before iterating |
| `M3_keep_rate` | > 0 | No inner-iter improved cache-misses — investigate ANGLE baseline / perf |
| `M5_keep_delta_cv` | ≤ 0.25 | Baseline too noisy — rerun Step 2 once before proceeding |

If all three gates pass: proceed to Task 5. If any fails: pause and root-cause; don't fall into the trap of running a meta-iter on top of a broken inner loop.

- [ ] **Step 5: No commit needed** — same reasoning as Task 3 Step 6.

---

## Task 5: Author the first meta-iter (edit rules.MD, commit, tag)

**Files:**
- Modify: `/mnt/f/code2/target_skill/struct_layout_opt/inputs/rules.MD`
- Tag: target_skill `skill-v2`

- [ ] **Step 1: Verify the pre-commit hook is installed**

Run:
```bash
test -x /mnt/f/code2/target_skill/.git/hooks/pre-commit && echo "hook installed: OK" || echo "MISSING — install per target_skill/struct_layout_opt/SKILL.md"
```

If MISSING, install before continuing:
```bash
cp /mnt/f/code2/target_skill/scripts/pre-commit.template /mnt/f/code2/target_skill/.git/hooks/pre-commit
chmod +x /mnt/f/code2/target_skill/.git/hooks/pre-commit
```

- [ ] **Step 2: Apply the rules.MD edit**

Use the Edit tool against `/mnt/f/code2/target_skill/struct_layout_opt/inputs/rules.MD`:

old_string:
```
7. Cache-line partitioning (align(64) on the struct + pad before cold) only
   if hot/cold contention is measured; otherwise it wastes memory.
```

new_string:
```
7. Cache-line partitioning (align(64) on the struct + pad before cold) only
   if hot/cold contention is measured; otherwise it wastes memory.
8. **Tie-break on alignment for uncategorized fields.** When a field is
   neither hot (rule 1) nor cold (rule 3) nor in a correlation group
   (rule 5), order it by alignment descending. Reduces apply-fail rate
   when the model lacks strong placement signal.
```

- [ ] **Step 3: Inspect the diff before committing**

Run: `git -C /mnt/f/code2/target_skill diff struct_layout_opt/inputs/rules.MD`

Expected: shows exactly the new rule 8 added after rule 7. No other lines should differ.

- [ ] **Step 4: Stage and commit with the `meta:` prefix**

```bash
cd /mnt/f/code2/target_skill
git add struct_layout_opt/inputs/rules.MD
git commit -m "$(cat <<'EOF'
meta(rules): tie-break on alignment for uncategorized fields

Hypothesis: gives the LLM a deterministic order when correlation and
hot/cold signals are weak, reducing apply-fail and improving M2.
Eval-N: 10
EOF
)"
```

Expected behavior: the pre-commit hook runs `check_manifest.py HEAD~1..HEAD`, sees that only `inputs/rules.MD` (an evolving file) changed, and accepts. If the hook rejects with "frozen file modified," you accidentally touched something else — `git diff HEAD~1..HEAD --name-only` to see what.

- [ ] **Step 5: Tag the new version**

Run: `bash /mnt/f/code2/target_skill/scripts/tag_meta_iter.sh`

Expected output:
```
Tagged HEAD as skill-v2
```

(If the script prints `HEAD already tagged: skill-v2` it's idempotent and fine.)

- [ ] **Step 6: Confirm the tag exists and points at the new commit**

Run: `git -C /mnt/f/code2/target_skill log -1 skill-v2 --format='%h %s'`

Expected: shows the `meta(rules):` commit subject from Step 4.

---

## Task 6: Evaluate skill-v2 — first real meta-iter

**Files:**
- Creates: `meta-runs/skill-v2/result.json`
- Creates: `meta-runs/skill-v2/results.tsv`
- Creates: `meta-runs/skill-v2/autoresearch.log`
- Appends: one row to `meta_results.tsv` (meta_iter=2)
- May update: `champion` tag in target_skill (if decision=advance)

- [ ] **Step 1: Launch the evaluation**

```bash
cd /mnt/f/code2/struct_cache_opt
./scripts/meta-bench.sh --N 3 --skill-tag skill-v2 2>&1 | tee meta-runs/skill-v2-N3.controller.log
```

Expected wall time: ~24 minutes. Headless (default). `tail -f meta-runs/skill-v2/autoresearch.log` for visibility.

- [ ] **Step 2: Verify the run produced the expected artifacts**

After script exits 0:

```bash
ls meta-runs/skill-v2/
python3 -c "
import json
d=json.load(open('meta-runs/skill-v2/result.json'))
b=json.load(open('meta-runs/skill-v0/result.json'))
for k in ['M1_total_drop','M2_apply_rate','M3_keep_rate','M4_struct_coverage','M5_keep_delta_cv']:
    print(f'{k:25s}  baseline={b[k]:>14}   candidate={d[k]:>14}   delta={d[k]-b[k] if isinstance(d[k],(int,float)) else \"n/a\"}')
"
tail -1 meta_results.tsv
```

Expected:
- `meta-runs/skill-v2/` contains `result.json`, `results.tsv`, `autoresearch.log`
- Side-by-side print of all 5 metrics, baseline vs candidate
- meta_results.tsv last row: `2\tskill-v2\tskill-v0\t10\t...\t<decision>\t...`

- [ ] **Step 3: Interpret the decision**

Read the `decision` and `reason` columns from the last row.

| Decision | What it means | What to do |
|---|---|---|
| `advance` | Rule 8 demonstrably improves the inner loop | Confirm `git -C /mnt/f/code2/target_skill tag --points-at champion` now includes `skill-v2`. Done. |
| `revert` | Rule 8 hurt the inner loop | Confirm `git -C /mnt/f/code2/target_skill log -1 HEAD --format=%h` is back at the old champion's commit. Read the per-iter `meta-runs/skill-v2/results.tsv` to understand which inner iters failed and why. Write a follow-up commit (with `meta:` prefix, scope `notes`) capturing the lesson before authoring the next meta-iter. |
| `manual` | Decision rule couldn't reach a confident verdict | Inspect the metric deltas from Step 2. Make the call manually: either `git -C /mnt/f/code2/target_skill tag -f champion skill-v2` (accept) or `git -C /mnt/f/code2/target_skill checkout champion` (reject). Document the rationale in a follow-up commit. |

- [ ] **Step 4: No source-code commit; record the run via meta_results.tsv (already done by script)**

The verdict is captured by `meta_decide.py`'s row append. No further commit needed in target_skill unless Step 3 requires a follow-up note.

---

## Task 7: Final verification against done criteria

**Files:**
- Read-only check across the workspace.

- [ ] **Step 1: Confirm all three meta_results.tsv rows exist**

Run: `grep -v '^#' /mnt/f/code2/struct_cache_opt/meta_results.tsv | tail -n +2`

Expected: exactly 3 lines, in order:
```
0	skill-v0	skill-v0	2	... manual	within noise band ...
1	skill-v0	skill-v0	3	... manual	within noise band ...
2	skill-v2	skill-v0	3	... <advance|revert|manual> ...
```

- [ ] **Step 2: Confirm result.json files exist for both versions**

Run: `ls meta-runs/skill-v0/result.json meta-runs/skill-v2/result.json`

Expected: both paths print, no "No such file" errors.

- [ ] **Step 3: Confirm placeholder is gone**

Run: `python3 -c "import json; d=json.load(open('meta-runs/skill-v0/result.json')); assert d['M1_total_drop'] != 20000000, 'placeholder still present'; print('baseline is real:', d['M1_total_drop'])"`

Expected: prints the real number, no AssertionError. (20000000 was the placeholder value; real measurements will not coincidentally hit it.)

- [ ] **Step 4: Confirm meta-bench patch holds**

Run: `grep -q 'AR_HEADLESS:-1' /mnt/f/code2/struct_cache_opt/scripts/meta-bench.sh && echo "patch intact"`

Expected: `patch intact`.

- [ ] **Step 5: Commit meta_results.tsv if it's tracked**

```bash
cd /mnt/f/code2/struct_cache_opt
git status meta_results.tsv
```

If `meta_results.tsv` shows as modified:
```bash
git add meta_results.tsv
git commit -m "$(cat <<'EOF'
chore(meta): record first three meta-iter rows

- iter 0: smoke pass (N=2, skill-v0 self) — plumbing verified
- iter 1: real baseline (N=10, skill-v0) — placeholder result.json
  replaced with real measurements
- iter 2: first real candidate (N=10, skill-v2, rules.MD rule 8) —
  see meta_results.tsv decision column for verdict
EOF
)"
```

If `meta_results.tsv` is gitignored, skip the commit.

- [ ] **Step 6: Brief summary to user**

Print a one-paragraph summary covering:
- Baseline M1..M5 numbers
- Candidate M1..M5 numbers and deltas
- Final decision and what it implies for the next meta-iter

Plan complete.

---

## Notes for the implementer

- **The benchmarks are slow.** Tasks 3, 4, and 6 each include a multi-tens-of-minutes wait. Don't poll the dashboard nervously — the script ends cleanly when done.
- **Don't skip the decision gate (Task 4 Step 4).** Running a meta-iter on a broken baseline produces noise, not signal — you'll spend hours and learn nothing.
- **The pre-commit hook only checks `meta:`-prefixed commits.** `contract:`-prefixed commits bypass it intentionally. Don't fight the hook; if it rejects, it caught you touching a frozen file.

## Setup prerequisites discovered during first run (2026-05-14)

These weren't in the original plan; folded in during execution.

1. **ANGLE `meta-baseline` tag must exist** before any meta-bench run. The script does `git -C $WORKDIR reset --hard meta-baseline`. If the tag is absent, create it at the desired baseline commit: `git -C /home/fxy/angle tag meta-baseline <sha>`.
2. **meta-bench.sh bootstrap fix** (commit `b5d9096`): when candidate tag equals champion tag and no prior `champion result.json` exists, the script now logs a bootstrap notice and proceeds instead of exiting 2. Required for the very first run on a fresh meta-loop.
3. **Stale autoresearch processes can hold port 8080**, which doesn't block headless runs but does block `AR_HEADLESS=0`. Check `ss -lntp | grep :8080` before any run that needs the dashboard; `pkill -f 'tsx src/index.ts.*vk-image-helper'` is the cleanup hammer if previous loop sessions left orphans.
