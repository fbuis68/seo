import { Module } from '@nestjs/common';
import { BillingCoreModule } from '../billing/billing-core.module';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';

@Module({ imports: [BillingCoreModule], controllers: [IdentityController], providers: [IdentityService], exports: [IdentityService] })
export class IdentityModule {}
