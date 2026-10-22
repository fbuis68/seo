import { Router } from "express";
import { prisma } from "../db";
import { resolveEntity } from "../lib/entity";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";

export const crmRouter = Router();

interface LoyaltyTiers {
  gold: number;
  premium: number;
}

function computeTier(points: number, tiers: LoyaltyTiers | null) {
  const gold = tiers?.gold ?? 500;
  const premium = tiers?.premium ?? 1500;
  if (points >= premium) return "Premium";
  if (points >= gold) return "Gold";
  return "Standard";
}

/**
 * GET /wa/crm/clients — fiches clients agrégées (panneau "Base clients") :
 * réservations (Booking), fidélité (LoyaltyAccount), préférences (ClientPrefs).
 *
 * Si l'établissement appartient à un groupe à fidélité centralisée, les
 * réservations et préférences sont agrégées sur TOUS les hôtels du groupe
 * (base clients partagée, cf. panneau "Groupes") — jamais au-delà des
 * frontières du groupe.
 */
crmRouter.get(
  "/crm/clients",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const group = entity.groupId ? await prisma.group.findUnique({ where: { id: entity.groupId } }) : null;
    const groupAggregated = group?.loyaltyMode === "centralized";

    const entityIds = groupAggregated
      ? (await prisma.entity.findMany({ where: { groupId: group!.id }, select: { id: true } })).map((e) => e.id)
      : [entity.id];
    const hotelsById = groupAggregated
      ? new Map((await prisma.entity.findMany({ where: { id: { in: entityIds } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]))
      : new Map([[entity.id, entity.name]]);

    const [bookings, loyaltyAccounts, prefs, cfg, sharingProfiles] = await Promise.all([
      prisma.booking.findMany({ where: { entityId: { in: entityIds } }, orderBy: { startDate: "desc" } }),
      groupAggregated
        ? prisma.loyaltyAccount.findMany({ where: { groupId: group!.id } })
        : prisma.loyaltyAccount.findMany({ where: { entityId: entity.id } }),
      prisma.clientPrefs.findMany({ where: { entityId: { in: entityIds } } }),
      prisma.entityModuleConfig.findUnique({ where: { entityId: entity.id } }),
      prisma.guestSharingProfile.findMany({
        where: { optIn: true, booking: { entityId: { in: entityIds } } },
        include: { booking: { select: { personEmail: true } } },
      }),
    ]);

    const pointsByEmail = new Map(loyaltyAccounts.map((a) => [a.email, a.totalPoints]));
    const prefsByEmail = new Map(prefs.map((p) => [p.email, p]));
    const tiers = (cfg?.loyaltyTiers as unknown as LoyaltyTiers | null) || null;

    // Centres d'intérêt + photo déclarés lors du check-in (module "Partage
    // entre clients") — union des centres d'intérêt sur TOUTES les
    // réservations opt-in de ce client (même hors groupe : GuestSharingProfile
    // est scopé sur les mêmes entityIds que le reste de la fiche), photo de
    // l'opt-in le plus récent, pour la fiche "Base clients".
    const interestsByEmail = new Map<string, Set<string>>();
    const photoByEmail = new Map<string, { photo: string; optInAt: Date | null }>();
    for (const p of sharingProfiles) {
      const key = p.booking.personEmail.toLowerCase();
      const set = interestsByEmail.get(key) || new Set<string>();
      for (const v of (p.interests as string[]) || []) set.add(v);
      interestsByEmail.set(key, set);
      if (p.photo) {
        const existingPhoto = photoByEmail.get(key);
        if (!existingPhoto || (p.optInAt && (!existingPhoto.optInAt || p.optInAt > existingPhoto.optInAt))) {
          photoByEmail.set(key, { photo: p.photo, optInAt: p.optInAt });
        }
      }
    }

    const byEmail = new Map<
      string,
      { email: string; firstname: string; lastname: string; phone: string; stays: number; lastStay: string; hotels: Set<string> }
    >();
    for (const b of bookings) {
      const key = b.personEmail.toLowerCase();
      const existing = byEmail.get(key);
      const hotelName = hotelsById.get(b.entityId) || "";
      if (existing) {
        existing.stays += 1;
        if (hotelName) existing.hotels.add(hotelName);
        if (b.startDate.toISOString() > existing.lastStay) existing.lastStay = b.startDate.toISOString();
      } else {
        byEmail.set(key, {
          email: b.personEmail,
          firstname: b.personFirstname,
          lastname: b.personLastname,
          phone: b.personPhone || "",
          stays: 1,
          lastStay: b.startDate.toISOString(),
          hotels: new Set(hotelName ? [hotelName] : []),
        });
      }
    }

    const clients = Array.from(byEmail.values()).map((c) => {
      const points = pointsByEmail.get(c.email.toLowerCase()) || 0;
      const pref = prefsByEmail.get(c.email.toLowerCase());
      return {
        email: c.email,
        firstname: c.firstname,
        lastname: c.lastname,
        phone: c.phone,
        stays: c.stays,
        lastStay: c.lastStay.slice(0, 10),
        points,
        tier: computeTier(points, tiers),
        tags: (pref?.tags as string[]) || [],
        interests: Array.from(interestsByEmail.get(c.email.toLowerCase()) || []),
        sharingPhoto: photoByEmail.get(c.email.toLowerCase())?.photo || "",
        hotels: groupAggregated ? Array.from(c.hotels) : undefined,
      };
    });

    clients.sort((a, b) => b.points - a.points);
    res.json({
      clients,
      groupAggregated,
      groupName: groupAggregated ? group!.name : null,
    });
  })
);

