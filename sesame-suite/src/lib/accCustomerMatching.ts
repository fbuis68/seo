import { prisma } from "../db";
import { AccCustomer } from "@prisma/client";
import { lookupEntrepriseBySiret } from "./entrepriseApi";

/**
 * Rapprochement client (facture de vente) — même logique/ordre de priorité
 * que matchSupplier (lib/accSupplierMatching.ts) : SIRET > TVA > SIREN >
 * raison sociale. Pas d'IBAN ici (AccCustomer n'en stocke pas — un client
 * ne nous verse pas via un IBAN qui lui serait propre de la même façon
 * qu'un fournisseur, cf. schema.prisma).
 */
export interface CustomerMatchResult {
  customer: AccCustomer | null;
  confidence: number;
  matchedBy: string | null;
}

function normalizeCompanyName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(sas|sarl|sa|sasu|eurl|sci|ei|snc)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function matchCustomer(
  entityId: string | null,
  extracted: { recipientSiret?: string | null; recipientSiren?: string | null; recipientVat?: string | null; recipientName?: string | null }
): Promise<CustomerMatchResult> {
  if (extracted.recipientSiret) {
    const c = await prisma.accCustomer.findFirst({ where: { entityId, siret: extracted.recipientSiret } });
    if (c) return { customer: c, confidence: 0.98, matchedBy: "siret" };
  }
  if (extracted.recipientVat) {
    const c = await prisma.accCustomer.findFirst({ where: { entityId, vatNumber: extracted.recipientVat } });
    if (c) return { customer: c, confidence: 0.95, matchedBy: "vat" };
  }
  if (extracted.recipientSiren) {
    const c = await prisma.accCustomer.findFirst({ where: { entityId, siren: extracted.recipientSiren } });
    if (c) return { customer: c, confidence: 0.9, matchedBy: "siren" };
  }
  if (extracted.recipientName) {
    const target = normalizeCompanyName(extracted.recipientName);
    if (target) {
      const candidates = await prisma.accCustomer.findMany({ where: { entityId } });
      const match = candidates.find((c) => normalizeCompanyName(c.name) === target);
      if (match) return { customer: match, confidence: 0.6, matchedBy: "name" };
    }
  }
  return { customer: null, confidence: 0, matchedBy: null };
}

/** Même garde-fou que canAutoCreateSupplier : jamais de fiche créée sur un nom seul, mal extrait. */
export function canAutoCreateCustomer(extracted: { recipientSiret?: string | null; recipientSiren?: string | null; recipientVat?: string | null; recipientName?: string | null }): boolean {
  return !!(extracted.recipientName && (extracted.recipientSiret || extracted.recipientSiren || extracted.recipientVat));
}

export async function createCustomerFromExtraction(
  entityId: string | null,
  extracted: { recipientName?: string | null; recipientSiren?: string | null; recipientSiret?: string | null; recipientVat?: string | null }
): Promise<AccCustomer> {
  const lookup = extracted.recipientSiret ? await lookupEntrepriseBySiret(extracted.recipientSiret) : null;
  return prisma.accCustomer.create({
    data: {
      entityId,
      name: (lookup?.name || extracted.recipientName || "Client sans nom").trim(),
      siren: extracted.recipientSiren || lookup?.siren || undefined,
      siret: extracted.recipientSiret || lookup?.siret || undefined,
      vatNumber: extracted.recipientVat || undefined,
      addressLine: lookup?.addressLine || undefined,
      postalCode: lookup?.postalCode || undefined,
      city: lookup?.city || undefined,
      country: lookup?.country || undefined,
    },
  });
}
