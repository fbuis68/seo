import { CANONICAL, EntityType } from './canonical';

/**
 * Profils de compatibilité versionnés (§6.1). Un profil ne devient "validated" qu'après
 * recette sur au moins deux sauvegardes représentatives anonymisées par produit/version.
 * Les profils Dendreo/Digiforma ci-dessous sont PROVISOIRES : hypothèses d'en-têtes à
 * confirmer sur paquets réels ; l'interface n'affiche jamais "compatible" pour eux.
 */
export interface FileRule { entity: EntityType; file: RegExp; aliases: Partial<Record<string, string[]>> }
export interface Profile {
  code: string; version: string; software: string; label: string;
  status: 'validated' | 'provisional'; obtain: string; limits: string[]; rules: FileRule[]; testedOn?: string;
}

export const normHeader = (h: string) => h.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const COMMON: Record<EntityType, Partial<Record<string, string[]>>> = {
  client: {
    external_id: ['id', 'id_client', 'id_entreprise', 'identifiant', 'code_client', 'reference'], name: ['nom', 'raison_sociale', 'entreprise', 'societe', 'client', 'nom_client', 'denomination'],
    kind: ['type', 'type_client', 'forme'], siret: ['siret', 'n_siret', 'numero_siret'], email: ['email', 'e_mail', 'mail', 'email_facturation'],
    address: ['adresse', 'adresse_1', 'rue'], postal_code: ['code_postal', 'cp'], city: ['ville', 'commune'], is_funder: ['financeur', 'opco', 'est_financeur'],
    is_customer: ['client_facture', 'est_client'],
  },
  person: {
    external_id: ['id', 'id_apprenant', 'id_stagiaire', 'id_personne', 'id_participant', 'identifiant'], first_name: ['prenom', 'first_name'],
    last_name: ['nom', 'nom_de_famille', 'last_name'], email: ['email', 'e_mail', 'mail'], phone: ['telephone', 'tel', 'portable', 'mobile'],
    role: ['role', 'type', 'profil'], client_ref: ['id_client', 'id_entreprise', 'entreprise_id', 'client_id'],
  },
  program: {
    external_id: ['id', 'id_programme', 'id_formation', 'identifiant'], code: ['code', 'reference', 'code_formation'],
    title: ['intitule', 'titre', 'nom', 'formation', 'programme', 'libelle'], duration_hours: ['duree', 'duree_heures', 'nb_heures', 'duree_h'],
    modality: ['modalite', 'format', 'type_formation'], objectives: ['objectifs', 'objectifs_pedagogiques'], price_ht: ['prix_ht', 'tarif_ht', 'prix'],
    vat_rate: ['tva', 'taux_tva'], rncp_code: ['rncp', 'code_rncp'],
  },
  session: {
    external_id: ['id', 'id_session', 'identifiant'], program_ref: ['id_programme', 'id_formation', 'programme_id', 'formation_id'],
    title: ['intitule', 'titre', 'nom', 'libelle'], kind: ['type', 'inter_intra', 'type_session'], client_ref: ['id_client', 'id_entreprise', 'client_id'],
    starts_on: ['date_debut', 'debut', 'date_de_debut', 'start'], ends_on: ['date_fin', 'fin', 'date_de_fin', 'end'], capacity: ['capacite', 'places', 'nb_places', 'effectif_max'],
    location: ['lieu', 'adresse', 'ville'], status: ['statut', 'etat', 'status'],
  },
  enrollment: {
    external_id: ['id', 'id_inscription'], session_ref: ['id_session', 'session_id', 'session'], person_ref: ['id_apprenant', 'id_stagiaire', 'id_personne', 'apprenant_id', 'id_participant'],
    client_ref: ['id_client', 'id_entreprise', 'client_id', 'payeur'], status: ['statut', 'etat', 'status'],
  },
  attendance: {
    external_id: ['id', 'id_emargement'], session_ref: ['id_session', 'session_id'], person_ref: ['id_apprenant', 'id_stagiaire', 'id_personne', 'apprenant_id'],
    starts_at: ['debut', 'date_heure_debut', 'debut_creneau', 'creneau_debut'], ends_at: ['fin', 'date_heure_fin', 'fin_creneau', 'creneau_fin'],
    status: ['presence', 'statut', 'etat'], minutes: ['minutes', 'duree_minutes', 'minutes_effectuees'],
  },
  invoice: {
    external_id: ['id', 'id_facture'], number: ['numero', 'n_facture', 'numero_facture', 'num_facture'], kind: ['type', 'type_piece'],
    client_ref: ['id_client', 'id_entreprise', 'client_id'], session_ref: ['id_session', 'session_id'], issue_date: ['date', 'date_facture', 'date_emission'],
    due_date: ['echeance', 'date_echeance'], total_ht: ['total_ht', 'montant_ht', 'ht'], total_vat: ['tva', 'montant_tva', 'total_tva'],
    total_ttc: ['total_ttc', 'montant_ttc', 'ttc'], currency: ['devise', 'monnaie'], pdf_path: ['fichier', 'pdf', 'chemin_pdf'],
  },
  payment: {
    external_id: ['id', 'id_reglement', 'id_paiement'], client_ref: ['id_client', 'id_entreprise', 'client_id'], invoice_ref: ['id_facture', 'facture_id', 'numero_facture'],
    amount: ['montant', 'montant_ttc', 'amount'], received_on: ['date', 'date_reglement', 'date_paiement', 'date_encaissement'], method: ['mode', 'mode_reglement', 'moyen'],
    reference: ['reference', 'libelle'],
  },
  document: { path: ['fichier', 'chemin', 'path'], owner_type: ['objet', 'type_objet'], owner_ref: ['id_objet', 'reference_objet'], kind: ['type', 'type_document', 'nature'] },
};

