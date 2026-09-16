import { prisma } from "../db";
import { AccEntry } from "@prisma/client";
import { findAccountByNumber } from "./accSeed";
import { nextSequenceValue } from "./sequence";

/**
 * Génération et cycle de vie des écritures comptables (§19,20,33,34,44,45).
 * Toute écriture naît en statut DRAFT (§19 : "avant validation") ; un
 * numéro définitif n'est attribué qu'à la validation explicite (§44),
 * jamais réutilisé. Une écriture VALIDATED n'est jamais supprimée
 * silencieusement — sa correction passe par une écriture d'extourne
 * (reverseEntry ci-dessous).
 *
 * Verrouillage de période (§45, clôture mensuelle/annuelle) : PAS encore
 * implémenté dans cette phase — aucun modèle de "période verrouillée" en
 * base. À ajouter avant une mise en production réelle du module.
 */

export class EntryGenerationError extends Error {}

/**
 * Génère l'écriture DRAFT d'une facture déjà validée (§19 achat / §20
 * vente) — appelé automatiquement à la validation d'une facture (cf.
 * routes/accounting.ts POST /acc/invoices/:id/validate) plutôt qu'à la
 * main : le montant, le compte de contrepartie et le tiers sont déjà
 * connus à ce stade, générer l'écriture immédiatement évite une étape
 * manuelle redondante — mais elle reste en DRAFT tant qu'un comptable ne
 * l'a pas validée à son tour (cf. validateEntry).
 */
