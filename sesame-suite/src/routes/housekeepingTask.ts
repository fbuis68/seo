import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";

export const housekeepingTaskRouter = Router();

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
