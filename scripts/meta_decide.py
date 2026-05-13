"""meta_decide — apply Pareto decision rule, append meta_results.tsv row.

Decision rule (from spec §5.4):
  if apply_rate < gate           -> revert
  elif M1 < champion.M1 * (1-band) -> revert
  elif M1 > champion.M1 * (1+band) -> advance
  else                           -> manual
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict


def decide(candidate: Dict, champion: Dict, noise_band: float, gate: float) -> Dict:
    cand_m1 = candidate["M1_total_drop"]
    cand_rate = candidate["M2_apply_rate"]
    champ_m1 = champion["M1_total_drop"]

    if cand_rate < gate:
        return {"decision": "revert",
                "reason": f"apply_rate {cand_rate:.0%} below gate {gate:.0%}"}

    lo = champ_m1 * (1 - noise_band)
    hi = champ_m1 * (1 + noise_band)

    if cand_m1 < lo:
        return {"decision": "revert",
                "reason": f"M1 {cand_m1} < {lo:.0f} (champion {champ_m1} -{noise_band:.0%})"}
    if cand_m1 > hi:
        pct = ((cand_m1 - champ_m1) / champ_m1) * 100 if champ_m1 else 0
        return {"decision": "advance",
                "reason": f"M1 +{pct:.1f}% over champion"}
    return {"decision": "manual",
            "reason": "within noise band"}


def append_row(tsv_path: str, meta_iter: int, skill_tag: str, parent_tag: str,
               candidate: Dict, decision: Dict, run_dir: str) -> None:
    """Append one row to meta_results.tsv. Creates the file with header if absent."""
    path = Path(tsv_path)
    header_needed = not path.exists() or path.stat().st_size == 0
    with path.open("a") as f:
        if header_needed:
            f.write("# direction=multi  primary=M1  baseline_tag=meta-baseline\n")
            f.write("meta_iter\tskill_tag\tparent_tag\teval_N\t"
                    "M1_total_drop\tM2_apply_rate\tM3_keep_rate\t"
                    "M4_struct_cov\tM5_cv\tdecision\treason\tts\trun_dir\n")
        cv = candidate.get("M5_keep_delta_cv")
        cv_s = "n/a" if cv is None else f"{cv:.3f}"
        f.write("\t".join([
            str(meta_iter),
            skill_tag,
            parent_tag,
            str(candidate["eval_N"]),
            str(candidate["M1_total_drop"]),
            f"{candidate['M2_apply_rate']:.0%}",
            f"{candidate['M3_keep_rate']:.0%}",
            str(candidate["M4_struct_coverage"]),
            cv_s,
            decision["decision"],
            decision["reason"],
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            run_dir,
        ]) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", required=True, help="path to candidate result.json")
    ap.add_argument("--champion", required=True, help="path to champion result.json")
    ap.add_argument("--append", required=True, help="path to meta_results.tsv to append")
    ap.add_argument("--meta-iter", type=int, required=True)
    ap.add_argument("--skill-tag", required=True)
    ap.add_argument("--parent-tag", required=True)
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--noise-band", type=float, default=0.10)
    ap.add_argument("--gate", type=float, default=0.5)
    args = ap.parse_args()

    cand = json.loads(Path(args.candidate).read_text())
    champ = json.loads(Path(args.champion).read_text())

    d = decide(cand, champ, args.noise_band, args.gate)

    # Write decision back into candidate.json (meta-bench.sh reads it from there)
    cand["decision"] = d["decision"]
    cand["reason"]   = d["reason"]
    Path(args.candidate).write_text(json.dumps(cand, indent=2))

    append_row(args.append, args.meta_iter, args.skill_tag, args.parent_tag,
               cand, d, args.run_dir)

    print(f"decision: {d['decision']}  ({d['reason']})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
