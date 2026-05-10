---
name: struct_cache_opt
description: Use when optimizing C/C++ struct memory layout for cache efficiency — reorders fields to minimize padding, cluster hot fields onto fewer cache lines, or align hot/cold splits. Driven by pahole DWARF layout reports and source-level rewriting. Invoked by autoresearch as `${skillDir}/run.sh`; reads context (pahole report + git log + TSV history + scope source) on stdin and emits a unified diff on stdout.
---

# struct_cache_opt

## Overview

Reorganize C/C++ class/struct layouts to improve cache behavior. The skill receives:

- **pahole layout report** for the target type(s), prepared by autoresearch's `contextCmds`. Includes current field offsets, holes (padding), and pahole's `--reorganize` suggestion.
- **git log** of recent experiments (which layouts were tried, which won/lost).
- **results.tsv tail** (autoresearch's iteration history with metric per iteration).
- **Source files** in scope (read from `$AR_SCOPE`, paths relative to `$AR_WORKDIR`).
- **Goal** in `$AR_GOAL` (e.g. "maximize gl_5_normal fps via vk::ImageHelper layout").

It emits a **unified diff** on stdout — applied by autoresearch's Stage 2.

## Inputs (env + stdin)

| Channel | Content |
|---|---|
| `$AR_SCOPE` | Colon-separated paths in scope (relative to `$AR_WORKDIR`). |
| `$AR_WORKDIR` | Absolute path to the target git worktree. |
| `$AR_GOAL` | Free-text goal string from autoresearch.yml. |
| `$IDEATE_CLI` | The CLI tool to call (default: `claude -p`). User-overridable. Examples: `claude -p`, `gh copilot suggest -t shell`, `python3 my-llm-wrapper.py`. |
| stdin | Heredoc: pahole report + `---` + git log + `---` + TSV tail. |

## Output

A unified diff on stdout (or empty stdout if no change is suggested). Exit 0 = success, non-zero = ideate-fail.

## Strategy guidance for the LLM (encoded in `lib/prompt.tmpl`)

1. **Read the pahole report first.** The current `ImageHelper` layout shows holes (padding). The `--reorganize` suggestion is a strong baseline.
2. **Cross-reference with usage.** From the source, identify which fields are touched in hot paths (rendering, draw-call dispatch). Cluster those onto the same 64-byte cache line.
3. **Don't break invariants.** Constructor initialization order, member alignment requirements (atomics, vk handles), and ABI-sensitive layouts must be preserved if any external code relies on them.
4. **Avoid trivial reverts.** If the git log shows a layout was tried and reverted (status=discard), don't propose the same layout again. Look at TSV for which directions actually moved the metric.
5. **Output a minimal diff.** Touch only files in `$AR_SCOPE`. No formatting churn, no unrelated edits.

## Files

- `run.sh` — entry point invoked by autoresearch.
- `lib/pahole-image-helper.sh` — helper that emits the pahole layout report. Listed in `autoresearch.yml`'s `contextCmds:` so the loop runs it before each iteration and pipes the output into the skill's stdin.
- `lib/prompt.tmpl` — the prompt body sent to `$IDEATE_CLI`. Edit this to tune the optimization strategy.

## Customizing the LLM

The skill defaults to `claude -p` for the unified-diff generation. To use a different CLI:

```bash
export IDEATE_CLI='gh copilot suggest -t shell'   # or any tool that takes a prompt and emits text
```

The CLI must:
- Accept a prompt as a single argument or via stdin.
- Emit a unified diff (and only the diff, no commentary) on stdout.
- Exit 0 on success.

If your CLI emits commentary alongside the diff, wrap it: have your wrapper grep out the `diff --git` block.
