# Ledger: billing service rewrite

Move invoicing out of the monolith into `services/ledger/`. See `services/ledger/app.py` and `app.py`.

**Decision:** Keep Postgres as the system of record. Rationale: the finance team already audits it.

## Risks and decisions

- **Risk:** Double charges during the cut-over. **Mitigation:** idempotency keys on every charge.
- **Decision:** Run both systems in parallel for two weeks.
- Rollback must be possible within an hour.

## Risk register

| Risk | Impact | Owner |
|---|---|---|
| Stripe webhook backlog | High | Payments |
| Currency rounding drift | Medium | Finance |

## Phase 1 — Schema

- **Dependencies:** None.
- [ ] Create `services/ledger/models.py`
- [ ] Write migrations

## Phase 2 — API

- **Depends on:** Phase 1.
- [ ] Write migrations
- [ ] Add `services/ledger/api.py` and `api.py` tests

## Phase 3 — Web dashboard

- **Dependencies:** Phase 1. Can run in parallel with Phase 2.
- [ ] Charts in `web/src/ledger/`

## Phase 4 — Cut-over

- **Dependencies:** probably the API work, once finance signs off.
- [ ] Switch traffic

## Phase 5 — Cleanup

- **Requires:** P2, P4, P7.
- [ ] Delete the old `billing/` module

## Architectural decisions

**Decision 1 — Event log for every balance change.**
Rationale: auditors replay it. **Rejected:** *mutable balances*, which lose history.

**Decision 2 — Amounts are integers in minor units.**
**Rejected:**
- *Floats.* Rounding errors.
- *Decimal strings.* Slow to aggregate.

## Open questions

- Who owns refunds after the cut-over?
- **Open question:** Do we need multi-currency at launch? **Answer:** no, EUR only.
