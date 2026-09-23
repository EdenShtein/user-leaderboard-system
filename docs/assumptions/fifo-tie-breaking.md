# FIFO Tie-Breaking for Equal Scores

## Problem

When two or more users share the same score, how should they be ranked? The naive approach (alphabetical by UUID) is arbitrary and non-deterministic from the user's perspective. A fair leaderboard should rank the user who **reached the score first** higher — this is FIFO (First-In, First-Out) ordering.

## Chosen Approach: Member-Encoded Tiebreak (Option 2)

### How It Works

**PostgreSQL:** The ORDER BY clause uses `(score DESC, "updatedAt" ASC, id ASC)` — users with the same score are ranked by who reached that score first (`updatedAt`), with UUID as a final disambiguator for identical timestamps.

**Redis:** The ZSET score remains a pure integer (the user's actual score). The FIFO tiebreak is encoded into the **member string** rather than the score.

#### Member Format

```
<invertedTimestamp>:<userId>
```

Where `invertedTimestamp = pad13(MAX_TS - updatedAt_ms)`.

- `MAX_TS = 9999999999999` (a far-future timestamp)
- Earlier `updatedAt` → larger inverted value → sorts first in `ZREVRANGE`

**Example:** Two users reach score 1000 at different times:

| User | updatedAt (ms) | Inverted TS | Member | ZREVRANGE position |
|------|---------------|-------------|--------|-------------------|
| Alice | 1700000000000 | 8299999999999 | `8299999999999:alice-uuid` | **First** (higher lex) |
| Bob | 1700000005000 | 8299999995000 | `8299999995000:bob-uuid` | Second (lower lex) |

Since `ZREVRANGE` sorts equal scores by member in **reverse lexicographic** order, Alice's larger inverted timestamp places her first — preserving FIFO.

#### O(1) Rank Lookups

A secondary Redis Hash (`leaderboard:members`) maps `userId → member`:

```
HGET leaderboard:members <userId>    → returns the encoded member    O(1)
ZREVRANK leaderboard:scores <member> → returns the exact rank         O(log N)
```

#### Atomic Score Updates (Lua Script)

When a user's score changes, the old member must be removed and a new one added (since the timestamp changes). A Lua script ensures atomicity:

```lua
local oldMember = redis.call('HGET', KEYS[2], ARGV[1])
if oldMember then
  redis.call('ZREM', KEYS[1], oldMember)
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
return ARGV[3]
```

### Why `updatedAt` Instead of `createdAt`

We use `updatedAt` (when the score was last set) rather than `createdAt` (when the user was first registered). This means "first to reach **this** score wins" rather than "oldest account wins." It's fairer because:

- A user who had score 500, then earned 1000, should be ranked based on *when they got 1000* — not when they signed up
- New users aren't permanently disadvantaged against old accounts

---

## Alternatives Considered

### Option 1: Bit-Packing into the Double

**Approach:** Encode both score and timestamp into a single IEEE-754 double: `redisScore = score × 2^23 + (2^23 - 1 - secondsSinceEpoch/10)`.

**Pros:**
- Exact integer arithmetic (stays under 2^53)
- No member format changes, no Lua script needed
- Simpler implementation

**Cons:**
- **Score cap:** Maximum score ~1 billion (2^30) before exceeding 2^53 safe integer range
- **Time resolution:** Only 10-second granularity for tiebreaking
- **Fragile:** Any score exceeding the cap silently corrupts rankings
- **Decode complexity:** Every read must decode with integer division

**Why rejected:** The score cap is too restrictive for a gaming leaderboard where scores can grow unbounded. The 10-second time resolution is also inadequate — two users achieving the same score within 10 seconds would still collide.

### Option 3: Fractional Timestamp Score Encoding

**Approach:** `redisScore = baseScore + (1 - now_ms / 10^13)` — encode the timestamp as a decimal fraction of the score.

**Pros:**
- Simple formula, no member changes
- Works for small scores

**Cons:**
- **IEEE-754 precision loss:** At score 1,000, the gap between representable doubles is ~2.3e-13, but 1ms encodes as 1e-13 — below the precision gap. Two users 1ms apart collide.
- **Degrades with score magnitude:** At score 1,000,000 → ~2.3 second resolution. At 1e9 → ~40 minute resolution.
- **Silent failures:** No error when precision is lost; ties silently revert to lexicographic member ordering.

**Why rejected:** The precision loss is a fundamental flaw that worsens as scores grow. This is unacceptable for a production leaderboard where scores routinely exceed 1,000,000.

### Option 4: App-Side Tie Resolution

**Approach:** Store raw scores only in Redis. Fetch the page of results, then re-sort tied rows by `updatedAt` in the application layer.

**Pros:**
- Simplest Redis setup (no member changes, no Lua)
- Display order is correct

**Cons:**
- **ZREVRANK is wrong for ties:** A user's numeric rank from Redis can flip between refreshes when tied users appear in arbitrary order
- **"You are #40,001" instability:** The user sees their rank change without their score changing
- **Cross-page boundary issues:** If tied users span a page break, app-side sorting can't see the full picture
- **Extra database load:** Every leaderboard read with ties requires a PostgreSQL query to fetch `updatedAt`

**Why rejected:** Rank instability is a UX problem. Users notice when their rank fluctuates without action. The extra database load also defeats the purpose of Redis caching.

---

## Comparison Summary

| Metric | Option 1 (Bit-pack) | Option 2 (Member) | Option 3 (Fractional) | Option 4 (App-side) |
|--------|---------------------|--------------------|-----------------------|---------------------|
| Score Precision | Lossless within mask | **100% Lossless** | Degrades with score | 100% Lossless |
| Time Resolution | ~10 seconds | **Millisecond** | Degrades with score | Millisecond |
| Max Score Cap | ~1 Billion | **No Cap** | Depends on precision | No Cap |
| ZREVRANK Accuracy | Exact | **Exact** | Approximate | **Flaky on ties** |
| Redis Complexity | Standard ZADD | Lua script + Hash | Standard ZADD | Standard ZADD |
| Memory Overhead | None | ~50 bytes/user (Hash) | None | None |

## Assumptions

1. **Timestamp granularity:** JavaScript `Date.getTime()` provides millisecond precision, which is sufficient for FIFO ordering
2. **Clock skew:** In a multi-instance deployment, server clocks are assumed to be synchronized via NTP within a few milliseconds. For this use case, sub-second accuracy is adequate.
3. **MAX_TS = 9999999999999:** This is November 20, 2286 — sufficient for any foreseeable deployment lifetime
4. **Memory overhead:** The `leaderboard:members` hash adds ~50 bytes per user. At 10M users, this is ~500MB — well within the ElastiCache `cache.r6g.large` (13GB) budget
