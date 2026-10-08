-- Phase 4: districts + location geometry.
-- SQLite cannot add a foreign key to an existing table, so Location is
-- rebuilt (same pattern as 20261001230000_phase3_execution).
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- 1. District: a named sub-area of a city with JSON geometry metadata.
CREATE TABLE "District" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OTHER',
    "description" TEXT,
    "geometry" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "District_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "District_cityId_name_key" ON "District"("cityId", "name");
CREATE INDEX "District_cityId_idx" ON "District"("cityId");

-- 2. Location gains districtId (+ the district FK) via table rebuild.
CREATE TABLE "new_Location" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cityId" TEXT NOT NULL,
    "districtId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OTHER',
    "address" TEXT,
    "capacity" INTEGER,
    "metadata" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Location_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Location_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Location" ("id", "cityId", "name", "kind", "address", "capacity", "metadata", "isActive", "createdAt", "updatedAt")
    SELECT "id", "cityId", "name", "kind", "address", "capacity", "metadata", "isActive", "createdAt", "updatedAt" FROM "Location";
DROP TABLE "Location";
ALTER TABLE "new_Location" RENAME TO "Location";
CREATE UNIQUE INDEX "Location_cityId_name_key" ON "Location"("cityId", "name");
CREATE INDEX "Location_cityId_idx" ON "Location"("cityId");
CREATE INDEX "Location_districtId_idx" ON "Location"("districtId");
CREATE INDEX "Location_kind_idx" ON "Location"("kind");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
