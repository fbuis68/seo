-- CreateTable
CREATE TABLE "EmailSenderIdentity" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSenderIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailSenderIdentity_entityId_email_key" ON "EmailSenderIdentity"("entityId", "email");

-- AddForeignKey
ALTER TABLE "EmailSenderIdentity" ADD CONSTRAINT "EmailSenderIdentity_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "MessageTemplate" ADD COLUMN "senderIdentityId" TEXT;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_senderIdentityId_fkey" FOREIGN KEY ("senderIdentityId") REFERENCES "EmailSenderIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
