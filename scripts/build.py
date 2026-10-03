#!/usr/bin/env python3
"""too-long, step 3: content model + config -> static site.

    python3 build.py plan.md [--out .too-long] [--config path/to/config.json]

Writes <out>/index.html, styles.css, app.js (copied from ../assets) and
data.js (window.TOO_LONG = {model, config}). data.js is a script, not JSON,
so the site works from file:// with no server.

The config is step 2 (visualization selection), written by Claude. Defaults
to <out>/config.json when it exists; without one, suggested views are used.
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from parse import parse_file, suggest_views

ASSETS = Path(__file__).resolve().parent.parent / "assets"
VIEWS = ["overview", "document", "roadmap", "tasks", "highlights", "diagrams", "files", "steps"]


def check_config(config, model):
    """Validate the config and enforce the fidelity rules. Returns (config, warnings)."""
    warnings = []
    ids = {"intro"} | {s["id"] for s in model["sections"]} | {
        sub["id"] for s in model["sections"] for sub in s["subsections"]}

    views = config.get("views") or suggest_views(model)
    unknown = [v for v in views if v not in VIEWS]
    if unknown:
        sys.exit(f"Unknown view(s): {', '.join(unknown)}. Choose from: {', '.join(VIEWS)}")
    if "document" not in views:  # the full, faithful document is always reachable
        views.append("document")
        warnings.append("added 'document' view (always included so no content is hidden)")
    config["views"] = list(dict.fromkeys(views))

    for key in config.get("notes", {}):
        if key not in ids:
            warnings.append(f"note for unknown section id '{key}' will not be shown")

    for key in ("roadmap", "track"):
        for i in config.get(key, []):
            if i not in ids:
                sys.exit(f"config '{key}' has unknown section id '{i}'")
    if config.get("roadmap"):  # stages picked by Claude instead of detected from titles
        model["roadmap"] = {"ids": config["roadmap"], "basis": "config"}

    for d in config.get("diagrams", []):
        if not d.get("title") or not d.get("mermaid"):
            sys.exit("Each config diagram needs 'title' and 'mermaid'.")
        d["inferred"] = True  # anything in the config was written by Claude, not the document
        for src in d.get("sources", []):
            if src not in ids:
                warnings.append(f"diagram '{d['title']}' cites unknown section id '{src}'")
    if config.get("diagrams") and "diagrams" not in config["views"]:
        warnings.append("config has diagrams but the 'diagrams' view is not enabled")
    return config, warnings


def main():
    ap = argparse.ArgumentParser(description="Turn a Markdown file into a local visual site.")
    ap.add_argument("markdown")
    ap.add_argument("--out", default=".too-long")
    ap.add_argument("--config")
    args = ap.parse_args()

    md = Path(args.markdown)
    out = Path(args.out)
    cfg_path = Path(args.config) if args.config else out / "config.json"
    config = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
    model = parse_file(md, config.get("track", []))
    # Relative links in the Markdown are relative to the .md file, not the output folder.
    model["base"] = os.path.relpath(md.resolve().parent, out.resolve()).replace(os.sep, "/")

    config, warnings = check_config(config, model)

    out.mkdir(parents=True, exist_ok=True)
    for name in ("index.html", "styles.css", "app.js"):
        shutil.copy(ASSETS / name, out / name)
    data = json.dumps({"model": model, "config": config}, ensure_ascii=False)
    (out / "data.js").write_text(f"window.TOO_LONG = {data};\n", encoding="utf-8")

    for w in warnings:
        print(f"warning: {w}")
    print(f"Built {out / 'index.html'}  views: {', '.join(config['views'])}"
          f"  ({len(model['sections'])} sections, {len(model['tasks'])} tasks)")


if __name__ == "__main__":
    main()
