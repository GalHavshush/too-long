# TaskForge decisions (excerpt)

From the TaskForge implementation plan, section 17, verbatim.

## Architectural Decisions

**Decision 1 — PostgreSQL is the source of truth; Redis is a rebuildable dispatch index.**
Tradeoff: two writes per dispatch, plus reconciler complexity. **Rejected:**
- *Redis-only state (RQ/Celery style).* State is lost on Redis failover, and querying and listing are weak.
- *PostgreSQL-only queue using `SKIP LOCKED` polling.* Simpler, but worker polling puts load on the primary at scale, and the requirements call for Redis. It stays as a possible degraded mode.

**Decision 2 — Claims are fenced by a CAS `UPDATE` in PostgreSQL with a per-claim `lease_token`.**
**Rejected:**
- *Redis reliable queue (`LMOVE` into a processing list).* Redis isn't durable enough to act as the authority.
- *Redlock.* Unsafe under clock jumps and GC pauses.

**Decision 3 — Short leases with heartbeat renewal, kept separate from the job timeout.**
Crashes are detected in about 80 s whether a job lasts 10 s or an hour. **Rejected:** *an SQS-style visibility timeout equal to the job timeout*, where a crashed hour-long job would sit locked for an hour. Tradeoff: heartbeat write load, about `running_jobs / 15` updates per second.

**Decision 4 — Delayed, scheduled, and retrying jobs live only in PostgreSQL and are promoted by the scheduler.**
**Rejected:** *a Redis delayed ZSET*, which would create a second source of truth for timing. Tradeoff: about 1 s of scheduling precision.

**Decision 5 — Leaderless scheduler loops using `FOR UPDATE SKIP LOCKED`.**
**Rejected:** *leader election with an advisory lock or a Redis lock.* It adds failover gaps and split-brain cases. Tradeoff: every loop must be idempotent, which is enforced in review and tests.

**Decision 6 — One Redis sorted set per queue, with a composite priority and FIFO score.**
**Rejected:**
- *Redis Streams.* The consumer-group PEL duplicates the PostgreSQL leasing, and Streams have no priority.
- *One list per priority level.* More keys, and every level has to be blocked on.

Tradeoff: low priorities can starve. Aging is deferred to Later.

**Decision 7 — Async-first worker runtime: one event loop per process with M slots, scaled out by processes.**
Sync handlers run in threads, and the process is recycled after a timeout. **Rejected:**
- *Prefork process pools.* Complex supervision and IPC.
- *Killing threads.* Python can't do it.

**Decision 8 — At-least-once execution with an idempotent-handler contract.**
**Rejected:** *exactly-once through distributed transactions.* It isn't achievable with arbitrary external side effects.

**Decision 9 — Prefixed API keys stored as HMAC-SHA256 with a versioned pepper.**
High-entropy secrets don't need a slow KDF. **Rejected:**
- *bcrypt or argon2.* Adds around 50 ms to every request.
- *JWT.* Revocation is hard.

**Decision 10 — The DLQ is the `dead` status in PostgreSQL, not a separate queue.**
It can be queried and filtered, and retried with one CAS.

**Decision 11 — Running jobs are cancelled cooperatively, on a best-effort basis.**
**Rejected:** *hard-killing worker tasks.* It corrupts handler state and shared connections.

**Decision 12 — The worker dashboard is built in Grafana, not as a custom UI.**
Lower cost to build, and it reuses the existing alerting stack.
