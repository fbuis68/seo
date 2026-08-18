-- Modèles de connecteur (preset) pour le panneau "Intégration réservations"
-- (Sesame Technology / Mews / Opera Cloud / Thaïs / personnalisé) — purement
-- informatif côté UI. + support du corps JSON en POST (API Mews, dont
-- l'authentification ClientToken/AccessToken se fait dans le corps de
-- chaque appel plutôt qu'un en-tête).
ALTER TABLE "BookingSourceConfig" ADD COLUMN "presetId" TEXT DEFAULT 'none',
ADD COLUMN "endpointBodyFormat" TEXT DEFAULT 'form',
ADD COLUMN "facilityEndpointBodyFormat" TEXT DEFAULT 'form';
