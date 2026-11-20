import { Request } from "express";
import { prisma } from "../db";

export interface BookingActivityLogParams {
  entityId: string;
  bookingId: string;
  type: "room_change" | "nfc_encode";
  detail: string;
}

/**
 * Enregistre un événement de gestion sur une réservation (20/11/2026,
 * "traçabilité des activités ... de changements de chambres d'encodage") —
 * même convention que lib/accessActivityLog.ts : req.admin (attachAdmin)
 * identifie l'agent, jamais bloquant pour l'action elle-même.
 */
export async function logBookingActivity(req: Request, params: BookingActivityLogParams): Promise<void> {
  try {
    await prisma.bookingActivityLog.create({
      data: {
        entityId: params.entityId,
        bookingId: params.bookingId,
        type: params.type,
        detail: params.detail,
        actorLabel: req.admin ? req.admin.email : null,
      },
    });
  } catch (e) {
    console.error("[bookingActivityLog] échec d'écriture du journal", e);
  }
}
