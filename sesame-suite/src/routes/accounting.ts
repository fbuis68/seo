import { Router } from "express";
import AdmZip from "adm-zip";
import { prisma } from "../db";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin } from "../middleware/requireAdmin";
import { resolveScope } from "../lib/scope";
import { processUploadedDocument, PipelineError } from "../lib/accPipeline";
import { DocumentIngestionError } from "../lib/accDocument";
import { seedAccounting } from "../lib/accSeed";
import { generateDraftEntry, validateEntry, reverseEntry, EntryGenerationError } from "../lib/accEntryService";
import { learnRuleFromCorrection } from "../lib/accRulesEngine";
import { worstLevel, CheckResult } from "../lib/accChecks";
import { recordAuditLog } from "../lib/accAudit";
import { parseBankFile, importBankTransactions, BankImportError, BankImportSource } from "../lib/accBanking";
import { fetchQontoOrganization, syncQontoBankAccount, QontoError, QontoCredentials } from "../lib/qonto";
import { testGoCardlessConnection, syncGoCardless, GoCardlessError, GoCardlessCredentials } from "../lib/gocardless";
import { findCandidates, confirmMatch, unmatch, autoReconcileMany, ReconciliationError } from "../lib/accReconciliation";
import { sendRelanceBatch, runRelanceRule } from "../lib/accRelance";

/**
 * Module comptabilité (§1-72 du cahier des charges) — routes REST. Toutes
 * les routes utilisent resolveScope(req) (même convention que
 * automationRule.ts/messageTemplate.ts) : ?scope=crm cible la portée
 * globale Sesame (entityId=null, réservé aux comptes "sesame"), sinon
 * repli sur l'établissement résolu de l'appelant. Phase 1 = chaîne achat
 * complète ; le rapprochement/la génération côté vente restent
 * schéma-prêts mais non branchés (cf. lib/accPipeline.ts).
 */
export const accountingRouter = Router();

function actorId(req: import("express").Request): string | null {
  return req.admin?.adminId || null;
}

// ───────────────────────── Documents / pipeline ─────────────────────────

interface UploadBody {
  filename: string;
  mimeType: string;
  base64: string;
  direction: "purchase" | "sale";
  source?: string;
}

accountingRouter.post(
  "/acc/documents/upload",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as UploadBody;
    if (!b.filename || !b.mimeType || !b.base64) throw new HttpError(400, "filename, mimeType et base64 requis");
    if (b.direction !== "purchase" && b.direction !== "sale") throw new HttpError(400, "direction doit être 'purchase' ou 'sale'");

    let result;
    try {
      result = await processUploadedDocument(entityId, {
        filename: b.filename,
        mimeType: b.mimeType,
        base64: b.base64,
        direction: b.direction,
        source: b.source || "upload",
      });
    } catch (err) {
      if (err instanceof DocumentIngestionError || err instanceof PipelineError) throw new HttpError(400, err.message);
      throw err;
    }

    await recordAuditLog({
      entityId,
      userId: actorId(req),
      action: result.isDuplicateDocument ? "document_upload_duplicate" : "document_uploaded",
      targetType: "AccInvoice",
      targetId: result.invoice.id,
      newValue: { status: result.invoice.status, direction: result.invoice.direction },
      ip: req.ip,
    });

    res.json({ invoice: result.invoice, isDuplicateDocument: result.isDuplicateDocument });
  })
);

const ZIP_ENTRY_MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  xml: "application/xml",
};

interface UploadZipBody {
  filename: string;
  base64: string;
  direction: "purchase" | "sale";
  source?: string;
}

interface ZipEntryResult {
  filename: string;
  ok: boolean;
  invoiceId?: string;
  isDuplicateDocument?: boolean;
  error?: string;
}

/**
 * POST /wa/acc/documents/uploadZip — import en masse d'une archive .zip de
 * factures (ex : export groupé Dext/Receipt Bank, ou tout autre outil qui
 * ne propose qu'un .zip en sortie) — évite à l'utilisateur de devoir
 * décompresser sur son poste avant de glisser les fichiers un par un. Traite
 * chaque fichier de l'archive exactement comme un upload individuel
 * (/acc/documents/upload, même pipeline OCR/extraction/rapprochement) —
 * l'échec d'un fichier n'interrompt jamais le traitement des autres.
 */
accountingRouter.post(
  "/acc/documents/uploadZip",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as UploadZipBody;
    if (!b.filename || !b.base64) throw new HttpError(400, "filename et base64 requis");
    if (b.direction !== "purchase" && b.direction !== "sale") throw new HttpError(400, "direction doit être 'purchase' ou 'sale'");

    let zip: AdmZip;
    try {
      zip = new AdmZip(Buffer.from(b.base64, "base64"));
    } catch {
      throw new HttpError(400, "Archive .zip invalide ou corrompue");
    }

    // Ignore dossiers, fichiers cachés/système (__MACOSX/, .DS_Store...) et
    // toute extension non reconnue par le pipeline — mêmes types acceptés
    // que le dépôt de fichier individuel (cf. accept= de la dropzone).
    const entries = zip.getEntries().filter((e) => {
      if (e.isDirectory) return false;
      const name = e.entryName.split("/").pop() || "";
      if (!name || name.startsWith(".")) return false;
      const ext = name.split(".").pop()?.toLowerCase() || "";
      return ext in ZIP_ENTRY_MIME;
    });
    if (!entries.length) throw new HttpError(400, "Aucun fichier exploitable dans cette archive (PDF/JPG/PNG/TIFF/XML attendus)");

    const results: ZipEntryResult[] = [];
    for (const entry of entries) {
      const filename = entry.entryName.split("/").pop() || entry.entryName;
      const ext = filename.split(".").pop()!.toLowerCase();
      try {
        const result = await processUploadedDocument(entityId, {
          filename,
          mimeType: ZIP_ENTRY_MIME[ext],
          base64: entry.getData().toString("base64"),
          direction: b.direction,
          source: b.source || "upload_zip",
        });
        await recordAuditLog({
          entityId,
          userId: actorId(req),
          action: result.isDuplicateDocument ? "document_upload_duplicate" : "document_uploaded",
          targetType: "AccInvoice",
          targetId: result.invoice.id,
          newValue: { status: result.invoice.status, direction: result.invoice.direction, viaZip: b.filename },
          ip: req.ip,
        });
        results.push({ filename, ok: true, invoiceId: result.invoice.id, isDuplicateDocument: result.isDuplicateDocument });
      } catch (err) {
        const message = err instanceof DocumentIngestionError || err instanceof PipelineError ? err.message : err instanceof Error ? err.message : "Erreur inattendue";
        results.push({ filename, ok: false, error: message });
      }
    }

    res.json({ imported: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
  })
);

// ───────────────────────── Factures ─────────────────────────

