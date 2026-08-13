import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";

export const clientPrefsRouter = Router();

/** GET /wa/clientPrefs/list?entityCode=&email= — préférences ménage / tags. */
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
          }
        : { email, menageFreq: null, servFreq: null, menageNote: "", tags: [] }
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
