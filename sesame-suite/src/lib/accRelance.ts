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
 * Relance groupée — une seule facture, même comportement qu'avant
 * (sendRelanceForInvoice). Plusieurs factures d'UN MÊME tiers (client ou
 * fournisseur, selon direction) : un seul email couvrant toutes ses
 * factures en retard sélectionnées, plutôt qu'un email par facture (demande
 * client 22/10/2026, "relancer une facture ou plusieurs factures à un
 * client"). Des factures de tiers différents dans la sélection donnent donc
 * plusieurs emails (un par tiers), jamais un mélange dans le même message.
 * Variables numero/montant/echeance restent celles de la PREMIÈRE facture du
 * groupe (compat ascendante des modèles existants) ; nombreFactures/
 * montantTotal/listeFactures s'ajoutent pour le cas multi-factures.
 * Uniquement pour l'envoi manuel (routes/accounting.ts /acc/invoices/
 * relance) — le balayage automatique quotidien (runRelanceRule) garde une
 * relance par facture, un jour de retard différent par facture n'ayant pas
 * de notion naturelle de "groupe" cohérent.
 */
export async function sendRelanceGroupedByClient(
  entityId: string | null,
  invoiceIds: string[],
  templateKey: string,
  attachInvoice: boolean
): Promise<RelanceBatchSummary> {
  const invoices = await prisma.accInvoice.findMany({
    where: { id: { in: invoiceIds }, entityId },
    include: { supplier: true, customer: true, document: { select: { contentBase64: true, mimeType: true, originalFilename: true } } },
  });

  const groups = new Map<string, InvoiceWithParties[]>();
  for (const inv of invoices) {
    const tiersEmail = inv.direction === "sale" ? inv.customer?.email : inv.supplier?.email;
    const key = `${inv.direction}|${tiersEmail || inv.id}`; // sans email commun, chaque facture reste son propre groupe (échouera comme avant, faute d'email)
    const list = groups.get(key) || [];
    list.push(inv);
    groups.set(key, list);
  }

  const results: RelanceResult[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      results.push(await sendRelanceForInvoice(group[0], templateKey, attachInvoice));
      continue;
    }
    results.push(...(await sendRelanceForInvoiceGroup(group, templateKey, attachInvoice)));
  }
  const successCount = results.filter((r) => r.ok).length;
  return { results, successCount, failureCount: results.length - successCount };
}

async function sendRelanceForInvoiceGroup(
  group: InvoiceWithParties[],
  templateKey: string,
  attachInvoice: boolean
): Promise<RelanceResult[]> {
  const relancable = group.filter(isRelancable);
  const skipped = group.filter((inv) => !isRelancable(inv)).map((inv) => ({ invoiceId: inv.id, ok: false, error: "Facture déjà soldée ou pas encore comptabilisée" }));
  if (!relancable.length) return skipped;

  const first = relancable[0];
  const tiersName = first.direction === "sale" ? first.customer?.name || first.recipientName : first.supplier?.name || first.issuerName;
  const tiersEmail = first.direction === "sale" ? first.customer?.email : first.supplier?.email;
  if (!tiersEmail) {
    return [...skipped, ...relancable.map((inv) => ({ invoiceId: inv.id, ok: false, error: `Aucun email pour ${inv.direction === "sale" ? "le client" : "le fournisseur"} rapproché` }))];
  }

  const montantTotal = relancable.reduce((sum, inv) => sum + remainingDue(inv), 0);
  const fmtEUR = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  const listeFactures = relancable
    .map((inv) => `${inv.invoiceNumber || "(sans n°)"} — ${fmtEUR(remainingDue(inv))}${inv.dueDate ? " — échéance " + new Date(inv.dueDate).toLocaleDateString("fr-FR") : ""}`)
    .join("\n");

  try {
    await sendMessage({
      entityId: first.entityId,
      channel: "email",
      templateKey,
      to: tiersEmail,
      variables: {
        numero: first.invoiceNumber || "",
        tiers: tiersName || "",
        montant: fmtEUR(remainingDue(first)),
        echeance: first.dueDate ? new Date(first.dueDate).toLocaleDateString("fr-FR") : "",
        nombreFactures: String(relancable.length),
        montantTotal: fmtEUR(montantTotal),
        listeFactures,
      },
      extraAttachments: attachInvoice
        ? relancable.filter((inv) => inv.document).map((inv) => ({ fileName: inv.document!.originalFilename, dataUrl: `data:${inv.document!.mimeType};base64,${inv.document!.contentBase64}` }))
        : undefined,
    });
    return [...skipped, ...relancable.map((inv) => ({ invoiceId: inv.id, ok: true }))];
  } catch (e) {
    const error = e instanceof Error ? e.message : "Erreur d'envoi";
    return [...skipped, ...relancable.map((inv) => ({ invoiceId: inv.id, ok: false, error }))];
  }
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
