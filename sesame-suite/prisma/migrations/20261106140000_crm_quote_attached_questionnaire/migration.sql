ALTER TABLE "CrmQuote" ADD COLUMN "attachedQuestionnaireIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
