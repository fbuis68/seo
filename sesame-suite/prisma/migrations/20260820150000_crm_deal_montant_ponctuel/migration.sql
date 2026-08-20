-- Montant ponctuel (one-shot) + mois d'encaissement sur une affaire (CrmDeal)
-- — pondéré par la probabilité existante et reporté sur le panneau
-- Trésorerie (catégorie Encaissement), en plus du MRR "amount" existant.
ALTER TABLE "CrmDeal" ADD COLUMN "montantPonctuel" DOUBLE PRECISION;
ALTER TABLE "CrmDeal" ADD COLUMN "moisEncaissement" INTEGER;
