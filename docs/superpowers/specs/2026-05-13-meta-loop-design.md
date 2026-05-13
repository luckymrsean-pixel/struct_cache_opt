# autoresearch meta-loop — design

> Status: draft (pending user review)
> Author: brainstormed with Claude 2026-05-13
> Targets: `/mnt/f/code2/target_skill/struct_layout_opt/` (the skill being evolved) +
> `/mnt/f/code2/struct_cache_opt/` (the harness that drives meta-iters)
> Related: `2026-05-13-struct-cache-opt-pipeline-design.md` (the inner-loop pipeline this meta-loop sits on top of)

## 1. Goal

Today's `autoresearch` loop treats the skill (`struct_layout_opt`) as a fixed
black box: skill emits a unified diff, harness applies/builds/benchmarks/scores,
the codebase evolves but the skill never does. When the skill produces bad
diffs (e.g. iters 2–3 on 2026-05-13 both `apply-fail`), there is no feedback
mechanism that improves the skill itself.

This design adds a second-order loop — a **meta-loop** that optimizes the skill.
The inner loop continues to optimize `vk::ImageHelper` cache-misses; the meta-loop
optimizes the skill that drives the inner loop, scored by how well the inner
loop performs in a fixed-size eval window.

The work splits into two phases:

- **Phase 1 (this spec)** — operator-driven meta-loop with measurement scaffolding.
  Operator commits one isolated change to the skill, runs `meta-bench.sh`, reads
  the verdict from `meta_results.tsv`. Deterministic, contained, no autonomy.
- **Phase 2 (future spec)** — an outer LLM driver that proposes meta-iters
  automatically by reading inner-loop history. Phase 1 leaves precise
  [P2-seam] hooks so Phase 2 can plug in without re-architecting.

## 2. Architecture in one diagram

```
                 ┌────────────────────────────────────────────────┐
   META-LOOP     │  operator edits one evolving file in           │
   (Phase 1)     │  target_skill/struct_layout_opt/ and commits   │
                 │  with `meta:` prefix                           │
                 └─────────────────────┬──────────────────────────┘
                                       │
                                       ▼
                 ┌────────────────────────────────────────────────┐
                 │  struct_cache_opt/scripts/meta-bench.sh        │
                 │  ─ stop live loop                              │
                 │  ─ git reset --hard meta-baseline (ANGLE)      │
                 │  ─ wipe skill state/                           │
                 │  ─ AR_TSV=meta-runs/<tag>/results.tsv          │
                 │      autoresearch run --iters N                │
                 │  ─ meta_score.py → result.json                 │
                 │  ─ meta_decide.py → meta_results.tsv           │
                 │  ─ advance / revert / manual                   │
                 └─────────────────────┬──────────────────────────┘
                                       │
                                       ▼
                                  meta_results.tsv
                                  meta-runs/<tag>/result.json   [P2-seam]
                                  target_skill `champion` tag   [P2-seam]

   INNER LOOP                    (unchanged, runs N times during a meta-bench
   per existing spec              and continuously during live operation)
```

## 3. Frozen / evolving partition

The skill repo is split into a contract layer that meta-iters MUST NOT touch
and a policy layer that meta-iters mutate.

### 3.1 Partition

```yaml
# target_skill/struct_layout_opt/MANIFEST.yml
frozen:
  - SKILL.md                # registry metadata; changes invalidate skill discovery
  - run.sh                  # autoresearch invocation contract (env / stdin / stdout)
  - lib/parse_output.py     # STATUS-line protocol parser
  - MANIFEST.yml            # itself

evolving:
  - inputs/rules.MD
  - inputs/cold_path.MD
  - inputs/correlation.MD
  - prompt.tmpl
  - lib/fuse_context.py     # signal computation; new rules may need new signals
```

Sibling `pahole_extractor/` is **outside this manifest** — it is upstream
infrastructure shared with other skills, evolved on its own cadence.

### 3.2 Enforcement

- `lib/check_manifest.py` — given a git revision range, lists files changed and
  exits non-zero if any path is outside the `evolving:` list.
- `target_skill/.git/hooks/pre-commit` — runs `check_manifest.py HEAD~1..HEAD`
  iff the commit subject starts with `meta:`. Other commits (manual
  refactoring of frozen files) bypass the check.

### 3.3 Contract bumps

