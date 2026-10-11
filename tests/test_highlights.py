#!/usr/bin/env python3
"""Semantic highlight extraction:  python3 tests/test_highlights.py"""
from _path import ROOT
from parse import parse_file

FIX = ROOT / "tests" / "fixtures"


def decisions(name):
    return [c for c in parse_file(FIX / name)["callouts"] if c["kind"] == "decision"]


# ---- TaskForge, section 17: twelve numbered decisions with rejected alternatives ----
tf = decisions("taskforge-decisions.md")
assert [d.get("number") for d in tf] == list(range(1, 13)), [d.get("number") for d in tf]
by = {d["number"]: d for d in tf}
assert by[2]["title"] == "Claims are fenced by a CAS `UPDATE` in PostgreSQL with a per-claim `lease_token`."
assert [r["text"].split("*")[1] for r in by[2]["rejected"]] == [
    "Redis reliable queue (`LMOVE` into a processing list).", "Redlock."]
assert [len(by[n]["rejected"]) for n in range(1, 13)] == [2, 2, 1, 1, 1, 2, 2, 1, 2, 0, 1, 0]
# No rejected alternative is ever presented as a decision.
titles = " ".join(d["title"] for d in tf)
for alt in ("Redlock", "Redis Streams", "JWT", "bcrypt", "Prefork", "Redis-only state"):
    assert alt not in titles, alt
# Tradeoffs and explanations stay with their decision, in a separate paragraph or inline.
assert {d["label"] for d in by[6]["details"]} == {"tradeoff"} and "starve" in by[6]["details"][0]["text"]
assert by[1]["details"][0]["text"] == "two writes per dispatch, plus reconciler complexity."
assert by[3]["body"][0]["text"].startswith("Crashes are detected") and "heartbeat write load" in by[3]["details"][0]["text"]
assert by[12]["body"][0]["text"] == "Lower cost to build, and it reuses the existing alerting stack."
# Source references: the decision line and each rejected alternative's own line.
lines = (FIX / "taskforge-decisions.md").read_text().splitlines()
for d in tf:
    assert f"Decision {d['number']} —" in lines[d["line"] - 1]
    for r in d["rejected"]:
        assert r["text"][:12] in lines[r["line"] - 1] or r["text"][:12] in lines[r["line"]], r
# Nothing is lost: every rejected alternative's text is still in the entry's blocks.
for d in tf:
    blocks_text = repr(d["blocks"])
    assert all(r["text"][:20] in blocks_text for r in d["rejected"])

# ---- Formats ----
f = {(d["at"], d.get("number"), d["title"]): d for d in decisions("decision-formats.md")}
keys = list(f)
assert keys == [
    ("plain-labels", None, "Use PostgreSQL."),
    ("plain-labels", None, "Keep the API stateless."),
    ("plain-labels", 4, "Ship weekly."),
    ("decision-1-postgresql-persistence", 1, "PostgreSQL persistence"),
    ("decision-2-fenced-claims", 2, "Fenced claims"),
    ("decisions", None, "Use Vite for the frontend"),
    ("decisions", None, "Use pnpm workspaces"),
    ("key-decisions", 7, "Cache reads in the edge."),
], keys
heading = f[keys[3]]
assert [r["text"] for r in heading["rejected"]] == ["Redis-only persistence.", "In-memory persistence."]
assert heading["details"] == [{"label": "rationale", "text": "one system to operate.", "line": heading["details"][0]["line"]}]
assert "body" not in f[keys[2]]  # "Note - ..." after it is prose of its own, not part of it
assert f[keys[5]]["from_heading"] and "from_heading" not in f[keys[0]]  # plain bullets under "Decisions" still count
assert f[keys[7]]["details"][0]["label"] == "tradeoff" and f[keys[7]]["rejected"][0]["text"].startswith("*a write-through cache*")
assert f[keys[7]]["body"][0]["text"].startswith("A paragraph in a decisions section")

# ---- ADR: the "## Decision" section is one decision ----
adr = decisions("adr.md")
assert len(adr) == 1 and adr[0]["title"] == "We will store billing changes as an append-only event log.", adr
print("ok")
