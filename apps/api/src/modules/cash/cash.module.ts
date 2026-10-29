import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PosContextModule } from '../pos-context/pos-context.module';
import { CashController } from './cash.controller';
import { CashService } from './cash.service';

@Module({
  imports: [AuthModule, PosContextModule],
  controllers: [CashController],
  providers: [CashService],
  exports: [CashService],
})
export class CashModule {}
