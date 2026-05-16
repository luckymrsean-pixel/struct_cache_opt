import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recount_diff import recount


class TestRecount(unittest.TestCase):
    def test_fixes_wrong_counts_keeps_starts(self):
        # declared 8/9 but body is 4 ctx +1 - +3 + → old=5 new=7
        d = (
            "diff --git a/p b/p\n"
            "--- a/p\n+++ b/p\n"
            "@@ -407,8 +407,9 @@\n"
            " a\n b\n c\n d\n"
            "-old\n"
            "+n1\n+n2\n+n3\n"
        )
        r = recount(d)
        hdr = [l for l in r.split("\n") if l.startswith("@@")][0]
        self.assertEqual(hdr, "@@ -407,5 +407,7 @@")

    def test_passthrough_non_hunk_lines(self):
        d = "diff --git a/p b/p\n--- a/p\n+++ b/p\n"
        self.assertEqual(recount(d), d)

    def test_trailing_blank_artifact_lines_dropped_from_count(self):
        d = (
            "@@ -1,9 +1,9 @@\n"
            " x\n-y\n+z\n w\n"
            "\n\n"          # artifact bare-empty trailing lines
        )
        r = recount(d)
        hdr = r.split("\n")[0]
        self.assertEqual(hdr, "@@ -1,3 +1,3 @@")

    def test_empty_context_line_with_space_is_counted(self):
        d = "@@ -1,1 +1,2 @@\n \n+added\n"   # one real empty ctx line (" ")
        r = recount(d)
        self.assertEqual(r.split("\n")[0], "@@ -1,1 +1,2 @@")

    def test_multi_hunk(self):
        d = (
            "@@ -1,1 +1,1 @@\n a\n"
            "@@ -50,1 +50,1 @@\n-b\n+c\n"
        )
        hdrs = [l for l in recount(d).split("\n") if l.startswith("@@")]
        self.assertEqual(hdrs, ["@@ -1,1 +1,1 @@", "@@ -50,1 +50,1 @@"])

    def test_garbage_no_throw_unchanged(self):
        self.assertEqual(recount("not a diff at all"), "not a diff at all")

    def test_hunk_output_is_newline_terminated(self):
        # last hunk line lacks a trailing newline (common LLM output)
        d = "@@ -1,1 +1,2 @@\n a\n+b"
        r = recount(d)
        self.assertTrue(r.endswith("\n"), repr(r))
        self.assertFalse(r.endswith("\n\n"))

    def test_interior_bare_blank_becomes_space_context(self):
        # model emitted a blank context line as bare "" (no leading space)
        d = "@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n"
        r = recount(d)
        body = r.split("\n")
        # the blank between ' a' and '-b' must be a single space, not ""
        self.assertEqual(body[2], " ")
        self.assertEqual(body[0], "@@ -1,3 +1,3 @@")  # blank counted as ctx

    def test_passthrough_no_forced_newline_when_no_hunk(self):
        self.assertEqual(recount("plain text no newline"),
                         "plain text no newline")


if __name__ == "__main__":
    unittest.main()