accountingRouter.get(
  "/acc/invoices",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const { status, direction, supplierId, q, unpaid, dueDateFrom, dueDateTo } = req.query as Record<string, string | undefined>;
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const offset = Number(req.query.offset) || 0;

    const where: Record<string, unknown> = { entityId };
    if (status) where.status = status;
    if (direction) where.direction = direction;
    if (supplierId) where.supplierId = supplierId;
    if (q) {
      where.OR = [
        { invoiceNumber: { contains: q, mode: "insensitive" } },
        { issuerName: { contains: q, mode: "insensitive" } },
        { recipientName: { contains: q, mode: "insensitive" } },
      ];
    }
    // Non payée = comptabilisée (ou validée) mais pas encore soldée. Le
    // statut à lui seul suffit : PAID n'est atteint qu'en passant par
    // invoiceStatusForAmountPaid (lib/accReconciliation.ts) ou la bascule
    // manuelle "réglée", jamais autrement — pas de comparaison montant/
    // montant à refaire ici.
    if (unpaid === "true") where.status = { in: ["VALIDATED", "ACCOUNTED", "PARTIALLY_PAID"] };
    if (dueDateFrom || dueDateTo) {
      where.dueDate = {
        ...(dueDateFrom ? { gte: new Date(dueDateFrom) } : {}),
        ...(dueDateTo ? { lte: new Date(dueDateTo) } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      prisma.accInvoice.findMany({
        where,
        include: { supplier: { select: { id: true, name: true } }, customer: { select: { id: true, name: true } }, document: { select: { originalFilename: true, mimeType: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.accInvoice.count({ where }),
    ]);
    res.json({ rows, total });
  })
);

accountingRouter.get(
  "/acc/invoices/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const invoice = await prisma.accInvoice.findFirst({
      where: { id: req.params.id, entityId },
      include: {
        supplier: true, customer: true, document: true, lines: true, vatLines: true, proposedAccount: true,
        entry: { include: { lines: { include: { account: true } } } },
        bankMatches: { include: { bankTransaction: true }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!invoice) throw new HttpError(404, "Facture introuvable");
    res.json(invoice);
  })
);

/**
 * GET /wa/acc/invoices/:id/unmatchedTransactions — pour l'affectation
 * manuelle d'un règlement CÔTÉ FACTURE (symétrique de
 * /acc/bank/transactions/:id/matches côté banque) : liste les transactions
 * bancaires encore disponibles (non MATCHED/IGNORED/INTERNAL_TRANSFER, avec
 * une capacité d'allocation restante) du sens et de la devise compatibles
 * avec cette facture.
 */
accountingRouter.get(
  "/acc/invoices/:id/unmatchedTransactions",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const invoice = await prisma.accInvoice.findFirst({ where: { id: req.params.id, entityId } });
    if (!invoice) throw new HttpError(404, "Facture introuvable");
    const rows = await prisma.accBankTransaction.findMany({
      where: {
        entityId,
        status: { notIn: ["MATCHED", "IGNORED", "INTERNAL_TRANSFER"] },
        direction: invoice.direction === "sale" ? "credit" : "debit",
        ...(invoice.currency ? { currency: invoice.currency } : {}),
      },
      orderBy: { operationDate: "desc" },
      take: 200,
      include: { matches: { select: { allocatedAmount: true } }, bankAccount: { select: { name: true } } },
    });
    const result = rows
      .map((r) => {
        const { matches, ...rest } = r;
        const matchedAmount = matches.reduce((s, m) => s + m.allocatedAmount, 0);
        return { ...rest, matchedAmount, remainingCapacity: Math.abs(r.amount) - matchedAmount };
      })
      .filter((r) => r.remainingCapacity > 0.01);
    res.json(result);
  })
);

const EDITABLE_INVOICE_FIELDS = [
  "direction",
  "invoiceNumber",
  "invoiceDate",
  "dueDate",
  "serviceDate",
  "currency",
  "orderNumber",
  "contractRef",
  "paymentMethod",
  "issuerName",
  "issuerSiren",
  "issuerSiret",
  "issuerVat",
  "issuerIban",
  "issuerBic",
  "recipientName",
  "recipientSiren",
  "recipientSiret",
  "recipientVat",
  "supplierId",
  "customerId",
  "amountHt",
  "amountVat",
  "amountTtc",
  "amountDiscount",
  "amountFees",
  "amountShipping",
] as const;

/** PUT /wa/acc/invoices/:id — corrections manuelles avant validation (§13/§38). */
accountingRouter.put(
  "/acc/invoices/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accInvoice.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Facture introuvable");
    if (existing.status === "VALIDATED" || existing.status === "ACCOUNTED") {
      throw new HttpError(400, "Facture déjà validée — utilisez une extourne d'écriture pour corriger");
    }

    const body = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    const oldValue: Record<string, unknown> = {};
    for (const field of EDITABLE_INVOICE_FIELDS) {
      if (!(field in body)) continue;
      let value = body[field];
      if (field === "direction" && value !== "purchase" && value !== "sale") throw new HttpError(400, "direction doit être 'purchase' ou 'sale'");
      if ((field === "invoiceDate" || field === "dueDate" || field === "serviceDate") && value) value = new Date(value as string);
      data[field] = value;
      oldValue[field] = (existing as unknown as Record<string, unknown>)[field];
    }
    if (!Object.keys(data).length) throw new HttpError(400, "Aucun champ à modifier");
    if ("direction" in data && data.direction !== existing.direction) {
      // Achat et vente ne partagent ni le rapprochement tiers (fournisseur
      // vs client) ni le type de compte proposé (charge vs produit) — un
      // ancien rapprochement/compte resterait incohérent avec la nouvelle
      // direction plutôt que simplement "à revalider".
      data.supplierId = null;
      data.customerId = null;
      data.proposedAccountId = null;
      data.proposedAccountConfidence = 0;
    }

    const updated = await prisma.accInvoice.update({ where: { id: existing.id }, data });
    await recordAuditLog({ entityId, userId: actorId(req), action: "invoice_fields_corrected", targetType: "AccInvoice", targetId: existing.id, oldValue, newValue: data, ip: req.ip });
    res.json(updated);
  })
);

/** PATCH /wa/acc/invoices/:id/account — correction du compte proposé (§18), alimente le moteur de règles. */
accountingRouter.patch(
  "/acc/invoices/:id/account",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accInvoice.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Facture introuvable");
    const accountId = req.body?.accountId as string;
    if (!accountId) throw new HttpError(400, "accountId requis");
    const account = await prisma.accAccount.findFirst({ where: { id: accountId, entityId } });
    if (!account) throw new HttpError(404, "Compte introuvable");

    const updated = await prisma.accInvoice.update({
      where: { id: existing.id },
      data: { proposedAccountId: accountId, proposedAccountConfidence: 1.0 },
    });
    if (existing.supplierId) await learnRuleFromCorrection(entityId, existing.supplierId, accountId);

    await recordAuditLog({
      entityId,
      userId: actorId(req),
      action: "invoice_account_corrected",
      targetType: "AccInvoice",
      targetId: existing.id,
      oldValue: { proposedAccountId: existing.proposedAccountId },
      newValue: { proposedAccountId: accountId },
      ip: req.ip,
    });
    res.json(updated);
  })
);

/**
 * POST /wa/acc/invoices/:id/validate — confirmation humaine des champs
 * extraits (§13) : génère l'écriture DRAFT correspondante (§19/§20) si elle
 * n'existe pas déjà (idempotent). Une alerte BLOCKING (§14, ex : IBAN
 * fournisseur changé) n'empêche jamais cette validation explicite — elle
 * bloque seulement toute validation AUTOMATIQUE côté pipeline.
 */
accountingRouter.post(
  "/acc/invoices/:id/validate",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const invoice = await prisma.accInvoice.findFirst({ where: { id: req.params.id, entityId } });
    if (!invoice) throw new HttpError(404, "Facture introuvable");
    if (invoice.status === "REJECTED") throw new HttpError(400, "Une facture rejetée ne peut pas être validée");

    if (!invoice.entryId) {
      try {
        await generateDraftEntry(invoice.id);
      } catch (err) {
        if (err instanceof EntryGenerationError) throw new HttpError(400, err.message);
        throw err;
      }
    }

    const updated = await prisma.accInvoice.update({
      where: { id: invoice.id },
      data: { status: "VALIDATED", validatedAt: new Date(), validatedBy: actorId(req) || undefined },
      include: { entry: { include: { lines: true } } },
    });
    await recordAuditLog({ entityId, userId: actorId(req), action: "invoice_validated", targetType: "AccInvoice", targetId: invoice.id, oldValue: { status: invoice.status }, newValue: { status: "VALIDATED" }, ip: req.ip });
    res.json(updated);
  })
);

