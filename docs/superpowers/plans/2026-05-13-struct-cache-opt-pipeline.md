# struct_cache_opt pipeline upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `struct_cache_opt` skill with a two-skill pipeline (`pahole_extractor` + `struct_layout_opt`) that emits richer context to the ideating LLM and tracks per-struct optimization status across iterations.

**Architecture:** `pahole_extractor` (pure data: builds debug `.o`, runs `pahole --show_private_classes -I` over a `target_lib`, emits raw layouts + struct index + lib overview). `struct_layout_opt` (opinionated: fuses pahole output with user-authored cold-field and correlation hints, drives a strict LLM output protocol, maintains a persistent worklist). Autoresearch's `vk-image-helper.yml` re-points its `skillDir` to `struct_layout_opt`. Spec: [`2026-05-13-struct-cache-opt-pipeline-design.md`](../specs/2026-05-13-struct-cache-opt-pipeline-design.md).

**Tech Stack:** Python 3.8+ stdlib only (no pip deps), bash for orchestration, pahole (dwarves package), `unittest` for tests. Target repo: `/mnt/f/code2/target_skill/` (local git, no remote).

---

## File Structure

Files to create / modify:

```
/mnt/f/code2/target_skill/
├── pahole_extractor/
│   ├── SKILL.md                              CREATE
│   ├── run.sh                                CREATE
│   ├── lib/pahole_extract.py                 CREATE
│   └── tests/
│       ├── test_layout_parser.py             CREATE
│       ├── test_index_writer.py              CREATE
│       └── fixtures/sample_pahole.txt        CREATE
├── struct_layout_opt/
│   ├── SKILL.md                              CREATE
│   ├── run.sh                                CREATE
│   ├── prompt.tmpl                           CREATE
│   ├── inputs/
│   │   ├── rules.MD                          CREATE
│   │   ├── cold_path.MD                      CREATE
│   │   └── correlation.MD                    CREATE
│   ├── lib/
│   │   ├── fuse_context.py                   CREATE
│   │   └── parse_output.py                   CREATE
│   └── tests/
│       ├── test_parse_output.py              CREATE
│       ├── test_cold_match.py                CREATE
│       ├── test_correlation_parse.py         CREATE
│       ├── test_fuse_writer.py               CREATE
│       └── fixtures/                         CREATE
│           ├── struct_index.tsv
│           ├── pahole_raw.txt
│           ├── cold_path.MD
│           ├── correlation.MD
│           └── expected_fused_index.md
├── struct_cache_opt/                         DELETE (whole directory)
└── (no top-level test runner needed; each skill has its own tests/)
```

```
/mnt/f/code2/struct_cache_opt/
└── vk-image-helper.yml                       MODIFY: skillDir pointer
```

Each Python module has one responsibility. Bash files only orchestrate; all parsing is in Python.

---

### Task 0: Prep — feature branch & sanity checks

**Files:**
- Modify: working tree of `/mnt/f/code2/target_skill/`

- [ ] **Step 1: Confirm pahole is installed**

Run: `pahole --version`
Expected: `v1.xx` or similar (non-zero version output). If "command not found", install with `sudo apt install dwarves` and re-run.

- [ ] **Step 2: Confirm Python 3.8+**

Run: `python3 --version`
Expected: `Python 3.8.x` or higher.

- [ ] **Step 3: Confirm working tree is clean**

Run: `git -C /mnt/f/code2/target_skill status --porcelain`
Expected: empty output (nothing modified). If not empty, stop and ask.

- [ ] **Step 4: Create feature branch**

Run: `git -C /mnt/f/code2/target_skill switch -c struct-pipeline-upgrade`
Expected: `Switched to a new branch 'struct-pipeline-upgrade'`.

- [ ] **Step 5: Commit empty branch marker (no-op marker for traceability)**

Run: `git -C /mnt/f/code2/target_skill commit --allow-empty -m "chore: begin struct pipeline upgrade"`

---

### Task 1: pahole_extractor skeleton & test fixture

Get the directory tree, an empty Python module, and a fixture pahole output in place so subsequent TDD tasks have a real artifact to parse.

**Files:**
- Create: `/mnt/f/code2/target_skill/pahole_extractor/lib/pahole_extract.py`
- Create: `/mnt/f/code2/target_skill/pahole_extractor/tests/__init__.py`
- Create: `/mnt/f/code2/target_skill/pahole_extractor/tests/fixtures/sample_pahole.txt`

- [ ] **Step 1: Create directory tree**

Run:
```
mkdir -p /mnt/f/code2/target_skill/pahole_extractor/{lib,tests/fixtures}
```

- [ ] **Step 2: Create empty Python package marker**

File `pahole_extractor/tests/__init__.py`:
```python
```
(Empty file. Required so `python3 -m unittest discover` finds the package.)

- [ ] **Step 3: Create the fixture pahole output**

File `pahole_extractor/tests/fixtures/sample_pahole.txt`:
```
=== rx::Tiny ===
class Tiny {
	int                        a;                    /*     0     4 */
	/* XXX 4 bytes hole, try to pack */
	long int                   b;                    /*     8     8 */

	/* size: 16, cachelines: 1, members: 2 */
	/* sum members: 12, holes: 1, sum holes: 4 */
};	/* definitions: 1 */
/* /home/x/angle/src/tiny.cc:42 */

=== --reorganize: rx::Tiny ===
class Tiny {
	long int                   b;                    /*     0     8 */
	int                        a;                    /*     8     4 */

	/* size: 16, cachelines: 1, members: 2 */
	/* padding: 4 */
};	/* saved 0 bytes! */

=== rx::Empty ===
class Empty {

	/* size: 1, cachelines: 1, members: 0 */
};
/* /home/x/angle/src/tiny.cc:55 */

=== --reorganize: rx::Empty ===
class Empty {

	/* size: 1, cachelines: 1, members: 0 */
};	/* saved 0 bytes! */
```

- [ ] **Step 4: Create the empty Python module (will be filled in next tasks)**

File `pahole_extractor/lib/pahole_extract.py`:
```python
"""pahole_extract — builds debug .o and emits structured layout artifacts.

Public entry point: main(). Helpers: LayoutParser, IndexWriter, PaholeRunner.
"""

from __future__ import annotations
```

- [ ] **Step 5: Commit**

```
git -C /mnt/f/code2/target_skill add pahole_extractor
git -C /mnt/f/code2/target_skill commit -m "scaffold: pahole_extractor tree + sample fixture"
```

---

### Task 2: LayoutParser — parse pahole output into structured records

TDD: write failing test → implement → pass → commit.

**Files:**
- Create: `pahole_extractor/tests/test_layout_parser.py`
- Modify: `pahole_extractor/lib/pahole_extract.py`

- [ ] **Step 1: Write failing test**

File `pahole_extractor/tests/test_layout_parser.py`:
```python
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lib.pahole_extract import LayoutParser, StructRecord


class TestLayoutParser(unittest.TestCase):
    def setUp(self):
        fixture = ROOT / "tests" / "fixtures" / "sample_pahole.txt"
        self.raw = fixture.read_text()

    def test_parses_two_structs(self):
        records = LayoutParser().parse(self.raw)
        self.assertEqual(len(records), 2)
        self.assertEqual([r.fqname for r in records], ["rx::Tiny", "rx::Empty"])

    def test_tiny_layout_fields(self):
        records = LayoutParser().parse(self.raw)
        tiny = records[0]
        self.assertEqual(tiny.fqname, "rx::Tiny")
        self.assertEqual(tiny.size, 16)
        self.assertEqual(tiny.member_count, 2)
        self.assertEqual(tiny.hole_count, 1)
        self.assertEqual(tiny.hole_bytes, 4)
        self.assertEqual(tiny.file, "/home/x/angle/src/tiny.cc")
        self.assertEqual(tiny.line, 42)

    def test_empty_struct_has_zero_holes(self):
        records = LayoutParser().parse(self.raw)
        empty = records[1]
        self.assertEqual(empty.size, 1)
        self.assertEqual(empty.member_count, 0)
        self.assertEqual(empty.hole_count, 0)
        self.assertEqual(empty.hole_bytes, 0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test (must fail)**

Run: `cd /mnt/f/code2/target_skill/pahole_extractor && python3 -m unittest tests.test_layout_parser -v`
Expected: ImportError on `LayoutParser, StructRecord`.

- [ ] **Step 3: Implement LayoutParser + StructRecord**

Append to `pahole_extractor/lib/pahole_extract.py`:
```python
import re
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class StructRecord:
    fqname: str
    size: int = 0
    member_count: int = 0
    hole_count: int = 0
    hole_bytes: int = 0
    file: Optional[str] = None
    line: Optional[int] = None
    raw_layout: str = ""
    raw_reorganize: str = ""


