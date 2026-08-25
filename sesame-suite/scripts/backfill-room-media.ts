/**
 * Régénère Room.photos pour toutes les chambres déjà en base à partir du
 * générateur courant (prisma/roomMedia.ts) — contrairement à seed.ts (qui
 * ne pose des photos qu'à la CRÉATION d'une chambre, jamais sur une ligne
 * existante), ce script réécrit systématiquement les photos existantes.
 * À relancer chaque fois que roomPhotoSvg()/hotelPlanSvg() sont retouchés
 * visuellement, pour propager l'amélioration aux bases déjà provisionnées
 * (ex. 25/08/2026 : lampe de chevet clarifiée, rideaux ajoutés, plante de
 * la salle de bain simplifiée — cf. historique de ce fichier).
 *
 * Ne couvre que les chambres dont le code correspond à ROOMS (le
 * catalogue Churchill officiel) — les chambres de test/manuelles hors
 * catalogue n'ont pas de photo de référence à regénérer.
 */
import { PrismaClient } from "@prisma/client";
import { ROOMS, svgDataUri, hotelPlanSvg, roomPhotoSvg } from "../prisma/roomMedia";

const prisma = new PrismaClient();

async function main() {
  const roomByCode = new Map(ROOMS.map((r) => [r.code, r]));
  const rows = await prisma.room.findMany({ where: { code: { in: ROOMS.map((r) => r.code) } } });

  let updated = 0;
  for (const row of rows) {
    const r = roomByCode.get(row.code);
    if (!r) continue;
    await prisma.room.update({
      where: { id: row.id },
      data: { photos: [svgDataUri(roomPhotoSvg(r.name, r.category, "chambre")), svgDataUri(roomPhotoSvg(r.name, r.category, "sdb"))] },
    });
    updated++;
  }
  console.log(`Photos régénérées pour ${updated} chambre(s).`);

  const configs = await prisma.entityModuleConfig.findMany({ where: { entity: { code: "E00000001" } } });
  for (const c of configs) {
    await prisma.entityModuleConfig.update({ where: { id: c.id }, data: { hotelPlan: svgDataUri(hotelPlanSvg()) } });
  }
  console.log(`Plan de l'hôtel régénéré pour ${configs.length} configuration(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
