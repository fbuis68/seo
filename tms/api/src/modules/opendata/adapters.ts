import { parseCsv, decodeText } from '../migration/tabular';
import { normHeader } from '../migration/profiles';
import { PublicRecordInput } from './opendata.service';

const pick = (row: Record<string, string>, ...names: string[]) => {
  const norm = Object.fromEntries(Object.entries(row).map(([k, v]) => [normHeader(k), v]));
  for (const n of names) if (norm[n]) return norm[n];
  return '';
};

/**
 * Adaptateurs versionnés de fichiers OpenData. Les en-têtes sont résolus par alias ;
 * un changement de schéma (champ clé introuvable) produit une erreur → quarantaine.
 */
export const ADAPTERS: Record<string, (buf: Buffer) => PublicRecordInput[]> = {
  dgefp_of: (buf) => {
    const t = parseCsv(decodeText(buf).text);
    const recs = t.rows.map((r) => {
      const nda = pick(r, 'numerodeclarationactivite', 'numero_declaration_activite', 'nda');
      const name = pick(r, 'denomination', 'raison_sociale');
      return { key: nda, searchText: `${nda} ${name} ${pick(r, 'siren')}`, data: {
        nda, name, siren: pick(r, 'siren'), siret: pick(r, 'siretetablissementdeclarant', 'siret'),
        qualiopi: { actions: pick(r, 'certifications_actionsdeformation', 'actions_de_formation'), bilans: pick(r, 'certifications_bilansdecompetences', 'bilans_de_competences'),
          vae: pick(r, 'certifications_vae', 'vae'), apprentissage: pick(r, 'certifications_actionsdeformationparapprentissage', 'apprentissage') },
        city: pick(r, 'adressephysiqueorganismeformation_ville', 'ville'), postalCode: pick(r, 'adressephysiqueorganismeformation_codepostal', 'code_postal'),
      } };
    }).filter((r) => r.key);
    if (t.rows.length && !recs.length) throw new Error('Schéma modifié : numéro de déclaration introuvable');
    return recs;
  },
  rncp_rs: (buf) => {
    const t = parseCsv(decodeText(buf).text);
    const recs = t.rows.map((r) => {
      const code = pick(r, 'numero_fiche', 'code_rncp', 'numero');
      const title = pick(r, 'intitule', 'libelle');
      return { key: code, searchText: `${code} ${title}`, data: { code, title, active: pick(r, 'actif', 'etat_fiche'), level: pick(r, 'nomenclature_europe_niveau', 'niveau'),
        validUntil: pick(r, 'date_fin_enregistrement', 'date_de_fin'), certifiers: pick(r, 'certificateurs', 'nom_certificateur') } };
    }).filter((r) => r.key);
    if (t.rows.length && !recs.length) throw new Error('Schéma modifié : code de fiche introuvable');
    return recs;
  },
  mcf_offre: (buf) => {
    const t = parseCsv(decodeText(buf).text);
    return t.rows.map((r) => {
      const id = pick(r, 'id_action', 'numero_action', 'id_offre', 'code_action');
      const title = pick(r, 'intitule_formation', 'intitule_certification', 'intitule');
      return { key: id, searchText: `${id} ${title} ${pick(r, 'nom_of', 'raison_sociale')} ${pick(r, 'code_rncp', 'code_inventaire')} ${pick(r, 'siret')}`, data: {
        id, title, provider: pick(r, 'nom_of', 'raison_sociale'), siret: pick(r, 'siret', 'siret_of'), certification: pick(r, 'code_rncp', 'code_rs', 'code_inventaire'),
        city: pick(r, 'nom_departement', 'ville', 'nom_region'), price: pick(r, 'frais_ttc_tot_mean', 'prix', 'frais_ttc'), hours: pick(r, 'nombre_heures_total_mean', 'duree_heures'),
        mode: pick(r, 'type_modalite', 'modalite'),
      } };
    }).filter((r) => r.key);
  },
};
