/**
 * Questions du questionnaire de qualification (07/09/2026) — une par module
 * du catalogue Souscriptions (cf. SUB_MODULES dans public/admin.html), à
 * l'exception de "room" (Choix de chambre & Plan), module de base fourni à
 * tout établissement et donc sans valeur de qualification commerciale.
 * Source unique consommée à la fois par la page publique du questionnaire
 * (qualification.html) et par le panneau CRM (public/crm.html, pour
 * l'aperçu avant envoi) — cf. GET /wa/crmQualification/modules.
 */
export interface QualificationModule {
  key: string;
  label: string;
  question: string;
}

export const QUALIFICATION_MODULES: QualificationModule[] = [
  {
    key: "taxe",
    label: "Taxe de séjour",
    question: "Automatisez-vous aujourd'hui le calcul et l'encaissement de la taxe de séjour ?",
  },
  {
    key: "kyc",
    label: "Vérification identité",
    question: "Vérifiez-vous l'identité de vos clients au moment du check-in ?",
  },
  {
    key: "eco",
    label: "Préférences éco-séjour",
    question: "Proposez-vous à vos clients des gestes éco-responsables (ménage allégé, économies d'eau) ?",
  },
  {
    key: "rewards",
    label: "Récompenses & fidélité",
    question: "Avez-vous un programme de points ou de récompenses pour vos clients réguliers ?",
  },
  {
    key: "payment",
    label: "Paiement en ligne",
    question: "Vos clients peuvent-ils régler leur séjour en ligne, sans passer par la réception ?",
  },
  {
    key: "roomservice",
    label: "Room Service",
    question: "Proposez-vous des produits ou services additionnels depuis le mobile du client (room service, boutique, casiers) ?",
  },
  {
    key: "crm",
    label: "CRM & Marketing",
    question: "Centralisez-vous vos contacts clients dans un CRM dédié, avec historique et relances ciblées ?",
  },
];

export function getQualificationModule(key: string): QualificationModule | undefined {
  return QUALIFICATION_MODULES.find((m) => m.key === key);
}