When the operator deliberately needs to change a frozen file (e.g. tighten
the STATUS protocol), they commit with subject `contract:` instead of `meta:`.
The pre-commit hook lets it through, and `meta-bench.sh` refuses to advance
through a `contract:` commit until the operator explicitly bumps the
`meta-baseline` ANGLE tag too — see §6.4.

## 4. Meta-iter conventions

### 4.1 Commit format

```
meta(<scope>): <one-line change>

Hypothesis: <expected effect on M1..M5>
Eval-N: 10
```

`<scope>` is one of `rules` / `cold_path` / `correlation` / `prompt` /
`fuse_context`, matching the file primarily changed. This makes
`git log --grep='^meta(rules)'` a usable slice.

### 4.2 Tag protocol

- `skill-v<N>` — every meta-iter attempted, advance or revert, gets one of these.
- `champion` — a floating tag that always points to the last `advance` commit.
  `meta-bench.sh` uses this as the comparison baseline.

Advance:
```bash
cd target_skill && git tag -f champion <new-sha>
```

Revert:
```bash
cd target_skill && git checkout champion   # working tree back to baseline
# the skill-v<N> tag remains for post-mortem; champion does not move
```

[P2-seam] An outer driver reads the current champion via
`git rev-parse champion` and the history via `git log champion`.

### 4.3 State reset on every meta-bench

Without resets, cross-iter comparison is unfair (later versions inherit
earlier mutations). `meta-bench.sh` resets four things in order:

| Reset target | Reset to | Owner |
|---|---|---|
| ANGLE worktree | `meta-baseline` tag | meta-bench step 1 |
| skill state dir | empty | meta-bench step 2 |
| autoresearch tsv | isolated `meta-runs/<skill-tag>/results.tsv` | meta-bench step 4 |
| live loop process | stopped (kill via `loop.pid`) | meta-bench step 0 |

`empty_struct_index.tsv` is wiped along with the rest of skill state — meta-bench
evaluates **cold-start performance** of each skill version. (A "warm-start"
evaluation mode is conceivable but out of scope.)

The `meta-baseline` ANGLE tag is created once, manually, at the start of the
project. It does not move automatically. Operator advances it periodically
(see R3 in §8).

### 4.4 Wall-clock budget per meta-iter

- ANGLE reset: ~1s
- Skill state wipe: <1s
- N = 10 inner iters at ~4–5 min/iter (build ≈30s ccached + verify ≈75s
  3-run-median + ideate ≈120–180s) = **40–50 min total**

This sets the throughput ceiling at ~30 meta-iters/day. Phase 2 amortizes by
running overnight; Phase 1 relies on the operator picking high-value changes.

## 5. `meta-bench.sh` contract

### 5.1 CLI

```bash
scripts/meta-bench.sh \
  [--N 10]                         # eval window size
  [--skill-tag HEAD]               # what to evaluate; default current HEAD
  [--baseline-tag meta-baseline]   # ANGLE reset target
  [--workdir $AR_WORKDIR]          # ANGLE worktree
```

Non-interactive. Exits 0 when bench completes (regardless of advance/revert).
Non-zero exit means meta-bench itself failed (infrastructure problem).

### 5.2 Steps

```
0.  test -f loop.pid && kill -INT "$(cat loop.pid)" && wait
1.  cd $AR_WORKDIR && git reset --hard <baseline-tag>
2.  cd target_skill && git checkout <skill-tag>
3.  rm -rf struct_layout_opt/state/<lib>/*
4.  RUN_DIR=meta-runs/<skill-tag>; mkdir -p "$RUN_DIR"
5.  AR_TSV=$RUN_DIR/results.tsv \
        autoresearch run --iters N
6.  python3 scripts/meta_score.py  --in  $RUN_DIR/results.tsv \
                                   --out $RUN_DIR/result.json
7.  CHAMPION_TAG=$(cd target_skill && git describe --exact-match champion)
    python3 scripts/meta_decide.py --candidate $RUN_DIR/result.json \
                                   --champion  meta-runs/$CHAMPION_TAG/result.json \
                                   --append    meta_results.tsv
8.  case $(jq -r .decision $RUN_DIR/result.json) in
      advance) cd target_skill && git tag -f champion <skill-tag> ;;
      revert)  cd target_skill && git checkout champion ;;
      manual)  : ;;   # target_skill stays on candidate; live loop stays stopped
                      # until operator manually moves champion (or not) and restarts
    esac
```

