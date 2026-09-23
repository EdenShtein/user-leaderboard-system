import { IsInt, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateScoreDto {
  @ApiProperty({ example: 2500, description: 'New score value', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  score!: number;
}
