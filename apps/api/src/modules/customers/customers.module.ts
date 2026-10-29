import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PosContextModule } from '../pos-context/pos-context.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [AuthModule, PosContextModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
