#!/usr/bin/env python3
"""File references: normalisation, aliases, on-disk status:  python3 tests/test_files.py"""
import subprocess
import tempfile
from pathlib import Path

from _path import ROOT
from model import build_document
from parse import parse_file

FIX = ROOT / "tests" / "fixtures" / "file-references.md"

# Pure text: shortened references merge into the one longer path they end with.
files = {f["path"]: f for f in parse_file(FIX)["files"]}
assert sorted(files) == ["../shared/settings.py", "main.py", "src/app/cli/main.py", "src/app/config.py",
                         "src/app/db/models.py", "src/app/scheduler/main.py", "src/app/scheduler/reaper.py"], sorted(files)
assert files["src/app/config.py"]["aliases"] == ["config.py"]
assert files["src/app/db/models.py"]["aliases"] == ["db/models.py"]
assert files["src/app/scheduler/reaper.py"]["aliases"] == ["scheduler/reaper.py"]  # from "{main,reaper}.py"
# Every original mention is kept, in line order, with its section.
assert [m["line"] for m in files["src/app/config.py"]["mentions"]] == [5, 9]
assert [m["at"] for m in files["src/app/config.py"]["mentions"]] == ["layout", "shortened-references"]
# "main.py" could be two files: left alone, with both candidates; "../" paths are never merged.
assert files["main.py"]["candidates"] == ["src/app/cli/main.py", "src/app/scheduler/main.py"]
assert "aliases" not in files["../shared/settings.py"]

# On disk: in a git repository, existing files are marked, the rest are planned.
with tempfile.TemporaryDirectory() as d:
    repo = Path(d)
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / "src/app/db").mkdir(parents=True)
    (repo / "src/app/db/models.py").write_text("")
    (repo / "src/app/config.py").write_text("")
    (repo / "lib/util").mkdir(parents=True)
    (repo / "lib/util/helpers.py").write_text("")
    (repo / "docs").mkdir()
    plan = repo / "docs" / "plan.md"
    plan.write_text(FIX.read_text() + "\nAlso `helpers.py`, `util/helpers.py` and `new/thing.py`.\n")
    doc = build_document(plan, {}, {}, repo / ".too-long")
    st = {f["path"]: (f["status"], f.get("resolved")) for f in doc.model["files"]}
    assert doc.model["files_root"] == "repository"
    assert st["src/app/config.py"] == ("exists", None)       # found from the repository root, not docs/
    assert st["src/app/db/models.py"] == ("exists", None)
    assert st["src/app/scheduler/reaper.py"] == ("planned", None)  # not created yet: not claimed to exist
    assert st["main.py"][0] == "ambiguous"
    # "helpers.py" merges into "util/helpers.py", which the repository has in exactly one place.
    assert st["util/helpers.py"] == ("exists", "lib/util/helpers.py") and "helpers.py" not in st
    assert st["new/thing.py"] == ("planned", None)

# Outside a repository, paths are checked from the Markdown's folder only.
with tempfile.TemporaryDirectory() as d:
    folder = Path(d)
    (folder / "src/app").mkdir(parents=True)
    (folder / "src/app/config.py").write_text("")
    plan = folder / "plan.md"
    plan.write_text(FIX.read_text())
    doc = build_document(plan, {}, {}, folder / ".too-long")
    st = {f["path"]: f["status"] for f in doc.model["files"]}
    assert doc.model["files_root"] == "folder"
    assert st["src/app/config.py"] == "exists" and st["src/app/db/models.py"] == "planned"
print("ok")
