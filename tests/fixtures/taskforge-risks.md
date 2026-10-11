# TaskForge risks and questions (excerpt)

From the TaskForge implementation plan, sections 18 and 19, verbatim.

## 18. Risks and Mitigations

| Risk | Likelihood / Impact | Mitigation |
|---|---|---|
| **Risk:** PostgreSQL write throughput caps job throughput (about 5 writes per job) | M / H | Batch heartbeats, tune fillfactor and HOT updates, PgBouncer. Later: monthly partitioning and batched claims |
| **Risk:** Table and index bloat from frequent updates | H / M | Tune autovacuum per table, retention purge, bloat alerts |
| **Risk:** Non-idempotent handlers cause duplicate side effects | M / H | Handler contract docs, `idempotency_token` in context, duplicate-rate metric |
| **Risk:** PostgreSQL outage longer than 75 s re-executes in-flight jobs | L / M | Documented. `lease_ttl` is tunable per deployment |
| **Risk:** Starvation of low priorities | M / M | Monitor wait time per priority; aging in Later |
| **Risk:** Reconciler load with backlogs of millions of jobs | L / M | ZCARD shortcut, `redispatch_after` backoff, batch limits |
| **Risk:** Rolling deploys leave tasks unknown to old workers | M / L | `unknown_task` is retryable; deploy workers before the API emits new tasks |
| **Risk:** Revocation lags by up to 60 s due to caching | L / M | Configurable TTL; emergency path flushes the cache |
| **Risk:** Metric cardinality explosion | L / M | No tenant labels, task-name regex, cardinality alert |

## 19. Open Questions

- **Open question:** Is the platform internal-only, or will external, untrusted tenants use it? The answer changes the handler sandboxing and payload-encryption requirements.
- **Open question:** Are cron or recurring schedules needed before GA?
- **Open question:** Do results need to exceed 64 KB, which would require object-storage offload?
- **Open question:** Is a per-tenant fairness guarantee needed (weighted fair queuing), or are rate limits and quotas enough?
- **Open question:** What are the retention and compliance requirements for payloads in history (30 days by default)?
- **Open question:** Will there be non-Python workers, which would mean an HTTP pull API with the same lease semantics?
- **Open question:** Should completion trigger client callbacks (webhooks)?
- **Open question:** What are the target cloud and managed services? The HA and RPO targets depend on them.
