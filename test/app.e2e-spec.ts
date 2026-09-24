import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

let app: INestApplication;

/**
 * E2E tests for the Leaderboard API.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run with:
 *   DB_HOST=localhost DB_PORT=5433 DB_USERNAME=test DB_PASSWORD=test DB_NAME=leaderboard_test \
 *   REDIS_HOST=localhost REDIS_PORT=6380 REDIS_WARM_ON_START=false \
 *   npx vitest run --config vitest.e2e.config.ts
 */

beforeAll(async () => {
  process.env.DB_HOST = process.env.DB_HOST || 'localhost';
  process.env.DB_PORT = process.env.DB_PORT || '5433';
  process.env.DB_USERNAME = process.env.DB_USERNAME || 'test';
  process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
  process.env.DB_NAME = process.env.DB_NAME || 'leaderboard_test';
  process.env.REDIS_HOST = process.env.REDIS_HOST || 'localhost';
  process.env.REDIS_PORT = process.env.REDIS_PORT || '6380';
  process.env.REDIS_WARM_ON_START = 'false';

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  await app.init();
}, 30000);

afterAll(async () => {
  await app?.close();
});

describe('Users API (e2e)', () => {
  let userId: string;

  it('POST /api/users — should create a user', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/users')
      .send({ name: 'TestUser', score: 5000 })
      .expect(201);

    expect(res.body).toHaveProperty('id');
    expect(res.body.name).toBe('TestUser');
    expect(Number(res.body.score)).toBe(5000);
    userId = res.body.id;
  });

  it('POST /api/users — should reject invalid payload', async () => {
    await request(app.getHttpServer())
      .post('/api/users')
      .send({ name: '', score: -1 })
      .expect(400);
  });

  it('POST /api/users — should reject missing name', async () => {
    await request(app.getHttpServer())
      .post('/api/users')
      .send({ score: 100 })
      .expect(400);
  });

  it('PATCH /api/users/:id/score — should update score and return applied: true', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/users/${userId}/score`)
      .send({ score: 9999 })
      .expect(200);

    expect(Number(res.body.score)).toBe(9999);
    expect(res.body.applied).toBe(true);
  });

  it('PATCH /api/users/:id/score — should return applied: false for lower score', async () => {
    // userId currently has score 9999 from the previous test
    const res = await request(app.getHttpServer())
      .patch(`/api/users/${userId}/score`)
      .send({ score: 100 })
      .expect(200);

    expect(res.body.applied).toBe(false);
    expect(Number(res.body.score)).toBe(9999);
  });

  it('PATCH /api/users/:id/score — should return applied: false for equal score', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/users/${userId}/score`)
      .send({ score: 9999 })
      .expect(200);

    expect(res.body.applied).toBe(false);
    expect(Number(res.body.score)).toBe(9999);
  });

  it('PATCH /api/users/:id/score — should reject negative score', async () => {
    await request(app.getHttpServer())
      .patch(`/api/users/${userId}/score`)
      .send({ score: -10 })
      .expect(400);
  });

  it('PATCH /api/users/:id/score — should 404 for missing user', async () => {
    await request(app.getHttpServer())
      .patch('/api/users/00000000-0000-0000-0000-000000000000/score')
      .send({ score: 100 })
      .expect(404);
  });

  it('PATCH /api/users/:id/score — should 400 for invalid UUID', async () => {
    await request(app.getHttpServer())
      .patch('/api/users/not-a-uuid/score')
      .send({ score: 100 })
      .expect(400);
  });
});

describe('Leaderboard API (e2e)', () => {
  const userIds: string[] = [];

  beforeAll(async () => {
    // Create 10 users with different scores
    for (let i = 0; i < 10; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/users')
        .send({ name: `Player${i}`, score: (i + 1) * 1000 });
      userIds.push(res.body.id);
    }
  });

  it('GET /api/leaderboard/top — should return top users in descending score order', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/leaderboard/top?limit=5')
      .expect(200);

    expect(res.body.length).toBeGreaterThanOrEqual(5);
    // Verify descending order
    for (let i = 1; i < res.body.length; i++) {
      expect(res.body[i - 1].score).toBeGreaterThanOrEqual(res.body[i].score);
    }
    // Verify rank is present and sequential
    expect(res.body[0].rank).toBe(1);
  });

  it('GET /api/leaderboard/top — should support pagination with offset', async () => {
    const page1 = await request(app.getHttpServer())
      .get('/api/leaderboard/top?limit=3&offset=0')
      .expect(200);

    const page2 = await request(app.getHttpServer())
      .get('/api/leaderboard/top?limit=3&offset=3')
      .expect(200);

    expect(page1.body.length).toBe(3);
    expect(page2.body.length).toBe(3);

    // Pages should not overlap
    const page1Ids = page1.body.map((u: { id: string }) => u.id);
    const page2Ids = page2.body.map((u: { id: string }) => u.id);
    for (const id of page2Ids) {
      expect(page1Ids).not.toContain(id);
    }

    // Page 2 ranks should continue from page 1
    expect(page2.body[0].rank).toBe(page1.body[2].rank + 1);
  });

  it('GET /api/leaderboard/top — should default to limit=10', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/leaderboard/top')
      .expect(200);

    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body.length).toBeLessThanOrEqual(10);
  });

  it('GET /api/leaderboard/user/:id — should return user position and surrounding', async () => {
    // Use a middle user
    const middleUserId = userIds[5];

    const res = await request(app.getHttpServer())
      .get(`/api/leaderboard/user/${middleUserId}`)
      .expect(200);

    expect(res.body).toHaveProperty('user');
    expect(res.body).toHaveProperty('surrounding');
    expect(res.body.user.id).toBe(middleUserId);
    expect(res.body.user).toHaveProperty('rank');
    expect(res.body.surrounding.length).toBeGreaterThan(0);
  });

  it('GET /api/leaderboard/user/:id — should 404 for missing user', async () => {
    await request(app.getHttpServer())
      .get('/api/leaderboard/user/00000000-0000-0000-0000-000000000000')
      .expect(404);
  });

  it('should order tied scores by FIFO (first to reach the score ranks higher)', async () => {
    // Create first user with score 77777
    const first = await request(app.getHttpServer())
      .post('/api/users')
      .send({ name: 'FirstToScore', score: 77777 })
      .expect(201);

    // Small delay to ensure different updatedAt timestamps
    await new Promise((r) => setTimeout(r, 50));

    // Create second user with same score
    const second = await request(app.getHttpServer())
      .post('/api/users')
      .send({ name: 'SecondToScore', score: 77777 })
      .expect(201);

    // Get leaderboard — FirstToScore should rank higher (earlier updatedAt)
    const res = await request(app.getHttpServer())
      .get('/api/leaderboard/top?limit=100')
      .expect(200);

    const firstIdx = res.body.findIndex((u: { id: string }) => u.id === first.body.id);
    const secondIdx = res.body.findIndex((u: { id: string }) => u.id === second.body.id);

    expect(firstIdx).toBeLessThan(secondIdx);
    expect(res.body[firstIdx].rank).toBeLessThan(res.body[secondIdx].rank);
  });
});

describe('Health API (e2e)', () => {
  it('GET /api/health/liveness — should return ok', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health/liveness')
      .expect(200);

    expect(res.body.status).toBe('ok');
  });

  it('GET /api/health/readiness — should return status with db and redis', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health/readiness')
      .expect(200);

    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('database');
    expect(res.body).toHaveProperty('redis');
  });
});
