import { Global, Module } from '@nestjs/common';
import { CreditsService } from './credits.service';
import { EntitlementsService } from './entitlements.service';

/** Droits, quotas et crédits : utilisés par la garde globale et tous les modules métier. */
@Global()
@Module({ providers: [EntitlementsService, CreditsService], exports: [EntitlementsService, CreditsService] })
export class BillingCoreModule {}