# Section delimiters used in pahole_raw.txt.
_HEADER_RE = re.compile(r"^=== (?:--reorganize: )?(?P<fqname>[\w:<>, ]+) ===\s*$", re.MULTILINE)
_SIZE_RE = re.compile(r"/\*\s*size:\s*(\d+),\s*cachelines:\s*\d+,\s*members:\s*(\d+)\s*\*/")
_HOLES_RE = re.compile(r"/\*\s*sum members:\s*\d+,\s*holes:\s*(\d+),\s*sum holes:\s*(\d+)\s*\*/")
_DECL_RE = re.compile(r"^/\*\s*(?P<file>[^:]+):(?P<line>\d+)\s*\*/\s*$", re.MULTILINE)


class LayoutParser:
    """Splits a concatenated pahole_raw.txt into per-struct StructRecord objects."""

    def parse(self, text: str) -> List[StructRecord]:
        sections = self._split_sections(text)
        records_by_name = {}
        for fqname, body, is_reorg in sections:
            rec = records_by_name.setdefault(fqname, StructRecord(fqname=fqname))
            if is_reorg:
                rec.raw_reorganize = body
            else:
                rec.raw_layout = body
                self._fill_layout_fields(rec, body)
        return list(records_by_name.values())

    def _split_sections(self, text: str):
        out = []
        matches = list(_HEADER_RE.finditer(text))
        for i, m in enumerate(matches):
            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            body = text[start:end]
            header_line = m.group(0)
            is_reorg = "--reorganize" in header_line
            fqname = m.group("fqname").strip()
            out.append((fqname, body, is_reorg))
        return out

    def _fill_layout_fields(self, rec: StructRecord, body: str):
        m_size = _SIZE_RE.search(body)
        if m_size:
            rec.size = int(m_size.group(1))
            rec.member_count = int(m_size.group(2))
        m_holes = _HOLES_RE.search(body)
        if m_holes:
            rec.hole_count = int(m_holes.group(1))
            rec.hole_bytes = int(m_holes.group(2))
        m_decl = _DECL_RE.search(body)
        if m_decl:
            rec.file = m_decl.group("file").strip()
            rec.line = int(m_decl.group("line"))
```

- [ ] **Step 4: Run test (must pass)**

Run: `cd /mnt/f/code2/target_skill/pahole_extractor && python3 -m unittest tests.test_layout_parser -v`
Expected: `OK` with 3 tests passing.

- [ ] **Step 5: Commit**

```
git -C /mnt/f/code2/target_skill add pahole_extractor
git -C /mnt/f/code2/target_skill commit -m "feat(pahole_extractor): LayoutParser parses raw pahole into StructRecord"
```

---

### Task 3: IndexWriter — emit struct_index.tsv and target_lib.md

**Files:**
- Create: `pahole_extractor/tests/test_index_writer.py`
- Modify: `pahole_extractor/lib/pahole_extract.py`

- [ ] **Step 1: Write failing test**

File `pahole_extractor/tests/test_index_writer.py`:
```python
import unittest
import tempfile
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lib.pahole_extract import IndexWriter, StructRecord


class TestIndexWriter(unittest.TestCase):
    def setUp(self):
        self.records = [
            StructRecord(
                fqname="rx::Big",
                size=2384, member_count=178, hole_count=17, hole_bytes=102,
                file="/home/x/angle/src/big.h", line=2218,
            ),
            StructRecord(
                fqname="rx::Small",
                size=16, member_count=2, hole_count=1, hole_bytes=4,
                file="/home/x/angle/src/small.h", line=42,
            ),
        ]

    def test_tsv_has_header_and_rows(self):
        with tempfile.TemporaryDirectory() as d:
            out_dir = Path(d)
            IndexWriter(workdir="/home/x/angle").write_tsv(self.records, out_dir / "struct_index.tsv")
            lines = (out_dir / "struct_index.tsv").read_text().strip().splitlines()
            self.assertEqual(
                lines[0],
                "fqname\tfile\tline\tsize\tholes\thole_bytes\tmember_count",
            )
            self.assertEqual(len(lines), 3)
            big = lines[1].split("\t")
            self.assertEqual(big[0], "rx::Big")
            # File path made workdir-relative
            self.assertEqual(big[1], "src/big.h")
            self.assertEqual(big[2], "2218")
            self.assertEqual(big[3], "2384")

    def test_target_lib_md_lists_top_by_size(self):
        with tempfile.TemporaryDirectory() as d:
            out_dir = Path(d)
            IndexWriter(workdir="/home/x/angle").write_overview(
                target_lib="myLib",
                records=self.records,
                tus=["src/myLib.cc"],
                obj_files=["out/Debug/myLib.o"],
                out_path=out_dir / "target_lib.md",
            )
            text = (out_dir / "target_lib.md").read_text()
            self.assertIn("# target_lib: myLib", text)
            self.assertIn("Total structs: 2", text)
            self.assertIn("rx::Big", text)
            self.assertIn("## Top 10 by size", text)
            self.assertIn("## Top 10 by hole_bytes", text)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test (must fail)**

Run: `cd /mnt/f/code2/target_skill/pahole_extractor && python3 -m unittest tests.test_index_writer -v`
Expected: ImportError on `IndexWriter`.

- [ ] **Step 3: Implement IndexWriter**

Append to `pahole_extractor/lib/pahole_extract.py`:
```python
import datetime
from pathlib import Path


class IndexWriter:
    """Emits struct_index.tsv and target_lib.md."""

    def __init__(self, workdir: str):
        self.workdir = Path(workdir).resolve()

    def _relpath(self, p: Optional[str]) -> str:
        if not p:
            return ""
        try:
            return str(Path(p).resolve().relative_to(self.workdir))
        except ValueError:
            return p  # outside workdir; keep absolute

    def write_tsv(self, records: List[StructRecord], out_path: Path) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("w") as f:
            f.write("fqname\tfile\tline\tsize\tholes\thole_bytes\tmember_count\n")
            for r in records:
                f.write(
                    f"{r.fqname}\t{self._relpath(r.file)}\t{r.line or ''}\t"
                    f"{r.size}\t{r.hole_count}\t{r.hole_bytes}\t{r.member_count}\n"
                )

    def write_overview(
        self,
        target_lib: str,
        records: List[StructRecord],
        tus: List[str],
        obj_files: List[str],
        out_path: Path,
    ) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z"
        by_size = sorted(records, key=lambda r: r.size, reverse=True)[:10]
        by_holes = sorted(records, key=lambda r: r.hole_bytes, reverse=True)[:10]
        lines = []
        lines.append(f"# target_lib: {target_lib}\n")
        lines.append(f"- Generated: {ts}")
        lines.append(f"- TUs scanned: {', '.join(tus)}")
        lines.append(f"- Object files: {', '.join(obj_files)}")
        lines.append(f"- Total structs: {len(records)}\n")
        lines.append("## Top 10 by size\n")
        lines.append("| fqname | size | holes | hole_bytes |")
        lines.append("|---|---|---|---|")
        for r in by_size:
            lines.append(f"| {r.fqname} | {r.size} | {r.hole_count} | {r.hole_bytes} |")
        lines.append("")
        lines.append("## Top 10 by hole_bytes\n")
        lines.append("| fqname | hole_bytes | size |")
        lines.append("|---|---|---|")
        for r in by_holes:
            lines.append(f"| {r.fqname} | {r.hole_bytes} | {r.size} |")
        out_path.write_text("\n".join(lines) + "\n")
```

- [ ] **Step 4: Run test (must pass)**

Run: `cd /mnt/f/code2/target_skill/pahole_extractor && python3 -m unittest tests.test_index_writer -v`
Expected: `OK` with 2 tests passing.

- [ ] **Step 5: Commit**

```
git -C /mnt/f/code2/target_skill add pahole_extractor
git -C /mnt/f/code2/target_skill commit -m "feat(pahole_extractor): IndexWriter emits struct_index.tsv + target_lib.md"
```

---

### Task 4: PaholeRunner + `main()` — orchestrate build & pahole calls

This task owns the `subprocess` boundary. We don't unit-test subprocess invocation; we test the type-list parsing (deterministic given pahole output).

**Files:**
- Modify: `pahole_extractor/lib/pahole_extract.py`
- Create: `pahole_extractor/tests/fixtures/types_listing.txt`
- Modify: `pahole_extractor/tests/test_layout_parser.py` (add one test for type enumeration)

- [ ] **Step 1: Create the type-listing fixture**

File `pahole_extractor/tests/fixtures/types_listing.txt` — what `pahole --show_private_classes -I <obj>` prints (just type names with decl-info comments):
```
class rx::Tiny {
} /* /home/x/angle/src/tiny.cc:42 */

struct rx::Outer::Inner {
} /* /home/x/angle/src/tiny.cc:60 */

class rx::Empty {
} /* /home/x/angle/src/tiny.cc:55 */
```

