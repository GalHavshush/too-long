#!/usr/bin/env python3
"""Golden-file parser tests:  python3 tests/test_golden.py [--update]

Each tests/fixtures/<name>.md is parsed and compared with tests/golden/<name>.json
(the model without its raw `source`). --update rewrites the golden files; review the diff.

Also checked for every fixture: no word of the source is missing from the model,
so content is never silently dropped.
"""
import json
import re
import sys
import time

from _path import ROOT
from parse import build_model

FIXTURES = ROOT / "tests" / "fixtures"
GOLDEN = ROOT / "tests" / "golden"


def model_of(path):
    m = build_model(path.read_text(encoding="utf-8"), path.stem)
    m.pop("source")
    return m


def strings(x):
    if isinstance(x, dict):
        return [s for v in x.values() for s in strings(v)]
    if isinstance(x, list):
        return [s for v in x for s in strings(v)]
    return [str(x)] if isinstance(x, (str, int)) and not isinstance(x, bool) else []


def check_nothing_dropped(path, model):
    words = set(re.findall(r"\w+", " ".join(strings(model))))
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = re.sub(r"\[[xX ]\]", "", line)  # task boxes are kept as `done`, not as text
        missing = [w for w in re.findall(r"\w+", line) if w not in words]
        assert not missing, f"{path.name}:{n} words missing from the model: {missing}"


def check_large_plan():
    """A ~3000 line plan parses quickly and keeps every task."""
    parts = ["# Large plan\n"]
    for p in range(1, 51):
        parts.append(f"## Phase {p}: part {p}\n\nGoal of phase {p}, see `src/phase{p}/main.py`.\n")
        for s in range(1, 4):
            parts.append(f"### Step {p}.{s}\n")
            parts += [f"- [{'x' if (p + t) % 3 == 0 else ' '}] Task {p}.{s}.{t}" for t in range(1, 11)]
            parts.append("\n```python\n" + "\n".join(f"line_{k} = {k}" for k in range(6)) + "\n```\n")
        parts.append(f"Risk: phase {p} may slip.\n")
    md = "\n".join(parts)
    assert md.count("\n") > 3000
    start = time.perf_counter()
    m = build_model(md, "large")
    elapsed = time.perf_counter() - start
    assert len(m["sections"]) == 50 and len(m["tasks"]) == 1500, (len(m["sections"]), len(m["tasks"]))
    assert len({t["id"] for t in m["tasks"]}) == 1500, "task ids must be unique"
    assert m["roadmap"]["basis"] == "titles" and len(m["roadmap"]["ids"]) == 50
    assert elapsed < 3, f"large plan took {elapsed:.2f}s"


def main():
    update = "--update" in sys.argv
    fixtures = sorted(FIXTURES.glob("*.md"))
    assert fixtures, "no fixtures found"
    for path in fixtures:
        model = model_of(path)
        check_nothing_dropped(path, model)
        golden = GOLDEN / f"{path.stem}.json"
        text = json.dumps(model, indent=2, ensure_ascii=False) + "\n"
        if update:
            golden.write_text(text, encoding="utf-8")
            continue
        assert golden.exists(), f"missing {golden.name}: run with --update and review it"
        expected = json.loads(golden.read_text(encoding="utf-8"))
        assert model == expected, f"{path.name} differs from {golden.name} (run with --update and review the diff)"
    check_large_plan()
    print("updated" if update else "ok")


if __name__ == "__main__":
    main()
