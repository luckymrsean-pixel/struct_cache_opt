#!/usr/bin/env bash
# pahole-image-helper.sh — emit a layout report for vk::ImageHelper to stdout.
#
# Listed in autoresearch.yml's contextCmds: the loop runs this once per
# iteration and concatenates the stdout into the LLM heredoc context.
#
# Strategy: build a single debug `.o` for vk_helpers.cc (one TU, fast after
# first build via ninja's caching), then pahole it. We do NOT modify the
# Release build — the loop's guardCmd still builds Release for the benchmark.
#
# Required env (set by the autoresearch loop):
#   AR_WORKDIR — absolute path to the ANGLE worktree (contains src/, out/, ...)
#
# Configurable env (override in autoresearch.yml `env:` or shell):
#   AR_DEBUG_OUT      — debug build dir (default: out/Debug-pahole)
#   AR_PAHOLE_TYPE    — fully-qualified type name to inspect (default: rx::vk::ImageHelper)
#   AR_PAHOLE_TU      — translation unit relative to workdir (default: src/libANGLE/renderer/vulkan/vk_helpers.cc)
#   AR_DEPOT_TOOLS    — depot_tools path (default: $HOME/depot_tools)

set -euo pipefail

workdir="${AR_WORKDIR:?AR_WORKDIR not set}"
debug_out="${AR_DEBUG_OUT:-out/Debug-pahole}"
target_type="${AR_PAHOLE_TYPE:-rx::vk::ImageHelper}"
tu_rel="${AR_PAHOLE_TU:-src/libANGLE/renderer/vulkan/vk_helpers.cc}"
depot="${AR_DEPOT_TOOLS:-$HOME/depot_tools}"

cd "$workdir"

# 1. One-time bootstrap of the debug build dir (idempotent — gn gen is cheap if args.gn unchanged).
if [ ! -f "$debug_out/args.gn" ]; then
  mkdir -p "$debug_out"
  cat > "$debug_out/args.gn" <<'GNARGS'
is_debug = true
symbol_level = 2
angle_assert_always_on = false
GNARGS
  PATH="$depot:$PATH" DEPOT_TOOLS_UPDATE=0 gn gen "$debug_out" >/dev/null
fi

# 2. Translate TU to ninja's object path. ANGLE follows: obj/<dir>/<tgt>.<basename>.o
# We don't try to predict which target; ninja can build by source path:
#   autoninja -C out/Debug-pahole -t targets all | grep <tu>
# Faster: just ask ninja for the .o by its source.
obj_rel=$(PATH="$depot:$PATH" DEPOT_TOOLS_UPDATE=0 ninja -C "$debug_out" -t query "$tu_rel" 2>/dev/null \
  | awk '/^  outputs:$/{flag=1; next} flag && /\.o$/ {print $1; exit}' || true)

if [ -z "$obj_rel" ]; then
  # Fallback: pick the first matching .o under obj/. Coarse but usually right.
  obj_rel=$(find "$debug_out/obj" -name "$(basename "$tu_rel" .cc).o" 2>/dev/null | head -1)
  obj_rel="${obj_rel#$debug_out/}"
fi

if [ -z "$obj_rel" ]; then
  echo "# pahole-image-helper: could not resolve .o path for $tu_rel" >&2
  exit 0
fi

# 3. Build that single .o. First run is slow (~30-90s), subsequent runs are
# near-instant if nothing in scope changed.
PATH="$depot:$PATH" DEPOT_TOOLS_UPDATE=0 \
  autoninja -C "$debug_out" "$obj_rel" >&2

obj_abs="$debug_out/$obj_rel"

# 4. Emit the layout report on stdout. The skill's prompt expects this header.
echo "=== pahole layout: $target_type ==="
pahole -C "$target_type" "$obj_abs" 2>/dev/null || {
  echo "# pahole could not find type $target_type in $obj_abs" >&2
  exit 0
}

echo
echo "=== pahole --reorganize suggestion: $target_type ==="
pahole --reorganize -C "$target_type" "$obj_abs" 2>/dev/null || true
