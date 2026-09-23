import { prisma } from "../db";
import { sendMessage } from "./messaging";
import { AccInvoice, AccSupplier, AccCustomer, AccDocument } from "@prisma/client";
import { invoiceTotal } from "./accReconciliation";

/**
 * Relance de facture impayée — envoi manuel (routes/accounting.ts,
 * POST /acc/invoices/relance) et automatique (accRelanceScheduler.ts,
 * balayage quotidien des AccRelanceRule) partagent exactement la même
 * logique d'envoi via sendRelanceForInvoice, pour ne jamais diverger sur ce
 * qui constitue une facture "relançable" ou sur le contenu de l'email.
 */

type InvoiceWithParties = AccInvoice & {
  supplier: AccSupplier | null;
  customer: AccCustomer | null;
  document?: Pick<AccDocument, "contentBase64" | "mimeType" | "originalFilename"> | null;
};

export interface RelanceResult {
  invoiceId: string;
  ok: boolean;
  error?: string;
}

/** Solde restant dû — jamais négatif (un trop-perçu ne redevient pas une dette). */
export function remainingDue(invoice: Pick<AccInvoice, "amountTtc" | "amountHt" | "amountPaid">): number {
  return Math.max(0, invoiceTotal(invoice) - invoice.amountPaid);
}

/** Facture éligible à une relance — comptabilisée (ou validée) et pas encore soldée. */
export function isRelancable(invoice: Pick<AccInvoice, "status" | "amountTtc" | "amountHt" | "amountPaid">): boolean {
  return ["VALIDATED", "ACCOUNTED", "PARTIALLY_PAID"].includes(invoice.status) && remainingDue(invoice) > 0.01;
}

export async function sendRelanceForInvoice(
  invoice: InvoiceWithParties,
  templateKey: string,
  attachInvoice: boolean
): Promise<RelanceResult> {
  if (!isRelancable(invoice)) {
    return { invoiceId: invoice.id, ok: false, error: "Facture déjà soldée ou pas encore comptabilisée" };
  }
  const tiersName = invoice.direction === "sale" ? invoice.customer?.name || invoice.recipientName : invoice.supplier?.name || invoice.issuerName;
  const tiersEmail = invoice.direction === "sale" ? invoice.customer?.email : invoice.supplier?.email;
  if (!tiersEmail) {
    return { invoiceId: invoice.id, ok: false, error: `Aucun email pour ${invoice.direction === "sale" ? "le client" : "le fournisseur"} rapproché` };
  }

  try {
    await sendMessage({
      entityId: invoice.entityId,
      channel: "email",
      templateKey,
      to: tiersEmail,
      variables: {
        numero: invoice.invoiceNumber || "",
        tiers: tiersName || "",
        montant: remainingDue(invoice).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €",
        echeance: invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString("fr-FR") : "",
      },
      extraAttachments:
        attachInvoice && invoice.document
          ? [{ fileName: invoice.document.originalFilename, dataUrl: `data:${invoice.document.mimeType};base64,${invoice.document.contentBase64}` }]
          : undefined,
    });
    return { invoiceId: invoice.id, ok: true };
  } catch (e) {
    return { invoiceId: invoice.id, ok: false, error: e instanceof Error ? e.message : "Erreur d'envoi" };
  }
}

export interface RelanceBatchSummary {
  results: RelanceResult[];
  successCount: number;
  failureCount: number;
}

export async function sendRelanceBatch(entityId: string | null, invoiceIds: string[], templateKey: string, attachInvoice: boolean): Promise<RelanceBatchSummary> {
  const invoices = await prisma.accInvoice.findMany({
    where: { id: { in: invoiceIds }, entityId },
    include: { supplier: true, customer: true, document: { select: { contentBase64: true, mimeType: true, originalFilename: true } } },
  });
  const results: RelanceResult[] = [];
  for (const inv of invoices) {
    results.push(await sendRelanceForInvoice(inv, templateKey, attachInvoice));
  }
  const successCount = results.filter((r) => r.ok).length;
  return { results, successCount, failureCount: results.length - successCount };
}

/**
 * Balaie une règle de relance automatique — envoie pour chaque facture
 * éligible dont (basisDate + offsetDays) <= aujourd'hui ET jamais encore
 * relancée par CETTE règle (AccRelanceSent). Le "<=" plutôt qu'une
 * correspondance exacte du jour J rend le balayage auto-réparant : un
 * passage manqué (serveur arrêté un jour) rattrape la relance au prochain
 * passage au lieu de la perdre silencieusement — jamais de relance en
 * double pour la même facture sur la même règle (contrainte unique
 * AccRelanceSent, vérifiée ici en mémoire ET protégée en base).
 */
export async function runRelanceRule(ruleId: string): Promise<RelanceBatchSummary> {
  const rule = await prisma.accRelanceRule.findUnique({ where: { id: ruleId } });
  if (!rule || !rule.active) return { results: [], successCount: 0, failureCount: 0 };

  const todayMidnightUtc = new Date();
  todayMidnightUtc.setUTCHours(0, 0, 0, 0);
  const cutoff = new Date(todayMidnightUtc.getTime() - rule.offsetDays * 86400000);
  // Borne haute exclusive du jour de cutoff — une facture dont basisDate
  // tombe CE jour-là doit rester éligible (basisDate <= cutoff, pas <
  // cutoff), d'où +1 jour sur la borne pour inclure toute la journée.
  const cutoffEnd = new Date(cutoff.getTime() + 86400000);

  const dateFilter = { not: null, lt: cutoffEnd };
  const invoices = await prisma.accInvoice.findMany({
    where: {
      entityId: rule.entityId,
      status: { in: ["VALIDATED", "ACCOUNTED", "PARTIALLY_PAID"] },
      ...(rule.direction ? { direction: rule.direction } : {}),
      ...(rule.basis === "invoiceDate" ? { invoiceDate: dateFilter } : { dueDate: dateFilter }),
      relanceSentLogs: { none: { ruleId: rule.id } },
    },
    include: { supplier: true, customer: true, document: { select: { contentBase64: true, mimeType: true, originalFilename: true } } },
  });

  const results: RelanceResult[] = [];
  for (const inv of invoices) {
    const result = await sendRelanceForInvoice(inv, rule.templateKey, rule.attachInvoice);
    results.push(result);
    // Enregistré même en échec (email manquant, déjà soldée...) — sinon un
    // échec permanent (ex : pas d'email tiers) serait retenté à l'infini
    // chaque jour sans jamais pouvoir réussir. Un échec transitoire (SMTP
    // temporairement indisponible) devra être relancé manuellement ou via
    // une nouvelle règle plutôt que par un retry automatique silencieux.
    await prisma.accRelanceSent.create({ data: { ruleId: rule.id, invoiceId: inv.id } }).catch(() => {});
  }
  const successCount = results.filter((r) => r.ok).length;
  return { results, successCount, failureCount: results.length - successCount };
}
