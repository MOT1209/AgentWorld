-- Phase 4: integration platform -- credentials, AI usage, webhooks, API keys,
-- testing runs, factory runs. Additive only: new tables, no changes to
-- existing ones (Agent/Company/Task/AgentSession/ExecutionJob gain relation
-- fields in the Prisma schema only; SQLite needs no FK backfill for those).
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'API_KEY',
    "scope" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "lastRotatedAt" DATETIME,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Credential_name_key" ON "Credential"("name");
CREATE INDEX "Credential_scope_refId_idx" ON "Credential"("scope", "refId");
CREATE INDEX "Credential_status_idx" ON "Credential"("status");

CREATE TABLE "AiUsage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KW',
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "agentId" TEXT,
    "sessionId" TEXT,
    "taskId" TEXT,
    "companyId" TEXT,
    "correlationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiUsage_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AiUsage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AiUsage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AiUsage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "AiUsage_providerId_model_idx" ON "AiUsage"("providerId", "model");
CREATE INDEX "AiUsage_agentId_createdAt_idx" ON "AiUsage"("agentId", "createdAt");
CREATE INDEX "AiUsage_companyId_createdAt_idx" ON "AiUsage"("companyId", "createdAt");
CREATE INDEX "AiUsage_createdAt_idx" ON "AiUsage"("createdAt");

CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "events" TEXT NOT NULL DEFAULT '["*"]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "secretPayload" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveryAt" DATETIME,
    "companyId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WebhookSubscription_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "WebhookSubscription_status_idx" ON "WebhookSubscription"("status");
CREATE INDEX "WebhookSubscription_companyId_idx" ON "WebhookSubscription"("companyId");

CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscriptionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responseStatus" INTEGER,
    "responseSnippet" TEXT,
    "error" TEXT,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");
CREATE INDEX "WebhookDelivery_subscriptionId_createdAt_idx" ON "WebhookDelivery"("subscriptionId", "createdAt");

CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT '[]',
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");
CREATE INDEX "ApiKey_status_idx" ON "ApiKey"("status");

CREATE TABLE "TestRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "suite" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "summary" TEXT NOT NULL DEFAULT '{}',
    "evidence" TEXT NOT NULL DEFAULT '{}',
    "rawPath" TEXT,
    "workspaceId" TEXT,
    "executionId" TEXT,
    "sessionId" TEXT,
    "taskId" TEXT,
    "agentId" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "correlationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TestRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TestRun_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ExecutionJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TestRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TestRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TestRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "TestRun_status_idx" ON "TestRun"("status");
CREATE INDEX "TestRun_suite_createdAt_idx" ON "TestRun"("suite", "createdAt");
CREATE INDEX "TestRun_taskId_idx" ON "TestRun"("taskId");
CREATE INDEX "TestRun_workspaceId_idx" ON "TestRun"("workspaceId");

CREATE TABLE "FactoryRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoUrl" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INTAKE',
    "currentStage" TEXT NOT NULL DEFAULT 'INTAKE',
    "config" TEXT NOT NULL DEFAULT '{}',
    "analysis" TEXT NOT NULL DEFAULT '{}',
    "plan" TEXT NOT NULL DEFAULT '{}',
    "github" TEXT NOT NULL DEFAULT '{}',
    "stats" TEXT NOT NULL DEFAULT '{}',
    "workspaceId" TEXT,
    "taskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FactoryRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FactoryRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FactoryRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "FactoryRun_companyId_status_idx" ON "FactoryRun"("companyId", "status");
CREATE INDEX "FactoryRun_status_idx" ON "FactoryRun"("status");
