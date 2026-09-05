import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";

/**
 * Origines proposées sur la fiche Client/Prospect/Suspect (d'où vient le
 * contact — ex : "FHT2026", "Site web") — même principe que crmSector.ts :
 * liste éditable en base (CrmOrigineOption) plutôt qu'un champ texte libre,
 * pour servir de filtre fiable à la sélection des envois d'email groupés
 * (public/crm.html). Réservé aux comptes "sesame".
 */
export const crmOrigineRouter = Router();

function shapeOrigine(o: { id: string; label: string; order: number }) {
  return { id: o.id, label: o.label, order: o.order };
}

crmOrigineRouter.get(
  "/crmOrigine/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.crmOrigineOption.findMany({ orderBy: [{ order: "asc" }, { label: "asc" }] });
    res.json(rows.map(shapeOrigine));
  })
);

crmOrigineRouter.post(
  "/crmOrigine/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const label = ((req.body.label as string) || "").trim();
    if (!label) throw new HttpError(400, "Libellé requis");
    const existing = await prisma.crmOrigineOption.findUnique({ where: { label } });
    if (existing) throw new HttpError(409, `L'origine "${label}" existe déjà`);
    const maxOrder = await prisma.crmOrigineOption.aggregate({ _max: { order: true } });
    const row = await prisma.crmOrigineOption.create({
      data: { label, order: (maxOrder._max.order ?? -1) + 1 },
    });
    res.status(201).json(shapeOrigine(row));
  })
);

crmOrigineRouter.post(
  "/crmOrigine/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmOrigineOption.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Origine introuvable");
    const label = req.body.label !== undefined ? String(req.body.label).trim() : undefined;
    if (label !== undefined && !label) throw new HttpError(400, "Le libellé ne peut pas être vide");
    const order = req.body.order !== undefined ? Number(req.body.order) : undefined;
    const row = await prisma.crmOrigineOption.update({ where: { id }, data: { label, order } });
    res.json(shapeOrigine(row));
  })
);

/**
 * POST /wa/crmOrigine/delete — supprime une origine de la liste proposée.
 * N'affecte jamais les fiches qui portent déjà cette origine en texte libre
 * (CrmProspect.origine) : elles gardent leur valeur, simplement absente du
 * menu déroulant pour une nouvelle sélection.
 */
crmOrigineRouter.post(
  "/crmOrigine/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmOrigineOption.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Origine introuvable");
    await prisma.crmOrigineOption.delete({ where: { id } });
    res.json({ ok: true });
  })
);
