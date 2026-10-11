#!/usr/bin/env python3
"""The command line gives actionable errors:  python3 tests/test_cli.py"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from _path import ROOT

CLI = ROOT / "scripts" / "too_long.py"
tmp = Path(tempfile.mkdtemp())


def run(*args, cwd=tmp):
    r = subprocess.run([sys.executable, str(CLI), *map(str, args)], cwd=cwd, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


plan = tmp / "plan.md"
plan.write_text("# Plan\n\n## Work\n\n- [ ] Do it\n")

# Happy path: build, with a predictable output folder and an open hint.
code, outp = run("build", plan)
assert code == 0 and (tmp / ".too-long" / "index.html").exists(), outp
assert "Open it:" in outp
code, outp = run("build", "--out", tmp / "site", plan)  # option before the file
assert code == 0 and (tmp / "site" / "data.js").exists(), outp
code, outp = run("parse", plan)
assert code == 0 and "Section ids" in outp

# Problems with the input file say what to do.
code, outp = run("build", tmp / "nope.md")
assert code == 1 and "no such file" in outp, outp
code, outp = run("build", tmp)
assert code == 1 and "is a folder" in outp, outp
latin = tmp / "latin.md"
latin.write_bytes("# Café\n".encode("latin-1"))
code, outp = run("build", latin)
assert code == 1 and "not UTF-8" in outp and "iconv" in outp, outp
code, outp = run("build")
assert code == 1 and "Give the Markdown file" in outp
notes = tmp / "notes.text"
notes.write_text("# Notes\n")
code, outp = run("build", notes, "--out", tmp / "n")
assert code == 0 and "does not end in .md" in outp, outp

# Config problems point at the line and column.
(tmp / "bad").mkdir()
(tmp / "bad" / "config.json").write_text('{\n  "views": ["overview",]\n}')
code, outp = run("build", plan, "--out", tmp / "bad")
assert code != 0 and "config.json:2:" in outp and "invalid JSON" in outp, outp
(tmp / "bad" / "config.json").write_text(json.dumps({"views": ["overveiw"]}))
code, outp = run("build", plan, "--out", tmp / "bad")
assert code != 0 and "Unknown view(s): overveiw" in outp, outp

# An output folder that can't be written.
if os.name != "nt" and os.geteuid() != 0:
    locked = tmp / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    code, outp = run("build", plan, "--out", locked / "site")
    locked.chmod(0o700)
    assert code != 0 and "choose another with --out" in outp, outp

# Unknown commands and help.
code, outp = run("bulid", plan)
assert code == 2 and "Unknown command 'bulid'" in outp
code, outp = run("--help")
assert code == 0 and "doctor" in outp

# doctor reports per feature and never fails just because video tools are missing.
code, outp = run("doctor")
assert code == 0 and "Python" in outp and "needed for" in outp, outp

# The scripts still work on their own (the skill calls them directly).
r = subprocess.run([sys.executable, str(ROOT / "scripts" / "build.py"), str(plan), "--out", str(tmp / "direct")],
                   capture_output=True, text=True)
assert r.returncode == 0 and (tmp / "direct" / "index.html").exists(), r.stderr
print("ok")