- [ ] **Step 2: Write failing test for type enumeration**

Append to `pahole_extractor/tests/test_layout_parser.py`:
```python
class TestTypeEnumerator(unittest.TestCase):
    def test_extracts_type_names(self):
        from lib.pahole_extract import extract_type_names
        fixture = ROOT / "tests" / "fixtures" / "types_listing.txt"
        names = extract_type_names(fixture.read_text())
        self.assertEqual(names, ["rx::Tiny", "rx::Outer::Inner", "rx::Empty"])
```

- [ ] **Step 3: Run test (must fail)**

Run: `cd /mnt/f/code2/target_skill/pahole_extractor && python3 -m unittest tests.test_layout_parser -v`
Expected: ImportError on `extract_type_names`.

- [ ] **Step 4: Implement type enumeration + PaholeRunner + main()**

Append to `pahole_extractor/lib/pahole_extract.py`:
```python
import argparse
import os
import subprocess
import sys


_TYPE_LINE_RE = re.compile(
    r"^(?:class|struct)\s+(?P<fqname>[\w:<>, ]+)\s*\{.*?\}\s*"
    r"(?:/\*\s*[^:]+:\d+\s*\*/)?\s*$",
    re.MULTILINE,
)


def extract_type_names(listing: str) -> List[str]:
    """Parse `pahole --show_private_classes -I <obj>` output for the type names."""
    return [m.group("fqname").strip() for m in _TYPE_LINE_RE.finditer(listing)]


# Initial target_lib → TU mapping. Extend here when new libs are added.
TARGET_LIB_TUS = {
    "vk_helpers": ["src/libANGLE/renderer/vulkan/vk_helpers.cc"],
}


class PaholeRunner:
    """Builds the debug .o, runs pahole, returns text artifacts."""

    def __init__(self, workdir: Path, debug_out: str, depot_tools: str):
        self.workdir = workdir
        self.debug_out = workdir / debug_out
        self.depot_tools = depot_tools

    def ensure_debug_build(self) -> None:
        if not (self.debug_out / "args.gn").exists():
            self.debug_out.mkdir(parents=True, exist_ok=True)
            (self.debug_out / "args.gn").write_text(
                "is_debug = true\nsymbol_level = 2\nangle_assert_always_on = false\n"
            )
            self._run(["gn", "gen", str(self.debug_out)], capture=False)

    def build_object(self, tu_rel: str) -> Path:
        # Query ninja for the .o output path for this TU.
        query = self._run(
            ["ninja", "-C", str(self.debug_out), "-t", "query", tu_rel],
            capture=True, check=False,
        )
        obj_rel = None
        in_outputs = False
        for line in query.splitlines():
            if line.strip() == "outputs:":
                in_outputs = True
                continue
            if in_outputs and line.strip().endswith(".o"):
                obj_rel = line.strip()
                break
        if not obj_rel:
            # Fallback: find by basename
            base = Path(tu_rel).stem + ".o"
            for p in (self.debug_out / "obj").rglob(base):
                obj_rel = str(p.relative_to(self.debug_out))
                break
        if not obj_rel:
            raise RuntimeError(f"could not resolve .o for TU {tu_rel}")
        self._run(["autoninja", "-C", str(self.debug_out), obj_rel], capture=False)
        return self.debug_out / obj_rel

    def list_types(self, obj: Path) -> List[str]:
        listing = self._run(
            ["pahole", "--show_private_classes", "-I", str(obj)],
            capture=True, check=False,
        )
        return extract_type_names(listing)

    def dump_layout(self, obj: Path, fqname: str) -> str:
        return self._run(
            ["pahole", "-C", fqname, str(obj)], capture=True, check=False,
        )

    def dump_reorganize(self, obj: Path, fqname: str) -> str:
        return self._run(
            ["pahole", "--reorganize", "-C", fqname, str(obj)], capture=True, check=False,
        )

    def _run(self, argv: List[str], capture: bool, check: bool = True) -> str:
        env = os.environ.copy()
        env["PATH"] = f"{self.depot_tools}:{env.get('PATH','')}"
        env["DEPOT_TOOLS_UPDATE"] = "0"
        r = subprocess.run(
            argv, cwd=self.workdir, env=env,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
            check=check, text=True,
        )
        return r.stdout if capture else ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", default=os.environ.get("AR_WORKDIR"))
    ap.add_argument("--target-lib", default=os.environ.get("AR_TARGET_LIB", "vk_helpers"))
    ap.add_argument("--debug-out", default=os.environ.get("AR_DEBUG_OUT", "out/Debug-pahole"))
    ap.add_argument("--depot-tools", default=os.environ.get("AR_DEPOT_TOOLS", os.path.expanduser("~/depot_tools")))
    ap.add_argument("--out-dir", default=None,
                    help="default: <script_dir>/../state/<target_lib>")
    args = ap.parse_args()

    if not args.workdir:
        print("error: AR_WORKDIR not set", file=sys.stderr)
        return 2
    tus = TARGET_LIB_TUS.get(args.target_lib)
    if not tus:
        print(f"error: unknown target_lib '{args.target_lib}'", file=sys.stderr)
        return 2

    script_dir = Path(__file__).resolve().parent
    out_dir = Path(args.out_dir) if args.out_dir else script_dir.parent / "state" / args.target_lib
    out_dir.mkdir(parents=True, exist_ok=True)

    runner = PaholeRunner(Path(args.workdir), args.debug_out, args.depot_tools)
    runner.ensure_debug_build()
    obj_files = [runner.build_object(tu) for tu in tus]

    raw_chunks = []
    all_records: List[StructRecord] = []
    for obj in obj_files:
        names = runner.list_types(obj)
        for fq in names:
            layout = runner.dump_layout(obj, fq)
            reorg = runner.dump_reorganize(obj, fq)
            raw_chunks.append(f"=== {fq} ===\n{layout}\n")
            raw_chunks.append(f"=== --reorganize: {fq} ===\n{reorg}\n")
        # Parse this object's output into records.
    raw_text = "".join(raw_chunks)
    (out_dir / "pahole_raw.txt").write_text(raw_text)
    all_records = LayoutParser().parse(raw_text)

    writer = IndexWriter(workdir=args.workdir)
    writer.write_tsv(all_records, out_dir / "struct_index.tsv")
    writer.write_overview(
        target_lib=args.target_lib,
        records=all_records,
        tus=tus,
        obj_files=[str(o.relative_to(Path(args.workdir))) for o in obj_files],
        out_path=out_dir / "target_lib.md",
    )
    print(f"pahole_extractor: wrote {len(all_records)} structs to {out_dir}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Run all extractor tests (must pass)**

Run: `cd /mnt/f/code2/target_skill/pahole_extractor && python3 -m unittest discover -s tests -v`
Expected: 4 tests pass (3 layout + 1 enumeration + 2 writer = 6 actually; expect `Ran 6 tests` `OK`).

- [ ] **Step 6: Commit**

```
git -C /mnt/f/code2/target_skill add pahole_extractor
git -C /mnt/f/code2/target_skill commit -m "feat(pahole_extractor): PaholeRunner + main() orchestrator"
```

---

### Task 5: pahole_extractor — run.sh + SKILL.md

**Files:**
- Create: `pahole_extractor/run.sh`
- Create: `pahole_extractor/SKILL.md`

- [ ] **Step 1: Create run.sh**

File `pahole_extractor/run.sh`:
```bash
#!/usr/bin/env bash
# pahole_extractor — emits raw pahole layouts + struct_index.tsv + target_lib.md
# for a target_lib (default: vk_helpers).
#
# Env in:  AR_WORKDIR (required), AR_TARGET_LIB, AR_DEBUG_OUT, AR_DEPOT_TOOLS
# Out:     state/<target_lib>/{pahole_raw.txt, struct_index.tsv, target_lib.md}

set -euo pipefail
skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$skill_dir/lib/pahole_extract.py" "$@"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x /mnt/f/code2/target_skill/pahole_extractor/run.sh`

- [ ] **Step 3: Create SKILL.md**

