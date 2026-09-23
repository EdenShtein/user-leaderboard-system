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

  async updateScore(id: string, score: number): Promise<User> {
    const result = await this.usersRepo
      .createQueryBuilder()
      .update(User)
      .set({ score })
      .where('id = :id', { id })
      .returning('*')
      .execute();

    if (result.affected === 0) {
      throw new NotFoundException(`User ${id} not found`);
    }

    const raw = result.raw[0];
    const saved: User = {
      ...raw,
      score: Number(raw.score),
      createdAt: new Date(raw.createdAt),
      updatedAt: new Date(raw.updatedAt),
    };
    await this.syncToRedis(saved);
    return saved;
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
