"""meta_score — read a results.tsv slice and emit a result.json with M1..M5.

Schema:
{
  "eval_N": int,
  "baseline_metric": int,
  "final_metric": int,
  "M1_total_drop": int,
  "M2_apply_rate": float,
  "M3_keep_rate": float,
  "M4_struct_coverage": int,
  "M5_keep_delta_cv": float | None
}
"""
from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
from pathlib import Path
from typing import Dict, List, Optional


def _parse_int(s: str) -> Optional[int]:
    try:
        return int(s)
    except (ValueError, TypeError):
        return None


def _fqname_from_desc(desc: str) -> Optional[str]:
    """Extract the optimized struct name from a keep description.

    Convention (from current loop.ts): keep descriptions of the form
        "keep <Name>"   (e.g. "keep ImageHelper")
    or just "keep" if the description lacks a name. We take the last
    whitespace-separated token if it's not "keep" itself.
    """
    parts = desc.strip().split()
    if not parts:
        return None
    if len(parts) == 1:
        return None   # bare "keep"
    name = parts[-1]
    if name == "keep":
        return None
    return name


def score(tsv_path: str) -> Dict:
    rows: List[Dict[str, str]] = []
    with open(tsv_path) as f:
        for raw in f:
            if raw.startswith("#") or not raw.strip():
                continue
            rows.append(raw.rstrip("\n").split("\t"))

    if not rows or rows[0][0] != "iter":
        raise ValueError(f"unexpected header in {tsv_path}: {rows[:1]}")
    header = rows[0]
    data = [dict(zip(header, r)) for r in rows[1:]]

    baseline_rows = [r for r in data if r["status"] == "baseline"]
    if not baseline_rows:
        raise ValueError("no baseline row in tsv")
    baseline = _parse_int(baseline_rows[0]["metric"])
    if baseline is None:
        raise ValueError("baseline metric not parseable")

    iter_rows = [r for r in data if r["status"] != "baseline"]
    eval_N = len(iter_rows)

    # Final metric = the last row that has a metric value (keep rows; some
    # discard rows for "regress" also have it). If none, fall back to baseline.
    final = baseline
    for r in reversed(iter_rows):
        m = _parse_int(r["metric"])
        if m is not None and r["status"] == "keep":
            final = m
            break

    keep_rows = [r for r in iter_rows if r["status"] == "keep"]
    apply_fail_rows = [r for r in iter_rows
                       if r["status"] == "discard" and "apply-fail" in r["desc"]]

    keep_deltas = []
    for r in keep_rows:
        d = _parse_int(r["delta"])
        if d is not None:
            keep_deltas.append(abs(d))

    fqnames = set()
    for r in keep_rows:
        n = _fqname_from_desc(r["desc"])
        if n:
            fqnames.add(n)

    if len(keep_deltas) >= 2:
        m = statistics.mean(keep_deltas)
        s = statistics.stdev(keep_deltas)
        cv: Optional[float] = (s / m) if m > 0 else 0.0
    else:
        cv = None

    return {
        "eval_N":             eval_N,
        "baseline_metric":    baseline,
        "final_metric":       final,
        "M1_total_drop":      baseline - final,
        "M2_apply_rate":      (1 - len(apply_fail_rows) / eval_N) if eval_N else 0.0,
        "M3_keep_rate":       (len(keep_rows) / eval_N) if eval_N else 0.0,
        "M4_struct_coverage": len(fqnames),
        "M5_keep_delta_cv":   cv,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="path to results.tsv slice")
    ap.add_argument("--out", required=True, help="path to result.json output")
    args = ap.parse_args()

    result = score(args.inp)
    Path(args.out).write_text(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
