#!/usr/bin/env bash
# struct_cache_opt skill entry point.
#
# Invoked by autoresearch with:
#   stdin = (pahole report + git log + TSV tail), assembled by the loop
#   env   = AR_SCOPE (colon-sep paths), AR_WORKDIR, AR_GOAL, IDEATE_CLI
#
# Emits a unified diff on stdout. Exit non-zero on failure.

set -euo pipefail

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ideate_cli="${IDEATE_CLI:-claude -p}"

ctx="$(cat)"

# Slurp the in-scope source files. Empty AR_SCOPE → just send context, no source.
src_blob=""
if [ -n "${AR_SCOPE:-}" ] && [ -n "${AR_WORKDIR:-}" ]; then
  IFS=':' read -ra paths <<< "$AR_SCOPE"
  for rel in "${paths[@]}"; do
    abs="$AR_WORKDIR/$rel"
    if [ -f "$abs" ]; then
      src_blob+=$'\n=== '"$rel"$' ===\n'
      src_blob+="$(cat "$abs")"
    fi
  done
fi

prompt_tmpl="$(cat "$skill_dir/lib/prompt.tmpl")"

prompt="$prompt_tmpl

# Goal
${AR_GOAL:-(unspecified)}

# Scope
${AR_SCOPE:-(unspecified)}

# Context (pahole + git log + TSV tail)
$ctx

# Source files
$src_blob
"

# Hand prompt to the configured CLI tool. The CLI is expected to emit a unified
# diff on stdout. We don't postprocess — if the CLI adds commentary, the operator
# is responsible for wrapping it (see SKILL.md "Customizing the LLM").
exec $ideate_cli "$prompt"
