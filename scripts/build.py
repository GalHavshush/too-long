#!/usr/bin/env python3
"""too-long, step 3: content model + config -> static site.

    python3 build.py plan.md [--out .too-long] [--config path/to/config.json]

Writes <out>/index.html, styles.css, app.js (copied from ../assets), data.js
(window.TOO_LONG = {model, config}) and build.json (ids kept between builds).
data.js is a script, not JSON, so the site works from file:// with no server.

The config is step 2 (visualization selection), written by Claude. Defaults
to <out>/config.json when it exists; without one, suggested views are used.

This is a thin command over regen.Regenerator (see also watch.py).
"""
import argparse
import sys

from regen import Regenerator


def main():
    ap = argparse.ArgumentParser(description="Turn a Markdown file into a local visual site.")
    ap.add_argument("markdown")
    ap.add_argument("--out", default=".too-long")
    ap.add_argument("--config")
    args = ap.parse_args()

    regen = Regenerator(args.markdown, args.out, args.config)
    result = regen.refresh(force=True)
    if not result.ok:
        sys.exit(result.error)
    for w in result.warnings:
        print(f"warning: {w}")
    doc = regen.document
    print(f"Built {regen.out / 'index.html'}  views: {', '.join(doc.config['views'])}"
          f"  ({len(doc.model['sections'])} sections, {len(doc.model['tasks'])} tasks)")


if __name__ == "__main__":
    main()
