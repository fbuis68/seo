-- Rapprochement ponctuel (par nom) du fichier de trésorerie 2026 (MRR) et de
-- l'export pmexport.xls (adresses des entreprises) avec les fiches CrmProspect
-- existantes. Rapprochement fait manuellement/par script one-off (voir README),
-- appliqué en migration pour que les environnements déjà provisionnés (mêmes
-- 68 fiches, seedées de manière déterministe par prisma/seed.ts) héritent
-- aussi de ces données sans reseed complet.

-- MRR (€/mois récurrent)
UPDATE "CrmProspect" SET mrr = 61.5 WHERE nom = 'DYNAMIC SEVRES' AND mrr IS NULL;
UPDATE "CrmProspect" SET mrr = 104.55 WHERE nom = 'ASTREA' AND mrr IS NULL;
UPDATE "CrmProspect" SET mrr = 89.39 WHERE nom = 'BUDA FITNESS' AND mrr IS NULL;
UPDATE "CrmProspect" SET mrr = 107.38 WHERE nom = 'DOJO BORDEAUX' AND mrr IS NULL;
UPDATE "CrmProspect" SET mrr = 135.3 WHERE nom = 'FLORELLA' AND mrr IS NULL;
UPDATE "CrmProspect" SET mrr = 192 WHERE nom = 'AUBERG''INE' AND mrr IS NULL;
UPDATE "CrmProspect" SET mrr = 178.34 WHERE nom = 'HOTEL MARIE' AND mrr IS NULL;
UPDATE "CrmProspect" SET mrr = 202.94 WHERE nom = 'ESCALE AU SOLEIL' AND mrr IS NULL;
UPDATE "CrmProspect" SET mrr = 113.9 WHERE nom = 'MAB BOX' AND mrr IS NULL;
UPDATE "CrmProspect" SET mrr = 113.47 WHERE nom = 'ASTORG' AND mrr IS NULL;
UPDATE "CrmProspect" SET mrr = 585.29 WHERE nom = 'YOU ARE DEAUVILLE' AND mrr IS NULL;
UPDATE "CrmProspect" SET mrr = 116.84 WHERE nom = 'Auberge St Jacques' AND mrr IS NULL;

-- Adresse / Ville
UPDATE "CrmProspect" SET adresse = '25 Bd Camille Dagonneau', ville = 'VARENNES VAUZELLES' WHERE nom = 'ASTREA' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '4 Rue de Tournai', ville = 'LILLE' WHERE nom = 'Ambassadeur Lille' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '62 Rue André Joineau', ville = 'PANTIN' WHERE nom = 'ACGP93' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '1 BD CHARLES DE GAULLE', ville = 'COLOMBES' WHERE nom = 'COLOMBYA' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '22 BOULEVARD DE CLICHY', ville = 'CLICHY' WHERE nom = 'COPWELL – Fédé. Natation' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '22 BOULEVARD DE CLICHY', ville = 'CLICHY' WHERE nom = 'COPWELL – HAVAS' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '22 BOULEVARD DE CLICHY', ville = 'CLICHY' WHERE nom = 'COPWELL – LARCO' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '84 Cr Aristide Briand', ville = 'BORDEAUX' WHERE nom = 'DOJO BORDEAUX' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '9 avenue de l''Europe', ville = 'SEVRES' WHERE nom = 'DYNAMIC SEVRES' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '75 Avenue Marius Coullet,', ville = 'FREJUS' WHERE nom = 'ESCALE AU SOLEIL' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '2, boulevard d''Alsace', ville = 'Cannes' WHERE nom = 'FLORELLA' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '2 RTE NATIONALE', ville = 'ROLLEBOISE' WHERE nom = 'LA RUCHE' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '14 Av. de Suède', ville = 'NICE' WHERE nom = 'LE MEURICE RIVIERA' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '31bis rue Victor Massé', ville = 'PARIS' WHERE nom = 'LE VICTOR' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '23 Rue Viala', ville = 'PARIS' WHERE nom = 'LES SUITES TOUR EIFFEL' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '22 Rue de Richelieu', ville = 'PARIS' WHERE nom = 'LOUVRE PIEMONT' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '38 Labrie', ville = 'JUGAZAN' WHERE nom = 'MAB BOX' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '39 AVENUE GOERGES V', ville = 'PARIS' WHERE nom = 'MMIP CITE VERON' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '10 rue d’alger', ville = 'CANNES' WHERE nom = 'MONTEFIORE' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '6 Rue de la République', ville = 'AVIGNON' WHERE nom = 'REGINA D''AVIGNON' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '2 RUE THOMAS EDISON', ville = 'PAU' WHERE nom = 'SEM PAU' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = 'LIEU DIT LA PINEDE', ville = 'ST TROPEZ' WHERE nom = 'VILLA CADIERE' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '2 RUE ALFRED DE VIGNY', ville = 'PARIS' WHERE nom = 'ASTORG' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '8 rue de vannes', ville = 'STE ANNE D AURAY' WHERE nom = 'AUBERG''INE' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '16 Rue de la Pépinière', ville = 'PARIS' WHERE nom = 'BELLEVAL' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '671 Route du Souzy', ville = 'QUINCIE-EN-BEAUJOLAIS' WHERE nom = 'CHÂTEAU DU SOUZY' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '8 RUE ANATOLE DE LA FORGE', ville = 'PARIS' WHERE nom = 'HOTEL MARIE' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '41-43 rue d''Aulnay', ville = 'GONESSE' WHERE nom = 'TAC BOX' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '18, avenue de la République', ville = 'AUTUN' WHERE nom = 'HOTEL DE LA GARE' AND adresse IS NULL;
UPDATE "CrmProspect" SET adresse = '1 Rue Désiré le Hoc', ville = 'DEAUVILLE' WHERE nom = 'YOU ARE DEAUVILLE' AND adresse IS NULL;

-- Cas particulier : adresse réelle indisponible dans la source ("[ND]"), ville seule fiable
UPDATE "CrmProspect" SET ville = 'Toulouse' WHERE nom = 'MAISON ROQUELONGUE' AND adresse IS NULL;
