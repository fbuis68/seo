/**
 * Corrige l'import "EquipHotel Paris 2026" (export scanner de badges,
 * colonne "Scanné par") dont le rapprochement commercial automatique a
 * échoué à l'import (05/11/2026, cf. fix du nom composé dans
 * matchCommercial() — routes/crmProspect.ts — insuffisant pour ce lot
 * déjà importé AVANT le fix).
 *
 * La valeur brute "Scanné par" n'est PAS stockée sur CrmProspect une fois
 * l'import terminé (seulement utilisée en mémoire côté serveur pour la
 * tentative de rapprochement) — impossible de la relire depuis la base.
 * Ce script réutilise donc la correspondance email → "Scanné par" extraite
 * directement du fichier Excel original (76 lignes, 3 scanneurs) plutôt
 * que de la deviner, et applique le mapping donné par le client :
 *   "JEAN THIERRY LODS" → commercial "JT"
 *   "Frederic Buis"     → commercial "Fred"
 *   "Visitor"           → commercial "Blanc"
 *
 * N'écrase JAMAIS un commercial déjà assigné (sauf --force) — en relançant
 * ce script par erreur, ou si un commercial a été corrigé à la main entre
 * temps. Lancer une seule fois après déploiement :
 *   tsx scripts/backfill-equiphotel-commercial.ts
 *   tsx scripts/backfill-equiphotel-commercial.ts --force   (réassigne même si déjà rempli)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const FORCE = process.argv.includes("--force");

// Emails extraits du fichier source (colonne Email + colonne "Scanné par"),
// groupés par scanneur — cf. commentaire ci-dessus, cette valeur brute
// n'existe plus nulle part en base.
const GROUPS: Record<string, string[]> = {
  // 41 lignes "Scanné par" = "JEAN THIERRY LODS"
  JT: [
    "jerome.lacroix@thermokon.fr",
    "f.chalumeau@ctxv.fr",
    "lre.perniola@gmail.com",
    "zakikhemais@gmail.com",
    "fv@domainedesuzel.com",
    "mjpm.sdebellabre@gmail.com",
    "g.ml@live.fr",
    "direction@vargestion.com",
    "jeanmarcgottero@gmail.com",
    "arnaud.salomon67@free.fr",
    "patcollov@gmail.com",
    "gm.hotels@solestia-group.com",
    "direction@urbatikdt.com",
    "poinclouxphilippe@gmail.com",
    "fsaveuse@icloud.com",
    "dsaveuse@gmail.com",
    "arles@brithotel.fr",
    "karim@hotellemillesime.fr",
    "l.lomont@looom.fr",
    "contact@hotelnympheas.fr",
    "johanna.amar@gmail.com",
    "mbizeau@villagesclubsdusoleil.com",
    "ylancar@acaris.fr",
    "jsamaras39@gmail.com",
    "hamya@wanadoo.fr",
    "sales@lesbainsgardians.com",
    "anna.debayeux@gmail.com",
    "nicolas.beraud@wenova-am.com",
    "smile@cocolodge.co",
    "lou.wendling3@gmail.com",
    "colette.carrie@wanadoo.fr",
    "thibault.charlot286@gmail.com",
    "violainesavatier@gmail.com",
    "virginierudelle@yahoo.fr",
    "julien.perrot@star-activity.com",
    "kandjy@hotmail.com",
    "nm@nmho.fr",
    "bouzid.berkani@yahoo.fr",
    "j.gaudefroy@lechateaudelatour.fr",
    "babin@agencedelaplage.immo",
    "jean-philippe.doyen@sixt.com",
  ],
  // 26 lignes "Scanné par" = "Frederic Buis"
  Fred: [
    "tony.benard@m-affinityhotel.com",
    "ads.sandyrey@free.fr",
    "laurent@coworkinglabs.fr",
    "laurent.ghelfi@starinvest.com",
    "bretonreginald@gmail.com",
    "kate@qc.ie",
    "reservations@maisonfenestraz.com",
    "anthony.appollot@sarmentsvignobles.com",
    "julien@thiasos.fr",
    "hotels-rennes@maisonruello.com",
    "contact@cedreno.com",
    "cohcolg@gmail.com",
    "contact@spalazen-nature.com",
    "seanergie.rangiroa@gmail.com",
    "frederic.gustave@socagem.com",
    "hotelsofiane@hotmail.fr",
    "contact@kyvos.me",
    "cagros@etic-groupe.com",
    "ptorrelli@pmthotels.com",
    "direction@moulindecambelong.com",
    "contact@hotelmartinezgrenay.com",
    "lerepublique77460@gmail.com",
    "christophe@ccconseils.fr",
    "didier@hoteldeparis.fr",
    "direction@le-moulin-neuf.com",
    "hotel@ascotparishotel.com",
  ],
  // 8 lignes "Scanné par" = "Visitor"
  Blanc: [
    "jeremy.lollia@sarmentsvignobles.com",
    "capucinerz@gmail.com",
    "m.walker.matthieu@gmail.com",
    "seanergie.rangiroa@gmail.com",
    "sales@lesbainsgardians.com",
    "eeckhaut.arnaud@gmail.com",
    "direction@baiedesanges.com",
    "c.morand@nmho.fr",
  ],
};

// Note : "seanergie.rangiroa@gmail.com" et "sales@lesbainsgardians.com"
// apparaissent dans DEUX groupes (Frederic Buis/Visitor et JT/Visitor
// respectivement) — le fichier source contient deux lignes avec cet email
// (deux badges/passages distincts). Si une seule fiche CrmProspect existe
// pour cet email, elle sera assignée au premier groupe traité ci-dessous
// (JT, puis Fred, puis Blanc) et ignorée pour le second (commercialId déjà
// rempli) — à corriger manuellement si l'ordre attendu est différent.

async function main() {
  const adminsByName = new Map<string, { id: string; name: string | null }>();
  for (const label of Object.keys(GROUPS)) {
    const admin = await prisma.adminUser.findFirst({
      where: { role: "sesame", active: true, name: { equals: label, mode: "insensitive" } },
      select: { id: true, name: true },
    });
    if (!admin) {
      console.warn(`⚠ Aucun compte sesame actif nommé "${label}" trouvé — groupe ignoré.`);
      continue;
    }
    adminsByName.set(label, admin);
  }

  let updated = 0,
    alreadySet = 0,
    notFound = 0,
    skippedNoAdmin = 0;

  for (const [label, emails] of Object.entries(GROUPS)) {
    const admin = adminsByName.get(label);
    if (!admin) {
      skippedNoAdmin += emails.length;
      continue;
    }
    for (const rawEmail of emails) {
      const email = rawEmail.trim().toLowerCase();
      const prospect = await prisma.crmProspect.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true, nom: true, commercialId: true },
      });
      if (!prospect) {
        console.warn(`✗ Introuvable en base : ${email} (prévu pour ${label})`);
        notFound++;
        continue;
      }
      if (prospect.commercialId && !FORCE) {
        alreadySet++;
        continue;
      }
      await prisma.crmProspect.update({ where: { id: prospect.id }, data: { commercialId: admin.id } });
      console.log(`✓ ${prospect.nom} (${email}) → ${label}`);
      updated++;
    }
  }

  console.log(
    `\nTerminé : ${updated} mis à jour, ${alreadySet} déjà assignés (ignorés, relancer avec --force pour écraser), ${notFound} introuvables en base, ${skippedNoAdmin} sautés (compte sesame introuvable).`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
