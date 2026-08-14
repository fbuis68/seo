import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { provisionEntity } from "../lib/provisionEntity";

/**
 * Parcours d'inscription en ligne (wizard public "Démarrer mon essai"),
 * hors convention /wa (pas d'authentification — c'est le point d'entrée qui
 * en crée une). Provisionne directement l'établissement + son compte admin
 * (mêmes briques que /wa/entity/create et /wa/subscription/status), et crée
 * la fiche Subscription associée, visible immédiatement dans le panneau
 * "Souscriptions" du back-office Sesame — qui fait office de suivi
 * commercial interne tant qu'aucun CRM externe (HubSpot, Pipedrive…) n'est
 * branché.
 */
export const onboardingRouter = Router();

// Catalogue des modules proposés à la souscription — source unique des prix
// par défaut, alignée avec MODULE_DEFS de l'admin (public/admin.html).
export const ONBOARDING_MODULES = [
  { k: "room", ico: "ti-door", label: "Choix de chambre & Plan", desc: "Sélection sur le plan ou en liste", required: true, price: 0 },
  { k: "taxe", ico: "ti-receipt", label: "Taxe de séjour", desc: "Calcul automatique, paiement et export CSV de la taxe à payer", required: false, price: 9 },
  { k: "kyc", ico: "ti-shield-check", label: "Vérification identité", desc: "Scan pièce d'identité + selfie", required: false, price: 15 },
  { k: "eco", ico: "ti-leaf", label: "Préférences éco-séjour", desc: "Ménage, serviettes, gains écologiques", required: false, price: 12 },
  { k: "rewards", ico: "ti-star", label: "Récompenses & fidélité", desc: "Points, statuts Standard/Gold/Premium", required: false, price: 19 },
  { k: "payment", ico: "ti-credit-card", label: "Paiement en ligne", desc: "Carte bancaire, fractionnement", required: false, price: 15 },
  { k: "roomservice", ico: "ti-bell", label: "Room Service", desc: "Commande de produits depuis la chambre", required: false, price: 12 },
  { k: "crm", ico: "ti-address-book", label: "CRM & Marketing", desc: "Base clients, campagnes Email/SMS/WhatsApp", required: false, price: 25 },
] as const;

const MODULE_KEYS = new Set(ONBOARDING_MODULES.map((m) => m.k));

/** GET /onboarding/pricing — grille tarifaire publique consommée par le wizard. */
onboardingRouter.get(
  "/onboarding/pricing",
  asyncHandler(async (_req, res) => {
    const cfg = await prisma.pricingConfig.upsert({
      where: { id: "global" },
      update: {},
      create: { id: "global" },
    });
    const modulePriceOverrides = (cfg.modulePrices as Record<string, number>) || {};
    res.json({
      basePrice: cfg.basePrice,
      trialDays: cfg.trialDays,
      modules: ONBOARDING_MODULES.map((m) => ({
        ...m,
        price: modulePriceOverrides[m.k] ?? m.price,
      })),
    });
  })
);

interface RegisterBody {
  name: string;
  email: string;
  phone?: string;
  addr?: string;
  zipcode?: string;
  city?: string;
  country?: string;
  currency?: string;
  stars?: number;
  rooms?: number;
  avgStay?: number;
  occupancy?: number;
  pms?: string;
  pmsOther?: string;
  existingEntityCode?: string;
  users?: string;
  modules?: string[];
  skipPayment?: boolean;
  ibanHolder?: string;
  iban?: string;
  bic?: string;
  billingEmail?: string;
  consentGiven?: boolean;
}

/**
 * POST /onboarding/register — provisionne l'établissement, son compte admin
 * et la fiche souscription (essai), retourne les accès de démarrage.
 *
 * Sécurité : même si le formulaire propose un "identifiant établissement si
 * connu" pour un client Sesame existant, on ne rattache JAMAIS
 * automatiquement à une Entity existante depuis ce point d'entrée public —
 * ce serait une prise de contrôle de compte triviale (n'importe qui pourrait
 * saisir le code d'un établissement tiers). La valeur est simplement notée
 * dans la fiche souscription pour vérification manuelle par l'équipe Sesame.
 *
 * Le tarif est toujours recalculé côté serveur à partir de la grille
 * publique — jamais depuis les prix envoyés par le client.
 */
