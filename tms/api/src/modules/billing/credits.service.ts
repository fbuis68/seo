import { Injectable } from '@nestjs/common';
import { Tx, lock, one } from '../../core/db';
import { paymentRequired } from '../../core/errors';
import { Entitlements } from './entitlements';
import { monthPeriod } from './usage';

/**
 * Crédits d'enveloppes de signature (§7 / §7.3) :
 * réservation atomique à la validation serveur, débit définitif à l'acceptation fournisseur,
 * libération si échec avant acceptation. Crédits mensuels non reportables + packs du cycle.
 */
@Injectable()
export class CreditsService {
  period(now = new Date()) { return monthPeriod(now); }

  async balance(tx: Tx, tenantId: string, e: Entitlements, period = this.period()) {
    const r = await one(tx, `
      SELECT
        coalesce(sum(amount) FILTER (WHERE kind='purchase'),0) purchased,
        coalesce(sum(amount) FILTER (WHERE kind='commit'),0) committed,
        coalesce(sum(amount) FILTER (WHERE kind='reserve'),0) reserved,
        coalesce(sum(amount) FILTER (WHERE kind='release'),0) released
      FROM credit_ledger WHERE tenant_id=$1 AND credit_type='signature_envelope' AND period=$2`, [tenantId, period]);
    const included = e.limits.signatureEnvelopesPerMonth;
    const purchased = Number(r!.purchased);
    // Une réservation est soit commitée soit libérée : en cours = reserve - commit - release.
    const pending = Number(r!.reserved) - Number(r!.committed) - Number(r!.released);
    const used = Number(r!.committed);
    return { period, included, purchased, used, pending, available: included + purchased - used - pending };
  }

  async reserve(tx: Tx, tenantId: string, e: Entitlements, envelopeId: string): Promise<string> {
    if (!e.canSendSignatures) {
      throw paymentRequired('signatures_unavailable', "L'envoi de signatures électroniques n'est pas disponible avec votre offre ou son état actuel.");
    }
    await lock(tx, `credits:${tenantId}`);
    const b = await this.balance(tx, tenantId, e);
    if (b.available < 1) {
      throw paymentRequired('signature_credits_exhausted', `Crédits de signature épuisés pour ${b.period}. Achetez un pack de 20 enveloppes ou passez à une offre supérieure.`, b);
    }
    await tx.query(`INSERT INTO credit_ledger(tenant_id, kind, amount, period, envelope_id, idempotency_key) VALUES ($1,'reserve',1,$2,$3,$4)`,
      [tenantId, b.period, envelopeId, `reserve:${envelopeId}`]);
    return b.period;
  }

  /** Débit définitif (idempotent) lorsque le fournisseur a accepté la création de l'enveloppe. */
  async commit(tx: Tx, tenantId: string, envelopeId: string) {
    const r = await one(tx, `SELECT period FROM credit_ledger WHERE idempotency_key=$1`, [`reserve:${envelopeId}`]);
    if (!r) return;
    await tx.query(`INSERT INTO credit_ledger(tenant_id, kind, amount, period, envelope_id, idempotency_key) VALUES ($1,'commit',1,$2,$3,$4)
                    ON CONFLICT (idempotency_key) DO NOTHING`, [tenantId, r.period, envelopeId, `settle:${envelopeId}`]);
  }

  /** Libération (idempotente) si échec certain avant acceptation. Exclusif avec commit (même clé). */
  async release(tx: Tx, tenantId: string, envelopeId: string) {
    const r = await one(tx, `SELECT period FROM credit_ledger WHERE idempotency_key=$1`, [`reserve:${envelopeId}`]);
    if (!r) return;
    await tx.query(`INSERT INTO credit_ledger(tenant_id, kind, amount, period, envelope_id, idempotency_key) VALUES ($1,'release',1,$2,$3,$4)
                    ON CONFLICT (idempotency_key) DO NOTHING`, [tenantId, r.period, envelopeId, `settle:${envelopeId}`]);
  }

  async purchase(tx: Tx, tenantId: string, amount: number, idempotencyKey: string, note: string) {
    await tx.query(`INSERT INTO credit_ledger(tenant_id, kind, amount, period, idempotency_key, note) VALUES ($1,'purchase',$2,$3,$4,$5)
                    ON CONFLICT (idempotency_key) DO NOTHING`, [tenantId, amount, this.period(), idempotencyKey, note]);
  }
}
