"""recount_diff — rewrite each unified-diff hunk's @@ -a,b +c,d @@ counts
from the actual hunk body.

Why: LLM-authored diffs routinely ship wrong hunk line-counts AND hallucinated
start lines (e.g. `@@ -407,8 @@` for a 60-line file). `git apply --recount`
fixes counts but cannot relocate (no fuzz); GNU `patch --fuzz` relocates by
context but refuses to parse a hunk whose declared counts don't match the
body. Recounting here makes the diff parse-clean so `patch -p1 --fuzz=N` can
then ignore the bogus start line and find the real location by context.

stdin = a (possibly malformed-count) unified diff
stdout = same diff with corrected @@ counts
Defensive: never throws; passes lines through unchanged when not a hunk.
"""
from __future__ import annotations

import re
import sys

HUNK = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$")


def recount(text: str) -> str:
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        m = HUNK.match(lines[i])
        if not m:
            out.append(lines[i])
            i += 1
            continue
        old_start, new_start, tail = m.group(1), m.group(2), m.group(3)
        body: list[str] = []
        i += 1
        while i < n and not lines[i].startswith("@@ ") \
                and not lines[i].startswith("diff --git ") \
                and not lines[i].startswith("--- ") \
                and not lines[i].startswith("Index: "):
            body.append(lines[i])
            i += 1
        # Drop trailing artifact blank lines (length 0 — not real ' '/'+'/'-'
        # diff lines). A genuine empty context line is " " (space), kept.
        while body and body[-1] == "":
            body.pop()
        old = sum(1 for b in body if b[:1] in (" ", "-"))
        new = sum(1 for b in body if b[:1] in (" ", "+"))
        out.append(f"@@ -{old_start},{old} +{new_start},{new} @@{tail}")
        out.extend(body)
    return "\n".join(out)


def main() -> int:
    sys.stdout.write(recount(sys.stdin.read()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
