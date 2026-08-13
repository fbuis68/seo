-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "capacity" INTEGER,
ADD COLUMN     "connected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "nosmoking" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pmr" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rate" DOUBLE PRECISION,
ADD COLUMN     "type" TEXT;
