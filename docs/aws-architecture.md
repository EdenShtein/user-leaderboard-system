# AWS Cloud Architecture — Leaderboard System

## Overview

Production AWS architecture for the leaderboard system, supporting 10M+ users with sub-100ms reads and high write throughput. Designed around the application's write-through caching pattern with graceful Redis fallback.

## Architecture Diagram

```
                                    ┌──────────────┐
                                    │   Route 53   │
                                    │    (DNS)     │
                                    └──────┬───────┘
                                           │
                                    ┌──────▼───────┐
                                    │  CloudFront  │  ← Cache GET /leaderboard/top (TTL 5s)
                                    │    (CDN)     │  ← Pass-through all other endpoints
                                    └──────┬───────┘
                                           │
                                    ┌──────▼───────┐
                                    │   AWS WAF    │  ← Rate limiting, IP blocking
                                    └──────┬───────┘
                                           │
                              ┌────────────▼────────────┐
                              │     ALB (HTTPS:443)     │
                              │   Health: /api/health   │
                              └────────────┬────────────┘
                                           │
               ┌───────────────────────────┼───────────────────────────┐
               │            AZ-a           │           AZ-b           │
               │                           │                          │
               │   ┌───────────────┐       │   ┌───────────────┐     │
               │   │  ECS Fargate  │       │   │  ECS Fargate  │     │
               │   │   (Task 1)    │       │   │   (Task 2)    │     │
               │   └───────┬───────┘       │   └───────┬───────┘     │
               │           │               │           │              │
               └───────────┼───────────────┼───────────┼──────────────┘
                           │               │           │
              ┌────────────▼───────────────▼───────────▼────────────┐
              │                    Private Subnets                   │
              │                                                      │
              │  ┌──────────────────┐    ┌───────────────────────┐  │
              │  │  ElastiCache     │    │   RDS PostgreSQL      │  │
              │  │  Redis 7         │    │   (Multi-AZ)          │  │
              │  │                  │    │                       │  │
              │  │  Primary (AZ-a)  │    │  Primary   (AZ-a)    │  │
              │  │  Replica (AZ-b)  │    │  Standby   (AZ-b)    │  │
              │  │                  │    │  Read Replica (AZ-a)  │  │
              │  └──────────────────┘    └───────────────────────┘  │
              └─────────────────────────────────────────────────────┘
```

## How the Code Maps to This Architecture

| Application Feature | AWS Component |
|---------------------|---------------|
| Write-through caching (PG + Redis on every write) | ECS → RDS Primary + ElastiCache Primary |
| Redis fallback to PostgreSQL | ECS reads from ElastiCache, falls back to RDS Read Replica |
| FIFO Lua script (atomic ZREM + ZADD + HSET) | ElastiCache — single-node mode (no cluster sharding) |
| Health probes (`/api/health/readiness`) | ALB target group health checks |
| Cache warm-up on startup (`REDIS_WARM_ON_START`) | ECS task init — streams PG → Redis on deploy |
| Rate limiting (`@nestjs/throttler`) | Application-level per-instance + WAF global rate limiting |
| Request logging + X-Request-ID | CloudWatch Logs via ECS stdout |

## Components

### 1. Networking

| Component | Configuration |
|-----------|---------------|
| **VPC** | 10.0.0.0/16, 2 AZs minimum |
| **Public subnets** | ALB, NAT Gateway (one per AZ) |
| **Private subnets** | ECS tasks, RDS, ElastiCache — no direct internet access |
| **Security Groups** | ALB → ECS (:3000), ECS → RDS (:5432), ECS → Redis (:6379) |

### 2. Compute — ECS Fargate

**Why Fargate:** Lower operational overhead than EKS for a single-service deployment. No cluster management, no node patching. The existing Dockerfile and health probes work as-is.

| Setting | Value | Rationale |
|---------|-------|-----------|
| CPU | 1 vCPU | Node.js is single-threaded; 1 vCPU is the sweet spot |
| Memory | 2 GB | TypeORM connection pool + Redis client + request buffers |
| Min tasks | 2 | One per AZ for high availability |
| Max tasks | 20 | Handles traffic spikes |
| Auto-scaling | CPU > 60% or ALB request count | Scale on compute or traffic pressure |
| Health check | `/api/health/readiness` | Verifies DB + Redis status before routing traffic |
| Deployment | Rolling update, minHealthy: 100%, max: 200% | Zero-downtime deploys |

