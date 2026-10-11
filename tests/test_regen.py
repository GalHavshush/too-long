#!/usr/bin/env python3
"""Regeneration engine, watcher plumbing, staleness and the model contract, all headless:
python3 tests/test_regen.py"""
import json
import tempfile
import threading
import time
from pathlib import Path

from _path import ROOT
import model as model_mod
import regen as regen_mod
from model import build_document, check_invariants
from regen import Regenerator
from watch import Debouncer, watch

tmp = Path(tempfile.mkdtemp())
md = tmp / "plan.md"
out = tmp / ".too-long"
out.mkdir()

PLAN = """# Plan

Intro.

## Alpha

Alpha does the parsing.

- [ ] Write parser
- [ ] Add tests

## Beta

Beta renders the site.
"""
CONFIG = {"tldr": ["Two parts."], "notes": {"alpha": "Parsing first."},
          "diagrams": [{"title": "Flow", "mermaid": "flowchart TD\n A-->B", "sources": ["beta"]}]}
md.write_text(PLAN)
(out / "config.json").write_text(json.dumps(CONFIG))

events = []
r = Regenerator(md, out)
r.subscribe(events.append)

# First build writes everything; nothing is stale.
res = r.refresh()
assert res.ok and set(res.written) == {"index.html", "styles.css", "app.js", "data.js", "build.json"}, res
assert res.stale == {"tldr": False, "notes": [], "diagrams": []}
assert len(events) == 1

# No change: no work, no notification. Same bytes rewritten: still no change.
assert r.refresh().changed is False
md.write_text(PLAN)
assert r.refresh().changed is False and len(events) == 1

# Ticking a task changes data.js only, and is not a reason to call inferred content stale.
md.write_text(PLAN.replace("- [ ] Write parser", "- [x] Write parser"))
res = r.refresh()
assert res.written == ["data.js", "build.json"] or res.written == ["data.js"], res.written
assert res.stale == {"tldr": False, "notes": [], "diagrams": []}, res.stale
ids = [t["id"] for t in r.document.model["tasks"]]

# Editing Beta: the diagram citing Beta and the TL;DR are stale; the note on Alpha is not.
md.write_text(md.read_text().replace("Beta renders the site.", "Beta renders the site and a video."))
res = r.refresh()
assert res.stale == {"tldr": True, "notes": [], "diagrams": [0]}, res.stale
assert any("diagram 1 may be outdated" in w for w in res.warnings)
# ...and stays stale on later rebuilds until the config is rewritten.
md.write_text(md.read_text() + "\nMore.\n")
assert r.refresh().stale["diagrams"] == [0]

# Task ids survive the edits (and an inserted task).
md.write_text(md.read_text().replace("- [x] Write parser", "- [ ] New first task\n- [x] Write parser"))
r.refresh()
tasks = {t["text"]: t["id"] for t in r.document.model["tasks"]}
assert [tasks["Write parser"], tasks["Add tests"]] == ids

# Rewriting the config (Claude updated it) takes new stamps: nothing stale.
(out / "config.json").write_text(json.dumps({**CONFIG, "tldr": ["Two parts, now with video."]}))
assert r.refresh().stale == {"tldr": False, "notes": [], "diagrams": []}

# Renaming a heading a note cites: an existing config keeps working, the note is reported.
md.write_text(md.read_text().replace("## Alpha", "## Parsing"))
res = r.refresh()
assert res.ok and res.stale["notes"] == ["alpha"], res
assert any("'alpha', which is no longer a section" in w for w in res.warnings)
# A new config citing it is refused, with the reason, and the last good site stays.
(out / "config.json").write_text(json.dumps({"notes": {"alpha": "x"}}))
res = r.refresh()
assert not res.ok and "unknown section id 'alpha'" in res.error and events[-1] is res
(out / "config.json").write_text("{ broken json")
res = r.refresh()
assert not res.ok and "config.json:1:3: invalid JSON" in res.error, res.error
(out / "config.json").write_text(json.dumps({"notes": {"parsing": "x"}}))
assert r.refresh().ok

# Refreshes never overlap, however many threads ask.
active, peak = 0, 0
real = regen_mod.build_document


def slow(*a, **k):
    global active, peak
    active += 1
    peak = max(peak, active)
    time.sleep(0.05)
    active -= 1
    return real(*a, **k)


regen_mod.build_document = slow
threads = [threading.Thread(target=r.refresh, kwargs={"force": True}) for _ in range(4)]
[t.start() for t in threads]
[t.join() for t in threads]
regen_mod.build_document = real
assert peak == 1, peak

# Debouncer: a burst of calls runs the function once.
calls = []
d = Debouncer(0.05, lambda: calls.append(1))
for _ in range(10):
    d()
time.sleep(0.2)
assert calls == [1], calls


# The change source is replaceable: a fake one drives the same engine. One watch per file.
class FakeSource:
    instances = []

    def __init__(self, paths, callback):
        self.paths, self.fire, self.started, self.stopped = paths, callback, False, False
        FakeSource.instances.append(self)

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True


results = []
w = watch(md, out, on_result=results.append, delay=0.05, source=FakeSource)
assert watch(md, out, source=FakeSource) is w and len(FakeSource.instances) == 1
src = FakeSource.instances[0]
assert src.started and md in src.paths
md.write_text(md.read_text() + "\nChanged by an editor.\n")
for _ in range(5):  # a burst of events (an editor writing in several steps)
    src.fire()
time.sleep(0.3)
assert len(results) == 1 and results[0].ok and results[0].changed, results
w.stop()
assert src.stopped and watch(md, out, source=FakeSource) is not w
watch(md, out, source=FakeSource).stop()

# The model contract holds for every fixture and the example (docs/model.md).
for path in sorted((ROOT / "tests" / "fixtures").glob("*.md")) + [ROOT / "examples" / "trailhead-plan.md"]:
    doc = build_document(path, {}, {}, tmp / "inv")
    problems = check_invariants(doc.model)
    assert not problems, (path.name, problems)

# A second consumer: read data.js as plain JSON, the way any non-browser viewer would.
data = json.loads((out / "data.js").read_text().removeprefix("window.TOO_LONG = ").rstrip().rstrip(";"))
m = data["model"]
assert m["schema_version"] == model_mod.SCHEMA_VERSION and len(m["revision"]) == 64 and m["doc_id"]
assert all({"id", "text", "done", "line", "at", "section", "sig"} <= t.keys() for t in m["tasks"])
assert m["revision"] == model_mod.revision(md.read_bytes())

# The site template is copied as is.
for name in ("index.html", "styles.css", "app.js"):
    assert (out / name).read_bytes() == (ROOT / "assets" / name).read_bytes()
print("ok")
