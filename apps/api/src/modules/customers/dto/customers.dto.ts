import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CustomerType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListCustomersDto {
  @ApiPropertyOptional({ description: 'Nombre, teléfono, correo, RFC o código' })
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @ApiPropertyOptional() @IsOptional() @Type(() => Boolean) @IsBoolean() includeInactive?: boolean;

  @ApiPropertyOptional({ description: 'Solo clientes que deben' })
  @IsOptional() @Type(() => Boolean) @IsBoolean() withBalance?: boolean;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}

export class UpsertCustomerDto {
  @ApiPropertyOptional({ enum: CustomerType }) @IsOptional() @IsEnum(CustomerType) type?: CustomerType;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) businessName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(12, 13) rfc?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) fiscalName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10) fiscalPostalCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() priceListId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() creditLimit?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) creditDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CustomerPaymentDto {
  @ApiProperty({ example: '500.00' }) @IsNumberString() amount!: string;
  @ApiProperty({ example: 'CASH' }) @IsString() @MaxLength(32) methodCode!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

export class StatementDto {
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}

export class SetPriceListItemDto {
  @ApiProperty() @IsUUID() variantId!: string;
  @ApiProperty({ example: '450.00' }) @IsNumberString() price!: string;
  @ApiPropertyOptional({ example: '1' }) @IsOptional() @IsNumberString() minQty?: string;
}
