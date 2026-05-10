# Toolchain Setup Log

| Component | Version | Installed at | Smoke test |
|-----------|---------|--------------|------------|
| build-essential | 13 | 2026-05-09T14:42:42+00:00 | gcc --version OK |
| cmake          | 3.28.3 | 2026-05-09T14:42:42+00:00 | --version OK |
| ninja          | 1.11.1 | 2026-05-09T14:42:42+00:00 | --version OK |
| pahole         | v1.25 | 2026-05-09T14:42:42+00:00 | --version OK |
| perf           | perf version 6.8.12 | 2026-05-09T14:42:42+00:00 | --version OK |
| valgrind       | valgrind-3.22.0 | 2026-05-09T14:42:42+00:00 | --version OK |
| display-path   | WSLg | 2026-05-09T14:42:42+00:00 | glxinfo+vulkaninfo OK |
| git            | 2.43.0 | 2026-05-09T14:48:32+00:00 | --version OK |
| python3        | 3.12.3 | 2026-05-09T14:48:32+00:00 | --version OK |
| python3-pip    | 24.0 | 2026-05-09T14:48:32+00:00 | --version OK |
| pkg-config     | 1.8.1 | 2026-05-09T14:48:32+00:00 | --version OK |
| GL/EGL/Vulkan dev headers | mesa libgl1-mesa-dev=25.2.8-0ubuntu0.24.04.1, libvulkan-dev=1.3.275.0-1build1 | 2026-05-09T14:48:32+00:00 | dpkg installed |
| gfxbench       | 89aa956f | 2026-05-09T15:09:46+00:00 | gl_alu smoke-test OK (llvmpipe, FPS 478.38, score 14351, status OK) |
| nvidia-cuda-dev | 12.0.146~12.0.1-4build4 | 2026-05-09T15:09:46+00:00 | headers only, no driver — required by GFXBench cudaw |
| libglu1-mesa-dev / xorg-dev / bison / swig | (Task 2 build deps) | 2026-05-09T15:09:46+00:00 | dpkg installed |

## Notes (added 2026-05-09T14:48:32+00:00)

