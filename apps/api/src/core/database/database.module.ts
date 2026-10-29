import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * El servicio se construye con FÁBRICA, no con `providers: [PrismaService]`.
 *
 * Motivo: el constructor de PrismaClient devuelve un Proxy que resuelve los
 * delegados de modelo. Dentro de la clase, `this` es el objeto envuelto y no
 * los tiene. La fábrica es el único punto donde se dispone del proxy, así que
 * es aquí donde se le pasa al servicio para que `get client()` pueda
 * devolverlo cuando no hay transacción activa.
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: (): PrismaService => {
        const prisma = new PrismaService();
        prisma.registerSelf(prisma);
        return prisma;
      },
    },
  ],
  exports: [PrismaService],
})
export class DatabaseModule {}
