-- "permettre que l'activation des tick box cgv et newsletter soient
-- optionnel" (18/11/2026) — toggles admin pour rendre la case CGU
-- facultative et/ou masquer la case newsletter côté check-in.
ALTER TABLE "EntityModuleConfig" ADD COLUMN "cguRequired" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "EntityModuleConfig" ADD COLUMN "newsletterEnabled" BOOLEAN NOT NULL DEFAULT true;
