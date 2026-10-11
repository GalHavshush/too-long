#!/usr/bin/env python3
"""Run every test:  python3 scripts/run_tests.py

Each tests/test_*.py is a plain script that exits non-zero on failure.
tests/*.mjs are browser tests (Node 22+ and Chrome); they skip themselves when those are missing.
"""
import shutil
import subprocess
import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parent.parent / "tests"


def main():
    cmds = [[sys.executable, str(t)] for t in sorted(TESTS.glob("test_*.py"))]
    node = shutil.which("node")
    for t in sorted(TESTS.glob("*.mjs")):
        if node:
            cmds.append([node, str(t)])
        else:
            print(f"skip {t.name}: node not found")
    failed = []
    for cmd in cmds:
        name = Path(cmd[-1]).name
        r = subprocess.run(cmd, cwd=TESTS, capture_output=True, text=True)
        print(f"{'ok  ' if r.returncode == 0 else 'FAIL'} {name}")
        if r.returncode:
            failed.append(name)
            print((r.stdout + r.stderr).rstrip())
    print(f"\n{len(cmds) - len(failed)}/{len(cmds)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
