import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { AddonCode, BillingInterval, PlanCode } from '../catalog';
import { CheckoutRequest, NormalizedEvent, PaymentProvider, ProviderSubscriptionState } from './payment-provider';

/**
 * Prestataire simulé (développement, démo, tests) : même contrat que Stripe,
 * page de paiement locale et webhooks signés HMAC. Jamais activé en production.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly sessions = new Map<string, CheckoutRequest & { status: 'open' | 'completed' }>();
  readonly subscriptions = new Map<string, ProviderSubscriptionState>();
  private seq = 0;

  constructor(private secret: string, private publicApiUrl: string) {}

  async createCheckout(req: CheckoutRequest) {
    const existing = [...this.sessions.entries()].find(([, s]) => s.idempotencyKey === req.idempotencyKey);
    if (existing) return { providerSessionId: existing[0], url: this.url(existing[0]) };
    const id = `fcs_${randomUUID()}`;
    this.sessions.set(id, { ...req, status: 'open' });
    return { providerSessionId: id, url: this.url(id) };
  }
  private url = (id: string) => `${this.publicApiUrl}/api/v1/dev/fake-checkout/${id}`;

  /** Simule le paiement réussi : crée l'abonnement et produit les événements signés. */
  complete(sessionId: string): { body: Buffer; headers: Record<string, string> }[] {
    const s = this.sessions.get(sessionId);
    if (!s || s.status !== 'open') throw new Error('session inconnue ou déjà utilisée');
    s.status = 'completed';
    const events: unknown[] = [];
    let subId: string | undefined;
    if (s.kind === 'subscription') {
      subId = `fsub_${randomUUID()}`;
      const now = Date.now();
      const state: ProviderSubscriptionState = {
        providerSubscriptionId: subId, providerCustomerId: s.customerId ?? `fcus_${s.tenantId.slice(0, 8)}`,
        tenantId: s.tenantId, status: s.trialDays ? 'trialing' : 'active', planCode: s.plan!, interval: s.interval!,
        addons: s.addons, cancelAtPeriodEnd: false,
        trialEnd: s.trialDays ? new Date(now + s.trialDays * 86400e3) : null,
        currentPeriodEnd: new Date(now + (s.interval === 'year' ? 365 : 30) * 86400e3),
      };
      this.subscriptions.set(subId, state);
      events.push(this.event('customer.subscription.created', { subscription: subId, tenant_id: s.tenantId }));
    }
    events.push(this.event('checkout.session.completed', {
      checkout_session: sessionId, subscription: subId, tenant_id: s.tenantId,
      customer: subId ? this.subscriptions.get(subId)!.providerCustomerId : `fcus_${s.tenantId.slice(0, 8)}`,
    }));
    return events.map((e) => this.sign(e));
  }

  /** Simule un changement de statut côté fournisseur (échec de paiement, résiliation...). */
  mutate(subId: string, patch: Partial<ProviderSubscriptionState>, eventType = 'customer.subscription.updated') {
    const sub = this.subscriptions.get(subId);
    if (!sub) throw new Error('abonnement inconnu');
    Object.assign(sub, patch);
    return this.sign(this.event(eventType, { subscription: subId, tenant_id: sub.tenantId }));
  }

  private event(type: string, data: Record<string, unknown>) {
    return { id: `fevt_${++this.seq}_${randomUUID()}`, type, created: Math.floor(Date.now() / 1000), data };
  }

  sign(evt: unknown, at = Math.floor(Date.now() / 1000)) {
    const body = Buffer.from(JSON.stringify(evt));
    const sig = createHmac('sha256', this.secret).update(`${at}.${body}`).digest('hex');
    return { body, headers: { 'x-fake-signature': `t=${at},v1=${sig}`, 'content-type': 'application/json' } };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedEvent {
    const header = String(headers['x-fake-signature'] ?? '');
    const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header);
    if (!m) throw new Error('signature absente');
    if (Math.abs(Date.now() / 1000 - Number(m[1])) > 300) throw new Error('horodatage hors tolérance');
    const expected = createHmac('sha256', this.secret).update(`${m[1]}.${rawBody}`).digest();
    const got = Buffer.from(m[2], 'hex');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error('signature invalide');
    const evt = JSON.parse(rawBody.toString('utf8'));
    const d = evt.data ?? {};
    const base = { id: evt.id, rawType: evt.type, createdAt: new Date(evt.created * 1000), raw: evt, tenantId: d.tenant_id };
    switch (evt.type) {
      case 'checkout.session.completed':
        return { ...base, type: 'checkout.completed', checkoutSessionId: d.checkout_session, providerSubscriptionId: d.subscription, providerCustomerId: d.customer };
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return { ...base, type: 'subscription.changed', providerSubscriptionId: d.subscription };
      case 'invoice.payment_failed':
        return { ...base, type: 'payment.failed', providerSubscriptionId: d.subscription };
      case 'invoice.paid':
        return { ...base, type: 'payment.succeeded', providerSubscriptionId: d.subscription };
      default:
        return { ...base, type: 'ignored' };
    }
  }

  async retrieveSubscription(id: string) {
    const s = this.subscriptions.get(id);
    if (!s) throw new Error('abonnement inconnu');
    return { ...s, addons: [...s.addons] };
  }

  async updateSubscription(id: string, change: { plan: PlanCode; interval: BillingInterval; addons: { code: AddonCode; quantity: number }[]; prorate: boolean }) {
    const s = this.subscriptions.get(id);
    if (!s) throw new Error('abonnement inconnu');
    Object.assign(s, { planCode: change.plan, interval: change.interval, addons: change.addons });
    return { ...s };
  }

  async setCancelAtPeriodEnd(id: string, cancel: boolean) {
    const s = this.subscriptions.get(id);
    if (!s) throw new Error('abonnement inconnu');
    s.cancelAtPeriodEnd = cancel;
    return { ...s };
  }
}