onboardingRouter.post(
  "/onboarding/register",
  asyncHandler(async (req, res) => {
    const b = req.body as RegisterBody;
    const name = (b.name || "").trim();
    const email = (b.email || "").trim().toLowerCase();
    if (!name) throw new HttpError(400, "Nom de l'établissement requis");
    if (!email || !email.includes("@")) throw new HttpError(400, "Email de contact valide requis");
    if (!b.pms) throw new HttpError(400, "Merci de préciser votre PMS (ou « Je n'ai pas encore de PMS »)");

    if (!b.skipPayment) {
      if (!b.iban || !b.iban.trim()) throw new HttpError(400, "IBAN requis, ou activez « configurer le paiement plus tard »");
      if (!b.consentGiven) throw new HttpError(400, "Le mandat SEPA doit être accepté pour continuer");
    }

    const cfg = await prisma.pricingConfig.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
    const modulePriceOverrides = (cfg.modulePrices as Record<string, number>) || {};
    const requestedModules = Array.isArray(b.modules) ? b.modules.filter((k) => MODULE_KEYS.has(k as (typeof ONBOARDING_MODULES)[number]["k"])) : [];
    // Les modules requis sont toujours inclus, indépendamment de ce qu'a envoyé le client.
    const selectedKeys = Array.from(new Set([...ONBOARDING_MODULES.filter((m) => m.required).map((m) => m.k), ...requestedModules]));

    const modulePrices: Record<string, number> = {};
    let monthlyTotal = cfg.basePrice;
    selectedKeys.forEach((k) => {
      const def = ONBOARDING_MODULES.find((m) => m.k === k)!;
      const price = modulePriceOverrides[k] ?? def.price;
      modulePrices[k] = price;
      if (!def.required) monthlyTotal += price;
    });

    let pmsLabel = b.pms;
    if (b.pms === "other" && b.pmsOther) pmsLabel = b.pmsOther.trim();
    if (b.existingEntityCode && b.existingEntityCode.trim()) {
      pmsLabel += ` (établissement existant déclaré : ${b.existingEntityCode.trim()} — à vérifier manuellement)`;
    }

    const { entity, adminEmail, adminPassword } = await provisionEntity({
      name,
      stars: b.stars,
      adminEmail: email,
    });

    // Complète les informations de contact/adresse au-delà du socle par défaut de provisionEntity().
    const fullAddr = [b.addr, [b.zipcode, b.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    await prisma.entityModuleConfig.update({
      where: { entityId: entity.id },
      data: {
        hotelAddr: fullAddr || undefined,
        hotelEmail: email,
        currency: b.currency || undefined,
      },
    });

    const trialDays = cfg.trialDays;
    const trialStart = new Date();
    const trialEnd = new Date(trialStart.getTime() + trialDays * 86400000);

    // Coordonnées bancaires : seuls le titulaire et les 4 derniers chiffres
    // sont conservés — jamais l'IBAN/BIC complets, qui n'ont pas leur place
    // en base tant qu'aucun vrai prestataire de paiement (GoCardless) ne les
    // tokenise à la source.
    const ibanLast4 = !b.skipPayment && b.iban ? b.iban.replace(/\s/g, "").slice(-4) : null;

    const subscription = await prisma.subscription.create({
      data: {
        entityId: entity.id,
        hotelName: name,
        stars: b.stars || 3,
        contactEmail: email,
        contactPhone: b.phone,
        pmsLabel,
        modules: selectedKeys,
        basePrice: cfg.basePrice,
        modulePrices,
        monthlyTotal,
        paymentIbanHolder: !b.skipPayment ? b.ibanHolder : undefined,
        paymentIbanLast4: ibanLast4 || undefined,
        status: "trial",
        trialDays,
        trialEnd,
        activatedAt: trialStart,
      },
    });

    res.status(201).json({
      entityId: entity.id,
      entityCode: entity.code,
      admin: { email: adminEmail, password: adminPassword },
      subscription: {
        id: subscription.id,
        status: subscription.status,
        trialStart: trialStart.toISOString(),
        trialEnd: trialEnd.toISOString(),
        trialDays,
        monthlyTotal,
      },
    });
  })
);
