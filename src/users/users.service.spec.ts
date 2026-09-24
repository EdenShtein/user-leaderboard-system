import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { User } from './user.entity';
import { RedisCacheService } from '../cache/redis-cache.service';

describe('UsersService', () => {
  let service: UsersService;

  const mockUser: User = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Test User',
    imageUrl: 'https://example.com/avatar.png',
    score: 1000,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockRepo = {
    create: vi.fn(),
    save: vi.fn(),
    findOne: vi.fn(),
    createQueryBuilder: vi.fn(),
  };

  const mockQueryBuilder = {
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    execute: vi.fn(),
  };

  const mockRedis = {
    isConnected: vi.fn().mockReturnValue(false),
    setUserScore: vi.fn().mockResolvedValue(undefined),
    setUserData: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: mockRepo },
        { provide: RedisCacheService, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create and return a new user', async () => {
      const dto = { name: 'Test User', imageUrl: 'https://example.com/avatar.png', score: 1000 };
      mockRepo.create.mockReturnValue(mockUser);
      mockRepo.save.mockResolvedValue(mockUser);

      const result = await service.create(dto);

      expect(mockRepo.create).toHaveBeenCalledWith(dto);
      expect(mockRepo.save).toHaveBeenCalledWith(mockUser);
      expect(result).toEqual(mockUser);
    });

    it('should sync to Redis when connected', async () => {
      const dto = { name: 'Test User', score: 500 };
      mockRepo.create.mockReturnValue(mockUser);
      mockRepo.save.mockResolvedValue(mockUser);
      mockRedis.isConnected.mockReturnValue(true);

      await service.create(dto);

      expect(mockRedis.setUserScore).toHaveBeenCalledWith(mockUser.id, mockUser.score, mockUser.updatedAt);
      expect(mockRedis.setUserData).toHaveBeenCalledWith(mockUser.id, {
        name: mockUser.name,
        imageUrl: mockUser.imageUrl,
      });
    });

    it('should not sync to Redis when disconnected', async () => {
      const dto = { name: 'Test User', score: 500 };
      mockRepo.create.mockReturnValue(mockUser);
      mockRepo.save.mockResolvedValue(mockUser);
      mockRedis.isConnected.mockReturnValue(false);

      await service.create(dto);

      expect(mockRedis.setUserScore).not.toHaveBeenCalled();
    });

    it('should not throw if Redis sync fails', async () => {
      const dto = { name: 'Test User', score: 500 };
      mockRepo.create.mockReturnValue(mockUser);
      mockRepo.save.mockResolvedValue(mockUser);
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.setUserScore.mockRejectedValue(new Error('Redis down'));

      const result = await service.create(dto);
      expect(result).toEqual(mockUser);
    });
  });

  describe('updateScore', () => {
    it('should atomically update and return the user with new score and applied: true', async () => {
      const updated = { ...mockUser, score: 2000 };
      mockRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder);
      mockQueryBuilder.execute.mockResolvedValue({ affected: 1, raw: [updated] });

      const result = await service.updateScore(mockUser.id, 2000);

      expect(result.score).toBe(2000);
      expect(result.applied).toBe(true);
      expect(mockQueryBuilder.set).toHaveBeenCalledWith({ score: 2000 });
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('id = :id AND score < :newScore', {
        id: mockUser.id,
        newScore: 2000,
      });
    });

    it('should throw NotFoundException when user does not exist', async () => {
      mockRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder);
      mockQueryBuilder.execute.mockResolvedValue({ affected: 0, raw: [] });
      mockRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateScore('non-existent-id', 100),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return applied: false when new score is not higher than current score', async () => {
      mockRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder);
      // WHERE score < :newScore fails — new score (500) is lower than current (1000)
      mockQueryBuilder.execute.mockResolvedValue({ affected: 0, raw: [] });
      mockRepo.findOne.mockResolvedValue(mockUser);
      mockRedis.isConnected.mockReturnValue(true);

      const result = await service.updateScore(mockUser.id, 500);

      expect(result.applied).toBe(false);
      expect(result.score).toBe(mockUser.score);
      expect(mockRedis.setUserScore).not.toHaveBeenCalled();
    });

    it('should return applied: false when new score equals current score', async () => {
      mockRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder);
      mockQueryBuilder.execute.mockResolvedValue({ affected: 0, raw: [] });
      mockRepo.findOne.mockResolvedValue(mockUser);

      const result = await service.updateScore(mockUser.id, mockUser.score);

      expect(result.applied).toBe(false);
      expect(result.score).toBe(mockUser.score);
    });

    it('should sync updated score to Redis when applied', async () => {
      const updated = { ...mockUser, score: 2000 };
      mockRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder);
      mockQueryBuilder.execute.mockResolvedValue({ affected: 1, raw: [updated] });
      mockRedis.isConnected.mockReturnValue(true);

      await service.updateScore(mockUser.id, 2000);

      expect(mockRedis.setUserScore).toHaveBeenCalledWith(mockUser.id, 2000, updated.updatedAt);
    });
  });

  describe('findById', () => {
    it('should return the user when found', async () => {
      mockRepo.findOne.mockResolvedValue(mockUser);

      const result = await service.findById(mockUser.id);
      expect(result).toEqual(mockUser);
    });

    it('should throw NotFoundException when user does not exist', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(
        service.findById('non-existent-id'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
