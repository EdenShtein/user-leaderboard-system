import { Controller, Post, Patch, Body, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateScoreDto } from './dto/update-score.dto';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Create a new user with a score' })
  @ApiResponse({ status: 201, description: 'User created successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Patch(':id/score')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: "Update a user's score" })
  @ApiParam({ name: 'id', description: 'User UUID', example: '550e8400-e29b-41d4-a716-446655440000' })
  @ApiResponse({ status: 200, description: 'Score updated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  updateScore(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateScoreDto,
  ) {
    return this.usersService.updateScore(id, dto.score);
  }
}
