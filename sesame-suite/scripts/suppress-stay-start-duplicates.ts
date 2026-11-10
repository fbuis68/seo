/**
 * Migration d'un premier client depuis l'ancienne guest app (10/11/2026,
 * "des e-mails de checkin qui sont déjà en base avec l'ancienne url... qui
 * feront doublon avec les nouveaux") — l'ancienne app n'a qu'une règle
 * H-8 (8h avant l'arrivée) : toute résa dont l'arrivée tombe dans les 8h
 * depuis maintenant a donc déjà reçu (ou est en train de recevoir) le mail
 * de check-in côté ancienne app. Au-delà de 8h, l'ancienne app n'a encore
 * rien envoyé — ces résas-là n'ont pas besoin d'être touchées.
 *
 * Ce script pré-remplit AutomationRuleLog pour chaque règle "stay.start"
 * ACTIVE de l'entité ciblée, sur les résas dans la fenêtre de risque — le
 * balayage périodique de lib/automation.ts (sweepDateRule) les verra comme
 * "déjà notifiées" et les sautera, sans toucher aux résas plus lointaines
 * ni désactiver la règle elle-même (les vrais nouveaux arrivants au-delà
 * de 8h sont gérés normalement dès l'import).
 *
 * Dry-run par défaut (liste ce qui SERAIT supprimé) ; --apply pour écrire
 * réellement. Jamais exécuté deux fois par erreur : AutomationRuleLog a une
 * contrainte unique (ruleId, targetType, targetId), un doublon est ignoré
 * silencieusement (skipDuplicates) plutôt que de planter.
 *
 * Usage :
 *   tsx scripts/suppress-stay-start-duplicates.ts --entityCode=XXXX
 *   tsx scripts/suppress-stay-start-duplicates.ts --entityCode=XXXX --hours=8 --apply
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function argValue(name: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
}

const ENTITY_CODE = argValue("entityCode");
const HOURS = Number(argValue("hours") || "8");
const APPLY = process.argv.includes("--apply");

async function main() {
  if (!ENTITY_CODE) {
    console.error("Usage: tsx scripts/suppress-stay-start-duplicates.ts --entityCode=XXXX [--hours=8] [--apply]");
    process.exit(1);
  }
  if (!Number.isFinite(HOURS) || HOURS <= 0) {
    console.error("--hours doit être un nombre positif");
    process.exit(1);
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

  const now = new Date();
  const cutoff = new Date(now.getTime() + HOURS * 3_600_000);
  const atRiskBookings = await prisma.booking.findMany({
    where: { entityId: entity.id, startDate: { gte: now, lte: cutoff } },
    select: { id: true, code: true, personEmail: true, startDate: true },
    orderBy: { startDate: "asc" },
  });

  console.log(`${ENTITY_CODE} — ${rules.length} règle(s) "Début de séjour" active(s), ${atRiskBookings.length} résa(s) arrivant dans les ${HOURS}h (déjà notifiées côté ancienne app H-${HOURS}) :`);
  for (const b of atRiskBookings) {
    console.log(`  - ${b.code} · ${b.personEmail || "(pas d'email)"} · arrivée ${b.startDate.toLocaleString("fr-FR")}`);
  }

  if (!atRiskBookings.length) {
    console.log("Rien à supprimer.");
    return;
  }

  const rows = rules.flatMap((rule) =>
    atRiskBookings.map((b) => ({ ruleId: rule.id, targetType: "booking", targetId: b.id }))
  );

  if (!APPLY) {
    console.log(`\n${rows.length} ligne(s) AutomationRuleLog seraient créées (${rules.length} règle(s) × ${atRiskBookings.length} résa(s)). Relancer avec --apply pour écrire réellement.`);
    return;
  }

  const result = await prisma.automationRuleLog.createMany({ data: rows, skipDuplicates: true });
  console.log(`\n✓ ${result.count} ligne(s) créées — ces résas ne recevront pas le mail de check-in Sesame (déjà couvertes par l'ancienne app).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
