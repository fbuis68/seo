import { config } from '../../config';
import { JobsService } from '../../core/jobs.service';
import { Tx, one } from '../../core/db';
import { SystemMailer } from '../../core/system-mail';
import { PLANS, PlanCode } from './catalog';

const fmt = (d: Date) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });

/**
 * Essai sans carte bancaire d'une offre payante choisie sur le site : démarre à la confirmation
 * de l'email, une seule fois par organisme. Fin d'essai sans abonnement : retour Free (ou lecture
 * seule si le volume dépasse Free) par le travail billing.reevaluate ; rappel 3 jours avant.
 */
export async function startNoCardTrial(tx: Tx, jobs: JobsService, mailer: SystemMailer, tenantId: string, plan: string, interval: string) {
  if (!['solo', 'equipe', 'centre'].includes(plan) || config.trialDays <= 0) return null;
  const sub = await one(tx, `SELECT * FROM subscriptions WHERE tenant_id=$1 FOR UPDATE`, [tenantId]);
  if (!sub || sub.status !== 'free' || sub.trial_ends_at || sub.provider_subscription_id) return null;
  const end = new Date(Date.now() + config.trialDays * 86400e3);
  await tx.query(`UPDATE subscriptions SET plan_code=$2, billing_interval=$3, status='trialing', provider='trial', trial_ends_at=$4, read_only_since=NULL, updated_at=now() WHERE tenant_id=$1`,
    [tenantId, plan, interval === 'year' ? 'year' : 'month', end]);
  await jobs.enqueue(tx, 'billing.reevaluate', { tenantId }, { tenantId, runAt: new Date(end.getTime() + 60e3), dedupeKey: `trial_end:${tenantId}` });
  const remind = new Date(end.getTime() - 3 * 86400e3);
  if (remind > new Date()) await jobs.enqueue(tx, 'billing.trial_reminder', { tenantId }, { tenantId, runAt: remind, dedupeKey: `trial_remind:${tenantId}` });
  const p = PLANS[plan as PlanCode];
  await ownersMail(tx, mailer, tenantId, `Votre essai ${p.name} a démarré`,
    `Votre essai gratuit de l'offre ${p.name} est actif jusqu'au ${fmt(end)}, sans carte bancaire.\n\n`
    + `Pour continuer ensuite, choisissez votre abonnement : ${config.appUrl}/billing\n`
    + `Sans abonnement à la fin de l'essai, votre espace repasse en offre Free : vos données sont conservées.`);
  return end;
}

export async function trialReminder(tx: Tx, mailer: SystemMailer, tenantId: string) {
  const sub = await one(tx, `SELECT * FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
  if (!sub || sub.status !== 'trialing' || sub.provider_subscription_id || !sub.trial_ends_at) return;
  const p = PLANS[sub.plan_code as PlanCode];
  await ownersMail(tx, mailer, tenantId, `Votre essai ${p?.name ?? ''} se termine le ${fmt(new Date(sub.trial_ends_at))}`.replace('  ', ' '),
    `Votre essai se termine le ${fmt(new Date(sub.trial_ends_at))}.\n\nPour garder l'offre ${p?.name ?? ''} et toutes vos fonctions, choisissez votre abonnement (aucun débit avant la fin de l'essai) : ${config.appUrl}/billing\n\nSans abonnement, votre espace repassera en offre Free ; vos données restent conservées.`);
}

export async function trialEnded(tx: Tx, mailer: SystemMailer, tenantId: string, result: string) {
  await ownersMail(tx, mailer, tenantId, 'Votre essai est terminé',
    `Votre période d'essai est terminée. Votre espace est maintenant ${result === 'read_only' ? 'en lecture seule (le volume dépasse l\'offre Free) : consultation et export restent possibles' : 'en offre Free'}.\n\n`
    + `Pour retrouver toutes les fonctions, choisissez votre abonnement : ${config.appUrl}/billing`);
}

async function ownersMail(tx: Tx, mailer: SystemMailer, tenantId: string, subject: string, body: string) {
  const owners = (await tx.query(`SELECT u.email, u.full_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.role='owner'`, [tenantId])).rows;
  for (const o of owners) {
    try { await mailer.send({ to: o.email, subject, text: `Bonjour ${o.full_name},\n\n${body}` }); }
    catch (err: any) { console.error(`[essai] email non envoyé à ${o.email} : ${err.message}`); }
  }
}
