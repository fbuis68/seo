-- Gestionnaire de questionnaires générique (08/09/2026) — remplace l'ancien
-- mécanisme figé "Questionnaire de qualification" (une question par module
-- Souscriptions, cf. git history lib/qualificationModules.ts).
--
-- Ordre : (1) créer les nouvelles tables, (2) migrer les données existantes
-- (CrmProspect.qualificationToken/qualificationSentAt + CrmQualificationResponse)
-- dans les nouvelles tables en conservant les tokens déjà envoyés aux
-- prospects (les liens /qualification.html?token=... déjà délivrés doivent
-- continuer à fonctionner), (3) seulement ensuite supprimer les anciennes
-- colonnes/table.

-- ── (1) Nouvelles tables ──

CREATE TABLE "Questionnaire" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Questionnaire_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuestionnaireQuestion" (
    "id" TEXT NOT NULL,
    "questionnaireId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionnaireQuestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuestionnaireSend" (
    "id" TEXT NOT NULL,
    "questionnaireId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionnaireSend_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuestionnaireAnswer" (
    "id" TEXT NOT NULL,
    "sendId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionnaireAnswer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Questionnaire_entityId_idx" ON "Questionnaire"("entityId");
CREATE INDEX "QuestionnaireQuestion_questionnaireId_idx" ON "QuestionnaireQuestion"("questionnaireId");
CREATE UNIQUE INDEX "QuestionnaireSend_token_key" ON "QuestionnaireSend"("token");
CREATE INDEX "QuestionnaireSend_targetType_targetId_idx" ON "QuestionnaireSend"("targetType", "targetId");
CREATE UNIQUE INDEX "QuestionnaireSend_questionnaireId_targetType_targetId_key" ON "QuestionnaireSend"("questionnaireId", "targetType", "targetId");
CREATE INDEX "QuestionnaireAnswer_sendId_idx" ON "QuestionnaireAnswer"("sendId");
CREATE UNIQUE INDEX "QuestionnaireAnswer_sendId_questionId_key" ON "QuestionnaireAnswer"("sendId", "questionId");

ALTER TABLE "Questionnaire" ADD CONSTRAINT "Questionnaire_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionnaireQuestion" ADD CONSTRAINT "QuestionnaireQuestion_questionnaireId_fkey" FOREIGN KEY ("questionnaireId") REFERENCES "Questionnaire"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionnaireSend" ADD CONSTRAINT "QuestionnaireSend_questionnaireId_fkey" FOREIGN KEY ("questionnaireId") REFERENCES "Questionnaire"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionnaireAnswer" ADD CONSTRAINT "QuestionnaireAnswer_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "QuestionnaireSend"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionnaireAnswer" ADD CONSTRAINT "QuestionnaireAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuestionnaireQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AutomationRule" ADD COLUMN "questionnaireId" TEXT;
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_questionnaireId_fkey" FOREIGN KEY ("questionnaireId") REFERENCES "Questionnaire"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── (2) Migration des données existantes ──

-- Questionnaire seedé (portée CRM, entityId NULL) — remplace l'ancien
-- mécanisme figé. Id fixe et lisible plutôt qu'un cuid() généré côté
-- application, puisque cette ligne est créée par une migration SQL brute.
INSERT INTO "Questionnaire" ("id", "entityId", "name", "description", "active", "createdAt", "updatedAt")
VALUES ('qnr_qualification_crm', NULL, 'Questionnaire de qualification', 'Intérêt du contact pour chaque module du catalogue Souscriptions.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "QuestionnaireQuestion" ("id", "questionnaireId", "order", "type", "label", "required", "options", "createdAt", "updatedAt") VALUES
('qnrq_qualification_taxe', 'qnr_qualification_crm', 0, 'single', 'Automatisez-vous aujourd''hui le calcul et l''encaissement de la taxe de séjour ?', false, '[{"key":"oui","label":"Oui"},{"key":"non","label":"Non"},{"key":"peut-etre","label":"Peut-être"}]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('qnrq_qualification_kyc', 'qnr_qualification_crm', 1, 'single', 'Vérifiez-vous l''identité de vos clients au moment du check-in ?', false, '[{"key":"oui","label":"Oui"},{"key":"non","label":"Non"},{"key":"peut-etre","label":"Peut-être"}]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('qnrq_qualification_eco', 'qnr_qualification_crm', 2, 'single', 'Proposez-vous à vos clients des gestes éco-responsables (ménage allégé, économies d''eau) ?', false, '[{"key":"oui","label":"Oui"},{"key":"non","label":"Non"},{"key":"peut-etre","label":"Peut-être"}]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('qnrq_qualification_rewards', 'qnr_qualification_crm', 3, 'single', 'Avez-vous un programme de points ou de récompenses pour vos clients réguliers ?', false, '[{"key":"oui","label":"Oui"},{"key":"non","label":"Non"},{"key":"peut-etre","label":"Peut-être"}]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('qnrq_qualification_payment', 'qnr_qualification_crm', 4, 'single', 'Vos clients peuvent-ils régler leur séjour en ligne, sans passer par la réception ?', false, '[{"key":"oui","label":"Oui"},{"key":"non","label":"Non"},{"key":"peut-etre","label":"Peut-être"}]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('qnrq_qualification_roomservice', 'qnr_qualification_crm', 5, 'single', 'Proposez-vous des produits ou services additionnels depuis le mobile du client (room service, boutique, casiers) ?', false, '[{"key":"oui","label":"Oui"},{"key":"non","label":"Non"},{"key":"peut-etre","label":"Peut-être"}]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('qnrq_qualification_crm', 'qnr_qualification_crm', 6, 'single', 'Centralisez-vous vos contacts clients dans un CRM dédié, avec historique et relances ciblées ?', false, '[{"key":"oui","label":"Oui"},{"key":"non","label":"Non"},{"key":"peut-etre","label":"Peut-être"}]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Un envoi par prospect ayant déjà un qualificationToken — le token est
-- réutilisé tel quel pour que les liens déjà envoyés continuent de fonctionner.
INSERT INTO "QuestionnaireSend" ("id", "questionnaireId", "targetType", "targetId", "token", "sentAt", "completedAt", "createdAt")
SELECT
  'qsend_' || p."id",
  'qnr_qualification_crm',
  'crmProspect',
  p."id",
  p."qualificationToken",
  p."qualificationSentAt",
  (SELECT MAX(r."updatedAt") FROM "CrmQualificationResponse" r WHERE r."prospectId" = p."id"),
  COALESCE(p."qualificationSentAt", CURRENT_TIMESTAMP)
FROM "CrmProspect" p
WHERE p."qualificationToken" IS NOT NULL;

-- Réponses existantes → QuestionnaireAnswer, mappées vers la question du
-- module correspondant (id "qnrq_qualification_<moduleKey>", construit ci-dessus).
INSERT INTO "QuestionnaireAnswer" ("id", "sendId", "questionId", "value", "createdAt", "updatedAt")
SELECT
  'qans_' || r."id",
  'qsend_' || r."prospectId",
  'qnrq_qualification_' || r."moduleKey",
  jsonb_strip_nulls(jsonb_build_object('choice', r."interested", 'note', r."note")),
  r."createdAt",
  r."updatedAt"
FROM "CrmQualificationResponse" r;

-- ── (3) Suppression de l'ancien mécanisme (une fois les données migrées) ──

ALTER TABLE "CrmQualificationResponse" DROP CONSTRAINT "CrmQualificationResponse_prospectId_fkey";
DROP INDEX "CrmProspect_qualificationToken_key";
ALTER TABLE "CrmProspect" DROP COLUMN "qualificationSentAt", DROP COLUMN "qualificationToken";
DROP TABLE "CrmQualificationResponse";
