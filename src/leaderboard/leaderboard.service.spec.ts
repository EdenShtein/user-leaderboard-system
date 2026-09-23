import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { RedisCacheService } from '../cache/redis-cache.service';

describe('LeaderboardService', () => {
  let service: LeaderboardService;

  const now = new Date();
  const earlier = new Date(now.getTime() - 60000); // 1 minute ago
  const latest = new Date(now.getTime() + 60000); // 1 minute later

  const mockUsers: User[] = [
    { id: 'aaa', name: 'Alice', imageUrl: null, score: 5000, createdAt: earlier, updatedAt: earlier },
    { id: 'bbb', name: 'Bob', imageUrl: null, score: 3000, createdAt: now, updatedAt: now },
    { id: 'ccc', name: 'Charlie', imageUrl: null, score: 1000, createdAt: latest, updatedAt: latest },
  ];

  const mockQueryBuilder = {
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orWhere: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    addOrderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    getRawMany: vi.fn(),
    getRawOne: vi.fn(),
  };

  const mockRepo = {
    createQueryBuilder: vi.fn().mockReturnValue(mockQueryBuilder),
  };

  const mockUsersService = {
    findById: vi.fn(),
  };

  const mockRedis = {
    isConnected: vi.fn().mockReturnValue(false),
    getTopUsers: vi.fn(),
    getUserDataBatch: vi.fn(),
    getUserRank: vi.fn(),
    getUserScore: vi.fn(),
    getSurroundingUsers: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeaderboardService,
        { provide: getRepositoryToken(User), useValue: mockRepo },
        { provide: UsersService, useValue: mockUsersService },
        { provide: RedisCacheService, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<LeaderboardService>(LeaderboardService);
    vi.clearAllMocks();
    mockRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder);
    Object.values(mockQueryBuilder).forEach((fn) => {
      if (fn.mockReturnThis) fn.mockReturnThis();
    });
    mockRedis.isConnected.mockReturnValue(false);
  });

  describe('getTopUsers (DB fallback)', () => {
    it('should return top N users with correct ranks', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { id: 'aaa', name: 'Alice', imageUrl: null, score: '5000', rank: '1' },
        { id: 'bbb', name: 'Bob', imageUrl: null, score: '3000', rank: '2' },
        { id: 'ccc', name: 'Charlie', imageUrl: null, score: '1000', rank: '3' },
      ]);

      const result = await service.getTopUsers(3, 0);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ rank: 1, id: 'aaa', name: 'Alice', imageUrl: null, score: 5000 });
      expect(result[2]).toEqual({ rank: 3, id: 'ccc', name: 'Charlie', imageUrl: null, score: 1000 });
    });

    it('should return empty array when no users exist', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.getTopUsers(10, 0);
      expect(result).toEqual([]);
    });

    it('should convert string scores to numbers (bigint handling)', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { id: 'aaa', name: 'Alice', imageUrl: null, score: '9999999999', rank: '1' },
      ]);

      const result = await service.getTopUsers(1, 0);
      expect(result[0].score).toBe(9999999999);
      expect(typeof result[0].score).toBe('number');
    });

    it('should apply offset to rank calculation', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { id: 'ddd', name: 'Dave', imageUrl: null, score: '2000', rank: '1' },
        { id: 'eee', name: 'Eve', imageUrl: null, score: '1500', rank: '2' },
      ]);

      const result = await service.getTopUsers(2, 10);

      expect(result[0].rank).toBe(11);
      expect(result[1].rank).toBe(12);
    });
  });

  describe('getUserWithSurrounding (DB fallback)', () => {
    it('should return user rank and surrounding users', async () => {
      mockUsersService.findById.mockResolvedValue(mockUsers[1]); // Bob, score 3000

      mockQueryBuilder.getRawOne.mockResolvedValue({ count: '1' });
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { id: 'aaa', name: 'Alice', imageUrl: null, score: '5000', rank: '1' },
        { id: 'bbb', name: 'Bob', imageUrl: null, score: '3000', rank: '2' },
        { id: 'ccc', name: 'Charlie', imageUrl: null, score: '1000', rank: '3' },
      ]);

      const result = await service.getUserWithSurrounding('bbb');

      expect(result.user.id).toBe('bbb');
      expect(result.user.rank).toBe(2);
      expect(result.surrounding).toHaveLength(3);
    });

    it('should throw NotFoundException for non-existent user', async () => {
      mockUsersService.findById.mockRejectedValue(
        new NotFoundException('User not-exist not found'),
      );

      await expect(
        service.getUserWithSurrounding('not-exist'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should handle user at rank 1 (no users above)', async () => {
      mockUsersService.findById.mockResolvedValue(mockUsers[0]); // Alice, rank 1

      mockQueryBuilder.getRawOne.mockResolvedValue({ count: '0' });
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { id: 'aaa', name: 'Alice', imageUrl: null, score: '5000', rank: '1' },
        { id: 'bbb', name: 'Bob', imageUrl: null, score: '3000', rank: '2' },
        { id: 'ccc', name: 'Charlie', imageUrl: null, score: '1000', rank: '3' },
      ]);

      const result = await service.getUserWithSurrounding('aaa');

      expect(result.user.rank).toBe(1);
      expect(result.surrounding[0].rank).toBe(1);
    });

    it('should handle tied scores with FIFO ordering (updatedAt tiebreaker)', async () => {
      // Bob has same score as Alice but updated later → ranks lower
      mockUsersService.findById.mockResolvedValue({
        ...mockUsers[1],
        score: 5000,
        updatedAt: now, // Bob updated at 'now'
      });

      // Alice updated earlier, so she ranks #1 (FIFO)
      mockQueryBuilder.getRawOne.mockResolvedValue({ count: '1' });
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { id: 'aaa', name: 'Alice', imageUrl: null, score: '5000', rank: '1' }, // earlier updatedAt
        { id: 'bbb', name: 'Bob', imageUrl: null, score: '5000', rank: '2' },   // later updatedAt
      ]);

      const result = await service.getUserWithSurrounding('bbb');

      expect(result.user.rank).toBe(2);
      expect(result.surrounding[0].id).toBe('aaa'); // Alice first (FIFO)
      expect(result.surrounding[1].id).toBe('bbb'); // Bob second
    });

    it('should handle user at bottom of leaderboard (fewer than 5 below)', async () => {
      // Charlie is last (rank 3 of 3) — only 2 users above, 0 below
      mockUsersService.findById.mockResolvedValue(mockUsers[2]);

      mockQueryBuilder.getRawOne.mockResolvedValue({ count: '2' });
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { id: 'aaa', name: 'Alice', imageUrl: null, score: '5000', rank: '1' },
        { id: 'bbb', name: 'Bob', imageUrl: null, score: '3000', rank: '2' },
        { id: 'ccc', name: 'Charlie', imageUrl: null, score: '1000', rank: '3' },
      ]);

      const result = await service.getUserWithSurrounding('ccc');

      expect(result.user.id).toBe('ccc');
      expect(result.user.rank).toBe(3);
      expect(result.surrounding).toHaveLength(3); // Only 3 total, not 11
    });

    it('should handle score of 0', async () => {
      const zeroUser = { ...mockUsers[2], score: 0 };
      mockUsersService.findById.mockResolvedValue(zeroUser);

      // Only user with score 0 → rank is count(higher) + 1 = 2 + 1 = 3
      mockQueryBuilder.getRawOne.mockResolvedValue({ count: '2' });
      // Surrounding window starting from offset 0 (rank 3 - 6 clamped to 0)
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { id: 'aaa', name: 'Alice', imageUrl: null, score: '5000', rank: '1' },
        { id: 'bbb', name: 'Bob', imageUrl: null, score: '3000', rank: '2' },
        { id: 'ccc', name: 'Charlie', imageUrl: null, score: '0', rank: '3' },
      ]);

      const result = await service.getUserWithSurrounding('ccc');

      expect(result.user.score).toBe(0);
      expect(result.user.rank).toBe(3);
    });
  });

  describe('getTopUsers (Redis)', () => {
    it('should use Redis when connected', async () => {
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.getTopUsers.mockResolvedValue([
        { id: 'aaa', score: 5000, rank: 1 },
        { id: 'bbb', score: 3000, rank: 2 },
      ]);
      mockRedis.getUserDataBatch.mockResolvedValue(
        new Map([
          ['aaa', { name: 'Alice', imageUrl: null }],
          ['bbb', { name: 'Bob', imageUrl: null }],
        ]),
      );

      const result = await service.getTopUsers(2, 0);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ rank: 1, id: 'aaa', name: 'Alice', imageUrl: null, score: 5000 });
      expect(mockRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should fall back to DB when Redis fails', async () => {
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.getTopUsers.mockRejectedValue(new Error('Redis error'));
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { id: 'aaa', name: 'Alice', imageUrl: null, score: '5000', rank: '1' },
      ]);

      const result = await service.getTopUsers(1, 0);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Alice');
    });

    it('should show "Unknown" for users missing from Redis user data', async () => {
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.getTopUsers.mockResolvedValue([
        { id: 'aaa', score: 5000, rank: 1 },
      ]);
      mockRedis.getUserDataBatch.mockResolvedValue(new Map());

      const result = await service.getTopUsers(1, 0);

      expect(result[0].name).toBe('Unknown');
    });
  });

  describe('getUserWithSurrounding (Redis)', () => {
    it('should use Redis when connected and user exists in cache', async () => {
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.getUserRank.mockResolvedValue(5);
      mockRedis.getSurroundingUsers.mockResolvedValue([
        { id: 'u3', score: 6000, rank: 3 },
        { id: 'u4', score: 5500, rank: 4 },
        { id: 'target', score: 5000, rank: 5 },
        { id: 'u6', score: 4500, rank: 6 },
        { id: 'u7', score: 4000, rank: 7 },
      ]);
      mockRedis.getUserDataBatch.mockResolvedValue(
        new Map([
          ['u3', { name: 'User3', imageUrl: null }],
          ['u4', { name: 'User4', imageUrl: null }],
          ['target', { name: 'Target', imageUrl: null }],
          ['u6', { name: 'User6', imageUrl: null }],
          ['u7', { name: 'User7', imageUrl: null }],
        ]),
      );

      const result = await service.getUserWithSurrounding('target');

      expect(result.user.id).toBe('target');
      expect(result.user.rank).toBe(5);
      expect(result.surrounding).toHaveLength(5);
      expect(mockRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should fall back to DB when user not in Redis', async () => {
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.getUserRank.mockResolvedValue(null);

      mockUsersService.findById.mockResolvedValue(mockUsers[0]);
      mockQueryBuilder.getRawOne.mockResolvedValue({ count: '0' });
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { id: 'aaa', name: 'Alice', imageUrl: null, score: '5000', rank: '1' },
      ]);

      const result = await service.getUserWithSurrounding('aaa');

      expect(result.user.id).toBe('aaa');
    });
  });
});
