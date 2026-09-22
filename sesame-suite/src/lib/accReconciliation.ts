import { prisma } from "../db";
import { AccBankTransaction, AccInvoice, AccSupplier, AccCustomer } from "@prisma/client";
import { validateEntry } from "./accEntryService";

/**
 * Moteur de rapprochement bancaire (phase 3 du cahier des charges Banque et
 * TVA) — associe une transaction bancaire importée (accBanking.ts/qonto.ts)
 * à une ou plusieurs factures ouvertes via un score de confiance
 * (montant/référence/IBAN/tiers/date), avec auto-confirmation au-dessus
 * d'un seuil et proposition de candidats pour validation manuelle en
 * dessous. Ne génère PAS d'écriture comptable ni de lettrage
 * (AccEntryLine.auxiliaryRef) — hors périmètre de cette passe, cf.
 * discussion avec l'utilisateur : le cœur du matching d'abord.
 */

export class ReconciliationError extends Error {}

// Score >= AUTO_THRESHOLD ET aucun autre candidat à moins de
// AUTO_AMBIGUITY_MARGIN points du premier : confirmation automatique.
// En dessous, la transaction reste IMPORTED avec des candidats proposés
// pour confirmation manuelle (findCandidates), jamais de faux positif
// silencieux sur de l'argent réel.
const AUTO_THRESHOLD = 95;
const AUTO_AMBIGUITY_MARGIN = 5;
const AMOUNT_EPSILON = 0.01;

function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeRef(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Chevauchement de tokens (mots de 3+ caractères) entre deux textes normalisés, 0..1. */
function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(normalizeText(a).split(" ").filter((t) => t.length >= 3));
  const tokensB = new Set(normalizeText(b).split(" ").filter((t) => t.length >= 3));
  if (!tokensA.size || !tokensB.size) return 0;
  let common = 0;
  for (const t of tokensA) if (tokensB.has(t)) common++;
  return common / Math.min(tokensA.size, tokensB.size);
}

interface PartyInfo {
  name: string;
  iban: string | null;
}

async function partyForInvoice(inv: AccInvoice): Promise<PartyInfo | null> {
  if (inv.direction === "purchase" && inv.supplierId) {
    const s = await prisma.accSupplier.findUnique({ where: { id: inv.supplierId } });
    return s ? { name: s.name, iban: s.iban } : null;
  }
  if (inv.direction === "sale" && inv.customerId) {
    const c = await prisma.accCustomer.findUnique({ where: { id: inv.customerId } });
    return c ? { name: c.name, iban: null } : null;
  }
  return null;
}

export interface ScoredCandidate {
  invoice: AccInvoice & { supplier: AccSupplier | null; customer: AccCustomer | null };
  score: number;
  remainingDue: number;
  reasons: string[];
}

/**
 * Score 0-100 d'une paire (transaction, facture) — cf. constantes ci-dessus
 * pour la pondération. Chaque composante est plafonnée individuellement, la
 * somme peut atteindre 100 mais jamais le dépasser.
 */
