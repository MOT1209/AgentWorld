-- CreateTable
CREATE TABLE "AgentActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "startTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedEndTime" DATETIME,
    "actualEndTime" DATETIME,
    "locationId" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentActivity_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentActivity_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentGoal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentGoal_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_World" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "timeScale" REAL NOT NULL DEFAULT 60,
    "timeOffsetMinutes" REAL NOT NULL DEFAULT 0,
    "lastTickAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'INITIALIZING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_World" ("createdAt", "description", "id", "isActive", "lastTickAt", "name", "timeOffsetMinutes", "timeScale", "updatedAt") SELECT "createdAt", "description", "id", "isActive", "lastTickAt", "name", "timeOffsetMinutes", "timeScale", "updatedAt" FROM "World";
DROP TABLE "World";
ALTER TABLE "new_World" RENAME TO "World";
CREATE UNIQUE INDEX "World_name_key" ON "World"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AgentActivity_agentId_status_idx" ON "AgentActivity"("agentId", "status");

-- CreateIndex
CREATE INDEX "AgentActivity_agentId_startTime_idx" ON "AgentActivity"("agentId", "startTime");

-- CreateIndex
CREATE INDEX "AgentActivity_locationId_idx" ON "AgentActivity"("locationId");

-- CreateIndex
CREATE INDEX "AgentGoal_agentId_status_idx" ON "AgentGoal"("agentId", "status");

