import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import {
  CreateUserDto,
  ListUsersDto,
  UpdateUserDto,
  UpdateUserPermissionsDto,
  UpdateUserRolesDto,
} from './dto/users.dto';
import { UsersService } from './users.service';

/**
 * Usuarios y roles.
 *
 * Cada endpoint declara el permiso que exige. El `PermissionsGuard` lo verifica
 * contra los permisos efectivos del usuario, resueltos en la base en cada
 * petición. Ocultar el menú en el panel no protege nada: esto sí.
 */
@ApiTags('Usuarios')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission(PERMISSIONS.USER_VIEW)
  @ApiOperation({ summary: 'Listar usuarios' })
  list(@Query() query: ListUsersDto) {
    return this.users.list(query);
  }

  @Get('permissions')
  @RequirePermission(PERMISSIONS.ROLE_MANAGE)
  @ApiOperation({ summary: 'Catálogo de permisos, agrupado' })
  listPermissions() {
    return this.users.listPermissions();
  }

  @Get('roles')
  @RequirePermission(PERMISSIONS.USER_VIEW)
  @ApiOperation({ summary: 'Roles con su número de permisos y usuarios' })
  listRoles() {
    return this.users.listRoles();
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.USER_VIEW)
  @ApiOperation({ summary: 'Detalle de un usuario' })
  findOne(@Param('id') id: string) {
    return this.users.findOne(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOperation({ summary: 'Crear usuario' })
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOperation({ summary: 'Actualizar usuario' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Patch(':id/roles')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOperation({ summary: 'Cambiar los roles de un usuario' })
  updateRoles(
    @Param('id') id: string,
    @Body() dto: UpdateUserRolesDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.users.updateRoles(id, dto.roleCodes, actor);
  }

  @Patch(':id/permissions')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOperation({ summary: 'Fijar los permisos efectivos de un usuario (rol + excepciones)' })
  updatePermissions(
    @Param('id') id: string,
    @Body() dto: UpdateUserPermissionsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.users.updatePermissions(id, dto.permissions, actor);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOperation({ summary: 'Archivar usuario (nunca se elimina)' })
  archive(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.users.archive(id, actor);
  }
}
