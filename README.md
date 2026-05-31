# struct_cache_opt

An **autonomous optimization loop** ("autoresearch") that automatically tunes the
memory layout of a hot C++ data structure — ANGLE's `vk::ImageHelper` — to reduce
CPU cache misses, benchmarks every change on real GPU workloads, keeps the winners,
and reverts the rest. A second, outer **meta-loop** then evolves the optimizer
itself.

In short: each round an LLM (the `struct_cache_opt` skill) proposes a field-reorder
diff → ANGLE is rebuilt → an `angle_perftests` draw-call workload is run under
`perf stat` → `cycles` / `cache-misses` / `dTLB-load-misses` are captured and amended
into the commit body → if `cache-misses` beats the historical best the commit is
kept, otherwise it is `git revert`ed.

## How it works

### Inner loop — optimize the struct

A TypeScript backend (`autoresearch/`) drives an 8-stage pipeline, one iteration per
round, against a target git repo (the ANGLE checkout):

| Stage | What it does |
|------:|--------------|
| 0 | Init & setup (auth, git config) |
| 1 | **Generate diff** — call the skill's `run.sh` with `pahole` layout + git log + recent results as context |
| 2 | **Apply diff** — `git apply`, with a `recount_diff.py` + `patch --fuzz` fallback for hallucinated line numbers |
| 3 | **Build** — rebuild ANGLE (`libGLESv2`, `libEGL`) |
| 4 | **Verify** — run the workload under `perf stat`, parse the metric |
| 5 | **Decide** — amend perf counters into the commit; keep if better, else `git revert` |
| 6 | **Schedule next** — loop until `iterations` or `plateauPatience` is hit |

Results are appended to `results.tsv` (`iter / status / metric / delta / …`), and a
web dashboard (`Autoresearch Dashboard.html`, served on `http://localhost:8080`)
streams live stage state over WebSocket with HTTP-polling fallback.

### Meta loop (Phase 2) — optimize the optimizer

The outer loop treats the **skill itself** (`prompt.tmpl`, pahole helpers, etc.) as
the thing under optimization. Each meta-iteration proposes an edit to the skill, runs
N inner iterations to evaluate it, scores the run across several metrics
(`meta_results.tsv`: total drop, apply rate, keep rate, struct coverage, cv), and
promotes the new skill version to "champion" only if it wins. See
`scripts/meta-driver.sh` and the `meta_*.py` helpers.

## Repository layout

| Path | Purpose |
|------|---------|
| `autoresearch/` | TypeScript backend — the inner-loop engine (`src/loop.ts`, `src/web.ts`, …) and its test suites |
| `scripts/` | Meta-loop driver + Python scoring/decision/diff helpers (`meta-driver.sh`, `meta_*.py`, `recount_diff.py`) |
| `vk-image-helper.yml` | Inner-loop config (workdir, scope, build/verify/ideate commands) |
| `Autoresearch Dashboard.html` | Live monitoring UI |
| `loop_control/SKILL.md` | Tool-agnostic skill describing how an agent supervises the loop |
| `how-to.md` | Full operations guide (in Chinese) — environment prep, stages, troubleshooting |
| `docs/superpowers/` | Design specs and implementation plans |
| `results.tsv` / `meta_results.tsv` | Inner-loop and meta-loop result logs |

## Quick start

```bash
# 1. Install the backend
cd autoresearch
npm install          # or pnpm install

# 2. Run the test suites
npm test

# 3. Start the server (from repo root config)
npx tsx src/index.ts ../vk-image-helper.yml 2> ../loop.log &
```

Then open `http://localhost:8080/` and click **Start**. Use
`http://localhost:8080/?demo=1` to preview the dashboard UI without a running backend.

> **Note:** the loop expects a configured environment — an ANGLE checkout, the
> `struct_cache_opt` target skill, a GPU workload (`angle_perftests`), and `perf`.
> Paths and host-specific setup (WSL2 caveats, proxy notes, etc.) are documented in
> [`how-to.md`](how-to.md).

## Requirements

- Node.js 20+ (developed on v22) with `tsx`
- Python 3 (meta-loop scoring + diff recount helpers)
- `git`, `perf`, and a buildable ANGLE checkout for actual optimization runs
