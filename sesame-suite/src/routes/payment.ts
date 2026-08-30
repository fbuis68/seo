import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { createCheckoutSession, verifyWebhookSignature, computeTaxeSejour, testConnection, PaymentError, CheckoutLineItem } from "../lib/payment";
import { finalizeOrder } from "./roomservice";

export const paymentRouter = Router();

type CartItem = { id: string; label: string; price: number; qty: number };

function shapeConfig(c: {
  enabled: boolean;
  secretKey: string | null;
  webhookSecret: string | null;
  currency: string;
  allowInstallments: boolean;
  includeTaxeSejour: boolean;
}) {
  return {
    enabled: c.enabled,
    // La clé secrète et le secret webhook ne sont jamais renvoyés en clair
    // une fois enregistrés — seul un indicateur "déjà configuré" (même
    // principe que les mots de passe ailleurs dans ce projet), pour éviter
    // qu'ils transitent inutilement vers le navigateur à chaque chargement
    // du panneau. Un champ laissé vide à l'enregistrement conserve la
    // valeur déjà en base (cf. POST /config/update).
    secretKeySet: !!c.secretKey,
    secretKeyLast4: c.secretKey ? c.secretKey.slice(-4) : "",
    webhookSecretSet: !!c.webhookSecret,
    currency: c.currency,
    allowInstallments: c.allowInstallments,
    includeTaxeSejour: c.includeTaxeSejour,
  };
}

/** GET /wa/payment/config — réglages du connecteur Stripe de cet établissement (créés vides au besoin). */
paymentRouter.get(
  "/payment/config",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const config = await prisma.paymentConfig.upsert({
      where: { entityId: entity.id },
      update: {},
      create: { entityId: entity.id },
    });
    res.json(shapeConfig(config));
  })
);

interface ConfigBody {
  enabled?: boolean;
  secretKey?: string;
  webhookSecret?: string;
  currency?: string;
  allowInstallments?: boolean;
  includeTaxeSejour?: boolean;
}

/** POST /wa/payment/config/update — un secretKey/webhookSecret vide conserve la valeur déjà enregistrée. */
paymentRouter.post(
  "/payment/config/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as ConfigBody;
    const data = {
      enabled: b.enabled,
      ...(b.secretKey ? { secretKey: b.secretKey } : {}),
      ...(b.webhookSecret ? { webhookSecret: b.webhookSecret } : {}),
      currency: b.currency,
      allowInstallments: b.allowInstallments,
      includeTaxeSejour: b.includeTaxeSejour,
    };
    const config = await prisma.paymentConfig.upsert({
      where: { entityId: entity.id },
      update: data,
      create: { entityId: entity.id, ...data },
    });
    res.json(shapeConfig(config));
  })
);

/** POST /wa/payment/test — valide la clé secrète enregistrée (ou fournie dans le formulaire, pas forcément encore sauvegardée) via GET /v1/balance. */
paymentRouter.post(
  "/payment/test",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const saved = await prisma.paymentConfig.findUnique({ where: { entityId: entity.id } });
    const b = req.body as ConfigBody;
    const secretKey = b.secretKey || saved?.secretKey || null;
    try {
      const result = await testConnection({ secretKey });
      res.json({ ok: true, livemode: result.livemode });
    } catch (e) {
      if (e instanceof PaymentError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

/** GET /wa/payment/status?entityCode= — public, permet au parcours client de savoir si le paiement en ligne est activé sans exposer la config. */
paymentRouter.get(
  "/payment/status",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const config = await prisma.paymentConfig.findUnique({ where: { entityId: entity.id } });
    res.json({ enabled: !!(config?.enabled && config.secretKey) });
  })
);

/**
 * POST /wa/payment/checkout — crée la commande (statut "pending") et une
 * session Stripe Checkout pour son panier. Les prix des articles du panier
 * (room-service/boutique) sont toujours recalculés ici à partir des
 * Product en base, JAMAIS acceptés tels quels depuis le client — au
 * contraire du champ "total" de /roomservice/create (purement informatif
 * tant qu'aucun paiement réel n'y est attaché), un montant Stripe est de
 * l'argent réellement prélevé : un client ne doit jamais pouvoir modifier
 * le prix qu'il paie en trafiquant la requête. La taxe de séjour, si
 * activée, est ajoutée en plus — calculée elle aussi côté serveur (cf.
 * computeTaxeSejour), jamais transmise par le client.
 */
paymentRouter.post(
  "/payment/checkout",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const config = await prisma.paymentConfig.findUnique({ where: { entityId: entity.id } });
    if (!config || !config.enabled || !config.secretKey) throw new HttpError(400, "Paiement en ligne non configuré");

    const b = req.body as {
      bookingCode?: string;
      source: string;
      clientName?: string;
      roomCode?: string;
      roomName?: string;
      items: CartItem[];
      note?: string;
      successUrl: string;
      cancelUrl: string;
    };
    if (!b.successUrl || !b.cancelUrl) throw new HttpError(400, "successUrl et cancelUrl requis");

    const booking = b.bookingCode
      ? await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code: b.bookingCode } } })
      : null;

    // Prix de confiance : on ignore b.items[].price, on relit le Product.
    const cartItems = (b.items || []).filter((it) => it.qty > 0);
    if (!cartItems.length && !config.includeTaxeSejour) throw new HttpError(400, "Le panier est vide");
    const products = await prisma.product.findMany({
      where: { id: { in: cartItems.map((it) => it.id) }, entityId: entity.id, active: true },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    const lineItems: CheckoutLineItem[] = [];
    const orderItems: CartItem[] = [];
    for (const it of cartItems) {
      const product = productById.get(it.id);
      if (!product) continue; // article inconnu/désactivé — ignoré plutôt que de bloquer tout le panier
      lineItems.push({ label: product.label, unitAmount: Math.round(product.price * 100), qty: it.qty });
      orderItems.push({ id: product.id, label: product.label, price: product.price, qty: it.qty });
    }

    if (config.includeTaxeSejour && booking) {
      const taxe = await computeTaxeSejour(entity.id, booking);
      if (taxe) {
        lineItems.push({ label: taxe.label, unitAmount: Math.round(taxe.amount * 100), qty: 1 });
        orderItems.push({ id: "taxe-sejour", label: taxe.label, price: taxe.amount, qty: 1 });
      }
    }
    if (!lineItems.length) throw new HttpError(400, "Le panier est vide");

    const total = orderItems.reduce((s, it) => s + it.price * it.qty, 0);
    const order = await prisma.order.create({
      data: {
        entityId: entity.id,
        bookingId: booking?.id,
        bookingCode: b.bookingCode || null,
        source: b.source || "roomservice",
        clientName: b.clientName || "Client",
        roomCode: b.roomCode || null,
        roomName: b.roomName || null,
        items: orderItems,
        total,
        note: b.note || null,
        status: "new",
        paymentStatus: "pending",
      },
    });

    try {
      const session = await createCheckoutSession(config, {
        orderId: order.id,
        items: lineItems,
        successUrl: b.successUrl,
        cancelUrl: b.cancelUrl,
        customerEmail: booking?.personEmail,
      });
      await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: session.id } });
      res.status(201).json({ checkoutUrl: session.url, orderId: order.id });
    } catch (e) {
      // La commande reste en base avec paymentStatus="pending" et aucune
      // session Stripe associée — visible côté admin comme un paiement qui
      // n'a jamais pu démarrer, plutôt que silencieusement supprimée.
      const message = e instanceof PaymentError ? e.message : "Erreur Stripe";
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: "failed" } });
      throw new HttpError(400, message);
    }
  })
);

