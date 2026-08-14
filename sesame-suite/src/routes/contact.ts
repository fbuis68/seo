import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";

/**
 * Formulaire de contact public (site web) — hors convention /wa, pas
 * d'authentification. Alimente le CRM commercial interne (public/crm.html) :
 * crée un CrmProspect (ou réutilise celui existant, retrouvé par email, pour
 * éviter les doublons sur des soumissions répétées) et y ajoute une tâche à
 * traiter (CrmActivity, done=false) portant le message du formulaire — visible
 * immédiatement dans le journal d'activité de la fiche.
 */
export const contactRouter = Router();

interface ContactBody {
  nom: string;
  email: string;
  secteur?: string;
  message: string;
}

contactRouter.post(
  "/contact",
  asyncHandler(async (req, res) => {
    const b = req.body as ContactBody;
    const nom = (b.nom || "").trim();
    const email = (b.email || "").trim().toLowerCase();
    const secteur = (b.secteur || "").trim();
    const message = (b.message || "").trim();

    if (!nom) throw new HttpError(400, "Nom requis");
    if (!email || !email.includes("@")) throw new HttpError(400, "Email valide requis");
    if (!message) throw new HttpError(400, "Message requis");

    let prospect = await prisma.crmProspect.findFirst({ where: { email } });
    if (!prospect) {
      prospect = await prisma.crmProspect.create({
        data: { nom, email, secteur: secteur || undefined, danger: "Modéré", contrat: "non" },
      });
    } else if (secteur && !prospect.secteur) {
      prospect = await prisma.crmProspect.update({ where: { id: prospect.id }, data: { secteur } });
    }

    await prisma.crmActivity.create({
      data: {
        prospectId: prospect.id,
        type: "Relance",
        text: `Formulaire de contact site web : "${message}"`,
        authorName: "Site web",
        done: false,
      },
    });

    res.status(201).json({ ok: true });
  })
);
