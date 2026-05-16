import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from propose_meta_edit import parse_proposal

EVOLVING = {"inputs/rules.MD", "inputs/cold_path.MD", "inputs/correlation.MD",
            "prompt.tmpl", "lib/fuse_context.py"}

GOOD = """FILE: inputs/rules.MD
SCOPE: rules
ONELINE: prefer 8-byte hot fields first
HYPOTHESIS: apply_rate up, M1 up
diff --git a/inputs/rules.MD b/inputs/rules.MD
--- a/inputs/rules.MD
+++ b/inputs/rules.MD
@@ -1 +1 @@
-x
+y
"""

GOOD_FENCED = """FILE: prompt.tmpl
SCOPE: prompt
ONELINE: tighten protocol
HYPOTHESIS: fewer parse failures
```diff
diff --git a/prompt.tmpl b/prompt.tmpl
--- a/prompt.tmpl
+++ b/prompt.tmpl
@@ -1 +1 @@
-a
+b
```
"""


class TestParseProposal(unittest.TestCase):
    def test_parse_good(self):
        p = parse_proposal(GOOD, evolving=EVOLVING)
        self.assertIsNone(p["error"])
        self.assertEqual(p["file"], "inputs/rules.MD")
        self.assertEqual(p["scope"], "rules")
        self.assertEqual(p["oneline"], "prefer 8-byte hot fields first")
        self.assertEqual(p["hypothesis"], "apply_rate up, M1 up")
        self.assertTrue(p["diff"].startswith("diff --git "))
        self.assertTrue(p["diff"].endswith("+y\n"))

    def test_parse_fenced_strips_fence(self):
        p = parse_proposal(GOOD_FENCED, evolving=EVOLVING)
        self.assertIsNone(p["error"])
        self.assertEqual(p["file"], "prompt.tmpl")
        self.assertNotIn("```", p["diff"])
        self.assertTrue(p["diff"].startswith("diff --git "))

    def test_reject_frozen_path(self):
        bad = GOOD.replace("inputs/rules.MD", "run.sh")
        p = parse_proposal(bad, evolving=EVOLVING)
        self.assertIsNotNone(p["error"])

    def test_reject_no_diff(self):
        txt = "FILE: inputs/rules.MD\nSCOPE: rules\nONELINE: x\nHYPOTHESIS: y\n"
        p = parse_proposal(txt, evolving=EVOLVING)
        self.assertIsNotNone(p["error"])

    def test_reject_missing_file_header(self):
        txt = "SCOPE: rules\nONELINE: x\nHYPOTHESIS: y\ndiff --git a/z b/z\n"
        p = parse_proposal(txt, evolving=EVOLVING)
        self.assertIsNotNone(p["error"])

    def test_reject_preamble_garbage_only(self):
        p = parse_proposal("I cannot help with that.", evolving=EVOLVING)
        self.assertIsNotNone(p["error"])


if __name__ == "__main__":
    unittest.main()
