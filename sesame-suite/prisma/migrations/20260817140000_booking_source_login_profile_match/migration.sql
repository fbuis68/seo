-- Sélection du bon profil quand la réponse de connexion contient un tableau
-- (un profil par établissement, ex: API Sesame Technology) — au lieu de
-- dépendre d'un index de tableau fixe et fragile.
ALTER TABLE "BookingSourceConfig" ADD COLUMN "loginProfileListPath" TEXT,
ADD COLUMN "loginProfileMatchField" TEXT,
ADD COLUMN "loginProfileMatchValue" TEXT;