const rules = (patterns: Record<EntityType, RegExp>): FileRule[] =>
  (Object.keys(patterns) as EntityType[]).map((entity) => ({ entity, file: patterns[entity], aliases: COMMON[entity] }));

export const PROFILES: Profile[] = [
  {
    code: 'generic', version: '1.0', software: 'generic', label: 'Paquet de fichiers documenté (CSV/XLSX)', status: 'validated', testedOn: 'fixtures synthétiques',
    obtain: 'Un fichier par objet (clients, apprenants, programmes, sessions, inscriptions, présences, factures, règlements) + dossier de pièces, regroupés dans un ZIP.',
    limits: ['Associations de colonnes à confirmer', 'Pièces rattachées par documents.csv ou chemin pdf des factures'],
    rules: rules({
      client: /(^|\/)(clients?|entreprises?|societes?|financeurs?)[^/]*\.(csv|xlsx|json)$/i,
      person: /(^|\/)(apprenants?|stagiaires?|personnes?|participants?|formateurs?|contacts?)[^/]*\.(csv|xlsx|json)$/i,
      program: /(^|\/)(programmes?|formations?|catalogue)[^/]*\.(csv|xlsx|json)$/i,
      session: /(^|\/)sessions?[^/]*\.(csv|xlsx|json)$/i,
      enrollment: /(^|\/)inscriptions?[^/]*\.(csv|xlsx|json)$/i,
      attendance: /(^|\/)(presences?|emargements?)[^/]*\.(csv|xlsx|json)$/i,
      invoice: /(^|\/)(factures?|avoirs?)[^/]*\.(csv|xlsx|json)$/i,
      payment: /(^|\/)(reglements?|paiements?|encaissements?)[^/]*\.(csv|xlsx|json)$/i,
      document: /(^|\/)(documents?|pieces?)\.(csv|xlsx|json)$/i,
    }),
  },
  {
    code: 'dendreo', version: '0.1-provisoire', software: 'dendreo', label: 'Dendreo — archive des exports officiels', status: 'provisional',
    obtain: "Depuis Dendreo : exports de listings / bibliothèque d'extractions (entreprises, participants, actions de formation, sessions, inscriptions, factures, règlements) + pièces locales, regroupés dans un ZIP. Aucun identifiant Dendreo n'est demandé.",
    limits: ["Profil non validé sur sauvegardes réelles : couverture à confirmer", 'Lecture d’un format de sauvegarde propriétaire non annoncée'],
    rules: rules({
      client: /(entreprises?|clients?|financeurs?)[^/]*\.(csv|xlsx)$/i, person: /(participants?|stagiaires?|contacts?|formateurs?)[^/]*\.(csv|xlsx)$/i,
      program: /(actions?_de_formation|actions?|modules?)[^/]*\.(csv|xlsx)$/i, session: /sessions?[^/]*\.(csv|xlsx)$/i,
      enrollment: /(inscriptions?|participations?)[^/]*\.(csv|xlsx)$/i, attendance: /(emargements?|presences?)[^/]*\.(csv|xlsx)$/i,
      invoice: /factures?[^/]*\.(csv|xlsx)$/i, payment: /(reglements?|paiements?)[^/]*\.(csv|xlsx)$/i, document: /documents?\.(csv|xlsx)$/i,
    }),
  },
  {
    code: 'digiforma', version: '0.1-provisoire', software: 'digiforma', label: 'Digiforma — archive des exports Excel/PDF', status: 'provisional',
    obtain: 'Depuis Digiforma : « exporter toutes ses données » (exports administratifs, commerciaux, qualité) + PDF d’émargement et pièces selon l’offre, regroupés dans un ZIP.',
    limits: ['Profil non validé sur sauvegardes réelles : couverture à confirmer', 'Un PDF qualité reste une synthèse : réponses individuelles non reconstituées'],
    rules: rules({
      client: /(entreprises?|clients?|financeurs?)[^/]*\.(xlsx|csv)$/i, person: /(apprenants?|stagiaires?|formateurs?|contacts?)[^/]*\.(xlsx|csv)$/i,
      program: /(programmes?|formations?)[^/]*\.(xlsx|csv)$/i, session: /sessions?[^/]*\.(xlsx|csv)$/i,
      enrollment: /inscriptions?[^/]*\.(xlsx|csv)$/i, attendance: /(emargements?|presences?|assiduite)[^/]*\.(xlsx|csv)$/i,
      invoice: /factures?[^/]*\.(xlsx|csv)$/i, payment: /(reglements?|paiements?)[^/]*\.(xlsx|csv)$/i, document: /documents?\.(xlsx|csv)$/i,
    }),
  },
];

