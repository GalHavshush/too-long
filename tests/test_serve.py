#!/usr/bin/env python3
"""The local server is a safe, thin transport over sync.py:  python3 tests/test_serve.py"""
import http.client
import json
import re
import tempfile
import threading
import time
from pathlib import Path

import _path  # noqa: F401
from model import revision
from serve import make_server

tmp = Path(tempfile.mkdtemp())
md, out = tmp / "plan.md", tmp / ".too-long"
md.write_text("# Plan\n\n## Work\n\n- [ ] One\n- [ ] Two\n")
(tmp / "secret.txt").write_text("outside the site folder")

httpd = make_server(md, out, port=0)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
port, token = httpd.app["port"], httpd.app["token"]
HOST = f"127.0.0.1:{port}"


def req(method, path, body=None, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    h = {"Host": HOST, **(headers or {})}
    if body is not None:
        body = json.dumps(body)
        h["Content-Type"] = "application/json"
    c.request(method, path, body=body, headers=h)
    r = c.getresponse()
    data = r.read()
    c.close()
    return r.status, data


auth = {"X-Too-Long-Token": token}
tasks = httpd.app["regen"].document.model["tasks"]

# The page gets the token in index.html only (scripts can be included cross-site; HTML can't be read).
status, html = req("GET", "/")
assert status == 200 and f'content="{token}"'.encode() in html
status, data_js = req("GET", "/data.js")
assert status == 200 and token.encode() not in data_js

# Toggle through the API: the Markdown changes, data.js follows.
rev = revision(md.read_bytes())
status, body = req("POST", "/api/task", {"id": tasks[1]["id"], "done": True, "revision": rev}, auth)
assert status == 200, body
assert md.read_text() == "# Plan\n\n## Work\n\n- [ ] One\n- [x] Two\n"
assert json.loads(body)["revision"] == revision(md.read_bytes())
status, body = req("GET", "/api/state", headers=auth)
assert json.loads(body)["revision"] == revision(md.read_bytes())
assert b'"done": true' in req("GET", "/data.js")[1]

# A stale revision is a 409 with the current revision; nothing is written.
snapshot = md.read_bytes()
status, body = req("POST", "/api/task", {"id": tasks[0]["id"], "done": True, "revision": rev}, auth)
assert status == 409 and json.loads(body)["revision"] == revision(snapshot) and md.read_bytes() == snapshot

# Unknown task, malformed body.
cur = revision(md.read_bytes())
assert req("POST", "/api/task", {"id": "t-nope", "done": True, "revision": cur}, auth)[0] == 404
assert req("POST", "/api/task", {"id": tasks[0]["id"]}, auth)[0] == 400

# Refused: no/wrong token, foreign Origin, cross-site fetch, DNS rebinding (wrong Host).
good = {"id": tasks[0]["id"], "done": True, "revision": cur}
assert req("POST", "/api/task", good)[0] == 403
assert req("POST", "/api/task", good, {"X-Too-Long-Token": "guess"})[0] == 403
assert req("POST", "/api/task", good, {**auth, "Origin": "https://evil.example"})[0] == 403
assert req("POST", "/api/task", good, {**auth, "Sec-Fetch-Site": "cross-site"})[0] == 403
assert req("POST", "/api/task", good, {**auth, "Host": f"evil.example:{port}"})[0] == 403
assert req("GET", "/data.js", headers={"Host": "evil.example"})[0] == 403
assert md.read_bytes() == snapshot

# Only the output folder is served.
for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/../plan.md"):
    status, body = req("GET", path)
    assert b"outside the site folder" not in body and b"- [x] Two" not in body, (path, status)

# Editing the Markdown in an editor: the server rebuilds and reports the new revision.
md.write_text(md.read_text() + "- [ ] Three\n")
deadline = time.time() + 5
while time.time() < deadline:
    if json.loads(req("GET", "/api/state", headers=auth)[1])["revision"] == revision(md.read_bytes()):
        break
    time.sleep(0.1)
else:
    raise AssertionError("server did not pick up the edit")
assert re.search(rb'"text": "Three"', req("GET", "/data.js")[1])

httpd.shutdown()
httpd.app["watch"].stop()
print("ok")
