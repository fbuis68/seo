/**
 * Backfill ponctuel — Hôtel Churchill (E00000001) : jeu de données de démo
 * (réservations récentes/à venir, commandes boutique, taxe de séjour,
 * tâches ménage éco) pour que les indicateurs du Dashboard admin
 * ("Indicateurs réels" — séjours, CA, taxe collectée, éco-gains) affichent
 * des valeurs réelles au lieu de zéros, quelle que soit la période choisie
 * (7 jours / mois en cours / mois dernier / année). Les photos de chambres
 * existent déjà (cf. migration 20260818180000_churchill_room_media_backfill)
 * — ce script ne s'occupe que des données de séjour.
 *
 * Idempotent : chaque entité est upsertée sur un code fixe ("HCH-KPI-xxxx"),
 * donc relancer ce script ne duplique rien (mais ne "rafraîchit" pas non
 * plus les dates des lignes déjà créées — cohérent avec le style upsert
 * `update: {}` déjà utilisé dans seed.ts pour les données Churchill).
 *
 * Supprime aussi TESTX01/TESTX02, deux chambres de test laissées par erreur
 * dans les données Churchill lors de tests précédents (non référencées par
 * aucune réservation).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ENTITY_CODE = "E00000001";

const ROOM_CODES = ["A11", "A12", "A14", "A23", "A42", "A43", "B13", "B14", "B43", "C16", "C17", "C19"];

const GUESTS: Array<{ first: string; last: string; email: string }> = [
  { first: "Elodie", last: "MARCHAND", email: "elodie.marchand@example.com" },
  { first: "Nicolas", last: "FONTAINE", email: "nicolas.fontaine@example.com" },
  { first: "Aurélie", last: "GAUTHIER", email: "aurelie.gauthier@example.com" },
  { first: "Baptiste", last: "ROUSSEAU", email: "baptiste.rousseau@example.com" },
  { first: "Manon", last: "PERRIN", email: "manon.perrin@example.com" },
  { first: "Hugo", last: "LEFEBVRE", email: "hugo.lefebvre@example.com" },
  { first: "Chloé", last: "GIRARD", email: "chloe.girard@example.com" },
  { first: "Antoine", last: "BONNET", email: "antoine.bonnet@example.com" },
  { first: "Léa", last: "MASSON", email: "lea.masson@example.com" },
  { first: "Maxime", last: "ROBIN", email: "maxime.robin@example.com" },
  { first: "Inès", last: "CARON", email: "ines.caron@example.com" },
  { first: "Simon", last: "MEUNIER", email: "simon.meunier@example.com" },
  { first: "Clara", last: "ADAM", email: "clara.adam@example.com" },
  { first: "Théo", last: "BRUNET", email: "theo.brunet@example.com" },
  { first: "Juliette", last: "COLIN", email: "juliette.colin@example.com" },
  { first: "Romain", last: "VIDAL", email: "romain.vidal@example.com" },
  { first: "Sarah", last: "FOURNIER", email: "sarah.fournier@example.com" },
  { first: "Lucas", last: "PICARD", email: "lucas.picard@example.com" },
  { first: "Camille", last: "ROY", email: "camille.roy2@example.com" },
  { first: "Adrien", last: "MEYER", email: "adrien.meyer@example.com" },
  { first: "Pauline", last: "GILLET", email: "pauline.gillet@example.com" },
  { first: "Yohan", last: "BLANCHARD", email: "yohan.blanchard@example.com" },
  { first: "Margaux", last: "LAMBERT", email: "margaux.lambert@example.com" },
  { first: "Kevin", last: "GAUDIN", email: "kevin.gaudin@example.com" },
];

const BOUTIQUE_ITEMS = [
  { id: "bq_pdej", label: "Plateau petit-déjeuner", price: 18.0 },
  { id: "bq_vin", label: "Verre de vin", price: 8.0 },
  { id: "bq_champ", label: "Coupe de Champagne", price: 14.0 },
  { id: "bq_burger", label: "Burger Churchill", price: 17.0 },
  { id: "bq_club", label: "Club sandwich", price: 14.0 },
  { id: "bq_kit", label: "Kit bien-être", price: 15.0 },
  { id: "bq_patis", label: "Pâtisserie du chef", price: 8.0 },
  { id: "bq_fruits", label: "Coupe de fruits frais", price: 7.0 },
];

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
function nightsBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}
function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

interface PlannedBooking {
  code: string;
  guestIdx: number;
  roomCode: string;
  startOffsetDays: number; // relatif à aujourd'hui
  nights: number;
  status: "confirmed" | "checkedin" | "completed";
  checkinDone: boolean;
}

async function main() {
  const entity = await prisma.entity.findUnique({ where: { code: ENTITY_CODE } });
  if (!entity) throw new Error(`Entité ${ENTITY_CODE} introuvable`);
  console.log(`Backfill démo KPI pour ${ENTITY_CODE} (${entity.name})…`);

  // ── Nettoyage des 2 chambres de test laissées par erreur (non référencées
  // par aucune réservation — vérifié avant ce script) ──
  const testRooms = await prisma.room.findMany({ where: { entityId: entity.id, code: { in: ["TESTX01", "TESTX02"] } } });
  for (const r of testRooms) {
    await prisma.roomHousekeepingStatus.deleteMany({ where: { roomId: r.id } });
    await prisma.room.delete({ where: { id: r.id } });
    console.log(`  Chambre de test supprimée : ${r.code}`);
  }

  const rooms = await prisma.room.findMany({ where: { entityId: entity.id, code: { in: ROOM_CODES } } });
  const roomByCode = new Map(rooms.map((r) => [r.code, r]));

  // ── Plan de réservations : réparties sur les 12 derniers mois (pour le
  // préréglage "Année"), avec une concentration sur les 30 derniers jours
  // (préréglages "7 jours" / "Mois en cours" / "Mois dernier") et quelques
  // arrivées à venir (préréglage personnalisé / vue "Réservations") ──
  const planned: PlannedBooking[] = [];
  let n = 1;
  const nextCode = () => `HCH-KPI-${String(n++).padStart(4, "0")}`;

  // 1 séjour terminé par mois sur les 10 mois précédant le mois en cours
  // (pour peupler "Année" au-delà du mois courant)
  for (let m = 10; m >= 2; m--) {
    planned.push({
      code: nextCode(),
      guestIdx: planned.length,
      roomCode: pick(ROOM_CODES, planned.length),
      startOffsetDays: -m * 30 + (planned.length % 5),
      nights: 2 + (planned.length % 3),
      status: "completed",
      checkinDone: true,
    });
  }

  // Mois dernier : 3 séjours terminés
  for (let i = 0; i < 3; i++) {
    planned.push({
      code: nextCode(),
      guestIdx: planned.length,
      roomCode: pick(ROOM_CODES, planned.length),
      startOffsetDays: -35 + i * 8,
      nights: 2 + (i % 3),
      status: "completed",
      checkinDone: true,
    });
  }

  // Mois en cours (hors 7 derniers jours) : 4 séjours terminés
  for (let i = 0; i < 4; i++) {
    planned.push({
      code: nextCode(),
      guestIdx: planned.length,
      roomCode: pick(ROOM_CODES, planned.length),
      startOffsetDays: -18 + i * 3,
      nights: 2 + (i % 2),
      status: "completed",
      checkinDone: true,
    });
  }

  // 7 derniers jours : 6 séjours (mélange terminé / en cours) — garantit que
  // le préréglage par défaut ("7 jours") a des données réelles
  const last7 = [
    { off: -6, nights: 2, status: "completed" as const, done: true },
    { off: -5, nights: 3, status: "completed" as const, done: true },
    { off: -4, nights: 2, status: "checkedin" as const, done: true },
    { off: -3, nights: 4, status: "checkedin" as const, done: true },
    { off: -2, nights: 2, status: "checkedin" as const, done: true },
    { off: 0, nights: 3, status: "checkedin" as const, done: true },
  ];
  for (const b of last7) {
    planned.push({
      code: nextCode(),
      guestIdx: planned.length,
      roomCode: pick(ROOM_CODES, planned.length),
      startOffsetDays: b.off,
      nights: b.nights,
      status: b.status,
      checkinDone: b.done,
    });
  }

  // À venir (30 prochains jours) : 5 réservations confirmées, pas encore
  // arrivées (checkinDone=false) — alimente la vue "Réservations" et les
  // KPI "à venir" sans fausser les compteurs de CA déjà encaissé.
  for (let i = 0; i < 5; i++) {
    planned.push({
      code: nextCode(),
      guestIdx: planned.length,
      roomCode: pick(ROOM_CODES, planned.length),
      startOffsetDays: 3 + i * 5,
      nights: 2 + (i % 3),
      status: "confirmed",
      checkinDone: false,
    });
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  let createdBookings = 0, createdOrders = 0, createdTaxe = 0, createdTasks = 0;

  for (const p of planned) {
    const room = roomByCode.get(p.roomCode);
    if (!room) continue;
    const start = addDays(today, p.startOffsetDays);
    const end = addDays(start, p.nights);
    const guest = pick(GUESTS, p.guestIdx);

    const existing = await prisma.booking.findUnique({ where: { entityId_code: { entityId: entity.id, code: p.code } } });
    if (existing) continue; // déjà backfillé — on ne retouche pas les dates

    const booking = await prisma.booking.create({
      data: {
        entityId: entity.id,
        code: p.code,
        personEmail: guest.email,
        personFirstname: guest.first,
        personLastname: guest.last,
        personPhone: "+33 6 " + String(10000000 + n).slice(0, 8).replace(/(\d{2})(?=\d)/g, "$1 ").trim(),
        startDate: start,
        endDate: end,
        roomId: room.id,
        facilityCode: room.code,
        facilityName: room.name,
        selectedRoomCode: room.code,
        status: p.status,
        checkinDone: p.checkinDone,
      },
    });
    createdBookings++;

    if (!p.checkinDone) continue; // pas encore arrivé : pas de commande/taxe/ménage

    // ── Commande boutique (1 à 2 par séjour) ──
    const itemCount = 1 + (p.guestIdx % 2);
    const items = Array.from({ length: itemCount }, (_, i) => {
      const it = pick(BOUTIQUE_ITEMS, p.guestIdx + i);
      return { id: it.id, label: it.label, price: it.price, qty: 1 };
    });
    const total = items.reduce((s, it) => s + it.price, 0);
    await prisma.order.create({
      data: {
        entityId: entity.id,
        bookingId: booking.id,
        bookingCode: booking.code,
        source: "checkin",
        clientName: `${guest.first} ${guest.last}`,
        roomCode: room.code,
        roomName: room.name,
        items,
        total,
        status: "delivered",
        createdAt: addDays(start, 1),
      },
    });
    createdOrders++;

    // ── Taxe de séjour (barème standard 2,30 €/nuit/adulte) ──
    const adults = 1 + (p.guestIdx % 2);
    const tarif = 2.3;
    const montant = Math.round(tarif * p.nights * adults * 100) / 100;
    await prisma.taxeSejourRecord.create({
      data: {
        entityId: entity.id,
        bookingId: booking.id,
        bookingCode: booking.code,
        facilityCode: room.code,
        checkinDate: start,
        checkoutDate: end,
        nights: p.nights,
        occupantsTotal: adults,
        occupantsAdultes: adults,
        occupantsAdos: 0,
        occupantsEnfants: 0,
        occupantsBebes: 0,
        tarifPerNightPerPerson: tarif,
        montantBrut: montant,
        montantDeduction: 0,
        montantNet: montant,
        devise: "EUR",
      },
    });
    createdTaxe++;

    // ── Ménage éco (check-in éco) : moins de tâches que de nuits pour que
    // les indicateurs "ménages évités / eau économisée" soient positifs ──
    const cleanings = Math.max(1, Math.ceil(p.nights / 2) - 1);
    for (let i = 0; i < cleanings; i++) {
      await prisma.housekeepingTask.create({
        data: {
          entityId: entity.id,
          roomCode: room.code,
          taskDate: addDays(start, 1 + i * 2),
          type: "menage",
          bookingCode: booking.code,
          ecoAuto: true,
          status: "done",
        },
      });
      createdTasks++;
    }
  }

  console.log(`Terminé : +${createdBookings} réservations, +${createdOrders} commandes, +${createdTaxe} taxes de séjour, +${createdTasks} tâches ménage.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
