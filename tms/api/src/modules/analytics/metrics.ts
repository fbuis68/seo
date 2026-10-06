/** Dictionnaire des métriques (§5.3) : même définition pour graphiques, exports et réponses IA. */
export const METRICS = {
  revenue_net_ht: {
    version: 1, label: 'CA facturé net HT', unit: 'currency', requires: 'finance.read',
    definition: "Somme des factures et factures d'acompte émises (HT, date d'émission) moins les avoirs émis (HT, date d'émission). Brouillons exclus. Les acomptes déduits sur facture finale par lignes négatives ne sont comptés qu'une fois.",
    exclusions: ['brouillons', 'factures historiques incomplètes (is_incomplete)', 'autres devises que celle filtrée'],
    note: 'Indicateur opérationnel, distinct du chiffre d’affaires comptable reconnu.',
  },
  cash_in_ttc: {
    version: 1, label: 'Encaissements clients TTC', unit: 'currency', requires: 'finance.read',
    definition: "Règlements clients enregistrés, par date d'encaissement, nets des remboursements (montants négatifs). Ne comprend pas les autres crédits bancaires.",
    exclusions: ['mouvements bancaires non rapprochés à un règlement'],
  },
  receivables: {
    version: 1, label: 'Impayés (balance âgée)', unit: 'currency', requires: 'finance.read',
    definition: 'Solde TTC des factures émises échues, net des avoirs et paiements affectés ; tranches 1–30, 31–60, 61–90, >90 jours.',
    exclusions: ['factures non échues', 'factures historiques incomplètes'],
  },
  learners: {
    version: 1, label: 'Apprenants', unit: 'count', requires: 'analytics.read',
    definition: 'Participants distincts (ou inscriptions selon l’unité) aux sessions débutant sur la période, inscriptions annulées exclues.',
    exclusions: ['inscriptions annulées'],
  },
  fill_rate: {
    version: 1, label: 'Taux de remplissage', unit: 'ratio', requires: 'analytics.read',
    definition: 'Inscriptions confirmées / capacité, par session ; sessions sans capacité exclues (dénominateur affiché).',
    exclusions: ['sessions sans capacité', 'sessions annulées'],
  },
  satisfaction: {
    version: 1, label: 'Satisfaction', unit: 'ratio', requires: 'quality.read',
    definition: 'Score moyen des réponses individuelles de satisfaction ; nombre de réponses affiché ; valeur absente ≠ zéro.',
    exclusions: ['synthèses importées sans réponses individuelles'],
  },
} as const;
export type MetricKey = keyof typeof METRICS;
