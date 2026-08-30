import crypto from "crypto";
import { prisma } from "../db";
import type { PaymentConfig, Booking } from "@prisma/client";

// Connecteur Stripe (module "Paiement en ligne" du catalogue d'abonnement)
// — un compte Stripe par établissement, appelé en REST brut (comme tous les
// autres connecteurs de ce projet) plutôt qu'avec le SDK stripe. Paie le
// panier client (room-service/boutique + taxe de séjour, jamais le prix de
// la chambre — cf. schema.prisma PaymentConfig) via Stripe Checkout : page
// de paiement hébergée par Stripe, aucune donnée de carte ne transite par
// nos serveurs, confirmation reçue en asynchrone par webhook signé
// (cf. routes/payment.ts).

const STRIPE_API_BASE = process.env.STRIPE_API_BASE_OVERRIDE || "https://api.stripe.com/v1";
const STRIPE_TIMEOUT_MS = 15000;

export class PaymentError extends Error {}

function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS) });
}

function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return "erreur réseau";
  if (e.name === "TimeoutError") return `délai de ${STRIPE_TIMEOUT_MS / 1000}s dépassé sans réponse de Stripe`;
  const cause = (e as { cause?: unknown }).cause;
  const causeCode = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : null;
  if (causeCode === "ENOTFOUND") return "nom de domaine introuvable (DNS)";
  if (causeCode === "ECONNREFUSED") return "connexion refusée";
  if (causeCode && /CERT|SSL|TLS/i.test(causeCode)) return `certificat TLS invalide (${causeCode})`;
  return e.message;
}

/**
 * L'API Stripe attend un corps application/x-www-form-urlencoded avec une
 * notation "crochets" pour les objets/tableaux imbriqués (ex :
 * line_items[0][price_data][unit_amount]=1000), jamais du JSON — cette
 * fonction aplati récursivement un objet JS vers cette notation.
 */
function stripeEncodeForm(obj: unknown, prefix?: string): string[] {
  const parts: string[] = [];
  if (obj === undefined || obj === null) return parts;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => parts.push(...stripeEncodeForm(v, `${prefix}[${i}]`)));
  } else if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === undefined) continue;
      parts.push(...stripeEncodeForm(v, prefix ? `${prefix}[${k}]` : k));
    }
  } else {
    parts.push(`${encodeURIComponent(prefix || "")}=${encodeURIComponent(String(obj))}`);
  }
  return parts;
}

async function parseJsonResponse(res: Response, context: string): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const snippet = text.trim().slice(0, 200) || "(réponse vide)";
    throw new PaymentError(`${context} n'est pas un JSON valide — début de la réponse reçue : "${snippet}"`);
  }
}

