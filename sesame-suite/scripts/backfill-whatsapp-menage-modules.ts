/**
 * Scission du module "sms" (SMS & WhatsApp combinés, 12€) en deux modules
 * distincts "sms" et "whatsapp" (29/10/2026, demande client) + ajout du
 * nouveau module "menage" (app dédiée menage.html, jusque-là non gardiée
 * par aucun module). Les deux changements grand-périsent l'existant pour
 * ne RIEN couper à un client déjà actif :
 *
 * - Toute Subscription ayant déjà "sms" dans ses modules reçoit aussi
 *   "whatsapp" (elle gardait les deux canaux avant la scission).
 * - TOUTE Subscription reçoit "menage" (le module n'existait pas avant,
 *   personne ne doit perdre l'accès à menage.html du jour au lendemain).
 *
 * Ne touche ni basePrice, ni modulePrices, ni monthlyTotal — purement un
 * ajustement d'accès, pas une refacturation rétroactive. À lancer une
 * seule fois après déploiement du code (tsx scripts/backfill-whatsapp-menage-modules.ts).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.subscription.findMany({ select: { id: true, modules: true } });
  let updated = 0;
  for (const row of rows) {
    const modules = Array.isArray(row.modules) ? (row.modules as string[]) : [];
    const next = new Set(modules);
    const hadSms = next.has("sms");
    if (hadSms) next.add("whatsapp");
    next.add("menage");
    if (next.size === modules.length) continue; // rien à ajouter, inutile de réécrire
    await prisma.subscription.update({ where: { id: row.id }, data: { modules: [...next] } });
    updated++;
  }
  console.log(`${updated}/${rows.length} souscription(s) mise(s) à jour (whatsapp grand-périsé si sms déjà présent, menage grand-périsé pour toutes).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
