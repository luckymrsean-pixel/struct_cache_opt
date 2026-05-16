# Meta-Loop Phase 2 + Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the autoresearch inner loop reliably produce applicable diffs (real optimization), add an autonomous Phase-2 meta-driver, surface the evolution process on the dashboard, then run it.

**Architecture:** Module A fixes the ideate path (non-agentic claude + hardened parser) — prerequisite. Module B wraps Phase-1 `meta-bench.sh` in an autonomous driver that proposes skill edits. Module C adds read-only dashboard endpoints/panel over `meta_results.tsv` + `meta-runs/`.

**Tech Stack:** bash, Python 3 (stdlib + pytest/unittest), TypeScript (tsx, node:assert), claude CLI v2.1.138.

**Repos:** `S=/mnt/f/code2/struct_cache_opt`, `K=/mnt/f/code2/target_skill` (skill, separate git repo), `A=/home/fxy/angle` (ANGLE workdir).

---

## Module A — Inner-loop ideate reliability (BLOCKER)

### Task A1: Non-agentic IDEATE_CLI

**Files:** Modify: `S/vk-image-helper.yml` (`env.IDEATE_CLI`)

- [ ] Step 1: Change `IDEATE_CLI: "claude -p"` →
  `IDEATE_CLI: 'claude -p --tools "" --output-format json --no-session-persistence --max-budget-usd 1.50'`
- [ ] Step 2: Commit in `S`: `git commit -am "fix(yml): non-agentic deterministic ideate CLI"`

### Task A2: `extract_result.py` (new frozen lib, TDD)

**Files:** Create `K/struct_layout_opt/lib/extract_result.py`, Test `K/struct_layout_opt/tests/test_extract_result.py`

- [ ] Step 1: Write failing test:

```python
import sys, json, io, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(ROOT))
from lib.extract_result import extract

class T(unittest.TestCase):
    def test_json_result_extracted(self):
        j = json.dumps({"type":"result","subtype":"success","result":"STRUCT: x STATUS: update\ndiff --git a/p b/p\n"})
        self.assertEqual(extract(j), "STRUCT: x STATUS: update\ndiff --git a/p b/p\n")
    def test_plain_text_passthrough(self):
        self.assertEqual(extract("STRUCT: x STATUS: update\n"), "STRUCT: x STATUS: update\n")
    def test_garbage_passthrough(self):
        self.assertEqual(extract("not json {oops"), "not json {oops")
    def test_json_without_result_key_passthrough(self):
        self.assertEqual(extract('{"type":"result"}'), '{"type":"result"}')
if __name__ == "__main__": unittest.main()
```

- [ ] Step 2: Run `cd K/struct_layout_opt && python3 -m pytest tests/test_extract_result.py -q` → FAIL (no module)
- [ ] Step 3: Implement:

```python
"""extract_result — if stdin is a claude --output-format json object with a
.result string, print that string; otherwise print stdin unchanged.
Defensive: never throws, exit 0 always (frozen contract file)."""
from __future__ import annotations
import json, sys

def extract(text: str) -> str:
    s = text.strip()
    if not s or s[0] != "{":
        return text
    try:
        obj = json.loads(s)
    except Exception:
        return text
    if isinstance(obj, dict) and isinstance(obj.get("result"), str):
        return obj["result"]
    return text

def main() -> int:
    sys.stdout.write(extract(sys.stdin.read()))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] Step 4: Run pytest → PASS
- [ ] Step 5 (commit deferred to A7 — one `contract:` commit for all frozen edits)

### Task A3: Harden `parse_output.py` (frozen, TDD)

**Files:** Modify `K/struct_layout_opt/lib/parse_output.py`, Test `K/struct_layout_opt/tests/test_parse_output.py`

- [ ] Step 1: Append failing cases to `test_parse_output.py`:

```python
    def test_agent_banner_preamble_then_protocol(self):
        txt = ("Detected AI agent env. Prepending --quiet ...\n"
               "I'll cluster the per-write hot data.\n"
               "STRUCT: rx::vk::ImageHelper STATUS: update\n"
               "diff --git a/src/vk_helpers.h b/src/vk_helpers.h\n"
               "--- a/src/vk_helpers.h\n+++ b/src/vk_helpers.h\n@@ -1 +1 @@\n-a\n+b\n")
        out = StringIO()
        rc = parse_and_dispatch(stdin_text=txt, stdout=out, state_dir=self.state_dir, iter_n=3)
        self.assertEqual(rc, 0)
        self.assertTrue(out.getvalue().startswith("diff --git "))
        self.assertIn("rx::vk::ImageHelper\t3\tupdate\t", self._read_index())

    def test_fenced_diff_block(self):
        txt = ("STRUCT: rx::vk::ImageHelper STATUS: update\n"
               "```diff\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n```\n")
        out = StringIO()
        parse_and_dispatch(stdin_text=txt, stdout=out, state_dir=self.state_dir, iter_n=4)
        self.assertTrue(out.getvalue().startswith("diff --git "))
        self.assertNotIn("```", out.getvalue())

    def test_no_status_line_anywhere_still_empty(self):
        out = StringIO()
        parse_and_dispatch(stdin_text=MALFORMED_INPUT, stdout=out, state_dir=self.state_dir, iter_n=1)
        self.assertEqual(out.getvalue(), "")