accountingRouter.post(
  "/acc/invoices/:id/reject",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const invoice = await prisma.accInvoice.findFirst({ where: { id: req.params.id, entityId } });
    if (!invoice) throw new HttpError(404, "Facture introuvable");
    const updated = await prisma.accInvoice.update({ where: { id: invoice.id }, data: { status: "REJECTED" } });
    await recordAuditLog({ entityId, userId: actorId(req), action: "invoice_rejected", targetType: "AccInvoice", targetId: invoice.id, oldValue: { status: invoice.status }, newValue: { status: "REJECTED", reason: req.body?.reason || null }, ip: req.ip });
    res.json(updated);
  })
);

/**
 * PATCH /wa/acc/invoices/:id/payment — indicateur "réglée" manuel (§21/§34),
 * pour un règlement hors rapprochement bancaire (espèces, chèque encaissé
 * sans passer par un relevé...). Réservé aux factures déjà comptabilisées.
 * Coexiste avec le rapprochement bancaire (phase 3, AccBankMatch) via
 * amountPaid : paid=true complète le solde dû restant (ne réduit jamais un
 * montant déjà rapproché par ailleurs) ; paid=false est refusé tant qu'un
 * rapprochement bancaire couvre une partie de la facture — il faut d'abord
 * le retirer (DELETE /acc/bank/matches/:id) pour éviter un état incohérent
 * (statut "non réglée" alors qu'un virement réel y est rapproché).
 */
accountingRouter.patch(
  "/acc/invoices/:id/payment",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const invoice = await prisma.accInvoice.findFirst({ where: { id: req.params.id, entityId } });
    if (!invoice) throw new HttpError(404, "Facture introuvable");
    if (!["ACCOUNTED", "PARTIALLY_PAID", "PAID"].includes(invoice.status)) {
      throw new HttpError(400, "Seule une facture comptabilisée peut être marquée payée");
    }
    const paid = !!req.body?.paid;
    if (!paid) {
      const bankMatchCount = await prisma.accBankMatch.count({ where: { invoiceId: invoice.id } });
      if (bankMatchCount > 0) {
        throw new HttpError(400, "Cette facture a un rapprochement bancaire — retirez-le (onglet Banque) avant de la marquer non réglée");
      }
    }
    const amountPaid = paid ? invoice.amountTtc || 0 : 0;
    const status = paid ? "PAID" : "ACCOUNTED";
    const updated = await prisma.accInvoice.update({ where: { id: invoice.id }, data: { status, amountPaid } });
    await recordAuditLog({ entityId, userId: actorId(req), action: paid ? "invoice_marked_paid" : "invoice_marked_unpaid", targetType: "AccInvoice", targetId: invoice.id, oldValue: { status: invoice.status }, newValue: { status }, ip: req.ip });
    res.json(updated);
  })
);

interface RelanceBody {
  invoiceIds?: string[];
  templateKey?: string;
  attachInvoice?: boolean;
}

/**
 * POST /wa/acc/invoices/relance — envoie un email de relance manuel (modèle
 * email au choix) pour chaque facture sélectionnée — même logique d'envoi
 * que le balayage automatique des règles (cf. lib/accRelance.ts), partagée
 * pour ne jamais diverger sur ce qui constitue une facture "relançable".
 */
accountingRouter.post(
  "/acc/invoices/relance",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as RelanceBody;
    if (!b.invoiceIds?.length) throw new HttpError(400, "invoiceIds requis");
    if (!b.templateKey) throw new HttpError(400, "templateKey requis");

    const summary = await sendRelanceBatch(entityId, b.invoiceIds, b.templateKey, b.attachInvoice !== false);
    await recordAuditLog({
      entityId, userId: actorId(req), action: "invoices_relance_sent", targetType: "AccInvoice", targetId: b.invoiceIds.join(","),
      newValue: { templateKey: b.templateKey, successCount: summary.successCount, failureCount: summary.failureCount }, ip: req.ip,
    });
    res.json(summary);
  })
);

// ───────────────────────── Règles de relance automatique ─────────────────────────

const RELANCE_BASIS = new Set(["invoiceDate", "dueDate"]);

accountingRouter.get(
  "/acc/relanceRules",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const rows = await prisma.accRelanceRule.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } });
    res.json(rows);
  })
);

interface RelanceRuleBody {
  name?: string;
  basis?: string;
  offsetDays?: number;
  direction?: string | null;
  templateKey?: string;
  attachInvoice?: boolean;
  active?: boolean;
}

function validateRelanceRuleBody(b: RelanceRuleBody) {
  if (!b.name) throw new HttpError(400, "name requis");
  if (!b.basis || !RELANCE_BASIS.has(b.basis)) throw new HttpError(400, "basis doit être 'invoiceDate' ou 'dueDate'");
  if (!Number.isInteger(b.offsetDays)) throw new HttpError(400, "offsetDays doit être un entier");
  if (b.direction && b.direction !== "purchase" && b.direction !== "sale") throw new HttpError(400, "direction doit être 'purchase', 'sale' ou vide");
  if (!b.templateKey) throw new HttpError(400, "templateKey requis");
}

accountingRouter.post(
  "/acc/relanceRules",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as RelanceRuleBody;
    validateRelanceRuleBody(b);
    const created = await prisma.accRelanceRule.create({
      data: {
        entityId,
        name: b.name!,
        basis: b.basis!,
        offsetDays: b.offsetDays!,
        direction: b.direction || null,
        templateKey: b.templateKey!,
        attachInvoice: b.attachInvoice !== false,
        active: b.active !== false,
      },
    });
    await recordAuditLog({ entityId, userId: actorId(req), action: "relance_rule_created", targetType: "AccRelanceRule", targetId: created.id, newValue: { name: created.name }, ip: req.ip });
    res.json(created);
  })
);

accountingRouter.put(
  "/acc/relanceRules/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accRelanceRule.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Règle introuvable");
    const b = req.body as RelanceRuleBody;
    const merged = { ...existing, ...b } as RelanceRuleBody;
    validateRelanceRuleBody(merged);
    const updated = await prisma.accRelanceRule.update({
      where: { id: existing.id },
      data: {
        name: merged.name!,
        basis: merged.basis!,
        offsetDays: merged.offsetDays!,
        direction: merged.direction || null,
        templateKey: merged.templateKey!,
        attachInvoice: merged.attachInvoice !== false,
        active: merged.active !== false,
      },
    });
    res.json(updated);
  })
);

accountingRouter.delete(
  "/acc/relanceRules/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accRelanceRule.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Règle introuvable");
    await prisma.accRelanceRule.delete({ where: { id: existing.id } });
    await recordAuditLog({ entityId, userId: actorId(req), action: "relance_rule_deleted", targetType: "AccRelanceRule", targetId: existing.id, oldValue: { name: existing.name }, ip: req.ip });
    res.json({ ok: true });
  })
);