File `pahole_extractor/SKILL.md`:
```markdown
---
name: pahole_extractor
description: Use to extract DWARF struct/class layouts for a target translation unit and emit three artifacts (raw layouts, struct_index.tsv, target_lib.md). Pure data — no LLM. Reusable from other skills or a terminal. Configured by AR_TARGET_LIB.
---

# pahole_extractor

Builds a debug `.o` for the requested `target_lib` (currently `vk_helpers`),
then runs `pahole --show_private_classes -I` over every type defined in it.
Outputs three files under `state/<target_lib>/`:

| File | Purpose |
|---|---|
| `pahole_raw.txt` | Concatenated `pahole -C <fqname>` and `pahole --reorganize -C <fqname>` output, struct-delimited with `=== <fqname> ===` headers. |
| `struct_index.tsv` | Tab-separated index: `fqname  file  line  size  holes  hole_bytes  member_count`. Header row included. |
| `target_lib.md` | Human-readable overview: TU(s) scanned, total struct count, top-10 by size, top-10 by hole_bytes. |

## Env (inputs)

| Var | Required | Default |
|---|---|---|
| `AR_WORKDIR` | yes | — |
| `AR_TARGET_LIB` | no | `vk_helpers` |
| `AR_DEBUG_OUT` | no | `out/Debug-pahole` |
| `AR_DEPOT_TOOLS` | no | `~/depot_tools` |

Add new libs by extending `TARGET_LIB_TUS` in `lib/pahole_extract.py`.

## Usage

```bash
AR_WORKDIR=/home/fxy/angle ./run.sh
```

Idempotent: re-running with no source changes is near-instant (ninja cache).
```

- [ ] **Step 4: Smoke test the run.sh entry**

Run: `/mnt/f/code2/target_skill/pahole_extractor/run.sh --help`
Expected: argparse help text printed; exit 0.

- [ ] **Step 5: Commit**

```
git -C /mnt/f/code2/target_skill add pahole_extractor
git -C /mnt/f/code2/target_skill commit -m "feat(pahole_extractor): run.sh entry + SKILL.md"
```

---

### Task 6: parse_output.py (struct_layout_opt) — STATUS-line protocol

Implement the LLM output parser first because it has the smallest surface area, no upstream dependency, and other tasks need to know its file paths exist.

**Files:**
- Create: `struct_layout_opt/lib/parse_output.py`
- Create: `struct_layout_opt/tests/__init__.py`
- Create: `struct_layout_opt/tests/test_parse_output.py`

- [ ] **Step 1: Create directories**

Run:
```
mkdir -p /mnt/f/code2/target_skill/struct_layout_opt/{lib,tests/fixtures,inputs,state}
touch /mnt/f/code2/target_skill/struct_layout_opt/tests/__init__.py
```

- [ ] **Step 2: Write failing test**

File `struct_layout_opt/tests/test_parse_output.py`:
```python
import unittest
import tempfile
from pathlib import Path
import sys
from io import StringIO

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lib.parse_output import parse_and_dispatch


UPDATE_INPUT = """STRUCT: rx::vk::ImageHelper STATUS: update
diff --git a/src/vk_helpers.h b/src/vk_helpers.h
--- a/src/vk_helpers.h
+++ b/src/vk_helpers.h
@@ -1 +1 @@
-old
+new
"""

SKIP_INPUT = "STRUCT: rx::vk::BufferHelper STATUS: cannot_update REASON: already optimal\n"

MALFORMED_INPUT = "Hello, I am a chatbot.\ndiff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n"


class TestParseOutput(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state_dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _read_index(self):
        p = self.state_dir / "empty_struct_index.tsv"
        return p.read_text() if p.exists() else ""

    def test_update_writes_diff_and_appends_index(self):
        out = StringIO()
        rc = parse_and_dispatch(
            stdin_text=UPDATE_INPUT,
            stdout=out,
            state_dir=self.state_dir,
            iter_n=7,
        )
        self.assertEqual(rc, 0)
        self.assertTrue(out.getvalue().startswith("diff --git "))
        idx = self._read_index().splitlines()
        self.assertEqual(idx[0], "fqname\titer\tstatus\treason")
        self.assertEqual(idx[1], "rx::vk::ImageHelper\t7\tupdate\t")

    def test_cannot_update_writes_no_diff_but_appends_index(self):
        out = StringIO()
        rc = parse_and_dispatch(
            stdin_text=SKIP_INPUT,
            stdout=out,
            state_dir=self.state_dir,
            iter_n=2,
        )
        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue(), "")
        idx = self._read_index().splitlines()
        self.assertEqual(idx[1], "rx::vk::BufferHelper\t2\tcannot_update\talready optimal")

    def test_malformed_header_emits_nothing_and_returns_zero(self):
        out = StringIO()
        rc = parse_and_dispatch(
            stdin_text=MALFORMED_INPUT,
            stdout=out,
            state_dir=self.state_dir,
            iter_n=1,
        )
        self.assertEqual(rc, 0)  # never crash the loop
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(self._read_index(), "")  # nothing appended


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run test (must fail)**

Run: `cd /mnt/f/code2/target_skill/struct_layout_opt && python3 -m unittest tests.test_parse_output -v`
Expected: ImportError on `parse_and_dispatch`.

- [ ] **Step 4: Implement parse_output.py**

File `struct_layout_opt/lib/parse_output.py`:
```python
"""parse_output — interpret LLM stdout per the STATUS-line protocol.

Protocol (line 1 always, diff body optional):

    STRUCT: <fqname> STATUS: update
    diff --git a/...
    ...

or

    STRUCT: <fqname> STATUS: cannot_update REASON: <text>

Behavior is defensive: malformed input yields empty stdout + stderr log,
never a non-zero exit. The autoresearch loop treats empty stdout as
ideate-fail and moves on.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import TextIO


HEADER_RE = re.compile(
    r"^STRUCT:\s+(?P<fqname>\S+)\s+STATUS:\s+(?P<status>update|cannot_update)"
    r"(?:\s+REASON:\s+(?P<reason>.+))?\s*$"
)


def parse_and_dispatch(
    stdin_text: str,
    stdout: TextIO,
    state_dir: Path,
    iter_n: int,
) -> int:
    lines = stdin_text.splitlines(keepends=True)
    if not lines:
        print("parse_output: empty input", file=sys.stderr)
        return 0
    header = lines[0].rstrip("\n")
    m = HEADER_RE.match(header)
    if not m:
        print(f"parse_output: malformed header: {header!r}", file=sys.stderr)
        return 0

    fqname = m.group("fqname")
    status = m.group("status")
    reason = m.group("reason") or ""

    _append_index(state_dir, fqname, iter_n, status, reason)

    if status == "update":
        # Strip any prose between header and first 'diff --git'; emit from there.
        rest = "".join(lines[1:])
        diff_start = rest.find("diff --git ")
        if diff_start == -1:
            print("parse_output: update with no diff body", file=sys.stderr)
            return 0
        stdout.write(rest[diff_start:])
    # else cannot_update: nothing on stdout
    return 0


def _append_index(state_dir: Path, fqname: str, iter_n: int, status: str, reason: str) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    idx = state_dir / "empty_struct_index.tsv"
    if not idx.exists():
        idx.write_text("fqname\titer\tstatus\treason\n")
    with idx.open("a") as f:
        f.write(f"{fqname}\t{iter_n}\t{status}\t{reason}\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-lib", default=os.environ.get("AR_TARGET_LIB", "vk_helpers"))
    ap.add_argument("--iter", type=int, default=int(os.environ.get("AR_ITER", "0")))
    ap.add_argument("--state-dir", default=None,
                    help="default: <script_dir>/../state/<target_lib>")
    args = ap.parse_args()

    script_dir = Path(__file__).resolve().parent
    state_dir = Path(args.state_dir) if args.state_dir else script_dir.parent / "state" / args.target_lib
    return parse_and_dispatch(
        stdin_text=sys.stdin.read(),
        stdout=sys.stdout,
        state_dir=state_dir,
        iter_n=args.iter,
    )


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Run test (must pass)**

Run: `cd /mnt/f/code2/target_skill/struct_layout_opt && python3 -m unittest tests.test_parse_output -v`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```
git -C /mnt/f/code2/target_skill add struct_layout_opt
git -C /mnt/f/code2/target_skill commit -m "feat(struct_layout_opt): parse_output dispatches STATUS protocol"
```

---

### Task 7: fuse_context.py — cold-pattern matching

Split into two TDD steps (this one + Task 8) because the file has two distinct responsibilities (parsing knowledge files vs. emitting fused_index.md).

**Files:**
- Create: `struct_layout_opt/lib/fuse_context.py`
- Create: `struct_layout_opt/tests/test_cold_match.py`

- [ ] **Step 1: Write failing test**

File `struct_layout_opt/tests/test_cold_match.py`:
```python
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lib.fuse_context import ColdMatcher

COLD_MD = """# cold

## debug
- mLabel
- ~/.*[Dd]ebug.*/

