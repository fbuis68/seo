import { Body, Controller, Get, Injectable, Module, OnModuleInit, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../../config';
import { AuditService } from '../../core/audit.service';
import { Ctx, RequestContext, RequirePermission } from '../../core/context';
import { Db, Tx, many, one } from '../../core/db';
import { badRequest, conflict } from '../../core/errors';
import { JobsService } from '../../core/jobs.service';
import { SystemMailer } from '../../core/system-mail';
import { parse } from '../../core/validation';
import { BillingProfileData, EXEMPTION_TEXT, currentProfile, profileProblems, saveProfile, validIban } from './billing-profile';
import { readiness } from './readiness';

/** Étapes de l'assistant (ONB 02), dans l'ordre. */
export const STEPS = [
  { key: 'company', label: 'Entreprise' }, { key: 'data', label: 'Données' }, { key: 'billing', label: 'Paramètres de facturation' },
  { key: 'check', label: 'Vérification' }, { key: 'first_invoice', label: 'Première facture' }, { key: 'finish', label: 'Finalisation' },
] as const;
type StepKey = (typeof STEPS)[number]['key'];
type StepState = 'to_do' | 'in_progress' | 'error' | 'to_validate' | 'done' | 'deferred';

const fmtNumber = (prefix: string, year: string, n: number) => `${prefix}${year}-${String(n).padStart(5, '0')}`;

/**
 * Mise en service (onboarding) : assistant persistant, progression calculée à partir des exigences
 * réellement satisfaites, jalons « Prêt à facturer » et « Reprise complète », relances d'inactivité.
 */
@Injectable()
export class OnboardingService implements OnModuleInit {
  constructor(private db: Db, private audit: AuditService, private jobs: JobsService, private mailer: SystemMailer) {}

  onModuleInit() {
    this.jobs.register('onboarding.remind', (p) => this.remind(p.tenantId, p.level));
  }

  /** Crée la session (idempotent) et programme les relances 24 h et 72 h d'inactivité. */
  async ensure(tx: Tx, tenantId: string) {
    const s = await one(tx, `INSERT INTO onboarding_sessions(tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING RETURNING *`, [tenantId]);
    if (s) await this.scheduleReminders(tx, tenantId, new Date());
    return s ?? (await one(tx, `SELECT * FROM onboarding_sessions WHERE tenant_id=$1`, [tenantId]));
  }

  private async scheduleReminders(tx: Tx, tenantId: string, from: Date) {
    for (const h of [24, 72]) {
      await this.jobs.enqueue(tx, 'onboarding.remind', { tenantId, level: h }, { tenantId, runAt: new Date(from.getTime() + h * 3600e3), dedupeKey: `onb:${tenantId}:${h}:${from.toISOString().slice(0, 13)}` });
    }
  }

  private async touch(tx: Tx, tenantId: string) {
    await tx.query(`UPDATE onboarding_sessions SET last_activity_at=now(), updated_at=now() WHERE tenant_id=$1`, [tenantId]);
  }

  async state(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, (tx) => this.compute(tx, ctx));
  }

  /** État calculé : étapes, progression, statut, jalons, suivi des reprises, diagnostic. */
  async compute(tx: Tx, ctx: { tenantId: string; permissions?: Set<string> }) {
    const s = await this.ensure(tx, ctx.tenantId);
    const t = (await one(tx, `SELECT legal_name, siret, address, currency FROM tenants WHERE id=$1`, [ctx.tenantId]))!;
    const ready = await readiness(tx, { permissions: ctx.permissions });
    const profile = await currentProfile(tx);
    const series = await one(tx, `SELECT prefix, next_number, legacy_last_number, cutover_on, confirmed_at FROM invoice_series WHERE code='FAC' AND NOT is_historical`);
    const counts = (await one(tx, `SELECT (SELECT count(*)::int FROM clients WHERE deleted_at IS NULL) clients, (SELECT count(*)::int FROM programs WHERE archived_at IS NULL) programs,
      (SELECT count(*)::int FROM training_sessions) sessions, (SELECT count(*)::int FROM memberships WHERE tenant_id=$1) members,
      (SELECT min(created_at) FROM invoices WHERE NOT is_historical) first_draft, (SELECT min(issue_date) FROM invoices WHERE status='issued' AND NOT is_historical) first_issue`, [ctx.tenantId]))!;
    const batches = await many(tx, `SELECT id, source_software, source_instance_id, status, created_at, published_at, simulation->'summary' summary, report->'perEntity' per_entity, created_by
                                      FROM import_batches ORDER BY created_at DESC LIMIT 20`);
    const deferred: string[] = s.deferred ?? [];
    const answers = s.answers ?? {};
    const addrOk = !!(t.address?.line1 && t.address?.postal_code && t.address?.city);

    const step: Record<StepKey, { state: StepState; requirements: { label: string; ok: boolean }[]; reason?: string }> = {} as any;
    const set = (k: StepKey, reqs: { label: string; ok: boolean }[], opts: { error?: string; toValidate?: boolean } = {}) => {
      const done = reqs.every((r) => r.ok);
      step[k] = { requirements: reqs, state: done ? 'done' : deferred.includes(k) ? 'deferred' : opts.error ? 'error' : opts.toValidate ? 'to_validate' : reqs.some((r) => r.ok) ? 'in_progress' : 'to_do', reason: opts.error };
    };
    set('company', [
      { label: 'Parcours choisi', ok: !!s.path }, { label: 'Raison sociale', ok: !!t.legal_name }, { label: 'Adresse complète', ok: addrOk },
      { label: 'SIRET', ok: /^\d{14}$/.test(t.siret ?? '') }, { label: 'Pays et devise', ok: !!(answers.country && t.currency) },
    ]);
    const published = batches.filter((b) => b.status === 'published');
    const failing = batches.find((b) => ['failed', 'rejected'].includes(b.status));
    const pendingImport = batches.find((b) => ['uploaded', 'detected', 'mapped', 'simulated', 'committing'].includes(b.status));
    set('data', s.path === 'start' || !s.path
      ? [{ label: 'Au moins un client', ok: counts.clients > 0 }, { label: 'Au moins une formation au catalogue', ok: counts.programs > 0 }]
      : [{ label: 'Données reprises (lot publié)', ok: published.length > 0 }, { label: 'Au moins un client', ok: counts.clients > 0 }],
    { error: failing && !published.length ? 'Un dépôt a été refusé : voir le rapport de reprise.' : undefined, toValidate: !!pendingImport && pendingImport.status === 'simulated' });
    const pp = profile ? profileProblems(profile.data) : ['Profil non renseigné'];
    set('billing', [
      { label: 'Régime de TVA et conditions de paiement renseignés', ok: !pp.length },
      { label: 'Règles fiscales confirmées', ok: !!profile?.confirmed_at }, { label: 'Numérotation validée', ok: !!series?.confirmed_at },
    ], { toValidate: !pp.length && (!profile?.confirmed_at || !series?.confirmed_at) });
    set('check', [{ label: 'Diagnostic : prêt à émettre', ok: ready.canIssue }], { error: ready.canIssue ? undefined : ready.blocking.map((c) => c.message).join(' ') });
    set('first_invoice', [{ label: 'Premier brouillon réel', ok: !!counts.first_draft }]);
    set('finish', [
      { label: 'Équipe invitée (facultatif)', ok: counts.members > 1 || deferred.includes('invite') },
      { label: 'Reprise complète validée ou sans objet', ok: !!s.complete_at || s.path === 'start' || deferred.includes('history') },
    ]);

    // Jalons (horodatés une seule fois).
    const now = new Date().toISOString();
    const readyNow = ready.canIssue && step.data.state === 'done';
    const milestones = {
      first_draft_at: s.first_draft_at ?? counts.first_draft ?? null,
      first_issue_at: s.first_issue_at ?? (counts.first_issue ? new Date(counts.first_issue).toISOString() : null),
      ready_at: s.ready_at ?? (readyNow ? now : null),
      complete_at: s.complete_at,
    };
    const status = s.closed_at ? (s.complete_at ? 'complete' : 'ready') : milestones.complete_at ? 'complete' : readyNow ? 'ready'
      : step.check.state !== 'done' && step.billing.state !== 'to_do' ? (step.billing.state === 'done' ? 'validation' : 'configuration')
        : pendingImport ? 'import' : s.path ? 'collect' : 'new';
    if (milestones.first_draft_at !== s.first_draft_at || milestones.first_issue_at !== s.first_issue_at || milestones.ready_at !== s.ready_at || status !== s.status) {
      await tx.query(`UPDATE onboarding_sessions SET first_draft_at=$2, first_issue_at=$3, ready_at=$4, status=$5, updated_at=now() WHERE tenant_id=$1`,
        [ctx.tenantId, milestones.first_draft_at, milestones.first_issue_at, milestones.ready_at, status]);
    }
    const reqs = Object.values(step).flatMap((x) => x.requirements);
    const progress = Math.round((reqs.filter((r) => r.ok).length / reqs.length) * 100);
    const current = STEPS.find((x) => !['done', 'deferred'].includes(step[x.key].state))?.key ?? 'finish';
    // Estimation révisable : ~5 min par exigence restante des étapes obligatoires.
    const remainingMinutes = reqs.filter((r) => !r.ok).length * 5;
    return {
      session: { path: s.path, answers, deferred, version: s.version, closedAt: s.closed_at, lastActivityAt: s.last_activity_at },
      status, progress, current, remainingMinutes, milestones,
      steps: STEPS.map((x) => ({ ...x, ...step[x.key] })),
      readiness: ready,
      billing: { profile: profile ? { version: profile.version, data: profile.data, confirmedAt: profile.confirmed_at, problems: pp } : null, series, exemptionTexts: EXEMPTION_TEXT },
      imports: batches.map((b) => ({ id: b.id, source: b.source_software, instance: b.source_instance_id, status: b.status, createdAt: b.created_at, publishedAt: b.published_at,
        summary: b.per_entity ?? b.summary ?? null })),
      counts,
    };
  }

  update(ctx: RequestContext, b: { version: number; path?: string; answers?: Record<string, unknown> }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await this.ensure(tx, ctx.tenantId);
      const r = await one(tx, `UPDATE onboarding_sessions SET path=coalesce($3, path), answers = answers || $4::jsonb, version=version+1, last_activity_at=now(), updated_at=now()
                               WHERE tenant_id=$1 AND version=$2 RETURNING version`, [ctx.tenantId, b.version, b.path ?? null, JSON.stringify(b.answers ?? {})]);
      if (!r) throw conflict('version_conflict', 'Modifié depuis un autre appareil : rechargez pour reprendre la dernière version.');
      // Devise et pays repris dans l'organisme quand ils sont fournis.
      if (b.answers?.currency) await tx.query(`UPDATE tenants SET currency=$2 WHERE id=$1`, [ctx.tenantId, String(b.answers.currency).toUpperCase().slice(0, 3)]);
      return this.compute(tx, ctx);
    });
  }

  defer(ctx: RequestContext, key: string, deferred: boolean) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await this.ensure(tx, ctx.tenantId);
      await tx.query(`UPDATE onboarding_sessions SET deferred = CASE WHEN $3 THEN (SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(deferred || to_jsonb($2::text)) x)
                                                               ELSE coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(deferred) x WHERE x <> to_jsonb($2::text)), '[]') END,
                        last_activity_at=now(), updated_at=now() WHERE tenant_id=$1`, [ctx.tenantId, key, deferred]);
      return this.compute(tx, ctx);
    });
  }

  close(ctx: RequestContext, b: { complete?: boolean }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await this.ensure(tx, ctx.tenantId);
      await tx.query(`UPDATE onboarding_sessions SET closed_at=now(), complete_at = CASE WHEN $2 THEN coalesce(complete_at, now()) ELSE complete_at END, updated_at=now() WHERE tenant_id=$1`, [ctx.tenantId, !!b.complete]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: b.complete ? 'onboarding.complete' : 'onboarding.closed' });
      return this.compute(tx, ctx);
    });
  }

  // ─── Profil de facturation ──────────────────────────────────────────────
  saveProfile(ctx: RequestContext, patch: BillingProfileData) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      if (patch.iban && !validIban(patch.iban)) throw badRequest('invalid_iban', 'IBAN invalide (clé de contrôle).', 'iban');
      const r = await saveProfile(tx, ctx.tenantId, ctx.userId, patch);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'billing_profile.saved', data: { version: r.version, invalidated: r.criticalChanged } });
      await this.touch(tx, ctx.tenantId);
      return this.compute(tx, ctx);
    });
  }

  confirmProfile(ctx: RequestContext, version: number) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const p = await currentProfile(tx);
      if (!p || p.version !== version) throw conflict('version_conflict', 'Le profil a changé : relisez la dernière version avant de confirmer.');
      const problems = profileProblems(p.data);
      if (problems.length) throw badRequest('profile_incomplete', problems.join(' '));
      await tx.query(`UPDATE billing_profile_versions SET confirmed_at=now(), confirmed_by=$2 WHERE id=$1`, [p.id, ctx.userId]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'billing_profile.confirmed', data: { version } });
      await this.touch(tx, ctx.tenantId);
      return this.compute(tx, ctx);
    });
  }

  // ─── Numérotation et bascule ────────────────────────────────────────────
  saveSeries(ctx: RequestContext, b: { prefix: string; nextNumber: number; legacyLastNumber?: string | null; cutoverOn?: string | null }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const s = await one(tx, `SELECT * FROM invoice_series WHERE code='FAC' AND NOT is_historical FOR UPDATE`);
      if (!s) throw conflict('series_missing', 'Série de factures absente.');
      const issued = await one(tx, `SELECT count(*)::int n FROM invoices WHERE series_code='FAC' AND status='issued'`);
      if (issued!.n > 0 && (b.prefix !== s.prefix || b.nextNumber < Number(s.next_number))) {
        throw conflict('series_in_use', 'Des factures ont déjà été émises : préfixe figé et numéro uniquement croissant.');
      }
      // Cohérence avec le dernier numéro de l'ancien outil (même schéma de numéro).
      const m = b.legacyLastNumber ? /(\d+)\s*$/.exec(b.legacyLastNumber) : null;
      if (m && b.legacyLastNumber!.startsWith(b.prefix) && b.nextNumber <= Number(m[1])) {
        throw badRequest('series_overlap', `Le prochain numéro (${b.nextNumber}) doit être supérieur au dernier numéro de l'ancien outil (${m[1]}).`, 'nextNumber');
      }
      const year = (await one(tx, `SELECT (now() AT TIME ZONE timezone)::date::text d FROM tenants WHERE id=$1`, [ctx.tenantId]))!.d.slice(0, 4);
      const next = fmtNumber(b.prefix, year, b.nextNumber);
      const clash = await one(tx, `SELECT number, is_historical FROM invoices WHERE number=$1 LIMIT 1`, [next]);
      if (clash) throw conflict('series_collision', `Le numéro ${next} existe déjà${clash.is_historical ? ' dans l’historique repris' : ''} : choisissez un prochain numéro supérieur.`);
      await tx.query(`UPDATE invoice_series SET prefix=$2, next_number=$3, legacy_last_number=$4, cutover_on=$5, confirmed_at=NULL, confirmed_by=NULL WHERE tenant_id=$1 AND code='FAC'`,
        [ctx.tenantId, b.prefix, b.nextNumber, b.legacyLastNumber ?? null, b.cutoverOn ?? null]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'invoice_series.saved', data: { ...b, next } });
      await this.touch(tx, ctx.tenantId);
      return this.compute(tx, ctx);
    });
  }

  confirmSeries(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await tx.query(`UPDATE invoice_series SET confirmed_at=now(), confirmed_by=$2 WHERE tenant_id=$1 AND code IN ('FAC','AV') AND NOT is_historical`, [ctx.tenantId, ctx.userId]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'invoice_series.confirmed' });
      await this.touch(tx, ctx.tenantId);
      return this.compute(tx, ctx);
    });
  }

  readiness(ctx: RequestContext, invoiceId?: string) {
    return this.db.tenantTx(ctx.tenantId, (tx) => readiness(tx, { permissions: ctx.permissions, invoiceId }));
  }

  /** Relance d'inactivité (ONB 04) : au plus une par palier, arrêtée à la clôture ou une fois prêt à facturer. */
  async remind(tenantId: string, level: number) {
    await this.db.tenantTx(tenantId, async (tx) => {
      const s = await one(tx, `SELECT * FROM onboarding_sessions WHERE tenant_id=$1 FOR UPDATE`, [tenantId]);
      if (!s || s.closed_at || s.ready_at || s.status === 'ready' || s.status === 'complete') return;
      const idleH = (Date.now() - new Date(s.last_activity_at).getTime()) / 3600e3;
      const already = level === 24 ? s.reminders_sent >= 1 : s.reminders_sent >= 2;
      if (already) return;
      if (idleH < level - 0.5) { await this.scheduleReminders(tx, tenantId, new Date(s.last_activity_at)); return; }
      const st = await this.compute(tx, { tenantId });
      const next = st.steps.find((x) => x.key === st.current)!;
      const owners = (await tx.query(`SELECT u.email, u.full_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.role IN ('owner','accountant')`, [tenantId])).rows;
      for (const o of owners) {
        try {
          await this.mailer.send({ to: o.email, subject: `Votre mise en service : ${st.progress} % — prochaine étape « ${next.label} »`,
            text: `Bonjour ${o.full_name},\n\nVotre espace est prêt à ${st.progress} %. Prochaine étape : ${next.label}.\n${next.reason ? `Point bloquant : ${next.reason}\n` : ''}\nReprendre là où vous vous êtes arrêté : ${config.appUrl}/onboarding\n\nBesoin d'aide ? Répondez à cet email.` });
        } catch (err: any) { console.error(`[onboarding] relance non envoyée à ${o.email} : ${err.message}`); }
      }
      await tx.query(`UPDATE onboarding_sessions SET reminders_sent = $2 WHERE tenant_id=$1`, [tenantId, level === 24 ? 1 : 2]);
      await this.audit.log(tx, { tenantId, action: 'onboarding.reminder_sent', data: { level } });
    });
  }
}

