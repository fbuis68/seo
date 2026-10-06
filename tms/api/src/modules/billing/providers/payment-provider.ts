import { AddonCode, BillingInterval, PlanCode } from '../catalog';

export interface CheckoutRequest {
  tenantId: string;
  checkoutId: string;
  customerEmail: string;
  customerId?: string | null;
  kind: 'subscription' | 'signature_pack';
  plan?: PlanCode;
  interval?: BillingInterval;
  addons: { code: AddonCode; quantity: number }[];
  trialDays?: number;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

export interface ProviderSubscriptionState {
  providerSubscriptionId: string;
  providerCustomerId: string;
  tenantId: string;
  /** Statut brut du fournisseur, traduit explicitement par SubscriptionService. */
  status: 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'paused';
  planCode: PlanCode;
  interval: BillingInterval;
  addons: { code: AddonCode; quantity: number }[];
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export type NormalizedEventType =
  | 'checkout.completed' | 'subscription.changed' | 'payment.failed' | 'payment.succeeded' | 'ignored';

export interface NormalizedEvent {
  id: string;
  type: NormalizedEventType;
  rawType: string;
  createdAt: Date;
  tenantId?: string;
  providerSubscriptionId?: string;
  providerCustomerId?: string;
  checkoutSessionId?: string;
  raw: unknown;
}

/** Prestataire de paiement hébergé : aucune donnée carte ne transite par l'application. */
export interface PaymentProvider {
  readonly name: string;
  createCheckout(req: CheckoutRequest): Promise<{ providerSessionId: string; url: string }>;
  /** Vérifie la signature et normalise ; lève une erreur si invalide. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedEvent;
  retrieveSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionState>;
  updateSubscription(providerSubscriptionId: string, change: {
    plan: PlanCode; interval: BillingInterval; addons: { code: AddonCode; quantity: number }[]; prorate: boolean;
  }): Promise<ProviderSubscriptionState>;
  setCancelAtPeriodEnd(providerSubscriptionId: string, cancel: boolean): Promise<ProviderSubscriptionState>;
  createPortalUrl?(providerCustomerId: string, returnUrl: string): Promise<string>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
