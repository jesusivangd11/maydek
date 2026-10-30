import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ACCESS_KEY_MESSAGE, USERNAME_MESSAGE, USERNAME_PATTERN } from '@pv/shared-types';
import { ACCESS_KEY_REGEX } from '../../auth/dto/auth.dto';
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

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class CreateUserDto {
  @ApiProperty({ example: 'carla', description: 'Con lo que entra; no distingue mayúsculas' })
  @Transform(lower)
  @Matches(USERNAME_PATTERN, { message: USERNAME_MESSAGE })
  username!: string;

  @ApiPropertyOptional({ description: 'Correo de contacto (opcional)' })
  @IsOptional() @IsEmail({}, { message: 'El correo no tiene un formato válido' }) @MaxLength(255)
  email?: string;

  @ApiProperty() @IsString() @Length(2, 120) name!: string;

  @ApiProperty({ description: 'Clave de acceso: PIN de 4+ dígitos o contraseña de 8+ caracteres' })
  @IsString() @Matches(ACCESS_KEY_REGEX, { message: ACCESS_KEY_MESSAGE })
  password!: string;

  @ApiPropertyOptional({ description: 'PIN de supervisor, 4 a 8 dígitos, para autorizar descuentos y cancelaciones' })
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

  @ApiPropertyOptional({ description: 'Clave nueva (PIN de 4+ dígitos o contraseña de 8+ caracteres)' })
  @IsOptional() @IsString() @Matches(ACCESS_KEY_REGEX, { message: ACCESS_KEY_MESSAGE })
  password?: string;

  @ApiPropertyOptional({ description: 'Correo de contacto' })
  @IsOptional() @IsEmail({}, { message: 'El correo no tiene un formato válido' }) @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ description: 'PIN nuevo de 4 a 8 dígitos' })
  @IsOptional() @IsString() @Matches(/^\d{4,8}$/, { message: 'El PIN debe tener entre 4 y 8 dígitos' })
  pin?: string;
}

export class UpdateUserPermissionsDto {
  @ApiProperty({
    example: ['sale.create', 'sale.discount.apply'],
    description: 'Permisos EFECTIVOS que debe tener la persona; las diferencias con su rol se guardan como excepciones',
  })
  @IsArray() @IsString({ each: true })
  permissions!: string[];
}

export class UpdateUserRolesDto {
  @ApiProperty({ example: ['CASHIER', 'WAREHOUSE'] })
  @IsArray() @ArrayNotEmpty({ message: 'El usuario debe conservar al menos un rol' })
  @IsString({ each: true })
  roleCodes!: string[];
}
