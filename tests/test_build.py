#!/usr/bin/env python3
"""Config validation:  python3 tests/test_build.py"""
import _path  # noqa: F401
from build import check_config
from parse import build_model

MD = "# P\n\n## Setup\n\n- [ ] Install\n\n## Launch\n\nShip it.\n"


def rejects(config, needle):
    try:
        check_config(config, build_model(MD, "p"))
    except SystemExit as e:
        assert needle in str(e), e
        return
    raise AssertionError(f"config should be rejected: {config}")


# Inferred content must cite sections that exist.
rejects({"notes": {"nope": "x"}}, "unknown section id 'nope'")
rejects({"diagrams": [{"title": "D", "mermaid": "flowchart TD\n A-->B", "sources": ["setup", "ghost"]}]},
        "unknown section id 'ghost'")
rejects({"roadmap": ["setup", "ghost"]}, "unknown section id 'ghost'")
rejects({"views": ["overview", "bogus"]}, "Unknown view")

config, warnings = check_config({"notes": {"setup": "x"}, "diagrams": [
    {"title": "D", "mermaid": "flowchart TD\n A-->B", "sources": ["launch"]}]}, build_model(MD, "p"))
assert config["diagrams"][0]["inferred"] is True
assert "document" in config["views"]
print("ok")
