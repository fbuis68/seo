import { ADDONS, AddonCode, FeatureKey, Limits, PAID_PLANS, PLANS, PlanCode, isAddonCode, isPlanCode } from './catalog';

export type SubscriptionStatus = 'free' | 'trialing' | 'active' | 'past_due' | 'read_only' | 'cancelled';

export interface SubscriptionRow {
  plan_code: string;
  status: SubscriptionStatus;
  trial_ends_at: Date | null;
  grace_until: Date | null;
  current_period_end: Date | null;
}

export interface Entitlements {
  planCode: PlanCode;
  status: SubscriptionStatus;
  readOnly: boolean;
  features: FeatureKey[];
  limits: Limits;
  addons: { code: AddonCode; quantity: number }[];
  /** Nouveaux envois de signature autorisés (suspendus en fin de grâce, lecture seule, essai). */
  canSendSignatures: boolean;
}

/**
 * Calcul pur des droits effectifs : l'état de paiement est distinct des droits.
 * Règles §7.1 : Free sans carte ; essai sans signature tierce gratuite ; past_due utilisable
 * pendant la grâce ; read_only = lecture/export seulement.
 */
export function computeEntitlements(
  sub: SubscriptionRow | undefined,
  addons: { addon_code: string; quantity: number; status: string }[] = [],
  now = new Date(),
): Entitlements {
  const status: SubscriptionStatus = sub?.status ?? 'free';
  let planCode: PlanCode = sub && isPlanCode(sub.plan_code) ? sub.plan_code : 'free';
  let readOnly = false;
  let canSendSignatures = true;

  switch (status) {
    case 'free':
    case 'cancelled':
      planCode = 'free';
      break;
    case 'trialing':
      if (sub?.trial_ends_at && sub.trial_ends_at < now) planCode = 'free';
      canSendSignatures = false; // pas de signature tierce facturable gratuite par défaut
      break;
    case 'past_due':
      if (sub?.grace_until && sub.grace_until < now) canSendSignatures = false;
      break;
    case 'read_only':
      planCode = 'free';
      readOnly = true;
      canSendSignatures = false;
      break;
  }

  const plan = PLANS[planCode];
  const limits: Limits = { ...plan.limits };
  if (status === 'trialing') limits.signatureEnvelopesPerMonth = 0;
  const features = new Set<FeatureKey>(plan.features);
  const activeAddons: { code: AddonCode; quantity: number }[] = [];

  if (PAID_PLANS.includes(planCode) && !readOnly) {
    for (const a of addons) {
      if (a.status !== 'active' || !isAddonCode(a.addon_code) || a.quantity <= 0) continue;
      const def = ADDONS[a.addon_code];
      if (!def.recurring) continue; // les packs ponctuels passent par le grand livre de crédits
      activeAddons.push({ code: a.addon_code, quantity: a.quantity });
      if (def.feature) features.add(def.feature);
      for (const [k, v] of Object.entries(def.grants) as [keyof Limits, number][]) {
        (limits as any)[k] = ((limits as any)[k] ?? 0) + v * a.quantity;
      }
    }
  }
  if (!features.has('signatures')) canSendSignatures = false;

  return { planCode, status, readOnly, features: [...features], limits, addons: activeAddons, canSendSignatures };
}

export function hasFeature(e: Entitlements, f: FeatureKey): boolean {
  return e.features.includes(f);
}
