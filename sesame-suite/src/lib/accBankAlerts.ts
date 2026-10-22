import { prisma } from "../db";
import { fireTrigger } from "./automation";

/**
 * Alerte "nouveau mouvement bancaire" (onglet Banque) — câblée sur le
 * moteur d'automatisation générique (lib/automation.ts, déclencheur
 * "bank.transaction.created") plutôt qu'un système d'alerte dédié : le
 * client configure direction/compte/seuil + modèle + destinataire depuis le
 * panneau Automatisations, comme toute autre règle (12/10/2026, demande
 * client — déplacé depuis un panneau "Alertes" spécifique à l'onglet
 * Banque).
 *
 * Appelé une seule fois, depuis lib/accBanking.ts importBankTransactions —
 * seul point de création de AccBankTransaction (import fichier ET
 * synchronisation Qonto) — avec `createdIds` (jamais les transactions déjà
 * connues simplement mises à jour) pour ne jamais re-déclencher sur un
 * mouvement déjà vu à un import précédent.
 */
export async function checkAndSendBankAlerts(entityId: string | null, createdIds: string[]): Promise<void> {
  if (!createdIds.length) return;

  const transactions = await prisma.accBankTransaction.findMany({
    where: { id: { in: createdIds } },
    include: { bankAccount: { select: { name: true } } },
  });

  for (const tx of transactions) {
    const absAmount = Math.abs(tx.amount);
    const directionLabel = tx.direction === "CREDIT" ? "Encaissement" : "Décaissement";
    await fireTrigger("bank.transaction.created", {
      entityId,
      targetType: "accBankTransaction",
      targetId: tx.id,
      // Pas de client/prospect associé à un mouvement bancaire — toujours
      // recipientMode="custom" côté règle (cf. commentaire sur le
      // déclencheur dans lib/automation.ts).
      recipient: {},
      matchData: { direction: tx.direction, amount: absAmount, bankAccountId: tx.bankAccountId },
      variables: {
        sens: directionLabel,
        montant: absAmount.toFixed(2).replace(".", ",") + " €",
        date: tx.operationDate.toLocaleDateString("fr-FR"),
        libelle: tx.rawLabel,
        compte: tx.bankAccount.name,
        contrepartie: tx.counterpartyName || "",
        // Alias explicite de `contrepartie` (nom du payeur/bénéficiaire
        // fourni par la banque) — demande client 22/10/2026, "des
        // variables sur la partie banque... avec le nom du client et le
        // montant" : `contrepartie` existait déjà mais sans nom évident
        // pour qui ne connaît pas le jargon bancaire. Repli sur le
        // libellé brut si la banque ne fournit aucun nom de contrepartie.
        nomClient: tx.counterpartyName || tx.rawLabel,
      },
    }).catch(() => {});
  }
}
