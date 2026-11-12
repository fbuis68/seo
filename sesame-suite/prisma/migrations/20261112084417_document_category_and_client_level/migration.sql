-- Classification de la bibliothèque documentaire (technique/commercial/
-- marketing) + rattachement de documents au CLIENT lui-même, en plus du
-- devis (12/11/2026, demande client).
ALTER TABLE "CrmDocument" ADD COLUMN "category" TEXT;
ALTER TABLE "CrmProspect" ADD COLUMN "attachedDocumentIds" TEXT[] NOT NULL DEFAULT '{}';