/**
 * GET /wa/crm/clientDetail?email=... — dossier détaillé d'un client de la
 * fiche "Base clients" : préférences éco (ClientPrefs), et pour chacune de
 * ses réservations, commandes (Order) et pièce d'identité (KycRecord).
 * Jusqu'ici la fiche ne montrait que points/statut/centres d'intérêt —
 * aucun moyen de voir ces éléments sans rouvrir chaque fiche réservation
 * une par une (panneau Réservations). Même périmètre groupe que
 * GET /wa/crm/clients ci-dessus.
 */
crmRouter.get(
  "/crm/clientDetail",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const email = ((req.query.email as string) || "").trim().toLowerCase();
    if (!email) {
      res.json({ prefs: null, bookings: [] });
      return;
    }
    const group = entity.groupId ? await prisma.group.findUnique({ where: { id: entity.groupId } }) : null;
    const groupAggregated = group?.loyaltyMode === "centralized";
    const entityIds = groupAggregated
      ? (await prisma.entity.findMany({ where: { groupId: group!.id }, select: { id: true } })).map((e) => e.id)
      : [entity.id];

    const bookings = await prisma.booking.findMany({
      where: { entityId: { in: entityIds }, personEmail: { equals: email, mode: "insensitive" } },
      orderBy: { startDate: "desc" },
    });
    const bookingIds = bookings.map((b) => b.id);
    const bookingCodes = bookings.map((b) => b.code);

    const [prefs, orders, kycRecords] = await Promise.all([
      prisma.clientPrefs.findFirst({ where: { entityId: { in: entityIds }, email: { equals: email, mode: "insensitive" } } }),
      prisma.order.findMany({ where: { entityId: { in: entityIds }, bookingCode: { in: bookingCodes } }, orderBy: { createdAt: "desc" } }),
      prisma.kycRecord.findMany({ where: { bookingId: { in: bookingIds } }, orderBy: { createdAt: "desc" } }),
    ]);

    // Adresse/CGU — pris sur la réservation la plus récente qui les renseigne
    // (bookings déjà triés startDate desc) : ces champs sont saisis par le
    // client à l'étape "Mes coordonnées" du check-in (cf. checkin.html
    // contactStepNext/POST /wa/booking/updateContact), pas stockés une
    // seule fois par client — une ancienne réservation sans adresse ne doit
    // pas masquer celle saisie sur une réservation plus récente.
    const bookingWithAddress = bookings.find((b) => b.personAddress || b.personZip || b.personCity);
    const bookingWithCgu = bookings.find((b) => b.cguAcceptedAt);

    const ordersByCode = new Map<string, typeof orders>();
    for (const o of orders) {
      if (!o.bookingCode) continue;
      const arr = ordersByCode.get(o.bookingCode) || [];
      arr.push(o);
      ordersByCode.set(o.bookingCode, arr);
    }
    const kycByBookingId = new Map(kycRecords.map((k) => [k.bookingId, k]));

    res.json({
      prefs: prefs
        ? {
            menageFreq: prefs.menageFreq,
            servFreq: prefs.servFreq,
            menageNote: prefs.menageNote,
            newsletterOptIn: prefs.newsletterOptIn,
          }
        : null,
      address: bookingWithAddress
        ? {
            address: bookingWithAddress.personAddress || "",
            zip: bookingWithAddress.personZip || "",
            city: bookingWithAddress.personCity || "",
          }
        : null,
      cguAcceptedAt: bookingWithCgu ? bookingWithCgu.cguAcceptedAt!.toISOString() : null,
      bookings: bookings.map((b) => ({
        code: b.code,
        startDate: b.startDate.toISOString().slice(0, 10),
        endDate: b.endDate.toISOString().slice(0, 10),
        facilityName: b.facilityName || b.selectedRoomCode || b.facilityCode || "",
        orders: (ordersByCode.get(b.code) || []).map((o) => ({
          createdAt: o.createdAt.toISOString(),
          status: o.status,
          total: o.total,
          items: o.items,
        })),
        kyc: (() => {
          const k = kycByBookingId.get(b.id);
          if (!k) return null;
          return {
            docType: k.docType || "",
            idVerified: k.idVerified,
            selfieVerified: k.selfieVerified,
            matchScore: k.matchScore,
            skipped: k.skipped,
            createdAt: k.createdAt.toISOString(),
          };
        })(),
      })),
    });
  })
);

