import { xlsxBuffer } from '../../core/xlsx';

/** Modèle de reprise Excel (onglets « Clients » et « Apprenants »), en-têtes reconnus automatiquement. */
export const TEMPLATE_SHEETS: { name: string; headers: string[]; examples: string[][] }[] = [
  {
    name: 'Clients',
    headers: ['Code client', 'Raison sociale', 'Type', 'SIRET', 'N° TVA', 'Email facturation', 'Téléphone', 'Adresse', 'Code postal', 'Ville', 'Financeur', 'Client facturé'],
    examples: [
      ['C001', 'ACME Industrie', 'Entreprise', '73282932000074', 'FR40732829320', 'compta@acme.fr', '0102030405', '12 rue des Lilas', '69003', 'Lyon', 'non', 'oui'],
      ['C002', 'OPCO Exemple', 'Entreprise', '', '', 'factures@opco.fr', '', '1 place du Marché', '75010', 'Paris', 'oui', 'oui'],
      ['C003', 'Martin Sophie', 'Particulier', '', '', 'sophie.martin@mail.fr', '0611223344', '5 allée Verte', '33000', 'Bordeaux', 'non', 'oui'],
    ],
  },
  {
    name: 'Apprenants',
    headers: ['Identifiant', 'Civilité', 'Prénom', 'Nom', 'Email', 'Téléphone', 'Portable', 'Date de naissance', 'Fonction', 'Adresse', 'Code postal', 'Ville', 'Code client', 'Rôle'],
    examples: [
      ['A001', 'M.', 'Jean', 'Dupont', 'jean.dupont@acme.fr', '', '0612345678', '14/02/1988', 'Cariste', '', '', '', 'C001', 'Apprenant'],
      ['A002', 'Mme', 'Lina', 'Bernard', 'lina.bernard@acme.fr', '', '', '03/09/1992', 'Responsable RH', '', '', '', 'C001', 'Contact'],
      ['A003', 'Mme', 'Sophie', 'Martin', 'sophie.martin@mail.fr', '', '0611223344', '', '', '5 allée Verte', '33000', 'Bordeaux', 'C003', 'Apprenant'],
    ],
  },
];

export function templateXlsx(withExamples = true): Promise<Buffer> {
  return xlsxBuffer(TEMPLATE_SHEETS.map((s) => ({ name: s.name, rows: [s.headers, ...(withExamples ? s.examples : [])] })));
}
