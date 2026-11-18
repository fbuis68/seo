-- Téléphone + photo du commercial, affichés en en-tête de l'espace client
-- des devis (public/devis-signature.html).
ALTER TABLE "AdminUser" ADD COLUMN "phone" TEXT;
ALTER TABLE "AdminUser" ADD COLUMN "photoUrl" TEXT;
