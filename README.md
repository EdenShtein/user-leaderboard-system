# User Leaderboard System

A high-performance leaderboard API built with Node.js, TypeScript, PostgreSQL, and Redis. Designed to handle 10M+ users with sub-100ms query times.

## Tech Stack

- **Runtime:** Node.js 20 + TypeScript
- **Framework:** NestJS 12
- **Database:** PostgreSQL 16
- **Cache:** Redis 7 (sorted sets)
- **Testing:** Vitest
- **Containerization:** Docker + Docker Compose

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose

### Option 1: Docker Compose (Recommended)

```bash
docker-compose up --build
```

This starts PostgreSQL, Redis, and the API on `http://localhost:3000`.

### Option 2: Local Development

1. Start PostgreSQL and Redis (via Docker or local installs):
```bash
docker-compose up postgres redis -d
```

2. Install dependencies and run:
```bash
npm install
cp .env.example .env
npm run build
npm run start:prod
```

The API runs on `http://localhost:3000`.

## API Endpoints

All endpoints are prefixed with `/api`.

### Create a User

```bash
POST /api/users
Content-Type: application/json

{
  "name": "Alice",
  "imageUrl": "https://example.com/alice.png",
  "score": 1500
}
```

**Response** `201`:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Alice",
  "imageUrl": "https://example.com/alice.png",
  "score": 1500,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

### Update a User's Score

```bash
PATCH /api/users/:id/score
Content-Type: application/json

{
  "score": 2500
}
```

### Get Top N Users

```bash
GET /api/leaderboard/top?limit=10&offset=0
```

**Response** `200`:
```json
[
  { "rank": 1, "id": "...", "name": "Alice", "imageUrl": "...", "score": 9500 },
  { "rank": 2, "id": "...", "name": "Bob", "imageUrl": null, "score": 8200 },
  ...
]
```

- `limit` defaults to 10, max 100.
- `offset` defaults to 0. Use for pagination (e.g., `?limit=10&offset=10` for page 2).

### Get User Position + Surrounding

```bash
GET /api/leaderboard/user/:id
```

**Response** `200`:
```json
{
  "user": { "rank": 42, "id": "...", "name": "Charlie", "imageUrl": null, "score": 5000 },
  "surrounding": [
    { "rank": 37, "id": "...", "name": "...", "imageUrl": "...", "score": 5200 },
    ...
    { "rank": 42, "id": "...", "name": "Charlie", "imageUrl": null, "score": 5000 },
    ...
    { "rank": 47, "id": "...", "name": "...", "imageUrl": "...", "score": 4800 }
  ]
}
```

Returns the user's rank plus 5 users above and 5 below.

### Health Check

```bash
GET /api/health/liveness    # Always returns { status: "ok" }
GET /api/health/readiness   # Reports DB + Redis connectivity
```

## Data Structure Design

### Why a single `users` table with a composite index?

The core challenge is computing ranks efficiently for 10M+ users. Two common approaches:

| Approach | Pros | Cons |
|----------|------|------|
| **Stored rank column** | O(1) rank read | Every score update cascades to millions of rows |
| **Computed rank at query time** | No cascade updates, always accurate | Requires efficient index |

We chose **computed rank** with a B-tree index on `(score DESC, "updatedAt" ASC, id ASC)`:

- **Top N query:** Index-only scan, returns results in O(log n + N) — essentially instant for N ≤ 100
- **Rank lookup:** `COUNT(*) WHERE score > X` uses the index for O(log n) computation
- **Score update:** Single atomic `UPDATE...RETURNING` + index maintenance in O(log n)
- **No cascade:** Updating one user's score doesn't touch any other rows
- **FIFO tie-breaking:** Users who reach the same score first rank higher (ordered by `updatedAt`)

### Redis sorted set as a cache layer

