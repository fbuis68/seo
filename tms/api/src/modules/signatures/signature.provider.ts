import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

export class ProviderError extends Error {
  /** definite = la demande n'a certainement pas été créée chez le fournisseur. */
  constructor(message: string, public definite: boolean) { super(message); }
}

export interface SignatureWebhookEvent {
  eventId: string;
  providerEnvelopeId: string;
  type: 'signer_signed' | 'signer_refused' | 'completed' | 'expired' | 'cancelled';
  signerEmail?: string;
  reason?: string;
  at: Date;
}

/**
 * Fournisseur de signature spécialisé (procédé et niveau eIDAS à confirmer contractuellement).
 * Aucun niveau "avancé/qualifié" n'est revendiqué par l'application elle-même.
 */
export interface SignatureProvider {
  readonly name: string;
  createEnvelope(req: { idempotencyKey: string; title: string; pdf: Buffer; filename: string; signers: { fullName: string; email: string; position: number }[]; expiresAt: Date; ordered: boolean }): Promise<{ providerId: string }>;
  findByIdempotencyKey(key: string): Promise<{ providerId: string } | null>;
  cancel(providerId: string): Promise<void>;
  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): SignatureWebhookEvent;
  downloadSigned(providerId: string): Promise<{ pdf: Buffer; proof: Buffer }>;
}
export const SIGNATURE_PROVIDER = Symbol('SIGNATURE_PROVIDER');

/** Simulation fidèle au contrat (idempotence, webhooks signés, pannes injectables). */
export class FakeSignatureProvider implements SignatureProvider {
  readonly name = 'fake';
  readonly envelopes = new Map<string, { key: string; pdf: Buffer; signers: { email: string }[]; status: string }>();
  /** Injection de panne pour la recette : 'definite' (refus), 'timeout_after_create' (réponse perdue). */
  failNext: null | 'definite' | 'timeout_after_create' = null;
  archiveUnavailable = false;
  private seq = 0;

  constructor(private secret: string) {}

  async createEnvelope(req: { idempotencyKey: string; pdf: Buffer; signers: { email: string }[] }) {
    const mode = this.failNext; this.failNext = null;
    if (mode === 'definite') throw new ProviderError('Requête refusée par le fournisseur (400)', true);
    const existing = await this.findByIdempotencyKey(req.idempotencyKey);
    const providerId = existing?.providerId ?? `fenv_${randomUUID()}`;
    if (!existing) this.envelopes.set(providerId, { key: req.idempotencyKey, pdf: req.pdf, signers: req.signers, status: 'sent' });
    if (mode === 'timeout_after_create') throw new ProviderError('Délai dépassé (réponse inconnue)', false);
    return { providerId };
  }
  async findByIdempotencyKey(key: string) {
    for (const [id, e] of this.envelopes) if (e.key === key) return { providerId: id };
    return null;
  }
  async cancel(providerId: string) { const e = this.envelopes.get(providerId); if (e) e.status = 'cancelled'; }

  event(providerEnvelopeId: string, type: SignatureWebhookEvent['type'], signerEmail?: string, at = Math.floor(Date.now() / 1000)) {
    const body = Buffer.from(JSON.stringify({ id: `fsig_evt_${++this.seq}_${randomUUID()}`, envelope: providerEnvelopeId, type, signer: signerEmail, created: at }));
    const sig = createHmac('sha256', this.secret).update(body).digest('hex');
    return { body, headers: { 'x-signature': sig, 'content-type': 'application/json' } };
  }

  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): SignatureWebhookEvent {
    const got = Buffer.from(String(headers['x-signature'] ?? ''), 'hex');
    const expected = createHmac('sha256', this.secret).update(raw).digest();
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error('signature invalide');
    const e = JSON.parse(raw.toString('utf8'));
    return { eventId: e.id, providerEnvelopeId: e.envelope, type: e.type, signerEmail: e.signer, at: new Date(e.created * 1000) };
  }

  async downloadSigned(providerId: string) {
    if (this.archiveUnavailable) throw new Error('Dossier de preuve temporairement indisponible');
    const e = this.envelopes.get(providerId);
    if (!e) throw new Error('enveloppe inconnue');
    const proof = Buffer.from(JSON.stringify({ envelope: providerId, signers: e.signers, completedAt: new Date().toISOString(), provider: 'fake', note: 'Dossier de preuve simulé' }, null, 2));
    return { pdf: e.pdf, proof };
  }
}
