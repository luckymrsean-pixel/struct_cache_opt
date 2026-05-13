# struct_cache_opt pipeline upgrade — design

> Status: draft (pending user review)
> Author: brainstormed with Claude 2026-05-13
> Targets: `/mnt/f/code2/target_skill/` (the LLM-driven ideate skill consumed by autoresearch)

## 1. Goal

Replace the current single-skill `struct_cache_opt` (one bash helper + thin prompt) with a two-skill pipeline that gives the ideating LLM substantially richer, pre-digested input:

- **`pahole_extractor`** — pure pahole data extraction over a configurable `target_lib`. No opinions, no LLM. Emits raw layouts, a struct index, and a per-lib markdown overview.
- **`struct_layout_opt`** — opinionated optimizer. Fuses pahole output with user-authored cold-field hints and member-correlation hints, feeds a curated context to the LLM, parses a strict output protocol, and maintains a persistent per-struct status worklist.

The autoresearch loop (`vk-image-helper.yml`) continues to drive iterations; only the `skillDir` pointer changes.

## 2. Why two skills

`pahole_extractor` is reusable — invokable from a terminal for inspection, or by other future skills doing layout work. `struct_layout_opt` carries the cache-opt strategy. Separation also makes failures localizable: extractor breakage looks like missing artifacts; ideation breakage looks like bad diffs.

## 3. Directory layout

```
/mnt/f/code2/target_skill/
├── pahole_extractor/                # NEW skill
│   ├── SKILL.md
│   ├── run.sh                       # entry point
│   ├── lib/
│   │   └── pahole_extract.py        # main extractor
│   └── state/<target_lib>/          # outputs (overwritten each run)
│       ├── pahole_raw.txt
│       ├── struct_index.tsv
│       └── target_lib.md
│
├── struct_layout_opt/               # NEW skill (replaces struct_cache_opt)
│   ├── SKILL.md
│   ├── run.sh                       # orchestrator — autoresearch invokes this
│   ├── lib/
│   │   ├── fuse_context.py
│   │   └── parse_output.py
│   ├── prompt.tmpl                  # rewritten prompt body
│   ├── inputs/                      # user-authored knowledge, ships with demos
│   │   ├── rules.MD
│   │   ├── cold_path.MD
│   │   └── correlation.MD
│   └── state/<target_lib>/
│       ├── fused_index.md           # per-iter
│       └── empty_struct_index.tsv   # persistent across iters
│
└── struct_cache_opt/                # DELETED in same commit that adds the above
```

In the autoresearch repo, `vk-image-helper.yml` updates:

```yaml
skillDir: /mnt/f/code2/target_skill/struct_layout_opt
```

## 4. Per-iteration data flow

```
[ANGLE workdir]                            [user-authored inputs]
        │                                  inputs/cold_path.MD
        │                                  inputs/correlation.MD
        ▼                                  inputs/rules.MD
[pahole_extractor/run.sh]                          │
        │  builds debug .o, runs pahole            │
        ▼                                          │
[pahole_extractor/state/vk_helpers/]               │
   pahole_raw.txt                                  │
   struct_index.tsv                                │
   target_lib.md                                   │
        │                                          │
        └──────────────────┬───────────────────────┘
                           ▼
              [struct_layout_opt/lib/fuse_context.py]
                           │
                           ▼
            [struct_layout_opt/state/vk_helpers/]
                  fused_index.md           ┌── empty_struct_index.tsv (read prior status)
                           │               │
                           ▼               │
                  [prompt.tmpl assembly] ◄─┘
                           │
                           ▼
                      $IDEATE_CLI
                           │
                           ▼
                   [parse_output.py]
                   ├── STATUS line ──► append to empty_struct_index.tsv
                   └── diff body ────► stdout to autoresearch Stage 2
```

## 5. Component contracts

### 5.1 `pahole_extractor/run.sh`

- **Env in:** `AR_WORKDIR` (required), `AR_TARGET_LIB` (default `vk_helpers`), `AR_DEPOT_TOOLS`, `AR_DEBUG_OUT` (default `out/Debug-pahole`).
- **Behavior:** delegates to `lib/pahole_extract.py`. Resolves the TU(s) for `target_lib` (initially hardcoded mapping: `vk_helpers → src/libANGLE/renderer/vulkan/vk_helpers.cc`), one-time bootstraps debug build dir, builds the .o(s), then runs `pahole --show_private_classes -I` over every type defined in the TU.
- **Out:** writes three files under `pahole_extractor/state/<target_lib>/`. Exits 0 on success; non-zero with a one-line stderr explanation on failure.

### 5.2 `pahole_extractor/lib/pahole_extract.py`

Pure Python (3.8+; stdlib only). Responsibilities:

