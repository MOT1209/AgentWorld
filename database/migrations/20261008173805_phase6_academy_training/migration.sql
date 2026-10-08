-- CreateTable
CREATE TABLE "TrainingRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "evaluator" TEXT NOT NULL DEFAULT 'quiz',
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "score" INTEGER,
    "passingScore" INTEGER NOT NULL DEFAULT 70,
    "feedback" TEXT,
    "correlationId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrainingRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TrainingRun_agentId_skillName_idx" ON "TrainingRun"("agentId", "skillName");

-- CreateIndex
CREATE INDEX "TrainingRun_status_idx" ON "TrainingRun"("status");
