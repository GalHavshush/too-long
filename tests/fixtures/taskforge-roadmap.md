# TaskForge roadmap (excerpt)

From the TaskForge implementation plan, section 14, verbatim.

## Implementation Roadmap

Phases 1–7 are the **MVP**. Phases 8–9 are **Beta**. Phase 10 is **GA**. Phases 8 and 9 can run in parallel with Phase 7.

```
P1 → P2 → P3 → P4 → P5 → P6 → P7 → P10
                 └──→ P8 ─────────┘
            P4 + P6 → P9 ─────────┘
```

### Phase 1 — Foundation and tooling
- **Objective:** A reproducible repository, configuration, logging, local infrastructure, and a CI skeleton.
- **Dependencies:** None.
- **Tasks:**
  - [ ] Initialize a `uv` project with Python 3.12 pinned; set up ruff, mypy (strict), and pre-commit
  - [ ] `config.py`: `pydantic-settings` with typed settings and `SecretStr`, one settings class per component
  - [ ] `logging.py`: structlog JSON configuration with request and job context binding
  - [ ] `deploy/docker-compose.yml` with postgres and redis, using healthchecks
  - [ ] Multi-stage `deploy/Dockerfile` with a non-root user and the `taskforge` CLI entrypoint (`api | worker | scheduler | migrate | admin`)
  - [ ] `ci.yml`: lint, typecheck, unit tests, image build
- **Files:** `pyproject.toml`, `src/taskforge/config.py`, `src/taskforge/logging.py`, `src/taskforge/cli.py`, `deploy/Dockerfile`, `.github/workflows/ci.yml`
- **Deliverables:** A bootable skeleton and a green CI run.
- **Acceptance criteria:** `docker compose up` gets PostgreSQL and Redis healthy in under 30 s. CI finishes in under 5 min. Misconfiguration fails at startup with a clear error.
- **Testing:** Unit tests for settings parsing and secret redaction.
- **Risks:** Over-investing in scaffolding. Keep it to the list above.

### Phase 2 — Persistence layer and state machine
- **Objective:** The schema, migrations, and fenced transition functions.
- **Dependencies:** P1.
- **Tasks:**
  - [ ] `domain/states.py`: the allowed-transition table (pure Python) and `domain/backoff.py` (equal jitter)
  - [ ] `db/models.py`: SQLAlchemy 2.0 typed models for every table in §7
  - [ ] First Alembic migration, including enums, partial indexes, and `fillfactor`
  - [ ] `db/jobs_repo.py`: async functions, each a single guarded statement
    - [ ] `insert_job` (idempotent), `claim`, `renew_leases`, `complete`, `fail`, `release`
    - [ ] `request_cancel`, `manual_retry`, `promote_due`, `select_undispatched`, `reap_expired`
  - [ ] `db/session.py`: async engine, pool sizing, PgBouncer-safe settings (`prepared_statement_cache_size=0`)
- **Files:** `src/taskforge/db/models.py`, `src/taskforge/db/jobs_repo.py`, `src/taskforge/db/migrations/versions/0001_initial.py`, `src/taskforge/domain/states.py`
- **Deliverables:** The migrated schema and a repository with full transition coverage.
- **Acceptance criteria:** `alembic upgrade head` followed by `downgrade base` succeeds on an empty database. `alembic check` reports no drift. Every transition in the diagram in §9.1 has a test, and every disallowed transition matches 0 rows.
- **Testing:** `tests/unit/test_states.py`, `tests/unit/test_backoff.py`, `tests/integration/test_jobs_repo.py` against real PostgreSQL, and `tests/integration/test_claim_race.py` (50 concurrent claims result in exactly 1 winner).
- **Risks:** Index choices hurting HOT updates. Benchmark in P10.

### Phase 3 — Authentication and API keys
- **Objective:** Tenant-scoped authentication and scope-based authorization.
- **Dependencies:** P2.
- **Tasks:**
  - [ ] `security/api_keys.py`: generation, HMAC hashing with `pepper_id`, constant-time verification
  - [ ] `api/deps.py`: a `Principal` dependency (tenant, key ID, scopes), a 60 s LRU cache, and a `require_scope()` dependency
  - [ ] `api/routes/keys.py`: create (secret shown once), list, and revoke, all audited
  - [ ] CLI `admin create-tenant` and `admin create-key`
  - [ ] Failed-auth counter per IP (in-memory in P3, moved to Redis in P8)