## init-destruction
- mAllocator
"""


class TestColdMatcher(unittest.TestCase):
    def test_substring_match(self):
        m = ColdMatcher.from_text(COLD_MD)
        self.assertEqual(m.classify("mLabel"), "debug")
        self.assertEqual(m.classify("mAllocator"), "init-destruction")

    def test_case_insensitive_substring(self):
        m = ColdMatcher.from_text(COLD_MD)
        self.assertEqual(m.classify("mLABEL"), "debug")

    def test_regex_match(self):
        m = ColdMatcher.from_text(COLD_MD)
        self.assertEqual(m.classify("mDebugTag"), "debug")
        self.assertEqual(m.classify("myDebugLog"), "debug")

    def test_no_match_returns_none(self):
        m = ColdMatcher.from_text(COLD_MD)
        self.assertIsNone(m.classify("mImage"))

    def test_first_category_wins(self):
        text = "## a\n- foo\n\n## b\n- foo\n"
        m = ColdMatcher.from_text(text)
        self.assertEqual(m.classify("foobar"), "a")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test (must fail)**

Run: `cd /mnt/f/code2/target_skill/struct_layout_opt && python3 -m unittest tests.test_cold_match -v`
Expected: ImportError on `ColdMatcher`.

- [ ] **Step 3: Implement ColdMatcher**

File `struct_layout_opt/lib/fuse_context.py`:
```python
"""fuse_context — fuses pahole extractor outputs with user-authored cold/correlation
hints into a single markdown index for the LLM prompt.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple


_SECTION_RE = re.compile(r"^##\s+(?P<name>[^\n]+?)\s*$", re.MULTILINE)
_BULLET_RE = re.compile(r"^-\s+(?P<item>.+?)\s*$", re.MULTILINE)
_REGEX_PATTERN = re.compile(r"^~/(?P<re>.+)/$")


@dataclass
class ColdPattern:
    category: str
    literal: Optional[str] = None  # substring, case-insensitive
    regex: Optional[re.Pattern] = None


class ColdMatcher:
    """Classifies member names as cold based on cold_path.MD patterns."""

    def __init__(self, patterns: List[ColdPattern]):
        self.patterns = patterns

    @classmethod
    def from_text(cls, text: str) -> "ColdMatcher":
        patterns: List[ColdPattern] = []
        # Walk sections in document order.
        sections = list(_SECTION_RE.finditer(text))
        for i, sec in enumerate(sections):
            name = sec.group("name").strip()
            body_start = sec.end()
            body_end = sections[i + 1].start() if i + 1 < len(sections) else len(text)
            body = text[body_start:body_end]
            for bullet in _BULLET_RE.finditer(body):
                item = bullet.group("item").strip()
                rmatch = _REGEX_PATTERN.match(item)
                if rmatch:
                    patterns.append(ColdPattern(category=name, regex=re.compile(rmatch.group("re"))))
                else:
                    patterns.append(ColdPattern(category=name, literal=item.lower()))
        return cls(patterns)

    def classify(self, name: str) -> Optional[str]:
        n_lower = name.lower()
        for p in self.patterns:
            if p.literal and p.literal in n_lower:
                return p.category
            if p.regex and p.regex.search(name):
                return p.category
        return None
```

- [ ] **Step 4: Run test (must pass)**

Run: `cd /mnt/f/code2/target_skill/struct_layout_opt && python3 -m unittest tests.test_cold_match -v`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```
git -C /mnt/f/code2/target_skill add struct_layout_opt
git -C /mnt/f/code2/target_skill commit -m "feat(struct_layout_opt): ColdMatcher classifies field names"
```

---

### Task 8: fuse_context.py — correlation parser + fused_index writer

**Files:**
- Modify: `struct_layout_opt/lib/fuse_context.py`
- Create: `struct_layout_opt/tests/test_correlation_parse.py`
- Create: `struct_layout_opt/tests/test_fuse_writer.py`
- Create: `struct_layout_opt/tests/fixtures/struct_index.tsv`
- Create: `struct_layout_opt/tests/fixtures/pahole_raw.txt`
- Create: `struct_layout_opt/tests/fixtures/cold_path.MD`
- Create: `struct_layout_opt/tests/fixtures/correlation.MD`
- Create: `struct_layout_opt/tests/fixtures/expected_fused_index.md`

- [ ] **Step 1: Write failing test for correlation parser**

File `struct_layout_opt/tests/test_correlation_parse.py`:
```python
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lib.fuse_context import CorrelationIndex

CORR_MD = """# corr

## G1: Hot path   Occurrence: 100
- a
- b

## G2: Other   Occurrence: 50
- b
- c
"""


class TestCorrelationIndex(unittest.TestCase):
    def test_groups_indexed_by_member(self):
        idx = CorrelationIndex.from_text(CORR_MD)
        self.assertEqual(
            idx.groups_for("a"),
            [("G1: Hot path", 100)],
        )
        self.assertEqual(
            sorted(idx.groups_for("b")),
            sorted([("G1: Hot path", 100), ("G2: Other", 50)]),
        )
        self.assertEqual(idx.groups_for("z"), [])

    def test_all_groups_returns_sorted_by_occurrence_desc(self):
        idx = CorrelationIndex.from_text(CORR_MD)
        gs = idx.all_groups()
        self.assertEqual(gs[0].title, "G1: Hot path")
        self.assertEqual(gs[0].occurrence, 100)
        self.assertEqual(gs[1].occurrence, 50)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Create fixture files**

File `struct_layout_opt/tests/fixtures/struct_index.tsv`:
```
fqname	file	line	size	holes	hole_bytes	member_count
rx::Tiny	src/tiny.cc	42	16	1	4	2
rx::Empty	src/tiny.cc	55	1	0	0	0
```

File `struct_layout_opt/tests/fixtures/pahole_raw.txt`:
```
=== rx::Tiny ===
class Tiny {
	int                        a;                    /*     0     4 */
	long int                   b;                    /*     8     8 */

	/* size: 16, cachelines: 1, members: 2 */
};

=== --reorganize: rx::Tiny ===
class Tiny {
	long int                   b;
	int                        a;

	/* size: 16 */
};	/* saved 0 bytes! */

=== rx::Empty ===
class Empty {

	/* size: 1, cachelines: 1, members: 0 */
};

=== --reorganize: rx::Empty ===
class Empty {
};
```

File `struct_layout_opt/tests/fixtures/cold_path.MD`:
```
## debug
- mLabel
```

File `struct_layout_opt/tests/fixtures/correlation.MD`:
```
## G1: hot   Occurrence: 100
- a
```

File `struct_layout_opt/tests/fixtures/expected_fused_index.md`:
```
# Fused index: testlib

## rx::Tiny   [src/tiny.cc:42]

- size: 16 B • holes: 1 (4 B padding)
- pahole --reorganize: 16 → ? (see pahole_raw.txt)
- prior status: (none)

### Fields (2 total)

| offset | type | name | size | cold? | groups (rank) |
|---|---|---|---|---|---|
| 0 | int | a | 4 | no | G1: hot (100) |
| 8 | long int | b | 8 | no | — |

### Top correlation clusters touching this struct
- G1: hot (100): a

## rx::Empty   [src/tiny.cc:55]

- size: 1 B • holes: 0 (0 B padding)
- pahole --reorganize: 1 → ? (see pahole_raw.txt)
- prior status: (none)

### Fields (0 total)

| offset | type | name | size | cold? | groups (rank) |
|---|---|---|---|---|---|

### Top correlation clusters touching this struct
(none)
```

- [ ] **Step 3: Write failing test for fused_index writer**

File `struct_layout_opt/tests/test_fuse_writer.py`:
```python
import unittest
import tempfile
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lib.fuse_context import build_fused_index


class TestFuseWriter(unittest.TestCase):
    def test_emits_expected_index(self):
        fx = ROOT / "tests" / "fixtures"
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "fused_index.md"
            build_fused_index(
                target_lib="testlib",
                struct_index_tsv=fx / "struct_index.tsv",
                pahole_raw_txt=fx / "pahole_raw.txt",
                cold_md=fx / "cold_path.MD",
                correlation_md=fx / "correlation.MD",
                empty_index_tsv=None,
                out_path=out,
            )
            got = out.read_text().strip()
            expected = (fx / "expected_fused_index.md").read_text().strip()
            self.assertEqual(got, expected)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 4: Run all struct_layout_opt tests (must fail)**

Run: `cd /mnt/f/code2/target_skill/struct_layout_opt && python3 -m unittest discover -s tests -v`
Expected: ImportError on `CorrelationIndex`, `build_fused_index`. Existing parse_output and cold_match tests still pass.

- [ ] **Step 5: Implement CorrelationIndex + build_fused_index**

Append to `struct_layout_opt/lib/fuse_context.py`:
```python
import argparse
import csv
import os
import sys


_OCCURRENCE_RE = re.compile(r"Occurrence:\s*(\d+)", re.IGNORECASE)


@dataclass
class CorrelationGroup:
    title: str
    occurrence: int
    members: List[str] = field(default_factory=list)


