import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { creditLoyaltyPoints } from "../lib/loyaltyCredit";
import { asyncHandler, HttpError } from "../lib/asyncHandler";

export const clientPrefsRouter = Router();

/** GET /wa/clientPrefs/list?entityCode=&email= — préférences ménage / tags / newsletter. */
clientPrefsRouter.get(
  "/clientPrefs/list",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const email = ((req.query.email as string) || "").trim().toLowerCase();
    if (!email) throw new HttpError(400, "email requis");

    const prefs = await prisma.clientPrefs.findUnique({
      where: { entityId_email: { entityId: entity.id, email } },
    });

    res.json(
      prefs
        ? {
            email: prefs.email,
            menageFreq: prefs.menageFreq,
            servFreq: prefs.servFreq,
            menageNote: prefs.menageNote || "",
            tags: prefs.tags || [],
            newsletterOptIn: prefs.newsletterOptIn,
            newsletterPointsAwarded: prefs.newsletterPointsAwarded,
          }
        : {
            email,
            menageFreq: null,
            servFreq: null,
            menageNote: "",
            tags: [],
            newsletterOptIn: false,
            newsletterPointsAwarded: false,
          }
    );
  })
);

/** POST /wa/clientPrefs/update — upsert (remplace SESAME_CLIENT_PREFS_*). */
clientPrefsRouter.post(
  "/clientPrefs/update",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as {
      email: string;
      menageFreq?: number;
      servFreq?: number;
      menageNote?: string;
      tags?: string[];
    };
    const email = (b.email || "").trim().toLowerCase();
    if (!email) throw new HttpError(400, "email requis");

    const prefs = await prisma.clientPrefs.upsert({
      where: { entityId_email: { entityId: entity.id, email } },
      update: {
        menageFreq: b.menageFreq,
        servFreq: b.servFreq,
        menageNote: b.menageNote,
        tags: b.tags,
      },
      create: {
        entityId: entity.id,
        email,
        menageFreq: b.menageFreq,
        servFreq: b.servFreq,
        menageNote: b.menageNote,
        tags: b.tags || [],
      },
    });

    res.json({
      email: prefs.email,
      menageFreq: prefs.menageFreq,
      servFreq: prefs.servFreq,
      menageNote: prefs.menageNote || "",
      tags: prefs.tags || [],
    });
  })
);

/**
 * POST /wa/clientPrefs/newsletterOptIn — body: { email, optIn }
 * Inscription/désinscription volontaire à la newsletter depuis l'espace
 * client (distincte d'emailOptOut, qui n'est qu'un état par défaut) — pilote
 * aussi emailOptOut pour rester cohérente avec le lien de désabonnement des
 * campagnes (cf. lib/unsubscribeToken.ts) : s'inscrire lève un opt-out
 * antérieur, se désinscrire ici équivaut à cliquer ce lien. Le bonus de
 * points (EntityModuleConfig.gains.points.newsletterBonus, 0 = désactivé)
 * n'est crédité qu'une seule fois, à la toute première inscription.
 */
clientPrefsRouter.post(
  "/clientPrefs/newsletterOptIn",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as { email: string; optIn: boolean };
    const email = (b.email || "").trim().toLowerCase();
    if (!email) throw new HttpError(400, "email requis");
    const optIn = !!b.optIn;

    const existing = await prisma.clientPrefs.findUnique({
      where: { entityId_email: { entityId: entity.id, email } },
    });

    const prefs = await prisma.clientPrefs.upsert({
      where: { entityId_email: { entityId: entity.id, email } },
      update: {
        newsletterOptIn: optIn,
        newsletterOptInAt: optIn ? new Date() : existing?.newsletterOptInAt,
        emailOptOut: !optIn,
        emailOptOutAt: optIn ? null : new Date(),
      },
      create: {
        entityId: entity.id,
        email,
        newsletterOptIn: optIn,
        newsletterOptInAt: optIn ? new Date() : null,
        emailOptOut: !optIn,
        emailOptOutAt: optIn ? null : new Date(),
      },
    });

    let pointsAwarded = 0;
    if (optIn && !existing?.newsletterPointsAwarded) {
      const cfg = await prisma.entityModuleConfig.findUnique({ where: { entityId: entity.id } });
      const gains = (cfg?.gains as { points?: { newsletterBonus?: number } }) || {};
      const bonus = gains.points?.newsletterBonus || 0;
      if (bonus > 0) {
        await creditLoyaltyPoints(entity, email, bonus, 0, "newsletter-optin");
        await prisma.clientPrefs.update({ where: { id: prefs.id }, data: { newsletterPointsAwarded: true } });
        pointsAwarded = bonus;
      }
    }

    res.json({ email, newsletterOptIn: prefs.newsletterOptIn, pointsAwarded });
  })
);
