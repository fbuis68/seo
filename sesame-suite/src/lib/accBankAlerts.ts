import { prisma } from "../db";
import { sendEmailRaw } from "./email";

/**
 * Alerte "nouveau mouvement bancaire" (onglet Banque — demande client
 * 12/10/2026) : vérifie les AccBankAlertRule actives de la portée et envoie
 * un email pour chaque transaction NOUVELLEMENT CRÉÉE qui correspond à une
 * règle. Appelé une seule fois, depuis lib/accBanking.ts
 * importBankTransactions — seul point de création de AccBankTransaction
 * (import fichier ET synchronisation Qonto) — avec `createdIds` (jamais les
 * transactions déjà connues simplement mises à jour, cf. le commentaire sur
 * `skipped` dans importBankTransactions) pour ne jamais ré-alerter sur un
 * mouvement déjà vu à un import précédent.
 *
 * Best-effort : une erreur d'envoi (SMTP non configuré, etc.) ne doit jamais
 * faire échouer l'import bancaire lui-même qui a réussi par ailleurs — même
 * principe que pushOrderPmsBestEffort (routes/roomservice.ts).
 */
export async function checkAndSendBankAlerts(entityId: string | null, createdIds: string[]): Promise<void> {
  if (!createdIds.length) return;

  const rules = await prisma.accBankAlertRule.findMany({
    where: { entityId, active: true },
    include: { senderIdentity: true },
  });
  if (!rules.length) return;

  const transactions = await prisma.accBankTransaction.findMany({
    where: { id: { in: createdIds } },
    include: { bankAccount: { select: { name: true } } },
  });

  for (const tx of transactions) {
    const absAmount = Math.abs(tx.amount);
    const matchingRules = rules.filter(
      (r) =>
        (!r.direction || r.direction === tx.direction) &&
        (!r.bankAccountId || r.bankAccountId === tx.bankAccountId) &&
        (r.minAmount == null || absAmount >= r.minAmount)
    );
    if (!matchingRules.length) continue;

    const directionLabel = tx.direction === "CREDIT" ? "Encaissement" : "Décaissement";
    const subject = `${directionLabel} de ${absAmount.toFixed(2)} € — ${tx.bankAccount.name}`;
    const html = `
      <p><b>${directionLabel}</b> sur le compte <b>${tx.bankAccount.name}</b></p>
      <p>Montant : <b>${absAmount.toFixed(2)} €</b><br>
      Date : ${tx.operationDate.toLocaleDateString("fr-FR")}<br>
      Libellé : ${tx.rawLabel}${tx.counterpartyName ? `<br>Contrepartie : ${tx.counterpartyName}` : ""}</p>
    `;

    // Un envoi par règle déclenchée (pas de dédoublonnage par email) : deux
    // règles peuvent viser la même adresse avec un expéditeur différent,
    // chacune reste indépendante.
    for (const rule of matchingRules) {
      const to = rule.notifyEmail.trim();
      if (!to) continue;
      try {
        await sendEmailRaw(entityId, to, subject, html, rule.senderIdentity?.name || undefined, {
          fromEmailOverride: rule.senderIdentity?.email || undefined,
        });
      } catch {
        // best-effort — cf. docstring ci-dessus
      }
    }
  }
}
