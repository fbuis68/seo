import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../core/context';
import { Db, Tx, many, one } from '../../core/db';
import { badRequest, forbidden } from '../../core/errors';
import { Permission } from '../../core/permissions';
import { METRICS, MetricKey } from './metrics';

export interface MetricQuery {
  metric: MetricKey; from: string; to: string; granularity: 'day' | 'month' | 'quarter' | 'year';
  currency?: string; programId?: string; clientId?: string; compare?: boolean; unit?: 'participants' | 'enrollments';
}

const REVENUE_ROWS = `
  SELECT i.id, i.number, i.kind, i.issue_date AS d, i.currency, i.client_id, c.name client_name,
         coalesce(s.program_id, so.program_id) program_id, coalesce(s.program_title, so.program_title) program_title,
         CASE WHEN i.kind='credit_note' THEN -i.total_ht ELSE i.total_ht END AS value
    FROM invoices i JOIN clients c ON c.id=i.client_id
    LEFT JOIN invoices o ON o.id=i.credited_invoice_id
    LEFT JOIN LATERAL (SELECT p.id program_id, p.title program_title FROM training_sessions ts JOIN program_versions v ON v.id=ts.program_version_id JOIN programs p ON p.id=v.program_id WHERE ts.id=i.session_id) s ON true
    LEFT JOIN LATERAL (SELECT p.id program_id, p.title program_title FROM training_sessions ts JOIN program_versions v ON v.id=ts.program_version_id JOIN programs p ON p.id=v.program_id WHERE ts.id=o.session_id) so ON true
   WHERE i.status='issued' AND NOT i.is_incomplete AND i.currency=$1 AND i.issue_date BETWEEN $2 AND $3`;

const CASH_ROWS = `
  SELECT p.id, p.received_on AS d, p.amount AS value, p.currency, p.client_id, c.name client_name, p.source, p.reference,
         EXISTS (SELECT 1 FROM reconciliation_allocations ra WHERE ra.payment_id=p.id AND ra.reverted_at IS NULL) bank_reconciled
    FROM payments p JOIN clients c ON c.id=p.client_id
   WHERE p.currency=$1 AND p.received_on BETWEEN $2 AND $3`;

/**
 * Agrégations backend uniques (pas de calcul divergent navigateur/IA).
 * Multi-devises : filtrage par devise, jamais d'addition EUR + autre devise.
 */
@Injectable()
export class AnalyticsService {
  constructor(private db: Db) {}

  definitions() { return METRICS; }

  private check(ctx: RequestContext, metric: MetricKey) {
    if (!METRICS[metric]) throw badRequest('unknown_metric', 'Métrique inconnue', 'metric');
    if (!ctx.permissions.has(METRICS[metric].requires as Permission)) throw forbidden('permission_denied', `Permission requise : ${METRICS[metric].requires}`);
  }

  private async currency(tx: Tx, ctx: RequestContext, q: { currency?: string }) {
    return q.currency ?? (await one(tx, `SELECT currency FROM tenants WHERE id=$1`, [ctx.tenantId]))!.currency;
  }

