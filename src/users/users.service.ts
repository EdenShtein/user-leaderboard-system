import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { RedisCacheService } from '../cache/redis-cache.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly redisCache: RedisCacheService,
  ) {}

  async create(dto: CreateUserDto): Promise<User> {
    const user = this.usersRepo.create(dto);
    const saved = await this.usersRepo.save(user);
    await this.syncToRedis(saved);
    return saved;
  }

  async updateScore(id: string, score: number): Promise<User & { applied: boolean }> {
    // Monotonic guard: only apply if the new score is strictly higher than the current score.
    // This prevents race conditions (concurrent retries with stale data overwriting a higher score)
    // and aligns with gaming semantics where scores represent achievements.
    const result = await this.usersRepo
      .createQueryBuilder()
      .update(User)
      .set({ score })
      .where('id = :id AND score < :newScore', { id, newScore: score })
      .returning('*')
      .execute();

    if (result.affected === 1) {
      const raw = result.raw[0];
      const saved: User = {
        ...raw,
        score: Number(raw.score),
        createdAt: new Date(raw.createdAt),
        updatedAt: new Date(raw.updatedAt),
      };
      await this.syncToRedis(saved);
      return { ...saved, applied: true };
    }

    // affected === 0 means either the user doesn't exist or the new score is not higher.
    // Distinguish the two cases with a separate read.
    const existing = await this.usersRepo.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`User ${id} not found`);
    }
    // User exists but new score is not strictly higher than the current score.
    return { ...existing, applied: false };
  }

  async findById(id: string): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  private async syncToRedis(user: User): Promise<void> {
    try {
      if (!this.redisCache.isConnected()) return;
      await Promise.all([
        this.redisCache.setUserScore(user.id, Number(user.score), user.updatedAt),
        this.redisCache.setUserData(user.id, {
          name: user.name,
          imageUrl: user.imageUrl,
        }),
      ]);
    } catch (err) {
      this.logger.warn('Failed to sync user to Redis', err);
    }
  }
}