/** POST /wa/acc/relanceRules/:id/run — déclenche le balayage de cette règle immédiatement, sans attendre le prochain passage quotidien (mêmes garde-fous anti-doublon). */
accountingRouter.post(
  "/acc/relanceRules/:id/run",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accRelanceRule.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Règle introuvable");
    const summary = await runRelanceRule(existing.id);
    await recordAuditLog({
      entityId, userId: actorId(req), action: "relance_rule_run", targetType: "AccRelanceRule", targetId: existing.id,
      newValue: { successCount: summary.successCount, failureCount: summary.failureCount }, ip: req.ip,
    });
    res.json(summary);
  })
);

// ───────────────────────── Réglages généraux ─────────────────────────

/**
 * GET/PUT /wa/acc/settings — délai de paiement par défaut de la portée,
 * utilisé pour calculer dueDate quand une facture ne l'indique pas et
 * qu'aucun réglage particulier n'existe sur le fournisseur rapproché
 * (cf. AccSupplier.paymentTermDays, lib/accPipeline.ts). Une portée sans
 * ligne AccSettings se comporte comme si 30 jours net (valeurs par défaut
 * du schéma) — GET renvoie ces valeurs par défaut sans créer de ligne,
 * seul PUT en crée une.
 */
accountingRouter.get(
  "/acc/settings",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const settings = await prisma.accSettings.findFirst({ where: { entityId } });
    res.json({
      defaultPaymentTermDays: settings?.defaultPaymentTermDays ?? 30,
      defaultPaymentTermMode: settings?.defaultPaymentTermMode ?? "net",
    });
  })
);

interface SettingsBody {
  defaultPaymentTermDays?: number;
  defaultPaymentTermMode?: string;
}

accountingRouter.put(
  "/acc/settings",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as SettingsBody;
    if (b.defaultPaymentTermDays != null && (!Number.isInteger(b.defaultPaymentTermDays) || b.defaultPaymentTermDays < 0)) {
      throw new HttpError(400, "Délai de paiement invalide (entier positif)");
    }
    if (b.defaultPaymentTermMode && b.defaultPaymentTermMode !== "net" && b.defaultPaymentTermMode !== "eom") {
      throw new HttpError(400, "Mode de calcul invalide");
    }
    const existing = await prisma.accSettings.findFirst({ where: { entityId } });
    const data = {
      defaultPaymentTermDays: b.defaultPaymentTermDays ?? existing?.defaultPaymentTermDays ?? 30,
      defaultPaymentTermMode: b.defaultPaymentTermMode ?? existing?.defaultPaymentTermMode ?? "net",
    };
    const updated = existing
      ? await prisma.accSettings.update({ where: { id: existing.id }, data })
      : await prisma.accSettings.create({ data: { entityId, ...data } });
    await recordAuditLog({ entityId, userId: actorId(req), action: "acc_settings_updated", targetType: "AccSettings", targetId: updated.id, oldValue: existing, newValue: data, ip: req.ip });
    res.json({ defaultPaymentTermDays: updated.defaultPaymentTermDays, defaultPaymentTermMode: updated.defaultPaymentTermMode });
  })
);

// ───────────────────────── Fournisseurs ─────────────────────────

accountingRouter.get(
  "/acc/suppliers",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const q = req.query.q as string | undefined;
    const where: Record<string, unknown> = { entityId };
    if (q) where.name = { contains: q, mode: "insensitive" };
    const rows = await prisma.accSupplier.findMany({ where, orderBy: { name: "asc" } });
    res.json(rows);
  })
);

const PAYMENT_METHODS = new Set(["virement", "prelevement", "cheque", "carte", "especes", "autre"]);

accountingRouter.post(
  "/acc/suppliers",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as { name?: string; paymentTermMode?: string; paymentMethod?: string };
    if (!b.name) throw new HttpError(400, "name requis");
    if (b.paymentTermMode && b.paymentTermMode !== "net" && b.paymentTermMode !== "eom") throw new HttpError(400, "Mode de calcul invalide");
    if (b.paymentMethod && !PAYMENT_METHODS.has(b.paymentMethod)) throw new HttpError(400, "Mode de règlement invalide");
    const created = await prisma.accSupplier.create({
      data: {
        entityId,
        name: b.name,
        siren: (req.body.siren as string) || undefined,
        siret: (req.body.siret as string) || undefined,
        vatNumber: (req.body.vatNumber as string) || undefined,
        addressLine: (req.body.addressLine as string) || undefined,
        postalCode: (req.body.postalCode as string) || undefined,
        city: (req.body.city as string) || undefined,
        country: (req.body.country as string) || undefined,
        email: (req.body.email as string) || undefined,
        phone: (req.body.phone as string) || undefined,
        iban: (req.body.iban as string) || undefined,
        bic: (req.body.bic as string) || undefined,
        defaultAccountId: (req.body.defaultAccountId as string) || undefined,
        paymentTermDays: req.body.paymentTermDays != null && req.body.paymentTermDays !== "" ? Number(req.body.paymentTermDays) : undefined,
        paymentTermMode: b.paymentTermMode || undefined,
        paymentMethod: b.paymentMethod || undefined,
      },
    });
    await recordAuditLog({ entityId, userId: actorId(req), action: "supplier_created", targetType: "AccSupplier", targetId: created.id, newValue: { name: created.name }, ip: req.ip });
    res.json(created);
  })
);

accountingRouter.put(
  "/acc/suppliers/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accSupplier.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Fournisseur introuvable");
    const fields = ["name", "siren", "siret", "vatNumber", "addressLine", "postalCode", "city", "country", "email", "phone", "iban", "bic", "defaultAccountId"] as const;
    const data: Record<string, unknown> = {};
    for (const f of fields) if (f in req.body) data[f] = req.body[f];
    // Champ vidé côté formulaire = "utiliser le réglage général" (null),
    // pas juste "ne pas modifier" (contrairement aux champs ci-dessus).
    if ("paymentTermDays" in req.body) {
      const v = req.body.paymentTermDays;
      data.paymentTermDays = v === null || v === "" ? null : Number(v);
    }
    if ("paymentTermMode" in req.body) {
      const v = req.body.paymentTermMode as string | null;
      if (v && v !== "net" && v !== "eom") throw new HttpError(400, "Mode de calcul invalide");
      data.paymentTermMode = v || null;
    }
    if ("paymentMethod" in req.body) {
      const v = req.body.paymentMethod as string | null;
      if (v && !PAYMENT_METHODS.has(v)) throw new HttpError(400, "Mode de règlement invalide");
      data.paymentMethod = v || null;
    }
    const updated = await prisma.accSupplier.update({ where: { id: existing.id }, data });
    await recordAuditLog({ entityId, userId: actorId(req), action: "supplier_updated", targetType: "AccSupplier", targetId: existing.id, oldValue: existing, newValue: data, ip: req.ip });
    res.json(updated);
  })
);

// ───────────────────────── Clients (facture de vente) ─────────────────────────

accountingRouter.get(
  "/acc/customers",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const q = req.query.q as string | undefined;
    const where: Record<string, unknown> = { entityId };
    if (q) where.name = { contains: q, mode: "insensitive" };
    const rows = await prisma.accCustomer.findMany({ where, orderBy: { name: "asc" } });
    res.json(rows);
  })
);

accountingRouter.post(
  "/acc/customers",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as { name?: string };
    if (!b.name) throw new HttpError(400, "name requis");
    const created = await prisma.accCustomer.create({
      data: {
        entityId,
        name: b.name,
        siren: (req.body.siren as string) || undefined,
        siret: (req.body.siret as string) || undefined,
        vatNumber: (req.body.vatNumber as string) || undefined,
        addressLine: (req.body.addressLine as string) || undefined,
        postalCode: (req.body.postalCode as string) || undefined,
        city: (req.body.city as string) || undefined,
        country: (req.body.country as string) || undefined,
        email: (req.body.email as string) || undefined,
        phone: (req.body.phone as string) || undefined,
      },
    });
    await recordAuditLog({ entityId, userId: actorId(req), action: "customer_created", targetType: "AccCustomer", targetId: created.id, newValue: { name: created.name }, ip: req.ip });
    res.json(created);
  })
);

