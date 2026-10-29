import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CashMovementType, CashSessionStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class OpenSessionDto {
  @ApiProperty({ example: '500.00', description: 'Fondo con el que arranca el turno' })
  @IsNumberString()
  openingFloat!: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() terminalId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CreateMovementDto {
  @ApiProperty() @IsUUID() cashSessionId!: string;

  @ApiProperty({ enum: CashMovementType, example: CashMovementType.CASH_OUT })
  @IsEnum(CashMovementType)
  type!: CashMovementType;

  @ApiProperty({ example: '200.00' }) @IsNumberString() amount!: string;

  @ApiProperty({ description: 'Obligatorio: un movimiento sin motivo no es auditable' })
  @IsString() @MaxLength(300)
  reason!: string;
}

export class CloseSessionDto {
  @ApiProperty() @IsUUID() cashSessionId!: string;

  @ApiProperty({ example: '3250.50', description: 'Efectivo realmente contado' })
  @IsNumberString()
  countedCash!: string;

  @ApiPropertyOptional({ description: 'Obligatorio si hay diferencia' })
  @IsOptional() @IsString() @MaxLength(500)
  differenceReason?: string;

  @ApiPropertyOptional({ description: 'Desglose por denominación: { "500": 4, "200": 6 }' })
  @IsOptional() @IsObject()
  denominations?: Record<string, number>;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class ListSessionsDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;

  @ApiPropertyOptional({ enum: CashSessionStatus })
  @IsOptional() @IsEnum(CashSessionStatus)
  status?: CashSessionStatus;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;
}

export class CurrentSessionDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() terminalId?: string;
}