/**
 * POST /wa/payment/webhook — reçoit les événements Stripe. Monté directement
 * sur l'app Express (cf. app.ts) AVANT le middleware express.json() global,
 * avec express.raw() à la place : la vérification de signature (cf.
 * verifyWebhookSignature) porte sur l'octet exact du corps envoyé par
 * Stripe — un corps re-sérialisé après parsing JSON ne matcherait pas la
 * signature. C'est pourquoi ce handler n'est PAS enregistré sur
 * paymentRouter (qui est monté après express.json(), body déjà parsé) mais
 * exporté séparément pour être monté avec son propre middleware.
 *
 * L'établissement N'EST JAMAIS déduit par repli (contrairement à
 * resolveEntity() utilisée ailleurs, dont le comportement "sans entityCode
 * -> tenant par défaut" est correct pour le parcours client mono-tenant en
 * pratique, mais serait ici une fuite entre établissements si l'admin d'un
 * hôtel oublie d'inclure ?entityCode=XXXX dans l'URL de webhook déclarée
 * côté Stripe) : chaque hôtel doit déclarer son PROPRE endpoint webhook
 * dans son dashboard Stripe avec cette query string (cf. panneau admin,
 * qui affiche l'URL exacte à copier).
 */
export const stripeWebhookHandler = asyncHandler(async (req: Request, res: Response) => {
  const entityCode = req.query.entityCode as string | undefined;
  if (!entityCode) throw new HttpError(400, "entityCode manquant dans l'URL du webhook");
  const entity = await prisma.entity.findUnique({ where: { code: entityCode } });
  if (!entity) throw new HttpError(404, `Entity inconnue: ${entityCode}`);
  const config = await prisma.paymentConfig.findUnique({ where: { entityId: entity.id } });
  if (!config?.webhookSecret) throw new HttpError(400, "Webhook non configuré");

  const rawBody = (req.body as Buffer).toString("utf8");
  const sig = req.headers["stripe-signature"] as string | undefined;
  if (!verifyWebhookSignature(rawBody, sig, config.webhookSecret)) {
    throw new HttpError(400, "Signature invalide");
  }

  const event = JSON.parse(rawBody);
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;
    if (orderId) {
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (order && order.paymentStatus !== "paid") {
        const updated = await prisma.order.update({
          where: { id: orderId },
          data: { paymentStatus: "paid", paidAt: new Date(), stripePaymentIntentId: session.payment_intent || null },
        });
        const booking = updated.bookingId ? await prisma.booking.findUnique({ where: { id: updated.bookingId } }) : null;
        await finalizeOrder(entity, updated, booking, (updated.items as CartItem[]) || [], updated.note || undefined);
      }
    }
  } else if (event.type === "checkout.session.expired") {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;
    if (orderId) {
      await prisma.order.updateMany({ where: { id: orderId, paymentStatus: "pending" }, data: { paymentStatus: "failed" } });
    }
  }

  res.json({ received: true });
});
