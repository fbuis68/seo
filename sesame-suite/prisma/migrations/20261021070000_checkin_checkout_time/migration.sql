-- AlterTable
ALTER TABLE "EntityModuleConfig" ADD COLUMN     "checkinTime" TEXT DEFAULT '15:00',
ADD COLUMN     "checkoutTime" TEXT DEFAULT '11:00';
