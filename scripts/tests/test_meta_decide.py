import unittest
import json
import tempfile
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from meta_decide import decide


CHAMPION = {
    "M1_total_drop": 20000000,
    "M2_apply_rate": 0.8,
}


class TestDecide(unittest.TestCase):
    def test_advance_when_M1_above_band(self):
        candidate = {"M1_total_drop": 25000000, "M2_apply_rate": 0.8}
        d = decide(candidate, CHAMPION, noise_band=0.1, gate=0.5)
        self.assertEqual(d["decision"], "advance")
        self.assertIn("+", d["reason"])

    def test_revert_when_M1_below_band(self):
        candidate = {"M1_total_drop": 17000000, "M2_apply_rate": 0.8}
        d = decide(candidate, CHAMPION, noise_band=0.1, gate=0.5)
        self.assertEqual(d["decision"], "revert")

    def test_manual_within_noise_band(self):
        candidate = {"M1_total_drop": 21000000, "M2_apply_rate": 0.8}
        d = decide(candidate, CHAMPION, noise_band=0.1, gate=0.5)
        self.assertEqual(d["decision"], "manual")

    def test_apply_rate_gate_dominates(self):
        # M1 huge improvement but apply_rate sub-gate → revert
        candidate = {"M1_total_drop": 50000000, "M2_apply_rate": 0.4}
        d = decide(candidate, CHAMPION, noise_band=0.1, gate=0.5)
        self.assertEqual(d["decision"], "revert")
        self.assertIn("apply_rate", d["reason"])


if __name__ == "__main__":
    unittest.main()