const profileSchema = z.object({
  vatRegime: z.enum(['subject', 'exempt_261_4_4', 'franchise_293b']).optional(),
  exemptionReason: z.string().max(300).nullable().optional(), vatNumber: z.string().max(20).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(120).optional(), paymentMethods: z.array(z.string().max(40)).max(10).optional(),
  latePenalty: z.string().max(200).nullable().optional(), fixedIndemnity: z.number().min(0).max(1000).optional(),
  showBankDetails: z.boolean().optional(), iban: z.string().max(40).nullable().optional(), bic: z.string().max(11).nullable().optional(), bankName: z.string().max(80).nullable().optional(),
  contactEmail: z.string().email().max(200).nullable().optional(), contactPhone: z.string().max(30).nullable().optional(), footer: z.string().max(500).nullable().optional(),
  einvoiceRequired: z.boolean().optional(),
});

@Controller('api/v1')
export class OnboardingController {
  constructor(private s: OnboardingService) {}

  @Get('onboarding') get(@Ctx() c: RequestContext) { return this.s.state(c); }

  @RequirePermission('org.manage') @Patch('onboarding')
  update(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.s.update(c, parse(z.object({
      version: z.number().int(), path: z.enum(['start', 'excel', 'migrate']).optional(),
      answers: z.object({
        activity: z.string().max(200).optional(), country: z.string().max(2).optional(), currency: z.string().length(3).optional(),
        companies: z.number().int().min(1).max(1000).optional(), previousTool: z.string().max(100).optional(), volume: z.string().max(50).optional(), goal: z.string().max(300).optional(),
      }).optional(),
    }), b) as any);
  }