class CorrelationIndex:
    def __init__(self, groups: List[CorrelationGroup]):
        self._groups = sorted(groups, key=lambda g: -g.occurrence)
        self._by_member: Dict[str, List[Tuple[str, int]]] = {}
        for g in self._groups:
            for m in g.members:
                self._by_member.setdefault(m, []).append((g.title, g.occurrence))

    @classmethod
    def from_text(cls, text: str) -> "CorrelationIndex":
        sections = list(_SECTION_RE.finditer(text))
        groups: List[CorrelationGroup] = []
        for i, sec in enumerate(sections):
            title = sec.group("name").strip()
            occ_m = _OCCURRENCE_RE.search(title)
            occurrence = int(occ_m.group(1)) if occ_m else 0
            clean_title = _OCCURRENCE_RE.sub("", title).rstrip(" \t-").strip()
            body_start = sec.end()
            body_end = sections[i + 1].start() if i + 1 < len(sections) else len(text)
            members = [m.group("item").strip() for m in _BULLET_RE.finditer(text[body_start:body_end])]
            groups.append(CorrelationGroup(title=clean_title, occurrence=occurrence, members=members))
        return cls(groups)

    def groups_for(self, member: str) -> List[Tuple[str, int]]:
        return list(self._by_member.get(member, []))

    def all_groups(self) -> List[CorrelationGroup]:
        return list(self._groups)


@dataclass
class FieldRow:
    offset: int
    type_str: str
    name: str
    size: int


_FIELD_RE = re.compile(
    r"^\s*(?P<type>.+?)\s+(?P<name>\w+);\s*/\*\s*(?P<offset>\d+)\s+(?P<size>\d+)\s*\*/",
    re.MULTILINE,
)


def _parse_fields_from_layout(layout: str) -> List[FieldRow]:
    rows: List[FieldRow] = []
    for m in _FIELD_RE.finditer(layout):
        rows.append(FieldRow(
            offset=int(m.group("offset")),
            type_str=m.group("type").strip(),
            name=m.group("name"),
            size=int(m.group("size")),
        ))
    return rows


def _read_prior_status(empty_index_tsv: Optional[Path], fqname: str) -> str:
    if not empty_index_tsv or not empty_index_tsv.exists():
        return "(none)"
    notes = []
    with empty_index_tsv.open() as f:
        reader = csv.reader(f, delimiter="\t")
        header = next(reader, None)
        for row in reader:
            if len(row) >= 3 and row[0] == fqname:
                notes.append(f"iter {row[1]}={row[2]}")
    return ", ".join(notes) if notes else "(none)"


