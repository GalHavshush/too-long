"""Stable identity for documents and tasks, kept in <out>/build.json between builds.

    doc_id   one per document. Browser state is keyed by it, so two plans with the same
             title never share checks. Survives edits, and moves/renames of the Markdown.
    task ids the parser gives each task a slug id; on rebuilds, reconcile() keeps the id a
             task had last time, so state follows the task through ordinary edits.
    sig      a hash of the task text. Browser-only state is stored with it and only applied
             while it still matches, so state never silently moves to a different task.

No HTTP, no browser, no printing: build.py uses it today, a future editor integration can too.
"""
import difflib
import hashlib
import json
import os
import re
import uuid
from pathlib import Path

MANIFEST = "build.json"
RENAME_MIN = 0.75     # similarity needed to treat an edited task as the same task
RENAME_MARGIN = 0.15  # ...and how clearly it must beat the next candidate


def load_manifest(out):
    try:
        data = json.loads((Path(out) / MANIFEST).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def source_ref(md_path, out):
    """The Markdown path as stored in build.json: relative to the output folder, so moving both
    together (or committing an example) keeps it valid and no absolute path is written."""
    return Path(os.path.relpath(Path(md_path).resolve(), Path(out).resolve())).as_posix()


def doc_id_for(md_path, manifest, out):
    """Keep the previous id when this output folder was built from the same file, or when that
    file is gone (moved or renamed). A different, still existing file gets a new id."""
    old, source = manifest.get("doc_id"), manifest.get("source")
    if old and (not source or source == source_ref(md_path, out) or not Path(os.path.normpath(Path(out).resolve() / source)).exists()):
        return old
    return uuid.uuid4().hex[:16]


def sig(text):
    return hashlib.sha1(re.sub(r"\s+", " ", text).strip().encode()).hexdigest()[:10]


def reconcile(prev, new):
    """prev: [{id, text, at}] from the last build; new: the parser's tasks (in order).
    Returns {parser id: stable id}. Match order: same section + same text (duplicates in order),
    then an unambiguous rename in the same section, else a fresh id that no earlier task used."""
    mapping, used_prev = {}, set()
    for t in new:
        p = next((p for p in prev if p["id"] not in used_prev and p["at"] == t["at"] and p["text"] == t["text"]), None)
        if p:
            mapping[t["id"]] = p["id"]
            used_prev.add(p["id"])

    # Renames: both sides must be each other's clear best match.
    left = [t for t in new if t["id"] not in mapping]
    spare = [p for p in prev if p["id"] not in used_prev]
    score = {(t["id"], p["id"]): difflib.SequenceMatcher(None, t["text"], p["text"]).ratio()
             for t in left for p in spare if p["at"] == t["at"]}

    def best(key_side, k):
        ranked = sorted(((s, pair) for pair, s in score.items() if pair[key_side] == k), reverse=True)
        top = ranked[0] if ranked else (0, None)
        runner = ranked[1][0] if len(ranked) > 1 else 0
        return top, runner

    for t in left:
        (s, pair), runner = best(0, t["id"])
        if not pair or s < RENAME_MIN or s - runner < RENAME_MARGIN:
            continue
        (s2, back), runner2 = best(1, pair[1])
        if back == pair and s2 - runner2 >= RENAME_MARGIN and pair[1] not in used_prev:
            mapping[t["id"]] = pair[1]
            used_prev.add(pair[1])

    # Everything else is new. Its id must not reuse an id an earlier task had.
    taken = {p["id"] for p in prev} | set(mapping.values())
    for t in new:
        if t["id"] not in mapping:
            base, n, tid = t["id"], 2, t["id"]
            while tid in taken:
                tid, n = f"{base}-{n}", n + 1
            mapping[t["id"]] = tid
            taken.add(tid)
    return mapping


def apply_identity(model, md_path, manifest, out):
    """Give the model its doc_id and stable task ids. Returns the manifest to save in `out`."""
    model["doc_id"] = doc_id_for(md_path, manifest, out)
    same_doc = model["doc_id"] == manifest.get("doc_id")
    mapping = reconcile(manifest.get("tasks", []) if same_doc else [], model["tasks"])

    def rename(items):
        for it in items:
            if "id" in it:
                it["id"] = mapping[it["id"]]
            rename(it.get("children", []))

    def walk(blocks):
        for b in blocks:
            if b["type"] == "list":
                rename(b["items"])
                for it in _all_items(b["items"]):
                    walk(it.get("blocks", []))
            elif "blocks" in b:
                walk(b["blocks"])

    walk(model["intro"])
    for s in model["sections"]:
        walk(s["blocks"])
        for sub in s["subsections"]:
            walk(sub["blocks"])
    for t in model["tasks"]:
        t["id"] = mapping[t["id"]]
        t["sig"] = sig(t["text"])
    return {"doc_id": model["doc_id"], "source": source_ref(md_path, out),
            "tasks": [{"id": t["id"], "text": t["text"], "at": t["at"]} for t in model["tasks"]]}


def _all_items(items):
    for it in items:
        yield it
        yield from _all_items(it.get("children", []))
