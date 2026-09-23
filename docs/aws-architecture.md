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
