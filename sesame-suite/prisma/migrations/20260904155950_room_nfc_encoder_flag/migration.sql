-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "isNfcEncoder" BOOLEAN NOT NULL DEFAULT false;

