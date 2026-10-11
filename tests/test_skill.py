#!/usr/bin/env python3
"""SKILL.md stays in step with what the code accepts:  python3 tests/test_skill.py"""
import re

from _path import ROOT

skill = (ROOT / "SKILL.md").read_text()
KEYS = ["views", "accent", "tldr", "notes", "diagrams", "roadmap", "track", "dependencies"]
code = "".join((ROOT / "scripts" / f).read_text() for f in ("config.py", "model.py", "roadmap.py"))
for k in KEYS:
    assert f'"{k}"' in code, f"config key '{k}' is not read by the code"
    assert f'"{k}"' in skill or f"`{k}`" in skill, f"config key '{k}' is not documented in SKILL.md"
# Every view the code knows is described, and the scripts it tells Claude to run exist.
from config import VIEWS  # noqa: E402
for v in VIEWS:
    assert f"| `{v}` |" in skill, v
for script in set(re.findall(r"scripts/(\w+\.py)", skill)):
    assert (ROOT / "scripts" / script).exists(), script
# Steps are numbered 1..n without gaps.
steps = [int(n) for n in re.findall(r"^### (\d+)\.", skill, re.M)]
assert steps == list(range(1, len(steps) + 1)), steps
print("ok")
