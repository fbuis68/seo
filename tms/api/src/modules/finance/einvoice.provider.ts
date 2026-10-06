import { randomUUID } from 'crypto';

/**
 * Partenaire de facturation électronique (plateforme agréée) — à sélectionner en discovery.
 * L'application ne se présente pas comme plateforme agréée : elle transmet et suit les statuts.
 */
export interface EInvoiceProvider {
  readonly name: string;
  transmit(req: { tenantId: string; invoice: any; idempotencyKey: string }): Promise<{ providerId: string; status: 'pending' | 'transmitted' | 'rejected' }>;
}
export const EINVOICE_PROVIDER = Symbol('EINVOICE_PROVIDER');

/** Simulation : accepte la transmission, statut "transmitted". */
export class FakeEInvoiceProvider implements EInvoiceProvider {
  readonly name = 'fake';
  private seen = new Map<string, string>();
  async transmit(req: { idempotencyKey: string }) {
    const id = this.seen.get(req.idempotencyKey) ?? `fei_${randomUUID()}`;
    this.seen.set(req.idempotencyKey, id);
    return { providerId: id, status: 'transmitted' as const };
  }
}
