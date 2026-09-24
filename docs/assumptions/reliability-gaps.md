# Reliability Gaps — Design Decisions

This document describes four reliability patterns that were **deliberately left out** of this implementation. Each gap was identified and considered during design; the simpler approach was chosen as appropriate for the exercise scope. A production deployment would prioritise adding these in order.

---

## 1. Warm-Up Sentinel (Not Implemented)

### What it is

During `warmCache()` (30–60 seconds for 10M users), the live `leaderboard:scores` ZSET is populated batch-by-batch. The current `isRedisAvailable()` check in `LeaderboardService` only verifies that the ioredis TCP connection is in the `ready` state — it becomes `true` as soon as the socket is established, before any data is loaded.

### The gap

Between connection established and warm-up complete, reads go to the partially-populated ZSET. A user at rank #6,000 calling `/leaderboard/user/:id` mid-warm may get `null` rank from Redis (their entry not yet loaded) and transparently fall back to PostgreSQL — which is correct. But rank #1–#5,000 users are served from Redis while rank #5,001+ fall back to PG, creating inconsistency within the same time window.

### Simple fix (when needed)

Add `private warmUpReady = false` to `CacheWarmerService`. Set it to `true` at the end of a successful `warmCache()`. Expose via `isReady(): boolean`. In `LeaderboardService.isRedisAvailable()`, add `&& this.cacheWarmerService.isReady()`.

This ensures Redis is only used once it is fully populated.

### Why not implemented

For the exercise, the existing fallback (partial Redis → PG fallback) already returns correct results. The sentinel adds ~10 lines but is not strictly required for correctness — just for consistency within the warm-up window.

---

## 2. Drift Reconciler (Not Implemented)

### What it is

A background process that periodically verifies that the Redis ZSET is consistent with PostgreSQL and repairs any divergence.

### The gap

`CacheWarmerService.warmCache()` runs once on startup (when `REDIS_WARM_ON_START=true`). After that, individual writes sync PG → Redis via `syncToRedis` — a fire-and-forget call that logs a warning on failure but does not retry. Scenarios that cause permanent drift:

- An ECS task crashes mid-warm → the ZSET is partially populated and never fully repaired until the next restart.
- A Redis FLUSHALL (ElastiCache failover, operator error) → Redis is empty; writes after the flush are synced for newly updated users, but unmodified users are absent from Redis until they receive a score update or the service restarts.
- A `syncToRedis` failure under transient Redis load → that user's score is missing from the ZSET indefinitely.

### Production design

A `ReconcilerService` with an `@Interval(30000)` (every 30s):
1. Sample 200–500 random users from PostgreSQL.
2. For each, compare `score` against `ZSCORE leaderboard:scores <member>` via the members hash.
3. If mismatch rate < 1%: targeted `ZADD` repair for divergent entries.
4. If mismatch rate ≥ 1%: trigger full `warmCache()` rebuild.

Maximum undetected drift window: 30 seconds. Implementation cost: ~60 lines in a new `src/cache/reconciler.service.ts`.

### Why not implemented

The warm-on-start path handles cold starts correctly. For the exercise, a 30s eventual-consistency window was accepted as a reasonable trade-off given the PG fallback provides correct answers throughout. Adding the reconciler is a straightforward extension when moving to production.

---

## 3. `X-Data-Source` Response Metadata (Not Implemented)

### What it is

A response header (or body field) indicating whether leaderboard data was served from Redis or PostgreSQL, and whether the response is from a degraded-mode fallback.

### The gap

API responses currently contain no metadata about their source. Callers cannot distinguish:

- A freshly warmed Redis response.
- A PG fallback response (Redis down or warming).
- A partially-warmed Redis response.

For a monitoring dashboard or a client that caches at their own layer, this information matters.

### Production design

Service methods return `{ data, source: 'redis' | 'postgres' }`. Controller sets:

```
X-Data-Source: redis
X-Data-As-Of: 2026-09-24T10:07:00.000Z
```

For degraded mode, additionally: `Warning: 199 - "degraded: serving from postgres"`.

Implementation cost: ~5 lines per service method, ~2 lines per controller action.

### Why not implemented

Not in the assignment scope. Adding it is straightforward and high-value for production observability, but adds response-shape noise for an exercise.

---

## 4. Shadow-Key Atomic Rebuild (Not Implemented)

### What it is

A pattern where the warm-up writes to a temporary shadow key (`leaderboard:scores:build`) rather than the live key, then performs an atomic `RENAME` after the build is verified — eliminating the partial-warm window entirely.

### The gap

The current `warmCache()` writes directly to the live `leaderboard:scores` key. For the entire warm-up duration, live Redis reads see a growing but incomplete ZSET. The warm-up sentinel (Gap 1) mitigates this by blocking Redis reads until warm-up is complete, but without the sentinel, reads return partial data.

### Production design

1. Build `leaderboard:scores:build` and `leaderboard:members:build` in isolation (no live traffic interference).
2. After completion, verify `ZCARD leaderboard:scores:build` equals `SELECT COUNT(*) FROM users`.
3. Atomic `RENAME leaderboard:scores:build leaderboard:scores` + `RENAME leaderboard:members:build leaderboard:members`.
4. Set warm-up sentinel.

**Complication:** Live writes during the rebuild (new score updates) must be replayed against the build key or queued. The simplest approach: after `RENAME`, the reconciler (Gap 2) repairs any writes that landed on the old key during the build window.

### Why not implemented

The sentinel (Gap 1) is the minimum viable solution — it routes all reads to PG during warm-up, so partial ZSET content never reaches clients. Shadow-key rebuild is an optimisation that reduces the PG-fallback window from minutes to milliseconds but adds significant implementation complexity. Appropriate for production; deferred for the exercise.

---

## Priority Order for Production

| Priority | Gap | Lines of Code | Benefit |
|----------|-----|--------------|---------|
| 1 | Warm-up sentinel | ~10 | Prevents inconsistent reads during cold start |
| 2 | Drift reconciler | ~60 | Heals Redis divergence without restart |
| 3 | `X-Data-Source` header | ~10 | Observability for clients and operators |
| 4 | Shadow-key rebuild | ~80 | Eliminates PG-fallback cold-start window |