- **Files:** `src/taskforge/security/api_keys.py`, `src/taskforge/api/deps.py`, `src/taskforge/api/routes/keys.py`, `src/taskforge/db/keys_repo.py`
- **Deliverables:** Working key lifecycle and enforced authentication.
- **Acceptance criteria:** A revoked key is rejected within 60 s. Cross-tenant access returns `404`. Verification adds under 1 ms at p99 on a cache hit. Secrets never appear in logs (verified by a log-capture test).
- **Testing:** Unit tests for hashing and parsing. `tests/integration/test_auth.py` covers the tenant-isolation matrix across every endpoint and scope.
- **Risks:** The revocation cache window. It is documented, and the TTL is configurable.

### Phase 4 — Jobs API
- **Objective:** Submit, get, list, attempts, cancel, and retry endpoints, without dispatch.
- **Dependencies:** P2, P3.
- **Tasks:**
  - [ ] `api/schemas.py`: strict request and response models with every limit from §8
  - [ ] `POST /v1/jobs`: idempotent insert, `request_hash` comparison, `200` replay or `409` conflict
  - [ ] `GET /v1/jobs` keyset pagination with filters; `GET /v1/jobs/{id}` and `/attempts`
  - [ ] Cancel and retry endpoints mapped to the repository CAS results (`200`/`202`/`409`)
  - [ ] RFC 9457 error handler, `request_id` middleware, OpenAPI published at `/v1/openapi.json`
  - [ ] `/healthz` and `/readyz`
- **Files:** `src/taskforge/api/routes/jobs.py`, `src/taskforge/api/schemas.py`, `src/taskforge/api/errors.py`, `src/taskforge/api/routes/health.py`
- **Deliverables:** A complete control-plane API with jobs persisted as `queued` or `scheduled`.
- **Acceptance criteria:** 50 parallel submits with the same key create exactly 1 job. Submit p99 is under 50 ms locally. Every endpoint passes Schemathesis fuzzing with no 5xx.
- **Testing:** `tests/integration/test_jobs_api.py`, `tests/integration/test_idempotency.py`, and `tests/contract/test_openapi.py` (Schemathesis).
- **Risks:** Slow listing queries at scale. Indexes must match every filter combination; verify with `EXPLAIN` in tests.

### Phase 5 — Redis queue and scheduler dispatch
- **Objective:** Move eligible jobs into Redis reliably.
- **Dependencies:** P2. The API fast path needs P4.
- **Tasks:**
  - [ ] `queue/redis_backend.py`: key naming, score function, pipelined `ZADD NX`, `BZPOPMIN` with rotation, `ZCARD`
  - [ ] Post-commit fast-path dispatch in the API through `BackgroundTasks`, with a 50 ms timeout and errors swallowed but counted
  - [ ] `scheduler/promoter.py`: `scheduled`/`retrying` jobs whose `run_at` has passed go to `queued` (`dispatched_at=NULL`)
  - [ ] `scheduler/dispatcher.py`: undispatched or stale queued jobs get `ZADD NX`, then `dispatched_at=now()`
    - [ ] Skip reconciling a queue when its ZCARD equals the PostgreSQL queued count
  - [ ] `scheduler/main.py`: asyncio loops, each with jittered intervals and its own error isolation
- **Files:** `src/taskforge/queue/redis_backend.py`, `src/taskforge/scheduler/{main,promoter,dispatcher}.py`
- **Deliverables:** Jobs reach Redis within about 1 s of becoming eligible, even if the fast path fails.
- **Acceptance criteria:** After `FLUSHALL`, every queued job is back in Redis within 60 s. Two scheduler replicas never double-promote (verified through `job_attempts` and the audit counts). A scheduled job is queued within 2 s of `run_at` at p95.
- **Testing:** `tests/integration/test_dispatch.py`, `tests/integration/test_redis_rebuild.py`, `tests/integration/test_scheduler_replicas.py`.
- **Risks:** Reconciler cost when the backlog is huge. Mitigated by the ZCARD shortcut and batched scans.

