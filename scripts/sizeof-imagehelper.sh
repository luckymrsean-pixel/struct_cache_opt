#!/usr/bin/env bash
# sizeof-imagehelper.sh — emit sizeof(rx::vk::ImageHelper) in bytes on stdout.
#
# Strategy: borrow ANGLE's actual clang invocation for vk_helpers.cpp (via
# `ninja -t commands`), replace `-c` with `-Xclang -fdump-record-layouts
# -fsyntax-only`, strip `-o <out>`, run it, and grep the layout dump for
# the ImageHelper class.
#
# Why not pahole/DWARF: pahole 1.25 + 1.31 both bail on ANGLE's heavy
# template_value_parameter usage; llvm-dwarfdump can't find the class
# definition even with -fstandalone-debug (probably eliminated by some
# Chromium-specific debug-info pruning that we haven't pinned down).
# `-fdump-record-layouts` works directly from the AST and side-steps DWARF.
#
# Output: a single integer (size in bytes), nothing else.
# Exit non-zero on any failure.

set -euo pipefail

workdir="${AR_WORKDIR:-/home/fxy/angle}"
debug_out="${AR_DEBUG_OUT:-out/Debug-pahole}"
obj_rel="${AR_OBJ_REL:-obj/src/libANGLE/renderer/vulkan/angle_vulkan_backend/vk_helpers.o}"
target_type="${AR_PROBE_TYPE:-rx::vk::ImageHelper}"
depot="${AR_DEPOT_TOOLS:-$HOME/depot_tools}"

cd "$workdir"

# Bootstrap debug build dir on first run.
if [ ! -f "$debug_out/args.gn" ]; then
  mkdir -p "$debug_out"
  cat > "$debug_out/args.gn" <<'GNARGS'
is_debug = true
symbol_level = 2
angle_assert_always_on = false
use_debug_fission = false
GNARGS
  PATH="$depot:$PATH" DEPOT_TOOLS_UPDATE=0 gn gen "$debug_out" >&2
fi

# Pull the live clang command for our target .o.
cmd=$(PATH="$depot:$PATH" ninja -C "$debug_out" -t commands "$obj_rel" 2>/dev/null | grep -E '\bclang(\+\+)? ' | tail -1)
if [ -z "$cmd" ]; then
  echo "no clang command for $obj_rel" >&2
  exit 2
fi

# Rewrite for layout-dump mode: drop -c (we're not producing an .o), drop
# -o <file>, append the dump flags. Keep all includes/defines so the AST
# matches the real build.
cmd=$(echo "$cmd" \
  | sed 's| -c | -Xclang -fdump-record-layouts -fsyntax-only |' \
  | sed 's| -o [^ ]* | |')

cd "$debug_out"
dump=$(eval "$cmd" 2>/dev/null) || {
  echo "clang -fdump-record-layouts failed" >&2
  exit 3
}

# Locate "0 | class <target>" then read forward to the next "[sizeof=N,..."
# line. The dump can contain template instantiations whose name also matches
# (e.g. as a template arg) — we want the FREESTANDING record, recognised by
# the class line ending exactly at the target name with no trailing args.
size=$(awk -v t="$target_type" '
  $0 ~ "^[[:space:]]*0 \\| class "t"$" { in_rec=1; next }
  in_rec && /\[sizeof=/ {
    match($0, /sizeof=[0-9]+/)
    print substr($0, RSTART+7, RLENGTH-7)
    exit
  }
' <<< "$dump")

if [ -z "$size" ]; then
  echo "could not parse sizeof($target_type) from layout dump" >&2
  exit 4
fi

echo "$size"