1. Ensure the debug `.o` exists (shell out to `gn gen` + `autoninja` as needed; reuses the bash logic that's there today).
2. Enumerate all types in the `.o`: `pahole --show_private_classes -I <obj>` lists every type with `/* <file>:<line> */` decl-info. Parse this once.
3. For each type, capture `pahole -C <fqname> <obj>` (raw layout) and `pahole --reorganize -C <fqname> <obj>` (suggestion). Concatenate into `pahole_raw.txt`.
4. Parse layout output into structured rows for `struct_index.tsv` and aggregate stats for `target_lib.md`.

Module split inside the file: `class PaholeRunner`, `class LayoutParser`, `class IndexWriter`. ~250 LOC target.

### 5.3 `struct_layout_opt/run.sh`

Bash, ~80 LOC. Pipeline:

1. `bash ../pahole_extractor/run.sh` (inherits all `AR_*` env).
2. `python3 lib/fuse_context.py --target-lib "$AR_TARGET_LIB" --iter "$AR_ITER"`.
3. Build the prompt string: concat `prompt.tmpl` + `inputs/rules.MD` + `inputs/cold_path.MD` + `inputs/correlation.MD` + `state/<lib>/fused_index.md` + the autoresearch stdin (git log + tsv tail).
4. Pipe prompt to `$IDEATE_CLI`, pipe its stdout through `python3 lib/parse_output.py --target-lib "$AR_TARGET_LIB" --iter "$AR_ITER"`.
5. `parse_output.py` appends to `empty_struct_index.tsv` and writes the diff body to its own stdout (which is the skill's stdout — what autoresearch reads).

`AR_ITER` is exposed by autoresearch via env; if absent (manual runs), default `0`.

### 5.4 `struct_layout_opt/lib/fuse_context.py`

Pure Python stdlib. Inputs:

- `pahole_extractor/state/<lib>/struct_index.tsv`
- `pahole_extractor/state/<lib>/pahole_raw.txt`
- `inputs/cold_path.MD`
- `inputs/correlation.MD`
- `state/<lib>/empty_struct_index.tsv` (may not exist on first run; treat as empty)

Logic:

1. Parse pahole layouts into per-struct field records (offset, type, name, size).
2. Parse `cold_path.MD` into category → list of name patterns (literal substrings or `~/regex/`). Per field name, run all patterns case-insensitively; record the first matching category as `cold_tag`.
3. Parse `correlation.MD` into ordered list of groups (group_id, occurrence, members). Per field, list every group it belongs to with rank.
4. For each struct, emit a markdown section into `fused_index.md` per the schema in §6.4.
5. Include "prior status" line summarizing the struct's history from `empty_struct_index.tsv`.

### 5.5 `struct_layout_opt/lib/parse_output.py`

Pure Python stdlib. Reads LLM stdout, expects line 1 to match:

```
^STRUCT:\s+(\S+)\s+STATUS:\s+(update|cannot_update)(?:\s+REASON:\s+(.+))?$
```

Behavior:

- On match: append `<fqname>\t<iter>\t<status>\t<reason>` (tab-separated; reason may be empty) to `state/<lib>/empty_struct_index.tsv`. Create the file with a header row if it doesn't exist.
- If `status=update`: write remaining lines (must begin with `diff --git`) to stdout. Strip markdown fences and any prose before the first `diff --git` line (same defensiveness as today's `sed -n '/^diff --git/,$p'`).
- If `status=cannot_update`: write nothing to stdout. Exit 0. (Autoresearch's Stage 1 treats empty stdout as "ideate-fail" → tsv records `discard / ideate-fail`. That's fine — next iter the LLM sees the new index row and picks something else.)
- If header line missing/malformed: log to stderr, write nothing to stdout, exit 0 (still treated as ideate-fail; do NOT crash the loop).

### 5.6 Inputs

- **`inputs/rules.MD`** — static, ships in repo. Renders the 7 rules with the three basics flagged. Includes the cached vs uncached prioritization branch as a conditional. Demo body in §6.6 below.
- **`inputs/cold_path.MD`** — demo with the categories from the existing prompt.tmpl (debug, init/destruction, format helpers, rare/config). User edits to match their access-pattern knowledge.
- **`inputs/correlation.MD`** — demo with 3 plausible groups based on the existing prompt's hot-field bullets. User edits when they have real perf-derived clusters.

## 6. Artifact formats

### 6.1 `struct_index.tsv` (extractor output)

Header row, tab-separated:
```
fqname	file	line	size	holes	hole_bytes	member_count
rx::vk::ImageHelper	src/libANGLE/renderer/vulkan/vk_helpers.h	2218	2384	17	102	178
rx::vk::BufferHelper	src/libANGLE/renderer/vulkan/vk_helpers.h	1845	320	5	24	42
```

- `fqname`: fully qualified C++ name as pahole prints.
- `file`,`line`: from `--show_private_classes -I` decl-info comment. Workdir-relative if pahole prints absolute paths.
- `size`, `holes`, `hole_bytes`, `member_count`: from pahole's `/* size: N, cachelines: ..., members: N */` footer and hole comments.

### 6.2 `target_lib.md` (extractor output)

```markdown
# target_lib: vk_helpers

- Generated: 2026-05-13T12:34:56Z
- TUs scanned: src/libANGLE/renderer/vulkan/vk_helpers.cc
- Object files: out/Debug-pahole/obj/.../vk_helpers.o
- Total structs: 47

## Top 10 by size

| fqname | size | holes | hole_bytes |
|---|---|---|---|
| rx::vk::ImageHelper | 2384 | 17 | 102 |
| ... |

## Top 10 by hole_bytes

| fqname | hole_bytes | size | density |
|---|---|---|---|
| rx::vk::FooHelper | 64 | 192 | 33% |
| ... |
```

### 6.3 `pahole_raw.txt` (extractor output)

Concatenated raw pahole output, struct-delimited:
```
=== rx::vk::ImageHelper ===
<pahole -C output>

=== --reorganize: rx::vk::ImageHelper ===
<pahole --reorganize output>

=== rx::vk::BufferHelper ===
...
```

### 6.4 `fused_index.md` (struct_layout_opt output)

One markdown section per struct, in size-descending order:

```markdown
## rx::vk::ImageHelper   [vk_helpers.h:2218]

- size: 2384 B • holes: 17 (102 B padding)
- pahole --reorganize: 2384 → 2296 B (-88, 0 new holes)
- prior status: iter 1=update, iter 3=update

### Fields (47 total)

| offset | type | name | size | cold? | groups (rank) |
|--------|------|------|------|-------|---------------|
| 0  | uint32_t      | mLabel                   | 4 | yes (debug)   | — |
| 4  | VkImage       | mImage                   | 8 | no            | G1 (8741) |
| 12 | VkImageLayout | mCurrentLayout           | 4 | no            | G1 (8741), G2 (5230) |
| ... |

### Top correlation clusters touching this struct
- G1 (8741): mCurrentLayout, mCurrentQueueFamilyIndex, mImage, mUsage
- G2 (5230): mLayerCount, mLevelCount, mFirstLayer, mBaseLevel, mCurrentLayout
```

### 6.5 `empty_struct_index.tsv` (struct_layout_opt state, persistent)

Append-only:
```
fqname	iter	status	reason
rx::vk::ImageHelper	1	update	
rx::vk::BufferHelper	2	cannot_update	already optimal; --reorganize delta <1B
rx::vk::ImageHelper	3	update	
```

### 6.6 `inputs/rules.MD` (demo content)

```markdown
# Struct cache-layout rules

Apply these in order. The first three are mandatory; the rest are
context-dependent.

## Mandatory (the basics)

1. **Hot fields first, contiguous.** Members accessed in tight loops live at
   the top of the struct.
2. **Within the hot group, sort by alignment descending.** 8-byte aligned
   first (uint64_t, pointers, double), then 4-byte (uint32_t, float), then
   2-byte, then 1-byte. Minimizes padding holes.
3. **Cold fields at the bottom; shrink them in place.** Cold = fields listed
   (fuzzy-matched) in `cold_path.MD`. Common shrinks: uint64_t timestamp →
   uint32_t delta; multiple bools → packed uint32_t flags; rare enum →
   uint8_t.

## Conditional (use when warranted)

4. Keep hot fields within one 64-byte cache line when possible. Don't force
   packing — false sharing hurts.
5. Pack high-Occurrence correlation groups (from `correlation.MD`) tightly.
   Same-group members should sit within one cache line.
6. Nested "section" struct for readability — still one outer struct; helps
   when the hot region has its own internal sub-grouping.
7. Cache-line partitioning (align(64) the struct + pad before cold region)
   only if hot/cold contention is measured; otherwise it wastes memory.

## Anti-tactics — don't do these

- No `__attribute__((aligned(64)))` on the whole class.
- No `#pragma pack(1)`.
- No renames. Layout-only changes.

## Cached vs uncached prioritization

- If the workload is mostly **cached** (working set fits in LLC/L2/L1):
  prioritize rules 1–4. Hot contiguity matters more than overall size.
- If the workload is mostly **uncached / bandwidth-bound**: prioritize
  rules 1, 3, and overall size reduction. Avoid cache-line partitioning
  padding — it grows footprint.
```

### 6.7 `inputs/cold_path.MD` (demo content)

```markdown
# cold_path.MD — fuzzy hints for cold members

`fuse_context.py` matches each field name against the patterns below,
case-insensitively. Patterns are literal substrings unless prefixed with
`~/.../` (regex). The first matching category becomes the field's cold_tag.

## debug
- mLabel
- mDebugLabel
- ~/.*[Dd]ebug.*/
- ~/.*[Ll]og.*/

## init-destruction
- mInitial
- mAllocationFlags
- mOwner
- mAllocator
- mMemoryAllocationType

## format-helper
- mFormatFeatures
- mViewFormats
- ~/.*[Ff]ormatHelp.*/

## rare-config
- mYcbcrConversionDesc
- mTilingMode
- mExternalFormat
```

### 6.8 `inputs/correlation.MD` (demo content)

```markdown
# correlation.MD — member co-occurrence groups

Higher Occurrence = stronger relationship. Goal: pack same-group members
into one 64-byte cache line.

## Group 1: Layout transition   Occurrence: 8741
- mCurrentLayout
- mCurrentQueueFamilyIndex
- mImage
- mUsage

## Group 2: Sub-resource barrier   Occurrence: 5230
- mLayerCount
- mLevelCount
- mFirstLayer
- mBaseLevel
- mCurrentLayout

## Group 3: Format / dimension query   Occurrence: 3104
- mFormat
- mExtents
- mSamples
- mImageType
```

## 7. LLM output protocol

The prompt enforces this strict format:

**Update case** (line 1 + diff):
```
STRUCT: rx::vk::ImageHelper STATUS: update
diff --git a/src/libANGLE/renderer/vulkan/vk_helpers.h b/...
...
```

**Skip case** (line 1 only, no diff body):
```
STRUCT: rx::vk::BufferHelper STATUS: cannot_update REASON: --reorganize delta <1B
```

`parse_output.py` is the single point that interprets this protocol. It is defensive: malformed input → empty stdout + stderr log, never crashes the autoresearch loop.

## 8. State & persistence

- `pahole_extractor/state/<lib>/` is **regenerated every run**. Safe to delete.
- `struct_layout_opt/state/<lib>/fused_index.md` is **regenerated every run**.
- `struct_layout_opt/state/<lib>/empty_struct_index.tsv` is **append-only across runs**, surviving the lifetime of the project. Holds the AI's per-struct progress so the user (or AI) can audit coverage every ~100 structs.

The state dir is **not** inside the ANGLE worktree — it's inside the skill repo. It does not get touched by `git apply`, so the LLM's diff scope guard remains accurate.

## 9. Testing strategy

Per-component fixtures so each piece is independently verifiable.

| Component | Test approach |
|---|---|
| `pahole_extract.py` | Fixture: a tiny `.o` checked into the repo with 2–3 dummy structs. Assert `struct_index.tsv` rows + `target_lib.md` aggregates. |
| `fuse_context.py` | Fixture: hand-written `pahole_raw.txt` + `struct_index.tsv` + minimal cold/correlation files. Assert `fused_index.md` content character-equal to a golden file. |
| `parse_output.py` | Unit tests on each branch (update with diff / cannot_update / malformed / missing header). Assert tsv append and stdout. |
| End-to-end | Mock `$IDEATE_CLI=cat` (echoes stdin to stdout) to test the orchestration without LLM cost. Verify a smoke prompt flows through to a parsed result. |

## 10. Migration

Single commit on a feature branch:

1. Create `pahole_extractor/` and `struct_layout_opt/` directory trees with new code, tests, demo input files.
2. Delete `struct_cache_opt/` (its content is now obsolete; bash helper replaced, prompt rewritten, etc.).
3. Update `/mnt/f/code2/struct_cache_opt/vk-image-helper.yml`: `skillDir` → `struct_layout_opt`. Add a comment noting the rename.

Operator action required after merge: stop and restart the autoresearch loop (yml is read at process start, not per-iter).

## 11. Risks & known caveats

- **First-iter `target_lib.md` is slow.** Debug `.o` build for vk_helpers.cc is ~30–90s on first run. Same as today. Subsequent runs near-instant (ninja cache).
- **LLM disobeys the STATUS protocol.** Mitigation: prompt explicitly states the rule in three places (start, middle, example). `parse_output.py` is defensive — malformed output yields empty diff, not a crash.
- **`cold_path.MD` fuzzy match may misclassify.** Each fused_index row shows the cold_tag in plain text so the LLM (and humans) can see and override.
- **Correlation file requires manual curation.** No tooling generates it. The demo lets the system work end-to-end with a plausible starting point; you replace it as access-pattern data becomes available.
- **Two-skill split adds one process per iter.** Negligible — extractor takes <2s when cached; the LLM call dominates wall time.

## 12. Out of scope

- Auto-deriving cold_path.MD from grep/static analysis.
- Auto-deriving correlation.MD from perf-record + addr2line.
- Expanding `target_lib` beyond `vk_helpers` (the framework allows it; we add the mapping when needed).
- Changing the metric (still `cache-misses` lower=better).