accountingRouter.put(
  "/acc/customers/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accCustomer.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Client introuvable");
    const fields = ["name", "siren", "siret", "vatNumber", "addressLine", "postalCode", "city", "country", "email", "phone"] as const;
    const data: Record<string, unknown> = {};
    for (const f of fields) if (f in req.body) data[f] = req.body[f];
    const updated = await prisma.accCustomer.update({ where: { id: existing.id }, data });
    await recordAuditLog({ entityId, userId: actorId(req), action: "customer_updated", targetType: "AccCustomer", targetId: existing.id, oldValue: existing, newValue: data, ip: req.ip });
    res.json(updated);
  })
);

/**
 * GET /wa/acc/customers/:id — fiche "compte client" : position du compte
 * (facturé/réglé/solde dû) + liste des factures + liste des règlements
 * bancaires affectés, pour un relevé de compte auxiliaire (411) complet
 * sans avoir à recouper manuellement l'onglet Factures et l'onglet Banque.
 */
accountingRouter.get(
  "/acc/customers/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const customer = await prisma.accCustomer.findFirst({ where: { id: req.params.id, entityId } });
    if (!customer) throw new HttpError(404, "Client introuvable");

    const invoices = await prisma.accInvoice.findMany({
      where: { customerId: customer.id },
      orderBy: { invoiceDate: "desc" },
      select: { id: true, invoiceNumber: true, invoiceDate: true, dueDate: true, status: true, amountHt: true, amountVat: true, amountTtc: true, amountPaid: true, currency: true },
    });

    const payments = await prisma.accBankMatch.findMany({
      where: { invoice: { customerId: customer.id } },
      include: { bankTransaction: { select: { operationDate: true, rawLabel: true } }, invoice: { select: { invoiceNumber: true } } },
      orderBy: { createdAt: "desc" },
    });

    // Prélèvements GoCardless de ce client (§ rapprochement demandé) — vide
    // pour tout client non rapproché à un customer GoCardless (customer.
    // gocardlessCustomerId null), jamais bloquant pour le reste de la fiche.
    const gocardlessPayments = await prisma.accGoCardlessPayment.findMany({
      where: { customerId: customer.id },
      include: { payout: { select: { id: true, status: true, arrivalDate: true, bankTransactionId: true } } },
      orderBy: { chargeDate: "desc" },
    });

    let totalHt = 0, totalTtc = 0, totalPaid = 0;
    for (const inv of invoices) {
      totalHt += inv.amountHt || 0;
      totalTtc += inv.amountTtc || 0;
      totalPaid += inv.amountPaid || 0;
    }

    res.json({
      customer,
      position: { totalHt, totalTtc, totalPaid, balanceDue: Math.max(0, totalTtc - totalPaid) },
      invoices,
      payments,
      gocardlessPayments,
    });
  })
);

// ───────────────────────── Plan comptable / journaux ─────────────────────────

accountingRouter.get(
  "/acc/accounts",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const where: Record<string, unknown> = { entityId };
    if (req.query.type) where.type = req.query.type;
    if (req.query.active !== undefined) where.active = req.query.active === "true";
    const rows = await prisma.accAccount.findMany({ where, orderBy: { number: "asc" } });
    res.json(rows);
  })
);

accountingRouter.post(
  "/acc/accounts",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as { number?: string; label?: string; type?: string };
    if (!b.number || !b.label || !b.type) throw new HttpError(400, "number, label et type requis");
    const created = await prisma.accAccount.create({ data: { entityId, number: b.number, label: b.label, type: b.type, class: Number(b.number[0]) || undefined } });
    await recordAuditLog({ entityId, userId: actorId(req), action: "account_created", targetType: "AccAccount", targetId: created.id, newValue: { number: created.number, label: created.label }, ip: req.ip });
    res.json(created);
  })
);

accountingRouter.put(
  "/acc/accounts/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accAccount.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Compte introuvable");
    const data: Record<string, unknown> = {};
    for (const f of ["label", "type", "active"] as const) if (f in req.body) data[f] = req.body[f];
    const updated = await prisma.accAccount.update({ where: { id: existing.id }, data });
    res.json(updated);
  })
);

/** POST /wa/acc/seed — initialise le plan comptable + journaux standards (§16/§33), idempotent. */
accountingRouter.post(
  "/acc/seed",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const result = await seedAccounting(entityId);
    await recordAuditLog({ entityId, userId: actorId(req), action: "accounting_seeded", targetType: "AccAccount", targetId: entityId || "crm", newValue: result, ip: req.ip });
    res.json(result);
  })
);

accountingRouter.get(
  "/acc/journals",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const rows = await prisma.accJournal.findMany({ where: { entityId }, orderBy: { code: "asc" } });
    res.json(rows);
  })
);

// ───────────────────────── Écritures ─────────────────────────

accountingRouter.get(
  "/acc/entries",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const where: Record<string, unknown> = { entityId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.journalId) where.journalId = req.query.journalId;
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const rows = await prisma.accEntry.findMany({ where, include: { journal: true, lines: { include: { account: true } } }, orderBy: { date: "desc" }, take: limit });
    res.json(rows);
  })
);

accountingRouter.get(
  "/acc/entries/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const entry = await prisma.accEntry.findFirst({ where: { id: req.params.id, entityId }, include: { journal: true, lines: { include: { account: true } }, invoice: true } });
    if (!entry) throw new HttpError(404, "Écriture introuvable");
    res.json(entry);
  })
);

/** POST /wa/acc/entries/:id/validate — numérotation définitive (§44), jamais réutilisée, idempotent. */
accountingRouter.post(
  "/acc/entries/:id/validate",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const entry = await prisma.accEntry.findFirst({ where: { id: req.params.id, entityId } });
    if (!entry) throw new HttpError(404, "Écriture introuvable");
    const updated = await validateEntry(entry.id, actorId(req));
    await recordAuditLog({ entityId, userId: actorId(req), action: "entry_validated", targetType: "AccEntry", targetId: entry.id, oldValue: { status: entry.status }, newValue: { status: updated.status, number: updated.number }, ip: req.ip });
    res.json(updated);
  })
);

/** POST /wa/acc/entries/:id/reverse — extourne (§44), seul moyen de corriger une écriture validée. */
accountingRouter.post(
  "/acc/entries/:id/reverse",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const entry = await prisma.accEntry.findFirst({ where: { id: req.params.id, entityId } });
    if (!entry) throw new HttpError(404, "Écriture introuvable");
    let reversal;
    try {
      reversal = await reverseEntry(entry.id, actorId(req), req.body?.reason as string | undefined);
    } catch (err) {
      if (err instanceof EntryGenerationError) throw new HttpError(400, err.message);
      throw err;
    }
    await recordAuditLog({ entityId, userId: actorId(req), action: "entry_reversed", targetType: "AccEntry", targetId: entry.id, newValue: { reversalEntryId: reversal.id, reason: req.body?.reason || null }, ip: req.ip });
    res.json(reversal);
  })
);

// ───────────────────────── Règles ─────────────────────────