Redis `ZSET` provides the same O(log n) guarantees as the PostgreSQL index, but entirely in-memory. To support FIFO tie-breaking, we use **member-encoded tiebreaks**: the ZSET member is `<invertedTimestamp>:<userId>` instead of just the userId. This ensures equal scores are ordered by who reached the score first, with zero floating-point precision loss. A Lua script ensures atomic member swaps on score updates. See [docs/assumptions/fifo-tie-breaking.md](docs/assumptions/fifo-tie-breaking.md) for the full design rationale.

| Operation | Redis Command | Complexity |
|-----------|---------------|------------|
| Update score | Lua script (ZREM + ZADD + HSET) | O(log n) |
| Get top N | `ZREVRANGE` + member parsing | O(log n + N) |
| Get rank | `HGET` member + `ZREVRANK` | O(log n) |
| Get surrounding | `ZREVRANGE` with offset | O(log n + M) |

The system uses **write-through caching**: every score write goes to both PostgreSQL (source of truth) and Redis (cache). If Redis is unavailable, the API gracefully falls back to PostgreSQL-only queries.

## Database Schema

```sql
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  "imageUrl"  VARCHAR(500),
  score       BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

-- Critical index for leaderboard queries (FIFO tie-breaking)
CREATE INDEX idx_users_score ON users (score DESC, "updatedAt" ASC, id ASC);
```

The `(score DESC, "updatedAt" ASC, id ASC)` index provides:
- FIFO ordering for tied scores (first to reach the score ranks higher)
- Efficient range scans for top-N queries
- Fast COUNT operations for rank computation
- UUID as final disambiguator for identical timestamps

## Seeding Test Data

```bash
# Seed 1M users (default)
npx ts-node src/database/seed.ts

# Seed 10M users
npx ts-node src/database/seed.ts 10000000
```

The seed script:
1. Bulk-inserts users into PostgreSQL via COPY protocol (~100k+ rows/sec)
2. Drops the index before insert and recreates it after for optimal write speed
3. **Automatically warms Redis** — populates the ZSET with all scores and the member-encoded FIFO tiebreak data

If Redis is unavailable, the script still completes (PostgreSQL data is populated) and logs a warning. The API will fall back to PostgreSQL queries until Redis is warmed.

## Running Tests

```bash
# Run unit tests
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:cov

# Run E2E tests (requires Docker)
docker compose -f docker-compose.test.yml up -d
npm run test:e2e
docker compose -f docker-compose.test.yml down
```

Unit tests cover:
- User CRUD operations with Redis sync
- Leaderboard queries (DB and Redis paths)
- Graceful Redis fallback on failure
- Edge cases: rank 1, FIFO tied scores, missing users
- Atomic score updates

E2E tests cover:
- Full API contract validation against real PostgreSQL + Redis
- Input validation (negative scores, missing fields, invalid UUIDs)
- Pagination behavior
- FIFO tie-breaking (two users with same score, verify ordering)
- Health check endpoints

## Docker / Kubernetes

### Build the image

```bash
docker build -t leaderboard-api .
```

### Kubernetes deployment

The Dockerfile produces a lightweight production image (node:20-alpine). Deploy it with:

- A PostgreSQL instance (e.g., CloudNativePG or managed RDS)
- A Redis instance (e.g., Redis Operator or ElastiCache)
- Environment variables as described in `.env.example`
- Liveness probe: `GET /api/health/liveness`
- Readiness probe: `GET /api/health/readiness`

## AWS Architecture

See [docs/aws-architecture.md](docs/aws-architecture.md) for a detailed production AWS deployment design including ECS Fargate, RDS Multi-AZ, ElastiCache Redis, ALB, CloudFront, and auto-scaling.

## Design Decisions

Detailed rationale for key architectural choices is documented under `docs/assumptions/`:

