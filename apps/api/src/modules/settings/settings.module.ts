import { Global, Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/** Global: ventas, catálogo y reportes leen la configuración sin importarlo. */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
