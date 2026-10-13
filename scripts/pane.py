#!/usr/bin/env python3
"""The side pane's way into the core: one short command, one JSON object on stdout.

    python3 pane.py model PLAN [--root DIR]                          rebuild the site, print the pane's summary
    python3 pane.py task  PLAN TASK_ID (--done|--undo) --revision R  write one checkbox (sync.update_task)
    python3 pane.py open  PLAN [--url URL]                           open the site (or URL) in the default browser
    python3 pane.py serve PLAN [--root DIR]                          serve the site live (serve.py) until killed

The output folder is always <plan's folder>/.too-long/<plan name>/, worked out here so the caller
never has to. `--root` is the project the plan is about, for "does this file exist" (a plan kept in
~/.claude/plans/ names files of the project, not of that folder).

stdout is always one JSON object with a "status":
    model  ok | error
    task   applied | conflict | busy | not_found | not_a_task | error
    open   ok | error
    serve  serving (with "url", printed once the server listens; it then runs until killed) | error
Exit code 0 for ok/applied, 1 for every other status (the JSON still says why), 2 for bad usage.
No traceback for expected failures: "error" carries a message a person can act on.
"""
import sys

if sys.version_info < (3, 9):
    sys.exit(f"too-long needs Python 3.9 or newer (this is {sys.version.split()[0]}).")

import argparse  # noqa: E402
import json  # noqa: E402
import webbrowser  # noqa: E402
from pathlib import Path  # noqa: E402

import sync  # noqa: E402
from config import ConfigError  # noqa: E402
from parse import InputError  # noqa: E402
from regen import Regenerator  # noqa: E402

LOCK_TIMEOUT = 5.0  # seconds to wait for another writer before answering "busy"
HIGHLIGHT_KINDS = ("decision", "risk", "question")


def out_dir(plan):
    plan = Path(plan).resolve()
    return plan.parent / ".too-long" / plan.stem


def summary(model):
    """What the pane draws, and nothing more: the full model stays in data.js for the site."""
    tasks = model["tasks"]
    titles = {}
    for s in model["sections"]:
        titles[s["id"]] = s["title"]
        titles.update((sub["id"], sub["title"]) for sub in s["subsections"])
    stages = []
    for sid in model["roadmap"]["ids"]:
        own = [t for t in tasks if sid in (t["section"], t["at"])]
        stages.append({"id": sid, "title": titles.get(sid, sid),
                       "done": sum(t["done"] for t in own), "total": len(own)})
    highlights = []
    for c in model["callouts"]:
        if c["kind"] in HIGHLIGHT_KINDS:
            h = {"kind": c["kind"], "title": c["title"], "line": c["line"]}
            mitigation = next((d["text"] for d in c["details"] if d["label"] == "mitigation"), None)
            if mitigation:
                h["mitigation"] = mitigation
            highlights.append(h)
    return {
        "revision": model["revision"], "doc_id": model["doc_id"], "title": model["title"], "file": model["file"],
        "sections": [{"id": s["id"], "title": s["title"]} for s in model["sections"]],
        "stages": stages,
        "tasks": [{k: t[k] for k in ("id", "text", "done", "section", "at", "line")} | {"browser_only": bool(t.get("browser_only"))}
                  for t in tasks],
        "highlights": highlights,
        "files": [{"path": f["path"], "status": f["status"]} for f in model["files"]],
        "warnings": model["warnings"],
    }


def cmd_model(plan, root=None):
    regen = Regenerator(plan, out_dir(plan), root=root)
    result = regen.refresh(force=True)
    if not result.ok:
        return {"status": "error", "error": result.error}
    out = regen.out
    return {"status": "ok", "path": str(Path(plan).resolve()), "out": str(out), "index": str(out / "index.html"),
            **summary(regen.document.model)}


def cmd_task(plan, task_id, done, rev):
    try:
        r = sync.update_task(plan, task_id, done, rev, out=out_dir(plan), timeout=LOCK_TIMEOUT)
    except sync.TaskNotFound:
        return {"status": "not_found", "error": f"no task {task_id} in {Path(plan).name}"}
    except sync.NotATask as e:
        return {"status": "not_a_task", "error": str(e)}
    except (InputError, ConfigError, OSError) as e:
        return {"status": "error", "error": str(e)}
    if isinstance(r, sync.Busy):
        return {"status": "busy", "error": f"{Path(plan).name} is being written by another process"}
    if isinstance(r, sync.Conflict):
        return {"status": "conflict", "revision": r.revision}
    return {"status": "applied", "revision": r.revision, "line": r.line}


def cmd_open(plan, url=None):
    if not url:
        index = out_dir(plan) / "index.html"
        if not index.exists():
            built = cmd_model(plan)
            if built["status"] != "ok":
                return built
        url = index.as_uri()
    if not webbrowser.open(url):
        return {"status": "error", "error": f"no browser found; open {url} by hand"}
    return {"status": "ok", "url": url}


def cmd_serve(plan, root=None):
    """serve.py for the pane: ticks in the browser are written to the plan, and plan edits (the
    pane's ticks too) reload the open page. Prints the URL as JSON, then serves until killed."""
    from serve import make_server  # only this command needs it

    try:
        httpd = make_server(plan, out_dir(plan), port=0, root=root)
    except SystemExit as e:  # make_server's own message for a first build that failed
        return {"status": "error", "error": str(e.code)}
    except OSError as e:
        return {"status": "error", "error": f"could not start the local server: {e.strerror or e}"}
    print(json.dumps({"status": "serving", "url": f"http://127.0.0.1:{httpd.app['port']}/"}), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.app["watch"].stop()
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description="JSON interface for the too-long side pane.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("model")
    m.add_argument("plan")
    m.add_argument("--root")
    t = sub.add_parser("task")
    t.add_argument("plan")
    t.add_argument("task_id")
    state = t.add_mutually_exclusive_group(required=True)
    state.add_argument("--done", action="store_true")
    state.add_argument("--undo", action="store_true")
    t.add_argument("--revision", required=True)
    o = sub.add_parser("open")
    o.add_argument("plan")
    o.add_argument("--url")
    v = sub.add_parser("serve")
    v.add_argument("plan")
    v.add_argument("--root")
    args = ap.parse_args(argv)

    if args.cmd == "model":
        res = cmd_model(args.plan, args.root)
    elif args.cmd == "task":
        res = cmd_task(args.plan, args.task_id, args.done, args.revision)
    elif args.cmd == "open":
        res = cmd_open(args.plan, args.url)
    else:
        res = cmd_serve(args.plan, args.root)
        if res is None:  # served until stopped
            return 0
    print(json.dumps(res))
    return 0 if res["status"] in ("ok", "applied") else 1


if __name__ == "__main__":
    sys.exit(main())
