/**
 * Recherche d'entreprises via l'API publique du même nom (data.gouv.fr,
 * recherche-entreprises.api.gouv.fr) — gratuite, sans clé, interroge
 * directement le répertoire SIRENE de l'INSEE par SIRET/SIREN ou
 * dénomination. Même API et même mapping de champs que côté client
 * (public/crm.html, entrepriseAutocomplete/pickEntreprise, fiche
 * CrmProspect) — utilisée ici côté serveur pour fiabiliser le nom et
 * l'adresse d'un fournisseur créé automatiquement à partir d'une facture
 * (cf. lib/accSupplierMatching.ts), le SIRET extrait étant un identifiant
 * beaucoup plus fiable que l'heuristique de raison sociale (première ligne
 * du texte, cf. lib/accExtraction.ts).
 */

export interface EntrepriseLookupResult {
  name: string;
  siret: string | null;
  siren: string | null;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
}

interface EntrepriseApiSiege {
  siret?: string;
  numero_voie?: string;
  type_voie?: string;
  libelle_voie?: string;
  code_postal?: string;
  libelle_commune?: string;
}

interface EntrepriseApiResult {
  nom_complet?: string;
  nom_raison_sociale?: string;
  siren?: string;
  siege?: EntrepriseApiSiege;
}

/**
 * Recherche par SIRET exact — le SIRET queried doit correspondre au SIRET
 * du siège renvoyé, sinon on ne renvoie rien plutôt que le premier résultat
 * approchant (l'API répond aussi sur une recherche par texte approximatif,
 * pas seulement une correspondance exacte de numéro).
 */
export async function lookupEntrepriseBySiret(siret: string): Promise<EntrepriseLookupResult | null> {
  const clean = siret.replace(/\s/g, "");
  if (!/^\d{14}$/.test(clean)) return null;

  let data: { results?: EntrepriseApiResult[] };
  try {
    const r = await fetch(`https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(clean)}&limit=3`);
    if (!r.ok) return null;
    data = (await r.json()) as { results?: EntrepriseApiResult[] };
  } catch {
    return null;
  }

  const match = (data.results || []).find((e) => e.siege?.siret === clean);
  if (!match) return null;

  const siege = match.siege || {};
  const street = [siege.numero_voie, siege.type_voie, siege.libelle_voie].filter(Boolean).join(" ") || null;
  return {
    name: match.nom_complet || match.nom_raison_sociale || "",
    siret: siege.siret || clean,
    siren: match.siren || clean.slice(0, 9),
    addressLine: street,
    postalCode: siege.code_postal || null,
    city: siege.libelle_commune || null,
    country: "FR",
  };
}
