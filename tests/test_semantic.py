#!/usr/bin/env python3
"""Semantic snapshots of realistic plans:  python3 tests/test_semantic.py [--update]

For each plan, the meaning too-long extracts (highlights with their rejected alternatives and
details, stage dependencies, merged file references) is compared with tests/golden/semantic/.
Review the diff after --update: every change there is a change in what readers are told.
"""
import json
import sys
import tempfile

from _path import ROOT
from model import build_document

PLANS = ["realworld-plan.md", "taskforge-decisions.md", "taskforge-risks.md", "taskforge-roadmap.md", "risk-formats.md"]
GOLDEN = ROOT / "tests" / "golden" / "semantic"


def snapshot(name):
    m = build_document(ROOT / "tests" / "fixtures" / name, {}, {}, tempfile.mkdtemp()).model
    r = m["roadmap"]
    return {
        "highlights": [{k: v for k, v in {
            "kind": c["kind"], "number": c.get("number"), "title": c["title"], "line": c["line"],
            "details": [f'{d["label"]}: {d["text"]}' for d in c["details"]] or None,
            "rejected": [x["text"] for x in c["rejected"]] or None,
            "from_heading": c.get("from_heading"),
        }.items() if v is not None} for c in m["callouts"]],
        "roadmap": {
            "stages": r["ids"],
            "dependencies": {s: [d["id"] + (" (partly)" if "qualified" in d else "") for d in ds] for s, ds in r["dependencies"].items()},
            "parallel": r["parallel"], "cycles": r["cycles"],
        },
        "tasks": [f'{t["id"]} L{t["line"]}' for t in m["tasks"]],
        "files": [{k: v for k, v in {"path": f["path"], "aliases": f.get("aliases"), "candidates": f.get("candidates")}.items() if v}
                  for f in m["files"]],
    }


update = "--update" in sys.argv
GOLDEN.mkdir(exist_ok=True)
for name in PLANS:
    snap = snapshot(name)
    path = GOLDEN / name.replace(".md", ".json")
    if update:
        path.write_text(json.dumps(snap, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    else:
        assert snap == json.loads(path.read_text(encoding="utf-8")), f"{name}: meaning changed (run with --update, review the diff)"

# Things the snapshot can't show: what was refused and why.
doc = build_document(ROOT / "tests" / "fixtures" / "realworld-plan.md", {}, {}, tempfile.mkdtemp())
w = " | ".join(doc.warnings)
assert "could not tell which stages 'phase-4-cut-over' depends on" in w  # ambiguous: unknown, not "none"
assert "'phase-5-cleanup' refers to stage 7, which is not a roadmap stage" in w
assert "phase-4-cut-over" not in doc.model["roadmap"]["dependencies"]
print("updated" if update else "ok")
