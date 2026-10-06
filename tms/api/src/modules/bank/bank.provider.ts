import { randomUUID } from 'crypto';

export interface ProviderAccount { id: string; name: string; ibanMasked: string | null; currency: string; balance: string | null; balanceAt: Date | null }
export interface ProviderTransaction { id: string; status: 'pending' | 'booked' | 'reversed'; amount: string; currency: string; bookedOn: string | null; valueOn: string | null; label: string; counterparty: string | null; version: number; raw: unknown }

/**
 * Agrégateur bancaire en LECTURE SEULE (type Powens) : consentement via parcours officiel,
 * l'application ne collecte jamais d'identifiants bancaires et n'expose aucune initiation de paiement.
 */
export interface BankProvider {
  readonly name: string;
  createConnectUrl(state: string, redirectUrl: string): Promise<string>;
  exchange(code: string): Promise<{ connectionId: string; institution: string; token: string; consentExpiresAt: Date | null }>;
  accounts(token: string, connectionId: string): Promise<ProviderAccount[]>;
  transactions(token: string, accountId: string, cursor: string | null): Promise<{ items: ProviderTransaction[]; next: string | null }>;
  revoke(token: string, connectionId: string): Promise<void>;
}
export const BANK_PROVIDER = Symbol('BANK_PROVIDER');

/** Simulation (démo/tests) : banques fictives, transactions pending→booked, pagination. */
export class FakeBankProvider implements BankProvider {
  readonly name = 'fake';
  readonly conns = new Map<string, { accounts: ProviderAccount[]; txs: Map<string, ProviderTransaction[]>; revoked: boolean }>();
  private codes = new Map<string, string>();

  async createConnectUrl(state: string, redirectUrl: string) {
    const code = `code_${randomUUID()}`;
    const connId = `fbc_${randomUUID()}`;
    this.codes.set(code, connId);
    this.conns.set(connId, {
      accounts: [{ id: `acc_${connId}_1`, name: 'Compte courant pro', ibanMasked: 'FR76 **** **** **** **** **** 123', currency: 'EUR', balance: '12500.00', balanceAt: new Date() }],
      txs: new Map(), revoked: false,
    });
    return `${redirectUrl}?code=${code}&state=${encodeURIComponent(state)}`;
  }
  async exchange(code: string) {
    const connId = this.codes.get(code);
    if (!connId) throw new Error('code invalide');
    this.codes.delete(code);
    return { connectionId: connId, institution: 'Banque Démo', token: `tok_${randomUUID()}`, consentExpiresAt: new Date(Date.now() + 180 * 86400e3) };
  }
  async accounts(_t: string, connectionId: string) {
    const c = this.conns.get(connectionId);
    if (!c || c.revoked) throw new Error('reauth_required');
    return c.accounts;
  }
  /** Pages de 2 transactions pour éprouver la reprise sur curseur. */
  async transactions(_t: string, accountId: string, cursor: string | null) {
    const c = [...this.conns.values()].find((x) => x.accounts.some((a) => a.id === accountId));
    const all = c?.txs.get(accountId) ?? [];
    const start = cursor ? Number(cursor) : 0;
    return { items: all.slice(start, start + 2), next: start + 2 < all.length ? String(start + 2) : null };
  }
  async revoke(_t: string, connectionId: string) { const c = this.conns.get(connectionId); if (c) c.revoked = true; }

  addTransaction(connectionId: string, tx: Partial<ProviderTransaction> & { amount: string; label: string }) {
    const c = this.conns.get(connectionId)!;
    const acc = c.accounts[0].id;
    const t: ProviderTransaction = { id: tx.id ?? `tx_${randomUUID()}`, status: tx.status ?? 'booked', amount: tx.amount, currency: tx.currency ?? 'EUR', bookedOn: tx.bookedOn ?? new Date().toISOString().slice(0, 10),
      valueOn: null, label: tx.label, counterparty: tx.counterparty ?? null, version: 1, raw: { simulated: true } };
    const list = c.txs.get(acc) ?? [];
    const i = list.findIndex((x) => x.id === t.id);
    if (i >= 0) list[i] = { ...t, version: list[i].version + 1 }; else list.push(t);
    c.txs.set(acc, list);
    return t;
  }
}