  private filters(q: MetricQuery, startIdx: number) {
    const where: string[] = []; const params: unknown[] = [];
    if (q.programId) { params.push(q.programId); where.push(`program_id = $${startIdx + params.length}`); }
    if (q.clientId) { params.push(q.clientId); where.push(`client_id = $${startIdx + params.length}`); }
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  async series(ctx: RequestContext, q: MetricQuery) {
    this.check(ctx, q.metric);
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const currency = await this.currency(tx, ctx, q);
      const run = async (from: string, to: string) => {
        let rowsSql: string;
        if (q.metric === 'revenue_net_ht') rowsSql = REVENUE_ROWS;
        else if (q.metric === 'cash_in_ttc') rowsSql = CASH_ROWS;
        else if (q.metric === 'learners') rowsSql = `
          SELECT ${q.unit === 'enrollments' ? 'e.id' : 'e.person_id'} AS ref, ts.starts_on AS d, $1::text cur, p.id program_id, ts.client_id
            FROM enrollments e JOIN training_sessions ts ON ts.id=e.session_id JOIN program_versions v ON v.id=ts.program_version_id JOIN programs p ON p.id=v.program_id
           WHERE e.status <> 'cancelled' AND ts.starts_on BETWEEN $2 AND $3`;
        else throw badRequest('metric_not_series', 'Métrique non disponible en série temporelle.');
        const f = this.filters(q, 4);
        const agg = q.metric === 'learners' ? 'count(DISTINCT r.ref)' : 'sum(r.value)';
        const rows = await many(tx, `
          WITH r AS (SELECT * FROM (${rowsSql}) x ${f.where}),
               periods AS (SELECT generate_series(date_trunc($4::text, $2::date), date_trunc($4::text, $3::date), ('1 ' || $4)::interval)::date p)
          SELECT to_char(periods.p, 'YYYY-MM-DD') period, coalesce(${agg}, 0)::text value
            FROM periods LEFT JOIN r ON date_trunc($4::text, r.d) = periods.p GROUP BY periods.p ORDER BY periods.p`,
          [currency, from, to, q.granularity, ...f.params]);
        return rows;
      };
      const current = await run(q.from, q.to);
      let previous: unknown[] | undefined;
      if (q.compare) {
        const shift = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
        previous = await run(shift(q.from), shift(q.to));
      }
      return {
        metric: q.metric, definition: METRICS[q.metric], currency: q.metric === 'learners' ? undefined : currency,
        filters: { from: q.from, to: q.to, granularity: q.granularity, programId: q.programId, clientId: q.clientId },
        series: current, previous, computedAt: new Date().toISOString(),
      };
    });
  }

  async breakdown(ctx: RequestContext, q: MetricQuery & { dimension: 'program' | 'client' | 'source' }) {
    this.check(ctx, q.metric);
    if (!['revenue_net_ht', 'cash_in_ttc'].includes(q.metric)) throw badRequest('unsupported', 'Répartition disponible pour CA et encaissements.');
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const currency = await this.currency(tx, ctx, q);
      const base = q.metric === 'revenue_net_ht' ? REVENUE_ROWS : CASH_ROWS;
      const key = q.dimension === 'client' ? 'client_name' : q.dimension === 'source' ? 'source' : 'program_title';
      if (q.dimension === 'program' && q.metric === 'cash_in_ttc') throw badRequest('unsupported', 'Encaissements non ventilés par programme.');
      const rows = await many(tx, `SELECT coalesce(${key}::text, 'Non affecté') label, sum(value)::text value FROM (${base}) r GROUP BY 1 ORDER BY sum(value) DESC`, [currency, q.from, q.to]);
      const hasNegative = rows.some((r) => Number(r.value) < 0);
      // Catégorie négative : un camembert serait trompeur → barres.
      return { metric: q.metric, dimension: q.dimension, currency, rows, chartHint: hasNegative ? 'bar' : 'pie', definition: METRICS[q.metric] };
    });
  }

  async receivables(ctx: RequestContext, currency?: string) {
    this.check(ctx, 'receivables');
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const cur = await this.currency(tx, ctx, { currency });
      const rows = await many(tx, `
        WITH b AS (
          SELECT i.id, i.number, i.due_date, c.name client_name, i.total_ttc
            - coalesce((SELECT sum(cn.total_ttc) FROM invoices cn WHERE cn.credited_invoice_id=i.id AND cn.status='issued'),0)
            - coalesce((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id=i.id),0) balance,
            (now()::date - i.due_date) days_late
          FROM invoices i JOIN clients c ON c.id=i.client_id
          WHERE i.status='issued' AND i.kind <> 'credit_note' AND NOT i.is_incomplete AND i.currency=$1)
        SELECT * FROM b WHERE balance > 0 ORDER BY due_date`, [cur]);
      const buckets = { not_due: 0n, d1_30: 0n, d31_60: 0n, d61_90: 0n, d90_plus: 0n } as Record<string, bigint>;
      for (const r of rows) {
        const cents = BigInt(Math.round(Number(r.balance) * 100));
        const k = r.days_late <= 0 ? 'not_due' : r.days_late <= 30 ? 'd1_30' : r.days_late <= 60 ? 'd31_60' : r.days_late <= 90 ? 'd61_90' : 'd90_plus';
        buckets[k] += cents;
      }
      const fmt = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
      return { currency: cur, buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, fmt(v)])), invoices: rows, bucketsVersion: 1, definition: METRICS.receivables };
    });
  }

  async fillRate(ctx: RequestContext, from: string, to: string) {
    this.check(ctx, 'fill_rate');
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `
      SELECT s.id, s.title, s.starts_on, s.capacity, count(e.id) FILTER (WHERE e.status='confirmed') confirmed,
             CASE WHEN s.capacity IS NULL THEN NULL ELSE round(count(e.id) FILTER (WHERE e.status='confirmed')::numeric / s.capacity, 4) END rate
        FROM training_sessions s LEFT JOIN enrollments e ON e.session_id=s.id
       WHERE s.status <> 'cancelled' AND s.starts_on BETWEEN $1 AND $2 GROUP BY s.id ORDER BY s.starts_on`, [from, to]));
  }

  /** Lignes justificatives d'un point de graphique (mêmes filtres, mêmes droits). */
  async drilldown(ctx: RequestContext, q: MetricQuery) {
    this.check(ctx, q.metric);
    if (!['revenue_net_ht', 'cash_in_ttc'].includes(q.metric)) throw badRequest('unsupported', 'Drill-down disponible pour CA et encaissements.');
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const currency = await this.currency(tx, ctx, q);
      const f = this.filters(q, 3);
      const rows = await many(tx, `SELECT * FROM (${q.metric === 'revenue_net_ht' ? REVENUE_ROWS : CASH_ROWS}) r ${f.where} ORDER BY d`, [currency, q.from, q.to, ...f.params]);
      return { metric: q.metric, currency, rows, total: rows.reduce((a, r) => a + Math.round(Number(r.value) * 100), 0) / 100 };
    });
  }

  /** Accueil : cartes essentielles. */
  async dashboard(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const cur = await this.currency(tx, ctx, {});
      const year = new Date().getFullYear();
      const cards: Record<string, unknown> = {
        upcomingSessions: Number((await one(tx, `SELECT count(*) n FROM training_sessions WHERE status IN ('planned','confirmed') AND starts_on >= current_date`))!.n),
        learnersThisYear: Number((await one(tx, `SELECT count(DISTINCT e.person_id) n FROM enrollments e JOIN training_sessions s ON s.id=e.session_id WHERE e.status<>'cancelled' AND extract(year FROM s.starts_on)=$1`, [year]))!.n),
        upcoming: await many(tx, `SELECT s.id, s.title, s.starts_on, s.status, s.capacity, (SELECT count(*) FROM enrollments e WHERE e.session_id=s.id AND e.status<>'cancelled') enrolled
                                   FROM training_sessions s WHERE s.status IN ('draft','planned','confirmed') AND (s.starts_on IS NULL OR s.starts_on >= current_date) ORDER BY s.starts_on NULLS LAST LIMIT 8`),
      };
      if (ctx.permissions.has('finance.read')) {
        cards.revenueYtdHt = (await one(tx, `SELECT coalesce(sum(value),0)::text v FROM (${REVENUE_ROWS}) r`, [cur, `${year}-01-01`, `${year}-12-31`]))!.v;
        cards.cashInYtdTtc = (await one(tx, `SELECT coalesce(sum(value),0)::text v FROM (${CASH_ROWS}) r`, [cur, `${year}-01-01`, `${year}-12-31`]))!.v;
        cards.overdueTtc = (await this.receivablesTotal(tx, cur));
        cards.currency = cur;
      }
      return { cards, computedAt: new Date().toISOString() };
    });
  }

  private async receivablesTotal(tx: Tx, cur: string) {
    return (await one(tx, `SELECT coalesce(sum(b),0)::text v FROM (SELECT i.total_ttc
        - coalesce((SELECT sum(cn.total_ttc) FROM invoices cn WHERE cn.credited_invoice_id=i.id AND cn.status='issued'),0)
        - coalesce((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id=i.id),0) b
        FROM invoices i WHERE i.status='issued' AND i.kind<>'credit_note' AND NOT i.is_incomplete AND i.currency=$1 AND i.due_date < current_date) x WHERE b > 0`, [cur]))!.v;
  }
}
