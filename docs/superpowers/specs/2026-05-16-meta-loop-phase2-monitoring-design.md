# Meta-Loop Phase 2 + Monitoring — Design

**Date:** 2026-05-16
**Status:** Spec (driven to implementation under an explicit completion goal — no approval gate)
**Related:** `2026-05-13-meta-loop-design.md` (Phase 1, the [P2-seam] hooks this builds on),
`2026-05-14-dashboard-meta-rework-design.md` (Skill Quadrants + stage-log panel this extends)

## 1. Goal

Drive the meta-loop until it does **real** optimization of the target skill,
fix the bugs that block that today, then run it autonomously and observably.

Concretely the end state is:

1. The inner loop reliably turns an ideate call into an *applicable* diff
   (today it does not — see §2).
2. An outer driver runs N meta-iters autonomously: propose a skill edit →
   `meta-bench.sh` → read verdict → advance/revert → repeat, with no operator
   click per iter.
3. The evolution process is observable: a monitoring surface shows live
   meta-iter progress, M1–M5 trends, and *why* each advance/revert happened.

Three modules, landed in order. Module A is the prerequisite — B and C are
worthless if the inner loop can't produce signal.

## 2. Root cause (the bug blocking real optimization)

Evidence: `meta-runs/skill-v2-N3.controller.log`, `skill-v0/result.json`.
The loop *can* optimize — `skill-v2` shaved cache-misses 67.3M → 54.1M
(−19.7%, 2/3 iters kept). But it is unreliable, for two coupled reasons:

