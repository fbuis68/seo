import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

/**
 * Statuts de propreté détaillés par chambre (panneau "Planning ménage", vue
 * "Statuts chambres") — sur le modèle d'un connecteur PMS de référence
 * (Thaïs) : une chambre a toujours exactement un de ces 8 statuts. Distinct
 * de RoomHousekeepingStatus.status (occupation : libre/occupee/...), géré
 * ailleurs (housekeepingTask.ts).
 */
export const CLEAN_STATUSES = [
  { k: "propre", label: "Propre", color: "#2ECC71" },
  { k: "recouche_lit", label: "Recouche lit à faire", color: "#E67E22" },
  { k: "recouche_blanc", label: "Recouche à blanc", color: "#F1C40F" },
  { k: "sale", label: "Sale", color: "#E74C3C" },
  { k: "en_verif", label: "En vérif", color: "#3498DB" },
  { k: "taie_oreiller", label: "Taie d'oreiller", color: "#9B59B6" },
  { k: "serviette", label: "Serviette", color: "#1ABC9C" },
  { k: "drap", label: "Drap", color: "#95A5A6" },
] as const;
const CLEAN_STATUS_KEYS = new Set(CLEAN_STATUSES.map((s) => s.k));

export const housekeepingStatusRouter = Router();

/**
 * GET /wa/housekeepingStatus/list — statut de propreté de chaque chambre de
 * l'hôtel (créé à "sale" par défaut au premier accès si absent, plutôt que
 * de planter sur les chambres créées avant ce champ).
 */
housekeepingStatusRouter.get(
  "/housekeepingStatus/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const rooms = await prisma.room.findMany({
      where: { entityId: entity.id },
      orderBy: { code: "asc" },
      include: { housekeepingStatus: true },
    });
    res.json(
      rooms.map((r) => ({
        roomCode: r.code,
        roomName: r.name,
        floor: r.floor,
        cleanStatus: r.housekeepingStatus?.cleanStatus || "sale",
        occupancyStatus: r.housekeepingStatus?.status || "libre",
        updatedAt: r.housekeepingStatus?.updatedAt || null,
      }))
    );
  })
);

/** POST /wa/housekeepingStatus/update — body: { roomCode, cleanStatus } */
housekeepingStatusRouter.post(
  "/housekeepingStatus/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const roomCode = (req.body.roomCode as string) || "";
    const cleanStatus = (req.body.cleanStatus as string) || "";
    if (!roomCode) throw new HttpError(400, "roomCode requis");
    if (!CLEAN_STATUS_KEYS.has(cleanStatus as (typeof CLEAN_STATUSES)[number]["k"])) {
      throw new HttpError(400, `cleanStatus invalide — valeurs possibles : ${[...CLEAN_STATUS_KEYS].join(", ")}`);
    }
    const room = await prisma.room.findUnique({ where: { entityId_code: { entityId: entity.id, code: roomCode } } });
    if (!room) throw new HttpError(404, "Chambre introuvable");

    const row = await prisma.roomHousekeepingStatus.upsert({
      where: { roomId: room.id },
      update: { cleanStatus },
      create: { roomId: room.id, cleanStatus },
    });
    res.json({ roomCode: room.code, cleanStatus: row.cleanStatus, updatedAt: row.updatedAt });
  })
);

/**
 * GET /wa/housekeepingStatus/week?from=YYYY-MM-DD — vue hebdomadaire
 * "philosophie Thaïs" : pour chaque jour de la semaine (7 jours à partir de
 * `from`), le nombre de départs (check-out) et d'arrivées (check-in) réels
 * (dérivés des réservations). Contrairement à la maquette de référence, qui
 * affiche aussi un historique quotidien des statuts de propreté, cette
 * version ne fabrique pas de nombres pour les statuts sur des jours passés
 * ou futurs : aucun instantané quotidien n'est conservé (cleanStatus est un
 * état courant, pas un historique) — seule la répartition ACTUELLE des
 * statuts est renvoyée une fois, à part, pour affichage sur la colonne
 * "aujourd'hui" seulement.
 */
housekeepingStatusRouter.get(
  "/housekeepingStatus/week",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const fromStr = (req.query.from as string) || new Date().toISOString().slice(0, 10);
    const from = new Date(fromStr + "T00:00:00.000Z");
    if (isNaN(from.getTime())) throw new HttpError(400, "from invalide");

    const days: { date: string; checkins: number; checkouts: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(from.getTime() + i * 86400000);
      days.push({ date: d.toISOString().slice(0, 10), checkins: 0, checkouts: 0 });
    }
    const rangeStart = from;
    const rangeEnd = new Date(from.getTime() + 7 * 86400000);

    const bookings = await prisma.booking.findMany({
      where: {
        entityId: entity.id,
        status: { not: "cancelled" },
        OR: [
          { startDate: { gte: rangeStart, lt: rangeEnd } },
          { endDate: { gte: rangeStart, lt: rangeEnd } },
        ],
      },
      select: { startDate: true, endDate: true },
    });
    const byDate = new Map(days.map((d) => [d.date, d]));
    for (const b of bookings) {
      const ci = b.startDate.toISOString().slice(0, 10);
      const co = b.endDate.toISOString().slice(0, 10);
      const ciDay = byDate.get(ci);
      if (ciDay) ciDay.checkins++;
      const coDay = byDate.get(co);
      if (coDay) coDay.checkouts++;
    }

    const rooms = await prisma.room.findMany({ where: { entityId: entity.id }, include: { housekeepingStatus: true } });
    const todayCounts: Record<string, number> = {};
    CLEAN_STATUSES.forEach((s) => (todayCounts[s.k] = 0));
    rooms.forEach((r) => {
      const k = r.housekeepingStatus?.cleanStatus || "sale";
      if (k in todayCounts) todayCounts[k]++;
    });

    res.json({ days, todayCounts, totalRooms: rooms.length });
  })
);
