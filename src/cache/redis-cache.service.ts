import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const LEADERBOARD_KEY = 'leaderboard:scores';
const USER_MEMBERS_KEY = 'leaderboard:members';
const USER_DATA_PREFIX = 'leaderboard:user:';
const USER_DATA_TTL = 86400; // 24 hours in seconds
const MAX_TS = 9999999999999; // Far-future timestamp for inversion

/**
 * Lua script for atomic score update with member-encoded FIFO tiebreak.
 *
 * KEYS[1] = leaderboard sorted set
 * KEYS[2] = user_members hash
 * ARGV[1] = userId
 * ARGV[2] = newScore
 * ARGV[3] = newMember (invertedTs:userId)
 *
 * Steps:
 * 1. Look up existing member for this user
 * 2. Remove old member from sorted set (if exists)
 * 3. Add new member with new score
 * 4. Update the userId→member mapping
 */
const UPSERT_SCORE_LUA = `
local oldMember = redis.call('HGET', KEYS[2], ARGV[1])
if oldMember then
  redis.call('ZREM', KEYS[1], oldMember)
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
return ARGV[3]
`;

/**
 * Lua script for atomic user removal.
 *
 * KEYS[1] = leaderboard sorted set
 * KEYS[2] = user_members hash
 * KEYS[3] = user data hash key
 * ARGV[1] = userId
 */
