-- Phase 3, M2b: execution queue + artifacts + execution columns on sessions.
-- SQLite cannot add a foreign key to an existing table, so AgentSession is
-- rebuilt (same pattern as 20261001090000_phase2_orchestration).
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- 1. AgentSession gains workspaceId/backendId (+ the workspace FK).
CREATE TABLE "new_AgentSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "taskId" TEXT,
    "workspaceId" TEXT,
    "backendId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'INITIALIZING',
    "context" TEXT NOT NULL DEFAULT '{}',
    "toolCalls" TEXT NOT NULL DEFAULT '[]',
    "result" TEXT,
    "error" TEXT,
    "correlationId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentSession_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentSession_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AgentSession" ("id", "agentId", "providerId", "model", "taskId", "status", "context", "toolCalls", "result", "error", "correlationId", "startedAt", "endedAt", "updatedAt")
    SELECT "id", "agentId", "providerId", "model", "taskId", "status", "context", "toolCalls", "result", "error", "correlationId", "startedAt", "endedAt", "updatedAt" FROM "AgentSession";
DROP TABLE "AgentSession";
ALTER TABLE "new_AgentSession" RENAME TO "AgentSession";
CREATE INDEX "AgentSession_agentId_status_idx" ON "AgentSession"("agentId", "status");
CREATE INDEX "AgentSession_status_idx" ON "AgentSession"("status");
CREATE INDEX "AgentSession_taskId_idx" ON "AgentSession"("taskId");
CREATE INDEX "AgentSession_startedAt_idx" ON "AgentSession"("startedAt");
CREATE INDEX "AgentSession_workspaceId_idx" ON "AgentSession"("workspaceId");

-- 2. ExecutionJob: the queue table (M5 consumes it; M3 writes to it).
CREATE TABLE "ExecutionJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'COMMAND',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "backendId" TEXT,
    "command" TEXT,
    "workingDir" TEXT,
    "workspaceId" TEXT,
    "sessionId" TEXT,
    "taskId" TEXT,
    "agentId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "timeoutMs" INTEGER NOT NULL DEFAULT 600000,
    "scheduledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "exitCode" INTEGER,
    "stdoutBytes" INTEGER NOT NULL DEFAULT 0,
    "stderrBytes" INTEGER NOT NULL DEFAULT 0,
    "result" TEXT,
    "error" TEXT,
    "errorCategory" TEXT,
    "createdBy" TEXT,
    "correlationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExecutionJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExecutionJob_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExecutionJob_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExecutionJob_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "ExecutionJob_status_scheduledAt_idx" ON "ExecutionJob"("status", "scheduledAt");
CREATE INDEX "ExecutionJob_workspaceId_idx" ON "ExecutionJob"("workspaceId");
CREATE INDEX "ExecutionJob_sessionId_idx" ON "ExecutionJob"("sessionId");
CREATE INDEX "ExecutionJob_agentId_idx" ON "ExecutionJob"("agentId");
CREATE INDEX "ExecutionJob_taskId_idx" ON "ExecutionJob"("taskId");
CREATE INDEX "ExecutionJob_correlationId_idx" ON "ExecutionJob"("correlationId");

-- 3. Artifact: registered workspace products (files, logs, reports).
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'FILE',
    "path" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT,
    "mimeType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "workspaceId" TEXT,
    "sessionId" TEXT,
    "taskId" TEXT,
    "agentId" TEXT,
    "executionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Artifact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Artifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Artifact_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Artifact_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Artifact_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ExecutionJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "Artifact_workspaceId_idx" ON "Artifact"("workspaceId");
CREATE INDEX "Artifact_sessionId_idx" ON "Artifact"("sessionId");
CREATE INDEX "Artifact_taskId_idx" ON "Artifact"("taskId");
CREATE INDEX "Artifact_agentId_idx" ON "Artifact"("agentId");
CREATE INDEX "Artifact_executionId_idx" ON "Artifact"("executionId");
CREATE INDEX "Artifact_kind_idx" ON "Artifact"("kind");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
