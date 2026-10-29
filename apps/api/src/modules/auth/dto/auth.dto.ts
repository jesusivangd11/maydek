import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'admin@distribuidora.local' })
  @IsEmail({}, { message: 'El correo no tiene un formato válido' })
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: 'Admin.Cambiar123' })
  @IsString()
  @IsNotEmpty({ message: 'La contraseña es obligatoria' })
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

  @ApiProperty({ description: 'Mínimo 10 caracteres' })
  @IsString()
  @Length(10, 200, { message: 'La contraseña nueva debe tener al menos 10 caracteres' })
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
