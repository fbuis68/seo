import { prisma } from "../db";
import { CheckResult } from "./accChecks";
import { normalizeCompanyName } from "./accSupplierMatching";

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
 * Les deux préfèrent un tiers déjà rapproché (supplierId/customerId non nul)
 * — sans lui, comparer un simple numéro ou montant produirait trop de faux
 * positifs (numérotations génériques partagées entre fournisseurs sans
 * rapport). Repli sans tiers rapproché (durci le 24/09/2026, cf.
 * findDuplicatesForUnmatchedTiers ci-dessous) : sans lui, la détection était
 * totalement désactivée (if (!tiersId) return []), laissant passer en
 * silence un vrai doublon dont le rapprochement fournisseur avait raté à la
 * 2e importation — cas réel observé ("LE PATIO BADUEL", même n° facture,
 * une occurrence comptabilisée avec tiers rapproché, l'autre encore
 * "Extraite" sans tiers).
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
  // Nom brut extrait du document (issuerName en achat, recipientName en
  // vente) — utilisé uniquement en repli quand supplierId/customerId est nul
  // (cf. findDuplicatesForUnmatchedTiers).
  tiersName: string | null;
  invoiceNumber: string | null;
  amountTtc: number | null;
  invoiceDate: Date | null;
}

export async function findDuplicateInvoices(entityId: string | null, input: FindDuplicatesInput): Promise<DuplicateMatch[]> {
  const tiersId = input.direction === "purchase" ? input.supplierId : input.customerId;
  if (tiersId) return findDuplicatesForMatchedTiers(entityId, input, tiersId);
  return findDuplicatesForUnmatchedTiers(entityId, input);
}

async function findDuplicatesForMatchedTiers(entityId: string | null, input: FindDuplicatesInput, tiersId: string): Promise<DuplicateMatch[]> {
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

/**
 * Repli sans tiers rapproché (§67, durci le 24/09/2026) — compare le nom
 * brut du tiers normalisé (accents/forme juridique/casse retirés, cf.
 * accSupplierMatching.normalizeCompanyName) contre TOUTES les factures du
 * même sens, y compris celles déjà rapprochées à un tiers (un même émetteur
 * peut apparaître une fois matché et une fois non, cf. cas réel "LE PATIO
 * BADUEL" en commentaire plus haut). Signal plus faible qu'un tiers
 * rapproché (un nom seul peut coïncider) — reste un WARNING, jamais
 * bloquant, comme le chemin normal.
 */
async function findDuplicatesForUnmatchedTiers(entityId: string | null, input: FindDuplicatesInput): Promise<DuplicateMatch[]> {
  const name = input.tiersName ? normalizeCompanyName(input.tiersName) : "";
  if (!name) return [];

  const candidateWhere: object[] = [];
  const hasInvoiceNumber = !!(input.invoiceNumber && input.invoiceNumber.trim());
  if (hasInvoiceNumber) {
    candidateWhere.push({ invoiceNumber: { equals: input.invoiceNumber!.trim(), mode: "insensitive" } });
  }
  let dayStart: Date | null = null;
  let dayEnd: Date | null = null;
  if (input.amountTtc !== null && input.invoiceDate) {
    dayStart = new Date(Date.UTC(input.invoiceDate.getUTCFullYear(), input.invoiceDate.getUTCMonth(), input.invoiceDate.getUTCDate()));
    dayEnd = new Date(dayStart.getTime() + 86400000);
    candidateWhere.push({
      invoiceDate: { gte: dayStart, lt: dayEnd },
      amountTtc: { gte: input.amountTtc - AMOUNT_TOLERANCE, lte: input.amountTtc + AMOUNT_TOLERANCE },
    });
  }
  if (!candidateWhere.length) return [];

  const candidates = await prisma.accInvoice.findMany({
    where: { entityId, direction: input.direction, OR: candidateWhere },
    select: { id: true, documentId: true, invoiceNumber: true, issuerName: true, recipientName: true, amountTtc: true },
    take: 20,
  });

  const matches: DuplicateMatch[] = [];
  const seenInvoiceIds = new Set<string>();
  for (const c of candidates) {
    const candidateName = input.direction === "purchase" ? c.issuerName : c.recipientName;
    if (!candidateName || normalizeCompanyName(candidateName) !== name) continue;

    if (hasInvoiceNumber && c.invoiceNumber && c.invoiceNumber.trim().toLowerCase() === input.invoiceNumber!.trim().toLowerCase()) {
      matches.push({ invoiceId: c.id, documentId: c.documentId, invoiceNumber: c.invoiceNumber, reason: "invoice_number" });
      seenInvoiceIds.add(c.id);
      continue;
    }
    if (!seenInvoiceIds.has(c.id) && dayStart && input.amountTtc !== null && c.amountTtc !== null && Math.abs(c.amountTtc - input.amountTtc) <= AMOUNT_TOLERANCE) {
      matches.push({ invoiceId: c.id, documentId: c.documentId, invoiceNumber: c.invoiceNumber, reason: "amount_date_supplier" });
      seenInvoiceIds.add(c.id);
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
