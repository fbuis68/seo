import { Router } from "express";
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

// ───────────────────────── Factures ─────────────────────────

accountingRouter.get(
  "/acc/invoices",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const { status, direction, supplierId, q } = req.query as Record<string, string | undefined>;
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
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.accInvoice.findMany({
        where,
        include: { supplier: { select: { id: true, name: true } }, document: { select: { originalFilename: true, mimeType: true } } },
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
      include: { supplier: true, customer: true, document: true, lines: true, vatLines: true, proposedAccount: true, entry: { include: { lines: { include: { account: true } } } } },
    });
    if (!invoice) throw new HttpError(404, "Facture introuvable");
    res.json(invoice);
  })
);

const EDITABLE_INVOICE_FIELDS = [
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
  "supplierId",
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
      if ((field === "invoiceDate" || field === "dueDate" || field === "serviceDate") && value) value = new Date(value as string);
      data[field] = value;
      oldValue[field] = (existing as unknown as Record<string, unknown>)[field];
    }
    if (!Object.keys(data).length) throw new HttpError(400, "Aucun champ à modifier");

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

accountingRouter.post(
  "/acc/suppliers",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entityId = await resolveScope(req);
    const b = req.body as { name?: string };
    if (!b.name) throw new HttpError(400, "name requis");
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
    const updated = await prisma.accSupplier.update({ where: { id: existing.id }, data });
    await recordAuditLog({ entityId, userId: actorId(req), action: "supplier_updated", targetType: "AccSupplier", targetId: existing.id, oldValue: existing, newValue: data, ip: req.ip });
    res.json(updated);
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