export const NATIVE_PROFILE = {
  code: 'native', version: '1.0', software: 'native', label: 'Export natif de cette application', status: 'validated' as const,
  obtain: 'Archive ZIP produite par « Exporter toutes mes données ».', limits: ['Secrets (clés, mots de passe) non inclus : à ressaisir'],
};

export interface FileMapping { path: string; entity: EntityType; columns: Record<string, string> }

/** Associe automatiquement les colonnes d'un fichier aux champs canoniques. */
export function autoMap(rule: FileRule, headers: string[]): Record<string, string> {
  const byNorm = new Map(headers.map((h) => [normHeader(h), h]));
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const field of Object.keys(CANONICAL[rule.entity])) {
    for (const alias of [field, ...(rule.aliases[field] ?? [])]) {
      const h = byNorm.get(alias);
      if (h && !used.has(h)) { out[field] = h; used.add(h); break; }
    }
  }
  return out;
}

export function requiredFields(entity: EntityType) {
  return Object.entries(CANONICAL[entity]).filter(([, d]) => d.required).map(([k]) => k);
}

/** Détection : score par profil = part des fichiers tabulaires reconnus avec champs obligatoires présents. */
export function detectProfiles(tables: { path: string; columns: string[] }[]) {
  return PROFILES.map((p) => {
    const files: FileMapping[] = [];
    for (const t of tables) {
      const rule = p.rules.find((r) => r.file.test(t.path));
      if (!rule) continue;
      const columns = autoMap(rule, t.columns);
      files.push({ path: t.path, entity: rule.entity, columns });
    }
    const complete = files.filter((f) => requiredFields(f.entity).every((r) => f.columns[r]));
    const confidence = tables.length ? Math.round((complete.length / tables.length) * 100) / 100 : 0;
    return { profile: p.code, version: p.version, status: p.status, label: p.label, confidence, files };
  }).sort((a, b) => b.confidence - a.confidence);
}
