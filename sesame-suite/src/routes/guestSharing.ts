import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

export const guestSharingRouter = Router();

/**
 * POST /wa/guestSharing/optIn — module "Partage entre clients" du parcours
 * d'enregistrement : le client choisit de rendre visible son nom/contact/
 * photo/centres d'intérêt aux autres clients présents dans l'établissement
 * pendant la durée de validité de sa réservation (cf. GuestSharingProfile,
 * prisma/schema.prisma). Même convention d'accès que kycRecord/create : pas
 * d'auth admin, bookingCode fait office de secret porteur.
 */
guestSharingRouter.post(
  "/guestSharing/optIn",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const b = req.body as {
      bookingCode: string;
      optIn: boolean;
      photo?: string | null;
      interests?: string[];
    };
    if (!b.bookingCode) throw new HttpError(400, "bookingCode requis");
    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code: b.bookingCode } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const optIn = !!b.optIn;
    const profile = await prisma.guestSharingProfile.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        optIn,
        optInAt: optIn ? new Date() : null,
        photo: b.photo ?? null,
        interests: (b.interests as never) ?? [],
      },
      update: {
        optIn,
        optInAt: optIn ? new Date() : null,
        ...(b.photo !== undefined ? { photo: b.photo } : {}),
        ...(b.interests !== undefined ? { interests: b.interests as never } : {}),
      },
    });
    res.json({ id: profile.id, optIn: profile.optIn });
  })
);

/**
 * GET /wa/guestSharing/nearby?bookingCode=... — liste des autres clients
 * opt-in présents dans l'établissement au même moment (chevauchement de
 * séjour, cf. Booking.startDate/endDate), pour l'écran découverte de
 * checkin.html. Portée large assumée (tout l'établissement, pas seulement
 * la même réservation — demande explicite). Réciprocité : le client doit
 * lui-même être opt-in pour voir les autres.
 */
guestSharingRouter.get(
  "/guestSharing/nearby",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const bookingCode = req.query.bookingCode as string;
    if (!bookingCode) throw new HttpError(400, "bookingCode requis");
    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code: bookingCode } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const myProfile = await prisma.guestSharingProfile.findUnique({ where: { bookingId: booking.id } });
    if (!myProfile || !myProfile.optIn) {
      res.json({ optedIn: false, guests: [] });
      return;
    }

    const others = await prisma.booking.findMany({
      where: {
        entityId: entity.id,
        id: { not: booking.id },
        startDate: { lte: booking.endDate },
        endDate: { gte: booking.startDate },
        guestSharingProfile: { optIn: true },
      },
      include: { guestSharingProfile: true },
    });

    const guests = others
      .filter((o) => o.personEmail.toLowerCase() !== booking.personEmail.toLowerCase())
      .map((o) => ({
        firstname: o.personFirstname,
        lastname: o.personLastname,
        email: o.personEmail,
        phone: o.personPhone || "",
        photo: o.guestSharingProfile?.photo || "",
        interests: (o.guestSharingProfile?.interests as string[]) || [],
        facilityCode: o.facilityCode || "",
      }));

    res.json({ optedIn: true, guests });
  })
);

/**
 * GET /wa/guestSharing/mine?bookingCode=... — profil de partage (opt-in,
 * photo, centres d'intérêt) d'UNE réservation, pour le client lui-même
 * (checkin.html : hydrate SHR à la connexion/sélection de réservation, sinon
 * un client déjà opt-in lors d'une session précédente repart de zéro — SHR
 * n'est sinon jamais rechargé depuis le serveur). Même convention d'accès
 * que /guestSharing/optIn : pas d'auth admin, bookingCode fait office de
 * secret porteur.
 */
guestSharingRouter.get(
  "/guestSharing/mine",
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const bookingCode = (req.query.bookingCode as string) || "";
    if (!bookingCode) throw new HttpError(400, "bookingCode requis");
    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code: bookingCode } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const profile = await prisma.guestSharingProfile.findUnique({ where: { bookingId: booking.id } });
    res.json({
      optIn: !!profile?.optIn,
      photo: profile?.photo || "",
      interests: (profile?.interests as string[]) || [],
    });
  })
);

/**
 * GET /wa/guestSharing/forBooking?code=... — profil de partage (opt-in,
 * centres d'intérêt, photo) d'UNE réservation, pour la fiche client côté
 * admin (panneau Réservations) : les centres d'intérêt saisis pendant le
 * check-in (étape "Partage entre clients") deviennent ainsi visibles côté
 * back-office, pas seulement affichés au client lui-même.
 */
guestSharingRouter.get(
  "/guestSharing/forBooking",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const code = (req.query.code as string) || "";
    if (!code) throw new HttpError(400, "code requis");
    const booking = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code } } });
    if (!booking) throw new HttpError(404, "Réservation introuvable");

    const profile = await prisma.guestSharingProfile.findUnique({ where: { bookingId: booking.id } });
    res.json({
      optIn: !!profile?.optIn,
      optInAt: profile?.optInAt || null,
      interests: (profile?.interests as string[]) || [],
      photo: profile?.photo || "",
    });
  })
);