  @RequirePermission('org.manage') @Post('onboarding/defer')
  defer(@Ctx() c: RequestContext, @Body() b: unknown) { const p = parse(z.object({ key: z.string().max(30), deferred: z.boolean().default(true) }), b); return this.s.defer(c, p.key, p.deferred); }

  @RequirePermission('org.manage') @Post('onboarding/close')
  close(@Ctx() c: RequestContext, @Body() b: unknown) { return this.s.close(c, parse(z.object({ complete: z.boolean().optional() }), b ?? {})); }

  @RequirePermission('finance.write') @Put('billing-profile')
  saveProfile(@Ctx() c: RequestContext, @Body() b: unknown) { return this.s.saveProfile(c, parse(profileSchema, b) as BillingProfileData); }

  @RequirePermission('invoices.issue') @Post('billing-profile/confirm')
  confirmProfile(@Ctx() c: RequestContext, @Body() b: unknown) { return this.s.confirmProfile(c, parse(z.object({ version: z.number().int() }), b).version); }

  @RequirePermission('finance.write') @Put('invoice-series')
  saveSeries(@Ctx() c: RequestContext, @Body() b: unknown) {
    return this.s.saveSeries(c, parse(z.object({
      prefix: z.string().min(1).max(12).regex(/^[A-Za-z0-9_\-/]+$/, 'Lettres, chiffres, - _ / uniquement'), nextNumber: z.number().int().min(1).max(99999999),
      legacyLastNumber: z.string().max(40).nullable().optional(), cutoverOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }), b));
  }

  @RequirePermission('invoices.issue') @Post('invoice-series/confirm') confirmSeries(@Ctx() c: RequestContext) { return this.s.confirmSeries(c); }

  @RequirePermission('finance.read') @Get('billing-readiness')
  readiness(@Ctx() c: RequestContext, @Query('invoiceId') invoiceId?: string) {
    if (invoiceId && !/^[0-9a-f-]{36}$/i.test(invoiceId)) throw badRequest('invalid_id', 'Identifiant invalide.');
    return this.s.readiness(c, invoiceId);
  }
}

@Module({ controllers: [OnboardingController], providers: [OnboardingService], exports: [OnboardingService] })
export class OnboardingModule {}
