#!/usr/bin/env python3
"""The side pane's JSON interface:  python3 tests/test_pane.py"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from _path import ROOT
import pane
import sync

PANE = ROOT / "scripts" / "pane.py"
tmp = Path(tempfile.mkdtemp()).resolve()  # /var -> /private/var on macOS


def run(*args):
    r = subprocess.run([sys.executable, str(PANE), *map(str, args)], capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout) if r.stdout.strip() else None, r.stderr


# A plan outside the project, as in ~/.claude/plans/, with spaces and Unicode in its path.
plans = tmp / "plans dir ✓"
plans.mkdir()
plan = plans / "my plan é.md"
plan.write_text(
    "# Ship it\n\n## Phase 1: Core\n\n- [x] Parse `scripts/pane.py`\n- [ ] Write `src/new.ts`\n\n"
    "## Phase 2: Pane\n\n- [ ] Draw it\n\n## Steps\n\n1. Tracked step\n\n"
    "## Risks\n\n- Risk: The pane is too narrow.\n  Mitigation: Wrap the labels.\n\n"
    "Decision: Poll the file. Rejected: OS events.\n\nQuestion: Windows?\n",
    encoding="utf-8")
out = plans / ".too-long" / "my plan é"

# model: builds the site next to the plan and prints the summary.
code, res, err = run("model", plan, "--root", ROOT)
assert code == 0 and res["status"] == "ok", (res, err)
assert Path(res["index"]) == out / "index.html" and (out / "index.html").exists() and (out / "data.js").exists()
assert res["title"] == "Ship it" and res["file"] == plan.name and len(res["revision"]) == 64
assert [(s["id"], s["done"], s["total"]) for s in res["stages"]] == [("phase-1-core", 1, 2), ("phase-2-pane", 0, 1)], res["stages"]
assert [t["done"] for t in res["tasks"]] == [True, False, False]
assert [s["title"] for s in res["sections"]] == ["Phase 1: Core", "Phase 2: Pane", "Steps", "Risks"]
assert {h["kind"] for h in res["highlights"]} == {"risk", "decision", "question"}
assert next(h for h in res["highlights"] if h["kind"] == "risk")["mitigation"] == "Wrap the labels."
# --root: a file of the project exists, one the plan will create is planned.
status = {f["path"]: f["status"] for f in res["files"]}
assert status == {"scripts/pane.py": "exists", "src/new.ts": "planned"}, status
# Without --root the plan's own folder is all there is.
code, res2, _ = run("model", plan)
assert {f["status"] for f in res2["files"]} == {"planned"}, res2["files"]

rev = res["revision"]
task = res["tasks"][1]

# task: applied, the box flips and the new revision comes back.
code, r, err = run("task", plan, task["id"], "--done", "--revision", rev)
assert code == 0 and r["status"] == "applied" and r["line"] == task["line"], (r, err)
assert "- [x] Write `src/new.ts`" in plan.read_text(encoding="utf-8")
assert r["revision"] != rev
# stale revision: conflict, nothing written.
before = plan.read_bytes()
code, r, _ = run("task", plan, task["id"], "--undo", "--revision", rev)
assert code == 1 and r["status"] == "conflict" and r["revision"] != rev and plan.read_bytes() == before
code, r, _ = run("task", plan, "no-such-task", "--done", "--revision", pane.sync.revision(before))
assert code == 1 and r["status"] == "not_found"
# a numbered step tracked in the browser only has no checkbox to write.
(out / "config.json").write_text(json.dumps({"track": ["steps"]}))
code, m, _ = run("model", plan)
step = next(t for t in m["tasks"] if t["browser_only"])
code, r, _ = run("task", plan, step["id"], "--done", "--revision", m["revision"])
assert code == 1 and r["status"] == "not_a_task", r
(out / "config.json").unlink()
# another writer holds the lock: busy.
pane.LOCK_TIMEOUT = 0.2
with sync.file_lock(plan.resolve(), 1) as locked:
    assert locked
    r = pane.cmd_task(plan, task["id"], False, pane.sync.revision(plan.read_bytes()))
assert r["status"] == "busy", r
# usage errors are argparse's.
code, r, err = run("task", plan, task["id"], "--revision", rev)
assert code == 2 and r is None and "--done" in err

# a missing plan: a message, not a traceback.
code, r, err = run("model", tmp / "gone.md")
assert code == 1 and r["status"] == "error" and "gone.md" in r["error"] and "Traceback" not in err, (r, err)
code, r, err = run("task", tmp / "gone.md", "x", "--done", "--revision", "0")
assert code == 1 and r["status"] == "error" and "Traceback" not in err, (r, err)

# open: hands the site's file URL to the browser.
opened = []
pane.webbrowser.open = lambda url: opened.append(url) or True
assert pane.cmd_open(plan)["status"] == "ok" and opened == [(out / "index.html").as_uri()]
pane.webbrowser.open = lambda url: False
assert pane.cmd_open(plan)["status"] == "error"

print("pane: ok")