**Environment variables:** Injected from AWS Secrets Manager (DB credentials) and SSM Parameter Store (non-secret config like `REDIS_HOST`, `PORT`).

### 3. Database — RDS PostgreSQL

| Setting | Value | Rationale |
|---------|-------|-----------|
| Engine | PostgreSQL 16 | Matches local development |
| Instance | `db.r6g.xlarge` | 4 vCPU, 32 GB RAM — fits users table + composite index in memory |
| Storage | 100 GB gp3 | Baseline 3,000 IOPS, burst to 16,000 |
| Multi-AZ | Yes | Automatic failover, ~30s downtime |
| Read replicas | 1 | Offload `GET /api/leaderboard/*` queries |
| Backup | 7-day retention, automated snapshots | Point-in-time recovery |
| Parameter tuning | `shared_buffers=8GB`, `work_mem=256MB` | Optimized for the `(score DESC, "updatedAt" ASC, id ASC)` index scans |

**Connection pooling:** 10-20 connections per ECS task. At 20 tasks = 200-400 connections. RDS xlarge supports ~5,000 — ample headroom.

### 4. Caching — ElastiCache Redis

| Setting | Value | Rationale |
|---------|-------|-----------|
| Engine | Redis 7 | Sorted set + Lua script support |
| Node type | `cache.r6g.large` | 13 GB memory |
| Cluster mode | **Disabled** (single-shard + replica) | Lua scripts access multiple keys (`leaderboard:scores`, `leaderboard:members`) — must be on the same shard |
| Replicas | 1 | Read scaling + automatic failover |
| Eviction policy | `volatile-ttl` | Protects the ZSET and members hash (no TTL, never evicted). Only user-data hashes (24h TTL) are eviction candidates under memory pressure. Configure via ElastiCache parameter group: `maxmemory-policy = volatile-ttl`. |
| Encryption | In-transit + at-rest | Security compliance |

**Why single-shard, not cluster mode:** Our FIFO Lua script atomically touches both the sorted set and the members hash. In Redis Cluster, multi-key operations require all keys on the same shard (via hash tags). Single-shard with a replica is simpler and sufficient — 10M users with member-encoded FIFO members (~80 bytes each) ≈ 1.5 GB, well within the 13 GB node.

**Memory estimate:**
| Data Structure | Per-Entry | 10M Users |
|----------------|-----------|-----------|
| ZSET (`leaderboard:scores`) | ~80 bytes (49-char member + score) | ~800 MB |
| Hash (`leaderboard:members`) | ~70 bytes (UUID → member mapping) | ~700 MB |
| Hashes (`leaderboard:user:*`) | ~60 bytes (name + imageUrl) | ~600 MB |
| **Total** | | **~2.1 GB** |

13 GB node leaves ~11 GB headroom for growth, OS overhead, and fragmentation.

### 5. Load Balancing — ALB

| Setting | Value |
|---------|-------|
| Listener | HTTPS (443) → target group (:3000) |
| SSL/TLS | ACM certificate, TLS 1.3 |
| Health check | `/api/health/liveness`, interval 10s, threshold 3 |
| Stickiness | Disabled — API is stateless |

### 6. CDN — CloudFront

| Behavior | Cache Policy |
|----------|-------------|
| `GET /api/leaderboard/top*` | TTL 5 seconds — the most popular endpoint, safe to cache briefly |
| All other paths | Pass-through (no caching) — writes and user-specific queries |

At 5s TTL, a viral leaderboard page gets served from edge with ~5s staleness — acceptable for a gaming leaderboard. Reduces origin load by 90%+ during traffic spikes.

### 7. Security

| Layer | Implementation |
|-------|---------------|
| **Secrets** | DB credentials in AWS Secrets Manager, rotated automatically |
| **Config** | Non-secret env vars in SSM Parameter Store |
| **IAM** | ECS task role with least-privilege access to Secrets Manager + SSM |
| **Network** | Private subnets for all data stores, no public IPs on ECS tasks |
| **WAF** | Rate limiting (1,000 req/s per IP), SQL injection rules, geo-blocking |
| **Encryption** | TLS in-transit everywhere, RDS + ElastiCache encrypted at rest |

