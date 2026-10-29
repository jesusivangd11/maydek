import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PurchaseOrderStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
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
  ValidateNested,
} from 'class-validator';

export class UpsertSupplierDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 200) businessName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) tradeName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(12, 13) rfc?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) paymentTerms?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) leadTimeDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class PurchaseLineDto {
  @ApiProperty() @IsUUID() variantId!: string;
  @ApiProperty({ example: '10' }) @IsNumberString() qty!: string;
  @ApiProperty({ example: '120.50', description: 'Costo unitario antes de impuestos' })
  @IsNumberString()
  unitCost!: string;
}

export class CreatePurchaseOrderDto {
  @ApiProperty() @IsUUID() supplierId!: string;

  @ApiProperty({ type: [PurchaseLineDto] })
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => PurchaseLineDto)
  items!: PurchaseLineDto[];

  @ApiPropertyOptional() @IsOptional() @IsISO8601() expectedDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() shippingCost?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class ReceiveLineDto {
  @ApiProperty() @IsUUID() variantId!: string;
  @ApiProperty({ example: '8' }) @IsNumberString() qty!: string;
  @ApiPropertyOptional({ description: 'Si el proveedor facturó a otro costo' })
  @IsOptional() @IsNumberString()
  unitCost?: string;
}

export class CreateReceiptDto {
  @ApiPropertyOptional({ description: 'Orden que se recibe. Sin ella es recepción directa.' })
  @IsOptional() @IsUUID()
  purchaseOrderId?: string;

  @ApiPropertyOptional({ description: 'Obligatorio en recepción directa' })
  @IsOptional() @IsUUID()
  supplierId?: string;

  @ApiProperty({ type: [ReceiveLineDto] })
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ReceiveLineDto)
  items!: ReceiveLineDto[];

  @ApiPropertyOptional({ description: 'Flete y otros costos a prorratear por valor' })
  @IsOptional() @IsNumberString()
  freightCost?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) supplierInvoiceNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class ListPurchaseOrdersDto {
  @ApiPropertyOptional({ enum: PurchaseOrderStatus })
  @IsOptional() @IsEnum(PurchaseOrderStatus)
  status?: PurchaseOrderStatus;

  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}