export async function generateDraftEntry(invoiceId: string): Promise<AccEntry> {
  const invoice = await prisma.accInvoice.findUnique({
    where: { id: invoiceId },
    include: { vatLines: true, supplier: true, customer: true },
  });
  if (!invoice) throw new EntryGenerationError("Facture introuvable");
  if (invoice.entryId) throw new EntryGenerationError("Une écriture existe déjà pour cette facture");
  if (invoice.amountHt === null || invoice.amountTtc === null) {
    throw new EntryGenerationError("Montants insuffisants pour générer une écriture (HT et/ou TTC manquant)");
  }
  const vatAmount = invoice.amountVat ?? invoice.vatLines.reduce((s, l) => s + l.vatAmount, 0);
  if (Math.abs(invoice.amountHt + vatAmount - invoice.amountTtc) > 0.02) {
    throw new EntryGenerationError("HT + TVA ne correspond pas au TTC — corrigez les montants avant de générer l'écriture");
  }
  if (!invoice.proposedAccountId) {
    throw new EntryGenerationError(`Aucun compte de ${invoice.direction === "sale" ? "produit" : "charge"} proposé pour cette facture`);
  }

  const isPurchase = invoice.direction !== "sale";
  const journalCode = isPurchase ? "ACH" : "VEN";
  const journal = await prisma.accJournal.findFirst({ where: { entityId: invoice.entityId, code: journalCode } });
  if (!journal) throw new EntryGenerationError(`Journal "${journalCode}" introuvable — initialisez d'abord le plan comptable (seedAccounting)`);

  const tiersAccount = await findAccountByNumber(invoice.entityId, isPurchase ? "401000" : "411000");
  if (!tiersAccount) throw new EntryGenerationError(`Compte "${isPurchase ? "401000" : "411000"}" introuvable`);

  let vatAccount = null;
  if (vatAmount > 0.02) {
    vatAccount = await findAccountByNumber(invoice.entityId, isPurchase ? "445660" : "445710");
    if (!vatAccount) throw new EntryGenerationError(`Compte de TVA "${isPurchase ? "445660" : "445710"}" introuvable`);
  }

  const thirdPartyName = isPurchase ? invoice.supplier?.name || invoice.issuerName : invoice.customer?.name;
  const label = [thirdPartyName, invoice.invoiceNumber].filter(Boolean).join(" — ") || "Facture";
  const auxiliaryRef = isPurchase ? invoice.supplierId || undefined : invoice.customerId || undefined;

  const lines: { accountId: string; label: string; debit: number; credit: number; auxiliaryRef?: string }[] = [];
  if (isPurchase) {
    lines.push({ accountId: invoice.proposedAccountId, label, debit: round2(invoice.amountHt), credit: 0 });
    if (vatAccount) lines.push({ accountId: vatAccount.id, label: "TVA déductible", debit: round2(vatAmount), credit: 0 });
    lines.push({ accountId: tiersAccount.id, label, debit: 0, credit: round2(invoice.amountTtc), auxiliaryRef });
  } else {
    lines.push({ accountId: tiersAccount.id, label, debit: round2(invoice.amountTtc), credit: 0, auxiliaryRef });
    lines.push({ accountId: invoice.proposedAccountId, label, debit: 0, credit: round2(invoice.amountHt) });
    if (vatAccount) lines.push({ accountId: vatAccount.id, label: "TVA collectée", debit: 0, credit: round2(vatAmount) });
  }
  assertBalanced(lines);

  const entry = await prisma.accEntry.create({
    data: {
      entityId: invoice.entityId,
      journalId: journal.id,
      date: invoice.invoiceDate || new Date(),
      reference: invoice.invoiceNumber || undefined,
      label,
      status: "DRAFT",
      lines: { create: lines },
    },
  });
  await prisma.accInvoice.update({ where: { id: invoice.id }, data: { entryId: entry.id } });
  return entry;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function assertBalanced(lines: { debit: number; credit: number }[]): void {
  const debit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const credit = round2(lines.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(debit - credit) > 0.02) {
    throw new EntryGenerationError(`Écriture déséquilibrée (débit ${debit} ≠ crédit ${credit}) — génération refusée`);
  }
}

/**
 * Valide une écriture DRAFT (§44) — lui attribue un numéro définitif
 * (compteur atomique par journal+année, cf. lib/sequence.ts, jamais
 * réutilisé) et fait passer la facture liée en ACCOUNTED. Une écriture
 * déjà VALIDATED ne peut pas être re-validée (idempotence — cf. §61).
 */
export async function validateEntry(entryId: string, userId: string | null): Promise<AccEntry> {
  const entry = await prisma.accEntry.findUnique({ where: { id: entryId }, include: { journal: true, invoice: true } });
  if (!entry) throw new EntryGenerationError("Écriture introuvable");
  if (entry.status === "VALIDATED") return entry; // idempotent — cf. §61, pas d'erreur sur un second appel

  const year = entry.date.getFullYear();
  const n = await nextSequenceValue(`entry-${entry.journal.code}-${year}`);
  const number = `${entry.journal.code}-${year}-${String(n).padStart(5, "0")}`;

  const updated = await prisma.accEntry.update({
    where: { id: entryId },
    data: { number, status: "VALIDATED", validatedAt: new Date(), validatedBy: userId || undefined },
  });

  if (entry.invoice) {
    await prisma.accInvoice.update({ where: { id: entry.invoice.id }, data: { status: "ACCOUNTED" } });
  }
  return updated;
}

/**
 * Écriture d'extourne (§44) — seul moyen de corriger une écriture déjà
 * VALIDATED : jamais de suppression ni de modification directe. Inverse
 * chaque ligne (débit ↔ crédit) dans le MÊME journal, validée et numérotée
 * immédiatement (une extourne est par nature déjà définitive).
 */
export async function reverseEntry(entryId: string, userId: string | null, reason?: string): Promise<AccEntry> {
  const original = await prisma.accEntry.findUnique({ where: { id: entryId }, include: { lines: true, journal: true } });
  if (!original) throw new EntryGenerationError("Écriture introuvable");
  if (original.status !== "VALIDATED") throw new EntryGenerationError("Seule une écriture validée peut être extournée");

  const year = new Date().getFullYear();
  const n = await nextSequenceValue(`entry-${original.journal.code}-${year}`);
  const number = `${original.journal.code}-${year}-${String(n).padStart(5, "0")}`;

  return prisma.accEntry.create({
    data: {
      entityId: original.entityId,
      journalId: original.journalId,
      date: new Date(),
      reference: original.reference,
      label: `Extourne — ${original.label}${reason ? ` (${reason})` : ""}`,
      status: "VALIDATED",
      number,
      validatedAt: new Date(),
      validatedBy: userId || undefined,
      reversalOfEntryId: original.id,
      lines: {
        create: original.lines.map((l) => ({ accountId: l.accountId, label: l.label, debit: l.credit, credit: l.debit, auxiliaryRef: l.auxiliaryRef })),
      },
    },
  });
}