accountingRouter.get(
  "/acc/rules",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const rows = await prisma.accRule.findMany({ where: { entityId }, include: { supplier: { select: { name: true } }, account: { select: { number: true, label: true } } }, orderBy: [{ priority: "desc" }, { createdAt: "desc" }] });
    res.json(rows);
  })
);

accountingRouter.post(
  "/acc/rules",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as { supplierId?: string; keyword?: string; accountId?: string; priority?: number };
    if (!b.accountId) throw new HttpError(400, "accountId requis");
    if (!b.supplierId && !b.keyword) throw new HttpError(400, "supplierId ou keyword requis");
    const created = await prisma.accRule.create({ data: { entityId, supplierId: b.supplierId || undefined, keyword: b.keyword || undefined, accountId: b.accountId, priority: b.priority || 0, source: "manual" } });
    await recordAuditLog({ entityId, userId: actorId(req), action: "rule_created", targetType: "AccRule", targetId: created.id, newValue: { supplierId: created.supplierId, keyword: created.keyword, accountId: created.accountId }, ip: req.ip });
    res.json(created);
  })
);

accountingRouter.put(
  "/acc/rules/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accRule.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Règle introuvable");
    const data: Record<string, unknown> = {};
    for (const f of ["active", "priority", "keyword", "accountId"] as const) if (f in req.body) data[f] = req.body[f];
    const updated = await prisma.accRule.update({ where: { id: existing.id }, data });
    res.json(updated);
  })
);

accountingRouter.delete(
  "/acc/rules/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accRule.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Règle introuvable");
    await prisma.accRule.delete({ where: { id: existing.id } });
    await recordAuditLog({ entityId, userId: actorId(req), action: "rule_deleted", targetType: "AccRule", targetId: existing.id, oldValue: { supplierId: existing.supplierId, keyword: existing.keyword, accountId: existing.accountId }, ip: req.ip });
    res.json({ ok: true });
  })
);

// ───────────────────────── Tableau de bord ─────────────────────────

/** GET /wa/acc/dashboard — tuiles de synthèse (§36) pour le panneau Comptabilité. */
accountingRouter.get(
  "/acc/dashboard",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const [byStatusRaw, pendingInvoices] = await Promise.all([
      prisma.accInvoice.groupBy({ by: ["status"], where: { entityId }, _count: { _all: true } }),
      prisma.accInvoice.findMany({ where: { entityId, status: { in: ["RECEIVED", "EXTRACTED", "CHECK_REQUIRED"] } }, select: { amountHt: true, amountTtc: true, checks: true } }),
    ]);
    const byStatus: Record<string, number> = {};
    for (const r of byStatusRaw) byStatus[r.status] = r._count._all;

    let pendingHt = 0;
    let pendingTtc = 0;
    let blockingCount = 0;
    for (const inv of pendingInvoices) {
      pendingHt += inv.amountHt || 0;
      pendingTtc += inv.amountTtc || 0;
      const checks = (inv.checks as unknown as CheckResult[]) || [];
      if (worstLevel(checks) === "BLOCKING") blockingCount++;
    }

    res.json({ byStatus, pendingCount: pendingInvoices.length, pendingHt, pendingTtc, blockingCount });
  })
);

// ───────────────────────── Banque (Phase 1 : comptes + import) ─────────────────────────

const BANK_IMPORT_SOURCES = new Set(["csv", "camt053", "mt940", "cfonb"]);

accountingRouter.get(
  "/acc/bank/accounts",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const rows = await prisma.accBankAccount.findMany({ where: { entityId }, orderBy: { name: "asc" } });
    res.json(rows);
  })
);

interface BankAccountBody {
  bank?: string;
  name?: string;
  iban?: string;
  bic?: string;
  currency?: string;
  type?: string;
  accountId?: string;
}

accountingRouter.post(
  "/acc/bank/accounts",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as BankAccountBody;
    if (!b.bank || !b.name || !b.accountId) throw new HttpError(400, "bank, name et accountId requis");
    const account = await prisma.accAccount.findFirst({ where: { id: b.accountId, entityId } });
    if (!account) throw new HttpError(400, "Compte comptable (accountId) introuvable pour cet établissement");
    const created = await prisma.accBankAccount.create({
      data: {
        entityId,
        bank: b.bank,
        name: b.name,
        iban: b.iban || null,
        bic: b.bic || null,
        currency: b.currency || "EUR",
        type: b.type || null,
        accountId: b.accountId,
      },
    });
    await recordAuditLog({ entityId, userId: actorId(req), action: "bank_account_created", targetType: "AccBankAccount", targetId: created.id, newValue: { bank: created.bank, name: created.name }, ip: req.ip });
    res.json(created);
  })
);

accountingRouter.put(
  "/acc/bank/accounts/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accBankAccount.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Compte bancaire introuvable");
    const data: Record<string, unknown> = {};
    for (const f of ["bank", "name", "iban", "bic", "currency", "type"] as const) if (f in req.body) data[f] = req.body[f];
    const updated = await prisma.accBankAccount.update({ where: { id: existing.id }, data });
    res.json(updated);
  })
);

accountingRouter.delete(
  "/acc/bank/accounts/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accBankAccount.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Compte bancaire introuvable");
    const txCount = await prisma.accBankTransaction.count({ where: { bankAccountId: existing.id } });
    if (txCount > 0) throw new HttpError(400, "Impossible de supprimer un compte bancaire ayant des transactions importées");
    await prisma.accBankAccount.delete({ where: { id: existing.id } });
    await recordAuditLog({ entityId, userId: actorId(req), action: "bank_account_deleted", targetType: "AccBankAccount", targetId: existing.id, oldValue: { bank: existing.bank, name: existing.name }, ip: req.ip });
    res.json({ ok: true });
  })
);

interface BankImportBody {
  bankAccountId?: string;
  source?: string;
  content?: string;
}

/**
 * POST /wa/acc/bank/import — import d'un relevé (CSV/CAMT.053/MT940 ; CFONB
 * pas encore supporté, cf. accBanking.ts). Idempotent : les transactions déjà
 * importées (même bankAccountId+externalId) sont simplement comptées en
 * "skipped", ce qui permet de réimporter un relevé qui chevauche le précédent.
 */
accountingRouter.post(
  "/acc/bank/import",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as BankImportBody;
    if (!b.bankAccountId || !b.source || !b.content) throw new HttpError(400, "bankAccountId, source et content requis");
    if (!BANK_IMPORT_SOURCES.has(b.source)) throw new HttpError(400, `source doit être l'un de: ${[...BANK_IMPORT_SOURCES].join(", ")}`);
    const bankAccount = await prisma.accBankAccount.findFirst({ where: { id: b.bankAccountId, entityId } });
    if (!bankAccount) throw new HttpError(404, "Compte bancaire introuvable");

    let parsed;
    try {
      parsed = parseBankFile(b.source as BankImportSource, b.content);
    } catch (err) {
      if (err instanceof BankImportError) throw new HttpError(400, err.message);
      throw err;
    }

    const result = await importBankTransactions(entityId, bankAccount.id, b.source as BankImportSource, parsed);
    await prisma.accBankAccount.update({ where: { id: bankAccount.id }, data: { lastSyncAt: new Date() } });
    const { matchedCount } = await autoReconcileMany(result.createdIds);
    await recordAuditLog({
      entityId,
      userId: actorId(req),
      action: "bank_transactions_imported",
      targetType: "AccBankAccount",
      targetId: bankAccount.id,
      newValue: { source: b.source, parsedCount: parsed.length, ...result, matchedCount },
      ip: req.ip,
    });

    res.json({ parsedCount: parsed.length, created: result.created, skipped: result.skipped, matchedCount });
  })
);

