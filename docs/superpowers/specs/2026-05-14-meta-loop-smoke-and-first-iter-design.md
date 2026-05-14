# Meta-loop smoke test + first real meta-iter — Design

**Date:** 2026-05-14
**Status:** draft (pending user review)
**Targets:**
- `/mnt/f/code2/target_skill/struct_layout_opt/` (skill being evolved)
- `/mnt/f/code2/struct_cache_opt/scripts/meta-bench.sh` (harness)
- `/mnt/f/code2/struct_cache_opt/meta_results.tsv` (verdict log)
**Related:** [2026-05-13-meta-loop-design.md](2026-05-13-meta-loop-design.md) (Phase 1 architecture this spec executes against)

## 1. Goal

The meta-loop Phase 1 infrastructure is in place (manifest, hooks, score/decide scripts, meta-bench.sh) but has never run end-to-end with real numbers. This spec drives it from "scaffolding compiled" to "first meaningful verdict in `meta_results.tsv`."

Concretely:
1. Verify the harness plumbing with a cheap smoke pass (N=2).
2. Replace the placeholder baseline with real numbers (N=10 on `skill-v0`).
3. Author and evaluate the first real meta-iter that touches an evolving file.
4. Establish the human-in-the-loop monitoring pattern (dashboard live + TSV after).

This is a one-shot operational pass, not new infrastructure. The only code change is one line in `meta-bench.sh`.

## 2. Pre-flight findings

Three issues discovered during brainstorming that must be addressed before any benchmark run:

### 2.1 `champion` tag points at a non-meaningful version

`git diff skill-v0 skill-v1 --stat` shows the only changed file is `scripts/tag_meta_iter.sh` — which lives outside `struct_layout_opt/` and is not in the MANIFEST. Therefore `skill-v1` is not a meta-iter in any meaningful sense; benchmarking it would just measure inner-loop noise.

**Resolution:** move `champion` back to `skill-v0` and treat `skill-v0` as the baseline. The first real candidate is a new tag (`skill-v2`) created after a genuine edit to an evolving file.

### 2.2 `meta-runs/skill-v0/result.json` contains placeholder data

The current file has round numbers (M1=20000000, M2=0.8, M3=0.4, M4=2, M5=0.15) that are clearly synthetic. Any comparison against this baseline is meaningless.

**Resolution:** delete it. The smoke pass (§4) and real baseline (§5) will overwrite it with real measurements.

### 2.3 `meta-bench.sh` forces `AR_HEADLESS=1`

The script unconditionally exports `AR_HEADLESS=1` at the line that launches autoresearch. In headless mode autoresearch does not bind port 8080, so the dashboard is unreachable during a meta-bench run. This conflicts with the chosen monitoring pattern (live dashboard during runs).

**Resolution:** change the export so it honors the inbound env var:
```
AR_TSV="$RESULTS_TSV" AR_ITERS="$N" AR_HEADLESS="${AR_HEADLESS:-1}" \
```
This preserves the original default (autonomous Phase 2 stays headless) while letting human-driven runs set `AR_HEADLESS=0` to expose the dashboard.

## 3. The frozen/evolving split

Already declared in [target_skill/struct_layout_opt/MANIFEST.yml](../../../../target_skill/struct_layout_opt/MANIFEST.yml) and enforced by `lib/check_manifest.py` + the pre-commit hook installed from `scripts/pre-commit.template`. No file moves; the declarative split is sufficient.

Frozen: `SKILL.md`, `run.sh`, `lib/parse_output.py`, `MANIFEST.yml`.
Evolving: `inputs/rules.MD`, `inputs/cold_path.MD`, `inputs/correlation.MD`, `prompt.tmpl`, `lib/fuse_context.py`.

Sibling `pahole_extractor/` is upstream infrastructure and outside the manifest.

## 4. Smoke pass (N=2)

**Goal:** prove the harness runs end-to-end before paying for ~100 minutes of build/perf time.

