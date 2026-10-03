#!/usr/bin/env python3
"""Tests for argument parsing and storyboard validation:  python3 scripts/test_video.py"""
from args import parse_args
from parse import build_model
from video import validate, timeline

# --video works in any position, quoted or unquoted paths
assert parse_args("plan.md") == {"file": "plan.md", "video": False}
assert parse_args("plan.md --video") == {"file": "plan.md", "video": True}
assert parse_args("--video plan.md") == {"file": "plan.md", "video": True}
assert parse_args('--video "my plan.md"') == {"file": "my plan.md", "video": True}
assert parse_args("my plan.md --video") == {"file": "my plan.md", "video": True}
try:
    parse_args("plan.md --fast")
    raise SystemExit("unknown flag should fail")
except ValueError:
    pass

MD = "# P\n\n## Setup\n\nRun `make dev`.\n\n```bash\nmake dev\n```\n\nFiles: `src/app.py`\n"
model = build_model(MD, "p")
ok = {"scenes": [
    {"type": "title", "heading": "P", "narration": "Hi."},
    {"type": "code", "heading": "Run", "code": "make dev", "sources": ["setup"], "narration": "Run it."},
    {"type": "files", "heading": "Files", "paths": ["src/app.py"], "sources": ["setup"], "narration": "Here."},
]}
errors, _ = validate(model, ok)
assert not errors, errors

bad = {"scenes": [
    {"type": "title", "heading": "P", "narration": "Hi."},
    {"type": "code", "heading": "Run", "code": "rm -rf /", "sources": ["setup"], "narration": "x"},
    {"type": "files", "heading": "F", "paths": ["src/invented.py"], "sources": ["nope"], "narration": "x"},
]}
errors, _ = validate(model, bad)
assert any("code line not in the Markdown" in e for e in errors), errors
assert any("path not in the Markdown" in e for e in errors), errors
assert any("unknown source section id 'nope'" in e for e in errors), errors

# timing: scenes follow each other, never shorter than the minimum
scenes = [{"narration": "a b c"}, {"narration": "word " * 40}]
total = timeline(scenes, {0: 1.0, 1: 14.0})
assert scenes[0]["start"] == 0 and scenes[0]["dur"] == 3.5 and scenes[1]["start"] == 3.5 and total == 3.5 + 15.3
print("ok")
