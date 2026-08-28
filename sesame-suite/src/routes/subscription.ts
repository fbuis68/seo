import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { provisionEntity } from "../lib/provisionEntity";
import { fireTrigger } from "../lib/automation";
import { resolveEntity } from "../lib/entity";
import { ONBOARDING_MODULES } from "./onboarding";

export const subscriptionRouter = Router();

// ── Grille tarifaire globale (panneau "Souscriptions") ──

subscriptionRouter.get(
  "/pricingConfig",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const cfg = await prisma.pricingConfig.upsert({
      where: { id: "global" },
      update: {},
      create: { id: "global" },
    });
    res.json(cfg);
  })
);

subscriptionRouter.post(
  "/pricingConfig/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as { basePrice?: number; trialDays?: number; modulePrices?: Record<string, number> };
    const cfg = await prisma.pricingConfig.upsert({
      where: { id: "global" },
      update: { basePrice: b.basePrice, trialDays: b.trialDays, modulePrices: b.modulePrices },
      create: { id: "global", basePrice: b.basePrice ?? 49, trialDays: b.trialDays ?? 30, modulePrices: b.modulePrices ?? {} },
    });
    res.json(cfg);
  })
);

// ── Demandes de souscription ──

function shapeSub(s: any) {
  return {
    id: s.id,
    entityId: s.entityId,
    entityCode: s.entity ? s.entity.code : null,
    hotelName: s.hotelName,
    stars: s.stars,
    contact: { email: s.contactEmail, phone: s.contactPhone || "" },
    pmsLabel: s.pmsLabel || "",
    modules: (s.modules as string[]) || [],
    pricing: { basePrice: s.basePrice, modulePrices: s.modulePrices || {}, monthlyTotal: s.monthlyTotal },
    paymentMethod: s.paymentIbanLast4 ? { ibanHolder: s.paymentIbanHolder || "", ibanLast4: s.paymentIbanLast4 } : null,
    status: s.status,
    trialDays: s.trialDays,
    trialEnd: s.trialEnd,
    activatedAt: s.activatedAt,
    createdAt: s.createdAt,
  };
}

/**
 * GET /subscription/list?entityCode= — sans entityCode, portefeuille complet
 * (vue Sesame HQ). Avec entityCode (envoyé automatiquement par adminFetch
 * dès qu'un hôtel est "actif" côté admin, cf. ACTIVE_ENTITY_CODE dans
 * admin.html), scope à ce seul établissement — le paramètre était jusqu'ici
 * ignoré, donc le panneau Souscriptions montrait tous les hôtels même en
 * contexte "hôtel actif".
 */
subscriptionRouter.get(
  "/subscription/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const entityCode = req.query.entityCode as string | undefined;
    const subs = await prisma.subscription.findMany({
      where: entityCode ? { entity: { code: entityCode } } : undefined,
      include: { entity: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(subs.map(shapeSub));
  })
);

interface CreateSubBody {
  hotelName: string;
  stars?: number;
  contactEmail: string;
  contactPhone?: string;
  pmsLabel?: string;
  modules?: string[];
  basePrice: number;
  modulePrices?: Record<string, number>;
  monthlyTotal: number;
  trialDays?: number;
  paymentIbanHolder?: string;
  paymentIbanLast4?: string;
}

subscriptionRouter.post(
  "/subscription/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as CreateSubBody;
    if (!b.hotelName || !b.contactEmail) throw new HttpError(400, "Nom de l'hôtel et email de contact requis");
    const trialDays = b.trialDays ?? 30;
    const trialEnd = new Date(Date.now() + trialDays * 86400000);
    const sub = await prisma.subscription.create({
      data: {
        hotelName: b.hotelName,
        stars: b.stars || 3,
        contactEmail: b.contactEmail,
        contactPhone: b.contactPhone,
        pmsLabel: b.pmsLabel,
        modules: b.modules || [],
        basePrice: b.basePrice,
        modulePrices: b.modulePrices || {},
        monthlyTotal: b.monthlyTotal,
        trialDays,
        trialEnd,
        paymentIbanHolder: b.paymentIbanHolder,
        paymentIbanLast4: b.paymentIbanLast4,
      },
    });
    res.status(201).json(shapeSub(sub));
  })
);

/** POST /wa/subscription/status — body: { id, status }.
 * Passage à "active" sans établissement encore provisionné : crée l'Entity +
 * son compte admin (cf. provisionEntity) et lie la souscription. */
subscriptionRouter.post(
  "/subscription/status",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, status } = req.body as { id: string; status: string };
    const sub = await prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw new HttpError(404, "Souscription introuvable");

    let entityId = sub.entityId;
    let provisioned: { adminEmail: string; adminPassword: string } | null = null;
    if (status === "active" && !entityId) {
      const { entity, adminEmail, adminPassword } = await provisionEntity({ name: sub.hotelName, stars: sub.stars, adminEmail: sub.contactEmail });
      entityId = entity.id;
      provisioned = { adminEmail, adminPassword };
    }

    const updated = await prisma.subscription.update({
      where: { id },
      data: { status, entityId, activatedAt: status === "active" ? new Date() : sub.activatedAt },
      include: { entity: true },
    });

    if (status !== sub.status && (status === "active" || status === "cancelled")) {
      fireTrigger(status === "active" ? "crm.subscription_activated" : "crm.subscription_cancelled", {
        entityId: null,
        targetType: "subscription",
        targetId: updated.id,
        recipient: { email: updated.contactEmail, phone: updated.contactPhone },
        variables: { nom: updated.hotelName, secteur: "" },
      }).catch((e) => console.error(`[automation] crm.subscription_${status}:`, e));
    }

    res.json({ ...shapeSub(updated), provisioned });
  })
);

