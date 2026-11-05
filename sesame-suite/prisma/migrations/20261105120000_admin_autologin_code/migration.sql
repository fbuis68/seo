-- Lien d'autologin agent support -> back-office client
CREATE TABLE "AdminAutologinCode" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "adminUserId" TEXT NOT NULL,
  "targetEntityCode" TEXT NOT NULL,
  "used" BOOLEAN NOT NULL DEFAULT false,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAutologinCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminAutologinCode_code_key" ON "AdminAutologinCode"("code");
CREATE INDEX "AdminAutologinCode_expiresAt_idx" ON "AdminAutologinCode"("expiresAt");

ALTER TABLE "AdminAutologinCode" ADD CONSTRAINT "AdminAutologinCode_adminUserId_fkey"
  FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
