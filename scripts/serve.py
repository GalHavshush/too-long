#!/usr/bin/env python3
"""Serve the site locally with two-way task sync: ticking a task in the browser writes [x] into
the Markdown, and editing the Markdown updates the open page.

    python3 serve.py plan.md [--out .too-long] [--config FILE] [--port 8765]

Only a transport: the rules live in sync.py (writes) and regen.py / watch.py (rebuilds).
Safety:
- Listens on 127.0.0.1 only. Requests whose Host is not this address are refused (stops DNS
  rebinding), and so are cross-site requests (Origin / Sec-Fetch-Site).
- Every /api request needs a random per-run token. It is put into the served index.html (which
  other sites cannot read), never into a script file.
- Only the one Markdown file named on the command line can be written, only through
  sync.update_task, which changes a single checkbox character.
- Files are served from the output folder only.
Opening index.html directly (file://) still works, read-only, as before.
"""
import argparse
import json
import secrets
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import sync
from config import ConfigError
from watch import watch


class Handler(SimpleHTTPRequestHandler):
    app = None  # set by make_server: {regen, token, port, md}

    def log_message(self, fmt, *args):  # quiet; errors still go to the JSON responses
        pass

    # ---- request checks ----
    def _allowed(self):
        port = self.app["port"]
        if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in (f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
            return False
        return self.headers.get("Sec-Fetch-Site", "same-origin") in ("same-origin", "none")

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _api_ok(self):
        if not self._allowed():
            self._json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
            return False
        if not secrets.compare_digest(self.headers.get("X-Too-Long-Token", ""), self.app["token"]):
            self._json(HTTPStatus.FORBIDDEN, {"error": "bad token"})
            return False
        return True

    # ---- GET: the site, plus the current revision ----
    def do_GET(self):
        if not self._allowed():
            return self._json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
        path = self.path.split("?", 1)[0]
        if path == "/api/state":
            if self._api_ok():
                doc = self.app["regen"].document
                self._json(HTTPStatus.OK, {"revision": doc.model["revision"] if doc else ""})
            return
        if path in ("/", "/index.html"):
            html = (self.app["regen"].out / "index.html").read_text(encoding="utf-8")
            meta = f'<meta name="too-long-token" content="{self.app["token"]}">'
            data = html.replace("<head>", "<head>\n  " + meta, 1).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always the latest data.js
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    # ---- POST /api/task {id, done, revision} ----
    def do_POST(self):
        if self.path != "/api/task":
            return self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        if not self._api_ok():
            return
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 10_000)))
            task_id, done, rev = str(body["id"]), bool(body["done"]), str(body["revision"])
        except (ValueError, KeyError, TypeError):
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "expected {id, done, revision}"})
        regen = self.app["regen"]
        try:
            result = sync.update_task(self.app["md"], task_id, done, rev, out=regen.out, config_path=regen.config_path)
        except sync.TaskNotFound:
            return self._json(HTTPStatus.NOT_FOUND, {"error": "no such task"})
        except sync.NotATask as e:
            return self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(e)})
        except (ConfigError, OSError) as e:
            return self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(e)})
        if isinstance(result, sync.Busy):
            return self._json(HTTPStatus.LOCKED, {"error": "the Markdown is being written by someone else; try again"})
        if isinstance(result, sync.Conflict):
            regen.refresh()
            return self._json(HTTPStatus.CONFLICT, {"error": "the Markdown changed", "revision": result.revision})
        regen.refresh()  # the page reloads its data right after; make sure data.js is current
        return self._json(HTTPStatus.OK, {"revision": result.revision, "line": result.line})


def make_server(md, out=".too-long", config_path=None, port=0):
    """Build the site, start watching the Markdown, and return an HTTP server (not yet serving)."""
    w = watch(md, out, config_path)
    first = w.regen.refresh(force=True)
    if not first.ok:
        w.stop()
        raise SystemExit(first.error)
    app = {"regen": w.regen, "token": secrets.token_urlsafe(24), "md": Path(md), "watch": w}
    handler = type("BoundHandler", (Handler,), {"app": app})
    httpd = ThreadingHTTPServer(("127.0.0.1", port), partial(handler, directory=str(w.regen.out)))
    app["port"] = httpd.server_address[1]
    httpd.app = app
    return httpd


def main():
    ap = argparse.ArgumentParser(description="Serve the too-long site with task sync to the Markdown.")
    ap.add_argument("markdown")
    ap.add_argument("--out", default=".too-long")
    ap.add_argument("--config")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    try:
        httpd = make_server(args.markdown, args.out, args.config, args.port)
    except OSError as e:
        sys.exit(f"Could not listen on 127.0.0.1:{args.port} ({e.strerror}). Try another --port.")
    print(f"Serving http://127.0.0.1:{httpd.app['port']}/  (task checks are written to {args.markdown}; Ctrl-C to stop)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.app["watch"].stop()


if __name__ == "__main__":
    main()