Step 5 requires a small change to autoresearch: support `AR_TSV` env var to
override `tsvPath` from `vk-image-helper.yml`. This is a ~10-line edit in
`autoresearch/src/` — see implementation surface in §7.

### 5.3 Multi-objective metrics

| Metric | Definition | Role |
|---|---|---|
| **M1** total_drop | `baseline_metric − final_metric` after N inner iters | Primary. How much cache-misses this skill version actually shaved off in N tries. Larger = better |
| **M2** apply_rate | `1 − apply_fail_count / N` | Gate. If <50% the skill is structurally broken, revert |
| **M3** keep_rate | `kept_count / N` | Diagnostic. Skill that always passes apply but never beats benchmark |
| **M4** struct_coverage | distinct fqnames touched in kept iters | Diagnostic. Catches skill versions that fixate on one struct |
| **M5** keep_delta_cv | cv across kept-iter deltas | Diagnostic. High cv = lucky-shot skill, not robust |

### 5.4 Decision rule (`meta_decide.py`)

```
if   apply_rate < 0.5            -> revert    # gate
elif M1 < champion.M1 * 0.9      -> revert    # primary regressed significantly
elif M1 > champion.M1 * 1.1      -> advance   # primary improved significantly
else                              -> manual    # within noise band; operator decides
```

10% noise band is the starting constant. After ~5 meta-iters of real data,
operator may tighten or loosen based on observed M5 distribution. The band is
a parameter in `meta_decide.py`, not a magic number.

### 5.5 `meta_results.tsv` schema

```
# direction=multi  primary=M1  baseline_tag=meta-baseline
meta_iter  skill_tag  parent_tag  eval_N  M1_total_drop  M2_apply_rate  M3_keep_rate  M4_struct_cov  M5_cv   decision  reason                  ts                    run_dir
0          skill-v0   -           10      23500513       40%            10%           1              n/a     baseline  initial champion        2026-05-13T12:03:55Z  meta-runs/skill-v0
1          skill-v1   skill-v0    10      28100000       70%            30%           2              12.4%   advance   M1 +19.6%, M2 +30pp     2026-05-13T14:12:09Z  meta-runs/skill-v1
2          skill-v2   skill-v1    10      27900000       70%            30%           2              13.1%   manual    within noise band       2026-05-13T15:04:31Z  meta-runs/skill-v2
```

[P2-seam] An outer LLM driver reads `meta-runs/<tag>/result.json` (machine
schema); the operator reads `meta_results.tsv` (human schema). Both are kept
in sync by `meta_decide.py`.

## 6. Dashboard surfacing + operator workflow

### 6.1 Dashboard changes

**v0 (this phase) — read-only table.** New tab "Skill versions" in
`Autoresearch Dashboard.html`. Parses `meta_results.tsv` into a table; current
champion row highlighted. `decision=manual` rows flagged in yellow.

**v0.1 (deferred, not in this phase) — interactive buttons.** Per-row
Advance/Revert buttons; a global "Resume live loop" button. Wired through the
existing WebSocket / dual-PTY infrastructure.

Rationale for the split: Phase 1 only needs `meta-bench.sh` + tsv + decision
script to be production-grade. The v0 table plus a terminal for git commands
is fully usable. v0.1 is sugar that can be added at any point — its absence
does not block the meta-loop.

### 6.2 Operator walkthrough

```
1. Watch dashboard. Last 10 inner iters had 4 apply-fail.
   Hypothesis: the LLM is dropping hunk context lines.

2. cd /mnt/f/code2/target_skill/struct_layout_opt
   $EDITOR prompt.tmpl                       # add "require exact 3-line context"
   git commit -am "meta(prompt): require exact 3-line hunk context

   Hypothesis: apply_rate jumps from 60% to >85%
   Eval-N: 10"
   bash scripts/tag_meta_iter.sh             # tags skill-v<next>

3. cd /mnt/f/code2/struct_cache_opt
   bash scripts/meta-bench.sh                # ~45 min

4. Dashboard "Skill versions" tab now shows a new row:
   - decision=advance: champion tag auto-moved
   - decision=revert:  target_skill HEAD already rolled back
   - decision=manual:  operator inspects M2/M3 and chooses

5. bash scripts/start.sh                     # explicit resume of live loop
```

The live loop is **not** auto-resumed after meta-bench, even on `advance`.
Explicit resume avoids the "I thought we were experimenting but live was
running" failure mode.

### 6.3 File flow summary

