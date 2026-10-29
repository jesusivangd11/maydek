import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PosContextModule } from '../pos-context/pos-context.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [AuthModule, PosContextModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
