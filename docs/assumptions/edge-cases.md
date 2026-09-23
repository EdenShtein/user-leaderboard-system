# Edge Cases & Boundary Handling

## Implemented Safeguards

### 1. Score Bounds Validation

**Problem:** JavaScript `Number.MAX_SAFE_INTEGER` (2^53 - 1 = 9,007,199,254,740,991) is smaller than PostgreSQL `BIGINT` (2^63 - 1). Scores above the JS safe integer limit lose precision silently — e.g., `9007199254740993` becomes `9007199254740992` in JavaScript before ever reaching the database.

**Solution:** Both `CreateUserDto` and `UpdateScoreDto` enforce `@Min(0)` and `@Max(Number.MAX_SAFE_INTEGER)`. Scores outside this range are rejected with a 400 Bad Request.

### 2. FIFO Tie-Breaking

See [fifo-tie-breaking.md](./fifo-tie-breaking.md) for full details. Equal scores are ordered by `updatedAt` (first to reach the score ranks higher).

### 3. Atomic Score Updates

**Problem:** A naive read-then-write (`findOne` + `save`) creates a race condition under concurrent score updates for the same user — the last write wins and intermediate updates are lost.

**Solution:** Score updates use a single `UPDATE ... SET score = $1 WHERE id = $2 RETURNING *` query, which is atomic at the database level.

### 4. User at Bottom of Leaderboard

**Problem:** The "surrounding users" endpoint returns up to 5 users above and 5 below. When a user is near the bottom (e.g., rank 9,999,998 of 10M), there are fewer than 5 users below.

**Behavior:** The API returns however many surrounding users exist. If the user is last, only users above are returned. The response `surrounding` array length is variable (up to 11).

### 5. Pagination Offset Cap

**Problem:** An unbounded `offset` parameter allows clients to request `offset=999999999`, forcing PostgreSQL to skip 1 billion rows — an O(n) operation even with an index.

**Solution:** The offset is capped at 10,000. For deeper pagination beyond 10K, cursor-based pagination should be used (not implemented — see "Not Implemented" below).

### 6. Redis Member Null Safety

**Problem:** The FIFO member encoding calls `updatedAt.getTime()`. If `updatedAt` is null/undefined (e.g., from a raw DB result or data migration), this throws a TypeError.

**Solution:** `buildMember()` falls back to `Date.now()` if `updatedAt` is not a valid Date instance.

---

## Not Implemented (Documented)

### 7. User Creation Idempotency

**Problem:** Sending the same `POST /api/users` request twice creates two distinct users with different UUIDs. In a real system, network retries or double-clicks could create duplicate accounts.

**Production solution:** Accept a client-generated idempotency key (e.g., `X-Idempotency-Key` header). Store it in a Redis hash with a 24h TTL. On duplicate key, return the original response instead of creating a new user.

**Why deferred:** Not in assignment scope. The leaderboard data structure design is unaffected.

### 8. Name Uniqueness

**Problem:** No unique constraint on the `name` column. Two users can have the same display name.

**Decision:** This is intentional. Gaming leaderboards commonly allow duplicate display names (e.g., "Player1" appearing twice). Unique display names are enforced at the identity/account layer, not the leaderboard layer.

### 9. Redis/PostgreSQL Data Reconciliation

**Problem:** If a Redis sync fails (network blip, Redis restart), Redis and PostgreSQL diverge. The fallback to PostgreSQL ensures correct results, but Redis may serve stale data once it recovers.

**Production solution:** Run a periodic reconciliation job (e.g., every 5 minutes) that compares a sample of Redis ranks against PostgreSQL and triggers a full cache warm-up if divergence exceeds a threshold.

**Current mitigation:** The cache warmer (`REDIS_WARM_ON_START=true`) handles cold starts. Individual sync failures are logged and self-heal on the next score update for that user.

### 10. `imageUrl` Validation

**Problem:** The `imageUrl` field accepts any string up to 500 characters. In production, this could store XSS payloads if rendered without escaping.

**Current mitigation:** The field is validated as `@IsString()` + `@MaxLength(500)`. URL format validation (`@IsUrl()`) is not enforced because this is a mock system.

**Production solution:** Add `@IsUrl()` validation or sanitize at the API gateway. Frontend must always escape/sanitize before rendering.

### 11. Cursor-Based Deep Pagination

**Problem:** Offset-based pagination (capped at 10,000) doesn't support browsing the full 10M-user leaderboard. A user ranked #500,000 cannot paginate to their neighborhood via `offset`.

**Production solution:** Implement cursor-based pagination using `(score, updatedAt, id)` as the cursor. The client sends `?after_score=5000&after_updated_at=...&after_id=...` and the API uses a `WHERE (score, "updatedAt", id) < (?, ?, ?)` keyset condition — O(log n) regardless of position.

**Current mitigation:** The `GET /api/leaderboard/user/:id` endpoint serves this use case by returning the user's rank and surrounding 11 users directly.