async function stripeRequest(config: { secretKey: string | null }, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<any> {
  if (!config.secretKey) throw new PaymentError("Clé secrète Stripe non configurée");
  const url = `${STRIPE_API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        Accept: "application/json",
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(method === "POST" ? { body: stripeEncodeForm(body).join("&") } : {}),
    });
  } catch (e) {
    throw new PaymentError(`Appel à Stripe impossible : ${describeFetchError(e)}`);
  }
  const json = await parseJsonResponse(res, "La réponse de Stripe");
  if (!res.ok) {
    const message = json?.error?.message || `Erreur HTTP ${res.status}`;
    throw new PaymentError(message);
  }
  return json;
}

/** Valide la clé secrète en récupérant le solde du compte — n'a aucun effet
 * de bord, sert uniquement au bouton "Tester la connexion" du panneau admin. */
export async function testConnection(config: { secretKey: string | null }): Promise<{ ok: true; livemode: boolean }> {
  const json = await stripeRequest(config, "GET", "/balance");
  return { ok: true, livemode: !!json.livemode };
}

export interface CheckoutLineItem {
  label: string;
  unitAmount: number; // en centimes, déjà arrondi
  qty: number;
}

/**
 * Crée une session Stripe Checkout pour le panier fourni — chaque ligne est
 * envoyée avec price_data (prix ad hoc, pas de Product/Price Stripe
 * préexistant à gérer côté admin). metadata.orderId permet au webhook de
 * retrouver la commande locale correspondante sans dépendre de l'ordre
 * d'arrivée entre la création de la session et l'événement webhook.
 */
export async function createCheckoutSession(
  config: PaymentConfig,
  opts: { orderId: string; items: CheckoutLineItem[]; successUrl: string; cancelUrl: string; customerEmail?: string }
): Promise<{ id: string; url: string }> {
  if (!opts.items.length) throw new PaymentError("Panier vide");
  const line_items = opts.items.map((it) => ({
    quantity: it.qty,
    price_data: {
      currency: config.currency || "eur",
      unit_amount: it.unitAmount,
      product_data: { name: it.label },
    },
  }));
  const json = await stripeRequest(config, "POST", "/checkout/sessions", {
    mode: "payment",
    line_items,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    ...(opts.customerEmail ? { customer_email: opts.customerEmail } : {}),
    "metadata[orderId]": opts.orderId,
    ...(config.allowInstallments
      ? { "payment_method_types[0]": "card", "payment_method_types[1]": "klarna" }
      : {}),
  });
  return { id: json.id, url: json.url };
}

/**
 * Vérifie la signature d'un événement webhook Stripe (en-tête
 * "Stripe-Signature": "t=<timestamp>,v1=<hmac>") — le corps DOIT être le
 * texte brut reçu (avant tout parsing JSON), la signature portant sur
 * l'octet exact envoyé par Stripe (cf. routes/payment.ts, qui monte ce
 * endpoint AVANT le middleware express.json() global pour cette raison).
 * Rejette aussi les événements de plus de 5 minutes (protection rejeu).
 */
export function verifyWebhookSignature(rawBody: string, sigHeader: string | undefined, webhookSecret: string): boolean {
  if (!sigHeader || !webhookSecret) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((kv) => kv.split("=") as [string, string]));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  const expected = crypto.createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const signatureBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== signatureBuf.length || !crypto.timingSafeEqual(expectedBuf, signatureBuf)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  return ageSeconds <= 300;
}

const TAXE_LABELS: Record<string, string> = { adulte: "Adulte", ado: "Ado (12-17 ans)", enfant: "Enfant", bebe: "Bébé" };

/**
 * Calcule la taxe de séjour d'une réservation côté serveur — reprend
 * exactement la formule déjà utilisée côté client dans checkin.html
 * (calcTaxe) : tarif par catégorie d'étoiles, exonération enfants/bébés
 * (exoEnf), demi-tarif ados (reducAdos). Calculée ici (jamais transmise par
 * le client) pour que le montant facturé via Stripe soit fiable — cf.
 * routes/payment.ts /checkout.
 */
export async function computeTaxeSejour(entityId: string, booking: Booking): Promise<{ amount: number; label: string } | null> {
  const cfg = await prisma.entityModuleConfig.findUnique({ where: { entityId } });
  if (!cfg) return null;
  const tarifs = (cfg.tarifs as number[]) || [];
  const tarif = tarifs[cfg.stars - 1] ?? 1.65;
  const nights = Math.max(0, Math.round((booking.endDate.getTime() - booking.startDate.getTime()) / 86400000));
  const occupants = await prisma.occupant.findMany({ where: { bookingId: booking.id } });
  if (!occupants.length || !nights) return null;

  const groups: Record<string, number> = {};
  for (const o of occupants) groups[o.ageCategory] = (groups[o.ageCategory] || 0) + 1;

  let total = 0;
  const lines: string[] = [];
  for (const [age, count] of Object.entries(groups)) {
    const isExo = cfg.exoEnf && (age === "enfant" || age === "bebe");
    const isHalf = cfg.reducAdos && age === "ado";
    const rate = isExo ? 0 : tarif * (isHalf ? 0.5 : 1);
    const amount = rate * nights * count;
    total += amount;
    if (amount > 0) lines.push(`${count} ${TAXE_LABELS[age] || age}`);
  }
  if (total <= 0) return null;
  return { amount: Math.round(total * 100) / 100, label: `Taxe de séjour (${lines.join(", ")} × ${nights}n)` };
}