**Pre-conditions:**
- `champion` tag at `skill-v0` (from §2.1).
- `meta-runs/skill-v0/result.json` deleted (from §2.2).
- `meta-bench.sh` patched per §2.3 and committed.
- Inner-loop `loop.pid` not running (the script kills it, but cleaner to stop first).

**Run:**

```bash
cd /mnt/f/code2/struct_cache_opt
AR_HEADLESS=0 ./scripts/meta-bench.sh --N 2 --skill-tag skill-v0
```

Open `http://localhost:8080` (or `http://<WSL IP>:8080`) before the run boots autoresearch, so the dashboard hooks the WebSocket as soon as it's up. Expected wall time: ~10–20 min.

**Verification (all four must pass):**

| Check | Where | Pass criterion |
|---|---|---|
| Real result.json shape | `meta-runs/skill-v0/result.json` | Contains `M1..M5` keys with non-round values; `eval_N=2` |
| Inner TSV populated | `meta-runs/skill-v0/results.tsv` | At least one data row (2 attempted; some may apply-fail) |
| Verdict row appended | `meta_results.tsv` | One new row, `meta_iter=0`, `skill_tag=skill-v0`, `decision=advance` (trivial self-comparison) |
| Pipeline ran | `meta-runs/skill-v0/autoresearch.log` | Shows Stage 0 through Stage 6 for at least one iter |

**Stop conditions** — if any of these fire, debug before §5:
- Inner loop crashes during Stage 3 (build) or Stage 4 (verify) — inspect `stage-N.log`, `build.log`.
- `meta_score.py` exits non-zero — schema mismatch with results.tsv.
- `meta_decide.py` exits non-zero — schema mismatch with result.json.
- Decision is `revert` against self — bug in the decide rule.

## 5. Real baseline (N=10 on `skill-v0`)

**Goal:** overwrite the smoke result.json with statistically usable baseline numbers.

**Run:**

```bash
rm -f meta-runs/skill-v0/result.json
AR_HEADLESS=0 ./scripts/meta-bench.sh --N 10 --skill-tag skill-v0
```

Wall time: ~50–100 min. Watch the dashboard during; the inner loop will keep/revert across 10 iters.

**Verification:**
- `meta-runs/skill-v0/result.json` has real M1..M5 over 10 iters.
- `meta_results.tsv` appends `meta_iter=1`, `skill_tag=skill-v0`, `decision=advance`.
- `champion` tag remains at `skill-v0`.

**Decision gate before §6:**
If `M2_apply_rate` is very low (<0.3) or `M3_keep_rate` is 0, the skill is barely functional on the current ANGLE baseline. Pause and root-cause — running a meta-iter on top of a broken inner loop produces noise, not signal. (Anticipated root causes: stale state from a previous run, ANGLE not at `meta-baseline`, perf counters returning zeros.)

## 6. First real meta-iter

### 6.1 Author the edit

Smallest-blast-radius first iter: add 1–2 lines to `inputs/rules.MD`. Specific content depends on what we learned in §5, but the working hypothesis is a tie-breaker rule for member ordering when correlation signal is weak (e.g., "prefer 8-byte members before 4-byte members for non-hot fields").

```bash
cd /mnt/f/code2/target_skill
# edit struct_layout_opt/inputs/rules.MD
git add struct_layout_opt/inputs/rules.MD
git commit -m "meta(rules): prefer 8B-before-4B for non-hot members

Hypothesis: reduces inner-iter apply-fail rate by giving the LLM
a tie-breaker when correlation signal is weak.
Eval-N: 10"
./scripts/tag_meta_iter.sh   # produces next skill-vN tag (likely skill-v2)
```

The pre-commit hook runs `check_manifest.py HEAD~1..HEAD` and accepts because `rules.MD` is in `evolving:`. Accidentally touching a frozen file would reject the commit.

