import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit.service';
import { RequestContext } from '../../core/context';
import { fromCents, mulToCents, pctOfCents, toCents } from '../../core/decimal';
import { Db, Tx, lock, many, one } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';
import { CrmService } from '../crm/crm.service';
import { EINVOICE_PROVIDER, EInvoiceProvider } from './einvoice.provider';

export interface LineInput { label: string; quantity: string; unitPriceHt: string; vatRate: string }

export function computeLines(lines: LineInput[]) {
  let ht = 0n, vat = 0n;
  const out = lines.map((l, i) => {
    const lht = mulToCents(l.quantity, l.unitPriceHt);
    const lvat = pctOfCents(lht, l.vatRate);
    ht += lht; vat += lvat;
    return { position: i + 1, label: l.label, quantity: l.quantity, unit_price_ht: l.unitPriceHt, vat_rate: l.vatRate, total_ht: fromCents(lht), total_vat: fromCents(lvat) };
  });
  return { lines: out, totalHt: fromCents(ht), totalVat: fromCents(vat), totalTtc: fromCents(ht + vat) };
}

const BALANCE_SQL = `
  i.total_ttc
  - coalesce((SELECT sum(cn.total_ttc) FROM invoices cn WHERE cn.credited_invoice_id=i.id AND cn.status='issued'),0)
  - coalesce((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id=i.id),0)`;

/**
 * Finance : décimales exactes, facture émise immuable (trigger SQL), correction par avoir,
 * numérotation atomique par organisme et série, séries historiques séparées.
 */
@Injectable()
export class FinanceService {
  constructor(private db: Db, private crm: CrmService, private audit: AuditService, @Inject(EINVOICE_PROVIDER) private einvoice: EInvoiceProvider) {}