**A1 — ideate is fully agentic.** `vk-image-helper.yml` sets
`IDEATE_CLI: "claude -p"`. The skill's `run.sh` pipes the prompt into it with
*no tool restrictions and no output-format control*. `claude -p` defaults to
all tools enabled; it detects the nested-agent env, prepends
`--quiet --batch=false --heartbeat_period=30s`, and frequently *does the work
itself* — running `autoninja` ("The build has finished successfully."),
editing files — then replies with prose analysis ("I'll cluster the per-write
hot data…") instead of a diff. This corrupts ANGLE state outside the loop's
controlled apply/build/verify and yields no patch.

**A2 — the parser is brittle.** `struct_layout_opt/lib/parse_output.py`
matches the `STRUCT: <fq> STATUS: update` header *only on `lines[0]`*. Any
preamble (prose, agent banner, code fence) on line 0 → "malformed header" →
empty stdout → `git apply` → "No valid patches in input" → `apply-fail`.

Fix = constrain the model to a pure text completion **and** make the parser
locate the protocol anywhere in the output. Both, not either.

## 3. Module A — inner-loop ideate reliability (prerequisite)

### A.1 Non-agentic, deterministic ideate

Change `vk-image-helper.yml` `env.IDEATE_CLI` to:

```
claude -p --tools "" --output-format json --no-session-persistence --permission-mode plan
```

- `--tools ""` — disables every tool. claude *cannot* build/edit; its only
  possible output is a text completion = the diff. Kills A1 at the source.
- `--output-format json` — single JSON object; the model text is `.result`,
  isolated from the "Detected AI agent env" banner and any stderr.
- `--no-session-persistence` — no cross-iter state leakage (each ideate is
  cold, matching meta-bench's cold-start contract).
- `--permission-mode plan` — defense in depth; even if a tool slipped through
  it could not mutate the tree.

`IDEATE_CLI` is a yml `env:` value, not a frozen skill file — changing it is a
harness config edit, not a skill mutation, so it does not touch the MANIFEST
partition.

### A.2 `run.sh` extracts `.result` from JSON

`run.sh` is **frozen** in `MANIFEST.yml`. This edit is a deliberate contract
change → commit subject prefix `contract:` (the pre-commit hook lets
`contract:`/non-`meta:` commits bypass `check_manifest.py`).

The ideate pipeline becomes:

```bash
printf '%s' "$prompt" \
  | $ideate_cli \
  | python3 "$skill_dir/lib/extract_result.py" \
  | python3 "$skill_dir/lib/parse_output.py" --target-lib "$target_lib" --iter "$iter_n"
```

`extract_result.py` (new, frozen): if stdin is a single JSON object with a
`.result` string, print that string; otherwise print stdin unchanged
(text-mode / non-JSON passthrough). Defensive — never throws, exit 0 always.
Decoupling extraction from `parse_output.py` keeps each file single-purpose
and independently testable.

### A.3 Harden `parse_output.py` (frozen → `contract:`)

Replace the `lines[0]`-only header match with: scan the whole text for the
**first line** matching `HEADER_RE`; treat everything before it as discardable
preamble. After an `update` header, locate the diff body by the first
`diff --git ` *or* the contents of the first fenced ```​diff /  ```​patch
block (models wrap diffs in fences often enough that tolerating it is cheaper
than fighting it). Strip a trailing ``` fence. Still defensive: any
ambiguity → empty stdout + stderr note, exit 0 (loop logs `ideate-fail`,
moves on — never crashes).

### A.4 `prompt.tmpl` (evolving → `meta:`-eligible, but committed here as setup)

Tighten to match the hardened parser: explicitly *allow* an optional single
fenced ```​diff block, and restate "no tool use — you are a text completion;
emit STATUS then diff and nothing else." This reduces the rate at which the
model needs the parser's tolerance at all.

### A.5 Verification gate for Module A

Before B/C, prove real optimization with the cheapest sufficient evidence:

1. **Unit:** new `tests/test_extract_result.py` + extended
   `tests/test_parse_output.py` cases (agent banner preamble, prose-before-
   header, fenced diff, JSON-wrapped). Run the skill's test suite green.
2. **Single live ideate:** invoke the real pipeline once against the live
   ANGLE tree; assert stdout is a syntactically valid unified diff
   (`git apply --check`) — *no build needed*.
3. **One real inner iter** via the existing loop (headless, `AR_ITERS=1`):
   assert TSV row is `keep` or `discard/regress` with a numeric metric — i.e.
   the pipeline reached verify, not `apply-fail`/`ideate-fail`.

Only when (1)–(3) pass is "the loop can do real optimization" satisfied.

## 4. Module B — Phase 2 automated meta-driver

A loop around the Phase-1 `meta-bench.sh`, which already does reset → run N
inner iters → score → decide → move champion. Phase 2 supplies the missing
piece: **proposing the next skill edit automatically** and **looping**.

### B.1 `scripts/meta-driver.sh`

```
scripts/meta-driver.sh --meta-iters 3 [--N <inner>] [--max-usd <budget>]
```

Per meta-iter:

1. `git -C $SKILL_REPO checkout champion` (clean base).
2. **Propose** — call `scripts/propose_meta_edit.py` (below). It writes one
   edit to an *evolving* file and stages it.
3. `git -C $SKILL_REPO commit -m "meta(<scope>): <one-line>\n\nHypothesis: …\nEval-N: <N>"`
   then `bash scripts/tag_meta_iter.sh` → `skill-v<next>`.
   The pre-commit hook (`check_manifest.py`) enforces evolving-only — a bad
   proposal that touches a frozen file is rejected here, counted as a skipped
   meta-iter, not a crash.
4. `bash scripts/meta-bench.sh --skill-tag skill-v<next> --N <N>` (Phase 1,
   unchanged) → appends `meta_results.tsv`, moves `champion` on advance.
5. Append a driver-side line to `meta-runs/driver.log` and emit a
   `meta-iter-done` event (see §5).
6. Budget guard: if cumulative `claude` spend ≥ `--max-usd`, stop after the
   current meta-iter (`--max-budget-usd` is already enforced per ideate call;
   the driver also sums `result.json` cost if present and hard-stops).

The driver is **idempotent on restart**: meta-iter index is derived from
`meta_results.tsv` (same logic `meta-bench.sh` already uses), so a killed
driver resumes at the next index.

### B.2 `scripts/propose_meta_edit.py`

The "outer LLM driver" from the Phase-1 [P2-seam]. Input: champion skill
state + the last K rows of `meta_results.tsv` + the champion run's
`results.tsv` (inner-loop failure modes). It calls the same non-agentic
`claude -p --tools "" --output-format json` to produce a STRICT proposal:

```
FILE: <one evolving path from MANIFEST.yml>
SCOPE: rules|cold_path|correlation|prompt|fuse_context
ONELINE: <commit subject tail>
HYPOTHESIS: <expected effect on M1..M5>
<unified diff against champion for that one file>
```

Parsed defensively (reuse the hardened `parse_output.py` diff-locator).
Guardrails against reward-hacking (Phase-1 R6): the proposal prompt forbids
edits whose stated mechanism is "emit cannot_update more often"; `meta_decide`
already makes M1 dominant and `meta-bench.sh` keeps the M2 gate. If the
proposal fails to parse or touches a frozen path, the meta-iter is recorded
as `decision=skip reason=bad-proposal` and the driver continues.

### B.3 Safety / invariants

- Live loop is stopped by `meta-bench.sh` step 0 (unchanged); the driver
  never runs concurrently with a live inner loop.
- `champion` only ever moves via `meta-bench.sh` advance — the driver does
  not move it directly (single source of truth).
- ANGLE is reset to `meta-baseline` every meta-bench (unchanged) — cross-iter
  comparability preserved.
- On any infrastructure failure (meta-bench non-zero), the driver logs, emits
  `meta-iter-error`, and stops rather than charging ahead blindly.

## 5. Module C — monitoring surface for the evolution process

Extends the existing dashboard (Skill Quadrants + stage-log panel already
present from the 2026-05-14 rework). No new server process — new endpoints on
the existing `web.ts`, served whether or not a live inner loop is running.

### C.1 Data already on disk

`meta_results.tsv` (human), `meta-runs/<tag>/result.json` (machine, M1–M5),
`meta-runs/<tag>/autoresearch.log` (inner-iter detail), and the new
`meta-runs/driver.log` (one line per meta-iter: proposal scope + hypothesis +
decision + reason). C only reads these.

### C.2 Endpoints (`web.ts`)

| Path | Returns |
|---|---|
| `GET /api/meta-state` | parsed `meta_results.tsv` rows + current `champion` tag + driver running? (pid file) + last `driver.log` line |
| `GET /api/meta-run?tag=<skill-vN>` | that run's `result.json` + tail of its `autoresearch.log` |

`fs.watch(meta_results.tsv)` and `fs.watch(meta-runs/driver.log)` →
broadcast `{type:"meta-updated"}`; browser re-pulls (same pull-on-notify
pattern the stage-log panel already uses).

### C.3 Dashboard panel: "Evolution"

A new tab/section rendering `/api/meta-state`:

- **Lineage table** — one row per meta-iter: `skill-vN`, parent, scope,
  M1 (Δcache-misses, with sparkline vs prior), M2 apply-rate, M3 keep-rate,
  M4 cov, M5 cv, decision (color: advance=green, revert=red, manual/skip=
  yellow), reason. Champion row pinned/highlighted.
- **M1 trend** — small line chart of `M1_total_drop` across meta-iters so the
  operator sees whether the skill is actually getting better.
- **Live status** — when `meta-driver.sh` is running: current meta-iter k/of,
  current phase (proposing / benching inner iter j/N), last hypothesis. Wired
  from the existing 2s status tick + `meta-updated` events.
- Clicking a row → modal with that meta-iter's proposed diff
  (`git -C skillDir show skill-vN -- <file>`, reuse the existing skill-diff
  modal) and `result.json`.

### C.4 Demo-safe

Behind real data only; if `meta_results.tsv` has just the header the panel
shows "no meta-iters yet" (no mock data — consistent with the 2026-05-14
demo-isolation rule).

## 6. Implementation surface

| File | Module | Nature |
|---|---|---|
| `vk-image-helper.yml` | A | edit `env.IDEATE_CLI` (non-agentic flags) |
| `target_skill/struct_layout_opt/lib/extract_result.py` | A | new (frozen) — JSON `.result` passthrough |
| `target_skill/struct_layout_opt/lib/parse_output.py` | A | harden header/diff locator (frozen → `contract:`) |
| `target_skill/struct_layout_opt/run.sh` | A | insert `extract_result.py` (frozen → `contract:`) |
| `target_skill/struct_layout_opt/prompt.tmpl` | A | allow fenced diff, restate no-tools |
| `target_skill/struct_layout_opt/MANIFEST.yml` | A | add `lib/extract_result.py` to frozen |
| `target_skill/struct_layout_opt/tests/test_extract_result.py` | A | new unit test |
| `target_skill/struct_layout_opt/tests/test_parse_output.py` | A | + preamble/fence/json cases |
| `struct_cache_opt/scripts/meta-driver.sh` | B | new (~120 LOC) |
| `struct_cache_opt/scripts/propose_meta_edit.py` | B | new (~140 LOC) |
| `struct_cache_opt/scripts/tests/test_propose_meta_edit.py` | B | new unit test |
| `struct_cache_opt/autoresearch/src/web.ts` | C | + `/api/meta-state`, `/api/meta-run`, fs.watch |
| `struct_cache_opt/Autoresearch Dashboard.html` | C | + "Evolution" panel |
| `struct_cache_opt/autoresearch/src/tests/meta-state.test.ts` | C | new unit test |
| `how-to.md` | C | document meta-driver + Evolution panel |

Frozen-file edits (`run.sh`, `parse_output.py`, new `extract_result.py`) ship
as one `contract:` commit in `target_skill`; the operator must then re-tag
`champion`/`skill-v0` at the new contract HEAD and (per Phase-1 R4) re-tag
`meta-baseline` on ANGLE if it moved — handled by the plan's migration step.

## 7. Testing / verification

- **A:** skill test suite green; live single-ideate `git apply --check` clean;
  one headless real inner iter reaches verify (not apply-fail).
- **B:** `propose_meta_edit.py` unit test (fixture meta_results + champion →
  valid evolving-only diff); `meta-driver.sh --dry-run` (reuses meta-bench
  `--dry-run`) runs 2 meta-iters touching only evolving files, no champion
  move, no LLM spend.
- **C:** `meta-state.test.ts` (fixture tsv → parsed rows + champion); manual
  dashboard check that the Evolution panel renders and live-updates.
- **End-to-end:** `meta-driver.sh --meta-iters 3 --N <small>` produces 3 new
  `meta_results.tsv` rows with real M1 values; at least one inner iter per
  meta-bench is `keep` (proves real optimization, not apply-fail noise).

## 8. Out of scope

- Auto-deriving cold_path/correlation from perf-record (still manual knowledge).
- Generalizing beyond `target_lib=vk_helpers`.
- Changing the inner metric (cache-misses, lower=better stays).
- Pareto front / multi-objective driver search — Phase 2 optimizes M1 with the
  M2 gate; richer search is a later phase.
- Skill self-rewrite where the skill mutates its own prompt then evaluates in
  the same process — `propose_meta_edit.py` is a *separate* driver, by design.

## 9. Migration

1. Land A files on a feature branch in both repos.
2. `target_skill`: one `contract:` commit (run.sh + parse_output.py +
   extract_result.py + MANIFEST.yml + prompt.tmpl), then
   `git tag -f champion HEAD && git tag -f skill-v0 HEAD` (new contract
   baseline; prior skill-vN tags kept for history).
3. ANGLE: if HEAD moved since `meta-baseline`, operator re-tags
   `git -C /home/fxy/angle tag -f meta-baseline HEAD` and records a `note:`
   row in `meta_results.tsv` (Phase-1 R3).
4. Seed `meta-runs/skill-v0/result.json` via one `meta-bench.sh --skill-tag
   skill-v0` so the driver has a champion baseline to compare against.
5. Land B, then C.
6. Start: `meta-driver.sh --meta-iters 3` (terminal state of the goal).
