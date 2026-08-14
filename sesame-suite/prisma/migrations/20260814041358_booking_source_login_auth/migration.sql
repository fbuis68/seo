-- AlterTable
ALTER TABLE "BookingSourceConfig" ADD COLUMN     "loginEmail" TEXT,
ADD COLUMN     "loginEmailField" TEXT DEFAULT 'login',
ADD COLUMN     "loginEmailLocation" TEXT DEFAULT 'body',
ADD COLUMN     "loginPassword" TEXT,
ADD COLUMN     "loginPasswordField" TEXT DEFAULT 'password',
ADD COLUMN     "loginPath" TEXT,
ADD COLUMN     "loginTokenHeaderName" TEXT DEFAULT 'Authorization',
ADD COLUMN     "loginTokenPath" TEXT,
ADD COLUMN     "loginTokenPrefix" TEXT;

