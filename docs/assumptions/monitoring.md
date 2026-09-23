# Monitoring & Alerting

## Decision

Monitoring infrastructure is **not implemented** in the codebase. This document describes the production monitoring strategy.

## Current State

The application has basic observability built in:
- **Request logging** — every HTTP request is logged with method, path, status, duration, and `X-Request-ID` (via `LoggingInterceptor`)
- **Redis failure warnings** — sync failures are logged at WARN level
- **Health probes** — `/api/health/liveness` and `/api/health/readiness` for Kubernetes

This is sufficient for local development but inadequate for production.

## Production Monitoring Design

### Metrics (Datadog / CloudWatch)

| Metric | Type | Source | Alert Threshold |
|--------|------|--------|-----------------|
| `leaderboard.api.request.duration` | Histogram | LoggingInterceptor | P99 > 200ms |
| `leaderboard.api.request.count` | Counter | LoggingInterceptor | Rate drop > 50% (5 min) |
| `leaderboard.api.error.rate` | Gauge | Exception filter | > 1% of requests |
| `leaderboard.redis.sync.failure` | Counter | UsersService.syncToRedis | > 10/min |
| `leaderboard.redis.fallback.count` | Counter | LeaderboardService | > 0 sustained 5 min |
| `leaderboard.cache.hit_ratio` | Gauge | LeaderboardService | < 90% |
| `leaderboard.score.update.duration` | Histogram | UsersService | P99 > 100ms |

### Logging (Datadog Logs / CloudWatch Logs)

**Log levels:**
- `ERROR` — unhandled exceptions, database connection failures
- `WARN` — Redis sync failures, Redis fallback triggered, rate limit exceeded
- `INFO` — application startup, cache warm-up progress, shutdown
- `DEBUG` — individual request traces (disabled in production)

**Structured logging format:**
```json
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "level": "warn",
  "service": "leaderboard-api",
  "requestId": "550e8400-...",
  "message": "Redis sync failed, data may be stale",
  "userId": "...",
  "error": "ECONNREFUSED",
  "duration_ms": 5002
}
```

**Implementation:** Replace NestJS default logger with `winston` + `dd-trace` (Datadog APM) or `aws-xray-sdk` (AWS X-Ray). Logs are shipped to Datadog/CloudWatch via the container's stdout — no file-based logging.

### Distributed Tracing (Datadog APM / AWS X-Ray)

Trace the full request path:
```
Client → ALB → NestJS → Redis (cache check) → PostgreSQL (fallback) → Response
```

Each span captures:
- Redis command type and duration (ZADD, ZREVRANGE, HGET)
- PostgreSQL query and duration
- Whether Redis fallback was triggered

**Implementation:** `dd-trace` auto-instruments `ioredis`, `pg`, and HTTP — no manual spans needed for most operations.

### Alerting (PagerDuty / OpsGenie)

| Alert | Severity | Condition | Action |
|-------|----------|-----------|--------|
| **API down** | P1 (Critical) | Health check fails for > 2 min | Page on-call engineer |
| **Redis fully down** | P2 (High) | `redis.fallback.count > 0` for > 5 min | Page on-call, API still works via PG fallback |
| **High error rate** | P2 (High) | Error rate > 5% for > 3 min | Page on-call |
| **High latency** | P3 (Medium) | P99 > 500ms for > 10 min | Slack notification |
| **Redis sync failures** | P3 (Medium) | `sync.failure > 50/min` for > 5 min | Slack notification, data divergence risk |
| **Cache hit ratio drop** | P4 (Low) | Cache hit < 80% for > 30 min | Slack notification, may need warm-up |

**Escalation policy:**
1. On-call engineer (5 min response for P1-P2)
2. Team lead (15 min escalation)
3. Engineering manager (30 min escalation)

### Dashboards

**Leaderboard Operations Dashboard:**
- Request rate by endpoint (top-N, user position, create, update)
- P50/P95/P99 latency by endpoint
- Redis vs PostgreSQL query split (cache hit ratio)
- Error rate by status code (400, 404, 429, 500)

**Infrastructure Dashboard:**
- ECS task count and CPU/memory utilization
- RDS connections, query duration, replication lag
- ElastiCache memory usage, evictions, hit rate
- ALB request count, target response time

## Why Not Implemented

1. **No external monitoring service available** — Datadog/CloudWatch require account credentials and infrastructure
2. **File-based logging adds no value** — production systems ship logs to centralized services via stdout, not local files
3. **The assignment evaluates data structure design** — not operational maturity. A design doc demonstrates the knowledge without burning implementation time.
