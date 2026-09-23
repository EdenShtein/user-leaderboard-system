import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { RedisCacheService } from '../cache/redis-cache.service';

export interface RankedUser {
  rank: number;
  id: string;
  name: string;
  imageUrl: string | null;
  score: number;
}

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly usersService: UsersService,
    private readonly redisCache: RedisCacheService,
  ) {}

  private isRedisAvailable(): boolean {
    return this.redisCache.isConnected();
  }

  /**
   * Get top N users. Tries Redis first, falls back to PostgreSQL.
   */
  async getTopUsers(limit: number, offset: number = 0): Promise<RankedUser[]> {
    if (this.isRedisAvailable()) {
      try {
        const result = await this.getTopUsersFromRedis(limit, offset);
        if (result.length > 0) return result;
      } catch (err) {
        this.logger.warn('Redis getTopUsers failed, falling back to DB', err);
      }
    }
    return this.getTopUsersFromDb(limit, offset);
  }

  /**
   * Get a user's rank plus the 5 users above and 5 below.
   * Tries Redis first, falls back to PostgreSQL.
   */
  async getUserWithSurrounding(userId: string): Promise<{
    user: RankedUser;
    surrounding: RankedUser[];
  }> {
    if (this.isRedisAvailable()) {
      try {
        return await this.getUserWithSurroundingFromRedis(userId);
      } catch (err) {
        this.logger.warn('Redis getUserWithSurrounding failed, falling back to DB', err);
      }
    }
    return this.getUserWithSurroundingFromDb(userId);
  }

  // ── Redis-backed implementations ──────────────────────────────

  private async getTopUsersFromRedis(limit: number, offset: number = 0): Promise<RankedUser[]> {
    const entries = await this.redisCache.getTopUsers(limit, offset);
    const userIds = entries.map((e) => e.id);
    const userData = await this.redisCache.getUserDataBatch(userIds);

    return entries.map((entry) => {
      const data = userData.get(entry.id);
      return {
        rank: entry.rank,
        id: entry.id,
        name: data?.name ?? 'Unknown',
        imageUrl: data?.imageUrl ?? null,
        score: entry.score,
      };
    });
  }

  private async getUserWithSurroundingFromRedis(userId: string): Promise<{
    user: RankedUser;
    surrounding: RankedUser[];
  }> {
    const rank = await this.redisCache.getUserRank(userId);
    if (rank === null) {
      // User not in Redis — fall back to DB
      return this.getUserWithSurroundingFromDb(userId);
    }

    const entries = await this.redisCache.getSurroundingUsers(rank);
    const userIds = entries.map((e) => e.id);
    const userData = await this.redisCache.getUserDataBatch(userIds);

    const surrounding: RankedUser[] = entries.map((entry) => {
      const data = userData.get(entry.id);
      return {
        rank: entry.rank,
        id: entry.id,
        name: data?.name ?? 'Unknown',
        imageUrl: data?.imageUrl ?? null,
        score: entry.score,
      };
    });

    const rankedUser = surrounding.find((u) => u.id === userId) ?? {
      rank,
      id: userId,
      name: 'Unknown',
      imageUrl: null,
      score: (await this.redisCache.getUserScore(userId)) ?? 0,
    };

    return { user: rankedUser, surrounding };
  }

  // ── PostgreSQL-backed implementations (fallback) ──────────────

  private async getTopUsersFromDb(limit: number, offset: number = 0): Promise<RankedUser[]> {
    const users = await this.usersRepo
      .createQueryBuilder('u')
      .select([
        'u.id AS id',
        'u.name AS name',
        'u."imageUrl" AS "imageUrl"',
        'u.score AS score',
        'ROW_NUMBER() OVER (ORDER BY u.score DESC, u."updatedAt" ASC, u.id ASC) AS rank',
      ])
      .orderBy('u.score', 'DESC')
      .addOrderBy('u."updatedAt"', 'ASC')
      .addOrderBy('u.id', 'ASC')
      .offset(offset)
      .limit(limit)
      .getRawMany();

    return users.map((u) => ({
      rank: offset + Number(u.rank),
      id: u.id,
      name: u.name,
      imageUrl: u.imageUrl,
      score: Number(u.score),
    }));
  }

  private async getUserWithSurroundingFromDb(userId: string): Promise<{
    user: RankedUser;
    surrounding: RankedUser[];
  }> {
    const user = await this.usersService.findById(userId);

    const rankResult = await this.usersRepo
      .createQueryBuilder('u')
      .select('COUNT(*)', 'count')
      .where('u.score > :score', { score: user.score })
      .orWhere(
        '(u.score = :score AND u."updatedAt" < :updatedAt) OR (u.score = :score AND u."updatedAt" = :updatedAt AND u.id < :id)',
        {
          score: user.score,
          updatedAt: user.updatedAt,
          id: user.id,
        },
      )
      .getRawOne();

    const userRank = Number(rankResult.count) + 1;

    const offset = Math.max(0, userRank - 6);
    const windowSize = 11;

    const surrounding = await this.usersRepo
      .createQueryBuilder('u')
      .select([
        'u.id AS id',
        'u.name AS name',
        'u."imageUrl" AS "imageUrl"',
        'u.score AS score',
        'ROW_NUMBER() OVER (ORDER BY u.score DESC, u."updatedAt" ASC, u.id ASC) AS rank',
      ])
      .orderBy('u.score', 'DESC')
      .addOrderBy('u."updatedAt"', 'ASC')
      .addOrderBy('u.id', 'ASC')
      .offset(offset)
      .limit(windowSize)
      .getRawMany();

    const rankedSurrounding: RankedUser[] = surrounding.map((u) => ({
      rank: offset + Number(u.rank),
      id: u.id,
      name: u.name,
      imageUrl: u.imageUrl,
      score: Number(u.score),
    }));

    const rankedUser = rankedSurrounding.find((u) => u.id === userId) ?? {
      rank: userRank,
      id: user.id,
      name: user.name,
      imageUrl: user.imageUrl,
      score: Number(user.score),
    };

    return { user: rankedUser, surrounding: rankedSurrounding };
  }
}
