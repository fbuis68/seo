-- Modèle tarifaire choisi à l'inscription ("forfait zéro" : commission sur
-- les économies plutôt qu'abonnement fixe) — v1, capture le choix
-- uniquement, pas encore de moteur de facturation usage réel.
ALTER TABLE "Subscription" ADD COLUMN "pricingModel" TEXT NOT NULL DEFAULT 'flat';
ALTER TABLE "Subscription" ADD COLUMN "roiSharePct" INTEGER NOT NULL DEFAULT 10;
