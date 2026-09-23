import { Controller, Get, Param, Query, ParseUUIDPipe, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { LeaderboardService } from './leaderboard.service';

@ApiTags('Leaderboard')
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  @Get('top')
  @ApiOperation({ summary: 'Get top N users on the leaderboard' })
  @ApiQuery({ name: 'limit', required: false, description: 'Number of users to return (default 10, max 100)', example: 10 })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of users to skip (default 0, max 10000, for pagination)', example: 0 })
  @ApiResponse({ status: 200, description: 'List of top ranked users' })
  getTopUsers(
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.leaderboardService.getTopUsers(
      Math.min(Math.max(limit, 1), 100),
      Math.min(Math.max(offset, 0), 10000),
    );
  }

  @Get('user/:id')
  @ApiOperation({ summary: "Get a user's position with 5 users above and below" })
  @ApiParam({ name: 'id', description: 'User UUID', example: '550e8400-e29b-41d4-a716-446655440000' })
  @ApiResponse({ status: 200, description: 'User rank and surrounding players' })
  @ApiResponse({ status: 404, description: 'User not found' })
  getUserPosition(@Param('id', ParseUUIDPipe) id: string) {
    return this.leaderboardService.getUserWithSurrounding(id);
  }
}
