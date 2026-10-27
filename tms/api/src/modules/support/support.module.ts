import { Body, Controller, Get, Headers, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../../config';
import { AllowReadOnly, AllowUnverified, Ctx, NoTenant, RequestContext } from '../../core/context';
import { Db } from '../../core/db';
import { AppError, notFound } from '../../core/errors';
import { SystemMailer } from '../../core/system-mail';
import { parse } from '../../core/validation';
import { xlsxBuffer } from '../../core/xlsx';
import { isPlatformAdmin } from '../platform/platform.module';

const CAT: Record<string, string> = { bug: 'Bug', question: 'Question', evolution: 'Évolution' };
const SEV: Record<string, string> = { blocking: 'Bloquant', normal: 'Gênant', minor: 'Mineur' };
const STATUS: Record<string, string> = { new: 'Nouveau', in_progress: 'En cours', fixed: 'Corrigé', wont_fix: 'Non retenu', duplicate: 'Doublon' };
const ref = (n: number) => `TCK-${String(n).padStart(5, '0')}`;

/** Masque les données personnelles d'un texte (emails, téléphones, IBAN, n° de sécurité sociale) avant export. */
export function anonymize(s: unknown): string {
  return String(s ?? '')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/g, '[iban]')
    .replace(/\b[12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}(?:\s?\d{2})?\b/g, '[nir]')
    .replace(/(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}\b/g, '[tél]')
    .replace(/Bearer\s+[\w.-]+/gi, 'Bearer [jeton]');
}

const ticketSchema = z.object({
  screen: z.string().min(1).max(300), feature: z.string().max(200).optional(),
  category: z.enum(['bug', 'question', 'evolution']).default('bug'), severity: z.enum(['blocking', 'normal', 'minor']).default('normal'),
  message: z.string().min(5, 'Décrivez le problème (5 caractères minimum)').max(5000), expected: z.string().max(2000).optional(),
  context: z.object({
    url: z.string().max(500).optional(), userAgent: z.string().max(400).optional(), viewport: z.string().max(40).optional(), appBuild: z.string().max(80).optional(),
    errors: z.array(z.object({ at: z.string().max(40), method: z.string().max(10), path: z.string().max(300), status: z.number().int(), code: z.string().max(80).optional(), message: z.string().max(500).optional() })).max(10).optional(),
  }).default({}),
});

@Injectable()
export class SupportService {
  constructor(private db: Db, private mailer: SystemMailer) {}

  async create(ctx: RequestContext, b: z.infer<typeof ticketSchema>, tenantHeader?: string) {
    // Organisme facultatif (page sans espace, back-office) : retenu seulement si l'utilisateur en est membre.
    if (!ctx.tenantId && tenantHeader && /^[0-9a-f-]{36}$/i.test(tenantHeader)) {
      const [m] = await this.db.query(`SELECT role FROM memberships WHERE user_id=$1 AND tenant_id=$2`, [ctx.userId, tenantHeader]);
      if (m) ctx = { ...ctx, tenantId: tenantHeader, role: m.role };
    }
    const [t] = await this.db.query(`INSERT INTO support_tickets(tenant_id, user_id, role, screen, feature, category, severity, message, expected, context)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, number, status, created_at`,
      [ctx.tenantId || null, ctx.userId, ctx.role ?? null, b.screen, b.feature ?? null, b.category, b.severity, b.message.trim(), b.expected?.trim() || null,
        JSON.stringify({ ...b.context, server: { version: process.env.APP_VERSION ?? process.env.npm_package_version ?? null } })]);
    // Avis à l'éditeur (sans bloquer l'utilisateur si la messagerie est indisponible).
    const [org] = ctx.tenantId ? await this.db.query(`SELECT legal_name FROM tenants WHERE id=$1`, [ctx.tenantId]) : [null];
    for (const to of config.platformAdmins) {
      void this.mailer.send({ to, subject: `[${ref(t.number)}] ${SEV[b.severity]} · ${CAT[b.category]} · ${b.feature ?? b.screen}`,
        text: `Organisme : ${org?.legal_name ?? '—'}\nÉcran : ${b.screen}\n\n${b.message}\n\n${config.appUrl}/platform?ticket=${t.id}` }).catch(() => undefined);
    }
    return { id: t.id, ref: ref(t.number), status: t.status, createdAt: t.created_at };
  }

