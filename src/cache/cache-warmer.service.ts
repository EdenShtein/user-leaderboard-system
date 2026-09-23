import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { RedisCacheService } from './redis-cache.service';

const BATCH_SIZE = 5000;

@Injectable()
export class CacheWarmerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CacheWarmerService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly redisCache: RedisCacheService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    const warmOnStart = this.config.get('REDIS_WARM_ON_START', 'false');
    if (warmOnStart !== 'true') return;

    if (!this.redisCache.isConnected()) {
      this.logger.warn('Redis not connected — skipping cache warm-up');
      return;
    }

    // Run asynchronously so it doesn't block startup
    this.warmCache().catch((err) =>
      this.logger.error('Cache warm-up failed', err),
    );
  }

  async warmCache(): Promise<void> {
    this.logger.log('Starting Redis cache warm-up from PostgreSQL...');
    const startTime = Date.now();

    const totalCount = await this.usersRepo.count();
    if (totalCount === 0) {
      this.logger.log('No users to warm — skipping');
      return;
    }

    let offset = 0;
    let loaded = 0;

    while (offset < totalCount) {
      const users = await this.usersRepo
        .createQueryBuilder('u')
        .select(['u.id', 'u.name', 'u.imageUrl', 'u.score', 'u.updatedAt'])
        .orderBy('u.id', 'ASC')
        .skip(offset)
        .take(BATCH_SIZE)
        .getMany();

      if (users.length === 0) break;

      await this.redisCache.warmBatch(
        users.map((u) => ({
          id: u.id,
          score: Number(u.score),
          name: u.name,
          imageUrl: u.imageUrl,
          updatedAt: u.updatedAt,
        })),
      );

      loaded += users.length;
      offset += BATCH_SIZE;

      if (loaded % 50000 === 0 || loaded === totalCount) {
        this.logger.log(
          `Cache warm-up: ${loaded.toLocaleString()} / ${totalCount.toLocaleString()} users`,
        );
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.logger.log(
      `Cache warm-up complete: ${loaded.toLocaleString()} users in ${elapsed}s`,
    );
  }
}