```

- [ ] Step 2: Run `python3 -m pytest tests/test_parse_output.py -q` → FAIL on the two new positive cases
- [ ] Step 3: Rewrite `parse_and_dispatch` body to scan for header anywhere + fenced/bare diff locate + fence strip:

```python
def parse_and_dispatch(stdin_text, stdout, state_dir, iter_n):
    lines = stdin_text.splitlines(keepends=True)
    hdr_i, m = None, None
    for i, ln in enumerate(lines):
        mm = HEADER_RE.match(ln.rstrip("\n"))
        if mm:
            hdr_i, m = i, mm
            break
    if m is None:
        print("parse_output: no STATUS header found", file=sys.stderr)
        return 0
    fqname, status = m.group("fqname"), m.group("status")
    reason = m.group("reason") or ""
    _append_index(state_dir, fqname, iter_n, status, reason)
    if status != "update":
        return 0
    rest = "".join(lines[hdr_i + 1:])
    j = rest.find("diff --git ")
    if j == -1:
        print("parse_output: update with no diff body", file=sys.stderr)
        return 0
    body = rest[j:]
    fence = body.find("\n```")          # strip a trailing ``` fence if present
    if fence != -1:
        body = body[:fence + 1]
    stdout.write(body)
    return 0
```

- [ ] Step 4: Run `python3 -m pytest tests/ -q` → all PASS (15 prior + 4 new = 19)
- [ ] Step 5 (commit deferred to A7)

### Task A4: `run.sh` inserts extract_result

**Files:** Modify `K/struct_layout_opt/run.sh` (Phase 4 pipeline)

- [ ] Step 1: Change the final pipeline to:

```bash
printf '%s' "$prompt" \
  | $ideate_cli \
  | python3 "$skill_dir/lib/extract_result.py" \
  | python3 "$skill_dir/lib/parse_output.py" \
      --target-lib "$target_lib" --iter "$iter_n"
```

- [ ] Step 2: `bash -n K/struct_layout_opt/run.sh` → no syntax error

### Task A5: `prompt.tmpl` — allow fenced diff, restate no-tools

**Files:** Modify `K/struct_layout_opt/prompt.tmpl`

- [ ] Step 1: Add near the top: "You have NO tools. Do not attempt to build, edit files, or run commands — emit only the protocol below as text." In the output-protocol section, add: "An optional single ```diff fenced block around the diff is tolerated; no other prose."

### Task A6: MANIFEST adds extract_result.py to frozen

**Files:** Modify `K/struct_layout_opt/MANIFEST.yml`

- [ ] Step 1: Add `  - lib/extract_result.py` under `frozen:`

### Task A7: Contract commit + retag baseline

- [ ] Step 1: `cd K && git checkout master` (land on the mainline the meta tags track; if detached, this consolidates)
- [ ] Step 2: `git -C K add -A && git -C K -c user.email=autoresearch@local -c user.name=sean commit -m "contract: non-agentic ideate + hardened parser + extract_result"`
  (subject `contract:` bypasses the meta pre-commit `check_manifest` gate)
- [ ] Step 3: `git -C K tag -f champion HEAD && git -C K tag -f skill-v0 HEAD` (new contract baseline)
- [ ] Step 4: `git -C K rev-parse --short champion skill-v0 HEAD` → all equal

### Task A8: VERIFY real optimization (gate before B/C)

- [ ] Step 1: Skill suite: `cd K/struct_layout_opt && python3 -m pytest tests/ -q` → all PASS
- [ ] Step 2: Single live ideate sanity (no build): run `run.sh` with live env against `A`, capture stdout to `/tmp/ar.smoke.patch`, then `git -C A apply --check /tmp/ar.smoke.patch` → exit 0 (valid diff). If STATUS=cannot_update (empty), retry once with a more directive context; record outcome.
- [ ] Step 3: One real headless inner iter:
  `cd S/autoresearch && AR_ITERS=1 AR_HEADLESS=1 AR_TSV=/tmp/ar.smoke.tsv timeout 1200 npx tsx src/index.ts ../vk-image-helper.yml 2>&1 | tee /tmp/ar.smoke.log`
