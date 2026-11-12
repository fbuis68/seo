-- Retour en arrière (12/11/2026, demande client "ne pas intégrer l'import
-- de document de la fiche client dans la bibliothèque documentaire, qui
-- sert exclusivement aux devis/projets") — la bibliothèque CrmDocument ne
-- doit plus être rattachable au CLIENT lui-même, seulement au devis
-- (CrmQuote.attachedDocumentIds, non touché ici).
ALTER TABLE "CrmProspect" DROP COLUMN "attachedDocumentIds";
