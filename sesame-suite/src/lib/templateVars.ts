import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
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
 * Code d'autologin de l'espace client (checkin.html "Mon espace client") —
 * court code aléatoire stocké en base (AutologinCode) plutôt qu'un JWT
 * auto-porteur embarqué dans l'URL : même lien final mais ~8 caractères au
 * lieu de ~250 (13/10/2026, demande client — URL "extrêmement longue").
 * Vérifié par POST /api/auth/autologin, qui échange le code contre un vrai
 * token de session (jamais exposé dans une URL).
 *
 * Expire au moins 2 jours à partir de MAINTENANT (pas seulement 2 jours
 * après le départ) : l'ancien plancher était 1h, ce qui rendait le lien
 * quasiment inutilisable dès qu'il était généré pour une réservation déjà
 * terminée (résa de démo, test, renvoi d'un lien pour un client déjà
 * parti) — le lien semblait "ne plus marcher" dès qu'on le testait plus
 * d'une heure après l'avoir généré.
 */
async function autologinToken(b: { id: string; personEmail?: string | null; endDate: Date }): Promise<string> {
  const floorMs = 2 * 86400000;
  const expiresInMs = Math.max(floorMs, b.endDate.getTime() + 2 * 86400000 - Date.now());
  const code = randomBytes(6).toString("base64url");
  await prisma.autologinCode.create({
    data: { code, bookingId: b.id, email: b.personEmail || null, expiresAt: new Date(Date.now() + expiresInMs) },
  });
  return code;
}

/**
 * Exporté séparément de bookingTemplateVars ci-dessous pour être réutilisé
 * par GET /wa/booking/autologinQr (panneau staff "Réservations", QR à
 * imprimer/afficher — cf. routes/booking.ts), qui a besoin du lien seul
 * sans construire tout l'objet de variables d'email.
 */
export async function buildAutologinUrl(b: { id: string; personEmail?: string | null; endDate: Date }, entityCode: string): Promise<string> {
  if (!entityCode) return "";
  const code = await autologinToken(b);
  return `${config.guestBaseUrl}/checkin.html?entityCode=${encodeURIComponent(entityCode)}&autologinToken=${code}`;
}

/**
 * Même lien que buildAutologinUrl, mais qui amène directement sur l'écran
 * "Séjour" (le processus de check-in — étapes room/taxe/kyc/eco/boutique/
 * rewards) plutôt que sur "Mon espace client" (verrouillé tant que le
 * check-in n'est pas terminé, cf. renderEspace/S.checkinDone dans
 * checkin.html) — utile pour une invitation à check-in avant l'arrivée,
 * quand "Mon espace" n'a justement pas encore de sens pour ce client.
 * ?dest=checkin est lu directement depuis l'URL côté client (checkin.html
 * AUTOLOGIN_DEST), pas depuis le code lui-même.
 */
export async function buildAutologinCheckinUrl(b: { id: string; personEmail?: string | null; endDate: Date }, entityCode: string): Promise<string> {
  const url = await buildAutologinUrl(b, entityCode);
  return url ? `${url}&dest=checkin` : "";
}

/** prenom/nom/code déjà utilisés partout — hotel/adresseHotel/telephoneHotel/chambre/dateArrivee/dateDepart/nuits/lienAutologin/lienAutologinCheckin sont les nouvelles variables. */
export async function bookingTemplateVars(b: BookingLike, hotel: HotelInfo): Promise<Record<string, string>> {
  const nights = Math.max(1, Math.round((b.endDate.getTime() - b.startDate.getTime()) / 86400000));
  const [lienAutologin, lienAutologinCheckin] = await Promise.all([
    buildAutologinUrl(b, hotel.entityCode),
    buildAutologinCheckinUrl(b, hotel.entityCode),
  ]);
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
    lienAutologin,
    lienAutologinCheckin,
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
