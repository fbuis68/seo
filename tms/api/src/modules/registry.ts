import { AiModule } from './ai/ai.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { BankModule } from './bank/bank.module';
import { CatalogModule } from './catalog/catalog.module';
import { CrmModule } from './crm/crm.module';
import { DocumentsModule } from './documents/documents.module';
import { ExportsModule } from './exports/exports.module';
import { FinanceModule } from './finance/finance.module';
import { MailModule } from './mail/mail.module';
import { MigrationModule } from './migration/migration.module';
import { OpenDataModule } from './opendata/opendata.module';
import { QualityModule } from './quality.module';
import { SessionsModule } from './sessions/sessions.module';
import { SignaturesModule } from './signatures/signatures.module';

/**
 * Registre des modules métier montés dans l'application (monolithe modulaire).
 * Ajouter un module = l'importer ici ; son accès commercial est contrôlé par @RequireFeature
 * (catalogue des offres : modules/billing/catalog.ts).
 */
export const MODULE_IMPORTS: any[] = [
  CrmModule, CatalogModule, SessionsModule, QualityModule, FinanceModule, DocumentsModule, SignaturesModule,
  AnalyticsModule, ExportsModule, MigrationModule, OpenDataModule, MailModule, BankModule, AiModule,
];
