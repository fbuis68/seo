import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

export const kycRecordRouter = Router();

/**
 * POST /wa/kycRecord/create — persiste le résultat de l'étape 4 (optionnelle)
 * du check-in éco : vérification d'identité (scan pièce + selfie), simulée
 * côté client (KYC.idVerified/selfieVerified/matchScore/skipped dans
 * checkin.html) — jusqu'ici jamais envoyée au serveur malgré le modèle
 * KycRecord déjà présent dans le schéma. Sert notamment l'étape "Pièce
 * d'identité" de la frise du parcours client (panneau Réservations).
 */
kycRecordRouter.post(
  "/kycRecord/create",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as {
      bookingCode: string;
      docType?: string;
      fields?: Record<string, unknown>;
      idVerified?: boolean;
      selfieVerified?: boolean;
      matchScore?: number;
      skipped?: boolean;
    };
    if (!b.bookingCode) throw new HttpError(400, "bookingCode requis");
    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code: b.bookingCode } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const record = await prisma.kycRecord.create({
      data: {
        bookingId: booking.id,
        docType: b.docType || null,
        fields: (b.fields as never) ?? undefined,
        idVerified: !!b.idVerified,
        selfieVerified: !!b.selfieVerified,
        matchScore: b.matchScore || 0,
        skipped: !!b.skipped,
      },
    });
    res.status(201).json({ id: record.id });
  })
);

/**
 * GET /wa/kycRecord/list — pour chaque réservation, l'état de vérification
 * d'identité (panneau Réservations, frise du parcours client). Pas de
 * filtre serveur : peu de volume par établissement, filtré côté client par
 * bookingCode comme taxeSejourRecord/roomservice.
 */
kycRecordRouter.get(
  "/kycRecord/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const records = await prisma.kycRecord.findMany({
      where: { booking: { entityId: entity.id } },
      include: { booking: { select: { code: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      records.map((r) => ({
        id: r.id,
        bookingCode: r.booking.code,
        docType: r.docType || "",
        idVerified: r.idVerified,
        selfieVerified: r.selfieVerified,
        matchScore: r.matchScore,
        skipped: r.skipped,
        createdAt: r.createdAt.toISOString(),
      }))
    );
  })
);
