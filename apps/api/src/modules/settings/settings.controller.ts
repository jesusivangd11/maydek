import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { IsObject } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import { SettingsService } from './settings.service';

export class UpdateSettingsDto {
  @ApiProperty({ example: { 'ticket.footer': '¡Vuelva pronto!', 'sales.allowNegativeStock': true } })
  @IsObject()
  values!: Record<string, unknown>;
}

/**
 * Configuración de la tienda. Cualquier usuario con sesión la lee (la caja
 * necesita el encabezado del ticket y las reglas de venta); cambiarla exige
 * `settings.manage`.
 */
@ApiTags('Configuración')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Configuración vigente (valores guardados o por defecto)' })
  getAll() {
    return this.settings.getAll();
  }

  @Put()
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Guardar opciones de configuración' })
  update(@Body() dto: UpdateSettingsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.settings.update(dto.values, actor);
  }
}
