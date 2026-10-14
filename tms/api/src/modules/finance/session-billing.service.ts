import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit.service';
import { RequestContext } from '../../core/context';
import { fromCents, toCents } from '../../core/decimal';
import { Db, Tx, lock, many, one } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';
import { FinanceService } from './finance.service';

export type Basis = 'flat' | 'hours';
export interface BillingOptions { basis: Basis; absenceToClient?: boolean }
interface Line { key: string; enrollmentId: string | null; role: 'client' | 'funder'; payerId: string; label: string; cents: bigint; attended?: number; planned?: number }

/** Arrondi au centime le plus proche (moitié vers le haut), sans virgule flottante. */
const prorata = (cents: bigint, num: number, den: number) => den <= 0 ? cents : (2n * cents * BigInt(num) + BigInt(den)) / (2n * BigInt(den));
const fmtH = (m: number) => `${Math.floor(m / 60)} h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
const fr = (d: string | null) => d ? d.split('-').reverse().join('/') : '';

/** Éléments facturés encore valables : facture existante, non entièrement annulée par avoir. */
const LIVE_ITEMS = `
  SELECT bi.*, i.status AS invoice_status, i.number AS invoice_number, i.total_ttc,
         CASE WHEN i.status = 'issued' THEN i.total_ttc
           - coalesce((SELECT sum(cn.total_ttc) FROM invoices cn WHERE cn.credited_invoice_id = i.id AND cn.status = 'issued'), 0)
           - coalesce((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), 0) END AS balance,
         c.name AS payer_name
    FROM billing_items bi JOIN invoices i ON i.id = bi.invoice_id JOIN clients c ON c.id = bi.payer_client_id
   WHERE bi.session_id = $1
     AND NOT (i.status = 'issued' AND coalesce((SELECT sum(cn.total_ttc) FROM invoices cn WHERE cn.credited_invoice_id = i.id AND cn.status = 'issued'), 0) >= i.total_ttc)`;

/**
 * Facturation depuis la session : brouillons de factures par client et par financeur,
 * au forfait ou au prorata des heures émargées. Jamais d'émission automatique ;
 * aucune double facturation d'une même inscription pour un même payeur.
 */
@Injectable()
export class SessionBillingService {
  constructor(private db: Db, private finance: FinanceService, private audit: AuditService) {}

  private async compute(tx: Tx, sessionId: string, o: BillingOptions) {
    const s = await one(tx, `
      SELECT s.*, p.title AS program_title, coalesce(s.price_ht, v.price_ht) AS price, v.vat_rate, t.vat_regime,
             coalesce(s.price_basis, CASE WHEN s.kind = 'intra' THEN 'per_session' ELSE 'per_learner' END) AS basis_kind
        FROM training_sessions s JOIN program_versions v ON v.id = s.program_version_id JOIN programs p ON p.id = v.program_id JOIN tenants t ON t.id = s.tenant_id
       WHERE s.id = $1`, [sessionId]);
    if (!s) throw notFound('Session');
    const warnings: string[] = [];
    const skipped: { enrollmentId: string | null; name: string; reason: string }[] = [];
    if (s.price == null) throw badRequest('price_required', 'Aucun prix : renseignez le prix HT du programme ou de la session.', 'priceHt');
    const vatRate = s.vat_regime === 'exempt_261_4_4' ? '0' : String(s.vat_rate ?? '20');
    const price = toCents(s.price);
    const period = `${fr(s.starts_on)}${s.ends_on && s.ends_on !== s.starts_on ? ` au ${fr(s.ends_on)}` : ''}`;
    const title = `Formation « ${s.program_title} »${period ? ` — ${period.includes('au') ? 'du' : 'le'} ${period}` : ''}`;
    // Heures prévues (séances non annulées où l'apprenant est attendu) et heures émargées.
    const enrollments = await many(tx, `
      SELECT e.id, e.client_id, pe.first_name || ' ' || pe.last_name AS name,
             coalesce((SELECT sum(slot_pedagogical_minutes(sl.starts_at, sl.ends_at, sl.breaks)) FROM slot_expected x JOIN slots sl ON sl.id = x.slot_id
                        WHERE x.enrollment_id = e.id AND sl.status <> 'cancelled' AND x.mode IN ('onsite','remote') AND x.dates_ok), 0)::int AS planned,
             coalesce((SELECT sum(a.minutes) FROM attendance a JOIN slots sl ON sl.id = a.slot_id WHERE a.enrollment_id = e.id AND sl.status <> 'cancelled'), 0)::int AS attended,
             coalesce((SELECT json_agg(json_build_object('funderId', f.funder_client_id, 'amount', f.amount, 'name', c.name)) FROM funding_allocations f JOIN clients c ON c.id = f.funder_client_id WHERE f.enrollment_id = e.id), '[]') AS fundings
        FROM enrollments e JOIN persons pe ON pe.id = e.person_id WHERE e.session_id = $1 AND e.status <> 'cancelled' ORDER BY pe.last_name`, [sessionId]);
    const lines: Line[] = [];
    if (s.basis_kind === 'per_session') {
      // Forfait intra : client de la session, moins les prises en charge des financeurs.
      if (!s.client_id) throw badRequest('client_required', 'Session intra sans client : renseignez le client.');
      if (o.basis === 'hours') warnings.push('Forfait de session : facturé au forfait, la base « heures réalisées » ne s’applique qu’aux prix par apprenant.');
      let funded = 0n;
      for (const e of enrollments) for (const f of e.fundings) {
        const c = toCents(f.amount); funded += c;
        lines.push({ key: `${e.id}:funder:${f.funderId}`, enrollmentId: e.id, role: 'funder', payerId: f.funderId, label: `Prise en charge — ${title} — ${e.name}`, cents: c });
      }
      const rest = price - funded;
      if (rest < 0n) warnings.push('Prises en charge supérieures au prix de la session : vérifiez les financements.');
      if (rest > 0n) lines.push({ key: `session:client:${s.client_id}`, enrollmentId: null, role: 'client', payerId: s.client_id, label: `${title} — formation intra`, cents: rest });
    } else {
      for (const e of enrollments) {
        const hours = o.basis === 'hours';
        if (hours && !e.planned) { skipped.push({ enrollmentId: e.id, name: e.name, reason: 'aucune heure prévue (séances non planifiées)' }); continue; }
        const ratio = (c: bigint) => hours ? prorata(c, Math.min(e.attended, e.planned), e.planned) : c;
        const detail = hours ? ` — ${fmtH(Math.min(e.attended, e.planned))} réalisées sur ${fmtH(e.planned)}` : '';
        let fundedFull = 0n; let fundedDue = 0n;
        for (const f of e.fundings) {
          const full = toCents(f.amount); const due = ratio(full);
          fundedFull += full; fundedDue += due;
          if (due > 0n) lines.push({ key: `${e.id}:funder:${f.funderId}`, enrollmentId: e.id, role: 'funder', payerId: f.funderId, label: `Prise en charge — ${title} — ${e.name}${detail}`, cents: due, attended: e.attended, planned: e.planned });
        }
        // Reste à charge du client : prorata, ou (option) heures d'absence non prises en charge refacturées au client.
        const rest = hours && o.absenceToClient ? price - fundedDue : ratio(price - fundedFull);
        if (rest <= 0n) continue;
        if (!e.client_id) { skipped.push({ enrollmentId: e.id, name: e.name, reason: `reste à charge ${fromCents(rest)} € HT sans client payeur : désignez le client de l’inscription` }); continue; }
        lines.push({ key: `${e.id}:client:${e.client_id}`, enrollmentId: e.id, role: 'client', payerId: e.client_id, label: `${title} — ${e.name}${detail}${hours && o.absenceToClient && fundedFull ? ' (absences non prises en charge incluses)' : ''}`, cents: rest, attended: e.attended, planned: e.planned });
      }
      if (o.basis === 'hours' && enrollments.some((e) => e.attended === 0)) warnings.push('Certains apprenants n’ont aucune présence saisie : leur ligne est à 0 et n’est pas créée.');
    }
    const billed = await many(tx, LIVE_ITEMS, [sessionId]);
    const billedKeys = new Set(billed.map((b) => b.enrollment_id ? `${b.enrollment_id}:${b.role}:${b.payer_client_id}` : `session:${b.role}:${b.payer_client_id}`));
    return { s, vatRate, lines, billed, billedKeys, warnings, skipped };
  }

  /** État : non facturée, partielle, brouillons à émettre, facturée, réglée. */
  private state(lines: Line[], billed: any[], billedKeys: Set<string>, skipped = 0) {
    if (!billed.length) return lines.length || skipped ? 'not_billed' : 'nothing_to_bill';
    if (skipped) return 'partial';
    if (lines.some((l) => !billedKeys.has(l.key))) return 'partial';
    if (billed.some((b) => b.invoice_status === 'draft')) return 'drafts';
    return billed.every((b) => b.balance != null && toCents(b.balance) <= 0n) ? 'paid' : 'billed';
  }

  private group(c: Awaited<ReturnType<SessionBillingService['compute']>>, names: Map<string, string>) {
    const todo = c.lines.filter((l) => !c.billedKeys.has(l.key));
    const byPayer = new Map<string, Line[]>();
    for (const l of todo) { if (!byPayer.has(l.payerId)) byPayer.set(l.payerId, []); byPayer.get(l.payerId)!.push(l); }
    return [...byPayer.entries()].map(([payerId, ls]) => ({
      clientId: payerId, clientName: names.get(payerId) ?? '', role: ls.some((l) => l.role === 'funder') ? 'funder' : 'client',
      lines: ls.map((l) => ({ label: l.label, amountHt: fromCents(l.cents), enrollmentId: l.enrollmentId, role: l.role })), totalHt: fromCents(ls.reduce((a, l) => a + l.cents, 0n)),
    }));
  }

  get(ctx: RequestContext, sessionId: string, o: BillingOptions = { basis: 'flat' }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      let c;
      try { c = await this.compute(tx, sessionId, o); }
      catch (e: any) { if (e.code === 'price_required' || e.code === 'client_required') return { state: 'not_configured', message: e.message, invoices: [], billed: [], warnings: [], skipped: [] }; throw e; }
      const names = new Map((await many(tx, `SELECT id, name FROM clients WHERE id = ANY($1::uuid[])`, [c.lines.map((l) => l.payerId)])).map((r) => [r.id, r.name]));
      return {
        state: this.state(c.lines, c.billed, c.billedKeys, c.skipped.length), basis: o.basis, vatRate: c.vatRate, price: c.s.price,
        priceBasis: c.s.basis_kind, invoices: this.group(c, names), warnings: c.warnings, skipped: c.skipped,
        billed: c.billed.map((b) => ({ id: b.id, invoiceId: b.invoice_id, invoiceNumber: b.invoice_number, invoiceStatus: b.invoice_status, balance: b.balance, payer: b.payer_name, role: b.role, amountHt: b.amount_ht, basis: b.basis })),
      };
    });
  }

  /** Brouillons créés en une transaction (tout ou rien) ; relancer ne refacture rien de déjà facturé. */
  generate(ctx: RequestContext, sessionId: string, o: BillingOptions & { dueDate?: string | null }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await lock(tx, `billing:${sessionId}`);
      const c = await this.compute(tx, sessionId, o);
      const todo = c.lines.filter((l) => !c.billedKeys.has(l.key));
      if (!todo.length) throw conflict('nothing_to_bill', 'Rien à facturer : tout est déjà facturé (ou aucun montant dû).');
      const byPayer = new Map<string, Line[]>();
      for (const l of todo) { if (!byPayer.has(l.payerId)) byPayer.set(l.payerId, []); byPayer.get(l.payerId)!.push(l); }
      const created: any[] = [];
      for (const [payerId, ls] of byPayer) {
        const inv = await this.finance.createInvoice(ctx, { clientId: payerId, kind: 'invoice', sessionId, dueDate: o.dueDate ?? null,
          lines: ls.map((l) => ({ label: l.label, quantity: '1', unitPriceHt: fromCents(l.cents), vatRate: c.vatRate })) }, tx);
        for (const l of ls) {
          await tx.query(`INSERT INTO billing_items(tenant_id, session_id, enrollment_id, payer_client_id, role, invoice_id, amount_ht, basis, attended_minutes, planned_minutes)
                          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [ctx.tenantId, sessionId, l.enrollmentId, payerId, l.role, inv.id, fromCents(l.cents), o.basis, l.attended ?? null, l.planned ?? null]);
        }
        created.push({ id: inv.id, clientName: inv.client_name, totalHt: inv.total_ht, lines: ls.length });
      }
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'session.billing_generated', entityType: 'session', entityId: sessionId, data: { basis: o.basis, invoices: created.map((x) => x.id) } });
      return { created, warnings: c.warnings, skipped: c.skipped };
    });
  }

  /** Sessions terminées (ou dont la dernière date est passée) sans facturation complète. */
  toBill(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const rows = await many(tx, `
        SELECT s.id, s.title, s.reference, s.status, s.starts_on, s.ends_on, s.kind,
               (SELECT count(*) FROM enrollments e WHERE e.session_id = s.id AND e.status <> 'cancelled')::int AS learners
          FROM training_sessions s
         WHERE s.status IN ('completed','archived','in_progress') AND NOT s.is_historical AND (s.status <> 'in_progress' OR s.ends_on < current_date)
         ORDER BY s.ends_on DESC NULLS LAST LIMIT 200`);
      const out = [];
      for (const r of rows) {
        let st: string;
        try { const c = await this.compute(tx, r.id, { basis: 'flat' }); st = this.state(c.lines, c.billed, c.billedKeys, c.skipped.length); }
        catch { st = 'not_configured'; }
        if (['not_billed', 'partial', 'drafts', 'not_configured'].includes(st) && r.learners > 0) out.push({ ...r, billingState: st });
      }
      return out;
    });
  }
}
