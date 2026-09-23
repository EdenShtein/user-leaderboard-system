import { IsString, IsOptional, IsInt, Min, Max, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ example: 'Alice', description: 'Player display name', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  name!: string;

  // Note: Accepts any string, not validated as a URL. In production, add @IsUrl()
  // or validate at the API gateway layer to prevent XSS payloads.
  @ApiPropertyOptional({ example: 'https://example.com/avatar.png', description: 'Player avatar URL' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiProperty({ example: 1500, description: 'Initial score', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  score!: number;
}
