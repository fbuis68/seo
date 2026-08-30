-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "vendorId" TEXT;

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "commissionPct" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "portalToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorCommission" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "salesAmount" DOUBLE PRECISION NOT NULL,
    "commissionPct" DOUBLE PRECISION NOT NULL,
    "commissionAmount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'due',
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorCommission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_portalToken_key" ON "Vendor"("portalToken");

-- CreateIndex
CREATE INDEX "Vendor_entityId_idx" ON "Vendor"("entityId");

-- CreateIndex
CREATE INDEX "VendorCommission_entityId_idx" ON "VendorCommission"("entityId");

-- CreateIndex
CREATE INDEX "VendorCommission_vendorId_idx" ON "VendorCommission"("vendorId");

-- CreateIndex
CREATE INDEX "VendorCommission_orderId_idx" ON "VendorCommission"("orderId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCommission" ADD CONSTRAINT "VendorCommission_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCommission" ADD CONSTRAINT "VendorCommission_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCommission" ADD CONSTRAINT "VendorCommission_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