// ───────── Connecteur Qonto (Phase 2 : synchronisation automatique) ─────────

function shapeQontoConfig(c: { login: string; secretKey: string; sandbox: boolean } | null) {
  if (!c) return { login: "", secretKeySet: false, secretKeyLast4: "", sandbox: false };
  return { login: c.login, secretKeySet: true, secretKeyLast4: c.secretKey.slice(-4), sandbox: c.sandbox };
}

accountingRouter.get(
  "/acc/bank/qonto/config",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const config = await prisma.qontoConfig.findFirst({ where: { entityId } });
    res.json(shapeQontoConfig(config));
  })
);

interface QontoConfigBody {
  login?: string;
  secretKey?: string;
  sandbox?: boolean;
}

/** PUT /wa/acc/bank/qonto/config — un secretKey vide conserve la valeur déjà enregistrée (même convention que /wa/payment/config/update). */
accountingRouter.put(
  "/acc/bank/qonto/config",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as QontoConfigBody;
    if (!b.login) throw new HttpError(400, "login requis");
    const existing = await prisma.qontoConfig.findFirst({ where: { entityId } });
    if (!b.secretKey && !existing) throw new HttpError(400, "secretKey requis à la première configuration");
    const data = { login: b.login, ...(b.secretKey ? { secretKey: b.secretKey } : {}), sandbox: !!b.sandbox };
    const config = existing
      ? await prisma.qontoConfig.update({ where: { id: existing.id }, data })
      : await prisma.qontoConfig.create({ data: { entityId, login: b.login, secretKey: b.secretKey!, sandbox: !!b.sandbox } });
    await recordAuditLog({ entityId, userId: actorId(req), action: "qonto_config_updated", targetType: "QontoConfig", targetId: config.id, ip: req.ip });
    res.json(shapeQontoConfig(config));
  })
);

/** POST /wa/acc/bank/qonto/test — valide les identifiants enregistrés en listant les comptes bancaires de l'organisation, aucun effet de bord. */
accountingRouter.post(
  "/acc/bank/qonto/test",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const config = await prisma.qontoConfig.findFirst({ where: { entityId } });
    if (!config) throw new HttpError(400, "Identifiants Qonto non configurés");
    const creds: QontoCredentials = { login: config.login, secretKey: config.secretKey, sandbox: config.sandbox };
    try {
      const org = await fetchQontoOrganization(creds);
      res.json({ ok: true, slug: org.slug, bankAccounts: org.bankAccounts });
    } catch (e) {
      if (e instanceof QontoError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

/** POST /wa/acc/bank/accounts/:id/qonto/connect — lie un AccBankAccount existant à un IBAN Qonto ; la première synchronisation se fait ensuite via "Synchroniser maintenant" ou le prochain passage du planificateur. */
accountingRouter.post(
  "/acc/bank/accounts/:id/qonto/connect",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accBankAccount.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Compte bancaire introuvable");
    const iban = (req.body as { iban?: string }).iban;
    if (!iban) throw new HttpError(400, "iban requis");
    const updated = await prisma.accBankAccount.update({
      where: { id: existing.id },
      data: { provider: "qonto", providerAccountId: iban, connectionStatus: "connected", lastSyncAt: null },
    });
    await recordAuditLog({ entityId, userId: actorId(req), action: "qonto_account_connected", targetType: "AccBankAccount", targetId: updated.id, newValue: { iban }, ip: req.ip });
    res.json(updated);
  })
);

accountingRouter.post(
  "/acc/bank/accounts/:id/qonto/disconnect",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accBankAccount.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Compte bancaire introuvable");
    const updated = await prisma.accBankAccount.update({
      where: { id: existing.id },
      data: { provider: "csv", providerAccountId: null, connectionStatus: "manual" },
    });
    res.json(updated);
  })
);

/**
 * POST /wa/acc/bank/accounts/:id/qonto/sync — synchronisation manuelle
 * immédiate (même logique que le planificateur de fond, delta depuis
 * lastSyncAt). ?full=1 refait passer tout l'historique (ignore lastSyncAt)
 * — pour backfiller un champ ajouté après coup (ex : labels analytiques)
 * sur des transactions déjà importées, jamais revisitées par un sync normal.
 */
accountingRouter.post(
  "/acc/bank/accounts/:id/qonto/sync",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const existing = await prisma.accBankAccount.findFirst({ where: { id: req.params.id, entityId } });
    if (!existing) throw new HttpError(404, "Compte bancaire introuvable");
    const full = req.query.full === "1";
    try {
      const result = await syncQontoBankAccount(existing.id, { full });
      await recordAuditLog({ entityId, userId: actorId(req), action: full ? "qonto_full_resynced" : "qonto_synced", targetType: "AccBankAccount", targetId: existing.id, newValue: result, ip: req.ip });
      res.json(result);
    } catch (e) {
      if (e instanceof QontoError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

// ───────── Connecteur GoCardless (prélèvements clients + rapprochement) ─────────

function shapeGoCardlessConfig(c: { accessToken: string; sandbox: boolean } | null) {
  if (!c) return { accessTokenSet: false, accessTokenLast4: "", sandbox: false };
  return { accessTokenSet: true, accessTokenLast4: c.accessToken.slice(-4), sandbox: c.sandbox };
}

accountingRouter.get(
  "/acc/gocardless/config",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const config = await prisma.goCardlessConfig.findFirst({ where: { entityId } });
    res.json(shapeGoCardlessConfig(config));
  })
);

interface GoCardlessConfigBody {
  accessToken?: string;
  sandbox?: boolean;
}

/** PUT /wa/acc/gocardless/config — un accessToken vide conserve la valeur déjà enregistrée (même convention que /wa/acc/bank/qonto/config). */
accountingRouter.put(
  "/acc/gocardless/config",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as GoCardlessConfigBody;
    const existing = await prisma.goCardlessConfig.findFirst({ where: { entityId } });
    if (!b.accessToken && !existing) throw new HttpError(400, "accessToken requis à la première configuration");
    const data = { ...(b.accessToken ? { accessToken: b.accessToken } : {}), sandbox: !!b.sandbox };
    const config = existing
      ? await prisma.goCardlessConfig.update({ where: { id: existing.id }, data })
      : await prisma.goCardlessConfig.create({ data: { entityId, accessToken: b.accessToken!, sandbox: !!b.sandbox } });
    await recordAuditLog({ entityId, userId: actorId(req), action: "gocardless_config_updated", targetType: "GoCardlessConfig", targetId: config.id, ip: req.ip });
    res.json(shapeGoCardlessConfig(config));
  })
);

