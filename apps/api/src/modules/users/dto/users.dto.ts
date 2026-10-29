import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListUsersDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ enum: UserStatus }) @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() cursor?: string;
  @ApiPropertyOptional({ default: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}

export class CreateUserDto {
  @ApiProperty() @IsEmail({}, { message: 'El correo no tiene un formato válido' }) @MaxLength(255)
  email!: string;

  @ApiProperty() @IsString() @Length(2, 120) name!: string;

  @ApiProperty({ description: 'Mínimo 10 caracteres' })
  @IsString() @Length(10, 200, { message: 'La contraseña debe tener al menos 10 caracteres' })
  password!: string;

  @ApiPropertyOptional({ description: 'PIN de 4 a 8 dígitos para el POS' })
  @IsOptional() @IsString() @Matches(/^\d{4,8}$/, { message: 'El PIN debe tener entre 4 y 8 dígitos' })
  pin?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) phone?: string;

  @ApiProperty({ example: ['CASHIER'], description: 'Códigos de rol' })
  @IsArray() @ArrayNotEmpty({ message: 'El usuario debe tener al menos un rol' })
  @IsString({ each: true })
  roleCodes!: string[];

  @ApiPropertyOptional({ description: 'Sucursales a las que tiene acceso' })
  @IsOptional() @IsArray() @IsUUID(undefined, { each: true })
  branchIds?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  mustChangePassword?: boolean;
}

export class UpdateUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @ApiPropertyOptional({ enum: UserStatus }) @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
}

export class UpdateUserRolesDto {
  @ApiProperty({ example: ['CASHIER', 'WAREHOUSE'] })
  @IsArray() @ArrayNotEmpty({ message: 'El usuario debe conservar al menos un rol' })
  @IsString({ each: true })
  roleCodes!: string[];
}
