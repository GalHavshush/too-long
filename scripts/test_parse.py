#!/usr/bin/env python3
"""Smoke test for the parser:  python3 scripts/test_parse.py"""
from parse import build_model

SAMPLE = """# Billing Rewrite

Move billing to `services/billing/` and drop the cron jobs.

**Decision:** Use Postgres, not Mongo.

## Phase 1: Setup

- [x] Create `services/billing/main.py`
- [ ] Add CI
  - [ ] Lint step
1. Run:

   ```bash
   make dev
   ```

> [!WARNING]
> Prod keys live in `.env`.

### Data model

| Table | Owner |
|-------|-------|
| invoices | `models/invoice.ts` |

## Phase 2: Launch

Risk: Webhooks may arrive twice.

```mermaid
graph LR; A-->B
```

## Open Questions

- Who owns refunds?
- Do we need multi-currency?
"""

m = build_model(SAMPLE, "plan")
ids = [s["id"] for s in m["sections"]]
assert m["title"] == "Billing Rewrite", m["title"]
assert ids == ["phase-1-setup", "phase-2-launch", "open-questions"], ids
assert m["sections"][0]["subsections"][0]["id"] == "data-model"
assert [(t["text"], t["done"]) for t in m["tasks"]] == [
    ("Create `services/billing/main.py`", True), ("Add CI", False), ("Lint step", False)]
kinds = [c["kind"] for c in m["callouts"]]
assert kinds == ["decision", "warning", "risk", "question", "question"], kinds
assert m["callouts"][-1].get("from_heading")
assert m["roadmap"] == {"ids": ["phase-1-setup", "phase-2-launch"], "basis": "titles"}
assert len(m["diagrams"]) == 1 and m["stats"]["code_blocks"] == 1
# the fenced block inside the numbered list stays attached to its item
lst = [b for b in m["sections"][0]["blocks"] if b["type"] == "list"]
assert lst[1]["items"][0]["blocks"][0]["text"] == "make dev"
files = [f["path"] for f in m["files"]]
assert files == [".env", "models/invoice.ts", "services/billing/", "services/billing/main.py"], files
print("ok")

# milestone markers, section-title kinds, decision tables, tracked numbered steps
m = build_model("""# P

## Product decisions

| Area | Decision |
|---|---|
| Auth | Supabase |

## Steps

### First product milestone

1. **Login.** Email + password.
2. **Schedule.**

> **★ Milestone 2: first demo.** End to end.
""", "p", track=["steps"])
c = [(x["kind"], x["blocks"][0]["text"]) for x in m["callouts"]]
assert c == [("decision", "**Auth** · Supabase"), ("milestone", "**first demo.** End to end.")], c
assert [(t["n"], t["done"], t["at"]) for t in m["tasks"]] == [(1, False, "first-product-milestone"), (2, False, "first-product-milestone")]
assert m["roadmap"]["basis"] == "sections"
print("ok")
