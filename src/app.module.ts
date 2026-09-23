import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { HealthController } from './health/health.controller';
import { UsersModule } from './users/users.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { CacheModule } from './cache/cache.module';
import { CacheWarmerService } from './cache/cache-warmer.service';
import { User } from './users/user.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get('DB_USERNAME', 'leaderboard'),
        password: config.get('DB_PASSWORD', 'leaderboard_secret'),
        database: config.get('DB_NAME', 'leaderboard'),
        entities: [User],
        synchronize: config.get('NODE_ENV') !== 'production',
        migrationsRun: config.get('NODE_ENV') === 'production',
        migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
      }),
    }),
    TypeOrmModule.forFeature([User]),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 100 }],
    }),
    CacheModule,
    UsersModule,
    LeaderboardModule,
  ],
  controllers: [HealthController],
  providers: [
    CacheWarmerService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
