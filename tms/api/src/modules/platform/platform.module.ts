import { Body, Controller, Get, Injectable, Module, OnModuleInit, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../../config';
import { AuditService } from '../../core/audit.service';
import { Ctx, NoTenant, RequestContext } from '../../core/context';
import { Db } from '../../core/db';
import { AppError, badRequest, conflict, notFound } from '../../core/errors';
import { JobsService } from '../../core/jobs.service';
import { StorageService } from '../../core/storage';
import { isoDate, parse } from '../../core/validation';
import { ADDONS, PLANS, PlanCode } from '../billing/catalog';
import { EntitlementsService } from '../billing/entitlements.service';

/** Accès réservé aux comptes éditeur (PLATFORM_ADMINS) ; réponse 404 pour tous les autres. */
export function isPlatformAdmin(ctx: { email: string; emailVerified: boolean }) {
  return ctx.emailVerified && config.platformAdmins.includes(ctx.email.toLowerCase());
}
const assertAdmin = (ctx: RequestContext) => { if (!isPlatformAdmin(ctx)) throw new AppError(404, 'not_found', 'introuvable'); };

/** Revenu mensuel récurrent HT (centimes) d'un abonnement : annuel ramené au mois. */
const MRR_SQL = `
  CASE WHEN s.status IN ('active','past_due') AND s.plan_code <> 'free' AND coalesce(s.provider, '') <> 'manual' THEN
    (CASE s.plan_code ${Object.values(PLANS).map((p) => `WHEN '${p.code}' THEN CASE WHEN s.billing_interval = 'year' THEN ${Math.round(p.yearlyPriceCents / 12)} ELSE ${p.monthlyPriceCents} END`).join(' ')} ELSE 0 END)
    + coalesce((SELECT sum(a.quantity * CASE a.addon_code ${Object.values(ADDONS).filter((a) => a.recurring).map((a) => `WHEN '${a.code}' THEN ${a.priceCents}`).join(' ')} ELSE 0 END)
                  FROM subscription_addons a WHERE a.tenant_id = s.tenant_id AND a.status = 'active'), 0)
  ELSE 0 END`;

const TENANT_SQL = `
  SELECT t.id, t.legal_name, t.siret, t.created_at, t.closed_at, t.signup_source,
         s.plan_code, s.status, s.billing_interval, s.provider, s.provider_customer_id, s.provider_subscription_id,
         s.current_period_end, s.trial_ends_at, s.grace_until, s.cancel_at_period_end, s.read_only_since,
         (${MRR_SQL})::int AS mrr_cents,
         (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id AND m.role IN ('owner','manager','accountant','importer') AND (m.expires_at IS NULL OR m.expires_at > now()))::int AS managers,
         (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id AND (m.expires_at IS NULL OR m.expires_at > now()))::int AS users,
         (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = t.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_email,
         (SELECT max(a.created_at) FROM auth_sessions a JOIN memberships m ON m.user_id = a.user_id WHERE m.tenant_id = t.id) AS last_login
    FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id`;

/**
 * Back-office éditeur : vue de tous les organismes, indicateurs d'abonnement et actions
 * commerciales tracées (essai, offre gratuite temporaire, retour Free, suspension).
 * Les données métier des organismes (apprenants, factures…) ne sont pas consultables :
 * seulement des compteurs d'usage.
 */
@Injectable()
export class PlatformService implements OnModuleInit {
  constructor(private db: Db, private audit: AuditService, private jobs: JobsService, private ent: EntitlementsService, private storage: StorageService) {}

  onModuleInit() {
    this.jobs.register('platform.comp_end', (p) => this.endComp(p.tenantId));
  }

  async overview() {
    const [totals] = await this.db.query(`
      SELECT count(*)::int AS tenants,
             count(*) FILTER (WHERE t.closed_at IS NULL)::int AS open,
             count(*) FILTER (WHERE t.closed_at IS NOT NULL)::int AS suspended,
             count(*) FILTER (WHERE s.status IN ('active','past_due') AND s.plan_code <> 'free' AND coalesce(s.provider,'') <> 'manual')::int AS paying,
             count(*) FILTER (WHERE s.status = 'trialing')::int AS trialing,
             count(*) FILTER (WHERE s.status = 'past_due')::int AS past_due,
             count(*) FILTER (WHERE s.status = 'read_only')::int AS read_only,
             count(*) FILTER (WHERE s.provider = 'manual' AND s.status = 'active')::int AS comped,
             coalesce(sum(${MRR_SQL}), 0)::int AS mrr_cents
        FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id`);
    const byPlan = await this.db.query(`SELECT coalesce(s.plan_code, 'free') AS plan, count(*)::int AS n FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id WHERE t.closed_at IS NULL GROUP BY 1 ORDER BY 2 DESC`);
    const months = await this.db.query(`
      WITH m AS (SELECT date_trunc('month', now()) - (g || ' months')::interval AS month FROM generate_series(0, 11) g)
      SELECT to_char(m.month, 'YYYY-MM') AS month,
             (SELECT count(*) FROM tenants t WHERE date_trunc('month', t.created_at) = m.month)::int AS signups,
             (SELECT count(DISTINCT a.tenant_id) FROM audit_events a WHERE a.action IN ('billing.upgraded','platform.paid_started') AND date_trunc('month', a.created_at) = m.month)::int AS upgrades,
             (SELECT count(*) FROM audit_events a WHERE a.action = 'billing.paid_ended' AND date_trunc('month', a.created_at) = m.month)::int AS churn
        FROM m ORDER BY m.month`);
    return { ...totals, byPlan, months, stripeMode: config.payment.provider === 'stripe' ? (config.payment.stripeSecretKey.startsWith('sk_live') ? 'live' : 'test') : 'simulation' };
  }

  list(q: { q?: string; status?: string; plan?: string; limit?: number; offset?: number }) {
    return this.db.query(`${TENANT_SQL}
      WHERE ($1::text IS NULL OR t.legal_name ILIKE $1 OR t.siret ILIKE $1 OR EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = t.id AND u.email ILIKE $1))
        AND ($2::text IS NULL OR ($2 = 'suspended' AND t.closed_at IS NOT NULL) OR s.status = $2)
        AND ($3::text IS NULL OR s.plan_code = $3)
      ORDER BY t.created_at DESC LIMIT $4 OFFSET $5`,
      [q.q ? `%${q.q.trim()}%` : null, q.status ?? null, q.plan ?? null, Math.min(q.limit ?? 100, 500), q.offset ?? 0]);
  }

  async detail(id: string) {
    const [t] = await this.db.query(`${TENANT_SQL} WHERE t.id = $1`, [id]);
    if (!t) throw notFound('Organisme');
    const members = await this.db.query(`SELECT u.email, u.full_name, m.role, m.expires_at, m.created_at,
                                                (SELECT max(a.created_at) FROM auth_sessions a WHERE a.user_id = u.id) AS last_login
                                           FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 ORDER BY m.created_at`, [id]);
    const addons = await this.db.query(`SELECT addon_code, quantity, status, updated_at FROM subscription_addons WHERE tenant_id = $1`, [id]);
    const events = await this.db.query(`SELECT a.action, a.data, a.created_at, u.email AS actor FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
                                         WHERE a.tenant_id = $1 AND (a.action LIKE 'billing.%' OR a.action LIKE 'platform.%' OR a.action LIKE 'support.%' OR a.action = 'account.signup')
                                         ORDER BY a.id DESC LIMIT 50`, [id]);
    const usage = await this.ent.usageSummary(id);
    const stripe = t.provider_customer_id && config.payment.provider === 'stripe'
      ? `https://dashboard.stripe.com/${config.payment.stripeSecretKey.startsWith('sk_live') ? '' : 'test/'}customers/${t.provider_customer_id}` : null;
    return { ...t, members, addons, events, quotas: usage.quotas, stripeUrl: stripe };
  }

  /**
   * Actions éditeur. Abonnement géré par Stripe : seules suspension et réactivation sont
   * possibles ici (le reste se fait dans Stripe, pour ne jamais diverger de la facturation).
   */
  async act(ctx: RequestContext, id: string, b: { action: 'trial' | 'comp' | 'free' | 'suspend' | 'reactivate'; plan?: PlanCode; until?: string | null; reason: string }) {
    return this.db.tx(async (tx) => {
      const [t] = (await tx.query(`SELECT t.*, s.status, s.provider, s.provider_subscription_id, s.plan_code FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id WHERE t.id = $1 FOR UPDATE OF t`, [id])).rows;
      if (!t) throw notFound('Organisme');
      const stripeManaged = !!t.provider_subscription_id && t.provider === 'stripe';
      if (['trial', 'comp', 'free'].includes(b.action) && stripeManaged) {
        throw conflict('stripe_managed', 'Abonnement payé via Stripe : modifiez-le dans Stripe (le webhook mettra l’application à jour).');
      }
      const until = b.until ? new Date(`${b.until}T23:59:59Z`) : null;
      if (until && until <= new Date()) throw badRequest('invalid_date', 'Date de fin dans le passé.', 'until');
      switch (b.action) {
        case 'trial':
          if (!b.plan || b.plan === 'free' || !until) throw badRequest('plan_required', 'Offre et date de fin d’essai requises.', 'plan');
          await tx.query(`UPDATE subscriptions SET plan_code = $2, status = 'trialing', trial_ends_at = $3, provider = coalesce(provider, 'manual'), read_only_since = NULL, updated_at = now() WHERE tenant_id = $1`, [id, b.plan, until]);
          break;
        case 'comp':
          if (!b.plan || b.plan === 'free') throw badRequest('plan_required', 'Offre requise.', 'plan');
          await tx.query(`UPDATE subscriptions SET plan_code = $2, status = 'active', provider = 'manual', billing_interval = NULL, current_period_end = $3,
                            grace_until = NULL, read_only_since = NULL, cancel_at_period_end = false, pending_change = NULL, updated_at = now() WHERE tenant_id = $1`, [id, b.plan, until]);
          if (until) await this.jobs.enqueue(tx, 'platform.comp_end', { tenantId: id }, { tenantId: id, runAt: until, dedupeKey: `comp_end:${id}:${until.toISOString()}` });
          break;
        case 'free':
          await this.toFree(tx, id, 'platform.back_to_free');
          break;
        case 'suspend':
          if (t.closed_at) throw conflict('already_suspended', 'Organisme déjà suspendu.');
          await tx.query(`UPDATE tenants SET closed_at = now() WHERE id = $1`, [id]);
          await tx.query(`UPDATE auth_sessions SET revoked_at = now() WHERE revoked_at IS NULL AND user_id IN (SELECT user_id FROM memberships WHERE tenant_id = $1)
                            AND NOT EXISTS (SELECT 1 FROM memberships m2 JOIN tenants t2 ON t2.id = m2.tenant_id WHERE m2.user_id = auth_sessions.user_id AND m2.tenant_id <> $1 AND t2.closed_at IS NULL)`, [id]);
          break;
        case 'reactivate':
          if (!t.closed_at) throw conflict('not_suspended', 'Organisme non suspendu.');
          await tx.query(`UPDATE tenants SET closed_at = NULL WHERE id = $1`, [id]);
          break;
      }
      await this.audit.log(tx, { tenantId: id, actor: ctx.userId, action: `platform.${b.action}`, data: { plan: b.plan, until: b.until, reason: b.reason, by: ctx.email } });
      return { ok: true };
    }).then(() => this.detail(id));
  }

  /** Retour Free si le volume le permet, sinon lecture seule (même règle qu'une fin d'abonnement). */
  private async toFree(tx: any, tenantId: string, action: string) {
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const fit = await this.ent.fitsFree(tx, tenantId);
    await tx.query(`UPDATE subscriptions SET plan_code = 'free', billing_interval = NULL, status = $2, provider = NULL, current_period_end = NULL, trial_ends_at = trial_ends_at,
                      grace_until = NULL, cancel_at_period_end = false, pending_change = NULL,
                      read_only_since = CASE WHEN $2 = 'read_only' THEN now() ELSE NULL END, updated_at = now() WHERE tenant_id = $1`, [tenantId, fit.fits ? 'free' : 'read_only']);
    await tx.query("SELECT set_config('app.tenant_id', '', true)");
    return fit;
  }

  /**
   * Suppression définitive d'un organisme (comptes de test, demande d'effacement) : toutes ses
   * données, ses fichiers et les comptes utilisateurs qui n'appartiennent à aucun autre organisme.
   * Irréversible ; confirmation par saisie exacte du nom ; refusée si un abonnement Stripe est en cours.
   */
  async purgeTenant(ctx: RequestContext, id: string, confirmName: string) {
    const removed = await this.db.tx(async (tx) => {
      const t = (await tx.query(`SELECT t.*, s.provider, s.status, s.provider_subscription_id FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id=t.id WHERE t.id=$1 FOR UPDATE OF t`, [id])).rows[0];
      if (!t) throw notFound('Organisme');
      if (confirmName.trim() !== t.legal_name) throw badRequest('confirm_mismatch', 'Le nom saisi ne correspond pas exactement au nom de l’organisme.', 'confirmName');
      if (t.provider === 'stripe' && t.provider_subscription_id && ['active', 'trialing', 'past_due'].includes(t.status)) {
        throw conflict('stripe_subscription_active', 'Abonnement Stripe en cours : résiliez-le d’abord dans Stripe (le webhook remettra l’organisme en Free), puis supprimez.');
      }
      const users = (await tx.query(`SELECT DISTINCT u.id, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1`, [id])).rows;
      await tx.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.tenant_purge', 'on', true)`, [id]);
      const tables: string[] = (await tx.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema
                                               WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE' AND c.table_name <> 'tenants'`)).rows.map((r: any) => r.table_name);
      const counts: Record<string, number> = {};
      // Suppression par passes : l'ordre des dépendances (clés étrangères) se résout sans liste à maintenir.
      let pending = tables;
      for (let pass = 0; pending.length && pass < 30; pass++) {
        const next: string[] = [];
        for (const table of pending) {
          await tx.query('SAVEPOINT purge');
          try {
            const r = await tx.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [id]);
            counts[table] = (counts[table] ?? 0) + (r.rowCount ?? 0);
            await tx.query('RELEASE SAVEPOINT purge');
          } catch (err: any) {
            await tx.query('ROLLBACK TO SAVEPOINT purge');
            if (err.code !== '23503') throw err;
            next.push(table);
          }
        }
        if (next.length === pending.length) throw conflict('purge_blocked', `Suppression impossible : dépendances non résolues (${next.join(', ')}).`);
        pending = next;
      }
      await tx.query(`DELETE FROM tenants WHERE id=$1`, [id]);
      // Comptes sans autre organisme (jamais un compte éditeur).
      const deletedUsers: string[] = [];
      for (const u of users) {
        if (config.platformAdmins.includes(String(u.email).toLowerCase())) continue;
        if ((await tx.query(`SELECT 1 FROM memberships WHERE user_id=$1 LIMIT 1`, [u.id])).rowCount) continue;
        await tx.query(`DELETE FROM invitations WHERE invited_by=$1`, [u.id]);
        await tx.query(`DELETE FROM users WHERE id=$1`, [u.id]);
        deletedUsers.push(u.email);
      }
      await tx.query(`SELECT set_config('app.tenant_id', '', true)`);
      await this.audit.log(tx, { tenantId: null as any, actor: ctx.userId, action: 'platform.tenant_deleted', entityType: 'tenant', entityId: id,
        data: { legalName: t.legal_name, by: ctx.email, deletedUsers, rows: Object.values(counts).reduce((a, n) => a + n, 0) } });
      return { deleted: true, legalName: t.legal_name, deletedUsers, rows: counts };
    });
    await this.storage.removeTree(id).catch(() => undefined);
    return removed;
  }

  /** Suppression d'un compte utilisateur sans organisme (ex. email de test réutilisable pour une nouvelle inscription). */
  async purgeUser(ctx: RequestContext, email: string) {
    return this.db.tx(async (tx) => {
      const u = (await tx.query(`SELECT id, email FROM users WHERE lower(email)=lower($1)`, [email.trim()])).rows[0];
      if (!u) throw notFound('Compte');
      if (config.platformAdmins.includes(String(u.email).toLowerCase())) throw conflict('platform_admin', 'Compte éditeur : suppression refusée.');
      const m = (await tx.query(`SELECT t.legal_name FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1`, [u.id])).rows;
      if (m.length) throw conflict('has_memberships', `Ce compte appartient encore à : ${m.map((x: any) => x.legal_name).join(', ')}. Supprimez d'abord ces organismes ou retirez-le de l'équipe.`);
      await tx.query(`DELETE FROM invitations WHERE invited_by=$1`, [u.id]);
      await tx.query(`DELETE FROM users WHERE id=$1`, [u.id]);
      await this.audit.log(tx, { tenantId: null as any, actor: ctx.userId, action: 'platform.user_deleted', data: { email: u.email, by: ctx.email } });
      return { deleted: true, email: u.email };
    });
  }

  /** Fin d'une offre offerte à durée limitée. */
  async endComp(tenantId: string) {
    await this.db.tx(async (tx) => {
      const [s] = (await tx.query(`SELECT provider, status, current_period_end FROM subscriptions WHERE tenant_id = $1 FOR UPDATE`, [tenantId])).rows;
      if (!s || s.provider !== 'manual' || s.status !== 'active' || !s.current_period_end || new Date(s.current_period_end) > new Date()) return;
      const fit = await this.toFree(tx, tenantId, 'platform.comp_ended');
      await this.audit.log(tx, { tenantId, action: 'platform.comp_ended', data: { result: fit.fits ? 'free' : 'read_only' } });
    });
  }
}

@Controller('api/v1/platform')
export class PlatformController {
  constructor(private s: PlatformService) {}

  @NoTenant() @Get('overview')
  overview(@Ctx() c: RequestContext) { assertAdmin(c); return this.s.overview(); }

  @NoTenant() @Get('tenants')
  list(@Ctx() c: RequestContext, @Query() q: unknown) {
    assertAdmin(c);
    return this.s.list(parse(z.object({ q: z.string().max(100).optional(), status: z.string().max(20).optional(), plan: z.string().max(20).optional(),
      limit: z.coerce.number().int().max(500).optional(), offset: z.coerce.number().int().min(0).optional() }), q));
  }

  @NoTenant() @Get('tenants/:id')
  detail(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string) { assertAdmin(c); return this.s.detail(id); }

  @NoTenant() @Post('tenants/:id/delete')
  purge(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    assertAdmin(c);
    return this.s.purgeTenant(c, id, parse(z.object({ confirmName: z.string().min(1).max(300) }), b).confirmName);
  }

  @NoTenant() @Post('users/delete')
  purgeUser(@Ctx() c: RequestContext, @Body() b: unknown) {
    assertAdmin(c);
    return this.s.purgeUser(c, parse(z.object({ email: z.string().email().max(200) }), b).email);
  }

  @NoTenant() @Post('tenants/:id/actions')
  act(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    assertAdmin(c);
    return this.s.act(c, id, parse(z.object({
      action: z.enum(['trial', 'comp', 'free', 'suspend', 'reactivate']), plan: z.enum(['free', 'solo', 'equipe', 'centre']).optional(),
      until: isoDate.nullable().optional(), reason: z.string().min(5, 'Motif obligatoire (5 caractères minimum)').max(500),
    }), b));
  }
}

@Module({ controllers: [PlatformController], providers: [PlatformService] })
export class PlatformModule {}
