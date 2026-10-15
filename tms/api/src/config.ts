import { randomBytes } from 'crypto';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

/**
 * URL publique : variable explicite, sinon dérivée de APP_DOMAIN. Une valeur d'exemple
 * laissée telle quelle (« exemple.fr ») est remplacée par https://APP_DOMAIN, avec avertissement.
 */
function publicUrl(name: string, fallback: string): string {
  const domain = process.env.APP_DOMAIN?.trim();
  const v = process.env[name]?.trim();
  if (domain && !/exemple\.(fr|com)$/.test(domain) && (!v || /exemple\.(fr|com)/.test(v))) {
    if (v) console.warn(`[config] ${name}=${v} est une valeur d'exemple : https://${domain} utilisé à la place. Corrigez le fichier .env.`);
    return `https://${domain}`;
  }
  return (v || fallback).replace(/\/+$/, '');
}

export const config = {
  isProd,
  port: Number(env('PORT', '4000')),
  /** URL publique de l'API (utilisée par le widget du site web et les retours de paiement). */
  publicApiUrl: publicUrl('PUBLIC_API_URL', 'http://localhost:4000'),
  /** URL de l'application (SPA) vers laquelle on redirige après inscription/paiement. */
  appUrl: publicUrl('APP_URL', 'http://localhost:5173'),
  /** Comptes éditeur ayant accès au back-office (emails séparés par des virgules). */
  platformAdmins: (process.env.PLATFORM_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** Origines autorisées à appeler les endpoints publics (site vitrine WordPress, etc.). */
  publicOrigins: env('PUBLIC_ORIGINS', 'http://localhost:5173,http://localhost:8080')
    .split(',').map((s) => s.trim()).filter(Boolean),
  databaseUrl: env('DATABASE_URL', 'postgres://tms_app:tms_app@localhost:5432/tms'),
  migrationDatabaseUrl: env('MIGRATION_DATABASE_URL', 'postgres://tms_owner:tms_owner@localhost:5432/tms'),
  /** Clé maître (32 octets base64) chiffrant les secrets clients (clés IA, SMTP, banque). */
  secretKey: env('SECRET_KEY', isProd ? undefined : Buffer.alloc(32, 7).toString('base64')),
  storageDir: env('STORAGE_DIR', './var/storage'),
  payment: {
    provider: env('PAYMENT_PROVIDER', isProd ? 'stripe' : 'fake') as 'stripe' | 'fake',
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    fakeWebhookSecret: env('FAKE_PAYMENT_WEBHOOK_SECRET', randomBytes(16).toString('hex')),
    /** Serveur de démonstration : page de paiement simulée autorisée même en production (jamais avec de vrais clients). */
    demo: process.env.DEMO_PAYMENTS === 'true',
  },
  signature: {
    provider: env('SIGNATURE_PROVIDER', 'fake'),
    fakeWebhookSecret: env('FAKE_SIGNATURE_WEBHOOK_SECRET', 'dev-signature-secret'),
  },
  trialDays: Number(env('TRIAL_DAYS', '14')),
  graceDays: Number(env('PAYMENT_GRACE_DAYS', '7')),
  readOnlyExportDays: Number(env('READ_ONLY_EXPORT_DAYS', '30')),
  termsVersion: env('TERMS_VERSION', '2026-10-06'),
  smtpSystem: {
    // Canal système (vérification email, sécurité, factures d'abonnement). Vide = journalisé seulement.
    url: process.env.SYSTEM_SMTP_URL ?? '',
    from: env('SYSTEM_MAIL_FROM', 'Formation SaaS <no-reply@example.invalid>'),
  },
  /** En test : autorise les hôtes SMTP locaux (jamais en production). */
  allowPrivateHostsForTests: process.env.ALLOW_PRIVATE_HOSTS === '1' && !isProd,
};
