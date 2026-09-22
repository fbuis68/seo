import { prisma } from "../db";
import { CheckResult } from "./accChecks";

/**
 * Détection de doublon FONCTIONNEL (§67) — distincte du doublon de FICHIER
 * (lib/accDocument.ts, hash SHA-256 sur les octets bruts, déjà géré en
 * amont dans accPipeline.ts). Une même facture reçue deux fois par des
 * canaux différents (PDF joint à un email puis redéposée à la main, ou
 * réenvoyée par le fournisseur avec une compression différente) a un hash
 * différent mais reste la même facture — non détectée par le hash seul.
 *
 * Deux signaux, ni l'un ni l'autre suffisant seul pour bloquer (toujours
 * WARNING, jamais BLOCKING — un même numéro de facture réutilisé par erreur
 * par un fournisseur, ou une coïncidence de montant, existe réellement ;
 * seule une validation humaine explicite tranche, cf. §51) :
 *
 * - "invoice_number" : même tiers rapproché + même numéro de facture.
 * - "amount_date_supplier" : même tiers rapproché + même montant TTC (± 1
 *   centime) + même date de facture (jour exact).
 *
 * Les deux exigent un tiers déjà rapproché (supplierId/customerId non nul)
 * — sans lui, comparer un simple numéro ou montant produirait trop de faux
 * positifs (numérotations génériques partagées entre fournisseurs sans
 * rapport).
 */

const AMOUNT_TOLERANCE = 0.02;

export interface DuplicateMatch {
  invoiceId: string;
  documentId: string;
  invoiceNumber: string | null;
  reason: "invoice_number" | "amount_date_supplier";
}

export interface FindDuplicatesInput {
  direction: "purchase" | "sale";
  supplierId: string | null;
  customerId: string | null;
  invoiceNumber: string | null;
  amountTtc: number | null;
  invoiceDate: Date | null;
}

export async function findDuplicateInvoices(entityId: string | null, input: FindDuplicatesInput): Promise<DuplicateMatch[]> {
  const tiersId = input.direction === "purchase" ? input.supplierId : input.customerId;
  if (!tiersId) return [];

  const tiersWhere = input.direction === "purchase" ? { supplierId: tiersId } : { customerId: tiersId };
  const matches: DuplicateMatch[] = [];
  const seenInvoiceIds = new Set<string>();

  if (input.invoiceNumber && input.invoiceNumber.trim()) {
    const byNumber = await prisma.accInvoice.findMany({
      where: { entityId, direction: input.direction, ...tiersWhere, invoiceNumber: { equals: input.invoiceNumber.trim(), mode: "insensitive" } },
      select: { id: true, documentId: true, invoiceNumber: true },
      take: 5,
    });
    for (const m of byNumber) {
      matches.push({ invoiceId: m.id, documentId: m.documentId, invoiceNumber: m.invoiceNumber, reason: "invoice_number" });
      seenInvoiceIds.add(m.id);
    }
  }

  if (input.amountTtc !== null && input.invoiceDate) {
    const dayStart = new Date(Date.UTC(input.invoiceDate.getUTCFullYear(), input.invoiceDate.getUTCMonth(), input.invoiceDate.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const byAmountDate = await prisma.accInvoice.findMany({
      where: {
        entityId, direction: input.direction, ...tiersWhere,
        invoiceDate: { gte: dayStart, lt: dayEnd },
        amountTtc: { gte: input.amountTtc - AMOUNT_TOLERANCE, lte: input.amountTtc + AMOUNT_TOLERANCE },
      },
      select: { id: true, documentId: true, invoiceNumber: true },
      take: 5,
    });
    for (const m of byAmountDate) {
      if (seenInvoiceIds.has(m.id)) continue; // déjà remonté par le numéro — pas la peine de le lever deux fois
      matches.push({ invoiceId: m.id, documentId: m.documentId, invoiceNumber: m.invoiceNumber, reason: "amount_date_supplier" });
      seenInvoiceIds.add(m.id);
    }
  }

  return matches;
}

export function duplicateMatchesToChecks(matches: DuplicateMatch[]): CheckResult[] {
  return matches.map((m) => ({
    code: m.reason === "invoice_number" ? "DUPLICATE_INVOICE_NUMBER" : "DUPLICATE_AMOUNT_DATE_SUPPLIER",
    level: "WARNING",
    message:
      m.reason === "invoice_number"
        ? `Doublon possible — une autre facture du même tiers porte déjà le numéro "${m.invoiceNumber}"`
        : `Doublon possible — une autre facture du même tiers, même montant et même date, existe déjà`,
  }));
}

/** Enregistre chaque appariement pour un suivi/audit ultérieur (AccDuplicateCandidate) — jamais bloquant, purement déclaratif. */
export async function recordDuplicateCandidates(entityId: string | null, documentId: string, matches: DuplicateMatch[]): Promise<void> {
  for (const m of matches) {
    if (m.documentId === documentId) continue; // même document (ne devrait pas arriver, garde-fou)
    await prisma.accDuplicateCandidate.create({
      data: { entityId, documentId, matchedDocumentId: m.documentId, reason: m.reason },
    });
  }
}
