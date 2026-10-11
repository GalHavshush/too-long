"""The document model: one function that turns a Markdown file (+ config + the previous build's
manifest) into the JSON every viewer reads. Pure: reads the Markdown, writes nothing.

    doc = build_document("plan.md", config, manifest, out=".too-long")
    doc.model, doc.config, doc.warnings, doc.manifest

The contract (fields, ids, invariants) is documented in docs/model.md; check_invariants() tests it.
Used by regen.py (site builds, watch mode) and sync.py (task updates); a future editor
integration can call it directly.
"""
import copy
import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

from config import check_config, config_sha, stamps, staleness
from identity import apply_identity
from parse import build_model, read_markdown, section_ids
from roadmap import add_dependencies

SCHEMA_VERSION = 1


def revision(data):
    """Identifies one exact version of the Markdown file (its bytes). sync.py refuses writes
    based on another version."""
    return hashlib.sha256(data).hexdigest()



@dataclass
class Document:
    model: dict
    config: dict
    warnings: list
    manifest: dict


def build_document(md_path, config, manifest, out):
    md_path, out = Path(md_path), Path(out)
    config = copy.deepcopy(config)
    sha = config_sha(config)
    # A config Claude just wrote (new or changed) must be exact; an older one survives document edits.
    new_config = sha != manifest.get("config_sha")

    data, text = read_markdown(md_path)  # one read: the revision always matches what was parsed
    model = build_model(text, md_path.stem, config.get("track", []))
    model["file"] = md_path.name
    model["schema_version"] = SCHEMA_VERSION
    model["revision"] = revision(data)
    # Relative links in the Markdown are relative to the .md file, not the output folder.
    model["base"] = os.path.relpath(md_path.resolve().parent, out.resolve()).replace(os.sep, "/")

    config, warnings = check_config(config, model, strict=new_config)
    warnings = model["warnings"] + warnings + add_dependencies(model, config)
    new_manifest = apply_identity(model, md_path, manifest, out)

    now = stamps(config, model)
    then = now if new_config else manifest.get("stamps", now)
    model["stale"] = staleness(then, now)
    new_manifest.update(config_sha=sha, stamps=then)  # keep the old stamps until the config is rewritten
    for i in model["stale"]["notes"]:
        warnings.append(f"note for '{i}' may be outdated: that section changed since the note was written")
    for k in model["stale"]["diagrams"]:
        warnings.append(f"diagram {k + 1} may be outdated: a section it is based on changed")
    if model["stale"]["tldr"]:
        warnings.append("the TL;DR may be outdated: the document changed since it was written")
    return Document(model, config, warnings, new_manifest)


def check_invariants(model):
    """The promises in docs/model.md. Returns a list of broken ones (empty = fine)."""
    problems = []
    ids = section_ids(model)
    n_lines = len(model["source"].splitlines())
    task_ids = [t["id"] for t in model["tasks"]]
    if len(set(task_ids)) != len(task_ids):
        problems.append("task ids are not unique")
    if not isinstance(model.get("revision"), str) or len(model["revision"]) != 64:
        problems.append("revision is missing")
    if model.get("schema_version") != SCHEMA_VERSION:
        problems.append("schema_version is missing or unknown")

    def items(blocks):
        for b in blocks:
            if b["type"] == "list":
                stack = list(b["items"])
                while stack:
                    it = stack.pop()
                    yield it
                    stack += it.get("children", [])
                    yield from items(it.get("blocks", []))
            yield from items(b.get("blocks", []) if b["type"] != "list" else [])

    in_blocks = {it["id"] for blk in [model["intro"]] + [s["blocks"] for s in model["sections"]] +
                 [x["blocks"] for s in model["sections"] for x in s["subsections"]] for it in items(blk) if "id" in it}
    if set(task_ids) != in_blocks:
        problems.append("tasks in model.tasks and in the document blocks differ")
    for kind, entries in (("task", model["tasks"]), ("callout", model["callouts"]), ("diagram", model["diagrams"])):
        for e in entries:
            if e["at"] not in ids or e["section"] not in ids:
                problems.append(f"{kind} points at unknown section {e['at']!r}")
            if not 1 <= e.get("line", 0) <= n_lines:
                problems.append(f"{kind} line {e.get('line')} is outside the document")
    for f in model["files"]:
        if any(a not in ids for a in f["at"]):
            problems.append(f"file {f['path']} points at an unknown section")
    for i in model["roadmap"]["ids"]:
        if i not in ids:
            problems.append(f"roadmap stage {i!r} is not a section")
    return problems
