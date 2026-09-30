-- AlterTable
ALTER TABLE "Photo" ADD COLUMN "visibilityChangedAt" DATETIME;

-- CreateIndex
CREATE INDEX "Photo_createdAt_idx" ON "Photo"("createdAt");

-- CreateIndex
CREATE INDEX "Photo_visibilityChangedAt_idx" ON "Photo"("visibilityChangedAt");
