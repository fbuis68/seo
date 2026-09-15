import jwt from "jsonwebtoken";
import { prisma } from "../db";
import { config } from "../config";

/**
 * Variables {{var}} communes aux modèles de message de portée hôtel — un
 * seul endroit pour construire les variables dérivées d'une Booking/Order/
 * Entity plutôt que de dupliquer ce mapping à chaque site d'appel de
 * fireTrigger() (booking.ts, bookingEngine.ts, roomservice.ts,
 * automation.ts, housekeepingTask.ts).
 */

export function formatDateFr(d: Date): string {
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

export interface HotelInfo {
  name: string;
  addr?: string | null;
  phone?: string | null;
  // Code de l'établissement (Entity.code) — nécessaire pour construire
  // {{lienAutologin}} (cf. bookingTemplateVars ci-dessous), qui pointe vers
  // l'app client sans session admin en cours pour en déduire l'hôtel.
  entityCode: string;
}

/**
 * Coordonnées de l'établissement (nom + adresse + téléphone d'accueil) pour
 * un entityId donné — une seule requête combinée (Entity.name/code +
 * EntityModuleConfig.hotelAddr/hotelPhone), appelée une fois par déclenchement
 * (ou une fois par balayage pour les règles à date pivot qui traitent
 * plusieurs réservations d'un même établissement, cf. sweepDateRule).
 */
export async function hotelContactInfo(entityId: string): Promise<HotelInfo> {
  const [entity, cfg] = await Promise.all([
    prisma.entity.findUnique({ where: { id: entityId }, select: { name: true, code: true } }),
    prisma.entityModuleConfig.findUnique({ where: { entityId }, select: { hotelAddr: true, hotelPhone: true } }),
  ]);
  return { name: entity?.name || "", addr: cfg?.hotelAddr || "", phone: cfg?.hotelPhone || "", entityCode: entity?.code || "" };
}

function hotelVars(hotel: HotelInfo): Record<string, string> {
  return {
    hotel: hotel.name,
    adresseHotel: hotel.addr || "",
    telephoneHotel: hotel.phone || "",
  };
}

interface BookingLike {
  id: string;
  entityId: string;
  personFirstname: string;
  personLastname: string;
  personEmail?: string | null;
  code: string;
  startDate: Date;
  endDate: Date;
  facilityName?: string | null;
  facilityCode?: string | null;
  selectedRoomCode?: string | null;
}

/**
 * Jeton d'autologin de l'espace client (checkin.html "Mon espace client") —
 * même mécanisme et même secret que POST /api/auth/guest-login (cf.
 * routes/auth.ts), mais porté par un lien plutôt que saisi à la main
 * (email/nom + code de réservation). Vérifié par POST /api/auth/autologin.
 * Expire 2 jours après le départ plutôt qu'une durée fixe courte : un lien
 * envoyé par email doit rester utilisable pendant tout le séjour, pas
 * seulement dans les heures suivant l'envoi (cf. discussion du 15/09/2026).
 */
function autologinToken(b: { id: string; entityId: string; personEmail?: string | null; endDate: Date }): string {
  const expiresInSeconds = Math.max(3600, Math.round((b.endDate.getTime() + 2 * 86400000 - Date.now()) / 1000));
  return jwt.sign({ entityId: b.entityId, bookingId: b.id, email: b.personEmail || undefined }, config.jwtSecret, {
    expiresIn: expiresInSeconds,
  });
}

/**
 * Exporté séparément de bookingTemplateVars ci-dessous pour être réutilisé
 * par GET /wa/booking/autologinQr (panneau staff "Réservations", QR à
 * imprimer/afficher — cf. routes/booking.ts), qui a besoin du lien seul
 * sans construire tout l'objet de variables d'email.
 */
export function buildAutologinUrl(b: { id: string; entityId: string; personEmail?: string | null; endDate: Date }, entityCode: string): string {
  if (!entityCode) return "";
  return `${config.guestBaseUrl}/checkin.html?entityCode=${encodeURIComponent(entityCode)}&autologinToken=${autologinToken(b)}`;
}

/** prenom/nom/code déjà utilisés partout — hotel/adresseHotel/telephoneHotel/chambre/dateArrivee/dateDepart/nuits/lienAutologin sont les nouvelles variables. */
export function bookingTemplateVars(b: BookingLike, hotel: HotelInfo): Record<string, string> {
  const nights = Math.max(1, Math.round((b.endDate.getTime() - b.startDate.getTime()) / 86400000));
  return {
    prenom: b.personFirstname,
    nom: b.personLastname,
    code: b.code,
    ...hotelVars(hotel),
    // selectedRoomCode (choisie à l'étape 2 du check-in) prime sur
    // facilityName/facilityCode (dénormalisés à la création de la
    // réservation, potentiellement différents) — cf. commentaire du champ
    // dans schema.prisma.
    chambre: b.selectedRoomCode || b.facilityName || b.facilityCode || "",
    dateArrivee: formatDateFr(b.startDate),
    dateDepart: formatDateFr(b.endDate),
    nuits: String(nights),
    lienAutologin: buildAutologinUrl(b, hotel.entityCode),
  };
}

interface OrderItemLike {
  label?: string;
  qty?: number;
}

interface OrderLike {
  id: string;
  bookingCode?: string | null;
  roomCode?: string | null;
  roomName?: string | null;
  total: number;
}

/** total déjà utilisé partout — hotel/adresseHotel/telephoneHotel/chambre/articles/numeroCommande/code sont les nouvelles variables. */
export function orderTemplateVars(o: OrderLike, items: OrderItemLike[], hotel: HotelInfo): Record<string, string> {
  const articles = items
    .map((it) => (it.qty && it.qty > 1 ? `${it.qty}x ${it.label || ""}` : it.label || ""))
    .filter(Boolean)
    .join(", ");
  return {
    ...hotelVars(hotel),
    // Numéro de réservation (booking) associé à la commande, quand elle en a
    // une — vide pour une commande boutique autonome sans réservation liée.
    code: o.bookingCode || "",
    // Order.id est un cuid peu lisible pour un client — préfixé par le code
    // de réservation quand disponible (plus parlant : "RES1234-A1B2").
    numeroCommande: o.bookingCode ? `${o.bookingCode}-${o.id.slice(-4).toUpperCase()}` : o.id.slice(-6).toUpperCase(),
    chambre: o.roomName || o.roomCode || "",
    articles,
    total: String(o.total),
  };
}
