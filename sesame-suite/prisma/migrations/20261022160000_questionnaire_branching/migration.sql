-- Branchement conditionnel des questionnaires (22/10/2026).
ALTER TABLE "QuestionnaireQuestion" ADD COLUMN "branching" JSONB;
