import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ACCESS_KEY_MESSAGE } from '@pv/shared-types';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** PIN de 4 a 12 dígitos, o contraseña de 8 a 200 caracteres. */
export const ACCESS_KEY_REGEX = /^(?:\d{4,12}|[\s\S]{8,200})$/;

export class LoginDto {
  @ApiProperty({ example: 'jesus', description: 'Usuario (no distingue mayúsculas)', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  username?: string;

  @ApiProperty({ required: false, description: 'Alternativa al usuario, por compatibilidad' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @ApiProperty({ example: '2580', description: 'PIN o contraseña' })
  @IsString()
  @IsNotEmpty({ message: 'Escribe tu PIN o contraseña' })
  @MaxLength(200)
  password!: string;
}

export class PinLoginDto {
  @ApiProperty({ description: 'Identificador de la terminal de caja' })
  @IsUUID('7', { message: 'La terminal no es válida' })
  terminalId!: string;

  @ApiProperty({ example: '1234', description: 'PIN de 4 a 8 dígitos' })
  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'El PIN debe tener entre 4 y 8 dígitos' })
  pin!: string;
}

export class AuthorizeDto {
  @ApiProperty()
  @IsUUID()
  branchId!: string;

  @ApiProperty({ example: '1234' })
  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'El PIN debe tener entre 4 y 8 dígitos' })
  pin!: string;

  @ApiProperty({ example: 'sale.discount.unlimited' })
  @IsString()
  @MaxLength(64)
  permission!: string;

  @ApiProperty({ example: 'Descuento del 25 % por producto con defecto' })
  @IsString()
  @MinLength(3, { message: 'Escribe el motivo de la autorización' })
  @MaxLength(500)
  reason!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @ApiProperty({ description: 'PIN de 4+ dígitos o contraseña de 8+ caracteres' })
  @IsString()
  @Matches(ACCESS_KEY_REGEX, { message: ACCESS_KEY_MESSAGE })
  newPassword!: string;
}

export class SetPinDto {
  @ApiProperty({ example: '1234' })
  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'El PIN debe tener entre 4 y 8 dígitos' })
  pin!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  userId?: string;
}
