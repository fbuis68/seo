/**
 * Registre des sources OpenData (§8.2). Une source n'est "active" qu'après validation
 * licence/accès/schéma et recette ; la présence d'un lien ne suffit pas.
 */
export interface SourceDef {
  code: string; producer: string; name: string; family: string; url: string; license: string;
  accessMode: 'bulk_file' | 'public_api' | 'not_open'; state: 'proposed' | 'awaiting_access' | 'licensed' | 'active' | 'stale' | 'broken' | 'excluded';
  priority: 'P0' | 'P1' | 'P2'; cadence: string; decisionNote: string;
}

export const SOURCES: SourceDef[] = [
  { code: 'dgefp_of', producer: 'DGEFP', name: 'Liste publique des organismes de formation (L.6351-7-1) et certification qualité', family: 'organismes',
    url: 'https://www.data.gouv.fr/datasets/liste-publique-des-organismes-de-formation-l-6351-7-1-du-code-du-travail', license: 'Licence Ouverte 2.0',
    accessMode: 'bulk_file', state: 'licensed', priority: 'P0', cadence: 'quotidienne', decisionNote: 'Préremplissage NDA/SIREN, catégories qualité publiées. Absence ≠ preuve de non-conformité.' },
  { code: 'rncp_rs', producer: 'France compétences', name: 'Répertoire national des certifications professionnelles et répertoire spécifique', family: 'certifications',
    url: 'https://www.data.gouv.fr/datasets/repertoire-national-des-certifications-professionnelles-et-repertoire-specifique', license: 'Licence Ouverte 2.0',
    accessMode: 'bulk_file', state: 'licensed', priority: 'P0', cadence: 'quotidienne', decisionNote: 'Recherche certifications, statut, blocs ; lien programme.' },
  { code: 'sirene', producer: 'INSEE / DINUM', name: 'Recherche d’entreprises (Sirene, diffusion publique)', family: 'entreprises',
    url: 'https://recherche-entreprises.api.gouv.fr', license: 'Licence Ouverte 2.0',
    accessMode: 'public_api', state: 'active', priority: 'P0', cadence: 'à la demande, cache 7 jours', decisionNote: 'Respect de la diffusion partielle ; préremplissage validé par l’utilisateur.' },
  { code: 'mcf_offre', producer: 'Caisse des Dépôts', name: 'Mon Compte Formation — l’offre de formation', family: 'cpf',
    url: 'https://www.data.gouv.fr/datasets/moncompteformation-loffre-de-formation', license: 'Licence Ouverte 2.0',
    accessMode: 'bulk_file', state: 'licensed', priority: 'P0', cadence: 'quotidienne', decisionNote: 'Couverture partielle (permis, bilans, VAE… absents) affichée. Offre retrouvée ≠ financement.' },
  { code: 'mcf_engagees', producer: 'Caisse des Dépôts', name: 'Mon Compte Formation — formations engagées', family: 'cpf',
    url: 'https://www.data.gouv.fr/datasets/moncompteformation-les-formations-engagees', license: 'Licence Ouverte 2.0',
    accessMode: 'bulk_file', state: 'licensed', priority: 'P0', cadence: 'hebdomadaire (publication mensuelle)', decisionNote: 'Nombre de dossiers ≠ titulaires uniques ; agrégats non additionnés.' },
  { code: 'mcf_usagers', producer: 'Caisse des Dépôts', name: 'Mon Compte Formation — usagers', family: 'cpf',
    url: 'https://www.data.gouv.fr/datasets/moncompteformation-les-usagers', license: 'Licence Ouverte 2.0',
    accessMode: 'bulk_file', state: 'proposed', priority: 'P0', cadence: 'hebdomadaire (publication trimestrielle)', decisionNote: 'Valeurs masquées conservées null ; jamais reconstituées.' },
  { code: 'certif_info', producer: 'Réseau Carif-Oref', name: 'Certif Info — référentiel national des certifications', family: 'certifications',
    url: 'https://www.data.gouv.fr/datasets/referentiel-national-des-certifications', license: 'À vérifier par publication',
    accessMode: 'bulk_file', state: 'proposed', priority: 'P1', cadence: 'à définir', decisionNote: 'Licence et conditions de réutilisation à valider.' },
  { code: 'rome', producer: 'France Travail', name: 'ROME — fiches métiers', family: 'metiers',
    url: 'https://www.francetravail.fr/employeur/vos-recrutements/le-rome-et-les-fiches-metiers.html', license: 'À vérifier',
    accessMode: 'public_api', state: 'awaiting_access', priority: 'P1', cadence: 'à définir', decisionNote: 'Accès API à obtenir ; aucune donnée candidat.' },
  { code: 'ban', producer: 'IGN / DINUM', name: 'Base Adresse Nationale', family: 'territoires',
    url: 'https://www.data.gouv.fr/datasets/base-adresse-nationale', license: 'Licence Ouverte 2.0',
    accessMode: 'public_api', state: 'proposed', priority: 'P1', cadence: 'à la demande, cache', decisionNote: 'Autocomplétion adresse.' },
  { code: 'insee_cog', producer: 'INSEE', name: 'Code officiel géographique', family: 'territoires',
    url: 'https://www.insee.fr/fr/information/2560452', license: 'Licence Ouverte 2.0',
    accessMode: 'bulk_file', state: 'proposed', priority: 'P1', cadence: 'annuelle (millésime)', decisionNote: 'Normalisation région/département.' },
  { code: 'mcf_droits_personnels', producer: 'Caisse des Dépôts', name: 'Droits CPF individuels', family: 'cpf',
    url: 'https://www.moncompteformation.gouv.fr/espace-public/consulter-mes-droits-formation', license: 'Données personnelles',
    accessMode: 'not_open', state: 'excluded', priority: 'P2', cadence: '—', decisionNote: 'Exclu : données personnelles, pas OpenData. Aucune connexion à un compte personnel.' },
];
