-- Le jeu de données de démo Hôtel Churchill (seed.ts) fixe les dates de
-- séjour en chaînes ISO littérales plutôt que relatives à "aujourd'hui" —
-- la réservation "vitrine" DEMO-2026-0001 (identifiants pré-établis
-- documentés dans le README pour les démos commerciales, cf. "Comptes de
-- démonstration") finit donc par sortir de sa fenêtre de validité au fil du
-- temps (déjà expirée au 26/08/2026, sa fenêtre s'arrêtant le 15/08/2026),
-- ce qui n'empêche pas la connexion (non vérifiée sur les dates) mais fait
-- apparaître un "Valable jusqu'au" déjà passé pendant une démo en direct.
-- Repoussée à une fenêtre lointaine pour rester fiable plusieurs années —
-- no-op si la réservation n'existe pas encore (nouvelle installation pas
-- encore seedée) ou si l'entité Churchill n'existe pas (autre déploiement).
UPDATE "Booking" b
SET "startDate" = '2032-06-10T00:00:00Z', "endDate" = '2032-06-15T00:00:00Z'
FROM "Entity" e
WHERE b."entityId" = e.id
  AND e.code = 'E00000001'
  AND b.code = 'DEMO-2026-0001';
