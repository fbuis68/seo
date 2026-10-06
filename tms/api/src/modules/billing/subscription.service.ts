import { Inject, Injectable } from '@nestjs/common';
import { config } from '../../config';
import { AuditService } from '../../core/audit.service';
import { stableHash } from '../../core/crypto';
import { Db, Tx, one } from '../../core/db';
import { AppError, badRequest, conflict, paymentRequired } from '../../core/errors';
import { JobsService } from '../../core/jobs.service';
import { SystemMailer } from '../../core/system-mail';
import { ADDONS, AddonCode, BillingInterval, PAID_PLANS, PLANS, PlanCode, planPrice } from './catalog';
import { CreditsService } from './credits.service';
import { EntitlementsService } from './entitlements.service';
import { NormalizedEvent, PAYMENT_PROVIDER, PaymentProvider, ProviderSubscriptionState } from './providers/payment-provider';

export interface PlanChoice { plan: PlanCode; interval: BillingInterval; addons: { code: AddonCode; quantity: number }[] }

const PAID_STATUSES = ['trialing', 'active', 'past_due'];

/**
 * Souscription autonome : checkout hébergé, webhooks vérifiés et idempotents,
 * traduction explicite des états fournisseur, upgrade/downgrade/résiliation en ligne.
 * Jamais d'activation sur simple retour de page de paiement : seul le serveur confirme.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private db: Db,
    @Inject(PAYMENT_PROVIDER) readonly provider: PaymentProvider,
    private entitlements: EntitlementsService,
    private credits: CreditsService,
    private audit: AuditService,
    private jobs: JobsService,
    private mailer: SystemMailer,
  ) {
    this.jobs.register('billing.reevaluate', (p) => this.reevaluate(p.tenantId));
    this.jobs.register('billing.apply_pending_change', (p) => this.applyPendingChange(p.tenantId));
    this.jobs.register('billing.reconcile', () => this.reconcileAll());
  }

  validateChoice(c: PlanChoice) {
    if (!PAID_PLANS.includes(c.plan)) throw badRequest('invalid_plan', 'Offre payante attendue (solo, equipe, centre).', 'plan');
    const seen = new Set<string>();
    for (const a of c.addons) {
      const def = ADDONS[a.code];
      if (!def || !def.recurring) throw badRequest('invalid_addon', `Option inconnue ou non récurrente : ${a.code}`, 'addons');
      if (def.availability === 'coming_soon') throw badRequest('addon_unavailable', `Option ${def.name} bientôt disponible.`, 'addons');
      if (seen.has(a.code)) throw badRequest('invalid_addon', 'Option en double', 'addons');
      if (a.quantity < 1 || a.quantity > 10) throw badRequest('invalid_addon', 'Quantité invalide', 'addons');
      seen.add(a.code);
    }
  }

  /** Montant récurrent HT (centimes) d'une configuration, calculé serveur. */
  recurringAmount(c: PlanChoice): number {
    const months = c.interval === 'year' ? 10 : 1; // annuel = 10 mensualités
    return planPrice(c.plan, c.interval) + c.addons.reduce((s, a) => s + ADDONS[a.code].priceCents * a.quantity * months, 0);
  }

  async getState(tenantId: string) {
    const [sub] = await this.db.query(`SELECT * FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
    const addons = await this.db.query(`SELECT addon_code, quantity, status FROM subscription_addons WHERE tenant_id=$1 AND status='active'`, [tenantId]);
    const usage = await this.entitlements.usageSummary(tenantId);
    const credits = await this.db.tenantTx(tenantId, (tx) => this.credits.balance(tx, tenantId, usage.entitlements));
    return {
      plan: sub.plan_code, interval: sub.billing_interval, status: sub.status, providerStatus: sub.provider_status,
      currentPeriodEnd: sub.current_period_end, trialEndsAt: sub.trial_ends_at, trialUsed: !!sub.trial_ends_at,
      graceUntil: sub.grace_until, cancelAtPeriodEnd: sub.cancel_at_period_end, pendingChange: sub.pending_change,
      readOnlySince: sub.read_only_since, hasPaymentMethod: !!sub.provider_subscription_id,
      addons, entitlements: usage.entitlements, quotas: usage.quotas, signatureCredits: credits,
    };
  }

  async startCheckout(tenantId: string, actor: { userId: string; email: string }, choice: PlanChoice & { trial?: boolean }, returnPath = '/billing') {
    this.validateChoice(choice);
    return this.db.tx(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`checkout:${tenantId}`]);
      const sub = await one(tx, `SELECT * FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
      if (sub.provider_subscription_id && PAID_STATUSES.includes(sub.status)) {
        throw conflict('subscription_exists', 'Un abonnement est déjà actif : utilisez le changement d’offre.');
      }
      const trial = !!choice.trial && !sub.trial_ends_at;
      if (choice.trial && sub.trial_ends_at) throw badRequest('trial_used', "L'essai gratuit a déjà été utilisé.");
      const day = new Date().toISOString().slice(0, 10);
      const key = stableHash({ tenantId, plan: choice.plan, interval: choice.interval, addons: choice.addons, trial, day });
      // Clic répété : même session de paiement, jamais deux abonnements.
      const existing = await one(tx, `SELECT url FROM checkout_sessions WHERE idempotency_key=$1 AND status='open'`, [key]);
      if (existing) return { url: existing.url, reused: true };
      const checkoutId = (await one(tx, `SELECT gen_random_uuid() id`))!.id;
      const res = await this.provider.createCheckout({
        tenantId, checkoutId, customerEmail: actor.email, customerId: sub.provider_customer_id, kind: 'subscription',
        plan: choice.plan, interval: choice.interval, addons: choice.addons, trialDays: trial ? config.trialDays : undefined,
        successUrl: `${config.appUrl}${returnPath}?checkout=success`, cancelUrl: `${config.appUrl}${returnPath}?checkout=cancelled`,
        idempotencyKey: key,
      });
      await tx.query(`INSERT INTO checkout_sessions(id, tenant_id, provider, provider_session_id, kind, plan_code, billing_interval, addons, idempotency_key, url)
                      VALUES ($1,$2,$3,$4,'subscription',$5,$6,$7,$8,$9)`,
        [checkoutId, tenantId, this.provider.name, res.providerSessionId, choice.plan, choice.interval, JSON.stringify(choice.addons), key, res.url]);
      await this.audit.log(tx, { tenantId, actor: actor.userId, action: 'billing.checkout_started', data: { ...choice, trial, amountCents: this.recurringAmount(choice) } });
      return { url: res.url, reused: false };
    });
  }

  async buySignaturePack(tenantId: string, actor: { userId: string; email: string }) {
    const e = await this.entitlements.get(tenantId);
    if (!PAID_PLANS.includes(e.planCode) || e.status === 'trialing') throw paymentRequired('paid_plan_required', 'Les packs de signatures sont réservés aux offres payantes actives.');
    const [sub] = await this.db.query(`SELECT provider_customer_id FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
    const checkoutId = (await this.db.query(`SELECT gen_random_uuid() id`))[0].id;
    const key = `pack:${tenantId}:${checkoutId}`;
    const res = await this.provider.createCheckout({
      tenantId, checkoutId, customerEmail: actor.email, customerId: sub.provider_customer_id, kind: 'signature_pack', addons: [],
      successUrl: `${config.appUrl}/billing?pack=success`, cancelUrl: `${config.appUrl}/billing?pack=cancelled`, idempotencyKey: key,
    });
    await this.db.query(`INSERT INTO checkout_sessions(id, tenant_id, provider, provider_session_id, kind, idempotency_key, url)
                         VALUES ($1,$2,$3,$4,'signature_pack',$5,$6)`, [checkoutId, tenantId, this.provider.name, res.providerSessionId, key, res.url]);
    return { url: res.url };
  }

  /** Aperçu d'un changement d'offre : prix, prorata estimé, date d'effet. */
  async previewChange(tenantId: string, choice: PlanChoice) {
    this.validateChoice(choice);
    const [sub] = await this.db.query(`SELECT * FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
    if (!sub.provider_subscription_id || !PAID_STATUSES.includes(sub.status)) throw badRequest('no_subscription', 'Aucun abonnement payant actif : utilisez la souscription.');
    const addons = await this.db.query(`SELECT addon_code code, quantity FROM subscription_addons WHERE tenant_id=$1 AND status='active'`, [tenantId]);
    const current: PlanChoice = { plan: sub.plan_code, interval: sub.billing_interval, addons };
    const curAmount = this.recurringAmount(current);
    const newAmount = this.recurringAmount(choice);
    const toMonthly = (c: PlanChoice, a: number) => (c.interval === 'year' ? a / 12 : a);
    const upgrade = toMonthly(choice, newAmount) >= toMonthly(current, curAmount) && !(choice.interval === 'month' && current.interval === 'year');
    let prorataCents = 0;
    if (upgrade && sub.current_period_end) {
      const periodDays = current.interval === 'year' ? 365 : 30;
      const remaining = Math.max(0, (new Date(sub.current_period_end).getTime() - Date.now()) / 86400e3);
      const ratio = Math.min(1, remaining / periodDays);
      prorataCents = choice.interval === current.interval
        ? Math.max(0, Math.round((newAmount - curAmount) * ratio))
        : Math.max(0, newAmount - Math.round(curAmount * ratio)); // nouvelle période, crédit du reliquat
    }
    return {
      direction: upgrade ? 'upgrade' : 'downgrade',
      effective: upgrade ? 'now' : 'period_end',
      effectiveDate: upgrade ? new Date().toISOString() : sub.current_period_end,
      currentAmountCents: curAmount, newAmountCents: newAmount,
      estimatedProrataCents: prorataCents,
      note: upgrade ? 'Prorata facturé immédiatement par le prestataire de paiement (montant exact sur la facture).' : 'Réduction appliquée à la prochaine échéance ; aucune donnée supprimée.',
    };
  }

  /** Changement confirmé : upgrade immédiat avec prorata ; downgrade à l'échéance. */
  async changePlan(tenantId: string, actor: string, choice: PlanChoice, confirm: { direction: string; newAmountCents: number }) {
    const preview = await this.previewChange(tenantId, choice);
    if (confirm.direction !== preview.direction || confirm.newAmountCents !== preview.newAmountCents) {
      throw conflict('preview_mismatch', 'Le montant ou le sens du changement a évolué : affichez à nouveau l’aperçu.', preview);
    }
    const [sub] = await this.db.query(`SELECT * FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
    if (preview.direction === 'upgrade') {
      const state = await this.provider.updateSubscription(sub.provider_subscription_id, { ...choice, prorate: true });
      await this.db.tx(async (tx) => {
        await this.applyState(tx, tenantId, state, new Date());
        await tx.query(`UPDATE subscriptions SET pending_change=NULL WHERE tenant_id=$1`, [tenantId]);
        await this.audit.log(tx, { tenantId, actor, action: 'billing.upgraded', data: choice });
      });
    } else {
      await this.db.tx(async (tx) => {
        await tx.query(`UPDATE subscriptions SET pending_change=$2, updated_at=now() WHERE tenant_id=$1`, [tenantId, JSON.stringify(choice)]);
        await this.jobs.enqueue(tx, 'billing.apply_pending_change', { tenantId }, {
          tenantId, runAt: sub.current_period_end ?? new Date(), dedupeKey: `pending:${tenantId}:${stableHash(choice)}`,
        });
        await this.audit.log(tx, { tenantId, actor, action: 'billing.downgrade_scheduled', data: choice });
      });
    }
    return this.getState(tenantId);
  }

  async applyPendingChange(tenantId: string) {
    const [sub] = await this.db.query(`SELECT * FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
    if (!sub?.pending_change || !sub.provider_subscription_id) return;
    if (sub.current_period_end && new Date(sub.current_period_end) > new Date()) {
      await this.jobs.enqueue(null, 'billing.apply_pending_change', { tenantId }, { tenantId, runAt: sub.current_period_end });
      return;
    }
    const state = await this.provider.updateSubscription(sub.provider_subscription_id, { ...sub.pending_change, prorate: false });
    await this.db.tx(async (tx) => {
      await this.applyState(tx, tenantId, state, new Date());
      await tx.query(`UPDATE subscriptions SET pending_change=NULL WHERE tenant_id=$1`, [tenantId]);
    });
  }

  /** Résiliation en ligne à l'échéance, sans appel obligatoire ; le compte gratuit reste ouvert. */
  async cancel(tenantId: string, actor: string, cancel = true) {
    const [sub] = await this.db.query(`SELECT * FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
    if (!sub.provider_subscription_id) throw badRequest('no_subscription', 'Aucun abonnement payant à résilier.');
    const state = await this.provider.setCancelAtPeriodEnd(sub.provider_subscription_id, cancel);
    await this.db.tx(async (tx) => {
      await this.applyState(tx, tenantId, state, new Date());
      await this.audit.log(tx, { tenantId, actor, action: cancel ? 'billing.cancel_scheduled' : 'billing.cancel_reverted' });
    });
    return this.getState(tenantId);
  }

  // ─── Webhooks ────────────────────────────────────────────────────────────

  async handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    let evt: NormalizedEvent;
    try { evt = this.provider.verifyWebhook(rawBody, headers); } catch (e) {
      throw new AppError(400, 'invalid_webhook', `Webhook refusé : ${(e as Error).message}`);
    }
    // Fetch de l'état frais hors transaction (réseau), puis application transactionnelle et dédupliquée.
    let state: ProviderSubscriptionState | undefined;
    if (evt.type !== 'ignored' && evt.providerSubscriptionId) state = await this.provider.retrieveSubscription(evt.providerSubscriptionId);
    return this.db.tx(async (tx) => {
      const ins = await one(tx, `INSERT INTO billing_events(provider, event_id, type, tenant_id, payload) VALUES ($1,$2,$3,$4,$5)
                                 ON CONFLICT DO NOTHING RETURNING event_id`,
        [this.provider.name, evt.id, evt.rawType, evt.tenantId ?? state?.tenantId ?? null, JSON.stringify(evt.raw)]);
      if (!ins) return { received: true, duplicate: true };
      await this.process(tx, evt, state);
      await tx.query(`UPDATE billing_events SET processed_at=now() WHERE provider=$1 AND event_id=$2`, [this.provider.name, evt.id]);
      return { received: true, duplicate: false };
    });
  }

  private async resolveTenant(tx: Tx, evt: NormalizedEvent, state?: ProviderSubscriptionState): Promise<string | undefined> {
    if (state?.providerSubscriptionId) {
      const r = await one(tx, `SELECT tenant_id FROM subscriptions WHERE provider_subscription_id=$1`, [state.providerSubscriptionId]);
      if (r) return r.tenant_id;
    }
    const candidate = state?.tenantId ?? evt.tenantId;
    if (candidate && (await one(tx, `SELECT 1 FROM tenants WHERE id=$1`, [candidate]))) return candidate;
    return undefined;
  }

  private async process(tx: Tx, evt: NormalizedEvent, state?: ProviderSubscriptionState) {
    if (evt.type === 'ignored') return;
    const tenantId = await this.resolveTenant(tx, evt, state);
    if (!tenantId) throw new Error(`organisme introuvable pour l'événement ${evt.id}`);

    if (evt.type === 'checkout.completed') {
      const cs = await one(tx, `UPDATE checkout_sessions SET status='completed' WHERE provider=$1 AND provider_session_id=$2 AND tenant_id=$3 RETURNING *`,
        [this.provider.name, evt.checkoutSessionId, tenantId]);
      if (cs?.kind === 'signature_pack') {
        await this.credits.purchase(tx, tenantId, ADDONS.signature_pack.grants.signatureEnvelopesPerMonth!, `pack:${evt.checkoutSessionId}`, 'Pack 20 signatures');
        await this.audit.log(tx, { tenantId, action: 'billing.signature_pack_purchased', data: { checkout: evt.checkoutSessionId } });
        return;
      }
      if (evt.providerCustomerId) await tx.query(`UPDATE subscriptions SET provider_customer_id=$2 WHERE tenant_id=$1`, [tenantId, evt.providerCustomerId]);
    }
    if (state) await this.applyState(tx, tenantId, state, evt.createdAt);
    if (evt.type === 'payment.failed') {
      const [u] = (await tx.query(`SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.role='owner' LIMIT 1`, [tenantId])).rows;
      if (u) await this.mailer.send({ to: u.email, subject: 'Échec de paiement de votre abonnement',
        text: `Le paiement de votre abonnement a échoué. Vous disposez de ${config.graceDays} jours pour mettre à jour votre moyen de paiement : ${config.appUrl}/billing` });
    }
  }

  /** Traduction explicite de l'état fournisseur vers l'état interne. */
  async applyState(tx: Tx, tenantId: string, s: ProviderSubscriptionState, at: Date) {
    const cur = await one(tx, `SELECT * FROM subscriptions WHERE tenant_id=$1 FOR UPDATE`, [tenantId]);
    // Un ancien abonnement terminé ne doit pas écraser l'abonnement courant.
    if (cur.provider_subscription_id && cur.provider_subscription_id !== s.providerSubscriptionId && PAID_STATUSES.includes(cur.status)) {
      if (['canceled', 'incomplete_expired'].includes(s.status)) return;
    }
    if (s.status === 'incomplete' || s.status === 'paused') {
      await tx.query(`UPDATE subscriptions SET provider_status=$2, last_provider_event_at=greatest(last_provider_event_at,$3), updated_at=now() WHERE tenant_id=$1`, [tenantId, s.status, at]);
      return;
    }
    if (s.status === 'canceled' || s.status === 'incomplete_expired') {
      await this.endPaid(tx, tenantId, s.status);
      return;
    }
    const status = s.status === 'trialing' ? 'trialing' : s.status === 'active' ? 'active' : 'past_due';
    await tx.query(`
      UPDATE subscriptions SET plan_code=$2, billing_interval=$3, status=$4, provider=$5, provider_customer_id=$6,
        provider_subscription_id=$7, provider_status=$8, current_period_end=$9,
        trial_ends_at=coalesce($10, trial_ends_at), cancel_at_period_end=$11,
        grace_until = CASE WHEN $4='past_due' THEN coalesce(grace_until, now() + ($12 || ' days')::interval) ELSE NULL END,
        read_only_since=NULL, last_provider_event_at=greatest(last_provider_event_at,$13), updated_at=now()
      WHERE tenant_id=$1`,
      [tenantId, s.planCode, s.interval, status, this.provider.name, s.providerCustomerId, s.providerSubscriptionId, s.status,
        s.currentPeriodEnd, s.trialEnd, s.cancelAtPeriodEnd, String(config.graceDays), at]);
    for (const code of Object.keys(ADDONS) as AddonCode[]) {
      if (!ADDONS[code].recurring) continue;
      const a = s.addons.find((x) => x.code === code);
      if (a) await tx.query(`INSERT INTO subscription_addons(tenant_id, addon_code, quantity, status) VALUES ($1,$2,$3,'active')
                             ON CONFLICT (tenant_id, addon_code) DO UPDATE SET quantity=$3, status='active', updated_at=now()`, [tenantId, code, a.quantity]);
      else await tx.query(`UPDATE subscription_addons SET status='cancelled', updated_at=now() WHERE tenant_id=$1 AND addon_code=$2`, [tenantId, code]);
    }
    if (status === 'past_due') {
      const g = await one(tx, `SELECT grace_until FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
      await this.jobs.enqueue(tx, 'billing.reevaluate', { tenantId }, { tenantId, runAt: g!.grace_until, dedupeKey: `grace:${tenantId}:${new Date(g!.grace_until).toISOString()}` });
    }
  }

  /** Fin d'abonnement payant : retour Free si sous quotas, sinon lecture seule avec export. */
  private async endPaid(tx: Tx, tenantId: string, reason: string) {
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const fit = await this.entitlements.fitsFree(tx, tenantId);
    await tx.query(`UPDATE subscriptions SET plan_code='free', billing_interval=NULL, status=$2, provider_subscription_id=NULL,
                      provider_status=$3, current_period_end=NULL, grace_until=NULL, cancel_at_period_end=false, pending_change=NULL,
                      read_only_since = CASE WHEN $2='read_only' THEN now() ELSE NULL END, updated_at=now() WHERE tenant_id=$1`,
      [tenantId, fit.fits ? 'free' : 'read_only', reason]);
    await tx.query(`UPDATE subscription_addons SET status='cancelled', updated_at=now() WHERE tenant_id=$1`, [tenantId]);
    await this.audit.log(tx, { tenantId, action: 'billing.paid_ended', data: { reason, result: fit.fits ? 'free' : 'read_only', over: fit.over } });
  }

  /** Réévaluation : fin de grâce, sortie de lecture seule quand le volume tient dans Free. */
  async reevaluate(tenantId: string) {
    return this.db.tenantTx(tenantId, async (tx) => {
      const sub = await one(tx, `SELECT * FROM subscriptions WHERE tenant_id=$1 FOR UPDATE`, [tenantId]);
      const fit = await this.entitlements.fitsFree(tx, tenantId);
      if (sub.status === 'past_due' && sub.grace_until && new Date(sub.grace_until) < new Date()) {
        await tx.query(`UPDATE subscriptions SET status=$2, plan_code='free', read_only_since = CASE WHEN $2='read_only' THEN now() END, updated_at=now() WHERE tenant_id=$1`,
          [tenantId, fit.fits ? 'free' : 'read_only']);
        await this.audit.log(tx, { tenantId, action: 'billing.grace_expired', data: { result: fit.fits ? 'free' : 'read_only' } });
      } else if (sub.status === 'read_only' && fit.fits) {
        await tx.query(`UPDATE subscriptions SET status='free', read_only_since=NULL, updated_at=now() WHERE tenant_id=$1`, [tenantId]);
        await this.audit.log(tx, { tenantId, action: 'billing.back_to_free' });
      }
      return { status: (await one(tx, `SELECT status FROM subscriptions WHERE tenant_id=$1`, [tenantId]))!.status, over: fit.over };
    });
  }

  /** Rapprochement périodique avec le fournisseur (événements perdus ou désordonnés). */
  async reconcileAll() {
    const subs = await this.db.query(`SELECT tenant_id, provider_subscription_id FROM subscriptions WHERE provider_subscription_id IS NOT NULL AND provider=$1`, [this.provider.name]);
    for (const s of subs) {
      const state = await this.provider.retrieveSubscription(s.provider_subscription_id);
      await this.db.tx((tx) => this.applyState(tx, s.tenant_id, state, new Date()));
    }
    return subs.length;
  }

  async portalUrl(tenantId: string) {
    const [sub] = await this.db.query(`SELECT provider_customer_id FROM subscriptions WHERE tenant_id=$1`, [tenantId]);
    if (!sub.provider_customer_id || !this.provider.createPortalUrl) throw badRequest('no_portal', 'Portail de facturation indisponible.');
    return { url: await this.provider.createPortalUrl(sub.provider_customer_id, `${config.appUrl}/billing`) };
  }
}

export { PLANS };
