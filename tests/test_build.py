#!/usr/bin/env python3
"""Config validation:  python3 tests/test_build.py"""
import _path  # noqa: F401
from config import ConfigError, check_config
from parse import build_model

MD = "# P\n\n## Setup\n\n- [ ] Install\n\n## Launch\n\nShip it.\n"


def rejects(config, needle):
    try:
        check_config(config, build_model(MD, "p"))
    except ConfigError as e:
        assert needle in str(e), e
        return
    raise AssertionError(f"config should be rejected: {config}")


# Inferred content must cite sections that exist.
rejects({"notes": {"nope": "x"}}, "unknown section id 'nope'")
rejects({"diagrams": [{"title": "D", "mermaid": "flowchart TD\n A-->B", "sources": ["setup", "ghost"]}]},
        "unknown section id 'ghost'")
rejects({"roadmap": ["setup", "ghost"]}, "unknown section id 'ghost'")
rejects({"views": ["overview", "bogus"]}, "Unknown view")
# The accent is a color and nothing else (no url(), no extra declarations).
rejects({"accent": "red;background:url(https://evil.example/x)"}, "must be a CSS color")
rejects({"accent": "url(https://evil.example/x)"}, "must be a CSS color")
for ok in ("#0f766e", "teal", "rgb(15 118 110)", "oklch(60% 0.1 190)"):
    check_config({"accent": ok}, build_model(MD, "p"))

config, warnings = check_config({"notes": {"setup": "x"}, "diagrams": [
    {"title": "D", "mermaid": "flowchart TD\n A-->B", "sources": ["launch"]}]}, build_model(MD, "p"))
assert config["diagrams"][0]["inferred"] is True
assert "document" in config["views"]
print("ok")
