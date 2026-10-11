#!/usr/bin/env python3
"""Every extracted item points at the source line it came from:  python3 tests/test_traceability.py"""
import re

from _path import ROOT
from parse import build_model, parse_file, section_ids

docs = sorted((ROOT / "tests" / "fixtures").glob("*.md")) + [ROOT / "examples" / "trailhead-plan.md"]


def words(s):
    return re.findall(r"\w+", re.sub(r"\[[^\]]*\]\([^)]*\)", "", s))


for path in docs:
    m = parse_file(path)
    lines = path.read_text(encoding="utf-8").splitlines()
    at = lambda n: lines[n - 1]  # noqa: E731

    for s in m["sections"] + [x for s in m["sections"] for x in s["subsections"]]:
        assert s["title"] in at(s["line"]) or s["title"] == at(s["line"]).strip(), (path.name, s["id"], s["line"])
    for t in m["tasks"]:
        line = at(t["line"])
        assert re.match(r"\s*([-*+]|\d+[.)])\s", line), (path.name, t["line"], line)
        first = words(t["text"])[:1]
        assert all(w in line for w in first), (path.name, t["id"], t["line"], line)
    for c in m["callouts"]:
        assert at(c["line"]).strip(), (path.name, c)
    for d in m["diagrams"]:
        assert at(d["line"]).lstrip().startswith(("```", "~~~")), (path.name, d["line"])
    for f in m["files"]:
        for mention in f["mentions"]:
            # a mention is on its line, or on a later line of the same paragraph
            text = "\n".join(lines[mention["line"] - 1:mention["line"] + 5])
            assert f["path"].rstrip("/") in text, (path.name, f["path"], mention)
            assert mention["at"] in section_ids(m)
    print(f"ok {path.name}")

# Front matter shifts every line; table-derived highlights point at their row.
m = build_model("---\na: 1\n---\n# T\n\n## Risks\n\n| Risk | Fix |\n|---|---|\n| Slow | Cache |\n\n- [ ] Ship\n", "t")
assert m["sections"][0]["line"] == 6
assert m["callouts"][0]["line"] == 10, m["callouts"]
assert m["tasks"][0]["line"] == 12
print("ok")