const REMOVE_USER_LUA = `
local oldMember = redis.call('HGET', KEYS[2], ARGV[1])
if oldMember then
  redis.call('ZREM', KEYS[1], oldMember)
end
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return 1
`;

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly logger = new Logger(RedisCacheService.name);

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis({
      host: config.get('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      lazyConnect: true,
    });
  }

  async onModuleInit() {
    try {
      await this.redis.connect();
      this.logger.log('Redis connected');
    } catch (err) {
      this.logger.warn('Redis connection failed, running without cache', err);
    }
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  isConnected(): boolean {
    return this.redis.status === 'ready';
  }

  // ── Member encoding helpers ──────────────────────────────────

  /**
   * Build a ZSET member string that encodes FIFO tiebreak.
   *
   * Format: `<invertedTimestamp>:<userId>`
   *
   * When two members share the same ZSET score, Redis ZREVRANGE sorts
   * equal-score members in reverse lexicographic order. By inverting
   * the timestamp (MAX_TS - ts), earlier timestamps produce LARGER
   * inverted values, which sort first in ZREVRANGE — achieving FIFO.
   */
  buildMember(userId: string, updatedAt: Date): string {
    const ts = updatedAt instanceof Date ? updatedAt.getTime() : Date.now();
    const inverted = String(MAX_TS - ts).padStart(13, '0');
    return `${inverted}:${userId}`;
  }

  /**
   * Parse a member string back into userId and inverted timestamp.
   */
  parseMember(member: string): { userId: string; invertedTs: string } {
    const colonIdx = member.indexOf(':');
    return {
      invertedTs: member.substring(0, colonIdx),
      userId: member.substring(colonIdx + 1),
    };
  }

  // ── Write operations ─────────────────────────────────────────

  /**
   * Add or update a user's score in the Redis sorted set.
   * Uses a Lua script for atomicity: ZREM old member + ZADD new + HSET mapping.
   */
  async setUserScore(userId: string, score: number, updatedAt: Date): Promise<void> {
    const member = this.buildMember(userId, updatedAt);
    await this.redis.eval(
      UPSERT_SCORE_LUA,
      2,
      LEADERBOARD_KEY,
      USER_MEMBERS_KEY,
      userId,
      score,
      member,
    );
  }

  /**
   * Cache user profile data (name, imageUrl) as a hash with TTL.
   */
  async setUserData(
    userId: string,
    data: { name: string; imageUrl: string | null },
  ): Promise<void> {
    const key = `${USER_DATA_PREFIX}${userId}`;
    await this.redis
      .pipeline()
      .hset(key, 'name', data.name, 'imageUrl', data.imageUrl ?? '')
      .expire(key, USER_DATA_TTL)
      .exec();
  }

  // ── Read operations ──────────────────────────────────────────

  /**
   * Get top N users from the sorted set (highest scores first).
   * Members are parsed to extract userId.
   */
  async getTopUsers(
    limit: number,
    offset: number = 0,
  ): Promise<{ id: string; score: number; rank: number }[]> {
    const results = await this.redis.zrevrange(
      LEADERBOARD_KEY,
      offset,
      offset + limit - 1,
      'WITHSCORES',
    );

    const users: { id: string; score: number; rank: number }[] = [];
    for (let i = 0; i < results.length; i += 2) {
      const { userId } = this.parseMember(results[i]);
      users.push({
        id: userId,
        score: Number(results[i + 1]),
        rank: offset + i / 2 + 1,
      });
    }
    return users;
  }

  /**
   * Get user data hash for enriching leaderboard results.
   */
  async getUserData(
    userId: string,
  ): Promise<{ name: string; imageUrl: string | null } | null> {
    const data = await this.redis.hgetall(`${USER_DATA_PREFIX}${userId}`);
    if (!data || !data.name) return null;
    return {
      name: data.name,
      imageUrl: data.imageUrl || null,
    };
  }

  /**
   * Batch get user data for multiple user IDs using pipeline.
   */
  async getUserDataBatch(
    userIds: string[],
  ): Promise<Map<string, { name: string; imageUrl: string | null }>> {
    if (userIds.length === 0) return new Map();

    const pipeline = this.redis.pipeline();
    for (const id of userIds) {
      pipeline.hgetall(`${USER_DATA_PREFIX}${id}`);
    }
    const results = await pipeline.exec();
    const map = new Map<string, { name: string; imageUrl: string | null }>();

    if (results) {
      for (let i = 0; i < userIds.length; i++) {
        const [err, data] = results[i];
        if (!err && data && typeof data === 'object' && 'name' in data) {
          const record = data as Record<string, string>;
          map.set(userIds[i], {
            name: record.name,
            imageUrl: record.imageUrl || null,
          });
        }
      }
    }
    return map;
  }

  /**
   * Get a user's rank (1-based) from the sorted set.
   * Looks up the encoded member via the user_members hash, then ZREVRANK.
   */
  async getUserRank(userId: string): Promise<number | null> {
    const member = await this.redis.hget(USER_MEMBERS_KEY, userId);
    if (!member) return null;
    const rank = await this.redis.zrevrank(LEADERBOARD_KEY, member);
    return rank !== null ? rank + 1 : null;
  }

  /**
   * Get a user's score from the sorted set.
   */
  async getUserScore(userId: string): Promise<number | null> {
    const member = await this.redis.hget(USER_MEMBERS_KEY, userId);
    if (!member) return null;
    const score = await this.redis.zscore(LEADERBOARD_KEY, member);
    return score !== null ? Number(score) : null;
  }

  /**
   * Get users surrounding a given rank (5 above + user + 5 below).
   * Members are parsed to extract userId.
   */
  async getSurroundingUsers(
    rank: number,
  ): Promise<{ id: string; score: number; rank: number }[]> {
    const start = Math.max(0, rank - 6); // 5 above (rank is 1-based, zrevrange is 0-based)
    const end = rank + 4; // 5 below

    const results = await this.redis.zrevrange(
      LEADERBOARD_KEY,
      start,
      end,
      'WITHSCORES',
    );

    const users: { id: string; score: number; rank: number }[] = [];
    for (let i = 0; i < results.length; i += 2) {
      const { userId } = this.parseMember(results[i]);
      users.push({
        id: userId,
        score: Number(results[i + 1]),
        rank: start + i / 2 + 1,
      });
    }
    return users;
  }

  /**
   * Remove a user from the leaderboard and their cached data.
   * Uses a Lua script for atomicity.
   */
  async removeUser(userId: string): Promise<void> {
    await this.redis.eval(
      REMOVE_USER_LUA,
      3,
      LEADERBOARD_KEY,
      USER_MEMBERS_KEY,
      `${USER_DATA_PREFIX}${userId}`,
      userId,
    );
  }

  /**
   * Bulk load a batch of users into Redis (ZADD + HSET) using pipeline.
   * Used during cache warm-up from PostgreSQL.
   */
  async warmBatch(
    users: {
      id: string;
      score: number;
      name: string;
      imageUrl: string | null;
      updatedAt: Date;
    }[],
  ): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const user of users) {
      const member = this.buildMember(user.id, user.updatedAt);
      pipeline.zadd(LEADERBOARD_KEY, user.score, member);
      pipeline.hset(USER_MEMBERS_KEY, user.id, member);
      pipeline.hset(
        `${USER_DATA_PREFIX}${user.id}`,
        'name',
        user.name,
        'imageUrl',
        user.imageUrl ?? '',
      );
      pipeline.expire(`${USER_DATA_PREFIX}${user.id}`, USER_DATA_TTL);
    }
    await pipeline.exec();
  }
}
