#!/usr/bin/env python3
"""Roadmap dependencies:  python3 tests/test_roadmap.py"""
import tempfile

from _path import ROOT
from config import ConfigError
from model import build_document

FIX = ROOT / "tests" / "fixtures"
OUT = tempfile.mkdtemp()


def roadmap(name, config=None):
    d = build_document(FIX / name, config or {}, {}, OUT)
    return d.model["roadmap"], d.warnings


def short(i):
    return "P" + i.split("-")[1]


# TaskForge section 14: the stated graph, with P5's partial need on P4 and P9's parallel note.
r, w = roadmap("taskforge-roadmap.md")
assert r["basis"] == "titles" and len(r["ids"]) == 10  # "### Phase N" subsections are the stages
got = {short(s): [short(d["id"]) + ("?" if "qualified" in d else "") for d in r["dependencies"][s]] for s in r["ids"]}
assert got == {
    "P1": [], "P2": ["P1"], "P3": ["P2"], "P4": ["P2", "P3"], "P5": ["P2", "P4?"], "P6": ["P5"], "P7": ["P6"],
    "P8": ["P4", "P5"], "P9": ["P4", "P6"], "P10": ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"],
}, got
assert {short(k): [short(x) for x in v] for k, v in r["parallel"].items()} == {"P9": ["P7", "P8"]}
p5 = r["dependencies"]["phase-5-redis-queue-and-scheduler-dispatch"]
assert p5[1]["qualified"] == "The API fast path needs P4."
lines = (FIX / "taskforge-roadmap.md").read_text().splitlines()
assert all("**Dependencies:**" in lines[d["line"] - 1] for ds in r["dependencies"].values() for d in ds)
assert r["cycles"] == [] and not [x for x in w if x.startswith("roadmap")]

# Formats, missing references, cycles, unknown dependencies.
r, w = roadmap("roadmap-deps.md")
deps = {short(s): [short(d["id"]) for d in r["dependencies"][s]] for s in r["dependencies"]}
assert deps == {"P1": [], "P2": ["P1"], "P3": ["P1", "P2"], "P4": ["P2", "P1"], "P5": ["P6"], "P6": ["P5"]}, deps
assert "phase-7-retro" not in r["dependencies"]  # no dependency line: unknown, not "none"
assert r["parallel"] == {"phase-3-api": ["phase-4-web-app"]}  # "in parallel" is never a dependency
assert r["cycles"] == [["phase-5-launch", "phase-6-docs"]]
assert any("refers to stage 9, which is not a roadmap stage" in x for x in w)
assert any("dependency cycle" in x for x in w)

# config.json can state dependencies the text leaves ambiguous; they replace the document's for that stage.
r, _ = roadmap("roadmap-deps.md", {"dependencies": {"phase-7-retro": ["phase-5-launch", "phase-6-docs"]}})
assert r["dependencies"]["phase-7-retro"] == [{"id": "phase-5-launch", "source": "config"},
                                               {"id": "phase-6-docs", "source": "config"}]
for bad, msg in (({"phase-7-retro": ["phase-99"]}, "unknown section id 'phase-99'"),
                 (["phase-1-setup"], "must look like")):
    try:
        roadmap("roadmap-deps.md", {"dependencies": bad})
        raise AssertionError(f"should be refused: {bad}")
    except ConfigError as e:
        assert msg in str(e), e

# Numbered top-level sections ("1. Executive summary") don't hide phase subsections.
from parse import build_model  # noqa: E402
m = build_model("# P\n\n## 1. Summary\n\nx\n\n## 2. Roadmap\n\n### Phase 1 — A\n\n### Phase 2 — B\n", "p")
assert m["roadmap"] == {"ids": ["phase-1-a", "phase-2-b"], "basis": "titles"}, m["roadmap"]

# A document without dependency lines has none recorded (the roadmap stays a plain sequence).
r, _ = roadmap("headings.md")
assert r["dependencies"] == {} and r["parallel"] == {} and r["cycles"] == []
print("ok")
