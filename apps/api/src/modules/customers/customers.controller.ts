import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import { CustomersService } from './customers.service';
import {
  CustomerPaymentDto,
  ListCustomersDto,
  SetPriceListItemDto,
  StatementDto,
  UpsertCustomerDto,
} from './dto/customers.dto';

@ApiTags('Clientes')
@Controller()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get('customers')
  @RequirePermission(PERMISSIONS.CUSTOMER_VIEW)
  @ApiOperation({ summary: 'Buscar clientes' })
  list(@Query() query: ListCustomersDto) {
    return this.customers.list(query);
  }

  @Get('customers/:id')
  @RequirePermission(PERMISSIONS.CUSTOMER_VIEW)
  @ApiOperation({ summary: 'Ficha del cliente' })
  findOne(@Param('id') id: string) {
    return this.customers.findOne(id);
  }

  @Post('customers')
  @RequirePermission(PERMISSIONS.CUSTOMER_CREATE)
  @ApiOperation({ summary: 'Alta de cliente' })
  create(@Body() dto: UpsertCustomerDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.customers.create(dto, actor);
  }

  @Patch('customers/:id')
  @RequirePermission(PERMISSIONS.CUSTOMER_UPDATE)
  @ApiOperation({ summary: 'Editar cliente' })
  update(
    @Param('id') id: string,
    @Body() dto: UpsertCustomerDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.customers.update(id, dto, actor);
  }

  @Get('customers/:id/statement')
  @RequirePermission(PERMISSIONS.CUSTOMER_ACCOUNT_VIEW)
  @ApiOperation({ summary: 'Estado de cuenta' })
  statement(@Param('id') id: string, @Query() query: StatementDto) {
    return this.customers.statement(id, query);
  }

  @Post('customers/:id/payments')
  @RequirePermission(PERMISSIONS.CUSTOMER_ACCOUNT_VIEW)
  @ApiOperation({ summary: 'Registrar un abono a la cuenta' })
  pay(
    @Param('id') id: string,
    @Body() dto: CustomerPaymentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.customers.registerPayment(id, dto, actor);
  }

  // ── Listas de precios ──
  @Get('price-lists')
  @RequirePermission(PERMISSIONS.PRICING_VIEW)
  @ApiOperation({ summary: 'Listas de precios' })
  priceLists() {
    return this.customers.priceLists();
  }

  @Get('price-lists/:id/items')
  @RequirePermission(PERMISSIONS.PRICING_VIEW)
  @ApiOperation({ summary: 'Precios de una lista' })
  priceListItems(@Param('id') id: string) {
    return this.customers.priceListItems(id);
  }

  @Put('price-lists/:id/items')
  @RequirePermission(PERMISSIONS.PRICING_LIST_MANAGE)
  @ApiOperation({ summary: 'Fijar el precio de un artículo en la lista' })
  setItem(
    @Param('id') id: string,
    @Body() dto: SetPriceListItemDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.customers.setPriceListItem(id, dto, actor);
  }

  @Delete('price-lists/:id/items/:itemId')
  @RequirePermission(PERMISSIONS.PRICING_LIST_MANAGE)
  @ApiOperation({ summary: 'Quitar un precio de la lista' })
  removeItem(@Param('id') id: string, @Param('itemId') itemId: string) {
    return this.customers.removePriceListItem(id, itemId);
  }
}