function scoreCandidate(tx: AccBankTransaction, invoice: AccInvoice, party: PartyInfo | null, remainingDue: number): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const txAmount = Math.abs(tx.amount);

  // Montant (40 pts) — exact (± centime) = plein, sinon décroît linéairement
  // jusqu'à 0 au-delà de 30% d'écart relatif.
  const amountDiff = Math.abs(remainingDue - txAmount);
  if (amountDiff <= AMOUNT_EPSILON) {
    score += 40;
    reasons.push("montant exact");
  } else if (remainingDue > 0) {
    const ratio = amountDiff / remainingDue;
    if (ratio < 0.3) {
      const partial = 40 * (1 - ratio / 0.3);
      score += partial;
      reasons.push(`montant proche (écart ${amountDiff.toFixed(2)}€)`);
    }
  }

  // Référence (25 pts) — n° de facture retrouvé dans le libellé/référence/
  // EndToEndId de la transaction, comparaison sur caractères alphanumériques
  // seuls (les banques reformattent souvent la ponctuation).
  if (invoice.invoiceNumber) {
    const ref = normalizeRef(invoice.invoiceNumber);
    if (ref.length >= 3) {
      const haystacks = [tx.rawLabel, tx.transactionRef, tx.endToEndId, tx.creditorRef].filter(Boolean).map((s) => normalizeRef(s as string));
      if (haystacks.some((h) => h.includes(ref))) {
        score += 25;
        reasons.push("n° facture trouvé dans le libellé/référence");
      }
    }
  }

  // IBAN (15 pts) — uniquement disponible côté fournisseur (AccCustomer n'a
  // pas d'IBAN stocké, cf. schema.prisma).
  if (party?.iban && tx.counterpartyIban && party.iban.replace(/\s/g, "").toUpperCase() === tx.counterpartyIban.replace(/\s/g, "").toUpperCase()) {
    score += 15;
    reasons.push("IBAN de contrepartie identique");
  }

  // Tiers (15 pts) — chevauchement de mots entre le nom du tiers rapproché
  // (ou la raison sociale extraite à défaut) et le libellé/contrepartie de
  // la transaction.
  const partyName = party?.name || invoice.issuerName || invoice.recipientName || "";
  if (partyName) {
    const overlap = Math.max(
      tokenOverlap(partyName, tx.counterpartyName || ""),
      tokenOverlap(partyName, tx.rawLabel)
    );
    if (overlap > 0) {
      score += 15 * overlap;
      if (overlap >= 0.5) reasons.push("nom du tiers reconnu");
    }
  }

  // Date (5 pts) — proximité entre la date d'échéance (ou de facture à
  // défaut) et la date de l'opération bancaire.
  const refDate = invoice.dueDate || invoice.invoiceDate;
  if (refDate) {
    const days = Math.abs((tx.operationDate.getTime() - refDate.getTime()) / 86400000);
    if (days <= 3) score += 5;
    else if (days <= 15) score += 3;
    else if (days <= 45) score += 1;
  }

  return { score: Math.min(100, Math.round(score * 10) / 10), reasons };
}

/**
 * Candidats de rapprochement pour une transaction, triés par score
 * décroissant — factures ouvertes (VALIDATED/ACCOUNTED/PARTIALLY_PAID) du
 * même sens (achat pour un débit, vente pour un crédit), même devise si les
 * deux sont renseignées, avec un solde dû restant. VALIDATED (écriture
 * DRAFT générée mais pas encore numérotée — cf. §44/validateEntry) est
 * inclus délibérément : le paiement bancaire réel est le déclencheur le
 * plus fiable pour finaliser une écriture, pas une raison de la rendre
 * invisible au rapprochement en attendant une seconde validation manuelle
 * séparée (confirmMatch valide l'écriture automatiquement le cas échéant).
 */
/**
 * includeZeroScore=true sert au repli "lister TOUTES les factures ouvertes"
 * (routes.ts, ?all=1) — le score à 0 ne signifie pas "aucun rapport", juste
 * qu'aucun des éléments pondérés n'a matché ; l'utilisateur doit pouvoir
 * quand même la choisir à la main (référence absente du libellé bancaire,
 * tiers pas encore rapproché...), pas seulement les candidats déjà
 * ressemblants.
 */