| Decision | Document | Summary |
|----------|----------|---------|
| **FIFO Tie-Breaking** | [fifo-tie-breaking.md](docs/assumptions/fifo-tie-breaking.md) | Member-encoded tiebreak in Redis ZSET — zero precision loss, no score cap. Compares 4 alternatives. |
| **UUID v4 Primary Key** | [primary-key-selection.md](docs/assumptions/primary-key-selection.md) | UUID v4 chosen over BIGINT/UUID v7. Memory tradeoff is acceptable at our scale (1.5GB vs 700MB within 13GB budget). |
| **Authentication** | [authentication.md](docs/assumptions/authentication.md) | JWT + role-based auth design. Intentionally deferred — not in assignment scope, but fully designed for production. |
| **Edge Cases** | [edge-cases.md](docs/assumptions/edge-cases.md) | Score bounds, atomic updates, bottom-of-leaderboard, offset cap, idempotency, data reconciliation. |
| **Test Framework** | [test-framework.md](docs/assumptions/test-framework.md) | Vitest over Jest — native TypeScript, zero config, identical API. Migration path documented. |
| **Monitoring** | [monitoring.md](docs/assumptions/monitoring.md) | Datadog/CloudWatch metrics, structured logging, PagerDuty alerting — designed but not implemented. |

## Production Considerations

### Rate Limiting

The API includes built-in rate limiting via `@nestjs/throttler`:
- **Read endpoints** (leaderboard): 100 requests/minute per IP
- **Write endpoints** (create user): 30 requests/minute per IP
- **Score updates**: 60 requests/minute per IP
- **Health endpoints**: exempt from rate limiting

In production, combine with AWS WAF for additional layer-7 protection.

### Database Migrations

In development, TypeORM `synchronize: true` auto-creates tables. In production (`NODE_ENV=production`), schema changes are applied via TypeORM migrations under `src/database/migrations/`. Migrations run automatically on startup when `migrationsRun: true`.

### Redis Cache Warm-Up

Set `REDIS_WARM_ON_START=true` to bulk-load all user scores from PostgreSQL into Redis on application startup. This runs asynchronously and doesn't block the API from serving requests. Useful after Redis restarts or cold deployments.

### Connection Pooling

TypeORM defaults to a pool of 10 connections per application instance. For production, explicitly configure the pool size based on your deployment:
- At 20 ECS tasks with 10 connections each = 200 total connections
- RDS `db.r6g.xlarge` supports ~5,000 concurrent connections
- Recommendation: set `extra: { max: 10-20 }` in TypeORM config per instance

### Read/Write Database Split

For maximum throughput at scale, separate read and write database connections:
- **Writes** (`POST /api/users`, `PATCH /api/users/:id/score`): hit the RDS primary instance
- **Reads** (`GET /api/leaderboard/*`): hit RDS read replicas via a separate TypeORM connection

This can be achieved by registering a second `TypeOrmModule.forRootAsync()` with `name: 'readonly'` pointing to the replica endpoint, then injecting it into `LeaderboardModule`.

### Request Tracing

All HTTP requests are logged with method, path, status code, duration, and a `X-Request-ID` correlation header. If the client sends `X-Request-ID`, it's propagated; otherwise one is generated. Use this for distributed tracing across services.

## Project Structure

```
src/
  main.ts                          # NestJS bootstrap
  app.module.ts                    # Root module
  common/
    logging.interceptor.ts         # Request logging + X-Request-ID
  health/
    health.controller.ts           # Liveness + readiness probes
  users/
    user.entity.ts                 # TypeORM entity
    users.module.ts
    users.service.ts               # Create, update score, find
    users.service.spec.ts          # Unit tests
    users.controller.ts            # POST /users, PATCH /users/:id/score
    dto/
      create-user.dto.ts
      update-score.dto.ts
  leaderboard/
    leaderboard.module.ts
    leaderboard.service.ts         # Top N, user position + surrounding
    leaderboard.service.spec.ts    # Unit tests
    leaderboard.controller.ts      # GET /leaderboard/top, /leaderboard/user/:id
  cache/
    cache.module.ts                # Global Redis module
    redis-cache.service.ts         # Redis sorted set operations
    cache-warmer.service.ts        # Startup cache warm-up from PostgreSQL
  database/
    seed.ts                        # Bulk seed script (COPY protocol)
    migrations/                    # TypeORM migrations for production
test/
  app.e2e-spec.ts                  # E2E integration tests
```
