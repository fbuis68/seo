-- AlterTable
ALTER TABLE "MessageTemplate" ADD COLUMN     "questionnaireId" TEXT,
ADD COLUMN     "defaultAttachments" JSONB NOT NULL DEFAULT '[]';

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_questionnaireId_fkey" FOREIGN KEY ("questionnaireId") REFERENCES "Questionnaire"("id") ON DELETE SET NULL ON UPDATE CASCADE;