- [ ] Step 4: Assert `/tmp/ar.smoke.tsv` last iter row status ∈ {keep, discard} with a numeric metric (NOT `ideate-fail`/`apply-fail`). This proves the loop reaches verify = real optimization. If apply-fail: debug parser/prompt before proceeding (do not advance to B).
- [ ] Step 5: Commit any prompt/parser tweaks discovered in S spec notes if needed.

---

## Module B — Phase 2 automated meta-driver

### Task B1: `propose_meta_edit.py` (TDD)

**Files:** Create `S/scripts/propose_meta_edit.py`, Test `S/scripts/tests/test_propose_meta_edit.py`

- [ ] Step 1: Failing test (pure parse function, no LLM):

```python
import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from propose_meta_edit import parse_proposal

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

class T(unittest.TestCase):
    def test_parse_good(self):
        p = parse_proposal(GOOD, evolving={"inputs/rules.MD","prompt.tmpl"})
        self.assertEqual(p["file"], "inputs/rules.MD")
        self.assertEqual(p["scope"], "rules")
        self.assertTrue(p["diff"].startswith("diff --git "))
        self.assertIsNone(p["error"])
    def test_reject_frozen_path(self):
        bad = GOOD.replace("inputs/rules.MD","run.sh")
        p = parse_proposal(bad, evolving={"inputs/rules.MD"})
        self.assertIsNotNone(p["error"])
    def test_reject_no_diff(self):
        p = parse_proposal("FILE: inputs/rules.MD\nSCOPE: rules\nONELINE: x\nHYPOTHESIS: y\n", evolving={"inputs/rules.MD"})
        self.assertIsNotNone(p["error"])
if __name__ == "__main__": unittest.main()
```

- [ ] Step 2: `cd S && python3 -m pytest scripts/tests/test_propose_meta_edit.py -q` → FAIL
- [ ] Step 3: Implement `propose_meta_edit.py`: `parse_proposal(text, evolving)` returns
  `{"file","scope","oneline","hypothesis","diff","error"}` — regex the `FILE:`/`SCOPE:`/`ONELINE:`/`HYPOTHESIS:` headers, locate `diff --git ` for the body (reuse the same locate/fence-strip logic as parse_output), error if file ∉ evolving or no diff. Plus a `main()` that: reads champion MANIFEST evolving list, builds a proposal prompt from `meta_results.tsv` tail + champion `result.json` + champion `results.tsv` tail, calls `claude -p --tools "" --output-format json --no-session-persistence --max-budget-usd 1.50`, pipes through extract+parse, writes the diff to a `--out` path and prints `FILE\tSCOPE\tONELINE\tHYPOTHESIS` to stdout, exit 0 on success / 3 on bad-proposal.
- [ ] Step 4: pytest → PASS
- [ ] Step 5: `git -C S add scripts/propose_meta_edit.py scripts/tests/test_propose_meta_edit.py && git -C S commit -m "feat(meta): propose_meta_edit.py — autonomous skill-edit proposer"`

### Task B2: `meta-driver.sh`

**Files:** Create `S/scripts/meta-driver.sh`

- [ ] Step 1: Implement per spec §B.1: arg `--meta-iters K [--N n] [--max-usd x] [--dry-run]`; loop K times:
  `git -C K checkout champion`; `python3 scripts/propose_meta_edit.py --out /tmp/meta.diff` (skip→record `decision=skip` row via meta_decide-less direct append, continue); `git -C K apply /tmp/meta.diff`; `git -C K commit -m "meta(<scope>): <oneline>\n\nHypothesis: <hyp>\nEval-N: <N>"`; `bash scripts/tag_meta_iter.sh`; `bash scripts/meta-bench.sh --skill-tag <newtag> --N <N>`; append one line to `meta-runs/driver.log`; budget check. Write `S/meta-driver.pid` while running; trap to remove it.
- [ ] Step 2: `bash -n scripts/meta-driver.sh` → clean
- [ ] Step 3: `chmod +x scripts/meta-driver.sh scripts/propose_meta_edit.py`
- [ ] Step 4: Dry-run: `bash scripts/meta-driver.sh --meta-iters 1 --dry-run` → exits 0, no champion move, prints intended steps. (propose still runs but result unused under dry-run; or skip propose under dry-run.)
- [ ] Step 5: `git -C S add scripts/meta-driver.sh && git -C S commit -m "feat(meta): meta-driver.sh — Phase 2 autonomous loop"`

---

## Module C — Monitoring surface

