import { Module } from '@nestjs/common';
import { PosContextService } from './pos-context.service';

/**
 * Resolución del contexto operativo (sucursal, almacén, terminal, canal).
 * Lo comparten ventas, caja y devoluciones, así que vive en su propio módulo
 * para no crear dependencias circulares entre ellos.
 */
@Module({
  providers: [PosContextService],
  exports: [PosContextService],
})
export class PosContextModule {}
