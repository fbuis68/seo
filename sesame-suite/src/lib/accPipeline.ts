import { prisma } from "../db";
import { AccInvoice } from "@prisma/client";
import { ingestDocument } from "./accDocument";
import { extractDocumentText } from "./accOcr";
import { classifyDocument } from "./accClassification";
import { extractInvoiceData, ExtractedInvoiceData, computeDueDate } from "./accExtraction";
import { matchSupplier, canAutoCreateSupplier, createSupplierFromExtraction } from "./accSupplierMatching";
import { matchCustomer, canAutoCreateCustomer, createCustomerFromExtraction } from "./accCustomerMatching";
import { proposeAccount } from "./accRulesEngine";
import { runInvoiceChecks, worstLevel, CheckResult } from "./accChecks";
import { findDuplicateInvoices, duplicateMatchesToChecks, recordDuplicateCandidates } from "./accDuplicates";

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
  let customerId: string | null = null;
  let customerMatchConfidence: number | null = null;

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
  } else if (input.direction === "sale" && extracted) {
    // Rapprochement côté client — mêmes champs recipient* (bloc
    // "Facturé à"/"Destinataire" de la facture émise par nous), jamais les
    // champs issuer* (qui décrivent notre propre société sur ce type de
    // document, cf. lib/accExtraction.ts).
    const match = await matchCustomer(entityId, extracted);
    if (match.customer) {
      customerId = match.customer.id;
      customerMatchConfidence = match.confidence;
    } else if (canAutoCreateCustomer(extracted)) {
      const created = await createCustomerFromExtraction(entityId, extracted);
      customerId = created.id;
      customerMatchConfidence = 1.0;
    }
  }

  // Nom du tiers utilisé pour le rapprochement par mot-clé (proposeAccount)
  // — celui du fournisseur à l'achat, celui du client à la vente. Utiliser
  // issuerName pour une facture de vente ferait matcher sur NOTRE PROPRE
  // société (nous sommes l'émetteur de ce type de document), jamais utile.
  const tiersNameForRules = input.direction === "sale" ? extracted?.recipientName : extracted?.issuerName;
  const accountProposal = await proposeAccount(entityId, {
    supplierId,
    description: classification.documentType,
    issuerName: tiersNameForRules || null,
  });

  // Échéance non indiquée sur la facture (courant) : calculée depuis le
  // délai de paiement propre au fournisseur si renseigné, sinon le réglage
  // général de la portée (AccSettings) — jamais devinée si invoiceDate
  // lui-même est absent (rien à calculer depuis).
  let computedDueDate: Date | null = null;
  if (extracted && !extracted.dueDate && extracted.invoiceDate) {
    const supplier = supplierId ? await prisma.accSupplier.findUnique({ where: { id: supplierId } }) : null;
    let termDays = supplier?.paymentTermDays ?? null;
    let termMode = supplier?.paymentTermMode ?? null;
    if (termDays == null) {
      // findFirst plutôt que findUnique : le type généré pour un champ
      // unique nullable (entityId) n'accepte pas null en where, alors que
      // c'est justement la valeur recherchée pour la portée CRM/Sesame.
      const settings = await prisma.accSettings.findFirst({ where: { entityId } });
      termDays = settings?.defaultPaymentTermDays ?? 30;
      termMode = settings?.defaultPaymentTermMode ?? "net";
    }
    computedDueDate = computeDueDate(extracted.invoiceDate, termDays, termMode || "net");
  }

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

  // ── Doublon fonctionnel (§67, cf. lib/accDuplicates.ts) — distinct du
  // doublon de fichier déjà géré plus haut (même hash). Toujours WARNING,
  // jamais bloquant : signale sans jamais empêcher la validation humaine.
  const duplicateMatches = await findDuplicateInvoices(entityId, {
    direction: input.direction,
    supplierId,
    customerId,
    tiersName: (input.direction === "purchase" ? extracted?.issuerName : extracted?.recipientName) || null,
    invoiceNumber: extracted?.invoiceNumber || null,
    amountTtc: extracted?.amountTtc ?? null,
    invoiceDate: extracted?.invoiceDate || null,
  });
  checks = checks.concat(duplicateMatchesToChecks(duplicateMatches));
  if (duplicateMatches.length) await recordDuplicateCandidates(entityId, document.id, duplicateMatches);

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
      dueDate: extracted?.dueDate || computedDueDate || undefined,
      currency: extracted?.currency || undefined,
      issuerName: extracted?.issuerName || undefined,
      issuerSiren: extracted?.issuerSiren || undefined,
      issuerSiret: extracted?.issuerSiret || undefined,
      issuerVat: extracted?.issuerVat || undefined,
      issuerIban: extracted?.issuerIban || undefined,
      issuerBic: extracted?.issuerBic || undefined,
      recipientName: extracted?.recipientName || undefined,
      recipientSiren: extracted?.recipientSiren || undefined,
      recipientSiret: extracted?.recipientSiret || undefined,
      recipientVat: extracted?.recipientVat || undefined,
      supplierId: supplierId || undefined,
      supplierMatchConfidence: supplierMatchConfidence ?? undefined,
      customerId: customerId || undefined,
      customerMatchConfidence: customerMatchConfidence ?? undefined,
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
