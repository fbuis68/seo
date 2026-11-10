-- Bibliothèque de questions partagée entre questionnaires (10/11/2026).
-- Le CONTENU de chaque QuestionnaireQuestion existante devient une Question
-- (nouvelle table) ; QuestionnaireQuestion devient un placement qui la
-- référence. On réutilise l'id de QuestionnaireQuestion comme id de la
-- Question correspondante (pure commodité : tables distinctes, aucun
-- conflit de clé primaire) pour ne jamais avoir à réécrire les FK
-- existantes qui pointent sur QuestionnaireQuestion.id (QuestionnaireAnswer,
-- CrmActivity, AutomationRule.questionnaireId ne sont pas concernés).

CREATE TABLE "Question" (
  "id" TEXT NOT NULL,
  "entityId" TEXT,
  "type" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "options" JSONB,
  "linkUrl" TEXT,
  "linkLabel" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Question_entityId_idx" ON "Question"("entityId");
ALTER TABLE "Question" ADD CONSTRAINT "Question_entityId_fkey"
  FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Une Question par QuestionnaireQuestion existante, même id, contenu copié
-- tel quel, portée héritée du Questionnaire parent.
INSERT INTO "Question" ("id", "entityId", "type", "label", "required", "options", "linkUrl", "linkLabel", "createdAt", "updatedAt")
SELECT qq."id", q."entityId", qq."type", qq."label", qq."required", qq."options", qq."linkUrl", qq."linkLabel", qq."createdAt", qq."updatedAt"
FROM "QuestionnaireQuestion" qq
JOIN "Questionnaire" q ON q."id" = qq."questionnaireId";

ALTER TABLE "QuestionnaireQuestion" ADD COLUMN "questionId" TEXT;
UPDATE "QuestionnaireQuestion" SET "questionId" = "id";
ALTER TABLE "QuestionnaireQuestion" ALTER COLUMN "questionId" SET NOT NULL;
CREATE INDEX "QuestionnaireQuestion_questionId_idx" ON "QuestionnaireQuestion"("questionId");
ALTER TABLE "QuestionnaireQuestion" ADD CONSTRAINT "QuestionnaireQuestion_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "QuestionnaireQuestion"
  DROP COLUMN "type",
  DROP COLUMN "label",
  DROP COLUMN "required",
  DROP COLUMN "options",
  DROP COLUMN "linkUrl",
  DROP COLUMN "linkLabel";
