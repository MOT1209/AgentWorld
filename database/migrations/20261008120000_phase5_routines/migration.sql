-- Phase 5: daily routine engine.
-- New table only (no rebuilds): AgentRoutine references Agent (CASCADE) and
-- Location (SET NULL), both of which already exist by this point in the
-- migration sequence (Phase 1 Location rebuild predates Phase 5).
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "AgentRoutine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "slotMinutes" INTEGER NOT NULL,
    "activityType" TEXT NOT NULL,
    "locationId" TEXT,
    "durationSimMinutes" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastTriggeredSimDate" TEXT,
    "evaluatedOnSimDate" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRoutine_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentRoutine_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentRoutine_agentId_slotMinutes_activityType_key" ON "AgentRoutine"("agentId", "slotMinutes", "activityType");
CREATE INDEX "AgentRoutine_agentId_active_idx" ON "AgentRoutine"("agentId", "active");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;