  async mine(ctx: RequestContext) {
    const rows = await this.db.query(`SELECT id, number, screen, feature, category, severity, message, status, resolution, created_at, updated_at FROM support_tickets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [ctx.userId]);
    return rows.map((r: any) => ({ ...r, ref: ref(r.number) }));
  }

  private async query(q: { status?: string; since?: string; tenantId?: string }) {
    const statuses = q.status === 'open' || !q.status ? ['new', 'in_progress'] : q.status === 'all' ? Object.keys(STATUS) : q.status.split(',');
    return this.db.query(`SELECT s.*, t.legal_name tenant_name, u.email user_email FROM support_tickets s LEFT JOIN tenants t ON t.id=s.tenant_id LEFT JOIN users u ON u.id=s.user_id
      WHERE s.status = ANY($1) AND ($2::timestamptz IS NULL OR s.created_at >= $2) AND ($3::uuid IS NULL OR s.tenant_id=$3)
      ORDER BY CASE s.severity WHEN 'blocking' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, s.created_at`, [statuses, q.since ?? null, q.tenantId ?? null]);
  }

  async list(q: { status?: string; since?: string; tenantId?: string }) {
    const rows = await this.query(q);
    const [counts] = await this.db.query(`SELECT count(*) FILTER (WHERE status='new')::int new, count(*) FILTER (WHERE status='in_progress')::int in_progress,
      count(*) FILTER (WHERE status IN ('new','in_progress') AND exported_at IS NULL)::int not_exported FROM support_tickets`);
    return { counts, tickets: rows.map((r: any) => ({ ...r, ref: ref(r.number) })) };
  }

  async update(id: string, b: { status?: string; resolution?: string | null }) {
    const [t] = await this.db.query(`UPDATE support_tickets SET status=coalesce($2,status), resolution=CASE WHEN $3::boolean THEN $4 ELSE resolution END, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, b.status ?? null, b.resolution !== undefined, b.resolution ?? null]);
    if (!t) throw notFound('Ticket');
    // Ticket clos : l'auteur est prévenu.
    if (b.status && ['fixed', 'wont_fix', 'duplicate'].includes(b.status) && t.user_id) {
      const [u] = await this.db.query(`SELECT email, full_name FROM users WHERE id=$1`, [t.user_id]);
      if (u) void this.mailer.send({ to: u.email, subject: `Votre signalement ${ref(t.number)} : ${STATUS[b.status].toLowerCase()}`,
        text: `Bonjour ${u.full_name},\n\nVotre signalement « ${String(t.message).slice(0, 120)} » est ${STATUS[b.status].toLowerCase()}.${t.resolution ? `\n\n${t.resolution}` : ''}\n\nMerci pour votre retour.` }).catch(() => undefined);
    }
    return { ...t, ref: ref(t.number) };
  }

  /** Récapitulatif à transmettre pour correction : Excel (2 onglets) ou Markdown, anonymisé par défaut. */
  async export(q: { status?: string; since?: string; anonymize?: boolean; markExported?: boolean; onlyNew?: boolean }, format: 'xlsx' | 'md') {
    let rows = await this.query(q);
    if (q.onlyNew) rows = rows.filter((r: any) => !r.exported_at);
    const a = (s: unknown) => (q.anonymize === false ? String(s ?? '') : anonymize(s));
    const who = (r: any) => (q.anonymize === false ? r.user_email ?? '' : `utilisateur ${String(r.user_id ?? '').slice(0, 8)}`);
    const errs = (r: any) => (r.context?.errors ?? []) as any[];
    if (q.markExported && rows.length) await this.db.query(`UPDATE support_tickets SET exported_at=now() WHERE id = ANY($1)`, [rows.map((r: any) => r.id)]);
    if (format === 'md') {
      const out = [`# Récapitulatif des signalements — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '',
        `${rows.length} ticket(s) · statut : ${q.status ?? 'open'}${q.since ? ` · depuis le ${q.since}` : ''}${q.anonymize === false ? '' : ' · données personnelles masquées'}`, ''];
      for (const r of rows) {
        out.push(`## ${ref(r.number)} — ${SEV[r.severity]} · ${CAT[r.category]} · ${a(r.feature ?? r.screen)}`, '',
          `- Date : ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC · Statut : ${STATUS[r.status]}`,
          `- Organisme : ${a(r.tenant_name ?? '—')} · Rôle : ${r.role ?? '—'} · ${who(r)}`,
          `- Écran : \`${r.screen}\`${r.context?.url ? ` · URL : \`${a(r.context.url)}\`` : ''}`,
          `- Navigateur : ${r.context?.userAgent ?? '—'}${r.context?.viewport ? ` · écran ${r.context.viewport}` : ''} · version ${r.context?.appBuild ?? r.context?.server?.version ?? '—'}`, '',
          '**Description**', '', a(r.message), '');
        if (r.expected) out.push('**Résultat attendu**', '', a(r.expected), '');
        if (errs(r).length) out.push('**Dernières erreurs serveur**', '', ...errs(r).map((e) => `- ${e.at} \`${e.method} ${a(e.path)}\` → ${e.status} ${e.code ?? ''} : ${a(e.message ?? '')}`), '');
        if (r.resolution) out.push(`**Suivi** : ${a(r.resolution)}`, '');
      }
      return Buffer.from(out.join('\n'), 'utf8');
    }
    const head = ['Réf.', 'Date (UTC)', 'Gravité', 'Type', 'Statut', 'Organisme', 'Utilisateur', 'Rôle', 'Écran', 'Fonction', 'Description', 'Résultat attendu', 'Dernière erreur', 'Navigateur', 'Version', 'Suivi'];
    const sheet1 = rows.map((r: any) => {
      const e = errs(r).slice(-1)[0];
      return [ref(r.number), new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' '), SEV[r.severity], CAT[r.category], STATUS[r.status], a(r.tenant_name ?? ''), who(r), r.role ?? '',
        r.screen, a(r.feature ?? ''), a(r.message), a(r.expected ?? ''), e ? `${e.method} ${a(e.path)} → ${e.status} ${e.code ?? ''} ${a(e.message ?? '')}` : '', r.context?.userAgent ?? '', r.context?.appBuild ?? r.context?.server?.version ?? '', a(r.resolution ?? '')];
    });
    const sheet2 = rows.flatMap((r: any) => errs(r).map((e) => [ref(r.number), e.at, e.method, a(e.path), String(e.status), e.code ?? '', a(e.message ?? '')]));
    return xlsxBuffer([
      { name: 'Tickets', rows: [head, ...sheet1] },
      { name: 'Erreurs techniques', rows: [['Réf.', 'Heure', 'Méthode', 'Adresse', 'Statut HTTP', 'Code', 'Message'], ...sheet2] },
    ]);
  }
}