### Phase 6 — Worker runtime
- **Objective:** Execute jobs safely and concurrently.
- **Dependencies:** P5.
- **Tasks:**
  - [ ] `workers/registry.py`: `@task(name, retryable_exceptions=...)` decorator
  - [ ] `workers/runner.py`: slot semaphore, pop-then-claim, execution under timeout, writing outcomes and `job_attempts`
    - [ ] Classify errors: retryable, non-retryable (`PermanentError`), timeout, `unknown_task`
    - [ ] Sync handlers via `to_thread`, with process recycling after a timeout
  - [ ] `workers/lease.py`: batched heartbeat, cancel-flag propagation, monotonic self-fencing
  - [ ] Worker registration, status updates, the SIGTERM/SIGINT drain, and lease release
  - [ ] `workers/context.py`: a `JobContext` exposing `job_id`, `attempt`, `idempotency_token`, `lease_token`, `logger`
- **Files:** `src/taskforge/workers/{runner,registry,lease,context,main}.py`, `src/taskforge/db/workers_repo.py`
- **Deliverables:** Horizontally scalable workers running the example tasks end to end.
- **Acceptance criteria:** 10,000 `demo.sleep(0)` jobs finish with 0 lost. SIGTERM during load gives 0 `lost` attempts (only `released` or `succeeded`). A timeout fires within 1 s of its configured value.
- **Testing:** `tests/integration/test_worker_execution.py`, `tests/integration/test_graceful_shutdown.py`, `tests/integration/test_timeouts.py`.
- **Risks:** Blocking sync handlers starving the event loop. Document the async-first approach and cap `to_thread` concurrency.

### Phase 7 — Recovery, cancellation, DLQ, and outage handling
- **Objective:** Meet the reliability targets in §4 under fault injection.
- **Dependencies:** P6.
- **Tasks:**
  - [ ] `scheduler/reaper.py`: reclaim expired leases (`retrying`/`dead`/`cancelled`) and record the `lost` attempt
  - [ ] `scheduler/monitor.py`: mark lost workers
  - [ ] Cooperative cancellation end to end, including the cancel-while-reaping case
  - [ ] DLQ workflow: filtering on `dead`, manual retry with an audit entry
  - [ ] Redis outage handling: circuit breaker with exponential backoff in workers; API keeps accepting jobs
  - [ ] Database outage handling: retry heartbeats and completions with backoff; API returns `503` on writes
  - [ ] `tests/chaos/invariants.py`: after a run, every job is terminal, has exactly one terminal transition, and has no more than `max_attempts` counted attempts
- **Files:** `src/taskforge/scheduler/{reaper,monitor}.py`, `tests/integration/test_job_recovery.py`, `tests/chaos/`
- **Deliverables:** A self-healing platform. **Milestone:** M1 internal alpha (MVP complete).
- **Acceptance criteria:** A worker hit with SIGKILL has its job in `retrying` within 85 s. A 30 s PostgreSQL restart under load causes 0 duplicate executions. A 2 min Redis outage loses 0 jobs, and the backlog starts draining within 10 s of recovery. A running job cancels within 20 s.
- **Testing:** Chaos suite using Toxiproxy (latency, partition), `docker kill -s KILL`, `redis-cli FLUSHALL`, and `pg_ctl restart`. The invariant checker runs after each scenario.
- **Risks:** Flaky timing-based tests. Use injectable clocks and intervals (test settings shrink them 10×).

### Phase 8 — Rate limiting, backpressure, and abuse prevention
- **Objective:** Protect the shared platform from noisy tenants.
- **Dependencies:** P4, P5.
- **Tasks:**
  - [ ] `queue/lua/token_bucket.lua` and `queue/ratelimit.py`: limits per key and per tenant, `RateLimit-*` headers
  - [ ] In-process fallback limiter that applies a per-replica share of the limit when Redis is down (fail-open)
  - [ ] Queue high-watermark check, returning `503` with `Retry-After`
  - [ ] Scheduler caches per-tenant pending counts in Redis every 15 s; API enforces the soft quota
  - [ ] Failed-auth throttling per IP moved to Redis; `allowed_queues` enforcement
