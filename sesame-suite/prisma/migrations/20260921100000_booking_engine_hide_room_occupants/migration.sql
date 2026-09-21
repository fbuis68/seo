-- AlterTable
ALTER TABLE "BookingEngineConfig" ADD COLUMN     "hideRoomSelection" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hideOccupants" BOOLEAN NOT NULL DEFAULT false;
