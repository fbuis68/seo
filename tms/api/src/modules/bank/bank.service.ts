import { Inject, Injectable } from '@nestjs/common';
import { config } from '../../config';
import { AuditService } from '../../core/audit.service';
import { RequestContext } from '../../core/context';
import { openSecret, randomToken, sealSecret, sha256 } from '../../core/crypto';
import { fromCents, toCents } from '../../core/decimal';
import { Db, Tx, lock, many, one } from '../../core/db';
import { badRequest, conflict, notFound } from '../../core/errors';
import { JobsService } from '../../core/jobs.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { FinanceService } from '../finance/finance.service';
import { BANK_PROVIDER, BankProvider } from './bank.provider';

const norm = (s: string | null | undefined) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/**
 * Banque connectée (lecture seule) et rapprochement : propositions déterministes motivées,
 * validation humaine obligatoire, allocations auditées, transactions brutes jamais supprimées.
 */
@Injectable()
export class BankService {
  private states = new Map<string, { tenantId: string; userId: string; at: number }>();

  constructor(private db: Db, @Inject(BANK_PROVIDER) private provider: BankProvider, private ent: EntitlementsService,
    private finance: FinanceService, private jobs: JobsService, private audit: AuditService) {
    this.jobs.register('bank.sync', (p) => this.sync(p.tenantId, p.connectionId));
  }

  async startConnect(ctx: RequestContext) {
    await this.db.tenantTx(ctx.tenantId, (tx) => this.ent.assertQuota(tx, ctx.tenantId, 'bankInstitutions'));
    const state = randomToken(24);
    this.states.set(sha256(state), { tenantId: ctx.tenantId, userId: ctx.userId, at: Date.now() });
    return { url: await this.provider.createConnectUrl(state, `${config.appUrl}/bank/callback`) };
  }

