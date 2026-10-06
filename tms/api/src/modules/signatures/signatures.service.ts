import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../core/audit.service';
import { RequestContext } from '../../core/context';
import { sha256 } from '../../core/crypto';
import { Db, many, one } from '../../core/db';
import { AppError, badRequest, conflict, notFound } from '../../core/errors';
import { JobsService } from '../../core/jobs.service';
import { StorageService } from '../../core/storage';
import { CreditsService } from '../billing/credits.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { DocumentsService } from '../documents/documents.service';
import { ProviderError, SIGNATURE_PROVIDER, SignatureProvider } from './signature.provider';

const RANK: Record<string, number> = { draft: 0, queued: 1, sent: 2, partially_signed: 3, completed_pending_archive: 4, completed: 5, refused: 5, expired: 5, cancelled: 5, failed: 5 };

/**
 * Signature électronique payante (§7.3) : document figé (hash), crédits réservés puis débités
 * à l'acceptation fournisseur, aucune réémission aveugle en cas d'état incertain,
 * archivage du PDF signé + dossier de preuve avant statut "completed".
 */
@Injectable()
export class SignaturesService {
  constructor(
    private db: Db, @Inject(SIGNATURE_PROVIDER) readonly provider: SignatureProvider, private credits: CreditsService,
    private ent: EntitlementsService, private storage: StorageService, private docs: DocumentsService,
    private jobs: JobsService, private audit: AuditService,
  ) {
    this.jobs.register('signature.reconcile', (p) => this.reconcile(p.tenantId, p.envelopeId));
    this.jobs.register('signature.archive', (p) => this.archive(p.tenantId, p.envelopeId));
  }

