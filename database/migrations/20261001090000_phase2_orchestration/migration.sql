-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "description" TEXT,
    "createdByAgentId" TEXT,
    "createdByUserId" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "milestones" TEXT NOT NULL DEFAULT '[]',
    "assumptions" TEXT NOT NULL DEFAULT '[]',
    "risks" TEXT NOT NULL DEFAULT '[]',
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Plan_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Plan_createdByAgentId_fkey" FOREIGN KEY ("createdByAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Plan_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "reviewerAgentId" TEXT,
    "reviewerUserId" TEXT,
    "outcome" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "criteria" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskReview_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskReview_reviewerAgentId_fkey" FOREIGN KEY ("reviewerAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TaskReview_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "authorAgentId" TEXT,
    "authorUserId" TEXT,
    "taskId" TEXT,
    "planId" TEXT,
    "conversationId" TEXT,
    "summary" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Report_authorAgentId_fkey" FOREIGN KEY ("authorAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Report_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Report_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Report_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "taskId" TEXT,
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
    CONSTRAINT "AgentSession_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentHierarchy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subordinateAgentId" TEXT NOT NULL,
    "supervisorAgentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OPERATIONAL',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentHierarchy_subordinateAgentId_fkey" FOREIGN KEY ("subordinateAgentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentHierarchy_supervisorAgentId_fkey" FOREIGN KEY ("supervisorAgentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Escalation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromAgentId" TEXT NOT NULL,
    "toAgentId" TEXT,
    "toUserId" TEXT,
    "taskId" TEXT,
    "planId" TEXT,
    "approvalRequestId" TEXT,
    "category" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "Escalation_fromAgentId_fkey" FOREIGN KEY ("fromAgentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Escalation_toAgentId_fkey" FOREIGN KEY ("toAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Escalation_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Escalation_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Escalation_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Escalation_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "ApprovalRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DecisionConflict" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issue" TEXT NOT NULL,
    "participants" TEXT NOT NULL DEFAULT '[]',
    "positions" TEXT NOT NULL DEFAULT '{}',
    "evidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "taskId" TEXT,
    "planId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "DecisionConflict_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DecisionConflict_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "personality" TEXT NOT NULL DEFAULT '{}',
    "goals" TEXT NOT NULL DEFAULT '[]',
    "skills" TEXT NOT NULL DEFAULT '[]',
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "routingOverrides" TEXT NOT NULL DEFAULT '{}',
    "concurrency" TEXT NOT NULL DEFAULT 'NORMAL',
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "temperature" REAL NOT NULL DEFAULT 0.3,
    "maxTokens" INTEGER NOT NULL DEFAULT 2048,
    "worldId" TEXT,
    "currentLocationId" TEXT,
    "currentCompanyId" TEXT,
    "currentJob" TEXT,
    "reputation" INTEGER NOT NULL DEFAULT 50,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Agent_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Agent_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "Location" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Agent_currentCompanyId_fkey" FOREIGN KEY ("currentCompanyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Agent" ("capabilities", "createdAt", "currentCompanyId", "currentJob", "currentLocationId", "goals", "id", "isActive", "maxTokens", "model", "name", "personality", "providerId", "reputation", "roleKey", "skills", "slug", "systemPrompt", "temperature", "title", "updatedAt", "worldId") SELECT "capabilities", "createdAt", "currentCompanyId", "currentJob", "currentLocationId", "goals", "id", "isActive", "maxTokens", "model", "name", "personality", "providerId", "reputation", "roleKey", "skills", "slug", "systemPrompt", "temperature", "title", "updatedAt", "worldId" FROM "Agent";
DROP TABLE "Agent";
ALTER TABLE "new_Agent" RENAME TO "Agent";
CREATE UNIQUE INDEX "Agent_slug_key" ON "Agent"("slug");
CREATE INDEX "Agent_roleKey_idx" ON "Agent"("roleKey");
CREATE INDEX "Agent_worldId_idx" ON "Agent"("worldId");
CREATE INDEX "Agent_currentCompanyId_idx" ON "Agent"("currentCompanyId");
CREATE INDEX "Agent_currentLocationId_idx" ON "Agent"("currentLocationId");
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "companyId" TEXT,
    "projectId" TEXT,
    "parentTaskId" TEXT,
    "planId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'GENERAL',
    "creatorAgentId" TEXT,
    "creatorUserId" TEXT,
    "assigneeAgentId" TEXT,
    "result" TEXT,
    "error" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "reworkCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 2,
    "plannedAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "cancelledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_creatorAgentId_fkey" FOREIGN KEY ("creatorAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_assigneeAgentId_fkey" FOREIGN KEY ("assigneeAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("assigneeAgentId", "attempts", "cancelledAt", "companyId", "completedAt", "createdAt", "creatorAgentId", "creatorUserId", "description", "error", "id", "metadata", "parentTaskId", "plannedAt", "priority", "projectId", "result", "startedAt", "status", "title", "updatedAt") SELECT "assigneeAgentId", "attempts", "cancelledAt", "companyId", "completedAt", "createdAt", "creatorAgentId", "creatorUserId", "description", "error", "id", "metadata", "parentTaskId", "plannedAt", "priority", "projectId", "result", "startedAt", "status", "title", "updatedAt" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_priority_idx" ON "Task"("priority");
CREATE INDEX "Task_assigneeAgentId_status_idx" ON "Task"("assigneeAgentId", "status");
CREATE INDEX "Task_creatorAgentId_idx" ON "Task"("creatorAgentId");
CREATE INDEX "Task_companyId_idx" ON "Task"("companyId");
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");
CREATE INDEX "Task_parentTaskId_idx" ON "Task"("parentTaskId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Plan_status_idx" ON "Plan"("status");

-- CreateIndex
CREATE INDEX "Plan_companyId_idx" ON "Plan"("companyId");

-- CreateIndex
CREATE INDEX "Plan_createdByAgentId_idx" ON "Plan"("createdByAgentId");

-- CreateIndex
CREATE INDEX "Plan_priority_idx" ON "Plan"("priority");

-- CreateIndex
CREATE INDEX "TaskReview_taskId_createdAt_idx" ON "TaskReview"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskReview_outcome_idx" ON "TaskReview"("outcome");

-- CreateIndex
CREATE INDEX "TaskReview_reviewerAgentId_idx" ON "TaskReview"("reviewerAgentId");

-- CreateIndex
CREATE INDEX "Report_kind_idx" ON "Report"("kind");

-- CreateIndex
CREATE INDEX "Report_authorAgentId_idx" ON "Report"("authorAgentId");

-- CreateIndex
CREATE INDEX "Report_taskId_idx" ON "Report"("taskId");

-- CreateIndex
CREATE INDEX "Report_planId_idx" ON "Report"("planId");

-- CreateIndex
CREATE INDEX "Report_createdAt_idx" ON "Report"("createdAt");

-- CreateIndex
CREATE INDEX "AgentSession_agentId_status_idx" ON "AgentSession"("agentId", "status");

-- CreateIndex
CREATE INDEX "AgentSession_status_idx" ON "AgentSession"("status");

-- CreateIndex
CREATE INDEX "AgentSession_taskId_idx" ON "AgentSession"("taskId");

-- CreateIndex
CREATE INDEX "AgentSession_startedAt_idx" ON "AgentSession"("startedAt");

-- CreateIndex
CREATE INDEX "AgentHierarchy_supervisorAgentId_idx" ON "AgentHierarchy"("supervisorAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentHierarchy_subordinateAgentId_supervisorAgentId_kind_key" ON "AgentHierarchy"("subordinateAgentId", "supervisorAgentId", "kind");

-- CreateIndex
CREATE INDEX "Escalation_status_idx" ON "Escalation"("status");

-- CreateIndex
CREATE INDEX "Escalation_fromAgentId_idx" ON "Escalation"("fromAgentId");

-- CreateIndex
CREATE INDEX "Escalation_toAgentId_idx" ON "Escalation"("toAgentId");

-- CreateIndex
CREATE INDEX "Escalation_category_idx" ON "Escalation"("category");

-- CreateIndex
CREATE INDEX "Escalation_createdAt_idx" ON "Escalation"("createdAt");

-- CreateIndex
CREATE INDEX "DecisionConflict_status_idx" ON "DecisionConflict"("status");

-- CreateIndex
CREATE INDEX "DecisionConflict_taskId_idx" ON "DecisionConflict"("taskId");

-- CreateIndex
CREATE INDEX "DecisionConflict_createdAt_idx" ON "DecisionConflict"("createdAt");

