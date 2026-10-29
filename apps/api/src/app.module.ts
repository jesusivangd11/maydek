import { MiddlewareConsumer, Module, NestModule, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { REDACTED_FIELDS } from '@pv/shared-types';
import { env } from './config/env';
import { CoreModule } from './core/core.module';
import { DatabaseModule } from './core/database/database.module';
import { AllExceptionsFilter } from './core/errors/all-exceptions.filter';
import { RequestContextMiddleware } from './core/request-context/request-context';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './modules/auth/guards/permissions.guard';
import { CashModule } from './modules/cash/cash.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { HealthModule } from './modules/health/health.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { PosContextModule } from './modules/pos-context/pos-context.module';
import { SalesModule } from './modules/sales/sales.module';
import { UsersModule } from './modules/users/users.module';
import { CustomersModule } from './modules/customers/customers.module';
import { PurchasesModule } from './modules/purchases/purchases.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ReturnsModule } from './modules/returns/returns.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SupportModule } from './modules/support/support.module';

const config = env();

@Module({
  imports: [
    // ── Logs estructurados con request_id correlacionado ──
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.LOG_LEVEL,
        transport: config.LOG_PRETTY
          ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } }
          : undefined,
        genReqId: (req) => (req as { id?: string }).id ?? crypto.randomUUID(),
        // Contraseñas, PIN, tokens y tarjetas NUNCA llegan a los logs.
        redact: {
          paths: [
            ...REDACTED_FIELDS.map((f) => `req.body.${f}`),
            ...REDACTED_FIELDS.map((f) => `res.body.${f}`),
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
          ],
          censor: '[REDACTADO]',
        },
        autoLogging: {
          ignore: (req) => (req.url ?? '').startsWith('/api/v1/health'),
        },
      },
    }),

    // ── Rate limiting ──
    //
    // UN SOLO bucket global, a propósito. En @nestjs/throttler, TODO bucket
    // declarado aquí se aplica a TODAS las rutas: declarar además uno llamado
    // "auth" de 5/min no limitaba el login, limitaba el sistema entero. Un
    // cajero que escanea seis artículos en un minuto recibía 429 al sexto.
    //
    // Los endpoints que sí necesitan mano dura estrechan ESTE bucket con
    // @Throttle({ default: … }), que es la forma de acotarlo por ruta.
    ThrottlerModule.forRoot([
      { name: 'default', ttl: config.THROTTLE_TTL_SECONDS * 1000, limit: config.THROTTLE_LIMIT },
    ]),

    DatabaseModule,
    CoreModule,
    AuthModule,
    UsersModule,
    HealthModule,
    SettingsModule,

    // ── Operación ──
    PosContextModule,
    CatalogModule,
    InventoryModule,
    CashModule,
    SalesModule,
    ReturnsModule,
    CustomersModule,
    PurchasesModule,
    ReportsModule,
    SupportModule,
  ],
  providers: [
    // ── Orden de los guards (importa) ──
    // 1. Límite de peticiones · 2. ¿Quién eres? · 3. ¿Puedes hacerlo?
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },

    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        // Un campo no declarado en el DTO hace fallar la petición. Cierra la
        // asignación masiva: nadie cuela `isAdmin: true` en un formulario.
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