### 8. Monitoring

| Tool | What It Watches |
|------|----------------|
| **CloudWatch Metrics** | ECS CPU/memory, RDS connections/latency, ElastiCache hit ratio |
| **CloudWatch Alarms** | P99 latency > 200ms, error rate > 1%, Redis fallback triggered |
| **CloudWatch Logs** | Structured JSON logs from ECS (request ID, duration, status) |
| **X-Ray** | Distributed tracing: API → Redis → PostgreSQL per request |

See [monitoring.md](../assumptions/monitoring.md) for the full alerting and dashboard design.

### 9. CI/CD Pipeline

```
GitHub Push → CodePipeline → CodeBuild (test + build) → ECR → ECS Rolling Deploy
```

| Stage | Action |
|-------|--------|
| **Source** | Trigger on `main` branch push |
| **Test** | `npm test` + `npm run build` |
| **Build** | `docker build` → push to ECR |
| **Deploy** | ECS rolling update from new image |

## Cost Estimate (Monthly)

| Component | Spec | Cost |
|-----------|------|------|
| ECS Fargate | 2-4 tasks, 1 vCPU / 2 GB | ~$120-240 |
| RDS PostgreSQL | db.r6g.xlarge, Multi-AZ | ~$500 |
| RDS Read Replica | db.r6g.large × 1 | ~$180 |
| ElastiCache Redis | cache.r6g.large, 1 replica | ~$300 |
| ALB | Standard usage | ~$30 |
| CloudFront | Moderate traffic | ~$20-50 |
| Secrets Manager + SSM | Minimal | ~$5 |
| **Total** | | **~$1,155-1,305/mo** |

## Scaling Playbook

| Signal | Action |
|--------|--------|
| ECS CPU > 60% sustained | Auto-scale: add tasks (up to 20) |
| RDS CPU > 70% sustained | Vertical: upgrade to db.r6g.2xlarge |
| Read replica lag > 100ms | Add a second read replica |
| Redis memory > 70% | Vertical: upgrade to cache.r6g.xlarge (26 GB) |
| Users > 50M | Evaluate Redis Cluster mode with hash-tagged keys, or partition leaderboard by region |
| Global latency requirements | Multi-region: Route 53 latency routing + cross-region RDS read replicas |

---

## Scaling to 100M Users

The current architecture is sized for 10M users. At 100M the bottlenecks shift. Below is a concrete upgrade path for each layer.

### 10M vs 100M: At a Glance

| Layer | 10M Config | 10M Load | 100M Config | 100M Load |
|-------|-----------|----------|-------------|-----------|
| **Redis** | cache.r6g.large (13 GB) | ~2.1 GB used | cache.r6g.2xlarge (52 GB) | ~21 GB used |
| **PostgreSQL** | db.r6g.xlarge (32 GB) | ~4 GB table+index | db.r6g.4xlarge (128 GB) | ~42 GB table+index |
| **ECS tasks** | 2–20 tasks | ~20k req/s origin | 2–60 tasks | ~60k req/s origin |
| **Read replicas** | 1 | Adequate | 2–3 behind reader endpoint | Distributes PG fallback load |
| **PG IOPS** | gp3 3,000 baseline | Adequate | gp3 6,000–16,000 provisioned | Higher write concurrency |

### Redis: Memory and Cluster Mode

**Memory estimate at 100M users:**

| Data Structure | Per-Entry | 100M Users |
|----------------|-----------|------------|
| ZSET (`leaderboard:scores`) | ~80 bytes | ~8 GB |
| Hash (`leaderboard:members`) | ~70 bytes | ~7 GB |
| Hashes (`leaderboard:user:*`) | ~60 bytes | ~6 GB |
| **Total** | | **~21 GB** |

`cache.r6g.large` (13 GB) is insufficient at 100M. Upgrade to `cache.r6g.xlarge` (26 GB) for comfortable headroom, or `cache.r6g.2xlarge` (52 GB) if rapid user growth is expected.