  /** Retour du parcours de consentement : state vérifié (lié à l'utilisateur et à l'organisme). */
  async callback(ctx: RequestContext, code: string, state: string) {
    const s = this.states.get(sha256(state));
    this.states.delete(sha256(state));
    if (!s || s.tenantId !== ctx.tenantId || s.userId !== ctx.userId || Date.now() - s.at > 15 * 60e3) throw badRequest('invalid_state', 'Session de connexion bancaire invalide ou expirée.');
    const r = await this.provider.exchange(code);
    const accounts = await this.provider.accounts(r.token, r.connectionId);
    const connId = await this.db.tenantTx(ctx.tenantId, async (tx) => {
      const e = await this.ent.get(ctx.tenantId, tx);
      await this.ent.assertQuota(tx, ctx.tenantId, 'bankInstitutions', 1, e);
      const c = await one(tx, `INSERT INTO bank_connections(tenant_id, provider, provider_connection_id, institution, secret_enc, status, consent_expires_at, created_by)
                               VALUES ($1,$2,$3,$4,$5,'active',$6,$7) RETURNING id`, [ctx.tenantId, this.provider.name, r.connectionId, r.institution, sealSecret(r.token), r.consentExpiresAt, ctx.userId]);
      const used = Number((await one(tx, `SELECT count(*) n FROM bank_accounts a JOIN bank_connections c ON c.id=a.connection_id WHERE a.selected AND c.status <> 'revoked'`))!.n);
      let room = Math.max(0, e.limits.bankAccounts - used);
      for (const a of accounts) {
        await tx.query(`INSERT INTO bank_accounts(tenant_id, connection_id, provider_account_id, name, iban_masked, currency, balance, balance_at, selected) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [ctx.tenantId, c!.id, a.id, a.name, a.ibanMasked, a.currency, a.balance, a.balanceAt, room-- > 0]);
      }
      await tx.query(`INSERT INTO provider_refs(provider, kind, provider_id, tenant_id, entity_id) VALUES ($1,'bank_connection',$2,$3,$4) ON CONFLICT DO NOTHING`, [this.provider.name, r.connectionId, ctx.tenantId, c!.id]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'bank.connected', entityType: 'bank_connection', entityId: c!.id, data: { institution: r.institution, accounts: accounts.length } });
      return c!.id as string;
    });
    await this.sync(ctx.tenantId, connId);
    return this.connections(ctx);
  }

  connections(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT c.id, c.provider, c.institution, c.status, c.consent_expires_at, c.last_sync_at, c.last_error,
      (SELECT json_agg(json_build_object('id',a.id,'name',a.name,'iban_masked',a.iban_masked,'currency',a.currency,'balance',a.balance,'balance_at',a.balance_at,'selected',a.selected)) FROM bank_accounts a WHERE a.connection_id=c.id) accounts
      FROM bank_connections c ORDER BY c.created_at`));
  }

  /** Synchronisation paginée sur curseur ; pending/booked mis à jour sans doublon ; droits revérifiés. */
  async sync(tenantId: string, connectionId: string) {
    const conn = await this.db.tenantTx(tenantId, (tx) => one(tx, `SELECT * FROM bank_connections WHERE id=$1`, [connectionId]));
    if (!conn || conn.status !== 'active') return { skipped: true };
    const e = await this.ent.get(tenantId);
    if (!e.features.includes('bank')) {
      await this.db.tenantTx(tenantId, (tx) => tx.query(`UPDATE bank_connections SET last_error='Option banque inactive : synchronisation suspendue' WHERE id=$1`, [connectionId]));
      return { skipped: true };
    }
    const token = openSecret(conn.secret_enc);
    const accounts = await this.db.tenantTx(tenantId, (tx) => many(tx, `SELECT * FROM bank_accounts WHERE connection_id=$1 AND selected`, [connectionId]));
    let upserts = 0;
    try {
      for (const acc of accounts) {
        let cursor: string | null = null;
        do {
          const page = await this.provider.transactions(token, acc.provider_account_id, cursor);
          await this.db.tenantTx(tenantId, async (tx) => {
            for (const t of page.items) {
              await tx.query(`INSERT INTO bank_transactions(tenant_id, account_id, provider_tx_id, status, amount, currency, booked_on, value_on, label, counterparty, raw, provider_version)
                              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                              ON CONFLICT (account_id, provider_tx_id) DO UPDATE SET status=EXCLUDED.status, amount=EXCLUDED.amount, booked_on=EXCLUDED.booked_on,
                                label=EXCLUDED.label, counterparty=EXCLUDED.counterparty, raw=EXCLUDED.raw, provider_version=EXCLUDED.provider_version, updated_at=now()
                              WHERE bank_transactions.provider_version < EXCLUDED.provider_version OR bank_transactions.status <> EXCLUDED.status`,
                [tenantId, acc.id, t.id, t.status, t.amount, t.currency, t.bookedOn, t.valueOn, t.label, t.counterparty, JSON.stringify(t.raw), t.version]);
              upserts++;
            }
          });
          cursor = page.next;
        } while (cursor);
      }
      await this.db.tenantTx(tenantId, (tx) => tx.query(`UPDATE bank_connections SET last_sync_at=now(), last_error=NULL WHERE id=$1`, [connectionId]));
    } catch (err: any) {
      const reauth = /reauth|consent|expired/i.test(err.message);
      await this.db.tenantTx(tenantId, (tx) => tx.query(`UPDATE bank_connections SET status=$2, last_error=$3 WHERE id=$1`, [connectionId, reauth ? 'reauth_required' : 'active', err.message.slice(0, 300)]));
      if (!reauth) throw err;
    }
    return { upserts };
  }

  transactions(ctx: RequestContext, q: { status?: string; unreconciled?: boolean; limit: number; offset: number }) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT t.*, a.name account_name,
        t.amount - coalesce((SELECT sum(amount) FROM reconciliation_allocations r WHERE r.transaction_id=t.id AND r.reverted_at IS NULL),0) unreconciled
      FROM bank_transactions t JOIN bank_accounts a ON a.id=t.account_id
      WHERE ($1::text IS NULL OR t.status=$1)
        AND (NOT $2::boolean OR t.amount - coalesce((SELECT sum(amount) FROM reconciliation_allocations r WHERE r.transaction_id=t.id AND r.reverted_at IS NULL),0) > 0)
      ORDER BY t.booked_on DESC NULLS FIRST LIMIT $3 OFFSET $4`, [q.status ?? null, !!q.unreconciled, q.limit, q.offset]));
  }

  /**
   * Propositions déterministes : uniquement crédits "booked" ; référence de facture dans le libellé,
   * montant exact, payeur, proximité de dates. Jamais sur un simple nom similaire.
   */
  async suggestions(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const txs = await many(tx, `SELECT t.*, t.amount - coalesce((SELECT sum(amount) FROM reconciliation_allocations r WHERE r.transaction_id=t.id AND r.reverted_at IS NULL),0) remaining
        FROM bank_transactions t WHERE t.status='booked' AND t.amount > 0`);
      const invoices = await many(tx, `SELECT i.id, i.number, i.client_id, c.name client_name, i.currency, i.due_date, i.total_ttc
          - coalesce((SELECT sum(cn.total_ttc) FROM invoices cn WHERE cn.credited_invoice_id=i.id AND cn.status='issued'),0)
          - coalesce((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id=i.id),0) balance
        FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.status='issued' AND i.kind <> 'credit_note'`);
      const payments = await many(tx, `SELECT p.*, c.name client_name FROM payments p JOIN clients c ON c.id=p.client_id
        WHERE p.source='manual' AND NOT EXISTS (SELECT 1 FROM reconciliation_allocations r WHERE r.payment_id=p.id AND r.reverted_at IS NULL)`);
      const out = [];
      for (const t of txs.filter((x) => toCents(x.remaining) > 0n)) {
        const label = norm(`${t.label} ${t.counterparty ?? ''}`);
        const amount = toCents(t.remaining);
        const days = (d: string | null) => (d && t.booked_on ? Math.abs((Date.parse(d) - Date.parse(t.booked_on)) / 86400e3) : 999);
        const candidates: any[] = [];
        for (const p of payments) {
          if (p.currency !== t.currency || toCents(p.amount) !== amount) continue;
          const reasons = ['montant identique'];
          let score = 40;
          if (days(p.received_on) <= 10) { score += 20; reasons.push('dates proches'); }
          if (norm(p.client_name) && label.includes(norm(p.client_name))) { score += 25; reasons.push('payeur reconnu'); }
          if (p.reference && label.includes(norm(p.reference))) { score += 30; reasons.push('référence identique'); }
          candidates.push({ type: 'existing_payment', paymentId: p.id, clientId: p.client_id, clientName: p.client_name, amount: p.amount, score: Math.min(score, 100), reasons });
        }
        for (const i of invoices.filter((x) => toCents(x.balance) > 0n && x.currency === t.currency)) {
          const reasons: string[] = []; let score = 0;
          if (i.number && label.includes(norm(i.number))) { score += 60; reasons.push(`numéro de facture ${i.number} dans le libellé`); }
          if (toCents(i.balance) === amount) { score += 30; reasons.push('montant = reste dû'); }
          if (norm(i.client_name) && label.includes(norm(i.client_name))) { score += 15; reasons.push('payeur reconnu'); }
          // Exigence : référence ou montant exact, jamais le nom seul.
          if (!reasons.some((r) => r.startsWith('numéro') || r.startsWith('montant'))) continue;
          candidates.push({ type: 'invoice', invoiceId: i.id, number: i.number, clientId: i.client_id, clientName: i.client_name, balance: i.balance,
            proposedAmount: fromCents(amount < toCents(i.balance) ? amount : toCents(i.balance)), score: Math.min(score, 100), reasons });
        }
        candidates.sort((a, b) => b.score - a.score);
        if (candidates.length) out.push({ transaction: { id: t.id, label: t.label, amount: t.amount, remaining: t.remaining, booked_on: t.booked_on, currency: t.currency }, candidates: candidates.slice(0, 5) });
      }
      return out;
    });
  }

  /** Validation humaine : association à un règlement existant ou création d'un règlement alloué. */
  async reconcile(ctx: RequestContext, b: { transactionId: string; paymentId?: string; clientId?: string; allocations?: { invoiceId: string; amount: string }[] }) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      await lock(tx, `bank-tx:${b.transactionId}`);
      const t = await one(tx, `SELECT t.*, t.amount - coalesce((SELECT sum(amount) FROM reconciliation_allocations r WHERE r.transaction_id=t.id AND r.reverted_at IS NULL),0) remaining
                               FROM bank_transactions t WHERE t.id=$1 FOR UPDATE`, [b.transactionId]);
      if (!t) throw notFound('Transaction');
      if (t.status !== 'booked') throw conflict('transaction_not_booked', 'Seule une transaction comptabilisée (booked) peut justifier un règlement.');
      if (toCents(t.amount) <= 0n) throw badRequest('not_a_credit', 'Seuls les crédits peuvent être rapprochés de règlements clients.');
      let paymentId = b.paymentId; let amount: bigint;
      if (paymentId) {
        const p = await one(tx, `SELECT * FROM payments WHERE id=$1 FOR UPDATE`, [paymentId]);
        if (!p) throw notFound('Règlement');
        if (p.currency !== t.currency) throw badRequest('currency_mismatch', 'Devises différentes.');
        if (await one(tx, `SELECT 1 FROM reconciliation_allocations WHERE payment_id=$1 AND reverted_at IS NULL`, [paymentId])) throw conflict('already_reconciled', 'Règlement déjà rapproché.');
        amount = toCents(p.amount);
      } else {
        if (!b.clientId || !b.allocations?.length) throw badRequest('allocations_required', 'Client et affectations requis.');
        amount = b.allocations.reduce((a, x) => a + toCents(x.amount), 0n);
        const p = await this.finance.createPayment(ctx, { clientId: b.clientId, amount: fromCents(amount), receivedOn: t.booked_on, method: 'transfer', reference: t.label.slice(0, 140), currency: t.currency, allocations: b.allocations }, 'bank', tx);
        paymentId = p!.id;
      }
      if (amount > toCents(t.remaining)) throw badRequest('exceeds_transaction', `Montant (${fromCents(amount)}) supérieur au disponible de la transaction (${t.remaining}).`);
      const r = await one(tx, `INSERT INTO reconciliation_allocations(tenant_id, transaction_id, payment_id, amount, validated_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [ctx.tenantId, t.id, paymentId, fromCents(amount), ctx.userId]);
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'bank.reconciled', entityType: 'bank_transaction', entityId: t.id, data: { paymentId, amount: fromCents(amount) } });
      return r;
    });
  }

  /** Annulation d'un rapprochement : la transaction bancaire et le règlement sont conservés. */
  revert(ctx: RequestContext, allocationId: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const r = await one(tx, `UPDATE reconciliation_allocations SET reverted_at=now(), reverted_by=$2 WHERE id=$1 AND reverted_at IS NULL RETURNING *`, [allocationId, ctx.userId]);
      if (!r) throw notFound('Rapprochement');
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'bank.reconciliation_reverted', entityType: 'reconciliation', entityId: allocationId });
      return r;
    });
  }

  /** Retrait d'accès : synchronisation stoppée immédiatement ; données importées conservées (≠ suppression). */
  async disconnect(ctx: RequestContext, id: string) {
    const c = await this.db.tenantTx(ctx.tenantId, (tx) => one(tx, `SELECT * FROM bank_connections WHERE id=$1`, [id]));
    if (!c) throw notFound('Connexion bancaire');
    if (c.secret_enc) await this.provider.revoke(openSecret(c.secret_enc), c.provider_connection_id).catch(() => undefined);
    await this.db.tenantTx(ctx.tenantId, (tx: Tx) => tx.query(`UPDATE bank_connections SET status='revoked', secret_enc=NULL WHERE id=$1`, [id]));
    await this.audit.log(null, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'bank.disconnected', entityType: 'bank_connection', entityId: id });
    return { revoked: true, dataKept: true };
  }
}