/**
 * POST /wa/crm/clients/merge — fusion de doublons dans la "Base clients"
 * (22/10/2026, demande client). Contrairement au CRM Sesame (CrmProspect,
 * une vraie table), cette fiche est entièrement RECALCULÉE à la volée
 * depuis Booking.personEmail (cf. GET /crm/clients ci-dessus) — il n'y a
 * donc rien à "fusionner" au sens d'une ligne qu'on supprimerait, mais un
 * même client réel peut apparaître deux fois sous deux emails différents
 * (faute de frappe, ancienne adresse...). Fusionner = réécrire
 * personEmail sur toutes les réservations du/des email(s) à abandonner
 * vers l'email à conserver, puis recoller fidélité (somme des points) et
 * préférences (une ligne par établissement) sur ce même email — portée
 * identique à GET /crm/clients (groupe à fidélité centralisée ou
 * établissement seul).
 */
crmRouter.post(
  "/crm/clients/merge",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entity = await resolveEntity(req);
    const group = entity.groupId ? await prisma.group.findUnique({ where: { id: entity.groupId } }) : null;
    const groupAggregated = group?.loyaltyMode === "centralized";
    const entityIds = groupAggregated
      ? (await prisma.entity.findMany({ where: { groupId: group!.id }, select: { id: true } })).map((e) => e.id)
      : [entity.id];

    const keepEmail = ((req.body.keepEmail as string) || "").trim().toLowerCase();
    const mergeEmails = ((req.body.mergeEmails as string[]) || []).map((e) => (e || "").trim().toLowerCase()).filter((e) => e && e !== keepEmail);
    if (!keepEmail) throw new HttpError(400, "Email à conserver requis");
    if (!mergeEmails.length) throw new HttpError(400, "Aucun email à fusionner");

    for (const mergeEmail of mergeEmails) {
      // Réservations — le client conservé hérite de tout l'historique.
      await prisma.booking.updateMany({
        where: { entityId: { in: entityIds }, personEmail: { equals: mergeEmail, mode: "insensitive" } },
        data: { personEmail: keepEmail },
      });

      // Fidélité — un seul compte par portée (entité, ou groupe si
      // centralisée) : somme des points de l'email abandonné dans celui
      // conservé, ou simple renommage si l'email conservé n'avait pas
      // encore de compte sur cette portée.
      const loyaltyWhereKeep = groupAggregated ? { groupId_email: { groupId: group!.id, email: keepEmail } } : { entityId_email: { entityId: entity.id, email: keepEmail } };
      const loyaltyWhereMerge = groupAggregated ? { groupId_email: { groupId: group!.id, email: mergeEmail } } : { entityId_email: { entityId: entity.id, email: mergeEmail } };
      const [keepAcc, mergeAcc] = await Promise.all([
        prisma.loyaltyAccount.findUnique({ where: loyaltyWhereKeep as never }),
        prisma.loyaltyAccount.findUnique({ where: loyaltyWhereMerge as never }),
      ]);
      if (mergeAcc) {
        if (keepAcc) {
          await prisma.$transaction([
            prisma.loyaltyTransaction.updateMany({ where: { accountId: mergeAcc.id }, data: { accountId: keepAcc.id } }),
            prisma.loyaltyAccount.update({ where: { id: keepAcc.id }, data: { totalPoints: keepAcc.totalPoints + mergeAcc.totalPoints } }),
            prisma.loyaltyAccount.delete({ where: { id: mergeAcc.id } }),
          ]);
        } else {
          await prisma.loyaltyAccount.update({ where: { id: mergeAcc.id }, data: { email: keepEmail } });
        }
      }

      // Préférences — une ligne par établissement (pas de notion de groupe
      // ici) : celles de l'email conservé l'emportent si les deux existent.
      for (const eId of entityIds) {
        const [keepPref, mergePref] = await Promise.all([
          prisma.clientPrefs.findFirst({ where: { entityId: eId, email: { equals: keepEmail, mode: "insensitive" } } }),
          prisma.clientPrefs.findFirst({ where: { entityId: eId, email: { equals: mergeEmail, mode: "insensitive" } } }),
        ]);
        if (mergePref) {
          if (keepPref) await prisma.clientPrefs.delete({ where: { id: mergePref.id } });
          else await prisma.clientPrefs.update({ where: { id: mergePref.id }, data: { email: keepEmail } });
        }
      }
    }

    res.json({ ok: true });
  })
);
