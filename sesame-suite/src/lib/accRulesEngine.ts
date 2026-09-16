import { prisma } from "../db";

/**
 * Moteur de proposition de compte comptable (§17/§18/§40) — ordre de
 * priorité :
 *   1. Règle explicite liée au fournisseur rapproché (la plus fiable —
 *      créée à la main ou apprise, cf. learnRuleFromCorrection ci-dessous) ;
 *   2. Compte par défaut de la fiche fournisseur (AccSupplier.defaultAccountId) ;
 *   3. Règle par mot-clé (pas de fournisseur rapproché, ou fournisseur sans
 *      règle propre — recherche dans la description/le nom émetteur) ;
 *   4. Historique — majorité des N dernières factures COMPTABILISÉES de ce
 *      fournisseur (§18 : "si les 20 dernières factures OVH ont été
 *      comptabilisées en 626000, proposer 626000") ;
 *   5. Aucune proposition (confidence 0) — jamais de compte inventé.
 */

export interface AccountProposal {
  accountId: string | null;
  confidence: number;
  source: string | null; // rule | supplier_default | keyword_rule | history | null
}

const HISTORY_WINDOW = 20;

export async function proposeAccount(
  entityId: string | null,
  input: { supplierId?: string | null; description?: string | null; issuerName?: string | null }
): Promise<AccountProposal> {
  if (input.supplierId) {
    const rule = await prisma.accRule.findFirst({
      where: { entityId, supplierId: input.supplierId, active: true },
      orderBy: [{ priority: "desc" }, { usageCount: "desc" }],
    });
    if (rule) return { accountId: rule.accountId, confidence: rule.source === "learned" ? 0.9 : 0.97, source: "rule" };

    const supplier = await prisma.accSupplier.findUnique({ where: { id: input.supplierId } });
    if (supplier?.defaultAccountId) return { accountId: supplier.defaultAccountId, confidence: 0.85, source: "supplier_default" };
  }

  const haystack = `${input.description || ""} ${input.issuerName || ""}`.toLowerCase();
  if (haystack.trim()) {
    const keywordRules = await prisma.accRule.findMany({ where: { entityId, keyword: { not: null }, active: true }, orderBy: { priority: "desc" } });
    const match = keywordRules.find((r) => r.keyword && haystack.includes(r.keyword.toLowerCase()));
    if (match) return { accountId: match.accountId, confidence: 0.75, source: "keyword_rule" };
  }

  if (input.supplierId) {
    const recent = await prisma.accInvoice.findMany({
      where: { entityId, supplierId: input.supplierId, status: { in: ["ACCOUNTED", "PARTIALLY_PAID", "PAID"] }, proposedAccountId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: HISTORY_WINDOW,
      select: { proposedAccountId: true },
    });
    if (recent.length >= 3) {
      const counts = new Map<string, number>();
      for (const r of recent) {
        if (!r.proposedAccountId) continue;
        counts.set(r.proposedAccountId, (counts.get(r.proposedAccountId) || 0) + 1);
      }
      const [topAccountId, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
      if (topAccountId) {
        const ratio = topCount / recent.length;
        // Confiance proportionnelle à la régularité historique — jamais
        // au-dessus de 0.9 (une majorité passée n'est jamais une certitude
        // au niveau d'une règle explicite).
        return { accountId: topAccountId, confidence: Math.min(0.9, 0.5 + ratio * 0.4), source: "history" };
      }
    }
  }

  return { accountId: null, confidence: 0, source: null };
}

/**
 * Appelé quand un utilisateur confirme/corrige le compte d'une facture
 * (§18 : "une correction utilisateur doit pouvoir créer ou ajuster une
 * règle"). Crée une règle "learned" si aucune n'existe encore pour ce
 * fournisseur+compte, sinon incrémente son usageCount — jamais deux
 * règles actives concurrentes pour le même fournisseur (la nouvelle
 * désactive l'ancienne si le compte choisi diffère, pour ne pas halluciner
 * une proposition contradictoire au prochain passage).
 */
export async function learnRuleFromCorrection(entityId: string | null, supplierId: string, accountId: string): Promise<void> {
  const existing = await prisma.accRule.findFirst({ where: { entityId, supplierId, active: true } });
  if (existing && existing.accountId === accountId) {
    await prisma.accRule.update({ where: { id: existing.id }, data: { usageCount: { increment: 1 } } });
    return;
  }
  if (existing && existing.accountId !== accountId) {
    await prisma.accRule.update({ where: { id: existing.id }, data: { active: false } });
  }
  await prisma.accRule.create({ data: { entityId, supplierId, accountId, source: "learned", usageCount: 1 } });
}