  listInvoices(ctx: RequestContext, q: { status?: string; clientId?: string; limit: number; offset: number }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `
      SELECT i.*, c.name client_name, CASE WHEN i.status='issued' AND i.kind <> 'credit_note' THEN ${BALANCE_SQL} END balance
        FROM invoices i JOIN clients c ON c.id=i.client_id
       WHERE ($1::text IS NULL OR i.status=$1) AND ($2::uuid IS NULL OR i.client_id=$2)
       ORDER BY coalesce(i.issue_date, i.created_at::date) DESC, i.number DESC NULLS FIRST LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.clientId ?? null, q.limit, q.offset]));
  }

  getInvoice(ctx: RequestContext, id: string, tx?: Tx) {
    const run = async (t: Tx) => {
      const inv = await one(t, `SELECT i.*, c.name client_name, c.billing_address, c.siret client_siret,
                                  CASE WHEN i.status='issued' AND i.kind <> 'credit_note' THEN ${BALANCE_SQL} END balance
                                  FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=$1`, [id]);
      if (!inv) throw notFound('Facture');
      inv.lines = await many(t, `SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY position`, [id]);
      inv.allocations = await many(t, `SELECT pa.*, p.received_on, p.method, p.reference FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.invoice_id=$1`, [id]);
      inv.credit_notes = await many(t, `SELECT id, number, total_ttc, status FROM invoices WHERE credited_invoice_id=$1`, [id]);
      return inv;
    };
    return tx ? run(tx) : this.db.tenantTx(ctx.tenantId, run);
  }

  async createInvoice(ctx: RequestContext, b: {
    clientId: string; kind: 'invoice' | 'deposit' | 'credit_note'; sessionId?: string | null; lines: LineInput[];
    dueDate?: string | null; creditedInvoiceId?: string | null; deductDepositIds?: string[]; currency?: string;
  }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const lines = [...b.lines];
      if (b.kind === 'credit_note') {
        if (!b.creditedInvoiceId) throw badRequest('credited_invoice_required', "Un avoir référence la facture d'origine.", 'creditedInvoiceId');
        const orig = await one(tx, `SELECT * FROM invoices WHERE id=$1 AND status='issued' AND kind <> 'credit_note'`, [b.creditedInvoiceId]);
        if (!orig || orig.client_id !== b.clientId) throw badRequest('invalid_credited_invoice', 'Facture d’origine émise du même client attendue.');
      }
      // Facture finale : déduction explicite des acomptes (lignes négatives) → aucun double comptage du CA.
      for (const depId of b.deductDepositIds ?? []) {
        const dep = await one(tx, `SELECT * FROM invoices WHERE id=$1 AND kind='deposit' AND status='issued' AND client_id=$2`, [depId, b.clientId]);
        if (!dep) throw badRequest('invalid_deposit', 'Acompte émis du même client attendu.', 'deductDepositIds');
        const used = await one(tx, `SELECT 1 FROM invoices WHERE deposit_of_invoice_id=$1`, [depId]);
        if (used) throw conflict('deposit_already_deducted', `Acompte ${dep.number} déjà déduit.`);
        for (const l of await many(tx, `SELECT * FROM invoice_lines WHERE invoice_id=$1`, [depId])) {
          lines.push({ label: `Acompte ${dep.number} déduit — ${l.label}`, quantity: '-1', unitPriceHt: l.total_ht, vatRate: l.vat_rate });
        }
      }
      const t = computeLines(lines);
      const currency = b.currency ?? (await one(tx, `SELECT currency FROM tenants WHERE id=$1`, [ctx.tenantId]))!.currency;
      const inv = await one(tx, `INSERT INTO invoices(tenant_id, kind, client_id, session_id, due_date, currency, total_ht, total_vat, total_ttc, credited_invoice_id, deposit_of_invoice_id)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [ctx.tenantId, b.kind, b.clientId, b.sessionId ?? null, b.dueDate ?? null, currency, t.totalHt, t.totalVat, t.totalTtc, b.creditedInvoiceId ?? null, b.deductDepositIds?.[0] ?? null]);
      for (const l of t.lines) await this.insertLine(tx, ctx.tenantId, inv!.id, l);
      return this.getInvoice(ctx, inv!.id, tx);
    });
  }

  private insertLine(tx: Tx, tenantId: string, invoiceId: string, l: ReturnType<typeof computeLines>['lines'][number]) {
    return tx.query(`INSERT INTO invoice_lines(tenant_id, invoice_id, position, label, quantity, unit_price_ht, vat_rate, total_ht, total_vat) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, invoiceId, l.position, l.label, l.quantity, l.unit_price_ht, l.vat_rate, l.total_ht, l.total_vat]);
  }

  updateDraft(ctx: RequestContext, id: string, b: { lines: LineInput[]; dueDate?: string | null }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const inv = await one(tx, `SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [id]);
      if (!inv) throw notFound('Facture');
      if (inv.status !== 'draft') throw conflict('invoice_immutable', 'Facture émise non modifiable : utiliser un avoir.');
      const t = computeLines(b.lines);
      await tx.query(`DELETE FROM invoice_lines WHERE invoice_id=$1`, [id]);
      for (const l of t.lines) await this.insertLine(tx, ctx.tenantId, id, l);
      await tx.query(`UPDATE invoices SET total_ht=$2, total_vat=$3, total_ttc=$4, due_date=coalesce($5, due_date) WHERE id=$1`, [id, t.totalHt, t.totalVat, t.totalTtc, b.dueDate ?? null]);
      return this.getInvoice(ctx, id, tx);
    });
  }

  /** Émission : numéro unique attribué sous verrou de série ; idempotente (réémission = même résultat). */
  issue(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const inv = await one(tx, `SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [id]);
      if (!inv) throw notFound('Facture');
      if (inv.status === 'issued') return this.getInvoice(ctx, id, tx);
      const n = await one(tx, `SELECT count(*) n FROM invoice_lines WHERE invoice_id=$1`, [id]);
      if (!Number(n!.n)) throw badRequest('empty_invoice', 'Facture sans ligne.');
      if (inv.kind === 'credit_note') {
        await lock(tx, `credit:${inv.credited_invoice_id}`);
        const orig = await one(tx, `SELECT total_ttc, (SELECT coalesce(sum(total_ttc),0) FROM invoices WHERE credited_invoice_id=$1 AND status='issued') credited FROM invoices WHERE id=$1`, [inv.credited_invoice_id]);
        if (toCents(orig!.credited) + toCents(inv.total_ttc) > toCents(orig!.total_ttc)) throw conflict('credit_exceeds_invoice', "Le total des avoirs dépasse le montant de la facture d'origine.");
      } else if (toCents(inv.total_ttc) < 0n) {
        throw badRequest('negative_invoice', 'Montant négatif : émettre un avoir.');
      }
      // Le client facturé consomme le quota "clients" (prospect → client).
      await this.crm.promoteToCustomer(tx, ctx.tenantId, inv.client_id);
      const series = inv.kind === 'credit_note' ? 'AV' : 'FAC';
      const s = await one(tx, `UPDATE invoice_series SET next_number = next_number + 1 WHERE tenant_id=$1 AND code=$2 AND NOT is_historical RETURNING prefix, next_number - 1 AS n`, [ctx.tenantId, series]);
      if (!s) throw conflict('series_missing', 'Série de numérotation indisponible.');
      const t = await one(tx, `SELECT (now() AT TIME ZONE timezone)::date today FROM tenants WHERE id=$1`, [ctx.tenantId]);
      const number = `${s.prefix}${String(t!.today).slice(0, 4)}-${String(s.n).padStart(5, '0')}`;
      await tx.query(`UPDATE invoices SET status='issued', series_code=$2, number=$3, issue_date=$4, due_date=coalesce(due_date, $4::date + 30) WHERE id=$1`,
        [id, series, number, t!.today]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'invoice.issued', entityType: 'invoice', entityId: id, data: { number, total_ttc: inv.total_ttc } });
      return this.getInvoice(ctx, id, tx);
    });
  }

  deleteDraft(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const inv = await one(tx, `SELECT status FROM invoices WHERE id=$1`, [id]);
      if (!inv) throw notFound('Facture');
      if (inv.status !== 'draft') throw conflict('invoice_immutable', 'Facture émise non supprimable.');
      await tx.query(`DELETE FROM invoice_lines WHERE invoice_id=$1`, [id]);
      await tx.query(`DELETE FROM invoices WHERE id=$1`, [id]);
      return { deleted: true };
    });
  }

  // ─── Règlements ─────────────────────────────────────────────────────────
  async allocate(tx: Tx, tenantId: string, paymentId: string, allocations: { invoiceId: string; amount: string }[]) {
    const pay = await one(tx, `SELECT * FROM payments WHERE id=$1 FOR UPDATE`, [paymentId]);
    if (!pay) throw notFound('Règlement');
    const already = await one(tx, `SELECT coalesce(sum(amount),0) s FROM payment_allocations WHERE payment_id=$1`, [paymentId]);
    let total = toCents(already!.s);
    for (const a of allocations) {
      const inv = await one(tx, `SELECT i.*, ${BALANCE_SQL} balance FROM invoices i WHERE i.id=$1 FOR UPDATE`, [a.invoiceId]);
      if (!inv || inv.status !== 'issued' || inv.kind === 'credit_note') throw badRequest('invalid_allocation', 'Affectation sur facture émise uniquement.');
      if (inv.client_id !== pay.client_id) throw badRequest('invalid_allocation', 'Facture et règlement de clients différents.');
      if (inv.currency !== pay.currency) throw badRequest('currency_mismatch', 'Devises différentes : conversion explicite requise.');
      const amt = toCents(a.amount);
      if (amt <= 0n || amt > toCents(inv.balance)) throw badRequest('allocation_exceeds_balance', `Montant affecté supérieur au reste dû (${inv.balance}).`);
      total += amt;
      await tx.query(`INSERT INTO payment_allocations(tenant_id, payment_id, invoice_id, amount) VALUES ($1,$2,$3,$4)`, [tenantId, paymentId, a.invoiceId, fromCents(amt)]);
    }
    if (total > toCents(pay.amount)) throw badRequest('allocation_exceeds_payment', 'Somme affectée supérieure au montant du règlement.');
  }

  createPayment(ctx: RequestContext, b: { clientId: string; amount: string; receivedOn: string; method?: string; reference?: string; currency?: string; allocations?: { invoiceId: string; amount: string }[] }, source: 'manual' | 'bank' = 'manual', tx?: Tx) {
    const run = async (t: Tx) => {
      const currency = b.currency ?? (await one(t, `SELECT currency FROM tenants WHERE id=$1`, [ctx.tenantId]))!.currency;
      const p = await one(t, `INSERT INTO payments(tenant_id, client_id, amount, currency, received_on, method, reference, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [ctx.tenantId, b.clientId, b.amount, currency, b.receivedOn, b.method ?? 'transfer', b.reference ?? null, source, ctx.userId]);
      if (b.allocations?.length) await this.allocate(t, ctx.tenantId, p!.id, b.allocations);
      await this.audit.log(t, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'payment.created', entityType: 'payment', entityId: p!.id, data: { amount: b.amount, source } });
      return p;
    };
    return tx ? run(tx) : this.db.tenantTx(ctx.tenantId, run);
  }

  addAllocations(ctx: RequestContext, paymentId: string, allocations: { invoiceId: string; amount: string }[]) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => { await this.allocate(tx, ctx.tenantId, paymentId, allocations); return this.getPayment(ctx, paymentId, tx); });
  }

  getPayment(ctx: RequestContext, id: string, tx?: Tx) {
    const run = async (t: Tx) => {
      const p = await one(t, `SELECT p.*, c.name client_name, p.amount - coalesce((SELECT sum(amount) FROM payment_allocations WHERE payment_id=p.id),0) unallocated
                                FROM payments p JOIN clients c ON c.id=p.client_id WHERE p.id=$1`, [id]);
      if (!p) throw notFound('Règlement');
      p.allocations = await many(t, `SELECT pa.*, i.number FROM payment_allocations pa JOIN invoices i ON i.id=pa.invoice_id WHERE pa.payment_id=$1`, [id]);
      return p;
    };
    return tx ? run(tx) : this.db.tenantTx(ctx.tenantId, run);
  }

  listPayments(ctx: RequestContext, q: { limit: number; offset: number }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT p.*, c.name client_name,
        p.amount - coalesce((SELECT sum(amount) FROM payment_allocations WHERE payment_id=p.id),0) unallocated
        FROM payments p JOIN clients c ON c.id=p.client_id ORDER BY p.received_on DESC LIMIT $1 OFFSET $2`, [q.limit, q.offset]));
  }

  // ─── Devis ──────────────────────────────────────────────────────────────
  createQuote(ctx: RequestContext, b: { clientId: string; sessionId?: string | null; lines: LineInput[]; validUntil?: string | null }) {
    const t = computeLines(b.lines);
    return this.db.tenantTx(ctx.tenantId, (tx) => one(tx, `INSERT INTO quotes(tenant_id, client_id, session_id, lines, total_ht, total_vat, total_ttc, valid_until)
                                                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ctx.tenantId, b.clientId, b.sessionId ?? null, JSON.stringify(t.lines), t.totalHt, t.totalVat, t.totalTtc, b.validUntil ?? null]));
  }

  setQuoteStatus(ctx: RequestContext, id: string, status: 'sent' | 'accepted' | 'refused') {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const q = await one(tx, `SELECT * FROM quotes WHERE id=$1 FOR UPDATE`, [id]);
      if (!q) throw notFound('Devis');
      const allowed: Record<string, string[]> = { draft: ['sent'], sent: ['accepted', 'refused'] };
      if (!(allowed[q.status] ?? []).includes(status)) throw conflict('invalid_transition', `Devis ${q.status} → ${status} impossible.`);
      let number = q.number;
      if (status === 'sent' && !number) {
        const s = await one(tx, `UPDATE invoice_series SET next_number=next_number+1 WHERE tenant_id=$1 AND code='DEV' RETURNING prefix, next_number-1 n`, [ctx.tenantId]);
        number = `${s!.prefix}${new Date().getFullYear()}-${String(s!.n).padStart(5, '0')}`;
      }
      return one(tx, `UPDATE quotes SET status=$2, number=$3 WHERE id=$1 RETURNING *`, [id, status, number]);
    });
  }

  listQuotes(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT q.*, c.name client_name FROM quotes q JOIN clients c ON c.id=q.client_id ORDER BY q.created_at DESC LIMIT 200`));
  }

  /** Devis accepté → facture brouillon (prévision ≠ CA facturé). */
  async quoteToInvoice(ctx: RequestContext, id: string) {
    const q = await this.db.tenantTx(ctx.tenantId, (tx) => one(tx, `SELECT * FROM quotes WHERE id=$1`, [id]));
    if (!q) throw notFound('Devis');
    if (q.status !== 'accepted') throw conflict('quote_not_accepted', 'Seul un devis accepté peut être facturé.');
    return this.createInvoice(ctx, { clientId: q.client_id, kind: 'invoice', sessionId: q.session_id,
      lines: q.lines.map((l: any) => ({ label: l.label, quantity: l.quantity, unitPriceHt: l.unit_price_ht, vatRate: l.vat_rate })) });
  }

  // ─── Facturation électronique (partenaire plateforme agréée) ─────────────
  async transmitEInvoice(ctx: RequestContext, id: string) {
    const inv = await this.getInvoice(ctx, id);
    if (inv.status !== 'issued') throw conflict('not_issued', 'Seule une facture émise peut être transmise.');
    if (inv.is_historical) throw conflict('historical_invoice', 'Facture historique reprise : jamais réémise.');
    if (inv.einvoice_provider_id && inv.einvoice_status !== 'rejected') return inv;
    const r = await this.einvoice.transmit({ tenantId: ctx.tenantId, invoice: inv, idempotencyKey: `einv:${id}:${inv.einvoice_status === 'rejected' ? Date.now() : 'first'}` });
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await tx.query(`UPDATE invoices SET einvoice_status=$2, einvoice_provider_id=$3, einvoice_reason=NULL WHERE id=$1`, [id, r.status, r.providerId]);
      await tx.query(`INSERT INTO provider_refs(provider, kind, provider_id, tenant_id, entity_id) VALUES ($1,'einvoice',$2,$3,$4) ON CONFLICT DO NOTHING`,
        [this.einvoice.name, r.providerId, ctx.tenantId, id]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'invoice.einvoice_transmitted', entityType: 'invoice', entityId: id, data: r });
      return this.getInvoice(ctx, id, tx);
    });
  }

  /** Statut retourné par le partenaire (webhook ou polling). */
  async applyEInvoiceStatus(providerId: string, status: string, reason?: string) {
    const [row] = await this.db.query(`SELECT tenant_id, entity_id FROM provider_refs WHERE provider=$1 AND kind='einvoice' AND provider_id=$2`, [this.einvoice.name, providerId]);
    if (!row) return;
    await this.db.tenantTx(row.tenant_id, (tx) => tx.query(`UPDATE invoices SET einvoice_status=$2, einvoice_reason=$3 WHERE id=$1`, [row.entity_id, status, reason ?? null]));
  }
}