- **Graphics renderer:** OpenGL renderer string: llvmpipe (LLVM 20.1.2, 256 bits)
- **Vulkan device:** deviceName         = llvmpipe (LLVM 20.1.2, 256 bits)
- **Acceleration:** software (llvmpipe / CPU) — WSLg without GPU passthrough on this host. Acceptable for Task 5's CPU-cycle measurements (the autoresearch metric is `cpu-cycles` in `angle_perftests` state-tracker code, which is backend-agnostic), but GPU-side benchmark numbers from GFXBench (Task 2) will reflect llvmpipe rasterization, not real GPU performance.
- **Host kernel:** 6.6.114.1-microsoft-standard-WSL2
- **Distro:** Ubuntu 24.04.4 LTS
- **Home filesystem:** 937G free of 1007G on /  (ANGLE checkout in Task 3 needs ~30–50 GB free)
- **perf symlink staleness:** `/usr/local/bin/perf` points at `/usr/lib/linux-tools/6.8.0-111-generic/perf`. After any `apt upgrade` of `linux-tools-generic` the target may disappear and perf will start failing with "No such file or directory". Re-link with: `sudo ln -sf /usr/lib/linux-tools/*/perf /usr/local/bin/perf`
- **GFXBench `cudaw` dependency:** the build links against a `cudaw` framework that hard-includes `<cuda.h>`. On bare Ubuntu this requires `sudo apt install nvidia-cuda-dev` (~2.4 GB installed; pulls CUDA 12.0 runtime libs but no kernel driver). Without it the build fails compiling `frameworks/cudaw/cudaw.cpp`. The cudaw lib is loaded lazily at runtime, so a GPU is not required to *run* the smoke test.
- **GFXBench Linux build deps beyond Task 1:** `libglu1-mesa-dev`, `xorg-dev`, `bison`, `swig` (in addition to `nvidia-cuda-dev`). Total install footprint ≈ 2.5 GB.
- **Python shim:** `~/work/binshim/python` is a symlink to `/usr/bin/python3`. Required because libepoxy's CMake hardcodes `python` (not `python3`). Prepend `~/work/binshim` to `PATH` for any future GFXBench rebuilds.
- **GFXBench bulky data dirs:** `~/work/gfxbench/{gfxbench-data40,gfxbench-data50,tfw-pkg,app_ios}` total ≈ 8 GB. Not used by the autoresearch loop; safe to delete if disk gets tight (re-fetchable via `git checkout` of the same SHA).
- **`perf` event-name on this host:** `perf stat -e cycles` works; `perf stat -e cpu-cycles` is also accepted (perf treats them as aliases on Linux 6.x). The autoresearch `verifyCmd` greps for the literal string `cpu-cycles` in `perf stat`'s output — verify in Task 5 that perf prints `cpu-cycles` (not `cycles`) for the `-e cpu-cycles` form on this version. If it prints `cycles`, the awk-based metric extraction in `autoresearch.yml` will silently produce empty output.
- **Cachegrind runtime overhead:** ≈50× slowdown vs native execution. For `angle_perftests` runs under cachegrind, reduce `--iterations` from the 100 used in the baseline to 5–10 (representative ratios are stable; absolute numbers don't matter for cache-locality work).

## Tool selection — architecture compatibility (target: ARM Cortex-A72)

| Tool | Status on x64 dev host | Validity for AArch64 target |
|------|------------------------|------------------------------|
| pahole (dwarves) | OK | OK — operates on DWARF, source-level struct layout transfers identically |
| perf stat (cycles) | OK on WSL2 (PMU pass-through, all four counters incl. cache-references/cache-misses report non-zero values on this host) | OK on Cortex-A72 (native PMU) — same metric definition |
| valgrind cachegrind | OK with `--cache-sim=yes --D1/--LL` overrides set to Cortex-A72 cache geometry (32K/2-way/64B; 1M/16-way/64B). NOTE: Valgrind 3.22 disables cache simulation by default — `--cache-sim=yes` is REQUIRED, otherwise only `Ir` (instruction reads) are recorded and D-cache miss data is absent. | OK — runs natively on AArch64 with the same overrides |
| Intel VTune | NOT installed | NOT applicable — EBS sampling requires Intel PMU; cannot collect cache-miss events on Cortex-A72 |
| Cache Explorer (LLVM-instrumented MESI sim) | NOT installed | Reportedly compatible per source brief, but install location was not provided; deferred until source URL is supplied |

### Reusable cachegrind invocation (Cortex-A72 cache geometry, x64 host)

```
valgrind --tool=cachegrind --cache-sim=yes \
  --D1=32768,2,64 --LL=1048576,16,64 \
  --cachegrind-out-file=$HOME/work/cachegrind-baseline/<name>.out \
  <binary>
```

Use `$HOME` (not `~`) inside `--cachegrind-out-file=...` — tilde expansion does not happen inside `=`-prefixed flag values. Valgrind 3.22 also auto-detects the host's L3 ("warning: L3 cache found, using its data for the LL simulation") — the `--LL` override suppresses that.

## Smoke-test outputs (2026-05-09, x64 WSL2 host)

| Tool | Input | Result |
|------|-------|--------|
| pahole v1.25 | `struct_demo` (uint8_t a; uint64_t b; uint32_t c; uint8_t d) | reported 7-byte hole between members `a` and `b`; total size 24 / sum members 14 / padding 3 — OK, matches expected x86_64 layout |
| valgrind 3.22 cachegrind (`--cache-sim=yes`, A72 geometry) | `cache_demo` (16 MiB stride-64 sweep, -O2) | I refs 18,248,159 / D refs 17,087,730 (298,453 rd + 16,789,277 wr) / D1 misses 526,061 / D1 miss rate 3.1% / LLd misses 525,765 / LLd miss rate 3.1% / LL miss rate 1.5% — OK |
| perf stat (cycles, instructions, cache-references, cache-misses) | `cache_demo` | cycles:u 10,256,936 / instructions:u 2,373,884 (0.23 IPC) / cache-references:u 764,696 / cache-misses:u 55,312 (7.23% of refs) — OK, all four counters non-zero (full PMU pass-through working on this WSL2 host, no `<not supported>` entries) |

