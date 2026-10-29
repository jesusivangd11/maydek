import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReturnType, StockCondition } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReturnItemDto {
  @ApiProperty({ description: 'Renglón de la venta original' })
  @IsUUID()
  saleItemId!: string;

  @ApiProperty({ example: '1' })
  @IsNumberString()
  qty!: string;

  @ApiPropertyOptional({ enum: StockCondition, default: StockCondition.GOOD })
  @IsOptional() @IsEnum(StockCondition)
  condition?: StockCondition;
}

export class CreateReturnDto {
  @ApiProperty() @IsUUID() saleId!: string;

  @ApiProperty({ type: [ReturnItemDto] })
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ReturnItemDto)
  items!: ReturnItemDto[];

  @ApiProperty({ enum: [ReturnType.REFUND, ReturnType.STORE_CREDIT] })
  @IsEnum(ReturnType)
  type!: ReturnType;

  @ApiPropertyOptional({ example: 'CASH', description: 'Forma de reembolso (REFUND)' })
  @IsOptional() @IsString() @MaxLength(32)
  refundMethodCode?: string;

  @ApiProperty({ example: 'TALLA_INCORRECTA' })
  @IsString() @MaxLength(48)
  reasonCode!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;

  @ApiPropertyOptional({ description: 'PIN de supervisor si la devolución sale de la política' })
  @IsOptional() @IsString() @MaxLength(8)
  supervisorPin?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) idempotencyKey?: string;
}

export class ListReturnsDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() saleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}