### Task C1: web.ts endpoints + watch (TDD)

**Files:** Modify `S/autoresearch/src/web.ts`; Create `S/autoresearch/scripts/test-meta-state.ts`; Modify `S/autoresearch/scripts/run-all-tests.sh`

- [ ] Step 1: Failing test `test-meta-state.ts` (tsx + node:assert): write a fixture `meta_results.tsv` to a temp dir, call exported `parseMetaState(dir)` → assert returns `{rows:[...], champion, driverRunning}` with correct row count + last decision.
- [ ] Step 2: `cd S/autoresearch && tsx scripts/test-meta-state.ts` → FAIL (function missing)
- [ ] Step 3: Add `parseMetaState(cacheRoot)` to `web.ts` (read `meta_results.tsv`, `meta-driver.pid`, `git -C skillRepo tag --points-at champion`, last `meta-runs/driver.log` line). Add HTTP handlers `/api/meta-state` and `/api/meta-run?tag=`. Add `fs.watch` on `meta_results.tsv` + `meta-runs/driver.log` → `broadcast({type:"meta-updated"})`. Send `meta-state` on WS handshake + 2s tick.
- [ ] Step 4: `tsx scripts/test-meta-state.ts` → PASS; `npx tsc --noEmit` → clean; register suite in `run-all-tests.sh`; `bash scripts/run-all-tests.sh` → all green
- [ ] Step 5: `git -C S commit -am "feat(web): /api/meta-state + /api/meta-run + watch"`

### Task C2: Dashboard "Evolution" panel

**Files:** Modify `S/Autoresearch Dashboard.html`

- [ ] Step 1: Add an "Evolution" section: lineage table (meta_iter, skill_tag, parent, scope, M1 w/ sparkline, M2, M3, M4, M5, decision colored, reason), champion row highlighted; M1 trend mini-chart (inline SVG/canvas, no deps); live status line from `meta-state`. Pull on WS `meta-updated` + handshake; "no meta-iters yet" when only header. Behind real data (no demo mock).
- [ ] Step 2: Manual check: open `http://127.0.0.1:8080/` (server running) → Evolution panel renders existing 3 `meta_results.tsv` rows; champion (skill-v2 or new) highlighted.
- [ ] Step 3: `git -C S commit -am "feat(dashboard): Evolution panel for meta-loop"`

### Task C3: Docs

**Files:** Modify `S/how-to.md`

- [ ] Step 1: Add a "Phase 2 — autonomous meta-driver" section: `bash scripts/meta-driver.sh --meta-iters 3`, the Evolution panel, driver.log, pid file, budget guard.
- [ ] Step 2: `git -C S commit -am "docs(how-to): Phase 2 meta-driver + Evolution panel"`

---

## Final: Start the loops

### Task D1: Seed champion baseline + start

- [ ] Step 1: Ensure `meta-runs/skill-v0/result.json` exists for the new contract baseline: `bash scripts/meta-bench.sh --skill-tag skill-v0 --N 2` (cheap seed; verifies pipeline end-to-end on the fixed skill). Confirm a `keep` row appears in `meta-runs/skill-v0/results.tsv` (real optimization proof).
- [ ] Step 2: Start the autonomous meta-loop: `nohup bash scripts/meta-driver.sh --meta-iters 3 --N 3 > meta-runs/driver.console.log 2>&1 & echo $! > meta-driver.pid`
- [ ] Step 3: Start the dashboard server so evolution is observable: `cd autoresearch && nohup npx tsx src/index.ts ../vk-image-helper.yml > /dev/null 2>> ../loop.log & echo $! > ../loop.pid`
- [ ] Step 4: Monitor: tail `meta-runs/driver.log` + `meta_results.tsv`; confirm meta-iters produce real M1 values and ≥1 `keep` inner iter per meta-bench. Report progress.

---

## Self-Review

- **Spec coverage:** A1–A8 = spec §3 (ideate fix + verify gate). B1–B2 = §4 (driver + proposer). C1–C3 = §5 (endpoints + panel + docs). D1 = §9 migration steps 4 & 6. ✓
- **Placeholder scan:** All code steps contain real code; commands are exact. ✓
- **Type consistency:** `parse_proposal` keys (`file/scope/oneline/hypothesis/diff/error`) consistent B1↔B2. `parseMetaState` shape (`rows/champion/driverRunning`) consistent C1↔C2. `extract()` / `parse_and_dispatch()` signatures match existing test harness. ✓
- **Risk:** A8 step 2/3 may reveal residual prompt issues; plan explicitly gates B/C on A8 passing (debug-before-proceed), consistent with goal "fix all bugs until loop does real optimization".
