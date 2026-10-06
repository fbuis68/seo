/**
 * Catalogue commercial : source unique des offres, modules et options.
 * Exposé tel quel au site web (widget de souscription) et appliqué côté serveur.
 * Tarifs indicatifs du cahier des charges v1.2 (§7) — à confirmer après contrats fournisseurs.
 */

export type PlanCode = 'free' | 'solo' | 'equipe' | 'centre';
export type BillingInterval = 'month' | 'year';
export type AddonCode = 'bank' | 'mail_inbox' | 'signature_pack';

/** Modules fonctionnels activables (le "côté modulaire" de l'offre). */
export type FeatureKey =
  | 'core' | 'exports' | 'migration.self' | 'opendata.basic' | 'opendata.advanced'
  | 'analytics.basic' | 'analytics.advanced' | 'signatures' | 'smtp.custom' | 'ai'
  | 'bank' | 'mail.inbox';

export interface Limits {
  managers: number;
  billedClients: number | null;       // null = sans quota (pas "illimité" de ressources)
  learnersPerYear: number;
  activeSessions: number | null;
  draftSessions: number | null;
  storageBytes: number;
  emailsPerMonth: number;
  signatureEnvelopesPerMonth: number;
  aiRequestsPerMonth: number;
  smtpMailboxes: number;
  crmProspects: number | null;
  opendataSearchesPerDay: number;
  importPackageBytes: number;
  bankInstitutions: number;
  bankAccounts: number;
  mailInboxes: number;
}

