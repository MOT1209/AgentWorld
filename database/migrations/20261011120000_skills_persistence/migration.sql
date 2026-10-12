-- External skills ecosystem: durable catalog, assignments, usage, requests.
-- Additive only; no existing table is altered. Before this migration the
-- skill state lived in process memory, so there is nothing to backfill.

-- CreateTable
CREATE TABLE "SkillCatalogEntry" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "record" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "installed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SkillAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillKey" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillAssignment_skillKey_fkey" FOREIGN KEY ("skillKey") REFERENCES "SkillCatalogEntry" ("key") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SkillAssignment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SkillUsage" (
    "skillKey" TEXT NOT NULL PRIMARY KEY,
    "installations" INTEGER NOT NULL DEFAULT 0,
    "executions" INTEGER NOT NULL DEFAULT 0,
    "success" INTEGER NOT NULL DEFAULT 0,
    "failure" INTEGER NOT NULL DEFAULT 0,
    "totalDurationMs" INTEGER NOT NULL DEFAULT 0,
    "permissionDenials" INTEGER NOT NULL DEFAULT 0,
    "securityBlocks" INTEGER NOT NULL DEFAULT 0,
    "updates" INTEGER NOT NULL DEFAULT 0,
    "rollbacks" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SkillUsageAgent" (
    "skillKey" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("skillKey", "agentId")
);

-- CreateTable
CREATE TABLE "SkillRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillKey" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "SkillCatalogEntry_status_idx" ON "SkillCatalogEntry"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SkillAssignment_skillKey_agentId_key" ON "SkillAssignment"("skillKey", "agentId");

-- CreateIndex
CREATE INDEX "SkillAssignment_agentId_idx" ON "SkillAssignment"("agentId");

-- CreateIndex
CREATE INDEX "SkillRequest_status_idx" ON "SkillRequest"("status");

-- CreateIndex
CREATE INDEX "SkillRequest_agentId_idx" ON "SkillRequest"("agentId");
