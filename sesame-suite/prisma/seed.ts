/**
 * Seed de démonstration — Hôtel Churchill Montreuil.
 * Données reprises telles que documentées dans documentation_sesame_suite.docx
 * (§10.1, §10.2) et dossier_lancement_dev.docx (§9.2, §3.1, §5.2), complétées
 * par les deux réservations historiques présentes dans le prototype HTML
 * (ESP_DEMO_BOOKINGS : HCH-2026-0881 et HCH-2026-0654) pour que l'onglet
 * "Historique" de l'espace client affiche bien "2 séjours" pour Camille et
 * Thomas comme annoncé dans la doc.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const ENTITY_CODE = process.env.DEFAULT_ENTITY_CODE || "E00000001";
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || "admin@hotel-churchill.fr";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "churchill2026";

async function main() {
  console.log(`Seeding entity ${ENTITY_CODE} (Hôtel Churchill)…`);

  const entity = await prisma.entity.upsert({
    where: { code: ENTITY_CODE },
    update: {},
    create: { code: ENTITY_CODE, name: "Hôtel Churchill" },
  });

  // ── Configuration / charte graphique (dossier_lancement_dev §3.1, §3.2) ──
  await prisma.entityModuleConfig.upsert({
    where: { entityId: entity.id },
    update: {},
    create: {
      entityId: entity.id,
      hotelName: "Hôtel Churchill",
      hotelSlogan: "",
      stars: 3,
      colors: {
        primary: "#8B1A2E",
        primaryLight: "#FDEDF0",
        accent: "#8B1A2E",
        headerBg: "#8B1A2E",
        headerText: "#FFFFFF",
        bg: "#F5F3F0",
        cardBg: "#FFFFFF",
        border: "#E3DED8",
        text: "#14121E",
        btnNav: "#8B1A2E",
      },
      radius: 14,
      radiusBtn: 8,
      shadow: true,
      fontTitle: "'Fraunces',serif",
      fontBody: "'Sora',sans-serif",
      logoMain: null,
      msgEco: "Chaque geste compte ! Vos choix génèrent des récompenses.",
      btnLabel: "Continuer",
      ptsLabel: "Sesame Points",
      lang: "fr",
      currency: "EUR",
      tarifs: [0.88, 1.65, 2.6, 4.2, 6.0],
      exoEnf: true,
      reducAdos: true,
      exoHand: false,
      eauMenage: 15,
      eauServ: 40,
      co2Factor: 0.0003,
      freqOpts: [0, 3, 1],
      gains: {
        points: { active: true, name: "Sesame Points", perLiter: 1.0, perMenage: 0, perServ: 0 },
        reduction: { active: true, pct: 5, cond: "any", cumul: true },
        produit: { active: false, list: ["Petit-déjeuner offert", "Late check-out"], mode: "single" },
        financier: { active: false, euroPerMenage: 2.5, deductible: true, toPoints: true },
      },
      checkinModules: {
        room: { active: true, mandatory: true },
        taxe: { active: true, mandatory: true },
        kyc: { active: true, mandatory: false },
        eco: { active: true, mandatory: false },
        boutique: { active: true, mandatory: false },
        rewards: { active: true, mandatory: true },
        roomservice: { active: true, mandatory: false },
      },
      rewardCatalog: [
        { id: "cafe", pts: 50, ico: "ti-coffee", label: "Café ou thé", desc: "Offert en chambre ou au bar", color: "#9B6E0A", active: true },
        { id: "petit_dej", pts: 150, ico: "ti-bread", label: "Petit-déjeuner", desc: "Pour 1 personne", color: "#8B1A2E", active: true },
        { id: "cocktail", pts: 200, ico: "ti-martini", label: "Cocktail de bienvenue", desc: "Au choix à la réception", color: "#7D3C98", active: true },
        { id: "parking", pts: 300, ico: "ti-car", label: "Parking 1 nuit", desc: "Place couverte", color: "#1A4880", active: true },
        { id: "spa", pts: 400, ico: "ti-heart-plus", label: "Accès Spa 1h", desc: "Sauna, hammam, piscine", color: "#B83030", active: true },
        { id: "late", pts: 250, ico: "ti-clock", label: "Late check-out", desc: "Départ jusqu'à 14h", color: "#1A4880", active: true },
        { id: "surclassement", pts: 500, ico: "ti-star", label: "Surclassement", desc: "Sous réserve de disponibilité", color: "#9B6E0A", active: true },
        { id: "bouteille", pts: 350, ico: "ti-bottle", label: "Bouteille de vin", desc: "Sélection du sommelier", color: "#7D3C98", active: true },
      ],
      loyaltyTiers: {
        gold: 500,
        premium: 1500,
        perks: {
          Standard: ["Accès au programme de fidélité", "Offres anniversaire"],
          Gold: ["Late check-out jusqu'à 14h", "Surclassement selon disponibilité", "Boisson de bienvenue offerte"],
          Premium: ["Petit-déjeuner offert chaque matin", "Surclassement prioritaire", "Check-out tardif jusqu'à 16h", "Accès au salon Premium"],
        },
      },
      hotelPlan: null,
      roomTags: ["Vue jardin", "Vue rue", "Étage élevé", "Calme", "Balcon"],
      accessPoints: [{ id: "room", label: "Chambre", ico: "ti-door", facilityCode: "", auto: true }],
    },
  });

  // ── Chambres (documentation_sesame_suite.docx §10.2) ──
  // floor: RDC=0, R+1=1, R+2=2, R+3=3, R+4=4 (cf. flLbls dans le prototype)
  const ROOMS: Array<{
    code: string; name: string; floor: number; surface: number; category: string; available: boolean; tag: string;
  }> = [
    { code: "A11", name: "Chambre A11 — Supérieure", floor: 1, surface: 25.1, category: "A — Supérieure", available: true, tag: "Supérieure" },
    { code: "A12", name: "Suite A12 — Supérieure", floor: 1, surface: 30.6, category: "A — Supérieure", available: true, tag: "Supérieure" },
    { code: "A14", name: "Chambre A14 — Supérieure", floor: 1, surface: 26.6, category: "A — Supérieure", available: false, tag: "Supérieure" },
    { code: "A23", name: "Chambre A23 — Supérieure", floor: 2, surface: 19.3, category: "A — Supérieure", available: true, tag: "Supérieure" },
    { code: "A42", name: "Chambre A42 — Supérieure Attique", floor: 4, surface: 24.1, category: "A — Supérieure", available: true, tag: "Attique" },
    { code: "A43", name: "Suite A43 — Attique", floor: 4, surface: 22.0, category: "A — Supérieure", available: true, tag: "Attique" },
    { code: "B13", name: "Chambre B13 — Standard", floor: 1, surface: 14.1, category: "B — Standard", available: true, tag: "Standard" },
    { code: "B14", name: "Chambre B14 — Standard", floor: 1, surface: 14.6, category: "B — Standard", available: true, tag: "Standard" },
    { code: "B43", name: "Chambre B43 — Standard", floor: 4, surface: 14.1, category: "B — Standard", available: true, tag: "Standard" },
    { code: "C16", name: "Chambre C16 — Compacte", floor: 1, surface: 15.3, category: "C — Compacte", available: true, tag: "Compacte" },
    { code: "C17", name: "Chambre C17 — Compacte", floor: 1, surface: 15.3, category: "C — Compacte", available: true, tag: "Compacte" },
    { code: "C19", name: "Chambre C19 — Compacte", floor: 1, surface: 15.2, category: "C — Compacte", available: false, tag: "Compacte" },
  ];

  const roomByCode = new Map<string, string>(); // code -> room.id
  for (const r of ROOMS) {
    const room = await prisma.room.upsert({
      where: { entityId_code: { entityId: entity.id, code: r.code } },
      update: {},
      create: {
        entityId: entity.id,
        code: r.code,
        name: r.name,
        floor: r.floor,
        surface: r.surface,
        category: r.category,
        tags: [r.tag],
        photos: [],
        available: r.available,
      },
    });
    roomByCode.set(r.code, room.id);
    await prisma.roomHousekeepingStatus.upsert({
      where: { roomId: room.id },
      update: {},
      create: { roomId: room.id, status: "libre" },
    });
  }

  // ── Réservations démo (documentation §10.1 + dossier §9.2 + historique du prototype) ──
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const BOOKINGS: Array<{
    code: string; email: string; first: string; last: string; room: string; start: string; end: string; status: string;
  }> = [
    { code: "DEMO-2026-0001", email: "demo@sesame.fr", first: "Alexis", last: "DEMO", room: "A43", start: "2026-08-10", end: "2026-08-15", status: "checkin_done" },
    { code: "HCH-2026-1042", email: "camille.bernard@gmail.com", first: "Camille", last: "BERNARD", room: "A12", start: "2026-06-10", end: "2026-06-13", status: "confirmed" },
    { code: "HCH-2026-0881", email: "camille.bernard@gmail.com", first: "Camille", last: "BERNARD", room: "B11", start: "2025-12-27", end: "2025-12-30", status: "completed" },
    { code: "HCH-2026-1078", email: "thomas.moreau@email.fr", first: "Thomas", last: "MOREAU", room: "B13", start: "2026-06-15", end: "2026-06-19", status: "confirmed" },
    { code: "HCH-2026-0654", email: "thomas.moreau@email.fr", first: "Thomas", last: "MOREAU", room: "C17", start: "2025-09-14", end: "2025-09-17", status: "completed" },
    { code: "HCH-2026-1095", email: "sophie.laurent@hotmail.fr", first: "Sophie", last: "LAURENT", room: "C16", start: "2026-05-20", end: "2026-05-22", status: "completed" },
    { code: "HCH-2026-1103", email: "julien.petit@gmail.com", first: "Julien", last: "PETIT", room: "A42", start: "2026-07-02", end: "2026-07-07", status: "confirmed" },
    { code: "HCH-2026-1118", email: "marie.dupuis@yahoo.fr", first: "Marie", last: "DUPUIS", room: "B43", start: "2026-06-10", end: "2026-06-14", status: "confirmed" },
  ];
  // Room names for historical bookings whose room isn't part of the 12 officially
  // configured Churchill rooms (B11 only appears in the prototype's history data).
  const FACILITY_NAME_OVERRIDE: Record<string, string> = {
    B11: "Chambre B11 — Standard",
  };

  for (const b of BOOKINGS) {
    const roomId = roomByCode.get(b.room) ?? null;
    const roomRow = roomId ? ROOMS.find((r) => r.code === b.room) : null;
    const facilityName = roomRow ? roomRow.name : FACILITY_NAME_OVERRIDE[b.room] || b.room;
    await prisma.booking.upsert({
      where: { entityId_code: { entityId: entity.id, code: b.code } },
      update: {},
      create: {
        entityId: entity.id,
        code: b.code,
        personEmail: b.email,
        personFirstname: b.first,
        personLastname: b.last,
        personPhone: "+33 6 00 00 00 00",
        startDate: new Date(b.start),
        endDate: new Date(b.end),
        roomId,
        facilityCode: b.room,
        facilityName,
        status: b.status,
        checkinDone: b.status === "checkin_done",
        selectedRoomCode: b.status === "checkin_done" ? b.room : null,
      },
    });
  }
  void today;
  void iso;

  // ── Catalogue boutique / room service (dossier §5.2 — 14 produits / 5 catégories) ──
  const PRODUCTS: Array<{ id: string; cat: string; ico: string; label: string; desc: string; price: number; photo: string }> = [
    { id: "bq_eau", cat: "Boissons", ico: "ti-droplet", label: "Eau minérale 50cl", desc: "Plate ou gazeuse, servie fraîche", price: 3.5, photo: "https://images.unsplash.com/photo-1548839140-29a749e1cf4d?w=400&q=70" },
    { id: "bq_cafe", cat: "Boissons", ico: "ti-coffee", label: "Café / Thé", desc: "Espresso, cappuccino, assortiment de thés et infusions", price: 4.5, photo: "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=400&q=70" },
    { id: "bq_vin", cat: "Boissons", ico: "ti-glass-full", label: "Verre de vin", desc: "Sélection du sommelier — rouge, blanc ou rosé", price: 8.0, photo: "https://images.unsplash.com/photo-1510812431401-41d2bd2722f3?w=400&q=70" },
    { id: "bq_champ", cat: "Boissons", ico: "ti-bottle", label: "Coupe de Champagne", desc: "Brut ou rosé, bulles délicates", price: 14.0, photo: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=70" },
    { id: "bq_club", cat: "Restauration", ico: "ti-sandwich", label: "Club sandwich", desc: "Poulet rôti, bacon, salade, tomates, mayo maison", price: 14.0, photo: "https://images.unsplash.com/photo-1539252554453-80ab65ce3586?w=400&q=70" },
    { id: "bq_burger", cat: "Restauration", ico: "ti-burger", label: "Burger Churchill", desc: "Bœuf charolais, comté, relish maison, frites fraîches", price: 17.0, photo: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&q=70" },
    { id: "bq_pdej", cat: "Restauration", ico: "ti-bread", label: "Plateau petit-déjeuner", desc: "Viennoiseries, fromages, fruits frais, jus pressé", price: 18.0, photo: "https://images.unsplash.com/photo-1504754524776-8f4f37790ca0?w=400&q=70" },
    { id: "bq_fruits", cat: "Desserts", ico: "ti-apple", label: "Coupe de fruits frais", desc: "Sélection de saison, coulis de fruits rouges", price: 7.0, photo: "https://images.unsplash.com/photo-1519996529931-28324d5a630e?w=400&q=70" },
    { id: "bq_patis", cat: "Desserts", ico: "ti-cake", label: "Pâtisserie du chef", desc: "Mille-feuille, tarte ou entremet du jour", price: 8.0, photo: "https://images.unsplash.com/photo-1464305795204-6f5bbfc7fb81?w=400&q=70" },
    { id: "bq_kit", cat: "Bien-être", ico: "ti-bath", label: "Kit bien-être", desc: "Peignoir moelleux + chaussons + sel de bain", price: 15.0, photo: "https://images.unsplash.com/photo-1556228578-8c89e6adf883?w=400&q=70" },
    { id: "bq_oreill", cat: "Bien-être", ico: "ti-moon", label: "Oreiller supplémentaire", desc: "Mémoire de forme ou plumes — précisez votre choix", price: 0.0, photo: "https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=400&q=70" },
    { id: "bq_spa", cat: "Bien-être", ico: "ti-droplet-half", label: "Accès Spa 1h", desc: "Sauna, hammam, jacuzzi — réservation confirmée en chambre", price: 28.0, photo: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?w=400&q=70" },
    { id: "bq_press", cat: "Services", ico: "ti-shirt", label: "Pressing express", desc: "Retour garanti sous 4h — récupération en chambre", price: 12.0, photo: "https://images.unsplash.com/photo-1558097704-013f40a5d0b9?w=400&q=70" },
    { id: "bq_taxi", cat: "Services", ico: "ti-car", label: "Transfert taxi", desc: "Réservation prioritaire vers gare ou aéroport", price: 0.0, photo: "https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=400&q=70" },
  ];

  for (let i = 0; i < PRODUCTS.length; i++) {
    const p = PRODUCTS[i];
    const existing = await prisma.product.findFirst({ where: { entityId: entity.id, category: p.cat, label: p.label } });
    if (existing) continue;
    await prisma.product.create({
      data: {
        entityId: entity.id,
        category: p.cat,
        label: p.label,
        description: p.desc,
        price: p.price,
        icon: p.ico,
        photo: p.photo,
        photos: [p.photo],
        active: true,
        sortOrder: i,
      },
    });
  }

  // ── Livret digital — rubriques de démonstration ──
  const LIVRET: Array<{ title: string; icon: string; content: string; order: number }> = [
    {
      title: "Bienvenue à l'Hôtel Churchill",
      icon: "ti-home-heart",
      content: "<p>Toute l'équipe est heureuse de vous accueillir. Ce livret digital rassemble les informations utiles pour profiter pleinement de votre séjour.</p>",
      order: 0,
    },
    {
      title: "Wi-Fi & connexion",
      icon: "ti-wifi",
      content: "<p>Réseau : <strong>Churchill-Guest</strong><br>Mot de passe : <strong>bienvenue2026</strong></p>",
      order: 1,
    },
    {
      title: "Petit-déjeuner",
      icon: "ti-coffee",
      content: "<p>Servi de 7h00 à 10h30 en salle Churchill (rez-de-chaussée). Formule continentale incluse, à la carte sur demande.</p>",
      order: 2,
    },
    {
      title: "Contact réception",
      icon: "ti-phone",
      content: "<p>24h/24 depuis votre chambre en composant le <strong>9</strong>, ou par la Boutique de l'application.</p>",
      order: 3,
    },
  ];
  const existingLivret = await prisma.livretSection.count({ where: { entityId: entity.id } });
  if (existingLivret === 0) {
    for (const s of LIVRET) {
      await prisma.livretSection.create({
        data: {
          entityId: entity.id,
          title: s.title,
          icon: s.icon,
          content: s.content,
          sortOrder: s.order,
          published: true,
        },
      });
    }
  }

  // ── Soldes de fidélité de démonstration ──
  const LOYALTY: Array<{ email: string; points: number }> = [
    { email: "demo@sesame.fr", points: 180 },
    { email: "camille.bernard@gmail.com", points: 620 },
    { email: "thomas.moreau@email.fr", points: 90 },
  ];
  for (const l of LOYALTY) {
    const account = await prisma.loyaltyAccount.upsert({
      where: { entityId_email: { entityId: entity.id, email: l.email } },
      update: { totalPoints: l.points },
      create: { entityId: entity.id, email: l.email, totalPoints: l.points },
    });
    const hasTx = await prisma.loyaltyTransaction.count({ where: { accountId: account.id } });
    if (hasTx === 0 && l.points > 0) {
      await prisma.loyaltyTransaction.create({
        data: { accountId: account.id, earned: l.points, spent: 0, bookingCode: null },
      });
    }
  }

  // ── Compte admin back-office ──
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await prisma.adminUser.upsert({
    where: { entityId_email: { entityId: entity.id, email: ADMIN_EMAIL } },
    update: {},
    create: { entityId: entity.id, email: ADMIN_EMAIL, passwordHash, name: "Direction Hôtel Churchill" },
  });
  console.log(`Admin seedé : ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);

  // ── Agents de ménage de démonstration (Planning) ──
  const STAFF: Array<{ name: string; color: string; team: string; rooms: string[] }> = [
    { name: "Fatou N.", color: "#2ECC71", team: "Matin", rooms: ["A11", "A12", "A23"] },
    { name: "Karim B.", color: "#3A9BD5", team: "Matin", rooms: ["B13", "B14", "B43"] },
    { name: "Elena R.", color: "#E67E22", team: "Après-midi", rooms: ["C16", "C17", "A42", "A43"] },
  ];
  const existingStaff = await prisma.housekeepingStaff.count({ where: { entityId: entity.id } });
  if (existingStaff === 0) {
    for (const s of STAFF) {
      await prisma.housekeepingStaff.create({
        data: { entityId: entity.id, name: s.name, color: s.color, team: s.team, assignedRoomCodes: s.rooms },
      });
    }
  }

  console.log("Seed terminé ✓");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
