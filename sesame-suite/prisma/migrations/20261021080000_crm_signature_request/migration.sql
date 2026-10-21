-- CreateTable
CREATE TABLE "CrmSignatureRequest" (
    "id" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileMimeType" TEXT NOT NULL DEFAULT 'application/pdf',
    "fileContentBase64" TEXT NOT NULL,
    "signerFirstname" TEXT NOT NULL,
    "signerLastname" TEXT NOT NULL,
    "signerEmail" TEXT NOT NULL,
    "signerPhone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "signToken" TEXT NOT NULL,
    "otpCodeHash" TEXT,
    "otpExpiresAt" TIMESTAMP(3),
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "signedAt" TIMESTAMP(3),
    "signerIp" TEXT,
    "signerUserAgent" TEXT,
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmSignatureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmSignatureRequest_signToken_key" ON "CrmSignatureRequest"("signToken");

-- CreateIndex
CREATE INDEX "CrmSignatureRequest_status_idx" ON "CrmSignatureRequest"("status");

-- AddForeignKey
ALTER TABLE "CrmSignatureRequest" ADD CONSTRAINT "CrmSignatureRequest_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
