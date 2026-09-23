import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { RedisCacheService } from '../cache/redis-cache.service';

@ApiTags('Health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redisCache: RedisCacheService,
  ) {}

  @Get('liveness')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiResponse({ status: 200, description: 'Service is alive' })
  liveness() {
    return { status: 'ok' };
  }

  @Get('readiness')
  @ApiOperation({ summary: 'Readiness probe — checks DB and Redis connectivity' })
  @ApiResponse({ status: 200, description: 'Service readiness status' })
  async readiness() {
    const dbReady = this.dataSource.isInitialized;
    const redisReady = this.redisCache.isConnected();
    const allReady = dbReady && redisReady;

    return {
      status: allReady ? 'ok' : 'degraded',
      database: dbReady ? 'connected' : 'disconnected',
      redis: redisReady ? 'connected' : 'disconnected',
    };
  }
}
