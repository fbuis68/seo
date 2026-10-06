import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './core/auth.guard';
import { CoreModule } from './core/core.module';
import { AppExceptionFilter } from './core/errors';
import { BillingCoreModule } from './modules/billing/billing-core.module';
import { BillingModule } from './modules/billing/billing.module';
import { IdentityModule } from './modules/identity/identity.module';
import { MODULE_IMPORTS } from './modules/registry';

/**
 * Monolithe modulaire : chaque domaine est un module Nest aux frontières explicites
 * (contrôleur + service + tables). Le backend reste l'autorité des droits, calculs, états et quotas.
 */
@Module({
  imports: [CoreModule, BillingCoreModule, IdentityModule, BillingModule, ...MODULE_IMPORTS],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class AppModule {}
