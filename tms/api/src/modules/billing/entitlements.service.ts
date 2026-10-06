import { Injectable } from '@nestjs/common';
import { Db, Tx, many, one } from '../../core/db';
import { paymentRequired } from '../../core/errors';
import { FeatureKey, Limits, PLANS } from './catalog';
import { Entitlements, computeEntitlements, hasFeature } from './entitlements';
import { QuotaKey, USAGE_QUERIES, dayPeriod, incrementCounter, lockQuota, monthPeriod, readCounter, yearOf } from './usage';

const FEATURE_LABELS: Partial<Record<FeatureKey, string>> = {
  signatures: 'La signature électronique est disponible dans les offres payantes.',
  'smtp.custom': "L'envoi depuis votre serveur SMTP est disponible dans les offres payantes.",
  bank: "La banque connectée est une option des offres payantes.",
  'mail.inbox': 'La réception email est une option des offres payantes.',
  'analytics.advanced': 'Les analyses avancées sont disponibles dans les offres payantes.',
  'opendata.advanced': 'La veille OpenData est disponible dans les offres payantes.',
};

/** Droits et quotas, appliqués côté serveur à chaque action et avant chaque appel externe. */
@Injectable()
export class EntitlementsService {
  constructor(private db: Db) {}

  async get(tenantId: string, tx?: Tx): Promise<Entitlements> {
    const run = async (t: Tx) => {
      const sub = await one(t, `SELECT * FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
      const addons = await many(t, `SELECT addon_code, quantity, status FROM subscription_addons WHERE tenant_id=$1`, [tenantId]);
      return computeEntitlements(sub, addons);
    };
    return tx ? run(tx) : this.db.tx(run);
  }

  requireFeature(e: Entitlements, feature: FeatureKey) {
    if (!hasFeature(e, feature)) {
      throw paymentRequired('feature_not_included', FEATURE_LABELS[feature] ?? `Module ${feature} non inclus dans votre offre.`,
        { feature, plan: e.planCode });
    }
  }

  /**
   * Vérifie (sous verrou) qu'ajouter `increment` unités ne dépasse pas la limite.
   * À appeler dans la même transaction que la création.
   */
  async assertQuota(tx: Tx, tenantId: string, key: QuotaKey, increment = 1, e?: Entitlements, year?: number): Promise<void> {
    e ??= await this.get(tenantId, tx);
    const limit = e.limits[key as keyof Limits] as number | null;
    if (limit === null || limit === undefined) return;
    await lockQuota(tx, tenantId, key);
    const tz = await this.tenantTz(tx, tenantId);
    const used = await USAGE_QUERIES[key](tx, tenantId, year ?? yearOf(new Date(), tz));
    if (used + increment > limit) {
      throw paymentRequired('quota_exceeded', quotaMessage(key, limit), { quota: key, limit, used, plan: e.planCode });
    }
  }

  /** Consomme un compteur périodique (emails, requêtes IA, recherches OpenData). */
  async consume(tx: Tx, tenantId: string, metric: 'emails' | 'ai_requests' | 'opendata_searches', by = 1, e?: Entitlements): Promise<number> {
    e ??= await this.get(tenantId, tx);
    const tz = await this.tenantTz(tx, tenantId);
    const [period, limit] = metric === 'emails' ? [monthPeriod(new Date(), tz), e.limits.emailsPerMonth]
      : metric === 'ai_requests' ? [monthPeriod(new Date(), tz), e.limits.aiRequestsPerMonth]
        : [dayPeriod(new Date(), tz), e.limits.opendataSearchesPerDay];
    await lockQuota(tx, tenantId, metric);
    const value = await incrementCounter(tx, tenantId, metric, period, by);
    if (value > limit) {
      throw paymentRequired('quota_exceeded', `Limite atteinte (${limit}) pour ${METRIC_LABELS[metric]} sur la période.`,
        { quota: metric, limit, used: value - by, plan: e.planCode });
    }
    return value;
  }

  async usageSummary(tenantId: string) {
    return this.db.tenantTx(tenantId, async (tx) => {
      const e = await this.get(tenantId, tx);
      const tz = await this.tenantTz(tx, tenantId);
      const year = yearOf(new Date(), tz);
      const month = monthPeriod(new Date(), tz);
      const quotas: Record<string, { used: number; limit: number | null }> = {};
      for (const key of Object.keys(USAGE_QUERIES) as QuotaKey[]) {
        quotas[key] = { used: await USAGE_QUERIES[key](tx, tenantId, year), limit: (e.limits as any)[key] ?? null };
      }
      quotas.emailsPerMonth = { used: await readCounter(tx, tenantId, 'emails', month), limit: e.limits.emailsPerMonth };
      quotas.aiRequestsPerMonth = { used: await readCounter(tx, tenantId, 'ai_requests', month), limit: e.limits.aiRequestsPerMonth };
      quotas.opendataSearchesPerDay = { used: await readCounter(tx, tenantId, 'opendata_searches', dayPeriod(new Date(), tz)), limit: e.limits.opendataSearchesPerDay };
      return { entitlements: e, quotas, period: { year, month } };
    });
  }

  /** Le volume actuel tient-il dans l'offre Free ? (retour Free vs lecture seule) */
  async fitsFree(tx: Tx, tenantId: string): Promise<{ fits: boolean; over: string[] }> {
    const free = PLANS.free.limits;
    const tz = await this.tenantTz(tx, tenantId);
    const year = yearOf(new Date(), tz);
    const over: string[] = [];
    for (const key of ['billedClients', 'learnersPerYear', 'activeSessions', 'managers', 'storageBytes'] as QuotaKey[]) {
      const limit = (free as any)[key] as number;
      if ((await USAGE_QUERIES[key](tx, tenantId, year)) > limit) over.push(key);
    }
    return { fits: over.length === 0, over };
  }

  private async tenantTz(tx: Tx, tenantId: string): Promise<string> {
    return (await one(tx, `SELECT timezone FROM tenants WHERE id=$1`, [tenantId]))?.timezone ?? 'Europe/Paris';
  }
}

const METRIC_LABELS = { emails: 'les emails', ai_requests: "les requêtes IA", opendata_searches: 'les recherches OpenData' };

function quotaMessage(key: QuotaKey, limit: number): string {
  const m: Record<QuotaKey, string> = {
    billedClients: `Votre offre est limitée à ${limit} clients facturés (archivés compris).`,
    crmProspects: `Votre offre est limitée à ${limit} fiches prospects.`,
    learnersPerYear: `Votre offre est limitée à ${limit} apprenants par année civile.`,
    activeSessions: `Votre offre est limitée à ${limit} sessions actives.`,
    draftSessions: `Votre offre est limitée à ${limit} sessions en brouillon.`,
    managers: `Votre offre est limitée à ${limit} gestionnaire(s).`,
    storageBytes: `Espace de stockage de l'offre atteint.`,
    smtpMailboxes: `Votre offre permet ${limit} boîte(s) expéditrice(s).`,
    bankAccounts: `Votre option banque permet ${limit} compte(s).`,
    bankInstitutions: `Votre option banque permet ${limit} établissement(s).`,
  };
  return m[key] + ' Passez à une offre supérieure ou réduisez le volume.';
}
