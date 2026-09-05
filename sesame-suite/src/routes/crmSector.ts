import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";

/**
 * Secteurs d'activité proposés sur la fiche Client/Prospect/Suspect —
 * remplace la liste SECTEURS codée en dur dans public/crm.html (jusqu'au
 * 04/09/2026) par une liste éditable en base (CrmSectorOption), pour pouvoir
 * ajouter un secteur rencontré lors d'un import externe (ex : "Restauration"
 * sur un salon) sans toucher au code. Réservé aux comptes "sesame".
 */
export const crmSectorRouter = Router();

function shapeSector(s: { id: string; label: string; order: number }) {
  return { id: s.id, label: s.label, order: s.order };
}

crmSectorRouter.get(
  "/crmSector/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.crmSectorOption.findMany({ orderBy: [{ order: "asc" }, { label: "asc" }] });
    res.json(rows.map(shapeSector));
  })
);

crmSectorRouter.post(
  "/crmSector/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const label = ((req.body.label as string) || "").trim();
    if (!label) throw new HttpError(400, "Libellé requis");
    const existing = await prisma.crmSectorOption.findUnique({ where: { label } });
    if (existing) throw new HttpError(409, `Le secteur "${label}" existe déjà`);
    const maxOrder = await prisma.crmSectorOption.aggregate({ _max: { order: true } });
    const row = await prisma.crmSectorOption.create({
      data: { label, order: (maxOrder._max.order ?? -1) + 1 },
    });
    res.status(201).json(shapeSector(row));
  })
);

crmSectorRouter.post(
  "/crmSector/update",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmSectorOption.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Secteur introuvable");
    const label = req.body.label !== undefined ? String(req.body.label).trim() : undefined;
    if (label !== undefined && !label) throw new HttpError(400, "Le libellé ne peut pas être vide");
    const order = req.body.order !== undefined ? Number(req.body.order) : undefined;
    const row = await prisma.crmSectorOption.update({ where: { id }, data: { label, order } });
    res.json(shapeSector(row));
  })
);

/**
 * POST /wa/crmSector/delete — supprime un secteur de la liste proposée.
 * N'affecte jamais les fiches qui portent déjà ce secteur en texte libre
 * (CrmProspect.secteur) : elles gardent leur valeur, simplement absente du
 * menu déroulant pour une nouvelle sélection.
 */
crmSectorRouter.post(
  "/crmSector/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const id = (req.body.id as string) || "";
    const existing = await prisma.crmSectorOption.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Secteur introuvable");
    await prisma.crmSectorOption.delete({ where: { id } });
    res.json({ ok: true });
  })
);
