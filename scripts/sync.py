"""Write a task's completion back to the Markdown. The Markdown stays the source of truth.

    result = update_task("plan.md", task_id, True, expected_revision, out=".too-long")

The rules, the same for every caller (serve.py today, an editor integration later):
- The caller names the revision it saw (model["revision"]). If the file is different now, nothing
  is written and Conflict(current revision) comes back: re-read, then try again.
- Only the one character inside the task's "[ ]" / "[x]" changes. Every other byte (line endings,
  encoding, trailing spaces) stays as it was.
- Writes are atomic (temp file in the same folder, then rename) and serialised across processes
  by an OS lock on a sidecar file ".<name>.too-long.lock" next to the Markdown. Editors that don't
  take the lock are caught by re-checking the file just before the rename.
- Task ids are the ones the viewer shows (reconciled through <out>/build.json).
No HTTP here: serve.py is only a transport.
"""
import os
import re
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from config import load_config
from identity import load_manifest
from model import build_document, revision

BOX_RE = re.compile(rb"^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]")


@dataclass
class Applied:
    revision: str   # the file's revision after the change
    line: int


@dataclass
class Conflict:
    revision: str   # the file changed: this is its current revision


@dataclass
class Busy:
    """Another writer held the lock for longer than the timeout."""


class TaskNotFound(LookupError):
    pass


class NotATask(ValueError):
    """The id is a tracked numbered step (no checkbox in the Markdown), or its line has no box."""


if os.name == "nt":
    import msvcrt

    def _try_lock(f):
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)

    def _unlock(f):
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
else:
    import fcntl

    def _try_lock(f):
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock(f):
        fcntl.flock(f, fcntl.LOCK_UN)


@contextmanager
def file_lock(md_path, timeout=5.0):
    """Exclusive lock for writing md_path. Yields True, or False after `timeout` seconds.
    The OS releases it if the process dies, so a crash never leaves a stale lock."""
    lock_path = md_path.parent / f".{md_path.name}.too-long.lock"
    with open(lock_path, "a+b") as f:
        deadline = time.monotonic() + timeout
        while True:
            try:
                _try_lock(f)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    yield False
                    return
                time.sleep(0.02)
        try:
            yield True
        finally:
            _unlock(f)


def update_task(md_path, task_id, done, expected_revision, out=".too-long", config_path=None, timeout=5.0):
    md_path = Path(md_path).resolve()  # write the real file, never replace a symlink
    out = Path(out)
    with file_lock(md_path, timeout) as locked:
        if not locked:
            return Busy()
        data = md_path.read_bytes()
        current = revision(data)
        if current != expected_revision:
            return Conflict(current)

        config = load_config(Path(config_path) if config_path else out / "config.json")
        doc = build_document(md_path, config, load_manifest(out), out)
        if doc.model["revision"] != current:  # changed between the two reads
            return Conflict(doc.model["revision"])
        task = next((t for t in doc.model["tasks"] if t["id"] == task_id), None)
        if task is None:
            raise TaskNotFound(task_id)
        if task.get("browser_only"):
            raise NotATask(f"{task_id} is a numbered step without a checkbox in the Markdown")

        lines = data.splitlines(keepends=True)  # same line breaks the parser counts
        k = task["line"] - 1
        m = BOX_RE.match(lines[k])
        if not m:
            raise NotATask(f"line {task['line']} has no checkbox")
        if (m[2] != b" ") == bool(done):
            return Applied(current, task["line"])  # already in that state
        box = m.end(2) - 1
        lines[k] = lines[k][:box] + (b"x" if done else b" ") + lines[k][box + 1:]
        new = b"".join(lines)

        fd, tmp = tempfile.mkstemp(dir=md_path.parent, prefix=f".{md_path.name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(new)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, md_path.stat().st_mode & 0o7777)
            if revision(md_path.read_bytes()) != current:  # an editor that ignores the lock wrote meanwhile
                return Conflict(revision(md_path.read_bytes()))
            os.replace(tmp, md_path)
            tmp = None
        finally:
            if tmp:
                os.unlink(tmp)
        return Applied(revision(new), task["line"])
