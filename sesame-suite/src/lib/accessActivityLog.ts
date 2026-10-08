import { Request } from "express";
import { prisma } from "../db";

export interface AccessActivityLogParams {
  entityId: string;
  method: "booking" | "direct";
  bookingCode?: string | null;
  guestName?: string | null;
  roomCode?: string | null;
  success: boolean;
  simulated?: boolean;
  errorMessage?: string | null;
}

/**
 * Enregistre une tentative d'ouverture d'accès (panneau "Gestion des
 * Accès", § demande client) — req.admin (renseigné globalement par
 * middleware/attachAdmin dès qu'un Bearer admin valide est présent, même
 * sur ces routes publiques côté parcours client) distingue une ouverture
 * déclenchée par le personnel (admin.html/reservations.html) d'une
 * ouverture déclenchée par le client lui-même (checkin.html, sans token).
 * N'échoue jamais l'ouverture réelle pour un problème de journalisation :
 * seule une erreur est tracée en console.
 */
export async function logAccessActivity(req: Request, params: AccessActivityLogParams): Promise<void> {
  try {
    await prisma.accessActivityLog.create({
      data: {
        entityId: params.entityId,
        method: params.method,
        bookingCode: params.bookingCode || null,
        guestName: params.guestName || null,
        roomCode: params.roomCode || null,
        actorType: req.admin ? "staff" : "guest",
        actorLabel: req.admin ? req.admin.email : null,
        success: params.success,
        simulated: !!params.simulated,
        errorMessage: params.errorMessage || null,
      },
    });
  } catch (e) {
    console.error("[accessActivityLog] échec d'écriture du journal", e);
  }
}
