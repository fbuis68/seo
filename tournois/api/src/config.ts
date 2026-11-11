function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}
const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  isTest: process.env.NODE_ENV === 'test',
  port: Number(env('PORT', '4100')),
  /** URL de l'application web : liens des QR Codes, emails et notifications. */
  appUrl: env('APP_URL', 'http://localhost:5174').replace(/\/+$/, ''),
  databaseUrl: env('DATABASE_URL', 'postgres://tn_app:tn_app@localhost:5432/tournois'),
  migrationDatabaseUrl: env('MIGRATION_DATABASE_URL', 'postgres://tn_owner:tn_owner@localhost:5432/tournois'),
  /** Super administrateurs de la plateforme (emails séparés par des virgules). */
  platformAdmins: (process.env.PLATFORM_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  sessionDays: Number(env('SESSION_DAYS', '30')),
  /** Durée de validité par défaut des QR Codes individuels (jours). */
  participantTokenDays: Number(env('PARTICIPANT_TOKEN_DAYS', '30')),
  smtpUrl: process.env.SMTP_URL ?? '',
  mailFrom: env('MAIL_FROM', 'Tournois <no-reply@localhost>'),
  /** Tâche périodique (échéances de confirmation) : intervalle en secondes, 0 pour désactiver. */
  sweepSeconds: Number(env('SWEEP_SECONDS', '60')),
};
