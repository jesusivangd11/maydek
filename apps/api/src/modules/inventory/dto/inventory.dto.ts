import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
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

export class ListStockDto {
  @ApiPropertyOptional({ description: 'SKU, nombre o código de barras' })
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;

  @ApiPropertyOptional({ description: 'Solo artículos bajo su mínimo' })
  @IsOptional() @Type(() => Boolean) @IsBoolean()
  onlyLow?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional() @Type(() => Boolean) @IsBoolean()
  onlyActive?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsUUID() cursor?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}

export class KardexDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  limit?: number;
}

export class AdjustStockLineDto {
  @ApiProperty() @IsUUID() variantId!: string;

  @ApiProperty({ example: '12.000', description: 'Cantidad REAL contada, no la diferencia' })
  @IsNumberString()
  countedQty!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

export class AdjustStockDto {
  @ApiProperty({ type: [AdjustStockLineDto] })
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => AdjustStockLineDto)
  lines!: AdjustStockLineDto[];

  @ApiProperty({ example: 'CONTEO_FISICO', description: 'Motivo: obligatorio y auditado' })
  @IsString() @MaxLength(48)
  reasonCode!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
}