### 6.2 Evaluate

```bash
cd /mnt/f/code2/struct_cache_opt
AR_HEADLESS=0 ./scripts/meta-bench.sh --N 10 --skill-tag skill-v2
```

Wall time: another ~50–100 min. C1 and C2 can run back-to-back unattended; pause between only if §5 verification flagged anomalies.

### 6.3 Possible outcomes

| Decision | Effect | Operator action |
|---|---|---|
| `advance` | `champion` tag moves to `skill-v2`; target_skill HEAD stays at v2 | None — first proof the meta-loop can improve the skill |
| `revert` | target_skill checkout returns to old `champion`; row records the failed hypothesis | Read the row, decide if the hypothesis is wrong or if the rule needs different wording |
| `manual` | Candidate left in working tree | Inspect M1..M5 deltas, write a follow-up commit explaining the call |

## 7. Monitoring pattern

**During a run** (live):
- Dashboard at `http://localhost:8080`. Watch Stage 1 (diff), Stage 3 (build), Stage 4 (verify) for each inner iter.
- Side terminal: `tail -f /mnt/f/code2/struct_cache_opt/meta-runs/<tag>/autoresearch.log` if the dashboard is slow or proxied.

**After a run** (durable):
- One new row in `meta_results.tsv` — the verdict.
- `meta-runs/<tag>/result.json` — the full M1..M5.
- `meta-runs/<tag>/results.tsv` — per-inner-iter detail.
- `meta-runs/<tag>/autoresearch.log` — full pipeline log.

No new dashboard yet. If meta-iters accumulate to where the TSV becomes hard to scan, build a meta-versions view then (out of scope for this spec).

## 8. Out of scope

- Phase 2 autonomy (an outer LLM driver that proposes meta-iters). Hooks for it (`champion` tag, result.json shape, MANIFEST) are already in place.
- Meta-dashboard visualization across meta-iters.
- Physical file reorganization (e.g. evolve/ subdir). MANIFEST.yml is sufficient.
- Changes to inner-loop scoring (M1..M5 definitions).
- Splitting `pahole_extractor` into frozen/evolving — it's upstream infrastructure shared with other skills, not subject to the meta-loop.

## 9. Risks and unknowns

| Risk | Likelihood | Mitigation |
|---|---|---|
| Smoke pass exposes a previously unhit bug in meta-bench.sh or score/decide | Medium | The verification table in §4 catches each failure mode at its boundary. Fix-forward; don't skip §4 to chase §6. |
| `skill-v0` baseline numbers are themselves noisy (high M5_cv) | Medium | If `M5_cv > 0.25`, treat baseline as unreliable and rerun §5 once before §6. |
| First meta-iter is a no-op (rule never fires) | Medium | If `M1` and `M2..M4` are within noise of baseline, the `manual` decision rule should fire — that's informative, not a failure. |
| Dashboard proxy issues on WSL | Low | Use `http://<WSL IP>:8080` directly; the dashboard falls back to HTTP polling if WebSocket is blocked. |
| meta-bench.sh deletes state mid-run if invoked twice in parallel | Low | Operator discipline. Phase 2 would need a lockfile. |

## 10. Done criteria

This spec is complete when all of the following hold:

- `meta-bench.sh` honors inbound `AR_HEADLESS`.
- `meta-runs/skill-v0/result.json` contains real M1..M5 over N=10.
- `meta_results.tsv` has three rows: the smoke pass (meta_iter=0, N=2, skill-v0), the real baseline (meta_iter=1, N=10, skill-v0), and the first real candidate (meta_iter=2, N=10, skill-v2). The first two are trivial self-comparisons; only the third is a real verdict.
- The first candidate's decision is recorded (advance, revert, or manual) and consistent with the M1..M5 delta vs baseline.
- The operator has read the full row, confirmed the verdict matches intuition, and either accepted `champion` movement or written a follow-up commit explaining a `manual` call.
