import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";

/**
 * Contacts multiples d'une fiche client/prospect (16/09/2026) — une
 * entreprise a souvent plusieurs interlocuteurs à des fonctions
 * différentes, qui doivent tous pouvoir recevoir les campagnes email
 * envoyées depuis la liste filtrée des fiches (cf. crm.html
 * crmSelectedRecipients()), sans être limités au seul email principal de
 * la fiche (CrmProspect.referent/email/tel, qui reste le contact "par
 * défaut" affiché partout ailleurs — inchangé).
 */
export const crmContactRouter = Router();

function shapeContact(c: { id: string; prospectId: string; name: string; fonction: string | null; email: string | null; phone: string | null; createdAt: Date; updatedAt: Date }) {
  return {
    id: c.id,
    prospectId: c.prospectId,
    name: c.name,
    fonction: c.fonction || "",
    email: c.email || "",
    phone: c.phone || "",
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

crmContactRouter.get(
  "/crmContact/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const prospectId = req.query.prospectId as string;
    if (!prospectId) throw new HttpError(400, "prospectId requis");
    const rows = await prisma.crmContact.findMany({ where: { prospectId }, orderBy: { createdAt: "asc" } });
    res.json(rows.map(shapeContact));
  })
);

/**
 * GET /wa/crmContact/listByProspects?ids=a,b,c — un seul appel pour
 * récupérer les contacts de plusieurs fiches à la fois (envoi groupé
 * depuis une sélection de la liste), plutôt qu'un appel par fiche
 * sélectionnée.
 */
crmContactRouter.get(
  "/crmContact/listByProspects",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const raw = (req.query.ids as string) || "";
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return res.json([]);
    const rows = await prisma.crmContact.findMany({ where: { prospectId: { in: ids } }, orderBy: { createdAt: "asc" } });
    res.json(rows.map(shapeContact));
  })
);

interface ContactBody {
  prospectId?: string;
  name?: string;
  fonction?: string;
  email?: string;
  phone?: string;
}

crmContactRouter.post(
  "/crmContact/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as ContactBody;
    if (!b.prospectId) throw new HttpError(400, "prospectId requis");
    if (!b.name || !b.name.trim()) throw new HttpError(400, "Nom requis");
    const prospect = await prisma.crmProspect.findUnique({ where: { id: b.prospectId } });
    if (!prospect) throw new HttpError(404, "Fiche introuvable");
    const row = await prisma.crmContact.create({
      data: { prospectId: b.prospectId, name: b.name.trim(), fonction: b.fonction?.trim() || null, email: b.email?.trim() || null, phone: b.phone?.trim() || null },
    });
    res.status(201).json(shapeContact(row));
  })
);

crmContactRouter.post(
  "/crmContact/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const { id, ...b } = req.body as ContactBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");
    const existing = await prisma.crmContact.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Contact introuvable");
    const row = await prisma.crmContact.update({
      where: { id },
      data: { name: b.name?.trim() || existing.name, fonction: b.fonction !== undefined ? b.fonction?.trim() || null : undefined, email: b.email !== undefined ? b.email?.trim() || null : undefined, phone: b.phone !== undefined ? b.phone?.trim() || null : undefined },
    });
    res.json(shapeContact(row));
  })
);

crmContactRouter.post(
  "/crmContact/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body as { id?: string }).id;
    if (!id) throw new HttpError(400, "id requis");
    await prisma.crmContact.deleteMany({ where: { id } });
    res.json({ ok: true });
  })
);

/** POST /wa/crmContact/bulkDelete — suppression multiple depuis la carte Contacts d'une fiche. */
crmContactRouter.post(
  "/crmContact/bulkDelete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const ids = (req.body as { ids?: string[] }).ids || [];
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, "ids requis");
    const result = await prisma.crmContact.deleteMany({ where: { id: { in: ids } } });
    res.json({ ok: true, deleted: result.count });
  })
);
