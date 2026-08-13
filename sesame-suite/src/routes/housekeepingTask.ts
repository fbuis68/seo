import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

export const housekeepingTaskRouter = Router();

function shapeTask(t: {
  id: string;
  roomCode: string;
  taskDate: Date;
  type: string;
  subtype: string | null;
  bookingCode: string | null;
  ecoAuto: boolean;
  status: string;
  priority: string;
  durationMinutes: number | null;
  assignedStaffId: string | null;
  notes: string | null;
}) {
  return {
    id: t.id,
    roomCode: t.roomCode,
    date: t.taskDate.toISOString().slice(0, 10),
    type: t.type,
    subtype: t.subtype || "",
    bookingCode: t.bookingCode || "",
    ecoAuto: t.ecoAuto,
    status: t.status,
    priority: t.priority,
    durationMinutes: t.durationMinutes,
    assignedStaffId: t.assignedStaffId || "",
    notes: t.notes || "",
  };
}

/**
 * POST /wa/housekeepingTask/createEco
 * body: { roomCode, bookingCode, guestName, checkIn, checkOut, menageFreq, servFreq, eauEconomisee, co2Evite }
 *
 * Génère les tâches ménage planifiées à partir des préférences éco choisies
 * par le client à l'étape 5 du check-in — équivalent serveur de
 * pushEcoToPlanning() / HousekeepingTaskDao.createEcoAutoTasks() documenté
 * comme développement prioritaire dans le dossier de lancement (§10.4).
 */
housekeepingTaskRouter.post(
  "/housekeepingTask/createEco",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as {
      roomCode: string;
      bookingCode: string;
      guestName?: string;
      checkIn: string;
      checkOut: string;
      menageFreq: number;
      servFreq: number;
      eauEconomisee?: number;
      co2Evite?: number;
    };
    if (!b.roomCode || !b.checkIn) throw new HttpError(400, "roomCode et checkIn requis");

    const room = await prisma.room.findUnique({
      where: { entityId_code: { entityId: entity.id, code: b.roomCode } },
    });

    const start = new Date(b.checkIn);
    const nights = b.checkOut ? Math.round((new Date(b.checkOut).getTime() - start.getTime()) / 86400000) : 0;

    const cleanDates: string[] = [];
    if (b.menageFreq > 0 && nights > 0) {
      for (let d = b.menageFreq; d < nights; d += b.menageFreq) {
        const dt = new Date(start);
        dt.setDate(dt.getDate() + d);
        cleanDates.push(dt.toISOString().slice(0, 10));
      }
    }

    // Idempotent : on retire les tâches éco précédentes pour cette chambre/réservation
    await prisma.housekeepingTask.deleteMany({
      where: { entityId: entity.id, roomCode: b.roomCode, bookingCode: b.bookingCode, ecoAuto: true },
    });

    const menageLabel = b.menageFreq === 0 ? "Aucun ménage" : b.menageFreq === 1 ? "Quotidien" : `Tous les ${b.menageFreq} jours`;
    const created = await prisma.$transaction(
      cleanDates.map((date) =>
        prisma.housekeepingTask.create({
          data: {
            entityId: entity.id,
            roomCode: b.roomCode,
            taskDate: new Date(date),
            type: "menage",
            bookingCode: b.bookingCode,
            ecoAuto: true,
            status: "planned",
            notes: `Ménage planifié selon préférence client (1/${b.menageFreq} j.) — ${b.guestName || ""}`.trim(),
          },
        })
      )
    );

    if (room) {
      await prisma.roomHousekeepingStatus.upsert({
        where: { roomId: room.id },
        update: {
          currentGuest: b.guestName || null,
          bookingCode: b.bookingCode,
          ecoPrefs: {
            menageFreq: b.menageFreq,
            servFreq: b.servFreq,
            menageLabel,
            eauEconomisee: b.eauEconomisee || 0,
            co2Evite: b.co2Evite || 0,
            checkIn: b.checkIn,
            checkOut: b.checkOut,
            plannedCleanDates: cleanDates,
            savedAt: new Date().toISOString(),
          },
        },
        create: {
          roomId: room.id,
          status: "occupee",
          currentGuest: b.guestName || null,
          bookingCode: b.bookingCode,
          ecoPrefs: {
            menageFreq: b.menageFreq,
            servFreq: b.servFreq,
            menageLabel,
            eauEconomisee: b.eauEconomisee || 0,
            co2Evite: b.co2Evite || 0,
            checkIn: b.checkIn,
            checkOut: b.checkOut,
            plannedCleanDates: cleanDates,
            savedAt: new Date().toISOString(),
          },
        },
      });
    }

    res.status(201).json({ createdTasks: created.length, plannedCleanDates: cleanDates });
  })
);

// ═══════════════════════════════════════════════ PLANNING (admin, CRUD générique)

/** GET /wa/housekeepingTask/list?from=YYYY-MM-DD&to=YYYY-MM-DD — grille planning. */
housekeepingTaskRouter.get(
  "/housekeepingTask/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const tasks = await prisma.housekeepingTask.findMany({
      where: {
        entityId: entity.id,
        ...(from || to
          ? {
              taskDate: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { taskDate: "asc" },
    });
    res.json(tasks.map(shapeTask));
  })
);

interface TaskBody {
  roomCode: string;
  date: string;
  type?: string;
  subtype?: string;
  bookingCode?: string;
  status?: string;
  priority?: string;
  durationMinutes?: number;
  assignedStaffId?: string;
  notes?: string;
}

/** POST /wa/housekeepingTask/create — création manuelle depuis le planning admin. */
housekeepingTaskRouter.post(
  "/housekeepingTask/create",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as TaskBody;
    if (!b.roomCode || !b.date) throw new HttpError(400, "roomCode et date requis");

    const task = await prisma.housekeepingTask.create({
      data: {
        entityId: entity.id,
        roomCode: b.roomCode,
        taskDate: new Date(b.date),
        type: b.type || "menage",
        subtype: b.subtype || null,
        bookingCode: b.bookingCode || null,
        status: b.status || "planned",
        priority: b.priority || "normal",
        durationMinutes: b.durationMinutes,
        assignedStaffId: b.assignedStaffId || null,
        notes: b.notes || null,
      },
    });
    res.status(201).json(shapeTask(task));
  })
);

/** POST /wa/housekeepingTask/update — body: { id, ...champs } */
housekeepingTaskRouter.post(
  "/housekeepingTask/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const { id, ...b } = req.body as TaskBody & { id: string };
    if (!id) throw new HttpError(400, "id requis");

    const task = await prisma.housekeepingTask.findFirst({ where: { id, entityId: entity.id } });
    if (!task) throw new HttpError(404, "Tâche introuvable");

    const updated = await prisma.housekeepingTask.update({
      where: { id },
      data: {
        roomCode: b.roomCode,
        taskDate: b.date ? new Date(b.date) : undefined,
        type: b.type,
        subtype: b.subtype,
        bookingCode: b.bookingCode,
        status: b.status,
        priority: b.priority,
        durationMinutes: b.durationMinutes,
        assignedStaffId: b.assignedStaffId,
        notes: b.notes,
      },
    });
    res.json(shapeTask(updated));
  })
);

/** POST /wa/housekeepingTask/delete — body: { id } */
housekeepingTaskRouter.post(
  "/housekeepingTask/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const id = (req.body.id as string) || "";
    const task = await prisma.housekeepingTask.findFirst({ where: { id, entityId: entity.id } });
    if (!task) throw new HttpError(404, "Tâche introuvable");
    await prisma.housekeepingTask.delete({ where: { id } });
    res.json({ ok: true });
  })
);
