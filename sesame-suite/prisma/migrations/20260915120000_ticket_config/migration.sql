-- CreateTable
CREATE TABLE "TicketConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "autoResolveAfterDays" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketConfig_pkey" PRIMARY KEY ("id")
);
