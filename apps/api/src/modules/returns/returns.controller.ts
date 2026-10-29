import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import { CreateReturnDto, ListReturnsDto } from './dto/returns.dto';
import { ReturnsService } from './returns.service';

@ApiTags('Devoluciones')
@Controller()
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Post('returns')
  @RequirePermission(PERMISSIONS.RETURN_CREATE)
  @ApiOperation({ summary: 'Registrar una devolución (total o parcial)' })
  create(@Body() dto: CreateReturnDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.returns.create(dto, actor);
  }

  @Get('returns')
  @RequirePermission(PERMISSIONS.SALE_VIEW)
  @ApiOperation({ summary: 'Historial de devoluciones' })
  list(@Query() query: ListReturnsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.returns.list(query, actor);
  }

  @Get('returns/:id')
  @RequirePermission(PERMISSIONS.SALE_VIEW)
  @ApiOperation({ summary: 'Detalle de una devolución' })
  findOne(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.returns.findOne(id, actor);
  }

  @Get('credit-notes/:folio')
  @RequirePermission(PERMISSIONS.SALE_CREATE)
  @ApiOperation({ summary: 'Consultar el saldo de una nota de crédito' })
  creditNote(@Param('folio') folio: string) {
    return this.returns.findCreditNote(folio);
  }
}
