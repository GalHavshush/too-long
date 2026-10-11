"""Regeneration engine: Markdown changed -> reparse -> reconcile ids -> update the model -> check
staleness -> rewrite what changed -> tell subscribers. Deterministic, no LLM, no HTTP, no browser.

    regen = Regenerator("plan.md", out=".too-long")
    regen.subscribe(lambda result: print(result))
    regen.refresh()          # call whenever the Markdown or config may have changed

Who calls refresh() is up to the caller: build.py once, watch.py from a file poller, serve.py
after a task update, or an editor integration from its own change events.
"""
import hashlib
import threading
from dataclasses import dataclass, field
from pathlib import Path

from config import ConfigError, load_config
from identity import load_manifest
from model import build_document
from parse import InputError, read_markdown
from website import write_site


@dataclass
class Result:
    ok: bool
    changed: bool = False          # something in the output folder was rewritten
    written: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    revision: str = ""             # the Markdown version the output now shows
    stale: dict = field(default_factory=dict)
    error: str = ""


class Regenerator:
    def __init__(self, md, out=".too-long", config_path=None):
        self.md = Path(md)
        self.out = Path(out)
        self.config_path = Path(config_path) if config_path else self.out / "config.json"
        self.document = None       # the last model.Document built
        self._lock = threading.Lock()
        self._inputs = None        # fingerprint of the inputs of the last successful build
        self._subscribers = []

    def subscribe(self, fn):
        """fn(result) after every refresh that changed something or failed. Returns an unsubscribe."""
        self._subscribers.append(fn)
        return lambda: self._subscribers.remove(fn)

    def _fingerprint(self):
        h = hashlib.sha256(read_markdown(self.md)[0])
        if self.config_path.exists():
            h.update(self.config_path.read_bytes())
        return h.hexdigest()

    def refresh(self, force=False):
        """Rebuild if the Markdown or config changed since the last refresh (or when forced).
        Refreshes never overlap: a second caller waits for the first."""
        with self._lock:
            try:
                inputs = self._fingerprint()
                if not force and inputs == self._inputs:
                    return Result(ok=True, revision=self.document.model["revision"] if self.document else "")
                doc = build_document(self.md, load_config(self.config_path), load_manifest(self.out), self.out)
                written = write_site(self.out, doc.model, doc.config, doc.manifest)
                self.document, self._inputs = doc, inputs
                result = Result(ok=True, changed=bool(written), written=written, warnings=doc.warnings,
                                revision=doc.model["revision"], stale=doc.model["stale"])
            except (ConfigError, InputError) as e:
                result = Result(ok=False, error=str(e))
            except OSError as e:  # e.g. the output folder is not writable
                where = f": {e.filename}" if e.filename else ""
                result = Result(ok=False, error=f"{e.strerror or e}{where}. If that is the output folder, choose another with --out.")
        if result.changed or not result.ok:
            for fn in list(self._subscribers):
                fn(result)
        return result
