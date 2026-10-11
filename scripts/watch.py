#!/usr/bin/env python3
"""Rebuild the site whenever the Markdown (or config) changes.

    python3 watch.py plan.md [--out .too-long] [--config FILE]

Three separate parts, so each can be replaced:

    change source (PollingWatcher)  ->  Debouncer  ->  Regenerator.refresh()  ->  subscribers

PollingWatcher checks mtime and size a few times a second (stdlib, any OS). An editor integration
with its own file events can pass its own `source` to watch() and keep the rest. Rapid saves are
coalesced by the Debouncer; Regenerator skips work when nothing changed. Never calls an LLM:
inferred content is only flagged as stale.
"""
import argparse
import threading
import time
from pathlib import Path

from regen import Regenerator


class PollingWatcher:
    """Calls on_change() when any path's (mtime, size) changes. start() / stop()."""

    def __init__(self, paths, on_change, interval=0.25):
        self.paths, self.on_change, self.interval = [Path(p) for p in paths], on_change, interval
        self._stop = threading.Event()
        self._thread = None

    def _state(self):
        out = []
        for p in self.paths:
            try:
                st = p.stat()
                out.append((st.st_mtime_ns, st.st_size))
            except OSError:
                out.append(None)
        return out

    def _run(self):
        last = self._state()
        while not self._stop.wait(self.interval):
            now = self._state()
            if now != last:
                last = now
                self.on_change()

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()


class Debouncer:
    """Calling it (re)starts a timer; fn runs once, `delay` seconds after the last call."""

    def __init__(self, delay, fn):
        self.delay, self.fn = delay, fn
        self._timer = None
        self._lock = threading.Lock()

    def __call__(self):
        with self._lock:
            if self._timer:
                self._timer.cancel()
            self._timer = threading.Timer(self.delay, self.fn)
            self._timer.daemon = True
            self._timer.start()

    def cancel(self):
        with self._lock:
            if self._timer:
                self._timer.cancel()


class Watch:
    def __init__(self, key, regen, source, debouncer):
        self.key, self.regen, self.source, self.debouncer = key, regen, source, debouncer

    def stop(self):
        self.source.stop()
        self.debouncer.cancel()
        with _lock:
            _watches.pop(self.key, None)


_watches = {}  # one watch per Markdown file, however many callers ask
_lock = threading.Lock()


def watch(md, out=".too-long", config_path=None, on_result=None, delay=0.3, source=PollingWatcher):
    """Start watching md (if not already watched) and return its Watch. on_result(result) is
    called after each rebuild. source(paths, callback) must return an object with start()/stop()."""
    key = str(Path(md).resolve())
    with _lock:
        w = _watches.get(key)
        if w is None:
            regen = Regenerator(md, out, config_path)
            debouncer = Debouncer(delay, regen.refresh)
            w = _watches[key] = Watch(key, regen, source([regen.md, regen.config_path], debouncer), debouncer)
            w.source.start()
    if on_result:
        w.regen.subscribe(on_result)
    return w


def report(result):
    stamp = time.strftime("%H:%M:%S")
    if not result.ok:
        print(f"[{stamp}] error: {result.error}", flush=True)
        return
    for w in result.warnings:
        print(f"[{stamp}] warning: {w}", flush=True)
    print(f"[{stamp}] rebuilt ({', '.join(result.written)})", flush=True)


def main():
    ap = argparse.ArgumentParser(description="Rebuild the too-long site when the Markdown changes.")
    ap.add_argument("markdown")
    ap.add_argument("--out", default=".too-long")
    ap.add_argument("--config")
    args = ap.parse_args()
    w = watch(args.markdown, args.out, args.config, on_result=report)
    first = w.regen.refresh(force=True)  # failures and rebuilds are reported by the subscriber
    if first.ok and not first.changed:
        print("Site is up to date.")
    print(f"Watching {args.markdown} (Ctrl-C to stop). Open {Path(args.out) / 'index.html'} and reload after changes.")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        w.stop()


if __name__ == "__main__":
    main()
