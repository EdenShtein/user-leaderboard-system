import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { User } from '../users/user.entity';
import { randomUUID } from 'crypto';
import { Writable } from 'stream';
import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * Seed script for bulk-inserting users into PostgreSQL + warming Redis cache.
 *
 * Uses PostgreSQL COPY protocol for maximum throughput (~100k+ rows/sec).
 * For 10M users, expect ~2-3 minutes depending on hardware.
 * After seeding, populates Redis ZSET with all scores for immediate leaderboard use.
 *
 * Usage:
 *   npx ts-node src/database/seed.ts [count]
 *   npx ts-node src/database/seed.ts 10000000
 */

const TOTAL_USERS = parseInt(process.argv[2] || '1000000', 10);
const BATCH_LOG_INTERVAL = 100_000;

const FIRST_NAMES = [
  'Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Quinn',
  'Avery', 'Blake', 'Cameron', 'Dakota', 'Emery', 'Finley', 'Harper',
  'Kai', 'Logan', 'Max', 'Noah', 'Oakley', 'Parker', 'Reese', 'Sage',
  'Skyler', 'River', 'Rowan', 'Phoenix', 'Eden', 'Ari', 'Jaden',
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
  'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez',
  'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark',
  'Ramirez', 'Lewis', 'Robinson',
];

