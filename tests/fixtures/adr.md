# ADR 7: Use event sourcing for billing

## Status

Accepted

## Context

Invoices must be auditable.

## Decision

We will store billing changes as an append-only event log. Projections build the current state.

## Consequences

Replays are slower as the log grows.
