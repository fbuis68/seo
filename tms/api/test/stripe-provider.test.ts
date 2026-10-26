import { StripeProvider } from '../src/modules/billing/providers/stripe.provider';

const env = { STRIPE_PRICE_EQUIPE_MONTH: 'price_eq_m', STRIPE_PRICE_ADDON_BANK: 'price_bank' } as any;
function capture() {
  const calls: URLSearchParams[] = [];
  (global as any).fetch = async (_url: string, init: any) => {
    calls.push(new URLSearchParams(init.body));
    return { ok: true, json: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }) };
  };
  return calls;
}
const req = (extra: any = {}) => ({ tenantId: 't1', checkoutId: 'c1', customerEmail: 'a@b.fr', kind: 'subscription', plan: 'equipe', interval: 'month',
  addons: [{ code: 'bank', quantity: 1 }], successUrl: 'https://x/ok', cancelUrl: 'https://x/ko', idempotencyKey: 'k', ...extra });

describe('StripeProvider : paiement avec TVA (Stripe Tax)', () => {
  it('active la TVA automatique, collecte adresse et n° de TVA', async () => {
    const calls = capture();
    await new StripeProvider('sk_test_x', 'whsec_x', env).createCheckout(req() as any);
    const p = calls[0];
    expect(p.get('automatic_tax[enabled]')).toBe('true');
    expect(p.get('billing_address_collection')).toBe('required');
    expect(p.get('tax_id_collection[enabled]')).toBe('true');
    expect(p.get('line_items[0][price]')).toBe('price_eq_m');
    expect(p.get('customer_email')).toBe('a@b.fr');
  });
  it('client existant : adresse et nom reportés sur la fiche ; TVA désactivable', async () => {
    const calls = capture();
    await new StripeProvider('sk_test_x', 'whsec_x', { ...env, STRIPE_AUTOMATIC_TAX: 'false' }).createCheckout(req({ customerId: 'cus_1' }) as any);
    const p = calls[0];
    expect(p.get('customer')).toBe('cus_1');
    expect(p.get('customer_update[address]')).toBe('auto');
    expect(p.get('customer_update[name]')).toBe('auto');
    expect(p.get('automatic_tax[enabled]')).toBeNull();
  });
});
