#!/usr/bin/env python3
"""Task sync engine, with no server:  python3 tests/test_sync.py"""
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from _path import ROOT
from model import revision
from regen import Regenerator
from sync import Applied, Busy, Conflict, NotATask, TaskNotFound, update_task

tmp = Path(tempfile.mkdtemp())
md, out = tmp / "plan.md", tmp / ".too-long"

# CRLF line endings, a trailing space, a duplicate task, a task in a quote, a numbered step.
SRC = (b"# Plan\r\n\r\n## Work\r\n\r\n- [ ] Write parser \r\n- [ ] Same text\r\n- [ ] Same text\r\n"
       b"> - [ ] Quoted task\r\n\r\n## Steps\r\n\r\n1. Tracked step\r\n2. Another\r\n")
md.write_bytes(SRC)
out.mkdir()
(out / "config.json").write_text(json.dumps({"track": ["steps"]}))
r = Regenerator(md, out)
r.refresh()


def tasks():
    return {(t["text"].strip(), t["line"]): t for t in r.document.model["tasks"]}


def rev():
    return revision(md.read_bytes())


t = tasks()[("Write parser", 5)]
res = update_task(md, t["id"], True, rev(), out=out)
assert isinstance(res, Applied) and res.line == 5, res
# Exactly one byte changed; CRLF and the trailing space survive.
assert md.read_bytes() == SRC.replace(b"- [ ] Write parser \r\n", b"- [x] Write parser \r\n")
assert res.revision == rev()

# Same state again: no write, same revision.
before = md.stat().st_mtime_ns
assert update_task(md, t["id"], True, rev(), out=out) == Applied(rev(), 5)
assert md.stat().st_mtime_ns == before

# Duplicate texts are different tasks: ticking the second leaves the first alone.
r.refresh()
dup2 = tasks()[("Same text", 7)]
update_task(md, dup2["id"], True, rev(), out=out)
lines = md.read_bytes().split(b"\r\n")
assert lines[5] == b"- [ ] Same text" and lines[6] == b"- [x] Same text", lines

# A task inside a blockquote.
r.refresh()
q = tasks()[("Quoted task", 8)]
update_task(md, q["id"], True, rev(), out=out)
assert b"> - [x] Quoted task\r\n" in md.read_bytes()

# Stale revision: refused, nothing written.
r.refresh()
old = rev()
md.write_bytes(md.read_bytes() + b"\r\nEdited elsewhere.\r\n")
snapshot = md.read_bytes()
res = update_task(md, t["id"], False, old, out=out)
assert res == Conflict(rev()) and md.read_bytes() == snapshot

# Unknown ids and numbered steps without a checkbox are errors, not edits.
r.refresh()
for bad, exc in (("t-nope", TaskNotFound), (tasks()[("Tracked step", 12)]["id"], NotATask)):
    try:
        update_task(md, bad, True, rev(), out=out)
        raise AssertionError(f"{bad} should raise {exc.__name__}")
    except exc:
        pass
assert md.read_bytes() == snapshot

# Unticking works and file permissions are kept.
md.chmod(0o640)
update_task(md, t["id"], False, rev(), out=out)
assert b"- [ ] Write parser \r\n" in md.read_bytes() and md.stat().st_mode & 0o777 == 0o640
assert not list(tmp.glob(".plan.md.*.tmp")), "temp files must not be left behind"

# Another process holding the lock: Busy after the timeout, nothing written.
holder = subprocess.Popen([sys.executable, "-c", f"""
import sys, time; sys.path.insert(0, {str(ROOT / 'scripts')!r})
from pathlib import Path
from sync import file_lock
with file_lock(Path({str(md)!r})) as ok:
    print("locked", flush=True); time.sleep(2)
"""], stdout=subprocess.PIPE, text=True)
assert holder.stdout.readline().strip() == "locked"
snapshot = md.read_bytes()
start = time.monotonic()
assert isinstance(update_task(md, t["id"], True, rev(), out=out, timeout=0.3), Busy)
assert time.monotonic() - start < 1.5 and md.read_bytes() == snapshot
holder.wait()

# Two processes writing at once from the same revision: one wins, the other gets a conflict.
r.refresh()
ids = [tasks()[("Same text", 6)]["id"], tasks()[("Write parser", 5)]["id"]]
base = rev()
code = """
import sys, json; sys.path.insert(0, {scripts!r})
from sync import update_task
r = update_task({md!r}, {id!r}, True, {rev!r}, out={out!r})
print(type(r).__name__)
"""
procs = [subprocess.Popen([sys.executable, "-c", code.format(scripts=str(ROOT / "scripts"), md=str(md), id=i, rev=base, out=str(out))],
                          stdout=subprocess.PIPE, text=True) for i in ids]
outcomes = sorted(p.communicate()[0].strip() for p in procs)
assert outcomes == ["Applied", "Conflict"], outcomes
assert md.read_bytes().count(b"[x]") == snapshot.count(b"[x]") + 1

# An editor that ignores the lock and writes during the update: detected before the rename.
import sync as sync_mod  # noqa: E402
r.refresh()
real_mkstemp = sync_mod.tempfile.mkstemp


def editor_writes_meanwhile(*a, **k):
    md.write_bytes(md.read_bytes() + b"typed in vim\r\n")
    return real_mkstemp(*a, **k)


sync_mod.tempfile.mkstemp = editor_writes_meanwhile
now = tasks()[("Write parser", 5)]["done"]  # whichever process won above, flip it so a write is needed
res = update_task(md, t["id"], not now, rev(), out=out)
sync_mod.tempfile.mkstemp = real_mkstemp
assert isinstance(res, Conflict) and md.read_bytes().endswith(b"typed in vim\r\n")
assert not list(tmp.glob(".plan.md.*.tmp"))
print("ok")
