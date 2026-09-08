import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

export const taxeSejourRecordRouter = Router();

/**
 * POST /wa/taxeSejourRecord/create
 * Remplace l'écriture localStorage('SESAME_TAXE_RECORDS') de pushTaxeRecord()
 * — export CSV mairie côté back-office (phase admin, ultérieure).
 */
taxeSejourRecordRouter.post(
  "/taxeSejourRecord/create",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as {
      bookingCode: string;
      facilityCode?: string;
      checkinDate: string;
      checkoutDate?: string;
      nights: number;
      occupantsTotal: number;
      occupantsAdultes: number;
      occupantsAdos: number;
      occupantsEnfants: number;
      occupantsBebes: number;
      tarifPerNightPerPerson: number;
      montantBrut: number;
      montantDeduction: number;
      montantNet: number;
      devise?: string;
    };

    const booking = await prisma.booking.findUnique({
      where: { entityId_code: { entityId: entity.id, code: b.bookingCode } },
    });

    const record = await prisma.taxeSejourRecord.create({
      data: {
        entityId: entity.id,
        bookingId: booking?.id,
        bookingCode: b.bookingCode,
        facilityCode: b.facilityCode || null,
        checkinDate: new Date(b.checkinDate),
        checkoutDate: b.checkoutDate ? new Date(b.checkoutDate) : null,
        nights: b.nights || 0,
        occupantsTotal: b.occupantsTotal || 0,
        occupantsAdultes: b.occupantsAdultes || 0,
        occupantsAdos: b.occupantsAdos || 0,
        occupantsEnfants: b.occupantsEnfants || 0,
        occupantsBebes: b.occupantsBebes || 0,
        tarifPerNightPerPerson: b.tarifPerNightPerPerson || 0,
        montantBrut: b.montantBrut || 0,
        montantDeduction: b.montantDeduction || 0,
        montantNet: b.montantNet || 0,
        devise: b.devise || "EUR",
      },
    });

    res.status(201).json({ id: record.id });
  })
);

/**
 * GET /wa/taxeSejourRecord/list — export CSV mairie (back-office, panneau
 * "Barèmes taxe"). TaxeSejourRecordDao.findByPeriod() décrit dans la doc.
 */
taxeSejourRecordRouter.get(
  "/taxeSejourRecord/list",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const cfg = await prisma.entityModuleConfig.findUnique({ where: { entityId: entity.id } });
    const records = await prisma.taxeSejourRecord.findMany({
      where: { entityId: entity.id },
      orderBy: { checkinDate: "asc" },
    });
    res.json(
      records.map((r) => ({
        id: r.id,
        hotelName: cfg?.hotelName || "",
        entityId: entity.code,
        stars: cfg?.stars || 0,
        facilityCode: r.facilityCode || "",
        bookingCode: r.bookingCode,
        checkinDate: r.checkinDate.toISOString().slice(0, 10),
        checkoutDate: r.checkoutDate ? r.checkoutDate.toISOString().slice(0, 10) : "",
        nights: r.nights,
        occupantsTotal: r.occupantsTotal,
        occupantsAdultes: r.occupantsAdultes,
        occupantsAdos: r.occupantsAdos,
        occupantsEnfants: r.occupantsEnfants,
        occupantsBebes: r.occupantsBebes,
        tarifPerNightPerPerson: r.tarifPerNightPerPerson,
        montantBrut: r.montantBrut,
        montantDeduction: r.montantDeduction,
        montantNet: r.montantNet,
        devise: r.devise,
        paid: r.paid,
        paidAt: r.paidAt ? r.paidAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      }))
    );
  })
);

/**
 * POST /wa/taxeSejourRecord/markPaid — body: { id } — marque un
 * enregistrement de taxe de séjour comme réglé (étape "Taxe payée" de la
 * frise du parcours client, panneau Réservations). Le calcul du montant dû
 * (création du record) et son règlement sont deux moments distincts — pas
 * de paiement en ligne dans cette app, réglé en direct à la réception,
 * simplement coché ici une fois fait.
 */
taxeSejourRecordRouter.post(
  "/taxeSejourRecord/markPaid",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const id = (req.body.id as string) || "";
    if (!id) throw new HttpError(400, "id requis");
    const record = await prisma.taxeSejourRecord.findUnique({ where: { id } });
    if (!record || record.entityId !== entity.id) throw new HttpError(404, "Enregistrement introuvable");
    const updated = await prisma.taxeSejourRecord.update({ where: { id }, data: { paid: true, paidAt: new Date() } });
    res.json({ id: updated.id, paid: updated.paid, paidAt: updated.paidAt!.toISOString() });
  })
);

/** POST /wa/taxeSejourRecord/clear — vide l'historique (back-office). */
taxeSejourRecordRouter.post(
  "/taxeSejourRecord/clear",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    await prisma.taxeSejourRecord.deleteMany({ where: { entityId: entity.id } });
    res.json({ ok: true });
  })
);
