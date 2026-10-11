# Decision formats

## Plain labels

Decision: Use PostgreSQL.

**Decision:** Keep the API stateless. It makes scaling trivial.

Decision 4 - Ship weekly.

Note - a dash without a number is prose, not a label.

## Headings

### Decision 1: PostgreSQL persistence

We persist everything in PostgreSQL.

Rationale: one system to operate.

Rejected:
- Redis-only persistence.
- In-memory persistence.

### Decision 2 — Fenced claims

Claims use compare-and-swap.

## Decisions

- Use Vite for the frontend
- Use pnpm workspaces

## Key decisions

**Decision 7 — Cache reads in the edge.** Tradeoff: stale reads for up to 60 s.
**Rejected:** *a write-through cache*, more moving parts.

A paragraph in a decisions section explains the numbered decision above it.
