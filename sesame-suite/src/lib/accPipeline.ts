import { prisma } from "../db";
import { AccInvoice } from "@prisma/client";
import { ingestDocument } from "./accDocument";
import { extractDocumentText } from "./accOcr";
import { classifyDocument } from "./accClassification";
import { extractInvoiceData, ExtractedInvoiceData } from "./accExtraction";
import { matchSupplier, canAutoCreateSupplier, createSupplierFromExtraction } from "./accSupplierMatching";
import { proposeAccount } from "./accRulesEngine";
import { runInvoiceChecks, worstLevel, CheckResult } from "./accChecks";

export class PipelineError extends Error {}

export interface ProcessResult {
  invoice: AccInvoice;
  isDuplicateDocument: boolean;
}

/**
 * Orchestration du pipeline document → facture (§7) : ingestion/hash/
 * doublon → texte natif (ou signal "OCR image requis") → classification →
 * extraction structurée → rapprochement fournisseur (+ création
 * automatique si un identifiant fort est présent) → proposition de compte
 * → contrôles de cohérence → AccInvoice. Chaque étape peut échouer à
 * produire une donnée (texte absent, aucun champ extrait, aucun
 * fournisseur rapproché...) sans faire échouer le pipeline lui-même :
 * l'AccInvoice résultante porte alors un statut CHECK_REQUIRED plutôt
 * qu'une exception, pour rester visible dans l'inbox de validation (§37)
 * au lieu de disparaître silencieusement.
 */
export async function processUploadedDocument(
  entityId: string | null,
  input: { filename: string; mimeType: string; base64: string; source: string; direction: "purchase" | "sale" }
): Promise<ProcessResult> {
  if (input.direction !== "purchase" && input.direction !== "sale") {
    throw new PipelineError("direction doit être 'purchase' ou 'sale'");
  }

  const { document, isDuplicate } = await ingestDocument(entityId, {
    filename: input.filename,
    mimeType: input.mimeType,
    base64: input.base64,
    source: input.source,
  });

  if (isDuplicate) {
    const existingInvoice = await prisma.accInvoice.findFirst({ where: { documentId: document.id } });
    if (existingInvoice) return { invoice: existingInvoice, isDuplicateDocument: true };
    // Le document existait déjà (même hash) mais aucune facture n'en avait
    // encore été créée (ex : échec en cours de traitement lors d'un appel
    // précédent) — on continue le traitement sur ce même document plutôt
    // que de renvoyer une erreur.
  }

  const buffer = Buffer.from(document.contentBase64, "base64");
  const { result: ocrResult, needsImageOcr } = await extractDocumentText(buffer, document.mimeType);
  const text = ocrResult?.text || "";

  await prisma.accDocument.update({
    where: { id: document.id },
    data: {
      extractedText: text || undefined,
      extractionMethod: ocrResult?.method || undefined,
      extractionConfidence: ocrResult?.confidence ?? undefined,
    },
  });

  const classification = text ? classifyDocument(text) : { documentType: "non_accounting", confidence: 0 };
  const extracted: ExtractedInvoiceData | null = text ? extractInvoiceData(text) : null;

  let supplierId: string | null = null;
  let supplierMatchConfidence: number | null = null;
  // Rapprochement/création côté client (vente) non implémenté en phase 1
  // (schéma AccCustomer prêt, logique de rapprochement pas encore écrite —
  // le périmètre validé pour cette phase est la chaîne achat complète).
  const customerId: string | null = null;

  if (input.direction === "purchase" && extracted) {
    const match = await matchSupplier(entityId, extracted);
    if (match.supplier) {
      supplierId = match.supplier.id;
      supplierMatchConfidence = match.confidence;
    } else if (canAutoCreateSupplier(extracted)) {
      const created = await createSupplierFromExtraction(entityId, extracted);
      supplierId = created.id;
      // Fiche tout juste créée à partir de ces mêmes identifiants forts —
      // rapprochement trivial, pas une simple estimation.
      supplierMatchConfidence = 1.0;
    }
  }

  const accountProposal = await proposeAccount(entityId, {
    supplierId,
    description: classification.documentType,
    issuerName: extracted?.issuerName || null,
  });

  let priorSupplierIbans: string[] = [];
  if (supplierId) {
    const priorInvoices = await prisma.accInvoice.findMany({
      where: { entityId, supplierId, issuerIban: { not: null } },
      select: { issuerIban: true },
      distinct: ["issuerIban"],
      take: 20,
    });
    priorSupplierIbans = priorInvoices.map((p) => p.issuerIban).filter((v): v is string => !!v);
  }

  let checks: CheckResult[];
  if (extracted) {
    checks = runInvoiceChecks(
      {
        invoiceDate: extracted.invoiceDate,
        dueDate: extracted.dueDate,
        amountHt: extracted.amountHt,
        amountVat: extracted.amountVat,
        amountTtc: extracted.amountTtc,
        lines: [],
        vatLines: extracted.vatLines,
        issuerSiren: extracted.issuerSiren,
        issuerSiret: extracted.issuerSiret,
        issuerVat: extracted.issuerVat,
        issuerIban: extracted.issuerIban,
      },
      priorSupplierIbans
    );
  } else {
    checks = [{ code: "NO_TEXT_EXTRACTED", level: needsImageOcr ? "BLOCKING" : "ERROR", message: needsImageOcr ? "Aucune couche texte exploitable — OCR image requis (non disponible dans cette phase)" : "Aucun texte extrait" }];
  }

  let status: string;
  if (needsImageOcr) status = "CHECK_REQUIRED";
  else if (worstLevel(checks) === "BLOCKING" || worstLevel(checks) === "ERROR") status = "CHECK_REQUIRED";
  else if (extracted) status = "EXTRACTED";
  else status = "CHECK_REQUIRED";

  const confidenceValues = extracted ? Object.values(extracted.confidence) : [];
  const globalConfidence = confidenceValues.length ? confidenceValues.reduce((s, c) => s + c, 0) / confidenceValues.length : 0;

  const invoice = await prisma.accInvoice.create({
    data: {
      entityId,
      documentId: document.id,
      direction: input.direction,
      documentType: classification.documentType,
      documentTypeConfidence: classification.confidence,
      status,
      invoiceNumber: extracted?.invoiceNumber || undefined,
      invoiceDate: extracted?.invoiceDate || undefined,
      dueDate: extracted?.dueDate || undefined,
      currency: extracted?.currency || undefined,
      issuerName: extracted?.issuerName || undefined,
      issuerSiren: extracted?.issuerSiren || undefined,
      issuerSiret: extracted?.issuerSiret || undefined,
      issuerVat: extracted?.issuerVat || undefined,
      issuerIban: extracted?.issuerIban || undefined,
      issuerBic: extracted?.issuerBic || undefined,
      supplierId: supplierId || undefined,
      supplierMatchConfidence: supplierMatchConfidence ?? undefined,
      customerId: customerId || undefined,
      amountHt: extracted?.amountHt ?? undefined,
      amountVat: extracted?.amountVat ?? undefined,
      amountTtc: extracted?.amountTtc ?? undefined,
      proposedAccountId: accountProposal.accountId || undefined,
      proposedAccountConfidence: accountProposal.confidence,
      fieldConfidence: extracted ? (extracted.confidence as object) : undefined,
      globalConfidence,
      checks: checks as unknown as object,
      vatLines: extracted?.vatLines.length
        ? { create: extracted.vatLines.map((l) => ({ rate: l.rate, baseAmount: l.baseAmount, vatAmount: l.vatAmount })) }
        : undefined,
    },
  });

  return { invoice, isDuplicateDocument: false };
}