  list(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, (tx) => many(tx, `SELECT e.*, (SELECT json_agg(s ORDER BY s.position) FROM signature_signers s WHERE s.envelope_id=e.id) signers
                                                            FROM signature_envelopes e ORDER BY e.created_at DESC LIMIT 200`));
  }
  get(ctx: RequestContext, id: string) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => {
      const e = await one(tx, `SELECT * FROM signature_envelopes WHERE id=$1`, [id]);
      if (!e) throw notFound('Enveloppe');
      e.signers = await many(tx, `SELECT * FROM signature_signers WHERE envelope_id=$1 ORDER BY position`, [id]);
      return e;
    });
  }

  async send(ctx: RequestContext, b: { documentId: string; title: string; signers: { fullName: string; email: string; role?: string }[]; ordered?: boolean; expiresInDays?: number }) {
    if (b.signers.length < 1 || b.signers.length > 3) throw badRequest('invalid_signers', 'Une enveloppe compte 1 à 3 signataires.', 'signers');
    const envelopeId = randomUUID();
    const idempotencyKey = `env:${envelopeId}`;
    const expiresAt = new Date(Date.now() + (b.expiresInDays ?? 14) * 86400e3);
    // 1) Réservation atomique du crédit + figeage du document.
    const doc = await this.db.tenantTx(ctx.tenantId, async (tx) => {
      const e = await this.ent.get(ctx.tenantId, tx);
      const d = await one(tx, `SELECT * FROM documents WHERE id=$1`, [b.documentId]);
      if (!d) throw notFound('Document');
      if (d.mime !== 'application/pdf') throw badRequest('pdf_required', 'Seul un PDF peut être signé.');
      await this.credits.reserve(tx, ctx.tenantId, e, envelopeId);
      await tx.query(`INSERT INTO signature_envelopes(id, tenant_id, document_id, document_sha256, title, status, provider, idempotency_key, expires_at, created_by)
                      VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9)`, [envelopeId, ctx.tenantId, d.id, d.sha256, b.title, this.provider.name, idempotencyKey, expiresAt, ctx.userId]);
      for (const [i, s] of b.signers.entries()) {
        await tx.query(`INSERT INTO signature_signers(tenant_id, envelope_id, full_name, email, role, position) VALUES ($1,$2,$3,$4,$5,$6)`,
          [ctx.tenantId, envelopeId, s.fullName, s.email.toLowerCase(), s.role ?? null, b.ordered ? i + 1 : 1]);
      }
      await this.audit.log(tx, { tenantId: ctx.tenantId, actor: ctx.userId, action: 'signature.queued', entityType: 'signature', entityId: envelopeId, data: { documentId: d.id, sha256: d.sha256 } });
      return d;
    });
    const pdf = await this.storage.get(doc.storage_key);
    if (sha256(pdf) !== doc.sha256) {
      await this.db.tenantTx(ctx.tenantId, async (tx) => {
        await this.credits.release(tx, ctx.tenantId, envelopeId);
        await tx.query(`UPDATE signature_envelopes SET status='failed', provider_status='document_hash_mismatch' WHERE id=$1`, [envelopeId]);
      });
      throw new AppError(500, 'document_altered', 'Empreinte du document incohérente : envoi annulé.');
    }
    // 2) Appel fournisseur hors transaction.
    try {
      const r = await this.provider.createEnvelope({ idempotencyKey, title: b.title, pdf, filename: doc.filename, expiresAt, ordered: !!b.ordered,
        signers: b.signers.map((s, i) => ({ fullName: s.fullName, email: s.email, position: b.ordered ? i + 1 : 1 })) });
      await this.markSent(ctx.tenantId, envelopeId, r.providerId);
    } catch (err) {
      if (err instanceof ProviderError && err.definite) {
        await this.db.tenantTx(ctx.tenantId, async (tx) => {
          await this.credits.release(tx, ctx.tenantId, envelopeId);
          await tx.query(`UPDATE signature_envelopes SET status='failed', provider_status=$2, updated_at=now() WHERE id=$1`, [envelopeId, err.message]);
        });
      } else {
        // État incertain : rapprochement par clé d'idempotence avant toute nouvelle tentative.
        await this.jobs.enqueue(null, 'signature.reconcile', { tenantId: ctx.tenantId, envelopeId }, { tenantId: ctx.tenantId, dedupeKey: `sigrec:${envelopeId}`, runAt: new Date(Date.now() + 30e3) });
      }
    }
    return this.get(ctx, envelopeId);
  }

  private async markSent(tenantId: string, envelopeId: string, providerId: string) {
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx.query(`UPDATE signature_envelopes SET status='sent', provider_id=$2, updated_at=now() WHERE id=$1 AND status='queued'`, [envelopeId, providerId]);
      await this.credits.commit(tx, tenantId, envelopeId);
      await tx.query(`INSERT INTO provider_refs(provider, kind, provider_id, tenant_id, entity_id) VALUES ($1,'signature',$2,$3,$4) ON CONFLICT DO NOTHING`,
        [this.provider.name, providerId, tenantId, envelopeId]);
    });
  }

  async reconcile(tenantId: string, envelopeId: string) {
    const [e] = await this.db.tenantTx(tenantId, (tx) => many(tx, `SELECT * FROM signature_envelopes WHERE id=$1`, [envelopeId]));
    if (!e || e.status !== 'queued') return;
    const found = await this.provider.findByIdempotencyKey(e.idempotency_key);
    if (found) return this.markSent(tenantId, envelopeId, found.providerId);
    await this.db.tenantTx(tenantId, async (tx) => {
      await this.credits.release(tx, tenantId, envelopeId);
      await tx.query(`UPDATE signature_envelopes SET status='failed', provider_status='not_found_after_reconcile', updated_at=now() WHERE id=$1`, [envelopeId]);
    });
  }

  async cancel(ctx: RequestContext, id: string) {
    const e = await this.get(ctx, id);
    if (!['sent', 'partially_signed'].includes(e.status)) throw conflict('not_cancellable', 'Enveloppe non annulable dans cet état.');
    await this.provider.cancel(e.provider_id); // annulation confirmée par le fournisseur (webhook) puis statut local
    await this.db.tenantTx(ctx.tenantId, (tx) => tx.query(`UPDATE signature_envelopes SET status='cancelled', updated_at=now() WHERE id=$1`, [id]));
    return this.get(ctx, id);
  }

  async handleWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>) {
    let evt;
    try { evt = this.provider.verifyWebhook(raw, headers); } catch (e) { throw new AppError(400, 'invalid_webhook', (e as Error).message); }
    const [ref] = await this.db.query(`SELECT tenant_id, entity_id FROM provider_refs WHERE provider=$1 AND kind='signature' AND provider_id=$2`, [this.provider.name, evt.providerEnvelopeId]);
    if (!ref) throw new AppError(404, 'unknown_envelope', 'Enveloppe inconnue');
    const ins = await this.db.query(`INSERT INTO signature_events(provider, event_id, provider_envelope_id, type, payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id`,
      [this.provider.name, evt.eventId, evt.providerEnvelopeId, evt.type, JSON.stringify(evt)]);
    if (!ins.length) return { duplicate: true };
    await this.db.tenantTx(ref.tenant_id, async (tx) => {
      const e = await one(tx, `SELECT * FROM signature_envelopes WHERE id=$1 FOR UPDATE`, [ref.entity_id]);
      if (evt.type === 'signer_signed' || evt.type === 'signer_refused') {
        await tx.query(`UPDATE signature_signers SET status=$3, signed_at = CASE WHEN $3='signed' THEN $4::timestamptz END, refusal_reason=$5 WHERE envelope_id=$1 AND email=$2`,
          [e.id, evt.signerEmail?.toLowerCase(), evt.type === 'signer_signed' ? 'signed' : 'refused', evt.at, evt.reason ?? null]);
      }
      const next = evt.type === 'signer_signed' ? 'partially_signed' : evt.type === 'signer_refused' ? 'refused'
        : evt.type === 'completed' ? 'completed_pending_archive' : evt.type;
      // Événements désordonnés : jamais de retour en arrière d'état.
      if (RANK[next] > RANK[e.status]) {
        await tx.query(`UPDATE signature_envelopes SET status=$2, provider_status=$3, updated_at=now() WHERE id=$1`, [e.id, next, evt.type]);
      }
      if (next === 'completed_pending_archive') {
        await this.jobs.enqueue(tx, 'signature.archive', { tenantId: ref.tenant_id, envelopeId: e.id }, { tenantId: ref.tenant_id, dedupeKey: `sigarch:${e.id}`, maxAttempts: 10 });
      }
    });
    return { duplicate: false };
  }

  /** Récupère PDF signé + dossier de preuve, les hashe et les conserve ; alors seulement "completed". */
  async archive(tenantId: string, envelopeId: string) {
    const [e] = await this.db.tenantTx(tenantId, (tx) => many(tx, `SELECT * FROM signature_envelopes WHERE id=$1`, [envelopeId]));
    if (!e || e.status !== 'completed_pending_archive') return;
    const { pdf, proof } = await this.provider.downloadSigned(e.provider_id);
    await this.db.tenantTx(tenantId, async (tx) => {
      const ctx = { tenantId };
      const signed = await this.docs.store(tx, ctx, { ownerType: 'signature', ownerId: envelopeId, kind: 'signed_pdf', filename: `signe-${e.title}.pdf`, mime: 'application/pdf', data: pdf, provenance: { provider: this.provider.name, providerId: e.provider_id } });
      const proofDoc = await this.docs.store(tx, ctx, { ownerType: 'signature', ownerId: envelopeId, kind: 'signature_proof', filename: `preuve-${e.title}.json`, mime: 'application/json', data: proof, provenance: { provider: this.provider.name, providerId: e.provider_id } });
      await tx.query(`UPDATE signature_envelopes SET status='completed', signed_document_id=$2, proof_document_id=$3, updated_at=now() WHERE id=$1`, [envelopeId, signed!.id, proofDoc!.id]);
      await this.audit.log(tx, { tenantId, action: 'signature.archived', entityType: 'signature', entityId: envelopeId, data: { signedSha256: signed!.sha256, proofSha256: proofDoc!.sha256 } });
    });
  }

  balance(ctx: RequestContext) {
    return this.db.tenantTx(ctx.tenantId, async (tx) => this.credits.balance(tx, ctx.tenantId, await this.ent.get(ctx.tenantId, tx)));
  }
}
