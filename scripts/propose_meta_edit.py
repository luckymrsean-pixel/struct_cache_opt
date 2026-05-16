"""propose_meta_edit — autonomous proposer for the Phase-2 meta-loop.

Reads the champion skill state + meta-loop history + the champion inner-loop
results, asks a non-agentic LLM for ONE edit to ONE *evolving* file, and emits
a unified diff. Defensive: a malformed/disallowed proposal exits 3 (the
driver records a `skip` and continues) — never a crash.

`parse_proposal(text, evolving)` is the pure, unit-tested core.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, Optional, Set

HEADER_FILE = re.compile(r"^FILE:\s+(?P<v>\S+)\s*$", re.M)
HEADER_SCOPE = re.compile(r"^SCOPE:\s+(?P<v>\S+)\s*$", re.M)
HEADER_ONE = re.compile(r"^ONELINE:\s+(?P<v>.+?)\s*$", re.M)
HEADER_HYP = re.compile(r"^HYPOTHESIS:\s+(?P<v>.+?)\s*$", re.M)


def _locate_diff(text: str) -> Optional[str]:
    """Return the unified-diff body, tolerating a wrapping ```diff fence.

    Same locator semantics as struct_layout_opt/lib/parse_output.py so the
    two stay behaviourally consistent.
    """
    j = text.find("diff --git ")
    if j == -1:
        return None
    body = text[j:]
    fence = body.find("\n```")
    if fence != -1:
        body = body[:fence + 1]
    return body


def parse_proposal(text: str, evolving: Set[str]) -> Dict[str, Optional[str]]:
    """Parse the strict proposal protocol into a dict.

    Returns keys: file, scope, oneline, hypothesis, diff, error. `error` is a
    human string when the proposal is unusable (and the other fields may be
    None); otherwise `error` is None.
    """
    out: Dict[str, Optional[str]] = {
        "file": None, "scope": None, "oneline": None,
        "hypothesis": None, "diff": None, "error": None,
    }
    mf = HEADER_FILE.search(text)
    if not mf:
        out["error"] = "no FILE: header"
        return out
    out["file"] = mf.group("v")
    ms = HEADER_SCOPE.search(text)
    out["scope"] = ms.group("v") if ms else ""
    mo = HEADER_ONE.search(text)
    out["oneline"] = mo.group("v") if mo else "meta edit"
    mh = HEADER_HYP.search(text)
    out["hypothesis"] = mh.group("v") if mh else ""

    if out["file"] not in evolving:
        out["error"] = f"FILE '{out['file']}' is not an evolving path"
        return out

    diff = _locate_diff(text)
    if not diff:
        out["error"] = "no unified diff body"
        return out
    out["diff"] = diff
    return out


# ── main() helpers ────────────────────────────────────────────────────────


def _read_evolving(manifest_path: Path) -> Set[str]:
    """Minimal parser for the strict MANIFEST.yml evolving block."""
    evolving: Set[str] = set()
    in_block = False
    for raw in manifest_path.read_text().splitlines():
        if raw.startswith("evolving:"):
            in_block = True
            continue
        if in_block:
            s = raw.strip()
            if s.startswith("- "):
                evolving.add(s[2:].strip())
            elif s and not raw.startswith((" ", "\t")):
                break
    return evolving


def _tail(path: Path, n: int) -> str:
    if not path.exists():
        return "(none)"
    lines = path.read_text().splitlines()
    return "\n".join(lines[-n:])


def _build_prompt(skill_dir: Path, evolving: Set[str], meta_tsv: Path,
                  champ_result: Path, champ_inner_tsv: Path) -> str:
    files_blob = ""
    for rel in sorted(evolving):
        p = skill_dir / rel
        if p.is_file() and p.stat().st_size < 40_000:
            files_blob += f"\n=== {rel} ===\n{p.read_text()}\n"
    champ_m = champ_result.read_text() if champ_result.exists() else "(none)"
    return f"""You are a meta-optimizer improving a struct-layout-optimization SKILL.

You have NO tools. Emit ONLY the protocol below as text — nothing happens
unless it is in your emitted text.

The skill drives an inner loop that proposes C++ struct layout diffs for
ANGLE's vk::ImageHelper; the harness builds + benchmarks them and keeps the
ones that lower cache-misses. Your job: make ONE small, well-reasoned edit to
ONE evolving file so the NEXT bench run improves M1 (total cache-miss drop
over N inner iters) without dropping M2 (apply-rate) below the 50% gate.

Do NOT propose edits whose mechanism is "emit cannot_update more often" or
that game M2/M3 without improving M1 — that is reward hacking and will be
reverted.

# Champion scoreboard (result.json)
{champ_m}

# Recent meta-iters (meta_results.tsv tail)
{_tail(meta_tsv, 8)}

# Champion inner-loop run (results.tsv tail — look for apply-fail/regress patterns)
{_tail(champ_inner_tsv, 12)}

# Current evolving files (edit exactly ONE; diff must apply against these)
{files_blob}

# Output protocol — STRICT
FILE: <one path from the evolving list above>
SCOPE: rules|cold_path|correlation|prompt|fuse_context
ONELINE: <short commit-subject tail>
HYPOTHESIS: <expected effect on M1..M5>
<unified diff for that ONE file, starting with `diff --git a/<FILE> b/<FILE>`>

No prose outside these fields. An optional single ```diff fence around the
diff is tolerated. If you genuinely cannot improve anything, still emit the
protocol with a no-op-but-valid one-line clarifying comment edit to
inputs/rules.MD (never emit nothing)."""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="path to write the proposed diff")
    ap.add_argument("--skill-repo", default="/mnt/f/code2/target_skill")
    ap.add_argument("--skill-subdir", default="struct_layout_opt")
    ap.add_argument("--meta-tsv",
                    default="/mnt/f/code2/struct_cache_opt/meta_results.tsv")
    ap.add_argument("--champion-result", required=True,
                    help="path to champion meta-runs/<tag>/result.json")
    ap.add_argument("--champion-inner-tsv", required=True,
                    help="path to champion meta-runs/<tag>/results.tsv")
    ap.add_argument("--max-usd", type=float, default=1.50)
    args = ap.parse_args()

    skill_dir = Path(args.skill_repo) / args.skill_subdir
    evolving = _read_evolving(skill_dir / "MANIFEST.yml")
    if not evolving:
        print("propose: empty evolving set", file=sys.stderr)
        return 3

    prompt = _build_prompt(
        skill_dir, evolving, Path(args.meta_tsv),
        Path(args.champion_result), Path(args.champion_inner_tsv),
    )

    cli = os.environ.get(
        "IDEATE_CLI",
        'claude -p --tools "" --output-format json --no-session-persistence',
    )
    cli = f"{cli} --max-budget-usd {args.max_usd}" if "--max-budget-usd" not in cli else cli
    try:
        proc = subprocess.run(cli, shell=True, input=prompt,
                               capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        print("propose: LLM timeout", file=sys.stderr)
        return 3

    raw = proc.stdout
    try:
        obj = json.loads(raw.strip())
        if isinstance(obj, dict) and isinstance(obj.get("result"), str):
            raw = obj["result"]
    except Exception:
        pass

    p = parse_proposal(raw, evolving)
    if p["error"]:
        print(f"propose: bad proposal: {p['error']}", file=sys.stderr)
        print(raw[:400], file=sys.stderr)
        return 3

    Path(args.out).write_text(p["diff"])
    print("\t".join([p["file"], p["scope"] or "", p["oneline"] or "",
                      p["hypothesis"] or ""]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
