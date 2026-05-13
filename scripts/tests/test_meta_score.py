import unittest
import json
import tempfile
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from meta_score import score


class TestScore(unittest.TestCase):
    def setUp(self):
        self.fixture = Path(__file__).parent / "fixtures" / "results_sample.tsv"

    def test_score_emits_all_metrics(self):
        out = score(str(self.fixture))
        # M1: 100M baseline → 72M final (iter 10) → drop = 28M
        self.assertEqual(out["M1_total_drop"], 28000000)
        # M2: 3 apply-fail / 10 iters = 70%
        self.assertAlmostEqual(out["M2_apply_rate"], 0.70, places=3)
        # M3: 5 keep / 10 iters = 50%
        self.assertAlmostEqual(out["M3_keep_rate"], 0.50, places=3)
        # M4: 3 distinct fqnames in kept descriptions
        self.assertEqual(out["M4_struct_coverage"], 3)
        # M5: cv of [10M, 5M, 5M, 5M, 3M] keep deltas
        self.assertIn("M5_keep_delta_cv", out)
        self.assertGreater(out["M5_keep_delta_cv"], 0)
        # Eval N = 10 inner iters (iter 0 is baseline, not counted)
        self.assertEqual(out["eval_N"], 10)
        self.assertEqual(out["baseline_metric"], 100000000)
        self.assertEqual(out["final_metric"], 72000000)

    def test_handles_no_keeps(self):
        with tempfile.NamedTemporaryFile("w", suffix=".tsv", delete=False) as f:
            f.write("# direction=lower\n")
            f.write("iter\tstatus\tmetric\tdelta\texit\twarns\tdesc\tts\n")
            f.write("0\tbaseline\t100\t\t0\t0\tinitial\t2026-05-13T00:00:00Z\n")
            f.write("1\tdiscard\t\t\t128\t0\tapply-fail\t2026-05-13T00:01:00Z\n")
            f.write("2\tdiscard\t\t\t128\t0\tapply-fail\t2026-05-13T00:02:00Z\n")
        out = score(f.name)
        self.assertEqual(out["M1_total_drop"], 0)        # final = baseline = 100
        self.assertAlmostEqual(out["M2_apply_rate"], 0.0)
        self.assertEqual(out["M3_keep_rate"], 0.0)
        self.assertEqual(out["M4_struct_coverage"], 0)
        self.assertIsNone(out["M5_keep_delta_cv"])


if __name__ == "__main__":
    unittest.main()
