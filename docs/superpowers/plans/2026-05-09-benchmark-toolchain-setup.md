# Benchmark & Analysis Toolchain Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision a WSL2 Ubuntu (x64) workstation with GFXBench 5, Google ANGLE, and an architecture-portable performance-analysis toolchain (pahole / perf / valgrind-cachegrind) so the existing `autoresearch` loop can iterate on `angle_perftests` cache-locality optimizations whose results generalize to ARM Cortex-A72.

**Architecture:** Three independent installs (GFXBench, ANGLE, analysis tools) sit side by side under the user's home; ANGLE is the optimization target consumed by `autoresearch.yml`'s `guardCmd` / `verifyCmd`, while pahole + perf + cachegrind provide source-level struct-layout inspection (pahole), runtime cycle counts (perf, the loop's metric source), and architecture-agnostic cache simulation (cachegrind, the substitute for the architecture-locked Intel VTune). GFXBench is built only as a reference workload; the closed-loop iteration runs against `angle_perftests`.

**Tech Stack:** Ubuntu 22.04+ on WSL2, CMake, Ninja, depot_tools (gn + autoninja), Python 3.10+, dwarves (pahole), linux-tools-generic (perf), valgrind (cachegrind), Mesa GL/EGL/Vulkan dev headers.

**Important environment notes:**
- The repo at `/mnt/f/code2/struct_cache_opt` is **not** a git repo — system-provisioning steps therefore do **not** include `git commit`. Code/config edits inside `autoresearch/` (which is its own git repo) commit normally.
- `fetch angle` downloads tens of GB and may take 30–120 minutes; Task 3 runs it in the background.
- WSLg requires Windows 11 (or Windows 10 ≥ build 19044 with KB5020030). On older hosts, X11 fallback (VcXsrv) is required — Step 1.4 detects which.
- **Cache Explorer** (LLVM-instrumented MESI simulator described in the source brief) is **not included**: no install URL was provided. Cachegrind covers the same role with full Cortex-A72 cache parameters; once a Cache Explorer source is supplied, add it as a follow-up task.

---

## File Structure

System-level installs (no source files created in this repo):
- `~/work/gfxbench/` — GFXBench 5 source tree + `build/` output
- `~/depot_tools/` — Chromium tooling on `PATH`
- `~/angle/` — ANGLE source + `out/Release/` build directory (also referenced by `autoresearch.yml` as `workdir`)
- `~/work/cachegrind-baseline/` — cachegrind output for baseline run

Files this plan creates or modifies inside the repo:
- Create: `/mnt/f/code2/struct_cache_opt/docs/setup-log.md` — running log of installed tool versions, smoke-test outputs, and the recorded baseline metric. One file is the right grain: it is the durable artifact a future engineer reads to know "what is on this machine and what was the starting number."
- Modify: `/mnt/f/code2/struct_cache_opt/autoresearch/autoresearch.yml` — set `workdir` to the absolute ANGLE path on this machine (currently hard-coded to `/home/sean/angle`) and clear `remote` for local execution.

---

## Task 1: System Prerequisites

**Files:**
- Create: `~/work/` (workspace root)
- Create: `/mnt/f/code2/struct_cache_opt/docs/setup-log.md`

- [ ] **Step 1.1: Create workspace and setup log**

```bash
mkdir -p ~/work
cat > /mnt/f/code2/struct_cache_opt/docs/setup-log.md <<'EOF'
# Toolchain Setup Log

| Component | Version | Installed at | Smoke test |
|-----------|---------|--------------|------------|
EOF
```

- [ ] **Step 1.2: Update apt and install build + analysis dependencies**

```bash
sudo apt update
sudo apt install -y \
  build-essential cmake ninja-build git python3 python3-pip pkg-config \
  libgl1-mesa-dev libegl1-mesa-dev libgles2-mesa-dev libvulkan-dev \
  mesa-utils vulkan-tools \
  dwarves linux-tools-common linux-tools-generic valgrind \
  curl ca-certificates lsb-release
```

Why each group:
- `build-essential cmake ninja-build` — GFXBench (CMake) and ANGLE (Ninja) builds
- `libgl1-mesa-dev libegl1-mesa-dev libgles2-mesa-dev libvulkan-dev` — ANGLE's GL/EGL/Vulkan backend headers
- `mesa-utils vulkan-tools` — `glxinfo` / `vulkaninfo` for Step 1.4 driver verification
- `dwarves` — provides `pahole` (DWARF struct-layout dump; the primary tool for designing cache-line-aligned struct edits)
- `linux-tools-generic` — provides `perf` (cycle-counting; this is the metric the autoresearch loop reads)
- `valgrind` — provides `cachegrind` and `callgrind` (architecture-agnostic cache simulator with configurable topology — used to model the Cortex-A72 L1/L2 hierarchy on this x64 host)

- [ ] **Step 1.3: Verify each tool reports a version**

Run:
```bash
for cmd in gcc cmake ninja python3 pahole perf valgrind glxinfo vulkaninfo; do
  printf '%-12s ' "$cmd"; "$cmd" --version 2>&1 | head -1 || echo "MISSING"
done
```

Expected: every line shows a version string; no `MISSING`.
If `perf` prints `WARNING: perf not found for kernel ...`, run `sudo ln -sf /usr/lib/linux-tools/*/perf /usr/local/bin/perf` (the package installs perf under a kernel-versioned subdirectory that doesn't always match the running WSL2 kernel).

- [ ] **Step 1.4: Detect and verify graphics display path (WSLg vs X11 fallback)**

Run:
```bash
if [ -n "$WAYLAND_DISPLAY" ] || [ -e /mnt/wslg ]; then
  echo "WSLg detected"
  glxinfo | grep -E "OpenGL renderer|OpenGL version" || echo "GL not reachable"
  vulkaninfo --summary 2>&1 | grep -E "GPU id|deviceName" | head -5 || echo "Vulkan not reachable"
else
  echo "WSLg NOT present — set DISPLAY to an external X server (e.g. VcXsrv on Windows) before running graphics binaries"
fi
```

Expected on a Win11 + WSLg machine: `WSLg detected`, an `OpenGL renderer` line (typically `D3D12 (NVIDIA ...)` or similar), and at least one Vulkan device.

If WSLg is absent, install VcXsrv on the Windows host, launch with "Disable access control" enabled, and append `export DISPLAY=$(grep nameserver /etc/resolv.conf | awk '{print $2}'):0` to `~/.bashrc`. Re-run this step until both `glxinfo` and `vulkaninfo` succeed.

- [ ] **Step 1.5: Append Task 1 results to setup log**

Run:
```bash
{
  echo "| build-essential | $(gcc -dumpversion) | $(date -Iseconds) | gcc --version OK |"
  echo "| cmake          | $(cmake --version | head -1 | awk '{print $3}') | $(date -Iseconds) | --version OK |"
  echo "| ninja          | $(ninja --version) | $(date -Iseconds) | --version OK |"
  echo "| pahole         | $(pahole --version 2>&1 | head -1) | $(date -Iseconds) | --version OK |"
  echo "| perf           | $(perf --version 2>&1) | $(date -Iseconds) | --version OK |"
  echo "| valgrind       | $(valgrind --version) | $(date -Iseconds) | --version OK |"
  echo "| display-path   | $([ -e /mnt/wslg ] && echo WSLg || echo X11-fallback) | $(date -Iseconds) | glxinfo+vulkaninfo OK |"
} >> /mnt/f/code2/struct_cache_opt/docs/setup-log.md
```

Expected: six new rows in `docs/setup-log.md`. No commit (this dir is not a repo).

---

## Task 2: GFXBench 5 Build & Smoke Test

**Files:**
- Create: `~/work/gfxbench/` (clone target)
- Create: `~/work/gfxbench/build/` (CMake out-of-tree build)
- Modify: `/mnt/f/code2/struct_cache_opt/docs/setup-log.md` (append result row)

- [ ] **Step 2.1: Clone the open-source GFXBench 5 repository**

Run:
```bash
cd ~/work
git clone https://github.com/Kishonti-Opensource/gfxbench.git
cd gfxbench
git log -1 --oneline
```

Expected: clone completes, last line prints a short SHA + commit subject.
If clone fails with 404, the repo URL provided in the brief was not yet correct — stop and report back; do not substitute a guess.

- [ ] **Step 2.2: Read the project's build documentation before building**

Run:
```bash
ls doc/ 2>/dev/null && head -100 doc/BUILD.md 2>/dev/null || \
  echo "No doc/BUILD.md; checking root README" && head -200 README.md
```

Read the output and note:
- Required CMake variables (e.g. `-DGFX_API=GLES`, `-DBUILD_TESTS=ON`)
- Any submodule init step (run `git submodule update --init --recursive` if mentioned)

If a CMake variable is required for headless / off-screen rendering and you intend to skip WSLg display, capture it now.

- [ ] **Step 2.3: Configure with CMake out-of-tree**

Run:
```bash
cmake -S ~/work/gfxbench -B ~/work/gfxbench/build \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release
```

Expected: configuration completes with `-- Configuring done` and `-- Generating done`.
If a feature is reported as "not found" (e.g. `Vulkan: NO`), confirm it is non-fatal in the project's docs before proceeding; if it is fatal, install the missing dev package and re-run.

- [ ] **Step 2.4: Build**

Run:
```bash
cmake --build ~/work/gfxbench/build --parallel "$(nproc)"
```

Expected: build finishes without error. Note the path of the produced executable(s) — typically `~/work/gfxbench/build/bin/` or similar.

- [ ] **Step 2.5: Smoke-test one short scene**

Run (replace the binary name with whichever the build produced — list with `find ~/work/gfxbench/build -maxdepth 4 -type f -executable | head`):
```bash
cd ~/work/gfxbench/build
timeout 30 ./bin/gfxbench --scene t_rex --frames 60 2>&1 | tail -20
```

Expected: process exits cleanly (return code 0 or 124 from timeout), produces a frame-count or score line.

If you see `eglInitialize failed`, the display path from Step 1.4 is not reaching the GPU — re-verify `glxinfo` works in the same shell.

- [ ] **Step 2.6: Append result row to setup log**

```bash
echo "| gfxbench       | $(cd ~/work/gfxbench && git rev-parse --short HEAD) | $(date -Iseconds) | scene smoke-test OK |" \
  >> /mnt/f/code2/struct_cache_opt/docs/setup-log.md
```

---

## Task 3: ANGLE Fetch, Build & Smoke Test

**Files:**
- Create: `~/depot_tools/` (clone target)
- Create: `~/angle/` (`fetch angle` populates this — must be empty at start)
- Create: `~/angle/out/Release/` (gn output dir)
- Modify: `~/.bashrc` (append depot_tools to PATH)
- Modify: `/mnt/f/code2/struct_cache_opt/docs/setup-log.md`

- [ ] **Step 3.1: Install depot_tools and put it on PATH**

```bash
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git ~/depot_tools
if ! grep -q 'depot_tools' ~/.bashrc; then
  echo 'export PATH="$HOME/depot_tools:$PATH"' >> ~/.bashrc
fi
export PATH="$HOME/depot_tools:$PATH"
which fetch gn autoninja
```

Expected: all three resolve under `~/depot_tools`.

- [ ] **Step 3.2: Fetch the ANGLE source tree (long-running — run in background)**

ANGLE pulls Chromium-style submodules totalling tens of GB; on a typical link this is 30–120 min. Start it in the background and monitor.

```bash
mkdir ~/angle && cd ~/angle
nohup fetch angle > ~/angle/fetch.log 2>&1 &
echo "fetch PID: $!"
```

Wait for completion before proceeding. Check progress periodically:
```bash
tail -5 ~/angle/fetch.log
ls ~/angle/angle 2>/dev/null && echo "fetch complete" || echo "still running"
```

Expected when done: `~/angle/angle/` exists and contains `BUILD.gn`, `src/`, `DEPS`. `fetch.log` ends without an `Error:` line.

- [ ] **Step 3.3: Install ANGLE's Linux build dependencies**

Run from inside the source tree:
```bash
cd ~/angle/angle
./build/install-build-deps.sh --no-prompt
```

Expected: script reports installed packages and exits 0. May require sudo for apt operations — provide when prompted.

- [ ] **Step 3.4: Generate Release build files**

```bash
cd ~/angle/angle
gn gen out/Release --args='is_debug=false angle_enable_vulkan=true angle_enable_gl=true'
```

Expected: `Done. Made N targets from M files in Xms.`

- [ ] **Step 3.5: Build `angle_perftests` (the autoresearch loop's verifyCmd target) plus a sample**

```bash
autoninja -C out/Release angle_perftests hello_triangle
```

Expected: build completes; both `out/Release/angle_perftests` and `out/Release/hello_triangle` exist as executables.

This is the canonical compile target referenced by `autoresearch.yml` `guardCmd` (`autoninja -C out/Release angle_perftests`). Verifying it builds here de-risks Task 5.

- [ ] **Step 3.6: Smoke-test `hello_triangle` (single-frame visual)**

```bash
cd ~/angle/angle
timeout 10 ./out/Release/hello_triangle 2>&1 | tail -10
```

Expected: a window appears (under WSLg) for ~10 s then the process exits via `timeout` (return code 124, which is success here). On X11 fallback, the window appears on the Windows desktop.

- [ ] **Step 3.7: Smoke-test `angle_perftests` with a short DrawQuad iteration count**

This mirrors `verifyCmd` but with reduced iterations to confirm the binary runs end-to-end before measuring a baseline (Task 5).

```bash
cd ~/angle/angle
./out/Release/angle_perftests --gtest_filter='*DrawQuad*' --iterations=5 2>&1 | tail -20
```

Expected: gtest output reports tests run, passed, and prints a `wall_time` or similar line per case. No assertion failures.

- [ ] **Step 3.8: Append result row to setup log**

```bash
echo "| angle          | $(cd ~/angle/angle && git rev-parse --short HEAD) | $(date -Iseconds) | angle_perftests --iterations=5 OK |" \
  >> /mnt/f/code2/struct_cache_opt/docs/setup-log.md
```

---

## Task 4: Analysis Toolchain Verification

**Files:**
- Create: `~/work/toolchain-smoke/` (scratch dir for smoke tests)
- Create: `~/work/toolchain-smoke/struct_demo.c` (pahole input)
- Create: `~/work/toolchain-smoke/cache_demo.c` (cachegrind input)
- Modify: `/mnt/f/code2/struct_cache_opt/docs/setup-log.md`

This task verifies each analysis tool produces useful output on a controlled input *before* pointing it at ANGLE, so that any failure in Task 5 can be attributed to the target rather than the tool.

- [ ] **Step 4.1: Create the workspace and a struct-layout demo for pahole**

```bash
mkdir -p ~/work/toolchain-smoke
cat > ~/work/toolchain-smoke/struct_demo.c <<'EOF'
#include <stdint.h>
struct hot {
    uint8_t  a;
    uint64_t b;   /* 7-byte hole before this on x86_64 */
    uint32_t c;
    uint8_t  d;   /* 3-byte hole after this */
};
struct hot demo;
int main(void) { return demo.a + (int)demo.c; }
EOF
gcc -g -O0 -o ~/work/toolchain-smoke/struct_demo ~/work/toolchain-smoke/struct_demo.c
```

Expected: compiles silently.

- [ ] **Step 4.2: Run pahole and confirm it reports holes**

```bash
pahole -C hot ~/work/toolchain-smoke/struct_demo
```

Expected output contains lines like `/* XXX 7 bytes hole, try to pack */`. If pahole prints nothing, the binary lacks DWARF — confirm `-g` was used.

This is the exact tool Task 5's optimization iterations will use to decide which fields in `src/libANGLE/State.h`, `Program.h`, `Context.h` to repack.

- [ ] **Step 4.3: Create a cache-behavior demo for cachegrind**

```bash
cat > ~/work/toolchain-smoke/cache_demo.c <<'EOF'
#include <stdlib.h>
#include <string.h>
#define N (16 * 1024 * 1024)
int main(void) {
    char *p = malloc(N);
    memset(p, 1, N);
    long sum = 0;
    for (int i = 0; i < N; i += 64) sum += p[i];
    free(p);
    return (int)(sum & 0xff);
}
EOF
gcc -O2 -o ~/work/toolchain-smoke/cache_demo ~/work/toolchain-smoke/cache_demo.c
```

- [ ] **Step 4.4: Run cachegrind with Cortex-A72 cache parameters**

Cortex-A72 reference cache topology (per ARM TRM): L1d 32 KiB / 64 B / 2-way, L2 unified 1 MiB / 64 B / 16-way per cluster.

```bash
mkdir -p ~/work/cachegrind-baseline
valgrind --tool=cachegrind --cache-sim=yes \
  --D1=32768,2,64 \
  --LL=1048576,16,64 \
  --cachegrind-out-file=$HOME/work/cachegrind-baseline/cache_demo.out \
  ~/work/toolchain-smoke/cache_demo 2>&1 | tail -15
```

**Two non-obvious requirements:**
- `--cache-sim=yes` is **required** on Valgrind ≥ 3.22; without it cachegrind only counts `Ir` (instruction reads) and produces no D-cache miss data.
- Use `$HOME` (not `~`) inside `--cachegrind-out-file=...` — tilde expansion does not happen inside `=`-prefixed flag values.

Expected: a summary block with `D refs`, `D1 misses`, `LLd misses`, and miss-rate percentages.
The ability to override D1/LL parameters from the host's actual topology is exactly what makes cachegrind viable for AArch64-target work on x64 — record this command, it will be reused against `angle_perftests` selectively. Note that A72 has no L3, so `--LL` here models the A72 L2 (which is the last level on A72).

- [ ] **Step 4.5: Run perf stat on the demo to confirm hardware counters work**

```bash
perf stat -e cycles,instructions,cache-references,cache-misses \
  ~/work/toolchain-smoke/cache_demo 2>&1 | tail -10
```

Expected: a counter table with non-zero values for `cycles` and `instructions`.
If you see `<not supported>` for cache events, WSL2's pass-through of PMU events is incomplete on this host — `cycles` will still work and is what the autoresearch loop reads. Note this in the setup log.

- [ ] **Step 4.6: Document the architecture-portability decisions in the setup log**

Append a notes section so future engineers understand which tools were chosen and why.

```bash
cat >> /mnt/f/code2/struct_cache_opt/docs/setup-log.md <<'EOF'

## Tool selection — architecture compatibility (target: ARM Cortex-A72)

| Tool | Status on x64 dev host | Validity for AArch64 target |
|------|------------------------|------------------------------|
| pahole (dwarves) | OK | OK — operates on DWARF, source-level struct layout transfers identically |
| perf stat (cycles) | OK on WSL2 (PMU pass-through) | OK on Cortex-A72 (native PMU) — same metric definition |
| valgrind cachegrind | OK with --D1/--LL overrides set to Cortex-A72 cache geometry (32K/2-way/64B; 1M/16-way/64B) | OK — runs natively on AArch64 with the same overrides |
| Intel VTune | NOT installed | NOT applicable — EBS sampling requires Intel PMU; cannot collect cache-miss events on Cortex-A72 |
| Cache Explorer (LLVM-instrumented MESI sim) | NOT installed | Reportedly compatible per source brief, but install location was not provided; deferred until source URL is supplied |

## Smoke-test outputs

| Tool | Input | Result |
|------|-------|--------|
| pahole | struct_demo (synthetic struct with intentional padding) | reported 7-byte hole — OK |
| cachegrind | cache_demo (16 MiB stride-64 sweep) | LLd miss rate produced — OK |
| perf | cache_demo | cycles + instructions counters non-zero — OK |
EOF
```

---

## Task 5: Establish Baseline & Wire to Autoresearch

**Files:**
- Modify: `/mnt/f/code2/struct_cache_opt/autoresearch/autoresearch.yml`
- Modify: `/mnt/f/code2/struct_cache_opt/docs/setup-log.md` (append baseline metric)

The autoresearch loop runs `verifyCmd` and treats the last numeric token of stdout as the metric. Before turning the loop on, run `verifyCmd` manually to (a) confirm it produces a parseable number and (b) record the starting cycle count so progress is measurable.

- [ ] **Step 5.1: Inspect current autoresearch.yml and identify required edits**

Read `/mnt/f/code2/struct_cache_opt/autoresearch/autoresearch.yml` (already shown to be hard-coded for `remote: ssh -tt … sean@build-host` and `workdir: /home/sean/angle`).

For local execution on this WSL2 host, two fields must change:
- `remote:` → `""` (empty string per the README's "本地测试配置" section)
- `workdir:` → the actual ANGLE checkout path, which from Task 3.2 is `~/angle/angle` (note: `fetch angle` puts the source under `angle/` inside the directory you ran it from). Confirm with `ls ~/angle/angle/BUILD.gn`.

- [ ] **Step 5.2: Apply the two edits**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
# Replace remote with empty string, workdir with the local ANGLE path.
# Resolve $HOME explicitly because YAML doesn't expand env vars.
ANGLE_DIR="$HOME/angle/angle"
sed -i.bak \
  -e "s|^remote:.*$|remote:  \"\"|" \
  -e "s|^workdir:.*$|workdir: $ANGLE_DIR|" \
  autoresearch.yml
diff autoresearch.yml autoresearch.yml.bak
rm autoresearch.yml.bak
```

Expected: diff shows exactly two changed lines (`remote` and `workdir`); nothing else.

- [ ] **Step 5.3: Run guardCmd manually to confirm the build target compiles via the configured command**

```bash
cd ~/angle/angle
autoninja -C out/Release angle_perftests 2>&1 | tee build.log | tail -5
echo "exit: $?"
```

Expected: exit 0. Since Task 3.5 already produced `out/Release/angle_perftests`, this is incremental and should be near-instant.

- [ ] **Step 5.4: Run verifyCmd manually and capture the baseline metric**

```bash
cd ~/angle/angle
BASELINE=$(perf stat -e cpu-cycles ./out/Release/angle_perftests \
    --gtest_filter='*DrawQuad*' --iterations=100 2>&1 \
    | grep cpu-cycles | awk '{print $1}' | tr -d ',')
echo "baseline cpu-cycles: $BASELINE"
```

Expected: `BASELINE` is a non-empty integer (e.g. `42135678901`). If empty, perf produced no `cpu-cycles` line — check `perf stat -e cycles` works (some kernels report it as `cycles` not `cpu-cycles`). If the field name differs, that is a `verifyCmd` mismatch and must be reported back, not silently patched.

- [ ] **Step 5.5: Capture pahole output for the three scope files (the targets the loop will be modifying)**

```bash
cd ~/angle/angle
mkdir -p ~/work/pahole-baseline
for header in src/libANGLE/State.h src/libANGLE/Program.h src/libANGLE/Context.h; do
  obj=$(find out/Release/obj/src/libANGLE -name "$(basename ${header%.h}).o" | head -1)
  if [ -n "$obj" ]; then
    pahole "$obj" > ~/work/pahole-baseline/$(basename ${header%.h}).pahole.txt
    echo "wrote ~/work/pahole-baseline/$(basename ${header%.h}).pahole.txt ($(wc -l < ~/work/pahole-baseline/$(basename ${header%.h}).pahole.txt) lines)"
  else
    echo "WARN: no object file for $header"
  fi
done
```

Expected: three files exist with non-zero line counts. These are the layout snapshots an iteration will compare against to confirm a struct edit actually shrunk holes / re-grouped hot fields.

- [ ] **Step 5.6: Append baseline to setup log**

```bash
{
  echo ""
  echo "## Baseline (recorded $(date -Iseconds))"
  echo ""
  echo "- guardCmd: \`autoninja -C out/Release angle_perftests\` — OK"
  echo "- verifyCmd cpu-cycles for \`*DrawQuad*\` --iterations=100: **$BASELINE**"
  echo "- pahole snapshots: ~/work/pahole-baseline/{State,Program,Context}.pahole.txt"
} >> /mnt/f/code2/struct_cache_opt/docs/setup-log.md
```

- [ ] **Step 5.7: Commit the autoresearch.yml change inside the autoresearch repo**

The autoresearch directory is its own git repo; this is a real config edit to that codebase.

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
git status
git diff autoresearch.yml
git add autoresearch.yml
git commit -m "config: switch remote→local and pin workdir to local ANGLE checkout

Sets remote to empty (local execution per README) and workdir to the
absolute path of the ANGLE source produced by Task 3 of the toolchain
setup plan. Baseline cpu-cycles for the *DrawQuad* filter recorded in
docs/setup-log.md."
```

Expected: commit succeeds. If the autoresearch dir is *not* a git repo on this machine, skip the commit and instead note the change in `docs/setup-log.md`.

- [ ] **Step 5.8: Final verification — dry-run the autoresearch loop to confirm Stage 3 + Stage 4 work end-to-end**

```bash
cd /mnt/f/code2/struct_cache_opt/autoresearch
# Dry Run mode skips Stage 1 (LLM diff generation) so we exercise build + bench only.
# Refer to README "Dry Run 模式" — usually a flag in the dashboard or env var.
DRY_RUN=1 tsx src/index.ts autoresearch.yml 2>&1 | tee /tmp/autoresearch-dry.log &
LOOP_PID=$!
sleep 180   # allow one iteration: build (~minutes) + bench (~30s)
kill $LOOP_PID 2>/dev/null
grep -E "stage-3|stage-4|metric" /tmp/autoresearch-dry.log | tail -20
```

Expected: stage-3 (build) reports success, stage-4 (bench) reports a metric value within ~10% of the Step 5.4 baseline. If the loop never reaches stage-4, fix before declaring the toolchain setup complete.

If `DRY_RUN=1` is not the correct flag for this codebase, consult `src/loop.ts` to find how Dry Run is enabled — do not skip this verification step.

---

## Out of scope (follow-ups, not part of this plan)

- **Cache Explorer install** — add as a separate task once an install URL or source location is provided. The cachegrind-based workflow established in Task 4 covers the immediate cache-simulation need.
- **Cross-compiling ANGLE for AArch64** — this plan provisions the x64 *iteration* environment. A separate plan should cover Cortex-A72 cross-toolchain (clang `--target=aarch64-linux-gnu`, sysroot, qemu-aarch64-static) when we are ready to validate that locally-derived struct edits hold up on the real target.
- **GPU passthrough verification under WSLg** — if the smoke test in Step 1.4 selects a software renderer (e.g. `llvmpipe`) instead of the hardware GPU, Vulkan-backed `angle_perftests` runs may be slower than expected; track as a separate environment task if it appears.
