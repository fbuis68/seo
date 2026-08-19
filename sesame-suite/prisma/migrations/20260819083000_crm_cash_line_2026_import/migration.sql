-- Import ponctuel des lignes de trésorerie prévisionnelle réelles (fichier
-- de trésorerie 2026 fourni par l'utilisateur, cf. README) : 65 versements
-- "signe", 86 lignes "depense" (mix récurrent/daté), 13 affaires "pipeline"
-- (mois de clôture laissé à null, à choisir dans l'app) et 1 ligne
-- "solde_depart". Idempotent via une clause NOT EXISTS sur (annee, kind, label, mois).

INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0001', 2026, 'signe', '#PARISESTMARNE&BOIS', 300, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='#PARISESTMARNE&BOIS' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0002', 2026, 'signe', '7 ANGES REIMS', 110, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='7 ANGES REIMS' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0003', 2026, 'signe', 'BED AND BICYCLE', 2326, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='BED AND BICYCLE' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0004', 2026, 'signe', 'BEDZZZ OPERATIONS LTD', 2500, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='BEDZZZ OPERATIONS LTD' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0005', 2026, 'signe', 'BEDZZZ OPERATIONS LTD', 2500, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='BEDZZZ OPERATIONS LTD' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0006', 2026, 'signe', 'BEDZZZ OPERATIONS LTD', 2500, NULL, 4, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='BEDZZZ OPERATIONS LTD' AND mois IS NOT DISTINCT FROM 4);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0007', 2026, 'signe', 'BPCE LEASE', 10000, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='BPCE LEASE' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0008', 2026, 'signe', 'BVDS', 2994.32, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='BVDS' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0009', 2026, 'signe', 'coeurmandie', 4841, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='coeurmandie' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0010', 2026, 'signe', 'GB HOSPITALITY', 586.03, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='GB HOSPITALITY' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0011', 2026, 'signe', 'GLASNOST DVA', 15054, NULL, 0, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='GLASNOST DVA' AND mois IS NOT DISTINCT FROM 0);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0012', 2026, 'signe', 'GLASNOST DVA', 1271, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='GLASNOST DVA' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0013', 2026, 'signe', 'HERITAGE ARLES', 2498, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='HERITAGE ARLES' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0014', 2026, 'signe', 'HOTEL DE LA GARE - GROUPE HRM', 1518, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='HOTEL DE LA GARE - GROUPE HRM' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0015', 2026, 'signe', 'HOTEL RESTAURANT LE SARMENT D''OR EURL', 2985, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='HOTEL RESTAURANT LE SARMENT D''OR EURL' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0016', 2026, 'signe', 'Delaforge Asnieres', 696, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Delaforge Asnieres' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0017', 2026, 'signe', 'Delaforge Asnieres', 10350, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Delaforge Asnieres' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0018', 2026, 'signe', 'Delaforge Asnieres', 7000, NULL, 8, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Delaforge Asnieres' AND mois IS NOT DISTINCT FROM 8);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0019', 2026, 'signe', 'Hôtel de France-Invalides', 810, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Hôtel de France-Invalides' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0020', 2026, 'signe', 'L''ESCALE AU SOLEIL', 792, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='L''ESCALE AU SOLEIL' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0021', 2026, 'signe', 'L''ESCALE AU SOLEIL', 180, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='L''ESCALE AU SOLEIL' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0022', 2026, 'signe', 'LA RUCHE EN SEINE', 1164, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='LA RUCHE EN SEINE' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0023', 2026, 'signe', 'LBC PROMOTION', 660, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='LBC PROMOTION' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0024', 2026, 'signe', 'LE BALIGAN', 1071, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='LE BALIGAN' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0025', 2026, 'signe', 'LE MEURICE RIVIERA NICE', 5570, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='LE MEURICE RIVIERA NICE' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0026', 2026, 'signe', 'LOCATYPIQUE', 897.6, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='LOCATYPIQUE' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0027', 2026, 'signe', 'My Maison Management', 194.75, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='My Maison Management' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0028', 2026, 'signe', 'My Maison Management', 1800, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='My Maison Management' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0029', 2026, 'signe', 'My Maison Management', 1500, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='My Maison Management' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0030', 2026, 'signe', 'POTINIERE DU LAC', 540, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='POTINIERE DU LAC' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0031', 2026, 'signe', 'RELAIS HORBE', 1852, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='RELAIS HORBE' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0032', 2026, 'signe', 'SAS 15 ASTORG', 780, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SAS 15 ASTORG' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0033', 2026, 'signe', 'SAS 15 ASTORG', 2240, NULL, 4, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SAS 15 ASTORG' AND mois IS NOT DISTINCT FROM 4);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0034', 2026, 'signe', 'SAS BIMMO', 4778, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SAS BIMMO' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0035', 2026, 'signe', 'SAS LES SOURCES D''ASPE', 6067, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SAS LES SOURCES D''ASPE' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0036', 2026, 'signe', 'SAS TL Les Sources Callou', 8587, NULL, 4, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SAS TL Les Sources Callou' AND mois IS NOT DISTINCT FROM 4);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0037', 2026, 'signe', 'SASU LA FONCIERE P&T', 1538, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SASU LA FONCIERE P&T' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0038', 2026, 'signe', 'SCI PIERRE CHARRON', 1354.3, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SCI PIERRE CHARRON' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0039', 2026, 'signe', 'SCI PUNCH', 631.24, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SCI PUNCH' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0040', 2026, 'signe', 'SDC 149 GRENELLE', 4636.61, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SDC 149 GRENELLE' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0041', 2026, 'signe', 'SDC 159 GRENELLE', 772.78, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SDC 159 GRENELLE' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0042', 2026, 'signe', 'SDC CITE VERON', 1632.68, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SDC CITE VERON' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0043', 2026, 'signe', 'SNC 14 COQUILLIERE', 2346.14, NULL, 0, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SNC 14 COQUILLIERE' AND mois IS NOT DISTINCT FROM 0);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0044', 2026, 'signe', 'SOCIETE HOTELIERE DE LA PEPINIERE', 2694.77, NULL, 4, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SOCIETE HOTELIERE DE LA PEPINIERE' AND mois IS NOT DISTINCT FROM 4);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0045', 2026, 'signe', 'SOCIETE HOTELIERE DE LA PEPINIERE', 2694.77, NULL, 6, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SOCIETE HOTELIERE DE LA PEPINIERE' AND mois IS NOT DISTINCT FROM 6);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0046', 2026, 'signe', 'SOCIETE HOTELIERE DE LA PEPINIERE', 2694.77, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SOCIETE HOTELIERE DE LA PEPINIERE' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0047', 2026, 'signe', 'SOCIETE HOTELLIERE LA PEPINIERE', 960, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='SOCIETE HOTELLIERE LA PEPINIERE' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0048', 2026, 'signe', 'TRIEDRE', 10000, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='TRIEDRE' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0049', 2026, 'signe', 'TRIEDRE', 12000, NULL, 8, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='TRIEDRE' AND mois IS NOT DISTINCT FROM 8);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0050', 2026, 'signe', 'TRIADETEL', 800, NULL, 4, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='TRIADETEL' AND mois IS NOT DISTINCT FROM 4);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0051', 2026, 'signe', 'VILLA LA CADIERE', 970, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='VILLA LA CADIERE' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0052', 2026, 'signe', 'MMIP', 3300, NULL, 6, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='MMIP' AND mois IS NOT DISTINCT FROM 6);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0053', 2026, 'signe', 'BENAYOUN', 13500, NULL, 6, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='BENAYOUN' AND mois IS NOT DISTINCT FROM 6);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0054', 2026, 'signe', 'Aromates / Sous le platane', 60, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Aromates / Sous le platane' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0055', 2026, 'signe', 'Aromates / Sous le platane', 2500, NULL, 6, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Aromates / Sous le platane' AND mois IS NOT DISTINCT FROM 6);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0056', 2026, 'signe', 'pieds de geant', 1200, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='pieds de geant' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0057', 2026, 'signe', 'HRM', 6000, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='HRM' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0058', 2026, 'signe', 'Ramery', 10000, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Ramery' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0059', 2026, 'signe', 'Groom', 5000, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Groom' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0060', 2026, 'signe', 'Groom', 3500, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Groom' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0061', 2026, 'signe', 'Castel Franc', 7700, NULL, 7, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Castel Franc' AND mois IS NOT DISTINCT FROM 7);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0062', 2026, 'signe', 'Castel Franc', 4146.15, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Castel Franc' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0063', 2026, 'signe', 'Guyane', 11900, NULL, 7, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Guyane' AND mois IS NOT DISTINCT FROM 7);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0064', 2026, 'signe', 'Guyane', 6407.69, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='Guyane' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_signe_0065', 2026, 'signe', 'CII', 40000, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='signe' AND label='CII' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0066', 2026, 'depense', 'Assurance', 83.33, NULL, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Assurance' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0067', 2026, 'depense', 'Jade', 4000, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Jade' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0068', 2026, 'depense', 'Jade', 1800, NULL, 6, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Jade' AND mois IS NOT DISTINCT FROM 6);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0069', 2026, 'depense', 'Jade', 3200, NULL, 7, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Jade' AND mois IS NOT DISTINCT FROM 7);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0070', 2026, 'depense', 'ESPACE REPRO', 250, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='ESPACE REPRO' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0071', 2026, 'depense', 'Check my guest/Triliv', 2500, NULL, 8, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Check my guest/Triliv' AND mois IS NOT DISTINCT FROM 8);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0072', 2026, 'depense', 'Check my guest/Triliv', 6000, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Check my guest/Triliv' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0073', 2026, 'depense', 'Rcsopi', 3500, NULL, 8, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Rcsopi' AND mois IS NOT DISTINCT FROM 8);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0074', 2026, 'depense', 'Compta', 600, NULL, 0, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Compta' AND mois IS NOT DISTINCT FROM 0);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0075', 2026, 'depense', 'Compta', 600, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Compta' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0076', 2026, 'depense', 'Compta', 600, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Compta' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0077', 2026, 'depense', 'Compta', 600, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Compta' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0078', 2026, 'depense', 'Compta', 500, NULL, 4, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Compta' AND mois IS NOT DISTINCT FROM 4);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0079', 2026, 'depense', 'Compta', 600, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Compta' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0080', 2026, 'depense', 'Compta', 600, NULL, 6, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Compta' AND mois IS NOT DISTINCT FROM 6);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0081', 2026, 'depense', 'Compta', 600, NULL, 7, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Compta' AND mois IS NOT DISTINCT FROM 7);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0082', 2026, 'depense', 'Compta', 600, NULL, 8, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Compta' AND mois IS NOT DISTINCT FROM 8);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0083', 2026, 'depense', 'Compta', 600, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Compta' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0084', 2026, 'depense', 'Compta', 600, NULL, 10, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Compta' AND mois IS NOT DISTINCT FROM 10);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0085', 2026, 'depense', 'Compta', 600, NULL, 11, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Compta' AND mois IS NOT DISTINCT FROM 11);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0086', 2026, 'depense', 'MAIDI', 600, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='MAIDI' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0087', 2026, 'depense', 'MAIDI', 2500, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='MAIDI' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0088', 2026, 'depense', 'MAIDI', 2500, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='MAIDI' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0089', 2026, 'depense', 'MAIDI', 2500, NULL, 8, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='MAIDI' AND mois IS NOT DISTINCT FROM 8);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0090', 2026, 'depense', 'MAIDI', 2500, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='MAIDI' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0091', 2026, 'depense', 'Salons', 2700, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Salons' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0092', 2026, 'depense', 'Salons', 1800, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Salons' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0093', 2026, 'depense', 'Salons', 1800, NULL, 4, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Salons' AND mois IS NOT DISTINCT FROM 4);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0094', 2026, 'depense', 'Salons', 2800, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Salons' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0095', 2026, 'depense', 'Salons', 1800, NULL, 7, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Salons' AND mois IS NOT DISTINCT FROM 7);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0096', 2026, 'depense', 'Salons', 3000, NULL, 8, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Salons' AND mois IS NOT DISTINCT FROM 8);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0097', 2026, 'depense', 'Salons', 3000, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Salons' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0098', 2026, 'depense', 'Synapse', 1000, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Synapse' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0099', 2026, 'depense', 'Prêt', 650, NULL, 0, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Prêt' AND mois IS NOT DISTINCT FROM 0);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0100', 2026, 'depense', 'Prêt', 650, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Prêt' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0101', 2026, 'depense', 'Prêt', 650, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Prêt' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0102', 2026, 'depense', 'Prêt', 650, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Prêt' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0103', 2026, 'depense', 'Prêt', 650, NULL, 4, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Prêt' AND mois IS NOT DISTINCT FROM 4);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0104', 2026, 'depense', 'salaire', 17000, NULL, 0, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='salaire' AND mois IS NOT DISTINCT FROM 0);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0105', 2026, 'depense', 'salaire', 15000, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='salaire' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0106', 2026, 'depense', 'salaire', 15000, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='salaire' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0107', 2026, 'depense', 'salaire', 15500, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='salaire' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0108', 2026, 'depense', 'salaire', 15500, NULL, 4, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='salaire' AND mois IS NOT DISTINCT FROM 4);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0109', 2026, 'depense', 'salaire', 15500, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='salaire' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0110', 2026, 'depense', 'salaire', 15500, NULL, 6, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='salaire' AND mois IS NOT DISTINCT FROM 6);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0111', 2026, 'depense', 'salaire', 15500, NULL, 7, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='salaire' AND mois IS NOT DISTINCT FROM 7);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0112', 2026, 'depense', 'salaire', 15500, NULL, 8, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='salaire' AND mois IS NOT DISTINCT FROM 8);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0113', 2026, 'depense', 'salaire', 15500, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='salaire' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0114', 2026, 'depense', 'salaire', 15500, NULL, 10, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='salaire' AND mois IS NOT DISTINCT FROM 10);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0115', 2026, 'depense', 'salaire', 15500, NULL, 11, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='salaire' AND mois IS NOT DISTINCT FROM 11);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0116', 2026, 'depense', 'Humanis/impot', 3000, NULL, 0, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Humanis/impot' AND mois IS NOT DISTINCT FROM 0);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0117', 2026, 'depense', 'Humanis/impot', 8000, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Humanis/impot' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0118', 2026, 'depense', 'Humanis/impot', 8000, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Humanis/impot' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0119', 2026, 'depense', 'Humanis/impot', 8800, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Humanis/impot' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0120', 2026, 'depense', 'Humanis/impot', 8800, NULL, 4, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Humanis/impot' AND mois IS NOT DISTINCT FROM 4);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0121', 2026, 'depense', 'Humanis/impot', 3306, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Humanis/impot' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0122', 2026, 'depense', 'Humanis/impot', 3306, NULL, 6, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Humanis/impot' AND mois IS NOT DISTINCT FROM 6);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0123', 2026, 'depense', 'Humanis/impot', 3306, NULL, 7, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Humanis/impot' AND mois IS NOT DISTINCT FROM 7);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0124', 2026, 'depense', 'Humanis/impot', 3306, NULL, 8, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Humanis/impot' AND mois IS NOT DISTINCT FROM 8);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0125', 2026, 'depense', 'Humanis/impot', 3306, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Humanis/impot' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0126', 2026, 'depense', 'Humanis/impot', 3306, NULL, 10, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Humanis/impot' AND mois IS NOT DISTINCT FROM 10);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0127', 2026, 'depense', 'Humanis/impot', 3306, NULL, 11, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Humanis/impot' AND mois IS NOT DISTINCT FROM 11);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0128', 2026, 'depense', 'URSSAF', 9149, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='URSSAF' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0129', 2026, 'depense', 'URSSAF', 9150, NULL, 6, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='URSSAF' AND mois IS NOT DISTINCT FROM 6);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0130', 2026, 'depense', 'URSSAF', 9151, NULL, 7, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='URSSAF' AND mois IS NOT DISTINCT FROM 7);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0131', 2026, 'depense', 'URSSAF', 9152, NULL, 8, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='URSSAF' AND mois IS NOT DISTINCT FROM 8);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0132', 2026, 'depense', 'URSSAF', 9153, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='URSSAF' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0133', 2026, 'depense', 'URSSAF', 9154, NULL, 10, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='URSSAF' AND mois IS NOT DISTINCT FROM 10);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0134', 2026, 'depense', 'URSSAF', 9155, NULL, 11, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='URSSAF' AND mois IS NOT DISTINCT FROM 11);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0135', 2026, 'depense', 'Ticket Restau', 2000, NULL, 0, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Ticket Restau' AND mois IS NOT DISTINCT FROM 0);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0136', 2026, 'depense', 'Ticket Restau', 2000, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Ticket Restau' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0137', 2026, 'depense', 'Ticket Restau', 2000, NULL, 7, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Ticket Restau' AND mois IS NOT DISTINCT FROM 7);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0138', 2026, 'depense', 'Ticket Restau', 2000, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Ticket Restau' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0139', 2026, 'depense', 'Ajustement', -6000, NULL, 4, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='Ajustement' AND mois IS NOT DISTINCT FROM 4);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0140', 2026, 'depense', 'TVA', 18000, NULL, 0, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='TVA' AND mois IS NOT DISTINCT FROM 0);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0141', 2026, 'depense', 'TVA', 10000, NULL, 1, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='TVA' AND mois IS NOT DISTINCT FROM 1);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0142', 2026, 'depense', 'TVA', 5000, NULL, 2, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='TVA' AND mois IS NOT DISTINCT FROM 2);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0143', 2026, 'depense', 'TVA', 13500, NULL, 3, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='TVA' AND mois IS NOT DISTINCT FROM 3);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0144', 2026, 'depense', 'TVA', 7000, NULL, 4, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='TVA' AND mois IS NOT DISTINCT FROM 4);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0145', 2026, 'depense', 'TVA', 5000, NULL, 5, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='TVA' AND mois IS NOT DISTINCT FROM 5);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0146', 2026, 'depense', 'TVA', 6000, NULL, 6, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='TVA' AND mois IS NOT DISTINCT FROM 6);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0147', 2026, 'depense', 'TVA', 5000, NULL, 7, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='TVA' AND mois IS NOT DISTINCT FROM 7);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0148', 2026, 'depense', 'TVA', 5000, NULL, 8, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='TVA' AND mois IS NOT DISTINCT FROM 8);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0149', 2026, 'depense', 'TVA', 5000, NULL, 9, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='TVA' AND mois IS NOT DISTINCT FROM 9);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0150', 2026, 'depense', 'TVA', 5000, NULL, 10, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='TVA' AND mois IS NOT DISTINCT FROM 10);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_depense_0151', 2026, 'depense', 'TVA', 5000, NULL, 11, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='depense' AND label='TVA' AND mois IS NOT DISTINCT FROM 11);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0152', 2026, 'pipeline', 'Armée', 20000, 50, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Armée' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0153', 2026, 'pipeline', 'Gener', 18000, 30, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Gener' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0154', 2026, 'pipeline', 'Dunoyer', 60000, 50, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Dunoyer' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0155', 2026, 'pipeline', 'Cabelia Lodge', 20000, 30, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Cabelia Lodge' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0156', 2026, 'pipeline', 'Moorea', 48000, 50, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Moorea' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0157', 2026, 'pipeline', 'Versailles', 7300, 50, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Versailles' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0158', 2026, 'pipeline', 'Bleeker', 5000, 50, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Bleeker' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0159', 2026, 'pipeline', 'Benayoun', 21000, 50, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Benayoun' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0160', 2026, 'pipeline', 'Hotel du Sud', 35000, 50, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Hotel du Sud' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0161', 2026, 'pipeline', 'Delaforge', 0, 30, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Delaforge' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0162', 2026, 'pipeline', 'Beaune', 16000, 30, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Beaune' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0163', 2026, 'pipeline', 'Res Narbonne', 37000, 50, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Res Narbonne' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_pipeline_0164', 2026, 'pipeline', 'Castel Franc', 10700, 50, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='pipeline' AND label='Castel Franc' AND mois IS NOT DISTINCT FROM NULL);
INSERT INTO "CrmCashLine" (id, annee, kind, label, montant, proba, mois, "createdAt", "updatedAt")
SELECT 'cid_solde_depart_0165', 2026, 'solde_depart', 'Solde au 1er janvier', 30000, NULL, NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "CrmCashLine" WHERE annee=2026 AND kind='solde_depart' AND label='Solde au 1er janvier' AND mois IS NOT DISTINCT FROM NULL);