export interface Plan {
  code: PlanCode;
  name: string;
  tagline: string;
  monthlyPriceCents: number;          // HT
  /** Annuel = prix de 10 mensualités, engagement 12 mois affiché. */
  yearlyPriceCents: number;
  features: FeatureKey[];
  limits: Limits;
  support: string;
  highlighted?: boolean;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const BASE_FEATURES: FeatureKey[] = ['core', 'exports', 'migration.self', 'opendata.basic', 'analytics.basic', 'ai'];
const PAID_FEATURES: FeatureKey[] = [...BASE_FEATURES, 'opendata.advanced', 'analytics.advanced', 'signatures', 'smtp.custom'];

const paidLimits = (managers: number, learners: number, storageGb: number, emails: number, envelopes: number, ai: number, smtp: number): Limits => ({
  managers, billedClients: null, learnersPerYear: learners, activeSessions: null, draftSessions: null,
  storageBytes: storageGb * GB, emailsPerMonth: emails, signatureEnvelopesPerMonth: envelopes,
  aiRequestsPerMonth: ai, smtpMailboxes: smtp, crmProspects: null, opendataSearchesPerDay: 2000,
  importPackageBytes: 1 * GB, bankInstitutions: 0, bankAccounts: 0, mailInboxes: 0,
});

export const PLANS: Record<PlanCode, Plan> = {
  free: {
    code: 'free', name: 'Free', tagline: 'Pour démarrer, sans carte et sans limite de durée',
    monthlyPriceCents: 0, yearlyPriceCents: 0, features: BASE_FEATURES, support: 'Aide en ligne',
    limits: {
      managers: 1, billedClients: 10, learnersPerYear: 50, activeSessions: 3, draftSessions: 10,
      storageBytes: 1 * GB, emailsPerMonth: 100, signatureEnvelopesPerMonth: 0, aiRequestsPerMonth: 20,
      smtpMailboxes: 0, crmProspects: 100, opendataSearchesPerDay: 100, importPackageBytes: 100 * MB,
      bankInstitutions: 0, bankAccounts: 0, mailInboxes: 0,
    },
  },
  solo: {
    code: 'solo', name: 'Solo', tagline: 'Formateur indépendant',
    monthlyPriceCents: 3900, yearlyPriceCents: 39000, features: PAID_FEATURES, support: 'Support email',
    limits: paidLimits(1, 200, 10, 1000, 5, 500, 1),
  },
  equipe: {
    code: 'equipe', name: 'Equipe', tagline: 'Petite équipe de gestion', highlighted: true,
    monthlyPriceCents: 8900, yearlyPriceCents: 89000, features: PAID_FEATURES, support: 'Support email',
    limits: paidLimits(3, 1000, 50, 5000, 20, 2000, 3),
  },
  centre: {
    code: 'centre', name: 'Centre', tagline: 'Centre de formation structuré',
    monthlyPriceCents: 14900, yearlyPriceCents: 149000, features: PAID_FEATURES, support: 'Support prioritaire',
    limits: paidLimits(6, 2500, 100, 10000, 50, 5000, 6),
  },
};

export interface Addon {
  code: AddonCode;
  name: string;
  description: string;
  priceCents: number;
  recurring: boolean;                 // false = achat ponctuel (pack)
  perUnit?: string;
  requiresPaidPlan: true;
  availability: 'available' | 'beta' | 'coming_soon';
  grants: Partial<Limits>;
  feature?: FeatureKey;
}

export const ADDONS: Record<AddonCode, Addon> = {
  bank: {
    code: 'bank', name: 'Banque connectée',
    description: 'Synchronisation bancaire en lecture seule et rapprochement des encaissements (1 établissement, 3 comptes).',
    priceCents: 1200, recurring: true, requiresPaidPlan: true, availability: 'beta',
    grants: { bankInstitutions: 1, bankAccounts: 3 }, feature: 'bank',
  },
  mail_inbox: {
    code: 'mail_inbox', name: 'Réception email',
    description: 'Rattachement des réponses reçues (IMAP/API) aux dossiers. Reprise initiale 90 jours.',
    priceCents: 900, recurring: true, perUnit: 'boîte', requiresPaidPlan: true, availability: 'coming_soon',
    grants: { mailInboxes: 1 }, feature: 'mail.inbox',
  },
  signature_pack: {
    code: 'signature_pack', name: 'Pack 20 signatures',
    description: '20 enveloppes de signature électronique supplémentaires, valables sur le cycle en cours.',
    priceCents: 2900, recurring: false, requiresPaidPlan: true, availability: 'available',
    grants: { signatureEnvelopesPerMonth: 20 },
  },
};

/** Modules présentés sur le site : libellé, description, inclusion par offre. */
export const MODULES: { key: FeatureKey; name: string; description: string; priority: 'P0' | 'P1' }[] = [
  { key: 'core', name: 'Gestion des formations', description: 'Catalogue, sessions, inscriptions, documents, présences, qualité, devis et factures.', priority: 'P0' },
  { key: 'migration.self', name: 'Reprise de vos données', description: 'Import contrôlé de vos sauvegardes (Dendreo, Digiforma, fichiers) avec simulation et rapport.', priority: 'P0' },
  { key: 'exports', name: 'Réversibilité', description: 'Export complet données + documents + preuves, inclus dans toutes les offres.', priority: 'P0' },
  { key: 'opendata.basic', name: 'OpenData', description: 'Préremplissage entreprises, organismes Qualiopi, RNCP/RS, recherche offre CPF.', priority: 'P0' },
  { key: 'analytics.basic', name: 'Tableaux de bord', description: 'CA facturé, encaissements, impayés, répartitions.', priority: 'P0' },
  { key: 'ai', name: 'Assistant IA', description: 'Assistant conversationnel avec votre clé OpenAI ou Gemini, actions toujours confirmées.', priority: 'P0' },
  { key: 'signatures', name: 'Signature électronique', description: 'Conventions, contrats et devis signés en ligne avec dossier de preuve.', priority: 'P0' },
  { key: 'smtp.custom', name: 'Envoi depuis votre messagerie', description: 'Emails envoyés depuis votre propre serveur SMTP.', priority: 'P0' },
  { key: 'analytics.advanced', name: 'Analyses avancées', description: 'Comparatifs N/N-1, exports de graphiques, veille OpenData.', priority: 'P0' },
  { key: 'opendata.advanced', name: 'Veille marché', description: 'Comparatifs et exports analytiques des données publiques CPF.', priority: 'P0' },
  { key: 'bank', name: 'Banque connectée (option)', description: 'Rapprochement bancaire en lecture seule.', priority: 'P0' },
  { key: 'mail.inbox', name: 'Réception email (option)', description: 'Réponses clients rattachées aux dossiers.', priority: 'P1' },
];

export const PAID_PLANS: PlanCode[] = ['solo', 'equipe', 'centre'];
export const isPlanCode = (v: string): v is PlanCode => v in PLANS;
export const isAddonCode = (v: string): v is AddonCode => v in ADDONS;
export function planPrice(plan: PlanCode, interval: BillingInterval): number {
  return interval === 'year' ? PLANS[plan].yearlyPriceCents : PLANS[plan].monthlyPriceCents;
}

/** Représentation publique (site web) : aucune donnée interne. */
export function publicCatalog() {
  return {
    currency: 'EUR',
    pricesExcludeTax: true,
    annualRule: 'Annuel : prix de 10 mensualités, engagement 12 mois.',
    trialDays: 14,
    plans: Object.values(PLANS).map((p) => ({
      code: p.code, name: p.name, tagline: p.tagline, highlighted: !!p.highlighted,
      monthlyPriceCents: p.monthlyPriceCents, yearlyPriceCents: p.yearlyPriceCents,
      features: p.features, support: p.support,
      limits: { ...p.limits },
    })),
    addons: Object.values(ADDONS),
    modules: MODULES,
  };
}
