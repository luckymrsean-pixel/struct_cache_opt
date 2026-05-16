"""recount_diff — normalize an LLM-authored unified diff so GNU `patch` can
parse it, then rely on `patch --fuzz` to relocate hunks by context.

LLM diffs are unparseable by `patch` for three recurring reasons:
  1. wrong @@ -a,b +c,d @@ counts (and hallucinated start lines);
  2. blank context lines emitted as a bare "" instead of " " (a space);
  3. the final hunk line not newline-terminated (or trailing junk blanks).
`git apply` tolerates 2 & 3 but cannot fuzz-relocate (1's bad start line);
`patch --fuzz` relocates by context but rejects 1/2/3 as "malformed". This
rewriter fixes all three so the recount→patch-fuzz path actually applies.

stdin = raw diff ; stdout = normalized diff. Defensive: never throws;
non-diff input passes through unchanged.
"""
from __future__ import annotations

import re
import sys

HUNK = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$")
_BOUNDARY = ("@@ ", "diff --git ", "--- ", "Index: ")


def recount(text: str) -> str:
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)
    had_hunk = False
    while i < n:
        m = HUNK.match(lines[i])
        if not m:
            out.append(lines[i])
            i += 1
            continue
        had_hunk = True
        old_start, new_start, tail = m.group(1), m.group(2), m.group(3)
        body: list[str] = []
        i += 1
        while i < n and not lines[i].startswith(_BOUNDARY):
            body.append(lines[i])
            i += 1
        # Drop trailing bare-empty artifact lines (model padding after the
        # last real hunk line).
        while body and body[-1] == "":
            body.pop()
        # An interior bare "" is a blank context line the model forgot to
        # space-prefix → make it a proper " " context line (patch-legal).
        body = [" " if b == "" else b for b in body]
        old = sum(1 for b in body if b[:1] in (" ", "-"))
        new = sum(1 for b in body if b[:1] in (" ", "+"))
        out.append(f"@@ -{old_start},{old} +{new_start},{new} @@{tail}")
        out.extend(body)

    s = "\n".join(out)
    # A diff fed to `patch` MUST be newline-terminated; only force this when
    # we actually saw a hunk (keeps non-diff passthrough byte-exact).
    if had_hunk and not s.endswith("\n"):
        s += "\n"
    return s


def main() -> int:
    sys.stdout.write(recount(sys.stdin.read()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