**Redis Cluster mode** becomes relevant above ~50M users to distribute write throughput across multiple shards. However, our Lua scripts atomically access two keys (`leaderboard:scores` and `leaderboard:members`). In Cluster mode, both keys must land on the same shard.

To enable Cluster mode, prefix both keys with the same hash tag:
```
{leaderboard}:scores   ← was: leaderboard:scores
{leaderboard}:members  ← was: leaderboard:members
```

Redis hashes keys inside `{}` for slot assignment, ensuring both keys share the same shard. This is a key rename + data migration and requires updating `redis-cache.service.ts` constants and the existing ZSET/hash data.

**Recommended upgrade path:**
1. First: Vertical scale (r6g.xlarge → r6g.2xlarge). No code changes.
2. Then: Redis Cluster with hash tags if write throughput exceeds single-node capacity (~100k ops/s).

### PostgreSQL: Memory and IOPS

**Data size at 100M users:**
- Table: 100M × ~200 bytes ≈ 20 GB
- Composite index `(score DESC, updatedAt ASC, id ASC)`: 100M × ~220 bytes ≈ 22 GB
- **Total: ~42 GB**

`db.r6g.xlarge` has 32 GB RAM with `shared_buffers = 8 GB`. The full index (22 GB) cannot fit in the buffer pool → index scans require disk reads → latency increases under mixed workload.

Upgrade to `db.r6g.4xlarge` (128 GB RAM, `shared_buffers = 32 GB`). At this size the entire index fits in memory, maintaining sub-millisecond index lookups.

**IOPS:** At 100M active users with ~5,000 concurrent score updates per second, gp3 baseline (3,000 IOPS) is the bottleneck. Configure provisioned IOPS:
- `gp3` with 6,000–16,000 IOPS: cheaper, covers most cases
- `io2 Block Express` at 64,000 IOPS: for extreme write throughput

### ECS Fargate: Task Count

Raise `max_tasks` from 20 to 50–60. Keep `min_tasks` at 2 (one per AZ). Auto-scaling on CPU > 60% or ALB `RequestCountPerTarget` remains unchanged.

At 100 tasks × 10 PG connections = 1,000 connections — well within `db.r6g.4xlarge` capacity (~15,000). If task count grows beyond 200, add **AWS RDS Proxy** (PgBouncer-as-a-service) to multiplex connections and reduce the per-task connection overhead.

### Read Replicas

Add 2–3 read replicas behind the RDS **reader endpoint** (DNS load-balances across replicas). `LeaderboardService`'s PG fallback path should target the reader endpoint, not the primary writer. This isolates leaderboard fallback reads from write traffic on the primary.

RDS reader endpoint failover is automatic — if one replica fails, the reader endpoint routes to the remaining replicas within seconds.

### CloudFront at 100M

No changes needed. CloudFront scales horizontally across edge PoPs by design. At 100M users with higher read traffic (10M+ DAU), reduce the TTL on `/leaderboard/top` to 2–3 seconds for fresher data at the cost of slightly more origin traffic — still well within the ALB's capacity with 50–60 ECS tasks.

### Connection Pooling at Scale

```
100 tasks × 10 connections = 1,000 total PG connections
db.r6g.4xlarge max_connections ≈ 15,000
Headroom: 14,000 connections — ample

If tasks grow to 300+:
  → Add AWS RDS Proxy (PgBouncer):
     300 tasks × 10 connections = 3,000 proxy connections
     RDS Proxy → PG Primary: ~100 persistent connections
     PG Primary sees 100 connections regardless of pod count
```

### Updated Cost Estimate at 100M Users (Monthly)

| Component | Spec | Cost |
|-----------|------|------|
| ECS Fargate | 4–15 tasks avg, 1 vCPU / 2 GB | ~$240–600 |
| RDS PostgreSQL | db.r6g.4xlarge, Multi-AZ | ~$2,000 |
| RDS Read Replicas | db.r6g.2xlarge × 2 | ~$1,400 |
| ElastiCache Redis | cache.r6g.2xlarge, 1 replica | ~$800 |
| RDS Proxy | Standard usage | ~$150 |
| ALB + CloudFront | Higher traffic | ~$100–200 |
| **Total** | | **~$4,700–5,150/mo** |