- **Files:** `src/taskforge/queue/ratelimit.py`, `src/taskforge/queue/lua/token_bucket.lua`, `src/taskforge/api/deps.py`
- **Deliverables:** Enforced limits, with clients told how long to back off.
- **Acceptance criteria:** A tenant over its limit gets `429` while other tenants' p99 stays within 10% of baseline. A Redis outage does not cause API 5xx.
- **Testing:** `tests/integration/test_rate_limit.py` and a noisy-neighbor scenario in `tests/load/`.
- **Risks:** The soft quota can be overshot by up to 15 s worth of submissions. Accepted.

### Phase 9 — Observability
- **Objective:** Traces, metrics, dashboards, and alerts as specified in §12.
- **Dependencies:** P4, P6. Can run in parallel with P7 and P8.
- **Tasks:**
  - [ ] `telemetry.py`: OTel providers, auto-instrumentation, `traceparent` capture and span links
  - [ ] Prometheus metrics per §12; scheduler exports depth, age, and status gauges
  - [ ] Add the OTel Collector, Jaeger, Prometheus, and Grafana to compose
  - [ ] `deploy/grafana/dashboards/{overview,workers}.json`, `deploy/prometheus/rules.yml`
  - [ ] Runbooks for each alert in `docs/runbooks/`
  - [ ] `GET /v1/workers` and `GET /v1/queues/stats`
- **Files:** `src/taskforge/telemetry.py`, `src/taskforge/api/routes/{workers,queues}.py`, `deploy/grafana/`, `deploy/prometheus/rules.yml`
- **Deliverables:** A worker-health dashboard and working alerting. **Milestone:** M2 beta.
- **Acceptance criteria:** One trace connects the submit request to the execution span through a link. Each chaos scenario from P7 fires its expected alert within 2 min. Metric cardinality stays under 5,000 series at the reference scale.
- **Testing:** `tests/integration/test_metrics.py` (scrape and assert), plus a promtool unit test for the alert rules.
- **Risks:** Cardinality from the `task` label. Enforce the task-name regex and cap the number of distinct tasks.

### Phase 10 — Production deployment, CI/CD, and GA hardening
- **Objective:** A safe, repeatable production rollout that meets the targets in §4.
- **Dependencies:** All prior phases.
- **Tasks:**
  - [ ] Helm chart `deploy/helm/taskforge/`: api (HPA), scheduler (2 replicas, PodDisruptionBudget), worker deployments per queue group (KEDA), migration Job as a `pre-upgrade` hook, NetworkPolicies
  - [ ] `release.yml`: on a tag, build, scan, and push by digest; deploy to staging; run smoke and e2e tests; get manual approval; deploy to production
  - [ ] Load tests (`tests/load/locustfile.py`) at the targets in §4; tune PostgreSQL autovacuum and fillfactor
  - [ ] `scheduler/retention.py`: purge terminal jobs and attempts older than 30 days, expire idempotency keys
  - [ ] Security review and pen-test checklist; rollback drill in staging
- **Files:** `deploy/helm/taskforge/**`, `.github/workflows/release.yml`, `tests/load/locustfile.py`, `src/taskforge/scheduler/retention.py`
- **Deliverables:** Production deployment and runbooks. **Milestone:** M3 GA.
- **Acceptance criteria:** All targets in §4 are met in a staging load test for 1 h. The rollback drill finishes in under 10 min with 0 lost jobs. There are no critical or high CVEs.
- **Testing:** Load tests, a 24 h soak test with background chaos, the rollback drill.
- **Risks:** PostgreSQL write throughput turning into the ceiling (see §18).

**Later (after GA):** cron schedules, priority aging and weighted fair queuing per tenant, partitioning `jobs` by month, an HTTP pull API for non-Python workers, completion webhooks, and payload encryption.