const admin = (ctx: RequestContext) => { if (!isPlatformAdmin(ctx)) throw new AppError(404, 'not_found', 'introuvable'); };
const listQuery = z.object({ status: z.string().max(80).optional(), since: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(), tenantId: z.string().uuid().optional() });

@Controller('api/v1')
export class SupportController {
  constructor(private s: SupportService) {}

  /** « Signaler un problème » : tout utilisateur connecté, y compris en lecture seule. */
  @AllowReadOnly() @AllowUnverified() @NoTenant() @Post('support/tickets')
  create(@Ctx() c: RequestContext, @Body() b: unknown, @Headers('x-tenant-id') tenant?: string) { return this.s.create(c, parse(ticketSchema, b), tenant); }

  @AllowReadOnly() @AllowUnverified() @NoTenant() @Get('support/tickets')
  mine(@Ctx() c: RequestContext) { return this.s.mine(c); }

  @NoTenant() @Get('platform/tickets')
  list(@Ctx() c: RequestContext, @Query() q: unknown) { admin(c); return this.s.list(parse(listQuery, q)); }

  @NoTenant() @Patch('platform/tickets/:id')
  update(@Ctx() c: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    admin(c);
    return this.s.update(id, parse(z.object({ status: z.enum(['new', 'in_progress', 'fixed', 'wont_fix', 'duplicate']).optional(), resolution: z.string().max(2000).nullable().optional() }), b));
  }

  /** Récapitulatif : ?format=xlsx|md, status=open|all|…, since=AAAA-MM-JJ, anonymize=false, onlyNew=true, mark=true. */
  @NoTenant() @Get('platform/tickets/export')
  async export(@Ctx() c: RequestContext, @Query() q: unknown, @Res() res: any) {
    admin(c);
    const p = parse(listQuery.extend({
      format: z.enum(['xlsx', 'md']).default('xlsx'), anonymize: z.enum(['true', 'false']).default('true'), onlyNew: z.enum(['true', 'false']).default('false'), mark: z.enum(['true', 'false']).default('false'),
    }), q);
    const buf = await this.s.export({ status: p.status, since: p.since, anonymize: p.anonymize === 'true', onlyNew: p.onlyNew === 'true', markExported: p.mark === 'true' }, p.format);
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', p.format === 'md' ? 'text/markdown; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="signalements-${day}.${p.format}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  }
}

@Module({ controllers: [SupportController], providers: [SupportService] })
export class SupportModule {}