export async function findCandidates(bankTransactionId: string, limit = 15, includeZeroScore = false): Promise<ScoredCandidate[]> {
  const tx = await prisma.accBankTransaction.findUnique({ where: { id: bankTransactionId } });
  if (!tx) throw new ReconciliationError("Transaction bancaire introuvable");

  const direction = tx.amount >= 0 ? "sale" : "purchase";
  const invoices = await prisma.accInvoice.findMany({
    where: {
      entityId: tx.entityId,
      direction,
      status: { in: ["VALIDATED", "ACCOUNTED", "PARTIALLY_PAID"] },
      ...(tx.currency ? { OR: [{ currency: tx.currency }, { currency: null }] } : {}),
    },
    include: { supplier: true, customer: true },
  });

  const candidates: ScoredCandidate[] = [];
  for (const inv of invoices) {
    const remainingDue = (inv.amountTtc || 0) - inv.amountPaid;
    if (remainingDue <= AMOUNT_EPSILON) continue;
    const party = await partyForInvoice(inv);
    const { score, reasons } = scoreCandidate(tx, inv, party, remainingDue);
    if (score <= 0 && !includeZeroScore) continue;
    candidates.push({ invoice: inv, score, remainingDue, reasons });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

function invoiceStatusForAmountPaid(amountTtc: number, amountPaid: number): "ACCOUNTED" | "PARTIALLY_PAID" | "PAID" {
  if (amountPaid >= amountTtc - AMOUNT_EPSILON) return "PAID";
  if (amountPaid > AMOUNT_EPSILON) return "PARTIALLY_PAID";
  return "ACCOUNTED";
}

export interface ConfirmMatchResult {
  match: { id: string; allocatedAmount: number; score: number | null; type: string };
  invoiceStatus: string;
  transactionFullyMatched: boolean;
}

/**
 * Confirme un rapprochement (manuel ou automatique) — crée AccBankMatch,
 * met à jour AccInvoice.amountPaid/status et AccBankTransaction.status.
 * Rejette toute allocation qui dépasserait le solde dû de la facture ou la
 * capacité restante de la transaction (paiement groupé : plusieurs
 * factures sur une même transaction, chacune bornée par son propre reste dû
 * et par ce qui reste disponible sur la transaction).
 */
export async function confirmMatch(
  bankTransactionId: string,
  invoiceId: string,
  allocatedAmount: number,
  type: "auto" | "manual",
  createdBy: string | null,
  score: number | null,
): Promise<ConfirmMatchResult> {
  if (allocatedAmount <= 0) throw new ReconciliationError("Montant alloué invalide");

  const tx = await prisma.accBankTransaction.findUnique({ where: { id: bankTransactionId }, include: { matches: true } });
  if (!tx) throw new ReconciliationError("Transaction bancaire introuvable");
  let invoice = await prisma.accInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new ReconciliationError("Facture introuvable");

  // Facture encore VALIDATED (écriture DRAFT générée, pas encore numérotée)
  // — le paiement bancaire confirmé est le déclencheur le plus fiable pour
  // finaliser cette écriture plutôt que d'exiger une validation manuelle
  // séparée dans l'onglet Écritures avant de pouvoir rapprocher (cf.
  // findCandidates). Bascule automatiquement en ACCOUNTED (ou PAID si
  // règlement par prélèvement — cf. validateEntry) juste avant l'allocation.
  if (invoice.status === "VALIDATED" && invoice.entryId) {
    await validateEntry(invoice.entryId, createdBy);
    invoice = await prisma.accInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new ReconciliationError("Facture introuvable");
  }

  if (!["ACCOUNTED", "PARTIALLY_PAID"].includes(invoice.status)) {
    throw new ReconciliationError("Seule une facture comptabilisée et non soldée peut être rapprochée");
  }
  const expectedDirection = tx.amount >= 0 ? "sale" : "purchase";
  if (invoice.direction !== expectedDirection) {
    throw new ReconciliationError(`Une transaction ${tx.amount >= 0 ? "créditrice" : "débitrice"} ne peut être rapprochée qu'à une facture de ${expectedDirection === "sale" ? "vente" : "achat"}`);
  }

  const alreadyAllocatedOnTx = tx.matches.reduce((s, m) => s + m.allocatedAmount, 0);
  const txCapacity = Math.abs(tx.amount) - alreadyAllocatedOnTx;
  if (allocatedAmount > txCapacity + AMOUNT_EPSILON) {
    throw new ReconciliationError(`Montant alloué (${allocatedAmount.toFixed(2)}€) supérieur au reste disponible sur la transaction (${txCapacity.toFixed(2)}€)`);
  }
  const remainingDue = (invoice.amountTtc || 0) - invoice.amountPaid;
  if (allocatedAmount > remainingDue + AMOUNT_EPSILON) {
    throw new ReconciliationError(`Montant alloué (${allocatedAmount.toFixed(2)}€) supérieur au solde dû de la facture (${remainingDue.toFixed(2)}€)`);
  }

  const match = await prisma.$transaction(async (px) => {
    const created = await px.accBankMatch.create({
      data: { entityId: tx.entityId, bankTransactionId, invoiceId, allocatedAmount, score, type, createdBy },
    });
    const newAmountPaid = invoice.amountPaid + allocatedAmount;
    await px.accInvoice.update({
      where: { id: invoiceId },
      data: { amountPaid: newAmountPaid, status: invoiceStatusForAmountPaid(invoice.amountTtc || 0, newAmountPaid) },
    });
    const newTxAllocated = alreadyAllocatedOnTx + allocatedAmount;
    const fullyMatched = newTxAllocated >= Math.abs(tx.amount) - AMOUNT_EPSILON;
    if (fullyMatched) {
      await px.accBankTransaction.update({ where: { id: bankTransactionId }, data: { status: "MATCHED" } });
    }
    return created;
  });

  const updatedInvoice = await prisma.accInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const newTxAllocated = alreadyAllocatedOnTx + allocatedAmount;
  return {
    match: { id: match.id, allocatedAmount: match.allocatedAmount, score: match.score, type: match.type },
    invoiceStatus: updatedInvoice.status,
    transactionFullyMatched: newTxAllocated >= Math.abs(tx.amount) - AMOUNT_EPSILON,
  };
}

/** Annule un rapprochement — remet la facture et la transaction dans l'état d'avant ce match précis. */
export async function unmatch(matchId: string): Promise<void> {
  const match = await prisma.accBankMatch.findUnique({ where: { id: matchId } });
  if (!match) throw new ReconciliationError("Rapprochement introuvable");
  const invoice = await prisma.accInvoice.findUnique({ where: { id: match.invoiceId } });
  if (!invoice) throw new ReconciliationError("Facture introuvable");

  await prisma.$transaction(async (px) => {
    await px.accBankMatch.delete({ where: { id: matchId } });
    const newAmountPaid = Math.max(0, invoice.amountPaid - match.allocatedAmount);
    // Ne redescend jamais en dessous d'ACCOUNTED : un désrapprochement ne
    // doit pas faire perdre le statut "comptabilisée" lui-même, seul
    // l'indicateur de règlement change.
    const status = invoiceStatusForAmountPaid(invoice.amountTtc || 0, newAmountPaid);
    await px.accInvoice.update({ where: { id: invoice.id }, data: { amountPaid: newAmountPaid, status } });
    await px.accBankTransaction.update({ where: { id: match.bankTransactionId }, data: { status: "IMPORTED" } });
  });
}

export interface AutoReconcileResult {
  matched: boolean;
  invoiceId?: string;
  score?: number;
}

/**
 * Tente un rapprochement automatique — n'agit que si le meilleur candidat
 * dépasse AUTO_THRESHOLD ET n'est pas ambigu (deuxième candidat trop
 * proche) ET couvre exactement le reste dû de la facture (les paiements
 * partiels/groupés restent toujours manuels, trop risqués à deviner).
 */
export async function autoReconcileTransaction(bankTransactionId: string): Promise<AutoReconcileResult> {
  const tx = await prisma.accBankTransaction.findUnique({ where: { id: bankTransactionId }, include: { matches: true } });
  if (!tx || tx.status === "MATCHED" || tx.status === "IGNORED" || tx.status === "INTERNAL_TRANSFER") return { matched: false };
  const alreadyAllocated = tx.matches.reduce((s, m) => s + m.allocatedAmount, 0);
  if (alreadyAllocated > AMOUNT_EPSILON) return { matched: false }; // déjà partiellement traité, laisser à la main de l'utilisateur

  const candidates = await findCandidates(bankTransactionId, 3);
  if (!candidates.length) return { matched: false };
  const top = candidates[0];
  if (top.score < AUTO_THRESHOLD) return { matched: false };
  if (candidates[1] && top.score - candidates[1].score < AUTO_AMBIGUITY_MARGIN) return { matched: false };
  if (Math.abs(top.remainingDue - Math.abs(tx.amount)) > AMOUNT_EPSILON) return { matched: false };

  await confirmMatch(bankTransactionId, top.invoice.id, Math.abs(tx.amount), "auto", null, top.score);
  return { matched: true, invoiceId: top.invoice.id, score: top.score };
}

/** Lance le rapprochement automatique sur une liste de transactions (typiquement les nouvelles issues d'un import) — jamais bloquant pour l'import lui-même, chaque échec est isolé. */
export async function autoReconcileMany(bankTransactionIds: string[]): Promise<{ matchedCount: number }> {
  let matchedCount = 0;
  for (const id of bankTransactionIds) {
    try {
      const result = await autoReconcileTransaction(id);
      if (result.matched) matchedCount++;
    } catch (e) {
      console.error(`[accReconciliation] auto-reconcile failed for ${id}:`, e);
    }
  }
  return { matchedCount };
}
