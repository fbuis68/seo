import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { provisionEntity } from "../lib/provisionEntity";
import { fireTrigger } from "../lib/automation";

export const entityRouter = Router();

/** GET /wa/entity/list — tous les établissements (panneau "Hôtels", Sesame uniquement). */
entityRouter.get(
  "/entity/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const entities = await prisma.entity.findMany({
      where: { NOT: { code: "SESAME-HQ" } },
      include: { config: true, group: true, _count: { select: { rooms: true, adminUsers: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json(
      entities.map((e) => ({
        id: e.id,
        code: e.code,
        name: e.name,
        hotelName: e.config?.hotelName || e.name,
        groupCode: e.group?.code || null,
        groupName: e.group?.name || null,
        stars: e.config?.stars ?? 3,
        color: (e.config?.colors as any)?.primary || "#8B1A2E",
        lang: e.config?.lang || "fr",
        currency: e.config?.currency || "EUR",
        roomsCount: e._count.rooms,
        adminsCount: e._count.adminUsers,
        modulesActive: e.config?.checkinModules
          ? Object.values(e.config.checkinModules as Record<string, { active?: boolean }>).filter((m) => m && m.active).length
          : 0,
        createdAt: e.createdAt,
      }))
    );
  })
);

interface CreateBody {
  name: string;
  stars?: number;
  adminEmail?: string;
  adminPassword?: string;
}

/** POST /wa/entity/create — provisionne un nouvel établissement + son compte admin. */
entityRouter.post(
  "/entity/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as CreateBody;
    if (!b.name) throw new HttpError(400, "Nom de l'hôtel requis");
    try {
      const { entity, adminEmail, adminPassword } = await provisionEntity({
        name: b.name,
        stars: b.stars,
        adminEmail: b.adminEmail,
        adminPassword: b.adminPassword,
      });

      // Relie systématiquement une fiche CRM à l'établissement dès sa
      // création manuelle — jusqu'ici seule l'inscription en ligne
      // (onboarding.ts) créait ce lien, laissant les établissements
      // provisionnés à la main par Sesame invisibles du CRM (pas de langue/
      // devise/fuseau consultables sur la fiche). "Client" plutôt que
      // "Prospect" : une création manuelle par l'équipe Sesame correspond à
      // un établissement déjà engagé, pas à un essai en self-service.
      const prospect = await prisma.crmProspect.create({
        data: {
          entityId: entity.id,
          nom: b.name,
          type: "Client",
          secteur: "Hôtellerie",
          etoiles: b.stars ? "★".repeat(Math.min(b.stars, 5)) : undefined,
          danger: "Modéré",
          contrat: "en cours",
          modules: 0,
          email: adminEmail,
          webApp: true,
          checkin: true,
          messagerie: "Noreply",
        },
      });
      fireTrigger("crm.prospect_created", {
        entityId: null,
        targetType: "crmProspect",
        targetId: prospect.id,
        recipient: { email: prospect.email, phone: prospect.tel },
        variables: { nom: prospect.nom, secteur: prospect.secteur || "" },
      }).catch((e) => console.error("[automation] crm.prospect_created:", e));
      await prisma.crmActivity.create({
        data: {
          prospectId: prospect.id,
          type: "Note interne",
          text: "Établissement provisionné manuellement depuis le panneau Hôtels [Multi].",
          authorName: "Automatique",
        },
      });

      res.status(201).json({ entity: { id: entity.id, code: entity.code, name: entity.name }, admin: { email: adminEmail, password: adminPassword } });
    } catch (e) {
      throw new HttpError(409, e instanceof Error ? e.message : "Création impossible");
    }
  })
);

/** POST /wa/entity/delete — body: { code } — supprime l'établissement (cascade). */
entityRouter.post(
  "/entity/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const code = (req.body.code as string) || "";
    if (code === "SESAME-HQ") throw new HttpError(400, "Impossible de supprimer l'entité Sesame");
    const entity = await prisma.entity.findUnique({ where: { code } });
    if (!entity) throw new HttpError(404, "Établissement introuvable");
    await prisma.entity.delete({ where: { id: entity.id } });
    res.json({ ok: true });
  })
);