def build_fused_index(
    target_lib: str,
    struct_index_tsv: Path,
    pahole_raw_txt: Path,
    cold_md: Path,
    correlation_md: Path,
    empty_index_tsv: Optional[Path],
    out_path: Path,
) -> None:
    # Parse pahole_raw.txt into per-struct layout text blocks.
    raw = pahole_raw_txt.read_text()
    layouts: Dict[str, str] = {}
    sec_re = re.compile(r"^=== (?P<header>[^=\n]+?) ===\s*$", re.MULTILINE)
    matches = list(sec_re.finditer(raw))
    for i, m in enumerate(matches):
        header = m.group("header").strip()
        is_reorg = header.startswith("--reorganize: ")
        if is_reorg:
            continue
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(raw)
        layouts[header] = raw[m.end():body_end]

    # Parse struct_index.tsv for size/file/line.
    struct_meta: Dict[str, Dict[str, str]] = {}
    with struct_index_tsv.open() as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            struct_meta[row["fqname"]] = row

    cold = ColdMatcher.from_text(cold_md.read_text())
    corr = CorrelationIndex.from_text(correlation_md.read_text())

    out_lines: List[str] = [f"# Fused index: {target_lib}\n"]

    for fqname, meta in struct_meta.items():
        out_lines.append(f"## {fqname}   [{meta['file']}:{meta['line']}]\n")
        out_lines.append(
            f"- size: {meta['size']} B • holes: {meta['holes']} ({meta['hole_bytes']} B padding)"
        )
        out_lines.append(
            f"- pahole --reorganize: {meta['size']} → ? (see pahole_raw.txt)"
        )
        out_lines.append(f"- prior status: {_read_prior_status(empty_index_tsv, fqname)}\n")

        fields = _parse_fields_from_layout(layouts.get(fqname, ""))
        out_lines.append(f"### Fields ({len(fields)} total)\n")
        out_lines.append("| offset | type | name | size | cold? | groups (rank) |")
        out_lines.append("|---|---|---|---|---|---|")
        for fld in fields:
            tag = cold.classify(fld.name)
            cold_cell = f"yes ({tag})" if tag else "no"
            groups = corr.groups_for(fld.name)
            groups_cell = ", ".join(f"{t} ({o})" for t, o in groups) if groups else "—"
            out_lines.append(
                f"| {fld.offset} | {fld.type_str} | {fld.name} | {fld.size} | {cold_cell} | {groups_cell} |"
            )
        out_lines.append("")

        out_lines.append("### Top correlation clusters touching this struct")
        names = {fld.name for fld in fields}
        touching = [
            g for g in corr.all_groups() if any(m in names for m in g.members)
        ][:5]
        if not touching:
            out_lines.append("(none)")
        else:
            for g in touching:
                members_in_struct = [m for m in g.members if m in names]
                out_lines.append(
                    f"- {g.title} ({g.occurrence}): {', '.join(members_in_struct)}"
                )
        out_lines.append("")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(out_lines).rstrip() + "\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-lib", default=os.environ.get("AR_TARGET_LIB", "vk_helpers"))
    ap.add_argument("--iter", type=int, default=int(os.environ.get("AR_ITER", "0")))
    args = ap.parse_args()

    script_dir = Path(__file__).resolve().parent
    skill_dir = script_dir.parent
    extractor_state = skill_dir.parent / "pahole_extractor" / "state" / args.target_lib
    own_state = skill_dir / "state" / args.target_lib
    own_state.mkdir(parents=True, exist_ok=True)

    build_fused_index(
        target_lib=args.target_lib,
        struct_index_tsv=extractor_state / "struct_index.tsv",
        pahole_raw_txt=extractor_state / "pahole_raw.txt",
        cold_md=skill_dir / "inputs" / "cold_path.MD",
        correlation_md=skill_dir / "inputs" / "correlation.MD",
        empty_index_tsv=own_state / "empty_struct_index.tsv",
        out_path=own_state / "fused_index.md",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 6: Run all struct_layout_opt tests (must pass)**

Run: `cd /mnt/f/code2/target_skill/struct_layout_opt && python3 -m unittest discover -s tests -v`
Expected: 10 tests pass (3 parse_output + 5 cold + 2 correlation + 1 fuse_writer = 11; actual count may vary by 1 — verify `OK`).

- [ ] **Step 7: Commit**

```
git -C /mnt/f/code2/target_skill add struct_layout_opt
git -C /mnt/f/code2/target_skill commit -m "feat(struct_layout_opt): CorrelationIndex + build_fused_index"
```

---

### Task 9: Knowledge inputs — rules.MD, cold_path.MD, correlation.MD

**Files:**
- Create: `struct_layout_opt/inputs/rules.MD`
- Create: `struct_layout_opt/inputs/cold_path.MD`
- Create: `struct_layout_opt/inputs/correlation.MD`

- [ ] **Step 1: Create rules.MD**

File `struct_layout_opt/inputs/rules.MD`:
```markdown
# Struct cache-layout rules

Apply these in order. The first three are mandatory; the rest are
context-dependent.

## Mandatory (the basics)

1. **Hot fields first, contiguous.** Members accessed in tight loops live at
   the top of the struct.
2. **Within the hot group, sort by alignment descending.** 8-byte aligned
   first (uint64_t, pointers, double), then 4-byte (uint32_t, float), then
   2-byte, then 1-byte. Minimizes padding holes.
3. **Cold fields at the bottom; shrink them in place.** Cold = fields listed
   (fuzzy-matched) in cold_path.MD. Common shrinks: uint64_t timestamp →
   uint32_t delta; multiple bools → packed uint32_t flags; rare enum →
   uint8_t.

## Conditional (use when warranted)

4. Keep hot fields within one 64-byte cache line when possible. Don't force
   packing — false sharing hurts.
5. Pack high-Occurrence correlation groups (from correlation.MD) tightly.
   Same-group members should sit within one cache line.
6. Nested "section" struct for readability — still one outer struct.
7. Cache-line partitioning (align(64) on the struct + pad before cold) only
   if hot/cold contention is measured; otherwise it wastes memory.

## Anti-tactics — don't do these

- No `__attribute__((aligned(64)))` on the whole class.
- No `#pragma pack(1)`.
- No renames. Layout-only changes.

## Cached vs uncached prioritization

- If the workload is mostly **cached** (working set fits in LLC/L2/L1):
  prioritize rules 1–4. Hot contiguity matters more than overall size.
- If the workload is mostly **uncached / bandwidth-bound**: prioritize
  rules 1, 3, and overall size reduction. Avoid cache-line partitioning
  padding — it grows footprint.
```

- [ ] **Step 2: Create cold_path.MD demo**

File `struct_layout_opt/inputs/cold_path.MD`:
```markdown
# cold_path.MD — fuzzy hints for cold members

fuse_context.py matches each field name against the patterns below,
case-insensitively. Patterns are literal substrings unless prefixed with
`~/.../` (regex). The first matching category becomes the field's cold_tag.

Edit this file to match the access patterns you know.

## debug
- mLabel
- mDebugLabel
- ~/.*[Dd]ebug.*/
- ~/.*[Ll]og.*/

## init-destruction
- mInitial
- mAllocationFlags
- mOwner
- mAllocator
- mMemoryAllocationType

## format-helper
- mFormatFeatures
- mViewFormats
- ~/.*[Ff]ormatHelp.*/

## rare-config
- mYcbcrConversionDesc
- mTilingMode
- mExternalFormat
```

- [ ] **Step 3: Create correlation.MD demo**

File `struct_layout_opt/inputs/correlation.MD`:
```markdown
# correlation.MD — member co-occurrence groups

Higher Occurrence = stronger relationship. Goal: pack same-group members
into one 64-byte cache line. Replace these demo values with real
perf-derived data when you have it.

## Group 1: Layout transition   Occurrence: 8741
- mCurrentLayout
- mCurrentQueueFamilyIndex
- mImage
- mUsage

## Group 2: Sub-resource barrier   Occurrence: 5230
- mLayerCount
- mLevelCount
- mFirstLayer
- mBaseLevel
- mCurrentLayout

## Group 3: Format / dimension query   Occurrence: 3104
- mFormat
- mExtents
- mSamples
- mImageType
```

- [ ] **Step 4: Commit**

```
git -C /mnt/f/code2/target_skill add struct_layout_opt/inputs
git -C /mnt/f/code2/target_skill commit -m "feat(struct_layout_opt): seed rules/cold/correlation input files"
```

---

### Task 10: prompt.tmpl + run.sh + SKILL.md

**Files:**
- Create: `struct_layout_opt/prompt.tmpl`
- Create: `struct_layout_opt/run.sh`
- Create: `struct_layout_opt/SKILL.md`

- [ ] **Step 1: Create prompt.tmpl**

File `struct_layout_opt/prompt.tmpl`:
```
You are a struct memory layout optimizer for performance-sensitive C++ code.

Your task: emit a STATUS line (always) and a unified diff (when status=update)
that reorders / aligns / clusters fields of the target type to improve cache
behavior and increase the benchmark metric in the direction the user specified.

# Output protocol — VERY STRICT

The framework parses your stdout. Anything off-protocol will be rejected.

Line 1 of your reply MUST match exactly one of these two shapes:

  STRUCT: <fully::qualified::name> STATUS: update
  STRUCT: <fully::qualified::name> STATUS: cannot_update REASON: <short text>

If STATUS=update, lines 2+ MUST be a valid unified diff that begins with
"diff --git a/<path> b/<path>". No prose, no fences, no blank line before
the diff. The very last character of your reply MUST be the final newline
of the last hunk.

If STATUS=cannot_update, output ONLY line 1 — nothing else. Use this when
the layout is already near-optimal or you have no useful change to propose.

# Strategy — read in order

1. Read inputs/rules.MD below for the optimization rules. The first three
   are mandatory; rules 4–7 are conditional.
2. Read state/<target_lib>/fused_index.md — this is the digested per-struct
   view with cold tags and correlation groups already pre-computed.
3. Read inputs/cold_path.MD for the raw cold-field hints (the fuse already
   applied them, but you can override based on actual access patterns).
4. Read inputs/correlation.MD for the raw correlation groups.
5. Cross-check with the recent git log and TSV history (included via stdin
   below). Avoid replaying layouts that lost. If recent iterations have
   plateaued, try a more aggressive change. If recent iterations are
   regressing, try a smaller, more conservative one.

# Picking which struct to touch this iter

You see many structs in fused_index.md. Pick ONE per iteration. Prefer:
- Structs not yet marked update or cannot_update in the prior-status line.
- Structs with high hole_bytes (free wins available).
- Structs with hot members spanning multiple cache lines (clustering wins).

Skip with STATUS: cannot_update when:
- The struct is already optimally laid out (pahole --reorganize delta ≤ 1B).
- The hot/cold pattern is unclear.
- You don't have enough signal to improve over a prior keep.

# Anti-tactics — don't do these

- No __attribute__((aligned(64))) on the whole class.
- No #pragma pack(1).
- Don't rename fields. Layout-only changes.
- Touch only files in $AR_SCOPE.
```

- [ ] **Step 2: Create run.sh**

File `struct_layout_opt/run.sh`:
```bash
#!/usr/bin/env bash
# struct_layout_opt — orchestrator invoked by autoresearch.
#
# Pipeline:
#   1. Run pahole_extractor (sibling skill) to refresh state/<target_lib>/.
#   2. Run fuse_context.py to produce fused_index.md.
#   3. Build prompt = prompt.tmpl + rules + cold + correlation + fused_index
#      + stdin (autoresearch's git log + tsv tail). Pipe to $IDEATE_CLI.
#   4. Pipe LLM stdout through parse_output.py: appends STATUS to
#      empty_struct_index.tsv; forwards diff body to autoresearch.

set -euo pipefail

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ideate_cli="${IDEATE_CLI:-claude -p}"
target_lib="${AR_TARGET_LIB:-vk_helpers}"
iter_n="${AR_ITER:-0}"

# stdin from autoresearch (git log + tsv tail) — preserve verbatim.
ctx="$(cat)"

# Phase 1: extract.
bash "$skill_dir/../pahole_extractor/run.sh" \
  --target-lib "$target_lib"

# Phase 2: fuse.
python3 "$skill_dir/lib/fuse_context.py" \
  --target-lib "$target_lib" --iter "$iter_n"

extractor_state="$skill_dir/../pahole_extractor/state/$target_lib"
own_state="$skill_dir/state/$target_lib"

# Phase 3: build prompt and ideate.
src_blob=""
prompt_paths="${AR_PROMPT_SCOPE:-${AR_SCOPE:-}}"
if [ -n "$prompt_paths" ] && [ -n "${AR_WORKDIR:-}" ]; then
  IFS=':' read -ra paths <<< "$prompt_paths"
  for rel in "${paths[@]}"; do
    abs="$AR_WORKDIR/$rel"
    if [ -f "$abs" ]; then
      src_blob+=$'\n=== '"$rel"$' ===\n'
      src_blob+="$(cat "$abs")"
    fi
  done
fi

prompt="$(cat "$skill_dir/prompt.tmpl")

# Goal
${AR_GOAL:-(unspecified)}

# Scope
${AR_SCOPE:-(unspecified)}

# inputs/rules.MD
$(cat "$skill_dir/inputs/rules.MD")

# inputs/cold_path.MD
$(cat "$skill_dir/inputs/cold_path.MD")

# inputs/correlation.MD
$(cat "$skill_dir/inputs/correlation.MD")

# state/$target_lib/fused_index.md
$(cat "$own_state/fused_index.md")

# Context (git log + tsv tail)
$ctx

# Source files
$src_blob
"

# Phase 4: ideate + parse.
printf '%s' "$prompt" \
  | $ideate_cli \
  | python3 "$skill_dir/lib/parse_output.py" \
      --target-lib "$target_lib" --iter "$iter_n"
```

- [ ] **Step 3: Make run.sh executable**

Run: `chmod +x /mnt/f/code2/target_skill/struct_layout_opt/run.sh`

- [ ] **Step 4: Create SKILL.md**

File `struct_layout_opt/SKILL.md`:
```markdown
---
name: struct_layout_opt
description: Use when optimizing C/C++ struct memory layout for cache efficiency. Pipeline: runs sibling pahole_extractor, fuses output with user-authored cold_path.MD + correlation.MD, drives a strict STATUS-line LLM protocol, maintains a persistent per-struct worklist. Invoked by autoresearch as `${skillDir}/run.sh`.
---

# struct_layout_opt

Replaces the older struct_cache_opt skill. Splits responsibility:

- pahole_extractor (sibling) emits raw layout data.
- struct_layout_opt fuses that with knowledge files, runs the LLM, parses output.

## Inputs

| Channel | Content |
|---|---|
| `$AR_WORKDIR` | ANGLE worktree (passed to pahole_extractor). |
| `$AR_TARGET_LIB` | Default `vk_helpers`. Extend TARGET_LIB_TUS in pahole_extractor when adding new libs. |
| `$AR_SCOPE`, `$AR_PROMPT_SCOPE` | Scope guard (used by autoresearch git apply) and prompt scope (which source files to inline). |
| `$AR_ITER` | Iteration number; recorded in empty_struct_index.tsv. |
| `$IDEATE_CLI` | CLI tool (default `claude -p`). |
| stdin | Autoresearch heredoc: git log + tsv tail. |

## Outputs

A unified diff on stdout (or empty stdout if STATUS=cannot_update or parse failure).

## State

| File | Lifecycle |
|---|---|
| `state/<lib>/fused_index.md` | Regenerated each iter. |
| `state/<lib>/empty_struct_index.tsv` | Append-only, persistent across iters. AI marks structs `update` or `cannot_update`. |

## LLM output protocol

```
STRUCT: <fqname> STATUS: update
diff --git a/...
...
```

or

```
STRUCT: <fqname> STATUS: cannot_update REASON: <text>
```

Parsed by `lib/parse_output.py` — defensively, never crashes the loop.

## Knowledge files

`inputs/rules.MD`, `inputs/cold_path.MD`, `inputs/correlation.MD` — edit
these to teach the optimizer your access-pattern knowledge.
```

- [ ] **Step 5: Smoke-test run.sh wiring with IDEATE_CLI=cat**

Verifies parse_output gets a STATUS line through the pipe. Skip pahole/build stages by stubbing them. Run:

```bash
# Quick offline check that the prompt is non-empty and the parser sees the protocol.
cd /mnt/f/code2/target_skill/struct_layout_opt
echo "STRUCT: rx::Tiny STATUS: cannot_update REASON: smoke" \
  | python3 lib/parse_output.py --target-lib vk_helpers --iter 0 \
      --state-dir /tmp/struct_layout_opt_smoke
test -f /tmp/struct_layout_opt_smoke/empty_struct_index.tsv
tail -1 /tmp/struct_layout_opt_smoke/empty_struct_index.tsv
rm -rf /tmp/struct_layout_opt_smoke
```
Expected: tail prints `rx::Tiny	0	cannot_update	smoke`.

- [ ] **Step 6: Commit**

```
git -C /mnt/f/code2/target_skill add struct_layout_opt
git -C /mnt/f/code2/target_skill commit -m "feat(struct_layout_opt): prompt.tmpl + run.sh + SKILL.md"
```

---

### Task 11: Delete struct_cache_opt and update vk-image-helper.yml

**Files:**
- Delete: `/mnt/f/code2/target_skill/struct_cache_opt/` (entire dir)
- Modify: `/mnt/f/code2/struct_cache_opt/vk-image-helper.yml`

- [ ] **Step 1: Delete old skill dir**

Run:
```
git -C /mnt/f/code2/target_skill rm -r struct_cache_opt
```

- [ ] **Step 2: Commit deletion**

```
git -C /mnt/f/code2/target_skill commit -m "chore: remove struct_cache_opt (replaced by struct_layout_opt)"
```

- [ ] **Step 3: Update vk-image-helper.yml skillDir**

Edit `/mnt/f/code2/struct_cache_opt/vk-image-helper.yml` — find this block:
```yaml
# ── Skill ────────────────────────────────────────────────────────────────────
# struct_cache_opt skill = the LLM-driven diff generator.
# Lives under /mnt/f/code2/target_skill/, which is itself a git repo so
# edits to the skill (prompt.tmpl, helpers, etc.) are versioned alongside
# experiment results.
skillDir: /mnt/f/code2/target_skill/struct_cache_opt
```

Replace with:
```yaml
# ── Skill ────────────────────────────────────────────────────────────────────
# struct_layout_opt skill = the LLM-driven diff generator.
# Sibling skill pahole_extractor is invoked by struct_layout_opt internally.
# Both live under /mnt/f/code2/target_skill/, versioned in that repo.
skillDir: /mnt/f/code2/target_skill/struct_layout_opt
```

- [ ] **Step 4: Commit yml change in struct_cache_opt repo**

```
cd /mnt/f/code2/struct_cache_opt
git add vk-image-helper.yml
git commit -m "chore(yml): point skillDir at struct_layout_opt (renamed)"
```

(Note: This commits to the autoresearch repo, not target_skill. Both repos get one commit each in this task.)

---

### Task 12: End-to-end smoke test against the live ANGLE workdir

Verifies the wired pipeline produces non-empty fused_index for vk_helpers. **Does not** invoke the LLM (no cost); uses IDEATE_CLI=cat as a stub.

**Files:** none (read-only check)

- [ ] **Step 1: Run pahole_extractor against ANGLE**

Run:
```bash
AR_WORKDIR=/home/fxy/angle \
  /mnt/f/code2/target_skill/pahole_extractor/run.sh
```
Expected: First run takes ~30–90s (debug build). Last line on stderr: `pahole_extractor: wrote N structs to .../state/vk_helpers`. N > 0.

- [ ] **Step 2: Inspect artifacts**

Run:
```bash
ls -la /mnt/f/code2/target_skill/pahole_extractor/state/vk_helpers/
head -3 /mnt/f/code2/target_skill/pahole_extractor/state/vk_helpers/struct_index.tsv
```
Expected: three files exist; TSV header + at least one data row visible.

- [ ] **Step 3: Run fuser**

Run:
```bash
cd /mnt/f/code2/target_skill/struct_layout_opt
python3 lib/fuse_context.py --target-lib vk_helpers --iter 0
test -s state/vk_helpers/fused_index.md
head -20 state/vk_helpers/fused_index.md
```
Expected: file is non-empty; first line is `# Fused index: vk_helpers`.

- [ ] **Step 4: Pipe a fake LLM through the full orchestrator**

Run:
```bash
cd /mnt/f/code2/target_skill/struct_layout_opt
echo "STRUCT: rx::vk::ImageHelper STATUS: cannot_update REASON: smoke" \
  > /tmp/fake_ideate.sh
chmod +x /tmp/fake_ideate.sh
printf '%s\n' '#!/usr/bin/env bash' 'cat /tmp/fake_ideate_payload.txt' > /tmp/fake_ideate.sh
echo "STRUCT: rx::vk::ImageHelper STATUS: cannot_update REASON: e2e-smoke" \
  > /tmp/fake_ideate_payload.txt
chmod +x /tmp/fake_ideate.sh

AR_WORKDIR=/home/fxy/angle AR_TARGET_LIB=vk_helpers AR_ITER=999 \
  IDEATE_CLI=/tmp/fake_ideate.sh \
  AR_SCOPE=src/libANGLE/renderer/vulkan/vk_helpers.h \
  bash ./run.sh < /dev/null

tail -1 state/vk_helpers/empty_struct_index.tsv
```
Expected: last line `rx::vk::ImageHelper	999	cannot_update	e2e-smoke`. Stdout of run.sh is empty (because cannot_update). No error exit.

- [ ] **Step 5: Cleanup smoke artifacts**

Run: `rm -f /tmp/fake_ideate.sh /tmp/fake_ideate_payload.txt`

- [ ] **Step 6: Commit a marker (optional) for the e2e milestone**

```
git -C /mnt/f/code2/target_skill commit --allow-empty -m "chore: e2e smoke passed"
```

---

### Task 13: Full test suite green check

- [ ] **Step 1: Run all extractor tests**

Run: `cd /mnt/f/code2/target_skill/pahole_extractor && python3 -m unittest discover -s tests -v`
Expected: all tests pass.

- [ ] **Step 2: Run all opt tests**

Run: `cd /mnt/f/code2/target_skill/struct_layout_opt && python3 -m unittest discover -s tests -v`
Expected: all tests pass.

- [ ] **Step 3: Confirm git status clean across both repos**

Run:
```
git -C /mnt/f/code2/target_skill status
git -C /mnt/f/code2/struct_cache_opt status
```
Expected: both report a clean working tree (or only the expected new files committed).

---

## Self-Review Notes

- **Spec coverage:** Tasks 1–5 cover §3, §4, §5.1–5.2, §6.1–6.3 (pahole_extractor). Tasks 6–10 cover §5.3–5.6, §6.4–6.8, §7 (struct_layout_opt). Task 11 covers §10 (migration). Task 12 is the §9 end-to-end test. Task 13 is the regression gate.
- **No placeholders:** every step has either a command + expected output, a file path + complete content, or an explicit "Expected: …" assertion.
- **Type consistency:** `StructRecord`, `ColdMatcher`, `CorrelationIndex`, `parse_and_dispatch`, `build_fused_index` are referenced by the same names everywhere.
- **Frequent commits:** 1 commit per task (sometimes 2 — code + yml in Task 11).
