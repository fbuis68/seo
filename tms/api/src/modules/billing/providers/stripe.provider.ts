import { createHmac, timingSafeEqual } from 'crypto';
import { AddonCode, BillingInterval, PlanCode, isAddonCode, isPlanCode } from '../catalog';
import { CheckoutRequest, NormalizedEvent, PaymentProvider, ProviderSubscriptionState } from './payment-provider';

/**
 * Adaptateur Stripe (Checkout hébergé + Billing) via l'API REST officielle.
 * Les prix sont créés dans Stripe et référencés par variables d'environnement :
 *   STRIPE_PRICE_SOLO_MONTH, STRIPE_PRICE_SOLO_YEAR, ..._EQUIPE_..., ..._CENTRE_...,
 *   STRIPE_PRICE_ADDON_BANK, STRIPE_PRICE_ADDON_MAIL_INBOX, STRIPE_PRICE_SIGNATURE_PACK
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  private api = 'https://api.stripe.com/v1';

  constructor(private secretKey: string, private webhookSecret: string, private env = process.env) {
    if (!secretKey || !webhookSecret) throw new Error('STRIPE_SECRET_KEY et STRIPE_WEBHOOK_SECRET requis');
  }

  private priceFor(kind: string): string {
    const id = this.env[`STRIPE_PRICE_${kind.toUpperCase()}`];
    if (!id) throw new Error(`Prix Stripe non configuré : STRIPE_PRICE_${kind.toUpperCase()}`);
    return id;
  }
  private planPrice = (plan: PlanCode, interval: BillingInterval) => this.priceFor(`${plan}_${interval}`);
  private addonPrice = (code: AddonCode) => code === 'signature_pack' ? this.priceFor('signature_pack') : this.priceFor(`addon_${code}`);

  private reverse(priceId: string): { plan?: PlanCode; interval?: BillingInterval; addon?: AddonCode } {
    for (const [k, v] of Object.entries(this.env)) {
      if (v !== priceId || !k.startsWith('STRIPE_PRICE_')) continue;
      const key = k.slice('STRIPE_PRICE_'.length).toLowerCase();
      if (key.startsWith('addon_') && isAddonCode(key.slice(6))) return { addon: key.slice(6) as AddonCode };
      const [plan, interval] = key.split('_');
      if (isPlanCode(plan) && (interval === 'month' || interval === 'year')) return { plan, interval };
    }
    return {};
  }

  private async call(method: 'GET' | 'POST', path: string, params?: Record<string, string>, idempotencyKey?: string): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}` };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let url = `${this.api}${path}`;
    let body: string | undefined;
    if (params && method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(params).toString();
    } else if (params) url += `?${new URLSearchParams(params)}`;
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
    const json: any = await res.json();
    if (!res.ok) throw new Error(`Stripe ${res.status}: ${json?.error?.message ?? 'erreur'}`);
    return json;
  }

  async createCheckout(req: CheckoutRequest) {
    const p: Record<string, string> = {
      success_url: req.successUrl, cancel_url: req.cancelUrl,
      client_reference_id: req.tenantId,
      'metadata[tenant_id]': req.tenantId, 'metadata[checkout_id]': req.checkoutId, 'metadata[kind]': req.kind,
      locale: 'fr', billing_address_collection: 'required', 'tax_id_collection[enabled]': 'true',
    };
    if (req.customerId) p.customer = req.customerId; else p.customer_email = req.customerEmail;
    if (req.kind === 'subscription') {
      p.mode = 'subscription';
      p['line_items[0][price]'] = this.planPrice(req.plan!, req.interval!);
      p['line_items[0][quantity]'] = '1';
      req.addons.forEach((a, i) => {
        p[`line_items[${i + 1}][price]`] = this.addonPrice(a.code);
        p[`line_items[${i + 1}][quantity]`] = String(a.quantity);
      });
      p['subscription_data[metadata][tenant_id]'] = req.tenantId;
      if (req.trialDays) p['subscription_data[trial_period_days]'] = String(req.trialDays);
    } else {
      p.mode = 'payment';
      p['line_items[0][price]'] = this.addonPrice('signature_pack');
      p['line_items[0][quantity]'] = '1';
      p['invoice_creation[enabled]'] = 'true';
    }
    const s = await this.call('POST', '/checkout/sessions', p, req.idempotencyKey);
    return { providerSessionId: s.id, url: s.url };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedEvent {
    const header = String(headers['stripe-signature'] ?? '');
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
    const t = Number(parts.t);
    const sigs = header.split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
    if (!t || !sigs.length) throw new Error('signature absente');
    if (Math.abs(Date.now() / 1000 - t) > 300) throw new Error('horodatage hors tolérance');
    const expected = createHmac('sha256', this.webhookSecret).update(`${t}.${rawBody.toString('utf8')}`).digest();
    const ok = sigs.some((s) => { const b = Buffer.from(s, 'hex'); return b.length === expected.length && timingSafeEqual(b, expected); });
    if (!ok) throw new Error('signature invalide');
    const evt = JSON.parse(rawBody.toString('utf8'));
    const obj = evt.data?.object ?? {};
    const base = { id: evt.id, rawType: evt.type, createdAt: new Date(evt.created * 1000), raw: evt };
    switch (evt.type) {
      case 'checkout.session.completed':
        return { ...base, type: 'checkout.completed', tenantId: obj.metadata?.tenant_id ?? obj.client_reference_id,
          checkoutSessionId: obj.id, providerSubscriptionId: obj.subscription ?? undefined, providerCustomerId: obj.customer ?? undefined };
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return { ...base, type: 'subscription.changed', tenantId: obj.metadata?.tenant_id, providerSubscriptionId: obj.id, providerCustomerId: obj.customer };
      case 'invoice.payment_failed':
        return { ...base, type: 'payment.failed', providerSubscriptionId: obj.subscription, providerCustomerId: obj.customer };
      case 'invoice.paid':
        return { ...base, type: 'payment.succeeded', providerSubscriptionId: obj.subscription, providerCustomerId: obj.customer };
      default:
        return { ...base, type: 'ignored' };
    }
  }

  private normalize(s: any): ProviderSubscriptionState {
    let planCode: PlanCode | undefined; let interval: BillingInterval = 'month';
    const addons: { code: AddonCode; quantity: number }[] = [];
    for (const item of s.items?.data ?? []) {
      const r = this.reverse(item.price.id);
      if (r.plan) { planCode = r.plan; interval = r.interval!; }
      if (r.addon) addons.push({ code: r.addon, quantity: item.quantity ?? 1 });
    }
    if (!planCode) throw new Error(`Abonnement Stripe ${s.id} sans prix d'offre reconnu`);
    return {
      providerSubscriptionId: s.id, providerCustomerId: s.customer, tenantId: s.metadata?.tenant_id,
      status: s.status, planCode, interval, addons,
      currentPeriodEnd: s.current_period_end ? new Date(s.current_period_end * 1000)
        : s.items?.data?.[0]?.current_period_end ? new Date(s.items.data[0].current_period_end * 1000) : null,
      trialEnd: s.trial_end ? new Date(s.trial_end * 1000) : null,
      cancelAtPeriodEnd: !!s.cancel_at_period_end,
    };
  }

  async retrieveSubscription(id: string) {
    return this.normalize(await this.call('GET', `/subscriptions/${encodeURIComponent(id)}`));
  }

  async updateSubscription(id: string, change: { plan: PlanCode; interval: BillingInterval; addons: { code: AddonCode; quantity: number }[]; prorate: boolean }) {
    const current = await this.call('GET', `/subscriptions/${encodeURIComponent(id)}`);
    const p: Record<string, string> = { proration_behavior: change.prorate ? 'always_invoice' : 'none' };
    let i = 0;
    const wanted = new Map<string, number>([[this.planPrice(change.plan, change.interval), 1]]);
    change.addons.forEach((a) => wanted.set(this.addonPrice(a.code), a.quantity));
    for (const item of current.items.data) {
      if (wanted.has(item.price.id)) {
        p[`items[${i}][id]`] = item.id; p[`items[${i}][quantity]`] = String(wanted.get(item.price.id)); wanted.delete(item.price.id);
      } else { p[`items[${i}][id]`] = item.id; p[`items[${i}][deleted]`] = 'true'; }
      i++;
    }
    for (const [price, qty] of wanted) { p[`items[${i}][price]`] = price; p[`items[${i}][quantity]`] = String(qty); i++; }
    return this.normalize(await this.call('POST', `/subscriptions/${encodeURIComponent(id)}`, p));
  }

  async setCancelAtPeriodEnd(id: string, cancel: boolean) {
    return this.normalize(await this.call('POST', `/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: String(cancel) }));
  }

  async createPortalUrl(customerId: string, returnUrl: string) {
    const s = await this.call('POST', '/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
    return s.url as string;
  }
}