function randomName(): string {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${first} ${last}`;
}

function randomScore(): number {
  // Power-law distribution: most users have low scores, few have very high scores
  const base = Math.random();
  return Math.floor(Math.pow(base, 0.3) * 1_000_000);
}

async function seed() {
  console.log(`Seeding ${TOTAL_USERS.toLocaleString()} users...`);
  const startTime = Date.now();

  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USERNAME || 'leaderboard',
    password: process.env.DB_PASSWORD || 'leaderboard_secret',
    database: process.env.DB_NAME || 'leaderboard',
  });

  await client.connect();
  console.log('Connected to PostgreSQL');

  // Ensure the table exists (via TypeORM synchronize)
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'leaderboard',
    password: process.env.DB_PASSWORD || 'leaderboard_secret',
    database: process.env.DB_NAME || 'leaderboard',
    entities: [User],
    synchronize: true,
  });
  await ds.initialize();
  await ds.destroy();
  console.log('Schema synchronized');

  // Drop index before bulk insert for faster writes, recreate after
  await client.query('DROP INDEX IF EXISTS idx_users_score').catch(() => {});
  console.log('Dropped index for bulk insert');

  // Use COPY for maximum insert throughput
  const copyQuery = `COPY users (id, name, "imageUrl", score, "createdAt", "updatedAt") FROM STDIN WITH (FORMAT csv)`;

  await new Promise<void>((resolve, reject) => {
    const stream = client.query(require('pg-copy-streams').from(copyQuery));

    let count = 0;
    const baseTime = Date.now();

    function writeBatch(): boolean {
      let canContinue = true;
      while (canContinue && count < TOTAL_USERS) {
        const id = randomUUID();
        const name = randomName().replace(/,/g, ' ');
        const imageUrl = `https://api.dicebear.com/7.x/avataaars/svg?seed=${id}`;
        const score = randomScore();
        const ts = new Date(baseTime + count).toISOString(); // Unique timestamp per user (1ms apart)
        const line = `${id},${name},${imageUrl},${score},${ts},${ts}\n`;

        count++;
        canContinue = stream.write(line);

        if (count % BATCH_LOG_INTERVAL === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const rate = Math.round(count / ((Date.now() - startTime) / 1000));
          console.log(
            `  ${count.toLocaleString()} / ${TOTAL_USERS.toLocaleString()} users (${elapsed}s, ${rate.toLocaleString()}/sec)`,
          );
        }
      }

      if (count >= TOTAL_USERS) {
        stream.end();
      }
      return canContinue;
    }

    stream.on('error', reject);
    stream.on('finish', resolve);
    stream.on('drain', writeBatch);

    writeBatch();
  });

  const insertTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nInserted ${TOTAL_USERS.toLocaleString()} users in ${insertTime}s`);

  // Recreate the index
  console.log('Recreating index (this may take a moment)...');
  const indexStart = Date.now();
  await client.query(
    'CREATE INDEX idx_users_score ON users (score DESC, "updatedAt" ASC, id ASC)',
  );
  const indexTime = ((Date.now() - indexStart) / 1000).toFixed(1);
  console.log(`Index created in ${indexTime}s`);

  // Run ANALYZE for query planner
  await client.query('ANALYZE users');
  console.log('ANALYZE complete');

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone! Total time: ${totalTime}s`);

  // Quick stats
  const countResult = await client.query('SELECT COUNT(*) FROM users');
  const topResult = await client.query(
    'SELECT name, score FROM users ORDER BY score DESC LIMIT 5',
  );
  console.log(`\nTotal users in DB: ${Number(countResult.rows[0].count).toLocaleString()}`);
  console.log('Top 5 users:');
  topResult.rows.forEach((row: { name: string; score: string }, i: number) => {
    console.log(`  ${i + 1}. ${row.name} — ${Number(row.score).toLocaleString()} points`);
  });

  // ── Redis warm-up ────────────────────────────────────────────
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);

  console.log(`\nWarming Redis cache (${redisHost}:${redisPort})...`);
  const redis = new Redis({ host: redisHost, port: redisPort, lazyConnect: true });

  try {
    await redis.connect();
  } catch (err) {
    console.warn('Could not connect to Redis — skipping cache warm-up. Data is in PostgreSQL.');
    await client.end();
    process.exit(0);
  }

  const MAX_TS = 9999999999999;
  const LEADERBOARD_KEY = 'leaderboard:scores';
  const USER_MEMBERS_KEY = 'leaderboard:members';
  const USER_DATA_PREFIX = 'leaderboard:user:';
  const REDIS_BATCH = 5000;
  const USER_DATA_TTL = 86400;

  // Clear existing Redis leaderboard data
  await redis.del(LEADERBOARD_KEY);
  await redis.del(USER_MEMBERS_KEY);

  const redisStart = Date.now();
  let redisLoaded = 0;
  let pgOffset = 0;
  const totalUsers = Number(countResult.rows[0].count);

  while (pgOffset < totalUsers) {
    const rows = await client.query(
      `SELECT id, name, "imageUrl", score, "updatedAt" FROM users ORDER BY id ASC LIMIT $1 OFFSET $2`,
      [REDIS_BATCH, pgOffset],
    );

    if (rows.rows.length === 0) break;

    const pipeline = redis.pipeline();
    for (const row of rows.rows) {
      const ts = new Date(row.updatedAt).getTime();
      const inverted = String(MAX_TS - ts).padStart(13, '0');
      const member = `${inverted}:${row.id}`;

      pipeline.zadd(LEADERBOARD_KEY, Number(row.score), member);
      pipeline.hset(USER_MEMBERS_KEY, row.id, member);
      pipeline.hset(
        `${USER_DATA_PREFIX}${row.id}`,
        'name', row.name,
        'imageUrl', row.imageUrl || '',
      );
      pipeline.expire(`${USER_DATA_PREFIX}${row.id}`, USER_DATA_TTL);
    }
    await pipeline.exec();

    redisLoaded += rows.rows.length;
    pgOffset += REDIS_BATCH;

    if (redisLoaded % 100_000 === 0 || redisLoaded >= totalUsers) {
      const elapsed = ((Date.now() - redisStart) / 1000).toFixed(1);
      const rate = Math.round(redisLoaded / ((Date.now() - redisStart) / 1000));
      console.log(
        `  Redis: ${redisLoaded.toLocaleString()} / ${totalUsers.toLocaleString()} users (${elapsed}s, ${rate.toLocaleString()}/sec)`,
      );
    }
  }

  const redisTime = ((Date.now() - redisStart) / 1000).toFixed(1);
  console.log(`Redis warm-up complete: ${redisLoaded.toLocaleString()} users in ${redisTime}s`);

  const grandTotal = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nAll done! Total time: ${grandTotal}s (PG: ${totalTime}s, Redis: ${redisTime}s)`);

  await redis.quit();
  await client.end();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