subscriptionRouter.post(
  "/subscription/extendTrial",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, days } = req.body as { id: string; days: number };
    const sub = await prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw new HttpError(404, "Souscription introuvable");
    const base = sub.trialEnd && sub.trialEnd > new Date() ? sub.trialEnd : new Date();
    const trialEnd = new Date(base.getTime() + days * 86400000);
    const updated = await prisma.subscription.update({ where: { id }, data: { trialEnd, trialDays: sub.trialDays + days } });
    res.json(shapeSub(updated));
  })
);

// ── Modules souscrits — consommé par le back-office hôtel pour le verrouillage des panneaux ──

/**
 * GET /wa/subscription/mine — accessible à tout compte admin (hôtel ou
 * sesame), scope automatiquement sur l'établissement courant via
 * resolveEntity() (entityCode si compte sesame, propre établissement sinon).
 *
 * `modules: null` signifie "aucune souscription formelle enregistrée" — cas
 * des établissements provisionnés manuellement (panneau Hôtels, seed) plutôt
 * que via l'inscription en ligne : dans ce cas on ne verrouille RIEN côté
 * front (pas de régression sur les établissements existants qui n'ont jamais
 * eu de Subscription).
 */
subscriptionRouter.get(
  "/subscription/mine",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const sub = await prisma.subscription.findFirst({ where: { entityId: entity.id }, orderBy: { createdAt: "desc" } });
    res.json({ modules: sub ? (sub.modules as string[]) : null });
  })
);

interface UpdateModulesBody {
  id: string;
  modules: string[];
}

/**
 * POST /wa/subscription/updateModules — seul moyen aujourd'hui de faire
 * évoluer les modules d'une souscription existante (jusqu'ici fixés une
 * fois pour toutes à la création). Recalcule monthlyTotal à partir de la
 * grille tarifaire globale (jamais depuis des prix envoyés par le client).
 */
subscriptionRouter.post(
  "/subscription/updateModules",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as UpdateModulesBody;
    const sub = await prisma.subscription.findUnique({ where: { id: b.id } });
    if (!sub) throw new HttpError(404, "Souscription introuvable");

    const validKeys = new Set(ONBOARDING_MODULES.map((m) => m.k));
    const requiredKeys = ONBOARDING_MODULES.filter((m) => m.required).map((m) => m.k);
    const requested = Array.isArray(b.modules) ? b.modules.filter((k) => validKeys.has(k as (typeof ONBOARDING_MODULES)[number]["k"])) : [];
    const modules = Array.from(new Set([...requiredKeys, ...requested]));

    const cfg = await prisma.pricingConfig.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
    const modulePriceOverrides = (cfg.modulePrices as Record<string, number>) || {};
    const modulePrices: Record<string, number> = {};
    let monthlyTotal = sub.basePrice;
    modules.forEach((k) => {
      const def = ONBOARDING_MODULES.find((m) => m.k === k)!;
      const price = modulePriceOverrides[k] ?? def.price;
      modulePrices[k] = price;
      if (!def.required) monthlyTotal += price;
    });

    const updated = await prisma.subscription.update({
      where: { id: b.id },
      data: { modules, modulePrices, monthlyTotal },
      include: { entity: true },
    });
    res.json(shapeSub(updated));
  })
);

/**
 * POST /wa/subscription/requestModule — body: { moduleKey }. Il n'existe pas
 * de souscription en libre-service à un module dans cette app (pas de
 * paiement en ligne intégré) — un compte hôtel qui clique "Demander
 * l'activation" sur un module verrouillé passe donc par cette route, qui
 * journalise la demande sur la fiche CRM prospect liée (si elle existe) pour
 * que l'équipe Sesame la traite manuellement. Best-effort : ne fait jamais
 * échouer la requête si aucune fiche n'est liée.
 */
subscriptionRouter.post(
  "/subscription/requestModule",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const moduleKey = (req.body.moduleKey as string) || "";
    const mod = ONBOARDING_MODULES.find((m) => m.k === moduleKey);
    if (!mod) throw new HttpError(400, "Module inconnu");

    const sub = await prisma.subscription.findFirst({ where: { entityId: entity.id }, include: { crmProspect: true }, orderBy: { createdAt: "desc" } });
    if (sub?.crmProspect) {
      await prisma.crmActivity.create({
        data: {
          prospectId: sub.crmProspect.id,
          type: "Relance",
          text: `Demande d'activation du module "${mod.label}" depuis le back-office (${entity.name}).`,
          authorName: req.admin!.email,
        },
      });
    }
    res.json({ ok: true });
  })
);