```
  target_skill/.git
       │
       │  meta: commit, tag skill-v<N>
       ▼
  meta-bench.sh <skill-v<N>>
       │
       ▼
  meta-runs/skill-v<N>/
       ├─ results.tsv         (isolated inner-loop tsv)
       └─ result.json         (machine schema for [P2-seam])
       │
       ▼
  meta_results.tsv  ←  meta_decide.py appends one row
       │
       ▼
  Dashboard "Skill versions" tab  ←  operator reads
       │
       ▼
  champion tag moved (advance) / not moved (revert/manual)
```

## 7. Implementation surface

| File | Type | Approx LOC |
|---|---|---|
| `target_skill/struct_layout_opt/MANIFEST.yml` | new | ~15 |
| `target_skill/struct_layout_opt/lib/check_manifest.py` | new | ~50 |
| `target_skill/.git/hooks/pre-commit` | new | ~10 |
| `target_skill/scripts/tag_meta_iter.sh` | new (sugar) | ~20 |
| `struct_cache_opt/scripts/meta-bench.sh` | new | ~100 |
| `struct_cache_opt/scripts/meta_score.py` | new | ~80 |
| `struct_cache_opt/scripts/meta_decide.py` | new | ~40 |
| `struct_cache_opt/meta_results.tsv` | new (header only) | 2 |
| `struct_cache_opt/autoresearch/src/*` | edit: honor `AR_TSV` env override | ~10 |
| `struct_cache_opt/Autoresearch Dashboard.html` | edit: add read-only "Skill versions" tab | ~80 |

Operator-side one-time action: `cd $AR_WORKDIR && git tag meta-baseline HEAD`.

## 8. Risks and known caveats

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Throughput ceiling** — ~30 meta-iters/day max at N=10. If M5 forces N=20, throughput halves. | Phase 2 amortizes via overnight autonomy. Phase 1 leans on operator judgment to pick high-yield changes. |
| R2 | **LLM noise leaks past the gate** — 10% noise band is a guess. | `meta_decide.py` exposes the band as a parameter; after ~5 meta-iters, tighten to 2σ of observed M5. |
| R3 | **Champion overfits to baseline ANGLE state** — every meta-bench resets to `meta-baseline`. A skill that wins from baseline may underperform once the live loop's cumulative ANGLE changes pile up. | Operator periodically pushes `meta-baseline` forward to live HEAD; record the re-baseline event in `meta_results.tsv` as a `note:` row. |
| R4 | **Contract bumps break cross-iter comparability** — changing a frozen file shifts the experimental setup mid-stream. | Use `contract:` commit prefix; `meta-bench.sh` refuses to advance through one without operator re-baselining ANGLE too. |
| R5 | **Ideate timeouts** — Stage 1 has no hard limit. A regressive skill version could push ideate to 5+ min. | `meta-bench.sh` enforces a 240s soft timeout per ideate; timeouts count as apply-fail in M2. |
| R6 | [P2-seam] **Outer LLM reward hacking** — Phase 2 driver may learn that emitting `cannot_update` lifts apply_rate (M2) at the cost of progress (M1). | Decision rule already makes M1 dominant; Phase 2 spec must explicitly list "no reward-hacking on M2/M3" and add a coverage floor on M4. |

## 9. Out of scope

- Auto-derived `cold_path.MD` / `correlation.MD` (grep/perf-record inference).
- Generalization beyond `target_lib=vk_helpers`.
- Changing the inner metric (cache-misses, lower=better stays).
- Phase 2 itself (outer LLM driver) — separate spec.
- Skill self-rewrite (LLM mutating its own `prompt.tmpl` then evaluating) — Phase 2+.
- Pareto chart, advance/revert buttons — v0.1, layered on later.

## 10. Migration

Single feature branch off `master`:

1. Add new files under `target_skill/struct_layout_opt/` (MANIFEST + check_manifest + hook + tag script).
2. Add new files under `struct_cache_opt/scripts/` (meta-bench + meta_score + meta_decide).
3. Patch `autoresearch/src/` to honor `AR_TSV` env override.
4. Extend `Autoresearch Dashboard.html` with the read-only Skill versions tab.
5. Commit `meta_results.tsv` with header row only.
6. Operator action post-merge: `cd $AR_WORKDIR && git tag meta-baseline HEAD`.
7. Operator action post-merge: in `target_skill/`, `git tag champion HEAD && git tag skill-v0 HEAD` to seed the baseline.

No data migration. No live-loop downtime beyond the bench window.
