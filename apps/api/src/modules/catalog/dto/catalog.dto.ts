import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class PosSearchDto {
  @ApiPropertyOptional({ description: 'Código de barras, SKU o nombre' })
  @IsOptional() @IsString() @MaxLength(100)
  q?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;

  @ApiPropertyOptional({ description: 'Precios con la lista del cliente (mayoreo…)' })
  @IsOptional() @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  limit?: number;
}

export class ListProductsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional() @Type(() => Boolean) @IsBoolean()
  includeInactive?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsUUID() cursor?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}

export class ProductVariantDto {
  @ApiProperty() @IsString() @Length(1, 64) sku!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) nameSuffix?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() basePrice?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() minStock?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) barcode?: string;
}

export class CreateProductDto {
  @ApiProperty() @IsString() @Length(2, 200) name!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) description?: string;

  @ApiPropertyOptional({ description: 'SKU del producto simple (sin variantes)' })
  @IsOptional() @IsString() @Length(1, 64)
  sku?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() basePrice?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() minStock?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() brandId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() unitId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() taxRateId?: string;

  @ApiPropertyOptional({ description: 'false para servicios: no mueven inventario' })
  @IsOptional() @IsBoolean()
  trackStock?: boolean;

  @ApiPropertyOptional({ type: [ProductVariantDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ProductVariantDto)
  variants?: ProductVariantDto[];
}

export class UpdateProductDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() brandId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() unitId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() taxRateId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() trackStock?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() basePrice?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() minStock?: string;
}

export class UpdateVariantDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) nameSuffix?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() basePrice?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() minStock?: string;
  @ApiPropertyOptional({ description: 'Reemplaza el código de barras principal' })
  @IsOptional() @IsString() @MaxLength(64)
  barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateCategoryDto {
  @ApiProperty() @IsString() @Length(2, 120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() position?: number;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() position?: number;
}
