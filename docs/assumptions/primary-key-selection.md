# Primary Key Selection: UUID v4 (Current Choice)

## Decision

We keep **UUID v4** as the primary key for the `users` table.

## Context: BIGINT vs UUID

For a 10M-user leaderboard system, BIGINT (64-bit integer) offers better raw performance and memory, but UUID provides operational advantages that outweigh the cost at our scale.

### BIGINT (64-bit Integer)

- **Redis Footprint:** Storing 10 million integer strings (e.g., `"12345678"`) as ZSET members uses ~600-700 MB of RAM — cutting Redis memory usage nearly in half.
- **PostgreSQL Performance:** Takes 8 bytes per row. B-Tree primary key indexes are compact, fit easily into memory, and append sequentially, avoiding disk page splits.
- **Trade-off:** Sequential IDs can expose total user counts or allow enumeration if exposed directly in public APIs (mitigated by hiding internal IDs behind obfuscated API tokens or using auto-increment per shard).

### UUID v4 (Random) — Current Choice

- **Redis Footprint:** Storing 36-character string members (e.g., `"f47ac10b-58cc-4372-a567-0e02b2c3d479"`) uses ~1.2-1.5 GB for 10M members in the Redis ZSET.
- **PostgreSQL Performance:** Random insertions across a B-Tree index cause page splits and index fragmentation as the table grows. However, the **hot query path** uses the composite score index `(score DESC, "updatedAt" ASC, id ASC)`, not the PK index — so PK fragmentation has minimal impact on leaderboard queries.
- **Advantages:**
  - No coordination required for distributed ID generation (multi-instance, multi-region)
  - No user count or ordering information leaked through the API
  - Standard format understood by all clients and tools

### UUID v7 / ULID (Time-Ordered UUID)

- **PostgreSQL Performance:** UUID v7 puts a timestamp prefix, making insertions naturally sequential and preserving B-Tree insert order.
- **Trade-off:** Still 16 bytes in PostgreSQL and high string memory in Redis. Requires changing the PK generator but keeps the UUID API format.

## Why We Chose UUID v4

| Factor | BIGINT | UUID v4 | UUID v7 |
|--------|--------|---------|---------|
| Redis memory (10M users) | ~700 MB | ~1.5 GB | ~1.5 GB |
| PG PK index size | 8 bytes/row | 16 bytes/row | 16 bytes/row |
| PG insert fragmentation | None (sequential) | Some (random) | None (sequential) |
| Distributed-friendly | Requires sequence coordination | Yes | Yes |
| API security | Exposes user counts | No information leak | Partially time-ordered |
| Refactor cost | High (all APIs, DTOs, tests) | None (current) | Low (swap generator) |

**The deciding factors:**

1. **Redis memory is not a bottleneck.** At 1.5 GB for 10M users, we're well within the ElastiCache `cache.r6g.large` budget (13 GB). The member strings in our FIFO encoding (`<invertedTs>:<uuid>`) add overhead regardless of PK type.

2. **PK index fragmentation doesn't affect the hot path.** Leaderboard queries use the composite score index, not the PK index. The PK index is only hit for single-user lookups (`findById`), which are O(log n) regardless.

3. **Switching PK is a high-risk refactor.** Changing to BIGINT would require migrating every API endpoint, DTO, validation pipe, test, seed script, and the Redis member encoding — touching nearly every file in the codebase for a ~800 MB Redis saving.

4. **UUIDs are operationally simpler.** No sequence coordination for multi-instance deployments, no ID collision concerns during database migrations or merges.

## When to Reconsider

- If Redis memory exceeds 70% of the ElastiCache node capacity (e.g., >9 GB on a 13 GB node)
- If scaling beyond 50M users, where the 2x memory savings becomes meaningful
- If switching to UUID v7 becomes trivial (TypeORM native support improves)
- If PK lookup performance becomes a measurable bottleneck in production profiling
