import 'reflect-metadata';
import { createServer } from 'node:net';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { env, loadEnvironment } from './config/env';

/**
 * Comprueba que el puerto esté LIBRE antes de arrancar.
 *
 * En Windows, dos procesos Node pueden quedarse escuchando el mismo puerto sin
 * error: el primero se lleva todas las peticiones y el segundo cree que está
 * sirviendo. El síntoma es desconcertante —el log dice "API escuchando" y las
 * respuestas vienen de otra aplicación— así que conviene detectarlo aquí y
 * fallar con un mensaje que diga qué pasa.
 */
async function assertPortIsFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();

    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            [
              `El puerto ${port} ya está en uso por otro proceso.`,
              '',
              '  Opciones:',
              '    · Cierra el proceso que lo ocupa, o',
              '    · Cambia API_PORT en el archivo .env',
              '',
              '  Para ver quién lo tiene (Windows):',
              `    netstat -ano | findstr :${port}`,
              '',
            ].join('\n'),
          ),
        );
      } else {
        reject(error);
      }
    });

    // `exclusive` impide que el sistema comparta el puerto entre procesos.
    probe.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      probe.close(() => resolve());
    });
  });
}

/**
 * App de escritorio: el POS en `/` y el panel en `/admin/`, compilados con el
 * API en la misma origen (`/api/v1`). El HTML nunca se guarda en caché para que
 * una actualización se vea al recargar; los archivos con hash, un año.
 */
function serveDesktopUi(app: NestExpressApplication, root: string): void {
  const setHeaders = (res: { setHeader(name: string, value: string): void }, file: string) => {
    res.setHeader(
      'Cache-Control',
      file.endsWith('.html') || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=31536000, immutable',
    );
  };
  app.use('/admin', (req: Request, res: Response, next: NextFunction) => {
    if (req.originalUrl === '/admin') return res.redirect(301, '/admin/');
    next();
  });
  app.useStaticAssets(path.join(root, 'admin'), { prefix: '/admin/', setHeaders });
  app.useStaticAssets(path.join(root, 'pos'), { setHeaders });
}

async function bootstrap(): Promise<void> {
  // La configuración se valida ANTES de construir nada. Si falta una variable
  // obligatoria, el proceso muere aquí con un mensaje que dice exactamente cuál.
  loadEnvironment();
  const config = env();

  await assertPortIsFree(config.API_PORT);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix(`${config.API_PREFIX}/v1`);

  const desktop = Boolean(config.PV_STATIC_DIR);
  app.use(
    helmet({
      contentSecurityPolicy:
        config.NODE_ENV !== 'production'
          ? false
          : desktop
            ? {
                // Las cajas de la red local entran por http://IP: sin esto, el
                // navegador pediría los recursos por https y la página no carga.
                directives: { upgradeInsecureRequests: null },
              }
            : undefined,
      hsts: config.NODE_ENV === 'production' && !desktop,
    }),
  );
  app.use(cookieParser());

  if (config.PV_STATIC_DIR) serveDesktopUi(app, config.PV_STATIC_DIR);

  // Lista blanca explícita. NUNCA "*" con credenciales.
  app.enableCors({
    origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'Idempotency-Key',
      'If-Match',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'ETag'],
    maxAge: 86_400,
  });

  app.enableShutdownHooks();

  // El contrato OpenAPI se genera del código: nunca queda desfasado respecto
  // de lo que el servidor realmente acepta.
  if (config.NODE_ENV !== 'production') {
    const swagger = new DocumentBuilder()
      .setTitle('Maydek — API')
      .setDescription(
        'Punto de venta, inventario y administración. Fase 1: cimientos, autenticación y permisos.',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();

    SwaggerModule.setup(
      'docs',
      app,
      SwaggerModule.createDocument(app, swagger),
      { swaggerOptions: { persistAuthorization: true } },
    );
  }

  await app.listen(config.API_PORT, config.API_HOST);

  logger.log(`API escuchando en http://localhost:${config.API_PORT}/${config.API_PREFIX}/v1`);
  if (config.NODE_ENV !== 'production') {
    logger.log(`Documentación OpenAPI en http://localhost:${config.API_PORT}/docs`);
  }
}

bootstrap().catch((error: unknown) => {
  // Sin logger todavía: se escribe en crudo para que el mensaje de
  // configuración inválida sea legible en la consola.
  console.error('\n✗ El API no pudo arrancar.\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
