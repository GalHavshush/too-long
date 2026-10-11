# Risk formats

## Paragraphs

Risk: PostgreSQL becomes a bottleneck.

Mitigation: Batch database operations.

**Risk:** Redis loses writes on failover. **Mitigation:** the reconciler rebuilds the queue.

## Standalone

Mitigation: a mitigation with no risk before it stays plain text.

## Risks and mitigations

- Risk: Workers starve the event loop.
- Mitigation: Cap `to_thread` concurrency.
- Risk: Metrics explode in cardinality.
  - Impact: dashboards time out.
  - Mitigation: no tenant labels.
  - Owner: platform team.
- An unlabeled bullet under the heading is a risk of its own.

## Review table

| Risk | Likelihood / Impact | Mitigations |
|---|---|---|
| Vendor lock-in | L / H | Keep the queue behind an interface |

## Open questions

- **Open question:** Do we need multi-region? **Answer:** not before GA.

## Context

Assumption: Tenants are internal teams.

## Phase 7

- **Deliverables:** A self-healing platform. **Milestone:** M1 internal alpha (MVP complete).
