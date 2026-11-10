/**
 * Migration d'un premier client depuis l'ancienne guest app (10/11/2026,
 * "des e-mails de checkin qui sont déjà en base avec l'ancienne url... qui
 * feront doublon avec les nouveaux") — l'ANCIEN SERVEUR RESTE EN LIGNE
 * après la bascule (confirmé par le client) : il continuera de tirer SA
 * propre règle H-8 pour CHAQUE résa déjà présente dans sa base, quelle que
 * soit sa date d'arrivée — une résa saisie il y a 6 mois avec arrivée dans
 * 8 mois recevra quand même le mail de l'ancienne app le moment venu.
 *
 * Le critère n'est donc PAS la date d'arrivée (version précédente de ce
 * script, erronée) mais la SAISIE : toute résa qui existait déjà dans
 * l'ancien système au moment de l'import doit être suppressed côté Sesame
 * — POUR TOUJOURS, peu importe quand elle arrive — puisque l'ancienne app
 * s'en charge de toute façon. Seules les résas créées APRÈS la bascule
 * (jamais passées par l'ancien système) doivent recevoir le mail Sesame.
 *
 * Ce script suppresse donc TOUT le backlog d'un coup : toutes les résas de
 * l'entité présentes au moment où on le lance (= tout ce qui vient de
 * l'import initial), pour chaque règle "stay.start" ACTIVE. Lancé une
 * seule fois, juste après l'import initial, avant que de nouvelles résas
 * "natives Sesame" ne commencent à arriver — --before permet de fixer une
 * limite de sécurité (ne suppresse que les résas créées avant cette date)
 * si le script est relancé plus tard et qu'il ne faut pas toucher les
 * résas entre-temps saisies nativement dans Sesame.
 *
 * Dry-run par défaut (liste ce qui SERAIT supprimé) ; --apply pour écrire
 * réellement. Jamais de doublon si relancé par erreur : AutomationRuleLog a
 * une contrainte unique (ruleId, targetType, targetId), skipDuplicates.
 *
 * Usage :
 *   tsx scripts/suppress-stay-start-duplicates.ts --entityCode=XXXX
 *   tsx scripts/suppress-stay-start-duplicates.ts --entityCode=XXXX --before=2026-11-10T00:00:00Z --apply
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function argValue(name: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
}

const ENTITY_CODE = argValue("entityCode");
const BEFORE_RAW = argValue("before");
const APPLY = process.argv.includes("--apply");

async function main() {
  if (!ENTITY_CODE) {
    console.error("Usage: tsx scripts/suppress-stay-start-duplicates.ts --entityCode=XXXX [--before=2026-11-10T00:00:00Z] [--apply]");
    process.exit(1);
  }
  let before: Date | null = null;
  if (BEFORE_RAW) {
    before = new Date(BEFORE_RAW);
    if (Number.isNaN(before.getTime())) {
      console.error(`--before invalide : "${BEFORE_RAW}" (attendu : date ISO, ex. 2026-11-10T00:00:00Z)`);
      process.exit(1);
    }
  }

  const entity = await prisma.entity.findUnique({ where: { code: ENTITY_CODE } });
  if (!entity) {
    console.error(`Aucun établissement avec le code "${ENTITY_CODE}"`);
    process.exit(1);
  }

  const rules = await prisma.automationRule.findMany({
    where: { entityId: entity.id, trigger: "stay.start", enabled: true },
  });
  if (!rules.length) {
    console.log(`Aucune règle "Début de séjour" active pour ${ENTITY_CODE} — rien à faire.`);
    return;
  }

  // Tout le backlog (toute résa déjà en base) sauf si --before fixe une
  // limite plus stricte — jamais filtré sur la date d'ARRIVÉE, l'ancienne
  // app enverra son H-8 quelle que soit cette date tant qu'elle reste en
  // ligne.
  const backlogBookings = await prisma.booking.findMany({
    where: { entityId: entity.id, ...(before ? { createdAt: { lt: before } } : {}) },
    select: { id: true, code: true, personEmail: true, startDate: true, createdAt: true },
    orderBy: { startDate: "asc" },
  });

  console.log(
    `${ENTITY_CODE} — ${rules.length} règle(s) "Début de séjour" active(s), ${backlogBookings.length} résa(s) du backlog (ancienne app, H-8 à venir quelle que soit la date d'arrivée) :`
  );
  for (const b of backlogBookings) {
    console.log(`  - ${b.code} · ${b.personEmail || "(pas d'email)"} · arrivée ${b.startDate.toLocaleString("fr-FR")} · saisie ${b.createdAt.toLocaleString("fr-FR")}`);
  }

  if (!backlogBookings.length) {
    console.log("Rien à supprimer.");
    return;
  }

  const rows = rules.flatMap((rule) =>
    backlogBookings.map((b) => ({ ruleId: rule.id, targetType: "booking", targetId: b.id }))
  );

  if (!APPLY) {
    console.log(`\n${rows.length} ligne(s) AutomationRuleLog seraient créées (${rules.length} règle(s) × ${backlogBookings.length} résa(s)). Relancer avec --apply pour écrire réellement.`);
    return;
  }

  const result = await prisma.automationRuleLog.createMany({ data: rows, skipDuplicates: true });
  console.log(`\n✓ ${result.count} ligne(s) créées — ces résas ne recevront jamais le mail de check-in Sesame (prises en charge par l'ancienne app). Toute résa saisie ensuite directement dans Sesame sera gérée normalement.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
