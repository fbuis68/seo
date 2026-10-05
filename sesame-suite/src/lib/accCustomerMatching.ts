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

/**
 * Cherche une fiche CRM (CrmProspect) déjà existante pour ce SIRET/SIREN —
 * SIRET > SIREN, même ordre de priorité que matchCustomer ci-dessus.
 * Ignore une correspondance déjà prise par une AUTRE fiche AccCustomer
 * (crmProspectId unique) plutôt que de faire échouer la création avec une
 * violation de contrainte.
 */
async function findLinkableCrmProspect(
  entityId: string | null,
  extracted: { recipientSiren?: string | null; recipientSiret?: string | null }
): Promise<string | undefined> {
  for (const where of [
    extracted.recipientSiret ? { entityId, siret: extracted.recipientSiret } : null,
    extracted.recipientSiren ? { entityId, siren: extracted.recipientSiren } : null,
  ]) {
    if (!where) continue;
    const prospect = await prisma.crmProspect.findFirst({ where });
    if (!prospect) continue;
    const alreadyLinked = await prisma.accCustomer.findUnique({ where: { crmProspectId: prospect.id } });
    if (!alreadyLinked) return prospect.id;
  }
  return undefined;
}

/**
 * Même recherche que findLinkableCrmProspect ci-dessus, mais CRÉE la fiche
 * CRM (type "Client") quand aucune ne correspond (05/10/2026, demande
 * client) — jusqu'ici une société nouvelle rapprochée côté compta restait
 * invisible de la liste "Clients" du CRM tant que personne ne la créait à
 * la main. Jamais appelée sans nom exploitable (cf. appelants :
 * canAutoCreateCustomer exige déjà un identifiant fort + un nom, et la
 * recherche d'entreprise manuelle fournit toujours une raison sociale).
 */
export async function findOrCreateLinkableCrmProspect(
  entityId: string | null,
  info: { name: string; siren?: string | null; siret?: string | null; addressLine?: string | null; postalCode?: string | null; city?: string | null }
): Promise<string> {
  const existing = await findLinkableCrmProspect(entityId, { recipientSiren: info.siren, recipientSiret: info.siret });
  if (existing) return existing;
  const created = await prisma.crmProspect.create({
    data: {
      entityId,
      nom: info.name,
      type: "Client",
      siret: info.siret || undefined,
      siren: info.siren || undefined,
      adresse: info.addressLine || undefined,
      ville: info.city || undefined,
    },
  });
  return created.id;
}

export async function createCustomerFromExtraction(
  entityId: string | null,
  extracted: { recipientName?: string | null; recipientSiren?: string | null; recipientSiret?: string | null; recipientVat?: string | null }
): Promise<AccCustomer> {
  const lookup = extracted.recipientSiret ? await lookupEntrepriseBySiret(extracted.recipientSiret) : null;
  const name = (lookup?.name || extracted.recipientName || "Client sans nom").trim();
  const siren = extracted.recipientSiren || lookup?.siren || undefined;
  const siret = extracted.recipientSiret || lookup?.siret || undefined;
  const addressLine = lookup?.addressLine || undefined;
  const city = lookup?.city || undefined;
  // Rapproche la fiche CRM (CrmProspect) correspondante DÈS LA CRÉATION, et
  // la crée si aucune n'existe (05/10/2026) — sans ça, AccCustomer et
  // CrmProspect restaient deux fiches distinctes du même client tant que
  // personne ne créait la fiche CRM à la main.
  const crmProspectId = await findOrCreateLinkableCrmProspect(entityId, { name, siren, siret, addressLine, city });
  return prisma.accCustomer.create({
    data: {
      entityId,
      name,
      siren,
      siret,
      vatNumber: extracted.recipientVat || undefined,
      addressLine,
      postalCode: lookup?.postalCode || undefined,
      city,
      country: lookup?.country || undefined,
      crmProspectId,
    },
  });
}