/** POST /wa/acc/gocardless/test — valide les identifiants enregistrés, aucun effet de bord. */
accountingRouter.post(
  "/acc/gocardless/test",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const config = await prisma.goCardlessConfig.findFirst({ where: { entityId } });
    if (!config) throw new HttpError(400, "Identifiants GoCardless non configurés");
    const creds: GoCardlessCredentials = { accessToken: config.accessToken, sandbox: config.sandbox };
    try {
      await testGoCardlessConnection(creds);
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof GoCardlessError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

/** POST /wa/acc/gocardless/sync — synchronise clients/mandats/prélèvements/virements et tente le rapprochement bancaire des virements (cf. lib/gocardless.ts syncGoCardless). */
accountingRouter.post(
  "/acc/gocardless/sync",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    try {
      const result = await syncGoCardless(entityId);
      await recordAuditLog({ entityId, userId: actorId(req), action: "gocardless_synced", targetType: "GoCardlessConfig", targetId: entityId || "crm", newValue: result, ip: req.ip });
      res.json(result);
    } catch (e) {
      if (e instanceof GoCardlessError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

/**
 * GET /wa/acc/gocardless/payouts/:id — détail d'un virement groupé GoCardless
 * (§ "un virement de 1000€ = 4 prélèvements de 250€ de 4 clients") : la
 * liste des prélèvements individuels qui le composent, avec le client
 * résolu — affiché dans la modale de rapprochement bancaire à côté des
 * candidats facture, pour voir d'un coup d'œil QUI compose le montant
 * plutôt que d'ouvrir chaque fiche client une par une.
 */
accountingRouter.get(
  "/acc/gocardless/payouts/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const payout = await prisma.accGoCardlessPayout.findFirst({
      where: { id: req.params.id, entityId },
      include: {
        payments: {
          include: { customer: { select: { id: true, name: true, crmProspectId: true } } },
          orderBy: { chargeDate: "desc" },
        },
      },
    });
    if (!payout) throw new HttpError(404, "Virement GoCardless introuvable");
    res.json(payout);
  })
);

/** Fin de journée inclusive côté "to" — une simple Date(req.query.to) tombe à 00:00:00 et exclurait toute transaction du jour lui-même. */
function endOfDay(dateStr: string): Date {
  const d = new Date(dateStr);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Part de TVA d'un rapprochement — prorata de l'allocation sur le total TTC de la facture (une transaction peut ne régler qu'UNE partie d'une facture, cf. AccBankMatch.allocatedAmount). */
function vatShare(allocatedAmount: number, invoice: { amountVat: number | null; amountTtc: number | null }): number {
  if (!invoice.amountTtc) return 0;
  return allocatedAmount * ((invoice.amountVat || 0) / invoice.amountTtc);
}

accountingRouter.get(
  "/acc/bank/transactions",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const where: Record<string, unknown> = { entityId };
    if (req.query.bankAccountId) where.bankAccountId = req.query.bankAccountId;
    if (req.query.status) where.status = req.query.status;
    if (req.query.from || req.query.to) {
      where.operationDate = {
        ...(req.query.from ? { gte: new Date(req.query.from as string) } : {}),
        ...(req.query.to ? { lte: endOfDay(req.query.to as string) } : {}),
      };
    }
    const take = Math.min(Number(req.query.take) || 100, 500);
    const rows = await prisma.accBankTransaction.findMany({
      where,
      orderBy: { operationDate: "desc" },
      take,
      skip: Number(req.query.skip) || 0,
      include: {
        matches: { select: { allocatedAmount: true, invoice: { select: { amountVat: true, amountTtc: true } } } },
        gocardlessPayout: { select: { id: true, gocardlessId: true } },
      },
    });
    res.json(rows.map((r) => {
      const { matches, ...rest } = r;
      const matchedAmount = matches.reduce((s, m) => s + m.allocatedAmount, 0);
      const vatAmount = matches.reduce((s, m) => s + vatShare(m.allocatedAmount, m.invoice), 0);
      return { ...rest, matchedAmount, vatAmount };
    }));
  })
);

/**
 * GET /wa/acc/bank/vat-summary — TVA collectée (ventes)/déductible (achats)
 * sur la période, calculée sur les factures RAPPROCHÉES en banque dont la
 * transaction tombe dans [from, to] (§ "calculer la TVA du mois" — logique
 * TVA sur les encaissements : la date qui compte est celle du règlement en
 * banque, pas la date de facture). Porte sur TOUS les comptes bancaires de
 * l'entité, pas seulement celui affiché dans la grille (une déclaration TVA
 * ne se limite pas à un seul compte).
 */
accountingRouter.get(
  "/acc/bank/vat-summary",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    if (!req.query.from || !req.query.to) throw new HttpError(400, "from et to requis");
    const matches = await prisma.accBankMatch.findMany({
      where: {
        entityId,
        bankTransaction: { operationDate: { gte: new Date(req.query.from as string), lte: endOfDay(req.query.to as string) } },
      },
      select: {
        allocatedAmount: true,
        invoice: { select: { direction: true, amountVat: true, amountTtc: true } },
      },
    });
    let collectee = 0, deductible = 0;
    for (const m of matches) {
      const share = vatShare(m.allocatedAmount, m.invoice);
      if (m.invoice.direction === "sale") collectee += share;
      else deductible += share;
    }
    res.json({ from: req.query.from, to: req.query.to, collectee, deductible, net: collectee - deductible, matchCount: matches.length });
  })
);

// ───────── Rapprochement bancaire (Phase 3) ─────────

accountingRouter.get(
  "/acc/bank/transactions/:id/matches",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const tx = await prisma.accBankTransaction.findFirst({ where: { id: req.params.id, entityId } });
    if (!tx) throw new HttpError(404, "Transaction introuvable");
    // ?all=1 : toutes les factures ouvertes du même sens/devise, pas
    // seulement les 15 mieux scorées — pour le cas où aucun élément
    // (montant/référence/tiers) ne matche automatiquement mais que
    // l'utilisateur sait, lui, quelle facture affecter.
    const all = req.query.all === "1";
    const [matches, candidates] = await Promise.all([
      prisma.accBankMatch.findMany({ where: { bankTransactionId: tx.id }, include: { invoice: { include: { supplier: true, customer: true } } }, orderBy: { createdAt: "asc" } }),
      findCandidates(tx.id, all ? 500 : 15, all),
    ]);
    const matchedInvoiceIds = new Set(matches.map((m) => m.invoiceId));
    res.json({
      matches,
      candidates: candidates.filter((c) => !matchedInvoiceIds.has(c.invoice.id)),
    });
  })
);

interface ConfirmMatchBody {
  invoiceId?: string;
  allocatedAmount?: number;
}

accountingRouter.post(
  "/acc/bank/transactions/:id/match",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const tx = await prisma.accBankTransaction.findFirst({ where: { id: req.params.id, entityId } });
    if (!tx) throw new HttpError(404, "Transaction introuvable");
    const b = req.body as ConfirmMatchBody;
    if (!b.invoiceId || !b.allocatedAmount) throw new HttpError(400, "invoiceId et allocatedAmount requis");
    const invoice = await prisma.accInvoice.findFirst({ where: { id: b.invoiceId, entityId } });
    if (!invoice) throw new HttpError(404, "Facture introuvable");
    try {
      const result = await confirmMatch(tx.id, invoice.id, b.allocatedAmount, "manual", actorId(req), null);
      await recordAuditLog({
        entityId, userId: actorId(req), action: "bank_match_confirmed", targetType: "AccBankMatch", targetId: result.match.id,
        newValue: { bankTransactionId: tx.id, invoiceId: invoice.id, allocatedAmount: b.allocatedAmount }, ip: req.ip,
      });
      res.json(result);
    } catch (e) {
      if (e instanceof ReconciliationError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);

accountingRouter.delete(
  "/acc/bank/matches/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const match = await prisma.accBankMatch.findFirst({ where: { id: req.params.id, entityId } });
    if (!match) throw new HttpError(404, "Rapprochement introuvable");
    try {
      await unmatch(match.id);
      await recordAuditLog({
        entityId, userId: actorId(req), action: "bank_match_removed", targetType: "AccBankMatch", targetId: match.id,
        oldValue: { bankTransactionId: match.bankTransactionId, invoiceId: match.invoiceId, allocatedAmount: match.allocatedAmount }, ip: req.ip,
      });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof ReconciliationError) throw new HttpError(400, e.message);
      throw e;
    }
  })
);
