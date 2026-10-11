#!/usr/bin/env python3
"""too-long command line. One entry point for everything the skill does:

    python3 too_long.py build  plan.md [--out .too-long] [--config FILE]   build the site
    python3 too_long.py watch  plan.md [--out ...]                         rebuild on every save
    python3 too_long.py serve  plan.md [--port 8765] [--out ...]           serve, ticking tasks writes the Markdown
    python3 too_long.py parse  plan.md [--json]                            print the structure
    python3 too_long.py video  plan.md [--out .too-long/video]             render the explainer video
    python3 too_long.py doctor                                             what is installed, what each feature needs

Each command is the script of the same name (build.py, watch.py, ...); this only checks the input
file first and dispatches. Output goes to .too-long/ in the current folder unless --out says otherwise.
"""
import sys

if sys.version_info < (3, 9):
    sys.exit(f"too-long needs Python 3.9 or newer (this is {sys.version.split()[0]}).")

import platform  # noqa: E402
from pathlib import Path  # noqa: E402

from parse import InputError, read_markdown  # noqa: E402

COMMANDS = {"build": "build", "watch": "watch", "serve": "serve", "parse": "parse", "video": "video"}
VALUE_OPTIONS = {"--out", "--config", "--port"}  # options followed by a value, not the file
MARKDOWN_EXTS = {".md", ".markdown", ".mdown", ".mkd", ".mdx", ".txt"}


def check_input(args):
    """The first non-option argument must be a readable UTF-8 file. Returns an error message or None."""
    path, skip = None, False
    for a in args:
        if skip:
            skip = False
        elif a in VALUE_OPTIONS:
            skip = True
        elif not a.startswith("-"):
            path = a
            break
    if path is None:
        return "Give the Markdown file to use, e.g. too_long.py build plan.md"
    try:
        read_markdown(path)
    except InputError as e:
        return str(e)
    if Path(path).suffix.lower() not in MARKDOWN_EXTS:
        print(f"note: {path} does not end in .md; reading it as Markdown anyway.", file=sys.stderr)
    return None


def doctor():
    from video import check_tools, node_major  # only needed here

    tools, problems = check_tools()
    node = node_major()
    rows = [
        ("Python", sys.version.split()[0], True, "everything (3.9+)"),
        ("Node.js", f"v{node}" if node else None, (node or 0) >= 22, "video, browser tests (22+)"),
        ("Chrome", tools["chrome"], bool(tools["chrome"]), "video, browser tests"),
        ("ffmpeg", tools["ffmpeg"], bool(tools["ffmpeg"]), "video"),
        ("say", tools["say"], bool(tools["say"]), "video narration (macOS; without it: captions only)"),
    ]
    print(f"too-long on {platform.system()} {platform.machine()}\n")
    for name, found, ok, needed_for in rows:
        print(f"  {'ok     ' if ok else 'missing'}  {name:<8} {found or '':<45.45}  needed for: {needed_for}")
    print("\nThe site (build, watch, serve) needs only Python. Viewing it needs any modern browser;"
          "\nMermaid diagrams load from a CDN the first time (offline, their source is shown).")
    if problems:
        print("\nFor video:\n  - " + "\n  - ".join(problems))
    return 0


def open_command():
    return {"darwin": "open", "win32": "start"}.get(sys.platform, "xdg-open")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "doctor":
        return doctor()
    if cmd not in COMMANDS:
        print(f"Unknown command '{cmd}'. Commands: {', '.join([*COMMANDS, 'doctor'])}\n", file=sys.stderr)
        print(__doc__.strip(), file=sys.stderr)
        return 2
    if not (cmd == "video" and "--check" in rest) and "-h" not in rest and "--help" not in rest:
        error = check_input(rest)
        if error:
            print(error, file=sys.stderr)
            return 1
    module = __import__(COMMANDS[cmd])
    sys.argv = [f"too_long.py {cmd}", *rest]
    module.main()
    if cmd == "build":
        out = next((rest[i + 1] for i, a in enumerate(rest[:-1]) if a == "--out"), ".too-long")
        print(f"Open it: {open_command()} {Path(out) / 'index.html'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
