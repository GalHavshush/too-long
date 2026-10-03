#!/usr/bin/env python3
"""Parse the skill's argument string: `plan.md`, `plan.md --video`, `--video plan.md`.

    python3 args.py '--video "my plan.md"'   ->  {"file": "my plan.md", "video": true}

--video can appear anywhere. Unquoted paths with spaces are rejoined. Any other
--flag is an error (the skill has no other flags).
"""
import json
import shlex
import sys


def parse_args(text):
    try:
        tokens = shlex.split(text)
    except ValueError:  # unbalanced quote: fall back to plain splitting
        tokens = text.split()
    video = "--video" in tokens
    rest = [t for t in tokens if t != "--video"]
    unknown = [t for t in rest if t.startswith("--")]
    if unknown:
        raise ValueError(f"Unknown option {unknown[0]}. Usage: <file.md> [--video]")
    return {"file": " ".join(rest), "video": video}


if __name__ == "__main__":
    try:
        print(json.dumps(parse_args(" ".join(sys.argv[1:]))))
    except ValueError as e:
        sys.exit(str(e))
