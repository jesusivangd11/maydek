import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SaleStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * El dinero y las cantidades viajan como STRING.
 *
 * Un `number` en JSON es un float de doble precisión: 0.1 + 0.2 deja de ser
 * 0.3 y el ticket sale descuadrado por un centavo. Como string llega intacto
 * hasta `Decimal`.
 */

export class SaleItemDto {
  @ApiProperty() @IsUUID() variantId!: string;

  @ApiProperty({ example: '1.000', description: 'Cantidad, hasta 3 decimales' })
  @IsNumberString({ no_symbols: false })
  qty!: string;

  @ApiPropertyOptional({ description: 'Precio manual. Exige sale.price_override' })
  @IsOptional() @IsNumberString()
  unitPrice?: string;

  @ApiPropertyOptional({ description: 'Descuento por importe' })
  @IsOptional() @IsNumberString()
  discountAmount?: string;

  @ApiPropertyOptional({ description: 'Descuento en fracción: 0.10 = 10 %' })
  @IsOptional() @IsNumberString()
  discountPercent?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200)
  discountReason?: string;
}

export class SalePaymentDto {
  @ApiProperty({ example: 'CASH', description: 'Código de la forma de pago' })
  @IsString() @MaxLength(32)
  methodCode!: string;

  @ApiProperty({ example: '150.00', description: 'Importe APLICADO a la venta' })
  @IsNumberString()
  amount!: string;

  @ApiPropertyOptional({ description: 'Autorización de tarjeta, folio de transferencia…' })
  @IsOptional() @IsString() @MaxLength(120)
  reference?: string;
}

export class CreateSaleDto {
  @ApiProperty({ type: [SaleItemDto] })
  @IsArray() @ArrayNotEmpty({ message: 'La venta necesita al menos un artículo' })
  @ValidateNested({ each: true }) @Type(() => SaleItemDto)
  items!: SaleItemDto[];

  @ApiProperty({ type: [SalePaymentDto] })
  @IsArray() @ArrayNotEmpty({ message: 'La venta necesita al menos una forma de pago' })
  @ValidateNested({ each: true }) @Type(() => SalePaymentDto)
  payments!: SalePaymentDto[];

  @ApiPropertyOptional({
    description: 'Efectivo que entregó el cliente. Con esto se calcula el cambio.',
  })
  @IsOptional() @IsNumberString()
  cashReceived?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() terminalId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;

  @ApiPropertyOptional({
    description:
      'Clave del ticket generada por el POS. Reintentar con la misma clave devuelve la venta original en vez de cobrar dos veces.',
  })
  @IsOptional() @IsString() @MaxLength(64)
  idempotencyKey?: string;

  @ApiPropertyOptional({ description: 'Vender bajo cero. Exige inventory.allow_negative' })
  @IsOptional() @IsBoolean()
  allowNegativeStock?: boolean;
}

export class CancelSaleDto {
  @ApiProperty({ example: 'El cliente se arrepintió antes de salir' })
  @IsString() @MaxLength(300)
  reason!: string;

  @ApiPropertyOptional({ description: 'PIN de un supervisor con sale.cancel' })
  @IsOptional() @IsString() @MaxLength(8)
  supervisorPin?: string;
}

export class HoldSaleDto {
  @ApiPropertyOptional({ example: 'Señora del vestido azul' })
  @IsOptional() @IsString() @MaxLength(80)
  label?: string;

  @ApiProperty({ description: 'El carrito tal como lo tiene el POS' })
  @IsObject()
  cart!: Record<string, unknown>;
}

export class ListSalesDto {
  @ApiPropertyOptional({ description: 'Folio o fragmento' })
  @IsOptional() @IsString() @MaxLength(60)
  search?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;

  @ApiPropertyOptional({ enum: SaleStatus })
  @IsOptional() @IsEnum(SaleStatus)
  status?: SaleStatus;

  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z' })
  @IsOptional() @IsISO8601()
  from?: string;

  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() cursor?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}
